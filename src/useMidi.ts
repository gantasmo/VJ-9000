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

const STORAGE_KEY = 'vj-midi-mappings:v1';

function loadMappings(): Record<NumericVJField, MidiMapping> {
  const out: Record<string, MidiMapping> = {};
  // Seed with auto-map defaults so a fresh user sees something
  // reasonable connected to their controller.
  for (const def of MIDI_PARAMS) {
    if (def.autoCc !== null) {
      out[def.key] = { kind: 'cc', number: def.autoCc, channel: null };
    }
  }
  if (typeof window === 'undefined') return out as Record<NumericVJField, MidiMapping>;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
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

function saveMappings(m: Record<NumericVJField, MidiMapping>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(m));
  } catch {
    /* quota / private mode — silently skip */
  }
}

export function useMidi(opts: UseMidiOpts = {}) {
  const supported = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<MidiInputInfo[]>([]);
  const [mappings, setMappings] = useState<Record<NumericVJField, MidiMapping>>(
    () => loadMappings(),
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

  // Persist mappings whenever they change.
  useEffect(() => {
    saveMappings(mappings);
  }, [mappings]);

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
    if (typeof window !== 'undefined') {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    setMappings(loadMappings());
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
  };
}
