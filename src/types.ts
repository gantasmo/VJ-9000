export interface VJState {
  // Input Source
  sourceType: 'camera' | 'clip';
  clipUrl: string | null;

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
    speed: number;
    chaos: number;
  };
  apWeights: Record<string, number>;
}

export const DEFAULT_VJ_STATE: VJState = {
  sourceType: 'camera',
  clipUrl: null,

  hue: 0,
  saturation: 150,
  contrast: 130,
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
    speed: 1.0,
    chaos: 0.5,
  },
  apWeights: {}
};

