import React, { useEffect, useRef } from 'react';
import { VJState } from '../types';
import { AudioLevels } from '../useAudioAnalyzer';
import { computeAudioModulation } from '../audioRouting';
import { getVisibility } from '../sa3Bridge';
import { PLUGIN_REGISTRY } from '../pluginRegistry';

// SOLO support. Built once from the plugin registry so it stays in sync
// as plugins are added (no hand-maintained duplicate).
//   - PLUGIN_PARAM_KEYS: plugin id → the VJState keys that plugin owns.
//   - EFFECT_NEUTRAL: every effect-owned key → its "off" value (a range
//     param's min, a toggle's false). Used to silence all other effects.
const PLUGIN_PARAM_KEYS: Record<string, Array<keyof VJState>> = {};
const EFFECT_NEUTRAL: Partial<Record<keyof VJState, number | boolean>> = {};
for (const p of PLUGIN_REGISTRY) {
  PLUGIN_PARAM_KEYS[p.id] = p.params.map((param) => param.key);
  for (const param of p.params) {
    EFFECT_NEUTRAL[param.key] =
      param.control.kind === 'toggle' ? false : param.control.min;
  }
}

/**
 * SOLO mode. When s.soloPluginId is set, returns a derived state where
 * every effect-owned parameter is forced to its neutral/off value
 * EXCEPT the soloed plugin's own params, and the global auto-modulators
 * (autoPilot / autoLFO) are disabled — so only that single effect shows
 * over the raw source while the user dials in its MIDI mapping. Audio
 * reactivity is left intact so reactive mappings can still be tested.
 * Returns the input unchanged when nothing is soloed (zero overhead).
 */
function applySolo(s: VJState): VJState {
  if (!s.soloPluginId) return s;
  const keep = new Set(PLUGIN_PARAM_KEYS[s.soloPluginId] ?? []);
  const next: VJState = { ...s, autoPilot: false, autoLFO: false };
  for (const key in EFFECT_NEUTRAL) {
    const k = key as keyof VJState;
    if (!keep.has(k)) {
      (next as unknown as Record<string, unknown>)[k] = EFFECT_NEUTRAL[k];
    }
  }
  return next;
}



// The SA3 FastAPI backend listens on :8600 on the same host that serves
// this VJ iframe, so we can reach it for the export transcode. Works for
// localhost and LAN; a solo-run VJ (no backend) falls back to a webm
// download (see uploadTake).
const SA3_BACKEND_PORT = 8600;

function sa3BackendBase(): string {
  const proto = window.location.protocol === 'https:' ? 'https:' : 'http:';
  return `${proto}//${window.location.hostname}:${SA3_BACKEND_PORT}`;
}

/** Hand a recorded webm take to the SA3 backend for ffmpeg transcode to
 *  the chosen codec (audio muxed in), saved under the configured export
 *  root / subfolder. Notifies the parent SA3 window so it can log the
 *  result. On any failure, downloads the raw webm so the take is never
 *  lost. */
