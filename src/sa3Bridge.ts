/**
 * SA3 bridge — listens for postMessage from the parent window (the
 * SA3 frontend, which embeds this app in an iframe in its VJ tab).
 *
 * When SA3 has a track loaded in its global player, it forwards the
 * master AnalyserNode's amplitude buckets (bass / mid / high / volume)
 * at requestAnimationFrame rate. Other messages carry the currently-
 * playing track's metadata, the user's input mute toggles, and the
 * raw MIDI byte stream from SA3's global Web MIDI listener.
 *
 * The bridge is INERT when the app runs standalone (no parent window
 * sending messages) — `getExternalLevels()` returns null and
 * useAudioAnalyzer falls back to its built-in mic capture. Input
 * state defaults to all-on so MIDI mappings + mic still work
 * without an SA3 parent.
 */

export interface ExternalAudioLevels {
  bass: number;
  mid: number;
  high: number;
  volume: number;
}

export interface ExternalTrackMeta {
  entryId: string | null;
  title: string | null;
  model: string | null;
  source: string | null;
  duration: number | null;
  isPlaying: boolean;
}

export interface ExternalInputState {
  mic: boolean;
  audio: boolean;
  midi: boolean;
}

export interface ExternalMidiMessage {
  /** 3-byte MIDI message: [status, data1, data2]. */
  data: number[];
  /** parent's performance.now() at send time — useful for jitter
   *  measurement. */
  t: number;
}

export interface ExternalLoadItem {
  entryId?: string | null;
  id?: string | null;
  label?: string | null;
  name?: string | null;
  title?: string | null;
  url?: string | null;
  kind?: 'audio' | 'video' | 'image' | string | null;
}

export interface ExternalLoadSetPayload {
  setId?: string | null;
  name?: string | null;
  items: ExternalLoadItem[];
}

export interface ExternalLoadTrackPayload {
  setId?: string | null;
  name?: string | null;
  item: ExternalLoadItem;
}

const LEVELS_STALE_MS = 200;

let latestLevels: ExternalAudioLevels | null = null;
let latestLevelsAt = 0;
let latestMeta: ExternalTrackMeta | null = null;
let latestInputs: ExternalInputState = { mic: true, audio: true, midi: true };
// Whether the SA3 VJ tab is currently visible. Defaults true so the app
// renders normally when standalone (no parent ever sends visibility).
let latestVisibility = true;
const metaListeners = new Set<(meta: ExternalTrackMeta) => void>();
const inputListeners = new Set<(state: ExternalInputState) => void>();
const midiListeners = new Set<(msg: ExternalMidiMessage) => void>();
const visibilityListeners = new Set<(visible: boolean) => void>();
const loadSetListeners = new Set<(payload: ExternalLoadSetPayload) => void>();
const loadTrackListeners = new Set<(payload: ExternalLoadTrackPayload) => void>();

// ── Control sync (SLIDE tab ⇄ VJ controls) ─────────────────────────
/** A single control change pushed FROM the host: set this VJState key to
 *  this native value (number for ranges, boolean for toggles). */
export interface ExternalControlSet {
  key: string;
  value: number | boolean;
}
// The host asks for the control manifest + current values (request-controls);
// App.tsx answers by calling sendControlManifest(). These listeners let App
// react to inbound control writes and manifest requests.
const controlSetListeners = new Set<(set: ExternalControlSet) => void>();
const requestControlsListeners = new Set<() => void>();
/** Remember who last messaged us so we can post back without the parent ref. */
let hostWindow: Window | null = null;


if (typeof window !== 'undefined') {
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    // Track the host window for outbound manifest / control-changed posts.
    if (typeof data.type === 'string' && data.type.startsWith('sa3-vj/') && event.source) {
      hostWindow = event.source as Window;
    }
    if (data.type === 'sa3-vj/audio-levels') {
      latestLevels = {
        bass: Number(data.bass) || 0,
        mid: Number(data.mid) || 0,
        high: Number(data.high) || 0,
        volume: Number(data.volume) || 0,
      };
      latestLevelsAt = performance.now();
    } else if (data.type === 'sa3-vj/track-meta') {
      latestMeta = {
        entryId: data.entryId ?? null,
        title: data.title ?? null,
        model: data.model ?? null,
        source: data.source ?? null,
        duration: typeof data.duration === 'number' ? data.duration : null,
        isPlaying: Boolean(data.isPlaying),
      };
      metaListeners.forEach((cb) => {
        try {
          cb(latestMeta!);
        } catch {
          /* listener should not throw, but be defensive */
        }
      });
    } else if (data.type === 'sa3-vj/inputs') {
      latestInputs = {
        mic: Boolean(data.mic),
        audio: Boolean(data.audio),
        midi: Boolean(data.midi),
      };
      inputListeners.forEach((cb) => {
        try { cb(latestInputs); } catch { /* defensive */ }
      });
    } else if (data.type === 'sa3-vj/midi') {
      if (Array.isArray(data.data)) {
        const msg: ExternalMidiMessage = {
          data: data.data.map((n: unknown) => Number(n) | 0),
          t: typeof data.t === 'number' ? data.t : performance.now(),
        };
        midiListeners.forEach((cb) => {
          try { cb(msg); } catch { /* defensive */ }
        });
      }
    } else if (data.type === 'sa3-vj/visibility') {
      latestVisibility = Boolean(data.visible);
      visibilityListeners.forEach((cb) => {
        try { cb(latestVisibility); } catch { /* defensive */ }
      });
    } else if (data.type === 'sa3-vj/load-set') {
      const payload: ExternalLoadSetPayload = {
        setId: data.setId ?? null,
        name: data.name ?? null,
        items: Array.isArray(data.items) ? data.items : [],
      };
      loadSetListeners.forEach((cb) => {
        try { cb(payload); } catch { /* defensive */ }
      });
    } else if (data.type === 'sa3-vj/load-track') {
      const payload: ExternalLoadTrackPayload = {
        setId: data.setId ?? null,
        name: data.name ?? null,
        item: (data.item && typeof data.item === 'object') ? data.item : {},
      };
      loadTrackListeners.forEach((cb) => {
        try { cb(payload); } catch { /* defensive */ }
      });
    } else if (data.type === 'sa3-vj/control-set') {
      // Host moved a SLIDE control → write it into VJState.
      if (typeof data.key === 'string' && (typeof data.value === 'number' || typeof data.value === 'boolean')) {
        const set: ExternalControlSet = { key: data.key, value: data.value };
        controlSetListeners.forEach((cb) => {
          try { cb(set); } catch { /* defensive */ }
        });
      }
    } else if (data.type === 'sa3-vj/request-controls') {
      // Host (re)connected and wants the manifest + current values.
      requestControlsListeners.forEach((cb) => {
        try { cb(); } catch { /* defensive */ }
      });
    }
  });
}

