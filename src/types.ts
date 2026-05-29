export interface VideoClip {
  id: string;
  name: string;
  url: string;
  size?: string;
  /** What kind of media this entry is. Audio entries play through
   *  the same <video> element (analyzer-driven, no frames); image
   *  entries aren't routed here — they go to imageUrl below. The
   *  bucket therefore holds video + audio clips; image is its own
   *  independent backdrop slot. */
  kind?: 'video' | 'audio';
}

export const DEFAULT_CLIPS: VideoClip[] = [];

export interface VJState {
  layoutMode: 'standard' | 'split' | 'preview' | 'fullscreen';
  // Input Source
  sourceType: 'camera' | 'clip';
  /** 0 = full CAM, 1 = full MEM clip. The CAM/MEM crossfader writes
   *  this; sourceType is kept in sync so the existing single-source
   *  renderer still works at the extremes. True dual-source
   *  compositing across mid-values is a VideoOutput follow-up. */
  sourceBlend?: number;
  clipUrl: string | null;
  /** Display label for the currently-loaded clip (file name). */
  clipLabel?: string | null;
  /** Set by the file router so the UI can label 'AUDIO LOADED' vs
   *  'VIDEO LOADED' without sniffing the URL. */
  clipKind?: 'video' | 'audio' | null;
  /** Static image rendered as a backdrop layer behind the WebGL
   *  canvas. Independent of clipUrl — user can have both at once. */
  imageUrl?: string | null;
  imageLabel?: string | null;
  /** When true, the next bucket entry auto-plays when the current
   *  clip ends. When false, playback stops at the end of each clip. */
  playlistAutoAdvance?: boolean;
  videoBucket: VideoClip[];
  activeClipId: string | null;
  autoSwitchClips: boolean;
  autoSwitchInterval: number; // Speed multiplier for switching
  clipAudio: boolean;

  // Color & Optics
  hue: number;
  saturation: number;
  contrast: number;
  brightness: number;
  invert: boolean;
  edgeDetect: boolean;
  
  // Geometry
  mirrorX: boolean;
  mirrorY: boolean;
  kaleidoscope: boolean;
  tiling: number;
  equirect: boolean;
  stereoMode: 'none' | 'sbs' | 'tb';
  softEdges: boolean;
  
  // Distortion & FX
  feedback: number;
  glitch: number;
  rgbGhost: number;
  rgbSplit: number; // For Anaglyph
  chromaAb: number; // Chromatic Aberration
  backskip: number; // Time glitch / buffer skip
  strobe: number;
  pixelate: number;
  waveWarp: number;
  
  // Post-Processing
  scanlines: boolean;
  vignette: boolean;
  crt: boolean;
  
  // Sequencing
  bpm: number;
  autoLFO: boolean;
  audioReactive: boolean;
  autoPilot: boolean;
  recording: boolean;
  aspectRatio: string;
  
  // Timecode
  playbackSpeed: number;
  reversePlayback: boolean;
  posterizeTime: number;
  echoTrails: number;
  slitScan: number;
  timeDisplace: number;
  
  // Autopilot specific configuration
  apConfig: {
    geo: boolean;
    corrupt: boolean;
    color: boolean;
    timecode: boolean;
    speed: number;
    chaos: number;
  };
  apWeights: Record<string, number>;
  apTriggerSource: 'volume' | 'bass' | 'mid-high' | 'time' | 'mixed' | 'chaos';
  apSensitivity: number;
  apRampType: 'none' | 'linear' | 'exponential' | 'sigmoid';
  apSubdueDepth: number;
  apModulateIntensity: boolean;
}

export const DEFAULT_VJ_STATE: VJState = {
  layoutMode: 'standard',
  sourceType: 'camera',
  sourceBlend: 0,
  clipUrl: null,
  clipLabel: null,
  clipKind: null,
  imageUrl: null,
  imageLabel: null,
  playlistAutoAdvance: true,
  videoBucket: [],
  activeClipId: null,
  autoSwitchClips: true,
  autoSwitchInterval: 8,
  clipAudio: false,

  hue: 0,
  saturation: 100,
  contrast: 100,
  brightness: 100,
  invert: false,
  edgeDetect: false,
  
  mirrorX: false,
  mirrorY: false,
  kaleidoscope: false,
  tiling: 1,
  equirect: false,
  stereoMode: 'none',
  softEdges: true,
  
  feedback: 0.85,
  glitch: 0,
  rgbGhost: 0,
  rgbSplit: 0,
  chromaAb: 0,
  backskip: 0,
  strobe: 0,
  pixelate: 0,
  waveWarp: 0,
  
  scanlines: true,
  vignette: true,
  crt: true,
  
  bpm: 128,
  autoLFO: false,
  audioReactive: false,
  autoPilot: false,
  recording: false,
  aspectRatio: 'free',
  
  playbackSpeed: 1.0,
  reversePlayback: false,
  posterizeTime: 60,
  echoTrails: 0,
  slitScan: 0,
  timeDisplace: 0,
  
  apConfig: {
    geo: true,
    corrupt: true,
    color: true,
    timecode: true,
    speed: 1.5,
    chaos: 0.6,
  },
  apWeights: {},
  apTriggerSource: 'mixed',
  apSensitivity: 0.15,
  apRampType: 'linear',
  apSubdueDepth: 0.1,
  apModulateIntensity: true,
};