async function uploadTake(
  blob: Blob,
  codec: string,
  resolution: string,
  subfolder: string,
): Promise<void> {
  const notifyParent = (type: string, detail: Record<string, unknown>) => {
    try {
      window.parent?.postMessage({ type, ...detail }, '*');
    } catch {
      /* no parent (solo run) — ignore */
    }
  };
  try {
    const form = new FormData();
    form.append('file', blob, `take_${new Date().getTime()}.webm`);
    form.append('codec', codec);
    form.append('resolution', resolution);
    form.append('subfolder', subfolder);
    const res = await fetch(`${sa3BackendBase()}/api/vj/export`, {
      method: 'POST',
      body: form,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`export failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    console.log('[vj] export saved:', data.path);
    notifyParent('sa3-vj/export-done', {
      path: data.path,
      filename: data.filename,
      codec: data.codec,
      folder: data.folder,
    });
  } catch (e) {
    console.error('[vj] export failed — falling back to webm download', e);
    notifyParent('sa3-vj/export-error', {
      message: e instanceof Error ? e.message : String(e),
    });
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = `LUMINA_RECORDING_${new Date().getTime()}.webm`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch {
      /* last-ditch — nothing more we can do */
    }
  }
}


interface VideoOutputProps {
  vjState: VJState;
  videoRef: React.RefObject<HTMLVideoElement>;
  cameraVideoRef?: React.RefObject<HTMLVideoElement>;
  clipVideoRef?: React.RefObject<HTMLVideoElement>;
  getAudioLevels: () => AudioLevels;
  onAutopilotSwitchClip?: () => void;
}

export function VideoOutput({ vjState, videoRef, cameraVideoRef, clipVideoRef, getAudioLevels, onAutopilotSwitchClip }: VideoOutputProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recordCanvasRef = useRef<HTMLCanvasElement>(null);
  
  const stateRef = useRef(vjState);
  useEffect(() => {
    stateRef.current = vjState;
  }, [vjState]);

  const onSwitchClipRef = useRef(onAutopilotSwitchClip);
  useEffect(() => {
    onSwitchClipRef.current = onAutopilotSwitchClip;
  }, [onAutopilotSwitchClip]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    if (!recordCanvasRef.current) {
        recordCanvasRef.current = document.createElement('canvas');
    }
    
    let active = true;
    let localMicStream: MediaStream | null = null;
    let audioCtx: AudioContext | null = null;
    
    const startRecording = async () => {
      if (!recordCanvasRef.current) return;
      // Lock the record canvas to the user-selected quality height
      // and derive width from the live display canvas's aspect so
      // the file matches what they see. The render loop's recordCanvas
      // branch (further down) detects a recording in progress and
      // uses scaled drawImage instead of auto-resizing.
      const qualityHeights: Record<string, number> = { '720p': 720, '1080p': 1080, '4K': 2160 };
      const resolution = vjState.recordQuality ?? '1080p';
      const targetH = qualityHeights[resolution] ?? 1080;
      // Snapshot the export choices now — the selects lock mid-take, so
      // these can't change before onstop fires.
      const codec = vjState.recordCodec ?? 'h264';
      const subfolder = vjState.exportSubfolder ?? '';
      const liveCanvas = canvasRef.current;
      const aspect = liveCanvas && liveCanvas.height > 0
        ? liveCanvas.width / liveCanvas.height
        : 16 / 9;
      // Force EVEN width/height. h264/h265 (yuv420p) and prores (422) all
      // reject odd dimensions — the encoder won't even open ("width not
      // divisible by 2"), which surfaced as a 500 on /api/vj/export. Deriving
      // width from the aspect routinely lands odd (e.g. 720p*305/144 = 1525),
      // so round each axis down to the nearest even pixel here at the source.
      const evenDown = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
      recordCanvasRef.current.width = evenDown(targetH * aspect);
      recordCanvasRef.current.height = evenDown(targetH);
      const stream = recordCanvasRef.current.captureStream(30);
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      audioCtx = new AudioContextClass();
      const dest = audioCtx.createMediaStreamDestination();
      let hasAudio = false;

      // 1. Try source audio (prefer MEM clip when clip audio is enabled,
      // otherwise prefer camera feed). Keep `videoRef` as a fallback for
      // older wiring.
      const preferredVideoEl = vjState.clipAudio
        ? (clipVideoRef?.current ?? videoRef.current)
        : (cameraVideoRef?.current ?? videoRef.current);
      if (preferredVideoEl) {
          try {
              if (preferredVideoEl.srcObject && preferredVideoEl.srcObject instanceof MediaStream) {
                  const tracks = (preferredVideoEl.srcObject as MediaStream).getAudioTracks();
                  if (tracks.length > 0) {
                      const source = audioCtx.createMediaStreamSource(preferredVideoEl.srcObject as MediaStream);
                      source.connect(dest);
                      hasAudio = true;
                  }
              } else {
                 const anyVid = preferredVideoEl as any;
                 const capturedStream = anyVid.captureStream ? anyVid.captureStream() : anyVid.mozCaptureStream ? anyVid.mozCaptureStream() : null;
                 if (capturedStream && capturedStream.getAudioTracks().length > 0) {
                     const source = audioCtx.createMediaStreamSource(capturedStream);
                     source.connect(dest);
                     hasAudio = true;
                 }
              }
          } catch(e) {
              console.warn("Could not capture audio stream from video", e);
          }
      }

      // 2. Try Mic Audio explicitly if we don't have video audio (e.g. they want to record the live set music)
      if (!hasAudio || vjState.audioReactive) {
         try {
             localMicStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
             if (localMicStream && localMicStream.getAudioTracks().length > 0) {
                 const source = audioCtx.createMediaStreamSource(localMicStream);
                 source.connect(dest);
                 hasAudio = true;
             }
         } catch(e) {
             console.warn("Could not get mic access for recording", e);
         }
      }

      if (!active) {
         // Cleanup if recording stopped while we were waiting for mic
         if (localMicStream) localMicStream.getTracks().forEach(t => t.stop());
         if (audioCtx) audioCtx.close();
         return;
      }

      if (hasAudio) {
         dest.stream.getAudioTracks().forEach(track => stream.addTrack(track));
      }

      try {
        const options = { mimeType: 'video/webm; codecs=vp9' };
        const recorder = new MediaRecorder(stream, options);
        mediaRecorderRef.current = recorder;
        recordedChunksRef.current = [];
        
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            recordedChunksRef.current.push(e.data);
          }
        };
        
        recorder.onstop = () => {
          const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
          // Hand the take to the SA3 backend, which ffmpeg-transcodes it
          // to the chosen codec (audio muxed in) and writes it under the
          // configured export root / subfolder. Falls back to a raw webm
          // download if the backend is unreachable (e.g. VJ run solo).
          void uploadTake(blob, codec, resolution, subfolder);
        };
        
        recorder.start();
      } catch (e) {
        console.error('MediaRecorder error', e);
      }
    };

    if (vjState.recording) {
      startRecording();
    } else {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      if (localMicStream) {
          localMicStream.getTracks().forEach(t => t.stop());
      }
      if (audioCtx) {
          audioCtx.close().catch(() => {});
      }
    }
    
    return () => {
       active = false;
    }
  }, [vjState.recording]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d', { alpha: false }); 
    if (!ctx) return;

    const offCanvas = document.createElement('canvas');
    const offCtx = offCanvas.getContext('2d', { alpha: false });
    
    // For Stereo 3D compositing
    const compostCanvas = document.createElement('canvas');
    const compostCtx = compostCanvas.getContext('2d', { alpha: false });
    
    // For Slit scan / Time displacement / Echo trails
    const slitCanvas = document.createElement('canvas');
    const slitCtx = slitCanvas.getContext('2d', { alpha: true });
    const blendCanvas = document.createElement('canvas');
    const blendCtx = blendCanvas.getContext('2d', { alpha: false });

    // ── Category A scratch buffers (Reaction-Diffusion, SDF Portal,
    // Topographic, Fluid Displacement). Each effect computes on a small
    // downsampled grid then composites up to the full canvas so the
    // 2D-canvas pipeline stays at 60fps even on weak GPUs. The buffers
    // persist across frames (the RD chemical field and the fluid
    // velocity field are inherently temporal). ──────────────────────
    // Reaction-Diffusion: ping-pong Gray-Scott chemical concentration
    // grids (Float32 A/B per cell) + an ImageData we paint the pattern
    // into for compositing.
    const RD_W = 160;
    const RD_H = 90;
    let rdA = new Float32Array(RD_W * RD_H).fill(1);
    let rdB = new Float32Array(RD_W * RD_H).fill(0);
    let rdA2 = new Float32Array(RD_W * RD_H);
    let rdB2 = new Float32Array(RD_W * RD_H);
    let rdSeeded = false;
    const rdCanvas = document.createElement('canvas');
    rdCanvas.width = RD_W;
    rdCanvas.height = RD_H;
    const rdCtx = rdCanvas.getContext('2d', { alpha: true });
    const rdImage = rdCtx ? rdCtx.createImageData(RD_W, RD_H) : null;

    // SDF Portal: drawn procedurally with canvas vector ops onto a
    // half-res buffer, then screen-composited.
    const sdfCanvas = document.createElement('canvas');
    const sdfCtx = sdfCanvas.getContext('2d', { alpha: true });

    // Fluid Displacement: coarse velocity field derived from luma
    // differences between the current and previous downsampled frame.
    const FLOW_W = 64;
    const FLOW_H = 36;
    let flowPrev = new Float32Array(FLOW_W * FLOW_H);
    const flowVx = new Float32Array(FLOW_W * FLOW_H);
    const flowVy = new Float32Array(FLOW_W * FLOW_H);
    const flowSampleCanvas = document.createElement('canvas');
    flowSampleCanvas.width = FLOW_W;
    flowSampleCanvas.height = FLOW_H;
    const flowSampleCtx = flowSampleCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    const fxScratch = document.createElement('canvas');
    const fxScratchCtx = fxScratch.getContext('2d', { alpha: false, willReadFrequently: true });

    // ── Category B scratch buffers (pseudo-depth volumetric looks) ──
    // A single shared "depth proxy" is derived once per frame from a
    // heavily-blurred luminance pass: blurring collapses high-frequency
    // detail so broad bright/in-focus regions read as "near" and dark/
    // smooth regions as "far". DEPTH_W/H is small; the blur is a couple
    // of box passes so the whole thing stays well under a millisecond.
    // depthProxy[i] in 0..1 (0 = far, 1 = near). Reused by fog, tilt-
    // shift, z-planes, and the depth-edge outline passes below.
    const DEPTH_W = 96;
    const DEPTH_H = 54;
    const depthProxy = new Float32Array(DEPTH_W * DEPTH_H);
    const depthTmp = new Float32Array(DEPTH_W * DEPTH_H);
    const depthSampleCanvas = document.createElement('canvas');
    depthSampleCanvas.width = DEPTH_W;
    depthSampleCanvas.height = DEPTH_H;
    const depthSampleCtx = depthSampleCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
    // Buffer the depth field is painted into for compositing (fog tint,
    // outline ink) at full canvas size via upscaled drawImage.
    const depthCanvas = document.createElement('canvas');
    depthCanvas.width = DEPTH_W;
    depthCanvas.height = DEPTH_H;
    const depthCtx = depthCanvas.getContext('2d', { alpha: true });
    const depthImage = depthCtx ? depthCtx.createImageData(DEPTH_W, DEPTH_H) : null;
    let depthBuilt = false;

    // Builds depthProxy from the current main canvas. Lazy: only the
    // first Category-B pass each frame that needs depth calls this, and
    // it flips depthBuilt so later passes reuse the same field. The
    // caller resets depthBuilt = false at the top of each frame.
    const buildDepthProxy = () => {
      if (!depthSampleCtx || depthBuilt) return;
      depthSampleCtx.drawImage(canvas, 0, 0, DEPTH_W, DEPTH_H);
      const d = depthSampleCtx.getImageData(0, 0, DEPTH_W, DEPTH_H).data;
      for (let i = 0; i < DEPTH_W * DEPTH_H; i++) {
        const p = i * 4;
        depthProxy[i] = (d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114) / 255;
      }
      // Two separable box-blur passes approximate a Gaussian so the
      // proxy is smooth (depth shouldn't have hard pixel edges).
      for (let pass = 0; pass < 2; pass++) {
        // horizontal
        for (let y = 0; y < DEPTH_H; y++) {
          for (let x = 0; x < DEPTH_W; x++) {
            const x0 = Math.max(0, x - 2);
            const x1 = Math.min(DEPTH_W - 1, x + 2);
            let sum = 0;
            for (let xx = x0; xx <= x1; xx++) sum += depthProxy[y * DEPTH_W + xx];
            depthTmp[y * DEPTH_W + x] = sum / (x1 - x0 + 1);
          }
        }
        // vertical
        for (let y = 0; y < DEPTH_H; y++) {
          for (let x = 0; x < DEPTH_W; x++) {
            const y0 = Math.max(0, y - 2);
            const y1 = Math.min(DEPTH_H - 1, y + 2);
            let sum = 0;
            for (let yy = y0; yy <= y1; yy++) sum += depthTmp[yy * DEPTH_W + x];
            depthProxy[y * DEPTH_W + x] = sum / (y1 - y0 + 1);
          }
        }
      }
      depthBuilt = true;
    };

    
    // Frame buffer for backskip and time displacement. The 60 canvas OBJECTS
    // are created up front (cheap — a canvas with no backing store costs almost
    // nothing), but a slot only gets a full-resolution backing store when it's
    // actually drawn into. Crucially we only CYCLE through the whole ring while
    // a time-history effect is active; otherwise we reuse a single slot, so the
    // other 59 never get sized up to full res — a big VRAM saving on low-VRAM
    // GPUs (the 6 GB-laptop case). See the sampling block below.
    const bufferSize = 60;
    const frameBuffer: HTMLCanvasElement[] = [];
    for(let i=0; i<bufferSize; i++) {
        frameBuffer.push(document.createElement('canvas'));
    }
    let frameIndex = 0;

    // SVG filter primitives — looked up once and cached, not re-queried (×6
    // document.getElementById) every frame. Last-set attribute strings are
    // cached too so we only call setAttribute (which forces an SVG filter
    // recompile) when a value actually changes.
    let svgWarpDisp: Element | null = null;
    let svgWarpTurb: Element | null = null;
    let svgRgbRed: Element | null = null;
    let svgRgbBlue: Element | null = null;
    let lastWarpScale = '';
    let lastWarpFreq = '';
    let lastRgbDx = '';
    let lastRgbDy = '';

    // Container size tracked via ResizeObserver instead of reading
    // clientWidth/clientHeight every frame (which forces a layout reflow each
    // tick). Seeded once synchronously so the first frame has real dimensions.
    let containerW = canvas.parentElement?.clientWidth ?? 0;
    let containerH = canvas.parentElement?.clientHeight ?? 0;
    let resizeObs: ResizeObserver | null = null;
    if (canvas.parentElement && typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver((entries) => {
        const cr = entries[0]?.contentRect;
        if (cr) { containerW = cr.width; containerH = cr.height; }
      });
      resizeObs.observe(canvas.parentElement);
    }

    // RD luminance re-seed is throttled to every Nth frame (the canvas→buffer
    // blit + readback is expensive); the pattern still tracks content closely.
    let rdReseedTick = 0;

    let animationId: number;
    
    // --- AUTOPILOT Brain State ---
    let apTimer = 0;
    let apState = {
       hue: 0, sat: 100, contrast: 100, bright: 100, feedback: 0,
       kaleido: false, mirrorX: false, mirrorY: false, invert: false, edgeDetect: false,
       pixelate: 0, waveWarp: 0, rgbSplit: 0, glitch: 0,
       tiling: 1, equirect: false, stereoMode: 'none',
       chromaAb: 0, backskip: 0, softEdges: false,
       playbackSpeed: 1, reversePlayback: false, posterizeTime: 60, echoTrails: 0, slitScan: 0, timeDisplace: 0,
       dropCooldown: 0,
    };
    let apTargets = {
       cycleLength: 6.0,
       hue: Math.random() * 360, sat: 100, contrast: 100, feedback: 0.5,
       pixelate: 0, waveWarp: 0, rgbSplit: 0, glitch: 0,
       chromaAb: 0, backskip: 0, 
       playbackSpeed: 1, posterizeTime: 60, echoTrails: 0, slitScan: 0, timeDisplace: 0,
    };
    
    let bassSmooth = 0;
    
    // Timecode Tracking
    let lastVideoUpdate = 0;
    let fallbackVideoUpdate = 0;

    const renderLoop = (timestamp: number) => {
      animationId = requestAnimationFrame(renderLoop);

      // PARK WHEN HIDDEN. When the SA3 host backgrounds the VJ tab it
      // posts sa3-vj/visibility:false; we keep the rAF alive (so the
      // loop resumes instantly when shown again) but skip ALL drawing
      // and analysis work, dropping the iframe to ≈0% GPU. Always true
      // standalone, so this is a no-op outside SA3.
      if (!getVisibility()) return;

      const camVideo = cameraVideoRef?.current ?? null;
      const memVideo = clipVideoRef?.current ?? null;
      const legacyVideo = videoRef.current ?? null;
      const hasCam = !!camVideo && camVideo.readyState >= 2 && camVideo.videoWidth > 0;
      const hasMem = !!memVideo && memVideo.readyState >= 2 && memVideo.videoWidth > 0;
      if (!hasCam && !hasMem) return;

      // SOLO mode neutralises every other effect when a plugin is soloed
      // so the operator can dial one effect's mapping in isolation; a
      // no-op (returns the same object) when nothing is soloed.
      const s = applySolo(stateRef.current);

      
      // Performance tier scales the internal backing-store resolution
      // while the CSS box (w-full h-full) stays the same size, so the
      // browser upscales a cheaper render on weaker GPUs.
      const perfScale = s.performanceMode === 'low' ? 0.5 : s.performanceMode === 'medium' ? 0.75 : 1.0;
      if (containerW > 0 && containerH > 0) {
        const targetW = Math.max(2, Math.round(containerW * perfScale));
        const targetH = Math.max(2, Math.round(containerH * perfScale));
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }
      }

      const w = canvas.width;
      const h = canvas.height;
      if (w === 0 || h === 0) return;

      // Category-B depth proxy is rebuilt on demand once per frame; reset
      // the cache flag here so the first B pass that needs it recomputes.
      depthBuilt = false;

      // --- PARAMETER RESOLUTION ---
      let currentGlitch = s.glitch;
      let currentGhost = s.rgbGhost;
      let currentStrobe = s.strobe;
      let currentPixelate = s.pixelate;
      let currentWave = s.waveWarp;
      let currentSplit = s.rgbSplit;
      let currentChromaAb = s.chromaAb;
      let currentBackskip = s.backskip;
      let currentSoft = s.softEdges;
      
      let currentFeedback = s.feedback;
      let currentKaleido = s.kaleidoscope;
      let currentMirrorX = s.mirrorX;
      let currentMirrorY = s.mirrorY;
      let currentTiling = s.tiling;
      let currentEquirect = s.equirect;
      let currentStereo: 'none'|'sbs'|'tb' = s.stereoMode;
      
      let currentHue = s.hue;
      let currentSat = s.saturation;
      let currentContrast = s.contrast;
      let currentBright = s.brightness;
      let currentInvert = s.invert;
      let currentEdge = s.edgeDetect;
      
      let currentPlaybackSpeed = s.playbackSpeed;
      let currentReversePlayback = s.reversePlayback;
      let currentPosterizeTime = s.posterizeTime;
      let currentEchoTrails = s.echoTrails;
      let currentSlitScan = s.slitScan;
      let currentTimeDisplace = s.timeDisplace;
      
      let zoomScale = 1.0;
      let isAudioStrobe = false;
      
      const audio = getAudioLevels();
      const powBass = Math.pow(audio.bass, 3); 
      
      bassSmooth = bassSmooth * 0.9 + powBass * 0.1;

      // --- PER-EFFECT AUDIO ROUTING ---
      // Every mappable parameter can be individually routed to an audio
      // band via the Audio Reactivity panel (see audioRouting.ts). When
      // the master `audioReactive` flag is on, fold each routed value
      // over its base before the rest of the pipeline reads it. Only
      // routed keys appear in `audioMod`, so unrouted params keep their
      // base value untouched.
      const audioMod = computeAudioModulation(s, audio);
      if (audioMod.glitch !== undefined) currentGlitch = audioMod.glitch;
      if (audioMod.rgbGhost !== undefined) currentGhost = audioMod.rgbGhost;
      if (audioMod.strobe !== undefined) currentStrobe = audioMod.strobe;
      if (audioMod.pixelate !== undefined) currentPixelate = audioMod.pixelate;
      if (audioMod.waveWarp !== undefined) currentWave = audioMod.waveWarp;
      if (audioMod.rgbSplit !== undefined) currentSplit = audioMod.rgbSplit;
      if (audioMod.chromaAb !== undefined) currentChromaAb = audioMod.chromaAb;
      if (audioMod.backskip !== undefined) currentBackskip = audioMod.backskip;
      if (audioMod.feedback !== undefined) currentFeedback = audioMod.feedback;
      if (audioMod.tiling !== undefined) currentTiling = audioMod.tiling;
      if (audioMod.hue !== undefined) currentHue = audioMod.hue;
      if (audioMod.saturation !== undefined) currentSat = audioMod.saturation;
      if (audioMod.contrast !== undefined) currentContrast = audioMod.contrast;
      if (audioMod.brightness !== undefined) currentBright = audioMod.brightness;
      if (audioMod.playbackSpeed !== undefined) currentPlaybackSpeed = audioMod.playbackSpeed;
      if (audioMod.posterizeTime !== undefined) currentPosterizeTime = audioMod.posterizeTime;
      if (audioMod.echoTrails !== undefined) currentEchoTrails = audioMod.echoTrails;
      if (audioMod.slitScan !== undefined) currentSlitScan = audioMod.slitScan;
      if (audioMod.timeDisplace !== undefined) currentTimeDisplace = audioMod.timeDisplace;

      
      if (s.autoPilot) {
         const { speed, chaos, geo, corrupt, color, timecode } = s.apConfig;
         
         const aw = (k: string) => s.apWeights && s.apWeights[k] !== undefined ? s.apWeights[k] : 1.0;
         
         // 1. DYNAMIC TRIGGER SIGNAL CALCULATION
         let activeTriggerLevel = 0.0;
         const timeMs = performance.now();
         const timeRamp = 0.5 + 0.5 * Math.sin(timeMs * 0.001 * speed);
         const rawChaosSignal = 0.5 + 0.5 * Math.sin(timeMs * 0.002) * Math.cos(timeMs * 0.0007);
         
         switch(s.apTriggerSource) {
            case 'volume':
               activeTriggerLevel = s.audioReactive ? Math.min(1.0, audio.volume * 5.0) : timeRamp;
               break;
            case 'bass':
               activeTriggerLevel = s.audioReactive ? Math.min(1.0, audio.bass * 2.5) : Math.pow(timeRamp, 1.5);
               break;
            case 'mid-high':
               activeTriggerLevel = s.audioReactive ? Math.min(1.0, (audio.mid + audio.high) * 2.5) : Math.abs(Math.sin(timeMs * 0.0015));
               break;
            case 'time':
               activeTriggerLevel = timeRamp;
               break;
            case 'chaos':
               activeTriggerLevel = Math.max(0, Math.min(1, rawChaosSignal + (Math.random() - 0.5) * chaos));
               break;
            case 'mixed':
            default:
               if (s.audioReactive) {
                  activeTriggerLevel = Math.min(1.0, (audio.volume * 2.0 + audio.bass * 2.0) / 2.0);
               } else {
                  activeTriggerLevel = 0.4 * timeRamp + 0.6 * rawChaosSignal;
               }
               break;
         }

         // 2. RAMPS & OPTIONAL SIGNAL TRANSLATIONS
         let modScalar = activeTriggerLevel;
         if (s.apRampType === 'none') {
            modScalar = 1.0;
         } else if (s.apRampType === 'exponential') {
            modScalar = Math.pow(activeTriggerLevel, 2.0);
         } else if (s.apRampType === 'sigmoid') {
            modScalar = 1.0 / (1.0 + Math.exp(-((activeTriggerLevel - 0.5) * 10.0)));
         }

         // 3. SENSITIVITY ATTENUATION / SYSTEM SUBDUE
         let gateFactor = 1.0;
         let timerSpeedMultiplier = 1.0;
         
         if (activeTriggerLevel < s.apSensitivity) {
            const ratio = s.apSensitivity > 0 ? (activeTriggerLevel / s.apSensitivity) : 0;
            // Scale smoothly down to subdued minimum
            gateFactor = s.apSubdueDepth + (1.0 - s.apSubdueDepth) * ratio;
            timerSpeedMultiplier = ratio;
            
            // If we are below half of the threshold, fully pause trigger cycle and switching
            if (ratio < 0.5) {
               timerSpeedMultiplier = 0.0;
            }
         }

         const apIntensityMultiplier = s.apModulateIntensity ? (gateFactor * modScalar) : gateFactor;
         const isSubdued = gateFactor < 0.25;
         
         apTimer += (1/60) * speed * timerSpeedMultiplier;
         if (apTimer > apTargets.cycleLength && s.autoSwitchClips && onSwitchClipRef.current) {
            setTimeout(() => {
               onSwitchClipRef.current?.();
            }, 0);
         }
         if (apTimer > apTargets.cycleLength) { 
            apTimer = 0;
            // Variable cycle length based on chaos (3s to 12s roughly)
            apTargets.cycleLength = 3.0 + Math.random() * 6.0 * (1.5 - chaos * 0.5);

            // Tasteful FX Selection - pick 1 or 2 focal effects per cycle
            const focalFX = Math.random();
            const fxLevel = Math.random() * chaos + 0.1; // Ensure somewhat visible if selected

            // --- Reset all targets back to baseline to prevent messy overlap ---
            apTargets.pixelate = 0;
            apTargets.waveWarp = 0;
            apTargets.rgbSplit = 0;
            apTargets.glitch = 0;
            apTargets.chromaAb = 0;
            apTargets.backskip = 0;
            apTargets.playbackSpeed = 1;
            apTargets.posterizeTime = 60;
            apTargets.echoTrails = 0;
            apTargets.slitScan = 0;
            apTargets.timeDisplace = 0;
            apTargets.feedback = 0;
            
            // Turn off most booleans
            apState.kaleido = false;
            apState.mirrorX = false;
            apState.mirrorY = false;
            apState.edgeDetect = false;
            apState.equirect = false;
            apState.stereoMode = 'none';
            apState.tiling = 1;
            apState.reversePlayback = false;
            apState.invert = false;
            
            // Gently drift colors over time instead of frantic jumping
            apTargets.hue = (apState.hue + 30 + Math.random() * 120) % 360; 
            apTargets.sat = 90 + Math.random() * 210 * chaos;
            apTargets.contrast = 100 + Math.random() * 150 * chaos;

            // Group 1: Geometry / Space (20%)
            if (focalFX < 0.20) {
               if (aw('kaleido') > 0 && Math.random() > 0.4) apState.kaleido = true;
               else if (aw('tiling') > 0 && Math.random() > 0.3) apState.tiling = Math.floor(1 + Math.random() * 3 * fxLevel);
               if (aw('waveWarp') > 0) apTargets.waveWarp = 0.15 * fxLevel * aw('waveWarp');
            } 
            // Group 2: Temporal Smear / Stutter (20%)
            else if (focalFX < 0.40) {
               if (aw('posterizeTime') > 0) apTargets.posterizeTime = Math.floor(8 + Math.random() * 20); // Not too low
               if (aw('echoTrails') > 0) apTargets.echoTrails = 8 * fxLevel * aw('echoTrails');
            } 
            // Group 3: Spatial Distortion (20%)
            else if (focalFX < 0.60) {
               if (aw('pixelate') > 0) apTargets.pixelate = 0.15 * fxLevel * aw('pixelate');
               if (aw('timeDisplace') > 0) apTargets.timeDisplace = 0.3 * fxLevel * aw('timeDisplace');
            } 
            // Group 4: Digital Corruption (20%)
            else if (focalFX < 0.80) {
               if (aw('chromaAb') > 0) apTargets.chromaAb = 0.8 * fxLevel * aw('chromaAb');
               if (aw('rgbSplit') > 0) apTargets.rgbSplit = 0.3 * fxLevel * aw('rgbSplit');
               if (aw('glitch') > 0 && Math.random() > 0.5) apTargets.glitch = 0.2 * fxLevel * aw('glitch');
            } 
            // Group 5: Playback Manipulation (20%)
            else {
               if (aw('playbackSpeed') > 0) apTargets.playbackSpeed = 0.4 + Math.random() * 1.6 * fxLevel;
               if (aw('reversePlayback') > 0 && Math.random() > 0.6) apState.reversePlayback = true;
               if (aw('backskip') > 0 && Math.random() > 0.5) apTargets.backskip = 0.4 * fxLevel * aw('backskip');
               if (aw('slitScan') > 0 && Math.random() > 0.5) apTargets.slitScan = 0.3 * fxLevel * aw('slitScan');
            }
            
            // Global independent tasteful sprinkles
            if (aw('feedback') > 0 && Math.random() > 0.8) apTargets.feedback = Math.random() * 0.85 * fxLevel * aw('feedback');
            if (aw('edgeDetect') > 0 && chaos > 0.7 && Math.random() > 0.85) apState.edgeDetect = true;
            if (aw('mirrorX') > 0 && Math.random() > 0.85) apState.mirrorX = true;
            if (aw('mirrorY') > 0 && Math.random() > 0.85) apState.mirrorY = true;
         }
         
         // Smooth Interpolation
         apState.hue += (apTargets.hue - apState.hue) * 0.05 * speed;
         apState.sat += (apTargets.sat - apState.sat) * 0.05 * speed;
         apState.contrast += (apTargets.contrast - apState.contrast) * 0.05 * speed;
         apState.feedback += (apTargets.feedback - apState.feedback) * 0.05 * speed;
         apState.pixelate += (apTargets.pixelate - apState.pixelate) * 0.05 * speed;
         apState.waveWarp += (apTargets.waveWarp - apState.waveWarp) * 0.05 * speed;
         apState.rgbSplit += (apTargets.rgbSplit - apState.rgbSplit) * 0.05 * speed;
         apState.glitch += (apTargets.glitch - apState.glitch) * 0.1 * speed;
         
         apState.chromaAb += (apTargets.chromaAb - apState.chromaAb) * 0.05 * speed;
         apState.backskip += (apTargets.backskip - apState.backskip) * 0.1 * speed;
         apState.playbackSpeed += (apTargets.playbackSpeed - apState.playbackSpeed) * 0.05 * speed;
         apState.posterizeTime += (apTargets.posterizeTime - apState.posterizeTime) * 0.1 * speed;
         apState.echoTrails += (apTargets.echoTrails - apState.echoTrails) * 0.05 * speed;
         apState.slitScan += (apTargets.slitScan - apState.slitScan) * 0.05 * speed;
         apState.timeDisplace += (apTargets.timeDisplace - apState.timeDisplace) * 0.1 * speed;
         
         // Drop Detection
         let autoPilotDrop = false;
         if (powBass > 0.6 && powBass > bassSmooth * 2.5 && apState.dropCooldown <= 0) {
             autoPilotDrop = true;
             apState.dropCooldown = 1.0 + Math.random() * 2.0; // Dynamic drop cooldown
         }
         // Decrease cooldown strictly based on actual time, so drops aren't suppressed if subdued
         if (apState.dropCooldown > 0) apState.dropCooldown -= 1/60;
         
         if (autoPilotDrop && !isSubdued) { // Only do massive drops if not highly subdued
            if (s.autoSwitchClips && Math.random() < 0.6 && onSwitchClipRef.current) {
               setTimeout(() => {
                  onSwitchClipRef.current?.();
               }, 0);
            }
            apTimer = apTargets.cycleLength - 0.2; // Force a new cycle soon after the drop hits to resolve it
            currentStrobe = 1.0; 
            
            // Tasteful Drops - Choose 1 Major Effect Type for the Drop rather than blasting all of them
            const dropStyle = Math.random();
            const hit = chaos; // Intensity of drop
            
            // Reset state to avoid crossover mess during drops
            apTargets.waveWarp = 0; apTargets.rgbSplit = 0; apTargets.glitch = 0;
            apTargets.chromaAb = 0; apTargets.backskip = 0; apTargets.slitScan = 0; 
            apTargets.timeDisplace = 0; apTargets.echoTrails = 0; apTargets.playbackSpeed = 1;

            if (dropStyle < 0.20 && aw('feedback') > 0) {
               // Heavy Reverb / Delay drop
               apState.feedback = 0.95 * aw('feedback'); 
               apTargets.feedback = 0; 
               if (aw('echoTrails') > 0) {
                   apState.echoTrails = 12 * hit * aw('echoTrails');
                   apTargets.echoTrails = 0;
               }
            } else if (dropStyle < 0.40 && aw('chromaAb') > 0) {
               // Aggressive Color Invert & Zoom
               if (aw('invert') > 0) apState.invert = !apState.invert;
               if (aw('edgeDetect') > 0 && Math.random() > 0.5) apState.edgeDetect = true;
               apState.chromaAb = 1.5 * hit * aw('chromaAb');
               apTargets.chromaAb = 0;
            } else if (dropStyle < 0.60 && (aw('glitch') > 0 || aw('rgbSplit') > 0)) {
               // Glitch & Tape Stop
               if (aw('glitch') > 0) { apState.glitch = 0.8 * hit * aw('glitch'); apTargets.glitch = 0; }
               if (aw('rgbSplit') > 0) { apState.rgbSplit = 0.8 * hit * aw('rgbSplit'); apTargets.rgbSplit = 0; }
               if (aw('playbackSpeed') > 0) apState.playbackSpeed = 3.0 * hit * aw('playbackSpeed');
            } else if (dropStyle < 0.80 && aw('kaleido') > 0) {
               // Geo Shatter
               apState.kaleido = true;
               if (aw('tiling') > 0) apState.tiling = Math.floor(1 + Math.random() * 3);
               if (aw('waveWarp') > 0) { apState.waveWarp = 0.8 * hit * aw('waveWarp'); apTargets.waveWarp = 0; }
            } else {
               // Time Smear 
               if (aw('slitScan') > 0) { apState.slitScan = 0.6 * hit * aw('slitScan'); apTargets.slitScan = 0; }
               if (aw('timeDisplace') > 0) { apState.timeDisplace = 0.7 * hit * aw('timeDisplace'); apTargets.timeDisplace = 0; }
               if (aw('reversePlayback') > 0) apState.reversePlayback = true;
            }
         }
         
         // Helper to check if autopilot is allowed to control this param
         const am = (key: string) => aw(key) > 0;

         // Apply over user state conditionally
         if (color) {
             if (am('hue')) currentHue = apState.hue;
             if (am('sat')) currentSat = apState.sat;
             if (am('contrast')) currentContrast = apState.contrast;
             if (am('invert')) currentInvert = isSubdued ? false : apState.invert;
             if (am('edgeDetect')) currentEdge = isSubdued ? false : apState.edgeDetect;
         }
         if (geo) {
             if (am('feedback')) currentFeedback = apState.feedback * apIntensityMultiplier;
             if (am('kaleido')) currentKaleido = isSubdued ? false : apState.kaleido;
             if (am('mirrorX')) currentMirrorX = isSubdued ? false : apState.mirrorX;
             if (am('mirrorY')) currentMirrorY = isSubdued ? false : apState.mirrorY;
             if (am('tiling')) currentTiling = isSubdued ? 1 : apState.tiling;
             if (am('equirect')) currentEquirect = isSubdued ? false : apState.equirect;
             if (am('stereoMode')) currentStereo = isSubdued ? 'none' : (apState.stereoMode as 'none'|'sbs'|'tb');
         }
         if (corrupt) {
             if (am('pixelate')) currentPixelate = Math.max(currentPixelate, apState.pixelate * apIntensityMultiplier);
             if (am('waveWarp')) currentWave = Math.max(currentWave, apState.waveWarp * apIntensityMultiplier);
             if (am('rgbSplit')) currentSplit = Math.max(currentSplit, apState.rgbSplit * apIntensityMultiplier);
             if (am('glitch')) currentGlitch = Math.max(currentGlitch, apState.glitch * apIntensityMultiplier);
             if (am('chromaAb')) currentChromaAb = Math.max(currentChromaAb, apState.chromaAb * apIntensityMultiplier);
             if (am('backskip')) currentBackskip = Math.max(currentBackskip, apState.backskip * apIntensityMultiplier);
         }
         if (timecode) {
             if (am('playbackSpeed')) {
                const targetSpeed = isSubdued ? 1.0 : apState.playbackSpeed;
                currentPlaybackSpeed *= (1.0 + (targetSpeed - 1.0) * apIntensityMultiplier);
             }
             if (am('reversePlayback')) currentReversePlayback = isSubdued ? false : (currentReversePlayback !== apState.reversePlayback);

             if (am('posterizeTime')) {
                const posterizeDelta = 60 - apState.posterizeTime;
                currentPosterizeTime = Math.min(currentPosterizeTime, Math.round(60 - posterizeDelta * apIntensityMultiplier));
             }
             if (am('echoTrails')) currentEchoTrails = Math.max(currentEchoTrails, Math.round(apState.echoTrails * apIntensityMultiplier));
             if (am('slitScan')) currentSlitScan = Math.max(currentSlitScan, apState.slitScan * apIntensityMultiplier);
             if (am('timeDisplace')) currentTimeDisplace = Math.max(currentTimeDisplace, apState.timeDisplace * apIntensityMultiplier);
             if (am('softEdges')) currentSoft = currentSoft || (isSubdued ? false : apState.softEdges);
         }
      }

      if (s.audioReactive) {
         // Bass-driven sweetening of the corruption effects. CRITICAL:
         // scale each push by its OWN base fader so an effect at 0 stays
         // fully off — previously these were hardcoded (powBass * k)
         // independent of the faders, which made effects "autoplay" with
         // the beat even when every slider/MIDI mapping was at zero. Now
         // a fader at 0 contributes nothing; raising it opens that
         // effect up to bass modulation. zoomScale is similarly gated so
         // there's no surprise pulse-zoom on a clean frame.
         if (s.glitch > 0) currentGlitch = Math.max(currentGlitch, powBass * 0.9 * s.glitch);
         if (s.rgbGhost > 0) currentGhost = Math.max(currentGhost, powBass * 0.7 * s.rgbGhost);
         if (s.rgbSplit > 0) currentSplit = Math.max(currentSplit, powBass * 0.5 * s.rgbSplit);
         if (s.waveWarp > 0) currentWave = Math.max(currentWave, powBass * 0.4 * s.waveWarp);

         // Pulse-zoom only when feedback/geometry are actually in play —
         // gated on any active geometry/feedback so a bare source frame
         // doesn't breathe on its own.
         if (s.feedback > 0 || s.kaleidoscope || s.tiling > 1 || s.radialSpokes >= 2) {
            zoomScale = 1.0 + (powBass * 0.25);
         }

         if (s.strobe > 0 && powBass > 0.5) {
             isAudioStrobe = true;
         }
         if (currentBackskip > 0 && powBass > 0.8) {
             currentBackskip = Math.max(currentBackskip, 0.8);
         }
      }


      if (s.autoLFO) {
         const now = Date.now() / 1000;
         const bps = s.bpm / 60;
         const phase = (now * bps) % 1.0;
         const decay = Math.max(0, 1.0 - (phase * 4)); 
         
         currentGlitch = Math.max(currentGlitch, decay * 0.85);
         currentGhost = Math.max(currentGhost, decay * 0.95);
      }

      // --- TIMECODE & FRAME BUFFER ---
      const playbackVideo = s.sourceType === 'clip'
        ? (memVideo ?? legacyVideo ?? camVideo)
        : (camVideo ?? legacyVideo ?? memVideo);

      currentPlaybackSpeed = Math.max(0.1, Math.min(10.0, currentPlaybackSpeed));
      if (playbackVideo && playbackVideo.playbackRate !== currentPlaybackSpeed) {
          playbackVideo.playbackRate = currentPlaybackSpeed;
      }
      
      if (playbackVideo && currentReversePlayback && currentPlaybackSpeed > 0 && timestamp - fallbackVideoUpdate > 20) {
          try {
             playbackVideo.currentTime = Math.max(0, playbackVideo.currentTime - ((timestamp - fallbackVideoUpdate)/1000) * currentPlaybackSpeed * 2);
          } catch(e){}
          fallbackVideoUpdate = timestamp;
      } else if (!currentReversePlayback) {
          fallbackVideoUpdate = timestamp;
      }

      let shouldSampleFrame = true;
      if (currentPosterizeTime < 60) {
          const fpsInterval = 1000 / currentPosterizeTime;
          if (timestamp - lastVideoUpdate < fpsInterval) {
              shouldSampleFrame = false;
          } else {
              lastVideoUpdate = timestamp;
          }
      }

      const blend = Math.max(0, Math.min(1, s.sourceBlend ?? (s.sourceType === 'clip' ? 1 : 0)));
      const fallbackVideo = memVideo ?? camVideo ?? legacyVideo;
      if (!fallbackVideo) return;
      let inputSource: CanvasImageSource = fallbackVideo;
      let inputW = fallbackVideo.videoWidth;
      let inputH = fallbackVideo.videoHeight;
      if (hasCam && hasMem && blendCtx && camVideo && memVideo) {
        const targetW = memVideo.videoWidth || camVideo.videoWidth;
        const targetH = memVideo.videoHeight || camVideo.videoHeight;
        if (blendCanvas.width !== targetW || blendCanvas.height !== targetH) {
          blendCanvas.width = targetW;
          blendCanvas.height = targetH;
        }
        blendCtx.globalCompositeOperation = 'source-over';
        blendCtx.globalAlpha = 1;
        blendCtx.fillStyle = 'black';
        blendCtx.fillRect(0, 0, targetW, targetH);
        blendCtx.globalAlpha = 1 - blend;
        blendCtx.drawImage(camVideo, 0, 0, targetW, targetH);
        blendCtx.globalAlpha = blend;
        blendCtx.drawImage(memVideo, 0, 0, targetW, targetH);
        blendCtx.globalAlpha = 1;
        inputSource = blendCanvas;
        inputW = targetW;
        inputH = targetH;
      } else if (hasMem && memVideo && blend >= 0.5) {
        inputSource = memVideo;
        inputW = memVideo.videoWidth;
        inputH = memVideo.videoHeight;
      } else if (hasCam && camVideo) {
        inputSource = camVideo;
        inputW = camVideo.videoWidth;
        inputH = camVideo.videoHeight;
      }

      // Only cycle the full ring when an effect actually reads frame history;
      // otherwise reuse slot 0 so the other 59 canvases never allocate a
      // full-resolution backing store. (headIndex resolves to 0 either way.)
      const needsHistory =
        currentBackskip > 0 || currentSlitScan > 0 || currentEchoTrails > 0 || currentTimeDisplace > 0;
      if (shouldSampleFrame) {
         const writeIndex = needsHistory ? frameIndex : 0;
         const fc = frameBuffer[writeIndex];
         const fCtx = fc.getContext('2d', { alpha: false });
         if (fc.width !== inputW || fc.height !== inputH) {
            fc.width = inputW;
            fc.height = inputH;
         }
         if (fCtx) fCtx.drawImage(inputSource, 0, 0, inputW, inputH);
         // history → advance the ring; no-history → park so headIndex === 0
         frameIndex = needsHistory ? (frameIndex + 1) % bufferSize : 1;
      }

      const headIndex = (frameIndex - 1 + bufferSize) % bufferSize;

      let sourceVideo: CanvasImageSource = shouldSampleFrame ? inputSource : frameBuffer[headIndex] || inputSource;
      let vidW = inputW;
      let vidH = inputH;
      
      if (currentBackskip > 0) {
         let backFrames = Math.floor(currentBackskip * (bufferSize - 1));
         let targetIndex = (headIndex - backFrames + bufferSize) % bufferSize;
         sourceVideo = frameBuffer[targetIndex] || fallbackVideo;
      }
      
      // Time-domain Composite Pass (Slit-scan, Echo, Displace)
      if (currentSlitScan > 0 || currentEchoTrails > 0 || currentTimeDisplace > 0) {
         slitCanvas.width = vidW;
         slitCanvas.height = vidH;
         if (slitCtx && vidH > 0) {
            slitCtx.clearRect(0, 0, vidW, vidH);

            if (currentEchoTrails > 0) {
                const echoCount = Math.floor(currentEchoTrails);
                slitCtx.globalAlpha = 1.0 / (echoCount + 1);
                slitCtx.drawImage(sourceVideo, 0, 0, vidW, vidH);
                for (let i = 1; i <= echoCount; i++) {
                    const tIndex = (headIndex - i + bufferSize) % bufferSize;
                    const srcFrame = frameBuffer[tIndex] || fallbackVideo;
                    slitCtx.drawImage(srcFrame, 0, 0, vidW, vidH);
                }
                slitCtx.globalAlpha = 1.0;
                sourceVideo = slitCanvas;
            }

            if (currentSlitScan > 0) {
                const slitDepth = Math.max(2, Math.floor(currentSlitScan * (bufferSize - 1)));
                const rowHeight = Math.max(1, Math.floor(vidH / slitDepth));
                slitCtx.globalAlpha = 1.0;
                for (let i = 0; i < slitDepth; i++) {
                    const tIndex = (headIndex - i + bufferSize) % bufferSize;
                    const srcFrame = frameBuffer[tIndex] || fallbackVideo;
                    const sy = i * rowHeight;
                    if (sy < vidH) {
                        slitCtx.drawImage(srcFrame, 0, sy, vidW, rowHeight, 0, sy, vidW, rowHeight);
                    }
                }
                sourceVideo = slitCanvas;
            }

            if (currentTimeDisplace > 0) {
                // Time displacement based on vertical position 
                // Alternatively, we displace random horizontal bands based on back-history. 
                // A true time displacement map needs luma analysis, which is too slow for 2D canvas in 60fps.
                // We'll mimic it by interleaving rows from different deep times.
                const zones = 50;
                const rowHeight = Math.max(1, vidH / zones);
                slitCtx.globalAlpha = 1.0;
                for (let i = 0; i < zones; i++) {
                    const displaceAmount = Math.sin(i * 0.5 + Date.now()/1000) * 0.5 + 0.5; // 0 to 1
                    const tOffset = Math.floor(displaceAmount * currentTimeDisplace * (bufferSize - 1));
                    const tIndex = (headIndex - tOffset + bufferSize) % bufferSize;
                    const srcFrame = frameBuffer[tIndex] || fallbackVideo;
                    const sy = i * rowHeight;
                    if (sy < vidH) {
                        slitCtx.drawImage(srcFrame, 0, sy, vidW, rowHeight, 0, sy, vidW, rowHeight);
                    }
                }
                sourceVideo = slitCanvas;
            }
         }
      }

      if (currentPixelate > 0) {
          const scaleFactor = 1.0 - (currentPixelate * 0.96); // 1.0 down to 0.04
          offCanvas.width = Math.max(4, Math.floor(vidW * scaleFactor));
          offCanvas.height = Math.max(4, Math.floor(vidH * scaleFactor));
          if (offCtx) offCtx.drawImage(sourceVideo, 0, 0, offCanvas.width, offCanvas.height);
          sourceVideo = offCanvas;
          vidW = offCanvas.width;
          vidH = offCanvas.height;
          ctx.imageSmoothingEnabled = false;
      } else {
          ctx.imageSmoothingEnabled = true;
      }

      const drawVideoCover = (x: number, y: number, tw: number, th: number) => {
         const imgRatio = vidW / vidH;
         const cRatio = tw / th;
         let dw = tw; let dh = th; let dx = x; let dy = y;
         if (imgRatio > cRatio) {
            dh = th; dw = vidW * (th / vidH); dx = x + (tw - dw) / 2;
         } else {
            dw = tw; dh = vidH * (tw / vidW); dy = y + (th - dh) / 2;
         }
         
         if (currentEquirect) {
            const slivers = 32;
            const slW_src = vidW / slivers;
            const slW_dst = dw / slivers;
            for (let i = 0; i < slivers; i++) {
                const px = (i / (slivers - 1)) * 2 - 1;
                const squeeze = Math.cos(px * Math.PI / 2.2); 
                const projectedH = dh * squeeze;
                const offsetY = dy + (dh - projectedH) / 2;
                ctx.drawImage(sourceVideo, i * slW_src, 0, slW_src, vidH, dx + i * slW_dst, offsetY, slW_dst, projectedH);
            }
         } else {
            ctx.drawImage(sourceVideo, dx, dy, dw, dh);
         }
         
         if (currentSoft) {
            const maskGradX = ctx.createLinearGradient(x, 0, x + tw, 0);
            maskGradX.addColorStop(0, 'rgba(0,0,0,1)');
            maskGradX.addColorStop(0.15, 'rgba(0,0,0,0)');
            maskGradX.addColorStop(0.85, 'rgba(0,0,0,0)');
            maskGradX.addColorStop(1, 'rgba(0,0,0,1)');
            ctx.fillStyle = maskGradX;
            ctx.fillRect(x, y, tw, th);

            const maskGradY = ctx.createLinearGradient(0, y, 0, y + th);
            maskGradY.addColorStop(0, 'rgba(0,0,0,1)');
            maskGradY.addColorStop(0.15, 'rgba(0,0,0,0)');
            maskGradY.addColorStop(0.85, 'rgba(0,0,0,0)');
            maskGradY.addColorStop(1, 'rgba(0,0,0,1)');
            ctx.fillStyle = maskGradY;
            ctx.fillRect(x, y, tw, th);
         }
      };

      // --- FEEDBACK TRAILS ---
      if (currentFeedback > 0) {
         ctx.globalAlpha = 1.0 - currentFeedback;
         ctx.globalCompositeOperation = 'source-over';
         ctx.fillStyle = 'rgba(0,0,0,1)';
         ctx.fillRect(0, 0, w, h);
         ctx.globalAlpha = 1.0 - (currentFeedback * 0.95);
      } else {
         ctx.globalAlpha = 1.0;
         ctx.fillStyle = 'black';
         ctx.fillRect(0, 0, w, h);
      }

      // --- GEOMETRY / KALEIDOSCOPE / TILING ---
      ctx.save();
      
      if (zoomScale > 1.0) {
         ctx.translate(w/2, h/2);
         ctx.scale(zoomScale, zoomScale);
         ctx.translate(-w/2, -h/2);
      }

      const t = Math.floor(currentTiling);
      for(let tx = 0; tx < t; tx++) {
         for(let ty = 0; ty < t; ty++) {
             const bx = (w / t) * tx;
             const by = (h / t) * ty;
             const bw = w / t;
             const bh = h / t;
             
             ctx.save();
             // Translate to local block center for internal transformations
             ctx.translate(bx + bw/2, by + bh/2);
             
             if (currentKaleido) {
                // 4-Quadrant Symmetry Mapping within the tile block
                ctx.save(); ctx.translate(-bw/2, -bh/2); drawVideoCover(0, 0, bw/2, bh/2); ctx.restore(); // TL
                ctx.save(); ctx.translate(bw/2, -bh/2); ctx.scale(-1, 1); drawVideoCover(0, 0, bw/2, bh/2); ctx.restore(); // TR
                ctx.save(); ctx.translate(-bw/2, bh/2); ctx.scale(1, -1); drawVideoCover(0, 0, bw/2, bh/2); ctx.restore(); // BL
                ctx.save(); ctx.translate(bw/2, bh/2); ctx.scale(-1, -1); drawVideoCover(0, 0, bw/2, bh/2); ctx.restore(); // BR
             } else {
                ctx.scale(currentMirrorX ? -1 : 1, currentMirrorY ? -1 : 1);
                ctx.translate(-bw/2, -bh/2);
                drawVideoCover(0, 0, bw, bh);
             }
             ctx.restore();
         }
      }

      ctx.restore();

      // --- RADIAL MIRROR / KALEIDOSCOPE WHEEL ---
      // Slices the composed frame into N angular sectors and mirrors a
      // single source wedge around the center, producing a radial
      // kaleidoscope. We snapshot the current canvas into compostCanvas
      // (the same scratch buffer the stereo pass re-snapshots later) and
      // redraw rotated, clipped wedges from it. When audioReactive is on,
      // mid/high energy rotates the wheel and bass nudges the sector
      // count's phase so the pattern pulses with the track.
      {
        const spokes = Math.round(s.radialSpokes ?? 0);
        if (spokes >= 2) {
          if (compostCanvas.width !== w || compostCanvas.height !== h) {
            compostCanvas.width = w;
            compostCanvas.height = h;
          }
          if (compostCtx) {
            compostCtx.clearRect(0, 0, w, h);
            compostCtx.drawImage(canvas, 0, 0);

            const sectorAngle = (Math.PI * 2) / spokes;
            // Audio-reactive rotation: mid+high spin the wheel, bass adds
            // a slow base drift. Falls back to a gentle time drift when
            // audio reactivity is off so the effect still breathes.
            let baseRotation = (timestamp / 1000) * 0.15;
            if (s.audioReactive) {
              baseRotation += (audio.mid + audio.high) * Math.PI;
            }

            ctx.fillStyle = 'black';
            ctx.fillRect(0, 0, w, h);

            const radius = Math.sqrt(w * w + h * h);
            for (let i = 0; i < spokes; i++) {
              ctx.save();
              ctx.translate(w / 2, h / 2);
              ctx.rotate(baseRotation + i * sectorAngle);
              // Mirror every other sector so reflections meet seamlessly.
              if (i % 2 === 1) ctx.scale(1, -1);

              // Clip to a single wedge of the source space.
              ctx.beginPath();
              ctx.moveTo(0, 0);
              ctx.arc(0, 0, radius, -sectorAngle / 2, sectorAngle / 2);
              ctx.closePath();
              ctx.clip();

              ctx.translate(-w / 2, -h / 2);
              ctx.drawImage(compostCanvas, 0, 0);
              ctx.restore();
            }
          }
        }
      }

      // --- CATEGORY A: REACTION-DIFFUSION SKIN (Gray-Scott) ---------
      // Runs a few Gray-Scott solver steps on a small grid each frame,
      // seeding chemical B from frame luminance so the Turing pattern
      // grows out of bright regions, then screen-composites the pattern
      // (tinted by hue) over the frame. Cheap: RD_W*RD_H cells * a few
      // iterations. Bass nudges the feed rate when audioReactive is on.
      if ((s.reactionDiffusion ?? 0) > 0 && rdCtx && rdImage) {
        const amt = s.reactionDiffusion;
        // Seed once: a noisy patch of B in the center so the reaction
        // has something to chew on at startup.
        if (!rdSeeded) {
          for (let i = 0; i < RD_W * RD_H; i++) {
            rdA[i] = 1;
            rdB[i] = Math.random() < 0.08 ? 1 : 0;
          }
          rdSeeded = true;
        }
        // Re-inject B from the current frame's bright areas so the pattern
        // tracks the video content. Throttled to every 3rd frame — the
        // canvas→small-buffer blit + readback is the expensive part and the
        // pattern evolves slowly enough that 20 Hz reseeding is invisible.
        if (flowSampleCtx && (rdReseedTick++ % 3 === 0)) {
          flowSampleCtx.drawImage(canvas, 0, 0, FLOW_W, FLOW_H);
        }
        const dA = 1.0;
        const dB = 0.5;
        const feed = 0.0545 + (s.audioReactive ? powBass * 0.01 : 0);
        const kill = 0.062;
        const steps = 6;
        for (let step = 0; step < steps; step++) {
          for (let y = 1; y < RD_H - 1; y++) {
            for (let x = 1; x < RD_W - 1; x++) {
              const idx = y * RD_W + x;
              const a = rdA[idx];
              const b = rdB[idx];
              // 3x3 Laplacian (center weight -1, edges 0.2, corners 0.05)
              const lapA =
                rdA[idx - 1] * 0.2 + rdA[idx + 1] * 0.2 +
                rdA[idx - RD_W] * 0.2 + rdA[idx + RD_W] * 0.2 +
                (rdA[idx - RD_W - 1] + rdA[idx - RD_W + 1] + rdA[idx + RD_W - 1] + rdA[idx + RD_W + 1]) * 0.05 -
                a;
              const lapB =
                rdB[idx - 1] * 0.2 + rdB[idx + 1] * 0.2 +
                rdB[idx - RD_W] * 0.2 + rdB[idx + RD_W] * 0.2 +
                (rdB[idx - RD_W - 1] + rdB[idx - RD_W + 1] + rdB[idx + RD_W - 1] + rdB[idx + RD_W + 1]) * 0.05 -
                b;
              const abb = a * b * b;
              rdA2[idx] = a + (dA * lapA - abb + feed * (1 - a));
              rdB2[idx] = b + (dB * lapB + abb - (kill + feed) * b);
            }
          }
          // ping-pong
          const ta = rdA; rdA = rdA2; rdA2 = ta;
          const tb = rdB; rdB = rdB2; rdB2 = tb;
        }
        // Paint B concentration into the RD image (hue-tinted white-ish).
        const data = rdImage.data;
        for (let i = 0; i < RD_W * RD_H; i++) {
          const v = Math.max(0, Math.min(1, (rdA[i] - rdB[i]) * 1.0));
          const c = Math.round(v * 255);
          data[i * 4] = c;
          data[i * 4 + 1] = Math.round(c * 0.85);
          data[i * 4 + 2] = 255 - c;
          data[i * 4 + 3] = Math.round(amt * 255);
        }
        rdCtx.putImageData(rdImage, 0, 0);
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = 1.0;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(rdCanvas, 0, 0, w, h);
        ctx.restore();
      }

      // --- CATEGORY A: TOPOGRAPHIC ISOLINES -------------------------
      // Quantizes the composed frame's luminance into N bands and draws
      // the band boundaries (where neighbouring pixels fall in different
      // bands) as bright contour strokes, mixed over the frame by amount.
      if ((s.topographic ?? 0) > 0 && fxScratchCtx) {
        const amt = s.topographic;
        const TW = Math.max(8, Math.floor(w * 0.5));
        const TH = Math.max(8, Math.floor(h * 0.5));
        if (fxScratch.width !== TW || fxScratch.height !== TH) {
          fxScratch.width = TW;
          fxScratch.height = TH;
        }
        fxScratchCtx.drawImage(canvas, 0, 0, TW, TH);
        const src = fxScratchCtx.getImageData(0, 0, TW, TH);
        const sd = src.data;
        const out = fxScratchCtx.createImageData(TW, TH);
        const od = out.data;
        const bands = 7;
        const lumaBand = (i: number) => {
          const l = (sd[i] * 0.299 + sd[i + 1] * 0.587 + sd[i + 2] * 0.114) / 255;
          return Math.floor(l * bands);
        };
        for (let y = 0; y < TH; y++) {
          for (let x = 0; x < TW; x++) {
            const i = (y * TW + x) * 4;
            const b0 = lumaBand(i);
            const bR = x < TW - 1 ? lumaBand(i + 4) : b0;
            const bD = y < TH - 1 ? lumaBand(i + TW * 4) : b0;
            const edge = b0 !== bR || b0 !== bD;
            if (edge) {
              od[i] = 220; od[i + 1] = 255; od[i + 2] = 230; od[i + 3] = 255;
            } else {
              od[i + 3] = 0;
            }
          }
        }
        fxScratchCtx.putImageData(out, 0, 0);
        ctx.save();
        ctx.globalAlpha = amt;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(fxScratch, 0, 0, w, h);
        ctx.restore();
      }

      // --- CATEGORY A: FLUID DISPLACEMENT ---------------------------
      // Derives a coarse velocity field from the luma difference between
      // the current and previous downsampled frame (a cheap motion proxy)
      // and smears the frame along that field by drawing offset, low-alpha
      // copies per cell. Volume amplifies the push when audioReactive.
      if ((s.fluidDisplace ?? 0) > 0 && flowSampleCtx) {
        const amt = s.fluidDisplace * (s.audioReactive ? 1 + audio.volume * 2 : 1);
        flowSampleCtx.drawImage(canvas, 0, 0, FLOW_W, FLOW_H);
        const fd = flowSampleCtx.getImageData(0, 0, FLOW_W, FLOW_H).data;
        // Update velocity field from temporal + spatial luma gradients.
        for (let y = 1; y < FLOW_H - 1; y++) {
          for (let x = 1; x < FLOW_W - 1; x++) {
            const idx = y * FLOW_W + x;
            const p = idx * 4;
            const luma = fd[p] * 0.299 + fd[p + 1] * 0.587 + fd[p + 2] * 0.114;
            const dt = luma - flowPrev[idx];
            const gx = (fd[p + 4] - fd[p - 4]);
            const gy = (fd[p + FLOW_W * 4] - fd[p - FLOW_W * 4]);
            // velocity ~ -temporal_diff * spatial_gradient (optical-flow-ish)
            flowVx[idx] = flowVx[idx] * 0.85 + (-dt * gx) * 0.0006;
            flowVy[idx] = flowVy[idx] * 0.85 + (-dt * gy) * 0.0006;
            flowPrev[idx] = luma;
          }
        }
        // Smear: draw a handful of displaced full-frame copies whose
        // offset samples the average field magnitude. Keeps it O(few)
        // drawImage calls rather than per-cell warping.
        let avgX = 0, avgY = 0;
        for (let i = 0; i < FLOW_W * FLOW_H; i++) { avgX += flowVx[i]; avgY += flowVy[i]; }
        avgX /= FLOW_W * FLOW_H; avgY /= FLOW_W * FLOW_H;
        if (compostCanvas.width !== w || compostCanvas.height !== h) {
          compostCanvas.width = w; compostCanvas.height = h;
        }
        if (compostCtx) {
          compostCtx.clearRect(0, 0, w, h);
          compostCtx.drawImage(canvas, 0, 0);
          const layers = 4;
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          for (let l = 1; l <= layers; l++) {
            const k = (l / layers) * amt * 120;
            ctx.globalAlpha = 0.18 * amt;
            ctx.drawImage(compostCanvas, avgX * k, avgY * k, w, h);
          }
          ctx.restore();
        }
      }

      // --- CATEGORY A: SDF RAYMARCH PORTAL --------------------------
      // Procedurally draws a glowing signed-distance-field ring/tunnel
      // on a half-res buffer (concentric SDF rings shaded by distance)
      // and screen-composites it as an overlay portal. Mid energy pulses
      // the radius; falls back to a gentle time pulse when audio is off.
      if ((s.sdfPortal ?? 0) > 0 && sdfCtx) {
        const amt = s.sdfPortal;
        const SW = Math.max(8, Math.floor(w * 0.5));
        const SH = Math.max(8, Math.floor(h * 0.5));
        if (sdfCanvas.width !== SW || sdfCanvas.height !== SH) {
          sdfCanvas.width = SW;
          sdfCanvas.height = SH;
        }
        sdfCtx.clearRect(0, 0, SW, SH);
        const cx = SW / 2;
        const cy = SH / 2;
        const pulse = s.audioReactive ? audio.mid : (0.5 + 0.5 * Math.sin(timestamp / 600));
        const baseR = Math.min(SW, SH) * (0.18 + pulse * 0.12);
        const rings = 6;
        for (let i = rings; i >= 1; i--) {
          const r = baseR * (1 + i * 0.5) + (timestamp / 1000 * 30 % (baseR * 0.5));
          const glow = (1 - i / rings);
          sdfCtx.beginPath();
          sdfCtx.arc(cx, cy, r, 0, Math.PI * 2);
          sdfCtx.lineWidth = 2 + glow * 6;
          sdfCtx.strokeStyle = `rgba(${Math.round(120 + glow * 135)}, ${Math.round(200 * glow + 40)}, 255, ${0.5 * glow})`;
          sdfCtx.stroke();
        }
        // Bright core
        const coreGrad = sdfCtx.createRadialGradient(cx, cy, 0, cx, cy, baseR);
        coreGrad.addColorStop(0, 'rgba(200,240,255,0.9)');
        coreGrad.addColorStop(1, 'rgba(40,80,255,0)');
        sdfCtx.fillStyle = coreGrad;
        sdfCtx.beginPath();
        sdfCtx.arc(cx, cy, baseR, 0, Math.PI * 2);
        sdfCtx.fill();
        ctx.save();
        ctx.globalCompositeOperation = 'screen';
        ctx.globalAlpha = amt;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(sdfCanvas, 0, 0, w, h);
        ctx.restore();
      }

      // --- CATEGORY B: METRIC DEPTH FOG -----------------------------
      // Fades a fog colour into the frame weighted by the depth proxy so
      // far (dark/smooth) regions wash out toward the fog colour while
      // near (bright) regions stay clear — the classic distance-fog
      // volumetric read. Bass thickens the fog when audioReactive is on.
      if ((s.depthFog ?? 0) > 0 && depthCtx && depthImage) {
        buildDepthProxy();
        const amt = (s.depthFog ?? 0) * (s.audioReactive ? 1 + powBass * 0.6 : 1);
        const dd = depthImage.data;
        // Fog is cool blue-grey; alpha grows with distance (1 - depth).
        for (let i = 0; i < DEPTH_W * DEPTH_H; i++) {
          const far = 1 - depthProxy[i];
          dd[i * 4] = 150;
          dd[i * 4 + 1] = 170;
          dd[i * 4 + 2] = 200;
          dd[i * 4 + 3] = Math.round(Math.min(1, far * amt) * 255);
        }
        depthCtx.putImageData(depthImage, 0, 0);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1.0;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(depthCanvas, 0, 0, w, h);
        ctx.restore();
      }

      // --- CATEGORY B: Z-QUANTIZED PLANE SPLITS ---------------------
      // Buckets the depth proxy into near/mid/far planes and grades each
      // independently (the far plane is cooled + darkened, the near plane
      // warmed + brightened) so the frame reads as separated depth slabs.
      if ((s.zPlanes ?? 0) > 0 && depthCtx && depthImage) {
        buildDepthProxy();
        const amt = s.zPlanes ?? 0;
        const dd = depthImage.data;
        for (let i = 0; i < DEPTH_W * DEPTH_H; i++) {
          const dpt = depthProxy[i];
          // 3 planes: far (<0.4), mid, near (>0.7).
          let r = 0, g = 0, b = 0;
          if (dpt < 0.4) { r = 20; g = 50; b = 120; }        // far → cool blue
          else if (dpt < 0.7) { r = 60; g = 30; b = 90; }    // mid → violet
          else { r = 160; g = 90; b = 30; }                   // near → warm amber
          dd[i * 4] = r;
          dd[i * 4 + 1] = g;
          dd[i * 4 + 2] = b;
          dd[i * 4 + 3] = Math.round(amt * 160);
        }
        depthCtx.putImageData(depthImage, 0, 0);
        ctx.save();
        ctx.globalCompositeOperation = 'overlay';
        ctx.globalAlpha = 1.0;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(depthCanvas, 0, 0, w, h);
        ctx.restore();
      }

      // --- CATEGORY B: TILT-SHIFT MINIATURE -------------------------
      // Progressively blurs the frame away from a central horizontal
      // focal band (the "miniature" look). We snapshot the frame, then
      // draw blurred copies masked to the top and bottom thirds via a
      // vertical alpha gradient so only the focal band stays sharp.
      if ((s.tiltShift ?? 0) > 0) {
        const amt = s.tiltShift ?? 0;
        if (compostCanvas.width !== w || compostCanvas.height !== h) {
          compostCanvas.width = w; compostCanvas.height = h;
        }
        if (compostCtx) {
          compostCtx.clearRect(0, 0, w, h);
          compostCtx.drawImage(canvas, 0, 0);
          ctx.save();
          ctx.filter = `blur(${(amt * 8).toFixed(1)}px)`;
          ctx.imageSmoothingEnabled = true;
          // Top out-of-focus region.
          const bandH = h * (0.5 - amt * 0.3);
          ctx.beginPath();
          ctx.rect(0, 0, w, bandH);
          ctx.rect(0, h - bandH, w, bandH);
          ctx.clip();
          ctx.drawImage(compostCanvas, 0, 0, w, h);
          ctx.restore();
        }
      }

      // --- CATEGORY B: DEPTH-EDGE COMIC OUTLINE ---------------------
      // Runs a Sobel pass on the depth proxy and inks the geometric
      // silhouette edges (depth discontinuities) over the frame — a
      // clean comic/contour outline that follows form rather than texture.
      if ((s.depthOutline ?? 0) > 0 && depthCtx && depthImage) {
        buildDepthProxy();
        const amt = s.depthOutline ?? 0;
        const dd = depthImage.data;
        for (let y = 0; y < DEPTH_H; y++) {
          for (let x = 0; x < DEPTH_W; x++) {
            const i = y * DEPTH_W + x;
            const xl = Math.max(0, x - 1), xr = Math.min(DEPTH_W - 1, x + 1);
            const yt = Math.max(0, y - 1), yb = Math.min(DEPTH_H - 1, y + 1);
            const gx =
              depthProxy[yt * DEPTH_W + xr] + 2 * depthProxy[y * DEPTH_W + xr] + depthProxy[yb * DEPTH_W + xr] -
              depthProxy[yt * DEPTH_W + xl] - 2 * depthProxy[y * DEPTH_W + xl] - depthProxy[yb * DEPTH_W + xl];
            const gy =
              depthProxy[yb * DEPTH_W + xl] + 2 * depthProxy[yb * DEPTH_W + x] + depthProxy[yb * DEPTH_W + xr] -
              depthProxy[yt * DEPTH_W + xl] - 2 * depthProxy[yt * DEPTH_W + x] - depthProxy[yt * DEPTH_W + xr];
            const mag = Math.min(1, Math.sqrt(gx * gx + gy * gy) * 4);
            const ink = mag > 0.35 ? 255 : 0;
            dd[i * 4] = 0;
            dd[i * 4 + 1] = 0;
            dd[i * 4 + 2] = 0;
            dd[i * 4 + 3] = Math.round((ink / 255) * amt * 255);
          }
        }
        depthCtx.putImageData(depthImage, 0, 0);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1.0;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(depthCanvas, 0, 0, w, h);
        ctx.restore();
      }

      // --- PIXEL TEARING (DATAMOSH) ---
      if (currentGlitch > 0) {

        ctx.globalAlpha = 1.0;
        if (Math.random() < currentGlitch) {
          const slices = Math.floor(Math.random() * 12 * currentGlitch) + 1;
          for(let i = 0; i < slices; i++) {
            const srcY = Math.random() * h;
            const sliceH = (Math.random() * 0.3 + 0.02) * h;
            const shiftX = (Math.random() - 0.5) * w * currentGlitch * 2.5;
            ctx.drawImage(canvas, 0, srcY, w, sliceH, shiftX, srcY, w, sliceH);
          }
        }
      }

      // --- GHOSTING (DELAY BUFFER SMEAR) ---
      if (currentGhost > 0) {
         ctx.globalCompositeOperation = 'screen';
         ctx.globalAlpha = 0.5 * currentGhost;
         const shiftX = currentGhost * w * 0.08;
         const shiftY = currentGhost * h * 0.02;
         ctx.drawImage(canvas, shiftX, shiftY, w, h);
         ctx.drawImage(canvas, -shiftX, -shiftY, w, h);
         ctx.globalCompositeOperation = 'source-over';
         ctx.globalAlpha = 1.0;
      }

      // --- STROBE ---
      if (currentStrobe > 0) {
         let shouldStrobe = false;
         if (s.audioReactive) {
            shouldStrobe = isAudioStrobe;
         } else {
            const freq = (currentStrobe * 20) + 1; 
            const period = 1000 / freq;
            if ((Date.now() % period) > (period * 0.5)) {
               shouldStrobe = true;
            }
         }

         if (shouldStrobe) {
            ctx.fillStyle = currentInvert ? 'black' : 'white';
            ctx.globalAlpha = 0.9;
            ctx.fillRect(0, 0, w, h);
            ctx.globalAlpha = 1.0;
         }
      }
      
      // --- FINAL COMPOST & STEREO 3D ROUTING ---
      if (currentStereo !== 'none') {
         if (compostCanvas.width !== w || compostCanvas.height !== h) {
             compostCanvas.width = w; compostCanvas.height = h;
         }
         if (compostCtx) compostCtx.drawImage(canvas, 0, 0); // Snapshot pure render
         
         ctx.fillStyle = 'black';
         ctx.fillRect(0, 0, w, h); // Clear main
         
         if (currentStereo === 'sbs') {
            ctx.drawImage(compostCanvas, 0, 0, w/2, h);
            ctx.drawImage(compostCanvas, w/2, 0, w/2, h);
         } else if (currentStereo === 'tb') {
            ctx.drawImage(compostCanvas, 0, 0, w, h/2);
            ctx.drawImage(compostCanvas, 0, h/2, w, h/2);
         }
      }

      // --- FINAL CSS SVG OPICS ---
      let finalHue = currentHue;
      if (s.autoLFO) {
         const now = Date.now() / 1000;
         finalHue = (currentHue + now * (s.bpm / 60) * 150) % 360;
      }

      let customFilters = '';
      if (currentEdge) customFilters += ' url(#fvj-edge)';
      if (currentWave > 0) {
         customFilters += ' url(#fvj-warp)';
         if (!svgWarpDisp) svgWarpDisp = document.getElementById('fvj-warp-disp');
         if (!svgWarpTurb) svgWarpTurb = document.getElementById('fvj-warp-turb');
         if (svgWarpDisp && svgWarpTurb) {
             const scale = (currentWave * 150).toString();
             const freq = (0.01 + currentWave * 0.04).toString();
             if (scale !== lastWarpScale) { svgWarpDisp.setAttribute('scale', scale); lastWarpScale = scale; }
             if (freq !== lastWarpFreq) { svgWarpTurb.setAttribute('baseFrequency', freq); lastWarpFreq = freq; }
         }
      }
      if (currentSplit > 0 || currentChromaAb > 0) {
         customFilters += ' url(#fvj-rgb)';
         if (!svgRgbRed) svgRgbRed = document.getElementById('fvj-rgb-red');
         if (!svgRgbBlue) svgRgbBlue = document.getElementById('fvj-rgb-blue');
         if (svgRgbRed && svgRgbBlue) {
             const dx = ((currentSplit * 100) + (currentChromaAb * 20)).toString();
             const dy = (currentChromaAb * 15).toString();
             if (dx !== lastRgbDx || dy !== lastRgbDy) {
                 svgRgbRed.setAttribute('dx', dx);
                 svgRgbRed.setAttribute('dy', dy);
                 svgRgbBlue.setAttribute('dx', (-Number(dx)).toString());
                 svgRgbBlue.setAttribute('dy', (-Number(dy)).toString());
                 lastRgbDx = dx;
                 lastRgbDy = dy;
             }
         }
      }

      // G1 effect tier — CSS filter knobs. Each slider gates a single
      // filter expression so unused effects cost nothing at render time.
      const sepiaAmt = s.fxSepia ?? 0;
      const grayAmt = s.fxGrayscale ?? 0;
      const blurAmt = s.fxBlur ?? 0;
      const fxFilters =
        (sepiaAmt > 0 ? `sepia(${(sepiaAmt * 100).toFixed(0)}%) ` : '') +
        (grayAmt > 0 ? `grayscale(${(grayAmt * 100).toFixed(0)}%) ` : '') +
        (blurAmt > 0 ? `blur(${(blurAmt * 20).toFixed(1)}px) ` : '');

      const styleStr = `
        hue-rotate(${Math.floor(finalHue)}deg)
        saturate(${currentSat}%)
        contrast(${currentContrast}%)
        brightness(${currentBright}%)
        ${currentInvert ? 'invert(100%)' : ''}
        ${fxFilters}
        ${customFilters}
      `;
      if (canvas.style.filter !== styleStr) {
         canvas.style.filter = styleStr;
      }
      
      // Update record canvas for captureStream with burned-in filters.
      // When a take is in progress the dims are locked to the chosen
      // recordQuality (set in startRecording); otherwise we mirror
      // the live canvas. The drawImage scales source → record dims.
      if (recordCanvasRef.current) {
          const rCanvas = recordCanvasRef.current;
          if (!s.recording && (rCanvas.width !== w || rCanvas.height !== h)) {
              rCanvas.width = w;
              rCanvas.height = h;
          }
          const rCtx = rCanvas.getContext('2d', { alpha: false });
          if (rCtx) {
              rCtx.filter = styleStr;
              rCtx.drawImage(canvas, 0, 0, rCanvas.width, rCanvas.height);
              rCtx.filter = 'none'; // reset for direct overlay drawing
              
              if (s.scanlines) {
                  rCtx.fillStyle = 'rgba(0,0,0,0.3)';
                  for (let i = 0; i < h; i += 4) {
                      rCtx.fillRect(0, i, w, 2);
                  }
              }
              if (s.crt) {
                  rCtx.fillStyle = 'rgba(255, 255, 255, 0.04)';
                  if (Math.random() > 0.5) {
                      const stripH = Math.random() * 20 + 5;
                      rCtx.fillRect(0, Math.random() * (h - stripH), w, stripH);
                  }
              }
              if (s.vignette) { // match div radial shadow
                  const vigGrad = rCtx.createRadialGradient(w/2, h/2, w*0.35, w/2, h/2, Math.max(w, h)*0.6);
                  vigGrad.addColorStop(0, 'rgba(0,0,0,0)');
                  vigGrad.addColorStop(1, 'rgba(0,0,0,0.85)');
                  rCtx.fillStyle = vigGrad;
                  rCtx.fillRect(0, 0, w, h);
              }
          }
      }
    };

    renderLoop(performance.now());
    return () => {
      cancelAnimationFrame(animationId);
      resizeObs?.disconnect();
    };
  }, []);

  return (
    <div className="w-full h-full bg-black flex items-center justify-center overflow-hidden">
      <div 
         className="relative bg-black shadow-2xl overflow-hidden"
         style={
             vjState.aspectRatio === 'free' 
             ? { width: '100%', height: '100%' }
             : { aspectRatio: vjState.aspectRatio.replace(':', '/'), width: '100%', maxHeight: '100%' }
         }
      >
        <svg width="0" height="0" className="absolute pointer-events-none">
          <defs>
          <filter id="fvj-edge">
             <feConvolveMatrix order="3 3" preserveAlpha="true" kernelMatrix="-1 -1 -1 -1 8 -1 -1 -1 -1" />
          </filter>
          <filter id="fvj-warp">
             <feTurbulence id="fvj-warp-turb" type="fractalNoise" baseFrequency="0.01" numOctaves="2" result="noise" />
             <feDisplacementMap id="fvj-warp-disp" in="SourceGraphic" in2="noise" scale="0" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <filter id="fvj-rgb">
             <feOffset id="fvj-rgb-red" dx="0" dy="0" in="SourceGraphic" result="red-shift" />
             <feOffset id="fvj-rgb-blue" dx="0" dy="0" in="SourceGraphic" result="blue-shift" />
             <feComponentTransfer in="red-shift" result="red-only">
               <feFuncR type="linear" slope="1"/><feFuncG type="linear" slope="0"/><feFuncB type="linear" slope="0"/>
             </feComponentTransfer>
             <feComponentTransfer in="blue-shift" result="blue-only">
               <feFuncR type="linear" slope="0"/><feFuncG type="linear" slope="0"/><feFuncB type="linear" slope="1"/>
             </feComponentTransfer>
             <feComponentTransfer in="SourceGraphic" result="green-only">
               <feFuncR type="linear" slope="0"/><feFuncG type="linear" slope="1"/><feFuncB type="linear" slope="0"/>
             </feComponentTransfer>
             <feBlend mode="screen" in="red-only" in2="green-only" result="rg-blend"/>
             <feBlend mode="screen" in="rg-blend" in2="blue-only" />
          </filter>
        </defs>
      </svg>
      {cameraVideoRef ? (
        <video
          ref={cameraVideoRef}
          autoPlay
          playsInline
          muted
          className="hidden"
          crossOrigin="anonymous"
        />
      ) : null}

      {clipVideoRef ? (
        <video
          ref={clipVideoRef}
          autoPlay
          playsInline
          muted={!vjState.clipAudio}
          loop
          className="hidden"
          crossOrigin="anonymous"
        />
      ) : null}

      {!cameraVideoRef && !clipVideoRef ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={vjState.sourceType === 'camera' || !vjState.clipAudio}
          loop
          className="hidden"
          crossOrigin="anonymous"
        />
      ) : null}
      
      {/* Primary Rendering Target */}
      <canvas ref={canvasRef} className="w-full h-full block" />

      {/* Screen Effects Layered Overhead */}
      {vjState.scanlines && (
        <div className="pointer-events-none absolute inset-0 z-10 scanlines-overlay mix-blend-overlay opacity-80"></div>
      )}
      {vjState.crt && (
        <div className="pointer-events-none absolute inset-0 z-10 crt-flicker-overlay"></div>
      )}
      {vjState.vignette && (
        <div className="pointer-events-none absolute inset-0 z-20 shadow-[inset_0_0_250px_rgba(0,0,0,0.9)]"></div>
      )}
      </div>
    </div>
  );
}
