/**
 * Canonical registry of VJState fields that can be MIDI-mapped AND
 * audio-reactivity-routed.
 *
 * This is the single source of truth for "mappable effect parameters".
 * Both the MIDI LEARN system (useMidi.ts / MidiPanel.tsx) and the
 * audio-reactivity router (audioRouting.ts / VideoOutput.tsx) iterate
 * this list, so adding one entry here makes a parameter controllable
 * from a MIDI controller, the crossfader, and any audio band at once.
 *
 * Each entry declares the field key, a human label, the min/max range
 * that incoming MIDI CC values (0..127) and normalized audio levels
 * (0..1) map onto, an `autoCc` hint (the CC number the param accepts by
 * default before the user maps anything), and a `group` so the UI can
 * cluster related controls.
 *
 * autoCc defaults follow the General MIDI / MIDI 1.0 Recommended
 * Practice for "performance" controllers + Mackie HUI conventions.
 * Anything hitting an unmapped CC is ignored until the user assigns it
 * via MIDI LEARN.
 */
import type { VJState } from './types';

/**
 * Every numeric VJState field a controller or audio band can drive.
 * Keep this union in sync with the MIDI_PARAMS array below.
 */
export type NumericVJField =
  // Source / mix
  | 'sourceBlend' // the CAM<->MEM crossfader
  | 'autoSwitchInterval'
  // Color & optics
  | 'hue'
  | 'saturation'
  | 'contrast'
  | 'brightness'
  // Geometry
  | 'tiling'
  | 'radialSpokes'
  // Distortion & FX
  | 'feedback'
  | 'glitch'
  | 'rgbGhost'
  | 'rgbSplit'
  | 'chromaAb'
  | 'backskip'
  | 'strobe'
  | 'pixelate'
  | 'waveWarp'
  // G1 look tier
  | 'fxSepia'
  | 'fxGrayscale'
  | 'fxBlur'
  // Sequencing / timecode
  | 'bpm'
  | 'playbackSpeed'
  | 'echoTrails'
  | 'slitScan'
  | 'timeDisplace'
  | 'posterizeTime';

/** UI grouping for the mapping + audio-routing panels. */
export type ParamGroup = 'mix' | 'color' | 'geometry' | 'distortion' | 'look' | 'timecode';

export interface MidiParamDef {
  key: NumericVJField;
  label: string;
  min: number;
  max: number;
  /** CC number this param accepts by default. null = no auto-map. */
  autoCc: number | null;
  group: ParamGroup;
}

export const MIDI_PARAMS: MidiParamDef[] = [
  // ── Source / mix ────────────────────────────────────────────────
  { key: 'sourceBlend',        label: 'Crossfader (CAM/MEM)', min: 0,    max: 1,   autoCc: 8,    group: 'mix' },
  { key: 'autoSwitchInterval', label: 'Autoswitch Speed',     min: 1,    max: 30,  autoCc: null, group: 'mix' },
  // ── Color & optics ──────────────────────────────────────────────
  { key: 'brightness',  label: 'Brightness',    min: 0,   max: 200, autoCc: 7,    group: 'color' },
  { key: 'hue',         label: 'Hue Rotate',    min: 0,   max: 360, autoCc: 10,   group: 'color' },
  { key: 'saturation',  label: 'Saturation',    min: 0,   max: 300, autoCc: 78,   group: 'color' },
  { key: 'contrast',    label: 'Contrast',      min: 0,   max: 300, autoCc: null, group: 'color' },
  // ── Geometry ────────────────────────────────────────────────────
  { key: 'tiling',       label: 'Grid Tiling',   min: 1,   max: 8,   autoCc: null, group: 'geometry' },
  { key: 'radialSpokes', label: 'Radial Mirror', min: 0,   max: 24,  autoCc: 9,    group: 'geometry' },
  // ── Distortion & FX ─────────────────────────────────────────────
  { key: 'feedback',    label: 'Feedback',       min: 0,   max: 0.99, autoCc: 1,   group: 'distortion' },
  { key: 'glitch',      label: 'Glitch',         min: 0,   max: 1,   autoCc: 11,   group: 'distortion' },
  { key: 'rgbGhost',    label: 'RGB Ghost',      min: 0,   max: 1,   autoCc: 71,   group: 'distortion' },
  { key: 'chromaAb',    label: 'Chromatic Ab.',  min: 0,   max: 1,   autoCc: 72,   group: 'distortion' },
  { key: 'strobe',      label: 'Strobe',         min: 0,   max: 1,   autoCc: 73,   group: 'distortion' },
  { key: 'pixelate',    label: 'Pixelate',       min: 0,   max: 1,   autoCc: 74,   group: 'distortion' },
  { key: 'waveWarp',    label: 'Wave Warp',      min: 0,   max: 1,   autoCc: 75,   group: 'distortion' },
  { key: 'rgbSplit',    label: 'RGB Split',      min: 0,   max: 1,   autoCc: 76,   group: 'distortion' },
  { key: 'backskip',    label: 'Time Glitch',    min: 0,   max: 1,   autoCc: 77,   group: 'distortion' },
  // ── G1 look tier ────────────────────────────────────────────────
  { key: 'fxSepia',     label: 'Sepia',          min: 0,   max: 1,   autoCc: null, group: 'look' },
  { key: 'fxGrayscale', label: 'Grayscale',      min: 0,   max: 1,   autoCc: null, group: 'look' },
  { key: 'fxBlur',      label: 'Soft Blur',      min: 0,   max: 1,   autoCc: null, group: 'look' },
  // ── Sequencing / timecode ───────────────────────────────────────
  { key: 'bpm',          label: 'BPM',            min: 60,  max: 220, autoCc: null, group: 'timecode' },
  { key: 'playbackSpeed',label: 'Playback Speed', min: 0,   max: 4,   autoCc: null, group: 'timecode' },
  { key: 'echoTrails',   label: 'Echo Trails',    min: 0,   max: 40,  autoCc: null, group: 'timecode' },
  { key: 'slitScan',     label: 'Slit Scan',      min: 0,   max: 1,   autoCc: null, group: 'timecode' },
  { key: 'timeDisplace', label: 'Time Displace',  min: 0,   max: 1,   autoCc: null, group: 'timecode' },
  { key: 'posterizeTime',label: 'Posterize',      min: 1,   max: 60,  autoCc: null, group: 'timecode' },
];

export const MIDI_PARAMS_BY_KEY: Record<NumericVJField, MidiParamDef> = Object.fromEntries(
  MIDI_PARAMS.map((p) => [p.key, p]),
) as Record<NumericVJField, MidiParamDef>;

export const PARAM_GROUP_LABELS: Record<ParamGroup, string> = {
  mix: 'Source / Mix',
  color: 'Color & Optics',
  geometry: 'Geometry',
  distortion: 'Distortion & FX',
  look: 'Look Tier',
  timecode: 'Sequencing / Timecode',
};

/** Scale a 0-127 MIDI CC value into the target param's range. */
export function scaleCcValue(value: number, def: MidiParamDef): number {
  const clamped = Math.max(0, Math.min(127, value));
  const norm = clamped / 127;
  return def.min + norm * (def.max - def.min);
}

/** Scale a normalized 0..1 audio level into the target param's range. */
export function scaleAudioValue(level: number, def: MidiParamDef): number {
  const clamped = Math.max(0, Math.min(1, level));
  return def.min + clamped * (def.max - def.min);
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
