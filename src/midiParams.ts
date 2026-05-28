/**
 * Registry of VJState fields that can be MIDI-mapped.
 *
 * Each entry declares the field key, a human label for the UI,
 * the min/max range that incoming MIDI CC values (0..127) map onto,
 * and an `autoCc` hint — the CC number that this param will receive
 * by default if a controller sends data on that CC and the user
 * hasn't explicitly mapped anything yet.
 *
 * `autoCc` defaults follow the General MIDI / MIDI 1.0 Recommended
 * Practice for "performance" controllers + Mackie HUI conventions:
 *   - CC1   mod wheel       → feedback (the most common "morph" knob)
 *   - CC7   volume           → brightness
 *   - CC10  pan              → hue (color shift)
 *   - CC11  expression       → glitch
 *   - CC71  resonance        → rgbGhost
 *   - CC72  release          → chromaAb
 *   - CC73  attack           → strobe
 *   - CC74  cutoff/filter    → pixelate
 *   - CC75  sound 6          → waveWarp
 *   - CC76  sound 7          → rgbSplit
 *   - CC77  sound 8          → backskip
 *   - CC78  sound 9          → saturation
 *
 * Anything else hitting an unmapped CC just gets ignored until the
 * user assigns it via MIDI LEARN.
 */
import type { VJState } from './types';

export type NumericVJField =
  | 'feedback'
  | 'glitch'
  | 'rgbGhost'
  | 'rgbSplit'
  | 'chromaAb'
  | 'backskip'
  | 'strobe'
  | 'pixelate'
  | 'waveWarp'
  | 'hue'
  | 'saturation'
  | 'contrast'
  | 'brightness'
  | 'tiling'
  | 'bpm'
  | 'playbackSpeed'
  | 'echoTrails'
  | 'slitScan'
  | 'timeDisplace'
  | 'posterizeTime';

export interface MidiParamDef {
  key: NumericVJField;
  label: string;
  min: number;
  max: number;
  /** CC number this param accepts by default. null = no auto-map. */
  autoCc: number | null;
}

export const MIDI_PARAMS: MidiParamDef[] = [
  { key: 'feedback',     label: 'Feedback',       min: 0,   max: 1,   autoCc: 1 },
  { key: 'brightness',   label: 'Brightness',     min: 0,   max: 200, autoCc: 7 },
  { key: 'hue',          label: 'Hue Rotate',     min: 0,   max: 360, autoCc: 10 },
  { key: 'glitch',       label: 'Glitch',         min: 0,   max: 1,   autoCc: 11 },
  { key: 'rgbGhost',     label: 'RGB Ghost',      min: 0,   max: 1,   autoCc: 71 },
  { key: 'chromaAb',     label: 'Chromatic Ab.',  min: 0,   max: 1,   autoCc: 72 },
  { key: 'strobe',       label: 'Strobe',         min: 0,   max: 1,   autoCc: 73 },
  { key: 'pixelate',     label: 'Pixelate',       min: 0,   max: 1,   autoCc: 74 },
  { key: 'waveWarp',     label: 'Wave Warp',      min: 0,   max: 1,   autoCc: 75 },
  { key: 'rgbSplit',     label: 'RGB Split',      min: 0,   max: 1,   autoCc: 76 },
  { key: 'backskip',     label: 'Time Glitch',    min: 0,   max: 1,   autoCc: 77 },
  { key: 'saturation',   label: 'Saturation',     min: 0,   max: 200, autoCc: 78 },
  { key: 'contrast',     label: 'Contrast',       min: 0,   max: 200, autoCc: null },
  { key: 'tiling',       label: 'Tiling',         min: 1,   max: 16,  autoCc: null },
  { key: 'bpm',          label: 'BPM',            min: 60,  max: 220, autoCc: null },
  { key: 'playbackSpeed',label: 'Playback Speed', min: 0.25, max: 4,  autoCc: null },
  { key: 'echoTrails',   label: 'Echo Trails',    min: 0,   max: 1,   autoCc: null },
  { key: 'slitScan',     label: 'Slit Scan',      min: 0,   max: 1,   autoCc: null },
  { key: 'timeDisplace', label: 'Time Displace',  min: 0,   max: 1,   autoCc: null },
  { key: 'posterizeTime',label: 'Posterize',      min: 1,   max: 120, autoCc: null },
];

export const MIDI_PARAMS_BY_KEY: Record<NumericVJField, MidiParamDef> = Object.fromEntries(
  MIDI_PARAMS.map((p) => [p.key, p]),
) as Record<NumericVJField, MidiParamDef>;

/** Scale a 0-127 MIDI CC value into the target param's range. */
export function scaleCcValue(value: number, def: MidiParamDef): number {
  const clamped = Math.max(0, Math.min(127, value));
  const norm = clamped / 127;
  return def.min + norm * (def.max - def.min);
}

/** True if the given VJ state field is one we can MIDI-map. */
export function isMappableField(key: string): key is NumericVJField {
  return key in MIDI_PARAMS_BY_KEY;
}

/** Helper used by useMidi to apply a fresh CC value to VJState. */
export function applyCcToState(
  value: number,
  paramKey: NumericVJField,
): Partial<VJState> {
  const def = MIDI_PARAMS_BY_KEY[paramKey];
  return { [paramKey]: scaleCcValue(value, def) } as unknown as Partial<VJState>;
}
