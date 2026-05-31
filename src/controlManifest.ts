/**
 * Control manifest — the canonical list of VJ controls exposed to an
 * external host (SA3's SLIDE tab) for two-way real-time sync.
 *
 * Continuous params come straight from midiParams.ts (the existing single
 * source of truth for mappable fields, with their native min/max). Toggle
 * params (invert, mirror, crt, …) are listed here so the host can render them
 * as pads. Everything is described in NATIVE units — the host converts to/from
 * its own 0..100 fader scale.
 *
 * The manifest is pure data + small helpers (no React) so it can be sent over
 * postMessage and unit tested.
 */
import type { VJState } from './types';
import { MIDI_PARAMS, type ParamGroup } from './midiParams';

export type ControlKind = 'range' | 'toggle';

export interface ControlManifestEntry {
  /** VJState field key — the stable id used in control-set / control-changed. */
  key: string;
  label: string;
  kind: ControlKind;
  group: ParamGroup | 'toggles';
  /** Native range (range kind only). */
  min?: number;
  max?: number;
  step?: number;
}

/** Toggle (boolean) VJState fields surfaced as pads on the host. */
const TOGGLE_CONTROLS: Array<{ key: keyof VJState; label: string }> = [
  { key: 'invert', label: 'Invert' },
  { key: 'edgeDetect', label: 'Edge Detect' },
  { key: 'mirrorX', label: 'Mirror X' },
  { key: 'mirrorY', label: 'Mirror Y' },
  { key: 'kaleidoscope', label: 'Kaleidoscope' },
  { key: 'equirect', label: 'Equirect' },
  { key: 'softEdges', label: 'Soft Edges' },
  { key: 'scanlines', label: 'Scanlines' },
  { key: 'vignette', label: 'Vignette' },
  { key: 'crt', label: 'CRT' },
  { key: 'reversePlayback', label: 'Reverse' },
  { key: 'autoLFO', label: 'Auto LFO' },
  { key: 'audioReactive', label: 'Audio React' },
  { key: 'autoPilot', label: 'Autopilot' },
];

/** A reasonable step per native range so host wheel/arrow nudges feel right. */
function stepFor(min: number, max: number): number {
  const span = Math.abs(max - min);
  if (span <= 1.5) return 0.01; // 0..1-ish fx
  if (span <= 30) return 1; // small integer ranges (tiling, spokes, echo)
  return 1; // hue/bpm/percent
}

/** The full manifest: continuous params first (grouped), then toggles. */
export const CONTROL_MANIFEST: ControlManifestEntry[] = [
  ...MIDI_PARAMS.map((p): ControlManifestEntry => ({
    key: p.key,
    label: p.label,
    kind: 'range',
    group: p.group,
    min: p.min,
    max: p.max,
    step: stepFor(p.min, p.max),
  })),
  ...TOGGLE_CONTROLS.map((t): ControlManifestEntry => ({
    key: t.key as string,
    label: t.label,
    kind: 'toggle',
    group: 'toggles',
  })),
];

/** Read the live value of a manifest control from VJState (native / boolean). */
export function readControlValue(state: VJState, key: string): number | boolean {
  const v = (state as unknown as Record<string, unknown>)[key];
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return 0;
}

/** Snapshot every manifest control's current value, keyed by control key. */
export function snapshotControlValues(state: VJState): Record<string, number | boolean> {
  const out: Record<string, number | boolean> = {};
  for (const entry of CONTROL_MANIFEST) out[entry.key] = readControlValue(state, entry.key);
  return out;
}

const MANIFEST_KEYS = new Set(CONTROL_MANIFEST.map((e) => e.key));

/** True if a key is a control we sync (guards inbound control-set). */
export function isManifestKey(key: string): boolean {
  return MANIFEST_KEYS.has(key);
}

/** Coerce an inbound value to the right type/range for its control. */
export function coerceControlValue(key: string, value: unknown): number | boolean | null {
  const entry = CONTROL_MANIFEST.find((e) => e.key === key);
  if (!entry) return null;
  if (entry.kind === 'toggle') return Boolean(value);
  const n = Number(value);
  if (Number.isNaN(n)) return null;
  const min = entry.min ?? 0;
  const max = entry.max ?? 1;
  return Math.max(min, Math.min(max, n));
}