/** Subscribe to inbound control writes from the host. */
export function subscribeToControlSet(cb: (set: ExternalControlSet) => void): () => void {
  controlSetListeners.add(cb);
  return () => { controlSetListeners.delete(cb); };
}

/** Subscribe to the host's request for the control manifest. */
export function subscribeToControlRequests(cb: () => void): () => void {
  requestControlsListeners.add(cb);
  return () => { requestControlsListeners.delete(cb); };
}

/** Post the control manifest + a snapshot of current values to the host. */
export function sendControlManifest(
  manifest: unknown,
  values: Record<string, number | boolean>,
): void {
  postToHost({ type: 'sa3-vj/controls-manifest', manifest, values });
}

/** Tell the host a VJ control changed (native value). Used for two-way sync
 *  so a control moved in the VJ deck mirrors onto the SLIDE fader. */
export function sendControlChanged(key: string, value: number | boolean): void {
  postToHost({ type: 'sa3-vj/control-changed', key, value });
}

/** Post a message back to the SA3 host window (parent or opener). Falls back
 *  to window.parent when no host message has arrived yet. */
function postToHost(payload: Record<string, unknown>): void {
  const target = hostWindow ?? (window.parent !== window ? window.parent : null);
  if (!target) return;
  try {
    target.postMessage(payload, '*');
  } catch {
    /* host not reachable; ignore */
  }
}

/** Whether the SA3 VJ tab is currently visible. The render loop parks
 *  itself when this is false so the iframe drops to ≈0% GPU while still
 *  mounted. Always true standalone. */
export function getVisibility(): boolean {
  return latestVisibility;
}

/** Subscribe to visibility changes. Returns an unsubscribe fn. */
export function subscribeToVisibility(cb: (visible: boolean) => void): () => void {
  visibilityListeners.add(cb);
  cb(latestVisibility);
  return () => { visibilityListeners.delete(cb); };
}

/** Subscribe to incoming SET loads from SA3 host. */
export function subscribeToLoadSet(cb: (payload: ExternalLoadSetPayload) => void): () => void {
  loadSetListeners.add(cb);
  return () => { loadSetListeners.delete(cb); };
}

/** Subscribe to incoming single-track loads from SA3 host. */
export function subscribeToLoadTrack(cb: (payload: ExternalLoadTrackPayload) => void): () => void {
  loadTrackListeners.add(cb);
  return () => { loadTrackListeners.delete(cb); };
}


/** Current input enable state pushed by SA3 (mic/audio/midi). */
export function getExternalInputs(): ExternalInputState {
  return latestInputs;
}

/** Subscribe to input-state changes. Returns an unsubscribe fn. */
export function subscribeToInputs(cb: (state: ExternalInputState) => void): () => void {
  inputListeners.add(cb);
  cb(latestInputs);
  return () => { inputListeners.delete(cb); };
}

/** Subscribe to forwarded MIDI events. Returns an unsubscribe fn.
 *  Each call delivers the 3-byte MIDI message verbatim. */
export function subscribeToMidi(cb: (msg: ExternalMidiMessage) => void): () => void {
  midiListeners.add(cb);
  return () => { midiListeners.delete(cb); };
}

/**
 * Latest audio amplitude buckets from the SA3 player, or null if the
 * bridge hasn't received a frame in the last LEVELS_STALE_MS. Callers
 * (useAudioAnalyzer) treat null as "fall back to mic / nothing".
 */
export function getExternalLevels(): ExternalAudioLevels | null {
  if (!latestLevels) return null;
  if (performance.now() - latestLevelsAt > LEVELS_STALE_MS) {
    return null;
  }
  return latestLevels;
}

/** Latest track metadata received from SA3, or null if none yet. */
export function getExternalMeta(): ExternalTrackMeta | null {
  return latestMeta;
}

/** Subscribe to track-meta updates. Returns an unsubscribe fn. */
export function subscribeToMeta(
  cb: (meta: ExternalTrackMeta) => void,
): () => void {
  metaListeners.add(cb);
  if (latestMeta) cb(latestMeta);
  return () => {
    metaListeners.delete(cb);
  };
}

/** True if SA3's audio bridge has sent a frame recently. */
export function isBridgeActive(): boolean {
  return (
    latestLevels !== null &&
    performance.now() - latestLevelsAt <= LEVELS_STALE_MS
  );
}
