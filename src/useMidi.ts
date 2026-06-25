/**
 * Web MIDI integration for VJ.
 *
 * - Requests MIDIAccess on first use; auto-attaches to any connected
 *   inputs. New inputs (hot-plugged) auto-attach via statechange.
 * - Maintains a learned mapping of MIDI CC# → VJState field. Defaults
 *   to the auto-map table in midiParams.ts; user overrides via the
 *   MIDI LEARN flow.
 * - Mappings persist to localStorage so the user's manual setup
 *   survives a reload.
 * - Audio reactivity + MIDI run side-by-side — there's no "MIDI vs
 *   audio" mode toggle. A CC moves the param, the audio analyser
 *   also reads from SA3, both affect the visualiser.
 *
 * Public API:
 *   const {
 *     supported,    // boolean — Web MIDI present in this browser
 *     ready,        // boolean — MIDIAccess resolved
 *     error,        // string | null — last permission/connect error
 *     inputs,       // { id, name, manufacturer, state }[]
 *     mappings,     // Record<NumericVJField, MidiMapping>
 *     setMapping,   // (paramKey, mapping | null) → void
 *     learning,     // NumericVJField | null — the param waiting for
 *                   //   the next CC to assign itself
 *     setLearning,  // (paramKey | null) → void
 *     resetMappings,// () => void — wipe + restore auto-defaults
 *   } = useMidi({ onCcChange, onNote })
 *
 * `onCcChange(cc, value, channel)` fires for every incoming CC after
 * mapping is applied; callers can inspect for unmapped CCs (the
 * learn-mode UI uses this to show "last seen: CC X").
 * `onNote(note, velocity, kind)` is similar for note on/off.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MIDI_PARAMS,
  MIDI_PARAMS_BY_KEY,
  scaleCcValue,
  type NumericVJField,
} from './midiParams';
import { subscribeToMidi } from './sa3Bridge';

export interface MidiMapping {
  /** Which controller event this param is bound to. */
  kind: 'cc' | 'note';
  /** MIDI CC# (0-127) or note number (0-127). */
  number: number;
  /** MIDI channel 0-15, or null = any channel. */
  channel: number | null;
  /** Inverts the mapping — 127 → min, 0 → max. */
  inverted?: boolean;
}

export interface MidiInputInfo {
  id: string;
  name: string;
  manufacturer: string;
  state: 'connected' | 'disconnected';
}

interface UseMidiOpts {
  /** Called with EVERY incoming CC, mapped or not. UI uses this to
   *  surface "last seen" hints during MIDI LEARN. */
  onCcChange?: (cc: number, value: number, channel: number) => void;
  /** Called for note on/off events. Hook applies the standard
   *  velocity-as-cc fallback automatically. */
  onNote?: (note: number, velocity: number, kind: 'on' | 'off', channel: number) => void;
  /** Called whenever a mapped CC produces a new value for a VJ
   *  param. Callers patch their VJState from this. */
  onParamChange?: (key: NumericVJField, value: number) => void;
}

// Mappings persist PER CONTROLLER so each connected device reloads its own learned
// map. The base key is the legacy global bucket (kept as a no-controller fallback
// and as the migration seed for the first device seen).
const STORAGE_PREFIX = 'vj-midi-mappings:v1';
const storageKeyFor = (ctrl: string | null): string => (ctrl ? `${STORAGE_PREFIX}::${ctrl}` : STORAGE_PREFIX);

/** Stable per-controller key — the device name (preferred, so the same model
 *  reloads its map across sessions even if the port id changes), else the id. */
function controllerKey(info: { name?: string | null; id?: string | null }): string {
  const raw = (info.name && info.name.trim()) || info.id || '';
  return raw.replace(/\s+/g, ' ').trim().slice(0, 64);
}

/** Auto-map defaults so a fresh device shows something reasonable connected. */
function seedDefaults(): Record<string, MidiMapping> {
  const out: Record<string, MidiMapping> = {};
  for (const def of MIDI_PARAMS) {
    if (def.autoCc !== null) {
      out[def.key] = { kind: 'cc', number: def.autoCc, channel: null };
    }
  }
  return out;
}

function loadMappings(ctrl: string | null): Record<NumericVJField, MidiMapping> {
  const out: Record<string, MidiMapping> = seedDefaults();
  if (typeof window === 'undefined') return out as Record<NumericVJField, MidiMapping>;
  try {
    let raw = window.localStorage.getItem(storageKeyFor(ctrl));
    // Migration: first time we see a specific controller, inherit the legacy
    // global map (if any) so an existing setup carries over. Non-destructive —
    // the legacy bucket is left intact and this device gets its own copy on save.
    if (!raw && ctrl) raw = window.localStorage.getItem(STORAGE_PREFIX);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, MidiMapping>;
      for (const [k, v] of Object.entries(parsed)) {
        if (k in MIDI_PARAMS_BY_KEY && v && typeof v.number === 'number') {
          out[k] = v;
        }
      }
    }
  } catch {
    /* corrupted; fall through to defaults */
  }
  return out as Record<NumericVJField, MidiMapping>;
}

