/**
 * Per-effect audio-reactivity router.
 *
 * The existing `audioReactive` flag drove a small fixed set of effects
 * from the bass band inside VideoOutput. This module generalizes that:
 * every mappable parameter (see MIDI_PARAMS in midiParams.ts) can be
 * individually routed to an audio band (bass / mid / high / volume)
 * with an adjustable amount. The render loop reads the routes once per
 * frame and modulates each parameter's base value accordingly.
 *
 * Routes persist to localStorage so a performer's setup survives a
 * reload, mirroring the MIDI-mapping persistence in useMidi.ts.
 *
 * Pure, framework-free state with a tiny subscribe API so both the
 * React config panel and the non-React render loop can share it.
 */
import {
  MIDI_PARAMS_BY_KEY,
  scaleAudioValue,
  type NumericVJField,
} from './midiParams';
import type { VJState } from './types';

/** Audio analysis bands exposed by useAudioAnalyzer. 'none' = unrouted. */
export type ReactiveBand = 'none' | 'bass' | 'mid' | 'high' | 'volume';

export const REACTIVE_BANDS: ReactiveBand[] = ['none', 'bass', 'mid', 'high', 'volume'];

export interface AudioLevels {
  bass: number;
  mid: number;
  high: number;
  volume: number;
}

export interface AudioRoute {
  /** Which band drives the parameter. 'none' = inactive. */
  band: ReactiveBand;
  /** 0..1 — fraction of the parameter's full range added at peak level. */
  amount: number;
}

export type AudioRoutes = Partial<Record<NumericVJField, AudioRoute>>;

// Routes persist PER CONTROLLER (mirroring useMidi's per-device mappings) so each
// device reloads its own audio-react setup. The base key is the legacy global
// bucket: a no-controller fallback and the migration seed for the first device.
const ROUTE_PREFIX = 'vj-audio-routes:v1';
const storageKeyFor = (ctrl: string | null): string => (ctrl ? `${ROUTE_PREFIX}::${ctrl}` : ROUTE_PREFIX);

let activeController: string | null = null;
let routes: AudioRoutes = loadRoutes(activeController);
const listeners = new Set<(r: AudioRoutes) => void>();

function loadRoutes(ctrl: string | null): AudioRoutes {
  if (typeof window === 'undefined') return {};
  try {
    let raw = window.localStorage.getItem(storageKeyFor(ctrl));
    // Migration: first time we see a device, inherit the legacy global routes (if
    // any). Non-destructive — the legacy bucket stays; this device gets its copy.
    if (!raw && ctrl) raw = window.localStorage.getItem(ROUTE_PREFIX);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as AudioRoutes;
    const out: AudioRoutes = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (k in MIDI_PARAMS_BY_KEY && v && typeof v.amount === 'number') {
        out[k as NumericVJField] = {
          band: (v.band ?? 'none') as ReactiveBand,
          amount: Math.max(0, Math.min(1, v.amount)),
        };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function persist() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(storageKeyFor(activeController), JSON.stringify(routes));
  } catch {
    /* quota / private mode — ignore */
  }
}

/** Switch the active controller: reload that device's saved routes and notify.
 *  Called from App whenever useMidi's detected controller changes. */
export function setActiveAudioController(ctrl: string | null): void {
  if (ctrl === activeController) return;
  activeController = ctrl;
  routes = loadRoutes(ctrl);
  emit();
}

function emit() {
  for (const fn of listeners) fn(routes);
}

/** Read the current route table (live reference; treat as read-only). */
export function getAudioRoutes(): AudioRoutes {
  return routes;
}

/** Set or clear a single parameter's audio route. */
export function setAudioRoute(key: NumericVJField, route: AudioRoute | null): void {
  const next: AudioRoutes = { ...routes };
  if (route === null || route.band === 'none' || route.amount <= 0) {
    delete next[key];
  } else {
    next[key] = { band: route.band, amount: Math.max(0, Math.min(1, route.amount)) };
  }
  routes = next;
  persist();
  emit();
}

/** Clear every audio route. */
export function clearAudioRoutes(): void {
  routes = {};
  persist();
  emit();
}

/** Subscribe to route changes. Returns an unsubscribe fn. */
export function subscribeToAudioRoutes(fn: (r: AudioRoutes) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function bandLevel(band: ReactiveBand, audio: AudioLevels): number {
  switch (band) {
    case 'bass':
      return audio.bass;
    case 'mid':
      return audio.mid;
    case 'high':
      return audio.high;
    case 'volume':
      return audio.volume;
    default:
      return 0;
  }
}

/**
 * Compute audio-modulated final values for every routed parameter.
 *
 * The base value comes from `state[key]`; the route adds
 * `amount * bandLevel * (max - min)` on top, clamped to the param's
 * declared range. Only routed params appear in the result, so the
 * render loop can do `current = result[key] ?? current` cheaply.
 *
 * Returns an empty object when the global `audioReactive` flag is off,
 * preserving the existing master switch behavior.
 */
export function computeAudioModulation(
  state: VJState,
  audio: AudioLevels,
): Partial<Record<NumericVJField, number>> {
  const out: Partial<Record<NumericVJField, number>> = {};
  if (!state.audioReactive) return out;

  for (const [k, route] of Object.entries(routes)) {
    const key = k as NumericVJField;
    if (!route || route.band === 'none' || route.amount <= 0) continue;
    const def = MIDI_PARAMS_BY_KEY[key];
    if (!def) continue;
    const base = Number((state as unknown as Record<string, unknown>)[key] ?? def.min);
    const level = bandLevel(route.band, audio);
    const span = def.max - def.min;
    const modulated = base + route.amount * level * span;
    out[key] = Math.max(def.min, Math.min(def.max, modulated));
  }
  return out;
}

/** Convenience: clamp a raw value into a param's declared range. */
export function clampToParam(key: NumericVJField, value: number): number {
  const def = MIDI_PARAMS_BY_KEY[key];
  if (!def) return value;
  return Math.max(def.min, Math.min(def.max, scaleAudioValue((value - def.min) / (def.max - def.min), def)));
}
