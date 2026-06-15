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
  /** Live-camera sub-source: a real capture device, a screen/window grabbed
   *  via getDisplayMedia, 'quest' — the direct theDAW QuestCast ADB/scrcpy
   *  relay decoded in-app with WebCodecs, or 'cymatics' — theDAW's reflective
   *  black-chrome cymatics visual rendered as a generative source. 'screen'
   *  remains as the fallback window-capture path. */
  cameraSource?: 'device' | 'screen' | 'quest' | 'cymatics';
  /** Active Cymatics mode when cameraSource==='cymatics'. */
  cymaticsMode?: 'orb' | 'cymatics' | 'landscape-chrome' | 'landscape-ferrofluid';
  /** Quest stereo-mirror crop: full SBS frame, or one eye cropped to 16:9. */
  questView?: 'full' | 'left' | 'right';
  /** Selected videoinput deviceId when cameraSource==='device' (the camera
   *  device picker). Null = browser default / facingMode. */
  cameraDeviceId?: string | null;
  /** Bump to force the live source to re-request (e.g. re-pick a screen/window
   *  or re-open a device) even when the other fields are unchanged. */
  cameraReinit?: number;
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
  /** Radial Mirror / Kaleidoscope. Number of angular sectors the
   *  frame is sliced into and mirrored around the center. 0 disables
   *  the effect; 2..24 produces increasingly fine reflection lines.
   *  Audio reactivity perturbs the rotation offset when audioReactive
   *  is on. Implemented in VideoOutput.tsx as a pre-composite pass. */
  radialSpokes: number;

  // ── Category A — additional GPU/geometry effects (no ML) ──────────
  /** Reaction-Diffusion Skin (Gray-Scott). 0 disables; 0..1 blends a
   *  Turing-pattern chemical-growth overlay (computed on a downsampled
   *  grid, seeded by frame luminance) over the composed frame. Bass
   *  energy perturbs the feed rate when audioReactive is on. */
  reactionDiffusion: number;
  /** SDF Raymarch Portal. 0 disables; 0..1 screen-composites a
   *  procedural signed-distance-field ring/tunnel raymarched on a
   *  downsampled buffer. Mid energy pulses the portal radius. */
  sdfPortal: number;
  /** Topographic Isolines. 0 disables; 0..1 quantizes frame luminance
   *  into discrete contour bands and draws the band boundaries as
   *  isoline strokes, mixed over the original by the amount. */
  topographic: number;
  /** Fluid Displacement. 0 disables; 0..1 drives a coarse velocity
   *  field from inter-frame pixel differences and smears the frame
   *  along it. Volume energy amplifies the displacement. */
  fluidDisplace: number;

  // ── Category B — depth / spatial / volumetric (pseudo-depth) ──────
  // These derive a cheap per-frame "depth proxy" from luminance (a
  // heavily-blurred luma channel approximates near/far: brighter, more
  // in-focus regions read as nearer). No ML model is required; the
  // proxy drives volumetric-style grades that read as 3D. Entries that
  // need a *true* metric depth net (point cloud, occlusion AR, RGBD,
  // camera-pose dolly, normals relight, depth-collision particles)
  // remain 'planned' until a depth runtime is wired in.
  /** Metric Depth Fog. 0 disables; 0..1 fades a fog colour into the
   *  frame by depth so far regions wash out. Bass thickens the fog. */
  depthFog: number;
  /** Tilt-Shift Miniature. 0 disables; 0..1 progressively blurs the
   *  frame away from a central horizontal focal band. */
  tiltShift: number;
  /** Z-Quantized Plane Splits. 0 disables; 0..1 segments the frame
   *  into near/mid/far depth bands and grades each (hue/contrast). */
  zPlanes: number;
  /** Depth-Edge Comic Outline. 0 disables; 0..1 runs a Sobel pass on
   *  the depth proxy and inks the geometric silhouette edges. */
  depthOutline: number;


  // Performance
  /** Render-scale tier. 'high' renders the canvas at full container
   *  resolution; 'medium' multiplies internal width/height by 0.75;
   *  'low' by 0.5. The CSS box stays the same size, so lower tiers
   *  trade sharpness for frame rate on weaker GPUs. */
  performanceMode: 'high' | 'medium' | 'low';

  
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

  // G1 effect tier — CSS-filter-driven looks that compose directly
  // into the existing canvas.style.filter chain. Cheap and
  // GPU-accelerated; add new entries here and wire into the styleStr
  // string in VideoOutput.tsx.
  /** Sepia tone amount 0..1. 0 = none, 1 = full sepia. */
  fxSepia?: number;
  /** Grayscale amount 0..1. */
  fxGrayscale?: number;
  /** Gaussian-style soft blur, slider value 0..1 maps to 0..20px. */
  fxBlur?: number;
  
  // Sequencing
  bpm: number;
  autoLFO: boolean;
  audioReactive: boolean;
  autoPilot: boolean;
  recording: boolean;
  /** Resolution the MediaRecorder canvas captures at — HD (1280x720),
   *  FHD (1920x1080), or UHD (3840x2160). Height-locked; width is
   *  derived from the live canvas's current aspect ratio so the
   *  recorded file matches what the user sees. */
  recordQuality?: '720p' | '1080p' | '4K';
  /** Delivery codec for the export. The browser always records webm
   *  (VP9); on stop the take is handed to the SA3 backend which ffmpeg-
   *  transcodes to this codec with audio muxed in. h264/h265 -> .mp4,
   *  prores -> .mov, pngseq -> zipped PNG frames + WAV. */
  recordCodec?: 'h264' | 'h265' | 'prores' | 'pngseq';
  /** Subfolder (under the backend's configured export root) the
   *  transcoded file lands in. Empty = the export root itself. */
  exportSubfolder?: string;
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

  // ── Live-set ergonomics (not persisted as creative state) ─────────
  /** Effect SOLO. When set to a plugin id, the renderer bypasses every
   *  other effect pass and shows ONLY that effect over the raw source,
   *  so the user can dial a single effect's mapping in isolation while
   *  setting up MIDI. null = normal (all enabled effects compose). The
   *  id matches pluginRegistry's PluginDef.id. */
  soloPluginId: string | null;
  /** Pushed by the SA3 host (sa3-vj/visibility) — false when the VJ tab
   *  is backgrounded so the render loop can park itself (≈0% GPU). True
   *  when standalone / visible. The renderer reads the live bridge value
   *  directly; this field mirrors it for any UI that wants to show it. */
  isTabVisible: boolean;
  /** Resolume-style clip grid dimensions (square cells). gridCols is clips per
   *  bank (row width); gridRows is the bank (row) count. Grown via the axis
   *  +/- buttons. Starts at one bank. */
  gridCols?: number;
  gridRows?: number;
  /** Deprecated: legacy bank-paging index, no longer used by the rows model. */
  gridBank?: number;
  /** Collapse/minimize state for the standard layout panels. */
  banksCollapsed?: boolean;
  rightPanelCollapsed?: boolean;
  /** Collapse state for the Library Pool browser above the banks. */
  poolCollapsed?: boolean;
}


export const DEFAULT_VJ_STATE: VJState = {
  layoutMode: 'standard',
  sourceType: 'camera',
  sourceBlend: 0,
  cameraSource: 'device',
  cymaticsMode: 'orb',
  questView: 'full',
  cameraDeviceId: null,
  cameraReinit: 0,
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
  gridCols: 10,
  gridRows: 1,
  gridBank: 0,
  poolCollapsed: false,

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
  radialSpokes: 0,

  reactionDiffusion: 0,
  sdfPortal: 0,
  topographic: 0,
  fluidDisplace: 0,

  depthFog: 0,
  tiltShift: 0,
  zPlanes: 0,
  depthOutline: 0,

  performanceMode: 'high',

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
  fxSepia: 0,
  fxGrayscale: 0,
  fxBlur: 0,
  
  bpm: 128,
  autoLFO: false,
  audioReactive: false,
  autoPilot: false,
  recording: false,
  recordQuality: '1080p',
  recordCodec: 'h264',
  exportSubfolder: '',
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

  soloPluginId: null,
  isTabVisible: true,
};