function saveMappings(m: Record<NumericVJField, MidiMapping>, ctrl: string | null) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKeyFor(ctrl), JSON.stringify(m));
  } catch {
    /* quota / private mode — silently skip */
  }
}

export function useMidi(opts: UseMidiOpts = {}) {
  const supported = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<MidiInputInfo[]>([]);
  // The active controller's stable key (name/id). null until a device is seen, or
  // when none is connected — then the legacy global bucket is used.
  const [activeController, setActiveController] = useState<string | null>(null);
  const [mappings, setMappings] = useState<Record<NumericVJField, MidiMapping>>(
    () => loadMappings(null),
  );
  const [learning, setLearning] = useState<NumericVJField | null>(null);

  // Latest values for callbacks so the message handler doesn't get
  // re-attached on every render (which would briefly drop messages).
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const mappingsRef = useRef(mappings);
  mappingsRef.current = mappings;
  const learningRef = useRef(learning);
  learningRef.current = learning;
  const activeControllerRef = useRef(activeController);
  activeControllerRef.current = activeController;

  // Persist mappings under the active controller whenever either changes.
  useEffect(() => {
    saveMappings(mappings, activeController);
  }, [mappings, activeController]);

  // Acquire MIDI access + wire onmessage on every input.
  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    let access: MIDIAccess | null = null;

    const onMessage = (e: MIDIMessageEvent) => {
      if (!e.data) return;
      const [status, data1, data2] = e.data;
      const command = status & 0xf0;
      const channel = status & 0x0f;
      if (command === 0xb0) {
        // CC change
        const cc = data1;
        const value = data2;
        optsRef.current.onCcChange?.(cc, value, channel);
        // Learn mode: bind this CC to the learning param + exit
        // learn state. Skip status messages (0xfe etc.) so the user
        // doesn't accidentally bind to an active-sensing tick.
        const target = learningRef.current;
        if (target) {
          setMappings((prev) => ({
            ...prev,
            [target]: { kind: 'cc', number: cc, channel },
          }));
          setLearning(null);
          return;
        }
        // Apply mapped value
        for (const [paramKey, mappingRaw] of Object.entries(mappingsRef.current)) {
          const mapping = mappingRaw as MidiMapping;
          if (mapping.kind !== 'cc') continue;
          if (mapping.number !== cc) continue;
          if (mapping.channel !== null && mapping.channel !== channel) continue;
          const def = MIDI_PARAMS_BY_KEY[paramKey as NumericVJField];
          const scaled = scaleCcValue(
            mapping.inverted ? 127 - value : value,
            def,
          );
          optsRef.current.onParamChange?.(paramKey as NumericVJField, scaled);
        }
      } else if (command === 0x90 || command === 0x80) {
        // Note on (0x90) / note off (0x80). 0x90 with velocity 0 is
        // an alternate note-off encoding some controllers use.
        const note = data1;
        const velocity = data2;
        const kind: 'on' | 'off' = command === 0x90 && velocity > 0 ? 'on' : 'off';
        optsRef.current.onNote?.(note, velocity, kind, channel);
        // Learn mode for notes: same flow as CC.
        const target = learningRef.current;
        if (target && kind === 'on') {
          setMappings((prev) => ({
            ...prev,
            [target]: { kind: 'note', number: note, channel },
          }));
          setLearning(null);
          return;
        }
        // Apply mapped notes — velocity drives the param value.
        for (const [paramKey, mappingRaw] of Object.entries(mappingsRef.current)) {
          const mapping = mappingRaw as MidiMapping;
          if (mapping.kind !== 'note') continue;
          if (mapping.number !== note) continue;
          if (mapping.channel !== null && mapping.channel !== channel) continue;
          const def = MIDI_PARAMS_BY_KEY[paramKey as NumericVJField];
          const scaled = scaleCcValue(
            mapping.inverted ? 127 - velocity : velocity,
            def,
          );
          optsRef.current.onParamChange?.(paramKey as NumericVJField, scaled);
        }
      }
    };

    const refreshInputs = (a: MIDIAccess) => {
      const list: MidiInputInfo[] = [];
      a.inputs.forEach((input) => {
        list.push({
          id: input.id,
          name: input.name ?? 'Unnamed MIDI input',
          manufacturer: input.manufacturer ?? '',
          state: input.state as 'connected' | 'disconnected',
        });
        input.onmidimessage = onMessage;
      });
      setInputs(list);
      // Active controller = the first connected device (else the first listed).
      // When it changes, load that controller's saved map so the same device
      // auto-restores its mappings; a fresh device starts from auto-defaults.
      const primary = list.find((i) => i.state === 'connected') ?? list[0] ?? null;
      const ctrl = primary ? controllerKey(primary) : null;
      if (ctrl !== activeControllerRef.current) {
        activeControllerRef.current = ctrl;
        setActiveController(ctrl);
        setMappings(loadMappings(ctrl));
      }
    };

    (navigator as Navigator & { requestMIDIAccess: () => Promise<MIDIAccess> })
      .requestMIDIAccess()
      .then((a) => {
        if (cancelled) return;
        access = a;
        setReady(true);
        setError(null);
        refreshInputs(a);
        a.onstatechange = () => {
          if (!cancelled && access) refreshInputs(access);
        };
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      cancelled = true;
      if (access) {
        access.inputs.forEach((input) => {
          input.onmidimessage = null;
        });
        access.onstatechange = null;
      }
    };
  }, [supported]);

  const setMapping = useCallback((key: NumericVJField, mapping: MidiMapping | null) => {
    setMappings((prev) => {
      const next = { ...prev };
      if (mapping === null) {
        delete next[key];
      } else {
        next[key] = mapping;
      }
      return next;
    });
  }, []);

  const resetMappings = useCallback(() => {
    const ctrl = activeControllerRef.current;
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(storageKeyFor(ctrl));
    }
    // Pure auto-defaults (don't re-inherit the legacy global via loadMappings);
    // the persist effect writes these back under the active controller.
    setMappings(seedDefaults() as Record<NumericVJField, MidiMapping>);
  }, []);

  // SA3-bridge subscription: when running inside SA3's VJ iframe,
  // the parent forwards every MIDI message from the user's
  // controller via postMessage. Synthesize a MIDIMessageEvent-like
  // payload and run it through the same mapping logic as direct
  // Web MIDI input. Either source reaches the same mappings table.
  useEffect(() => {
    const unsub = subscribeToMidi((msg) => {
      const [status, data1, data2] = msg.data;
      if (typeof status !== 'number') return;
      const command = status & 0xf0;
      const channel = status & 0x0f;
      if (command === 0xb0) {
        optsRef.current.onCcChange?.(data1, data2, channel);
        const target = learningRef.current;
        if (target) {
          setMappings((prev) => ({
            ...prev,
            [target]: { kind: 'cc', number: data1, channel },
          }));
          setLearning(null);
          return;
        }
        for (const [paramKey, mappingRaw] of Object.entries(mappingsRef.current)) {
          const mapping = mappingRaw as MidiMapping;
          if (mapping.kind !== 'cc') continue;
          if (mapping.number !== data1) continue;
          if (mapping.channel !== null && mapping.channel !== channel) continue;
          const def = MIDI_PARAMS_BY_KEY[paramKey as NumericVJField];
          const scaled = scaleCcValue(mapping.inverted ? 127 - data2 : data2, def);
          optsRef.current.onParamChange?.(paramKey as NumericVJField, scaled);
        }
      } else if (command === 0x90 || command === 0x80) {
        const kind: 'on' | 'off' = command === 0x90 && data2 > 0 ? 'on' : 'off';
        optsRef.current.onNote?.(data1, data2, kind, channel);
        const target = learningRef.current;
        if (target && kind === 'on') {
          setMappings((prev) => ({
            ...prev,
            [target]: { kind: 'note', number: data1, channel },
          }));
          setLearning(null);
          return;
        }
        for (const [paramKey, mappingRaw] of Object.entries(mappingsRef.current)) {
          const mapping = mappingRaw as MidiMapping;
          if (mapping.kind !== 'note') continue;
          if (mapping.number !== data1) continue;
          if (mapping.channel !== null && mapping.channel !== channel) continue;
          const def = MIDI_PARAMS_BY_KEY[paramKey as NumericVJField];
          const scaled = scaleCcValue(mapping.inverted ? 127 - data2 : data2, def);
          optsRef.current.onParamChange?.(paramKey as NumericVJField, scaled);
        }
      }
    });
    return unsub;
  }, []);

  return {
    supported,
    ready,
    error,
    inputs,
    mappings,
    setMapping,
    learning,
    setLearning,
    resetMappings,
    /** Stable key of the active controller (name/id), or null when none — drives
     *  per-controller audio-route persistence in App (see setActiveAudioController). */
    activeController,
  };
}
