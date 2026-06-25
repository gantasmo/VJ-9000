import { useEffect, useRef, useState } from 'react';
import { AkvjCloudRenderer, AKVJ_PARAMS_DEFAULT, type AkvjLevels, type AkvjParams } from './akvj/AkvjCloudRenderer';

/**
 * "depthcloud" VJ source — turn ANY video (a loaded clip, or the webcam) into a
 * live point cloud with NO depth camera.
 *
 * A Web Worker runs monocular Depth-Anything-V2 on downscaled frames; this hook
 * synthesizes a one-time pinhole ray-table, maps the model's relative depth into
 * a pseudo-metric range (EMA-smoothed to kill flicker), and feeds the SAME
 * AkvjCloudRenderer the Kinect path uses — so every style, the audio reactivity,
 * and the camera spin work on ordinary footage with zero new shader code.
 *
 * Depth is RELATIVE and stylized, never a measurement (perfect for VJ). Inference
 * runs off-thread at reduced resolution and is decoupled from the 60fps render
 * loop, so the deck never stutters between inferences.
 */

type DepthState = 'idle' | 'loading-model' | 'ready' | 'running' | 'error';

export interface DepthCloudFeed {
  stream: MediaStream | null;
  state: DepthState;
  backend: string | null; // 'webgpu' | 'wasm'
  progress: number; // model-download percent (0..100)
  fps: number; // inference fps
  error: string | null;
  log: string[];
}

const initialFeed: DepthCloudFeed = {
  stream: null,
  state: 'idle',
  backend: null,
  progress: 0,
  fps: 0,
  error: null,
  log: [],
};

const LOG_CAP = 200;
const TARGET_W = 320; // inference + cloud grid width (height follows source aspect)
const INFER_MS = 120; // ~8fps inference (render stays 60fps on the last depth)
const FOV_Y_DEG = 55; // assumed vertical FOV for the synthetic pinhole ray-table
const NEAR_M = 0.6;
const FAR_M = 4.0;
const EMA = 0.5; // depth temporal smoothing (higher = snappier, more flicker)

function buildPinholeTable(w: number, h: number): Float32Array {
  const tan = Math.tan((FOV_Y_DEG * Math.PI) / 180 / 2);
  const aspect = w / h;
  const t = new Float32Array(w * h * 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const u = (x + 0.5) / w;
      const v = (y + 0.5) / h;
      t[i * 2] = (u - 0.5) * 2 * tan * aspect; // rayX
      t[i * 2 + 1] = (v - 0.5) * 2 * tan; // rayY (shader flips for world-up)
    }
  }
  return t;
}

export function useDepthCloud(
  enabled: boolean,
  getLevels: () => AkvjLevels,
  mode = 'points',
  params: AkvjParams = AKVJ_PARAMS_DEFAULT,
  clipUrl: string | null = null,
  engine: { precision: string; res: number; fps: number } = { precision: 'auto', res: 320, fps: 8 },
): DepthCloudFeed {
  const [feed, setFeed] = useState<DepthCloudFeed>(initialFeed);
  const getLevelsRef = useRef(getLevels);
  getLevelsRef.current = getLevels;
  const rendererRef = useRef<AkvjCloudRenderer | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    if (!enabled) {
      setFeed((prev) => ({ ...initialFeed, log: prev.log }));
      return;
    }

    const targetW = engine.res || TARGET_W;
    const inferMs = engine.fps ? Math.max(40, Math.round(1000 / engine.fps)) : INFER_MS;

    let closed = false;
    let gridW = 0;
    let gridH = 0;
    let emaBuf: Float32Array | null = null;
    let depthMeters: Float32Array | null = null;
    let depthU16: Uint16Array | null = null;
    let pendingColor: ImageBitmap | null = null;
    let sending = false;
    let inferTimer: ReturnType<typeof setInterval> | null = null;
    let inferCount = 0;
    let fpsT0 = performance.now();
    let mediaStreamForCam: MediaStream | null = null;

    const patch = (next: Partial<DepthCloudFeed>) => {
      if (!closed) setFeed((prev) => ({ ...prev, ...next }));
    };
    const logLine = (m: string) => {
      // eslint-disable-next-line no-console
      console.info('[depthcloud]', m);
      if (closed) return;
      const stamped = `${new Date().toLocaleTimeString()} ${m}`;
      setFeed((prev) => ({ ...prev, log: [...prev.log, stamped].slice(-LOG_CAP) }));
    };
    const fail = (m: string) => {
      logLine(`ERROR: ${m}`);
      patch({ state: 'error', error: m });
    };

    logLine(`depthcloud enabled (${clipUrl ? 'clip' : 'webcam'} source)`);

    // Renderer + capture stream (reused from the Kinect path).
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    let renderer: AkvjCloudRenderer | null = null;
    try {
      renderer = new AkvjCloudRenderer(canvas, () => getLevelsRef.current());
    } catch (e) {
      fail(`renderer init failed: ${(e as Error)?.message ?? e}`);
      return;
    }
    rendererRef.current = renderer;
    renderer.setStyle(modeRef.current);
    renderer.setParams(paramsRef.current);
    let stream: MediaStream | null = null;
    if (typeof canvas.captureStream === 'function') stream = canvas.captureStream(30);
    patch({ stream });

    // Hidden source video + downscale canvas.
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    const small = document.createElement('canvas');
    const sctx = small.getContext('2d', { willReadFrequently: true });

    // Depth worker.
    let worker: Worker;
    try {
      worker = new Worker(new URL('./akvj/depthWorker.ts', import.meta.url), { type: 'module' });
    } catch (e) {
      fail(`could not start the depth worker: ${(e as Error)?.message ?? e}`);
      renderer.dispose();
      return;
    }
    patch({ state: 'loading-model' });

    const ensureGrid = (w: number, h: number) => {
      if (w === gridW && h === gridH && renderer) return;
      gridW = w;
      gridH = h;
      small.width = w;
      small.height = h;
      emaBuf = null;
      depthMeters = new Float32Array(w * h);
      depthU16 = new Uint16Array(w * h);
      renderer?.setXYTable(w, h, buildPinholeTable(w, h));
      logLine(`grid ${w}x${h} (pinhole ray-table)`);
    };

    worker.onmessage = (ev: MessageEvent) => {
      const msg: any = ev.data;
      if (closed || !msg) return;
      if (msg.type === 'progress') {
        const p = msg.progress;
        if (p && typeof p.progress === 'number') patch({ progress: Math.round(p.progress) });
        return;
      }
      if (msg.type === 'ready') {
        patch({ state: 'running', backend: msg.backend, error: null, progress: 100 });
        logLine(`model ready (${msg.backend})`);
        return;
      }
      if (msg.type === 'error') {
        fail(msg.message || 'depth worker error');
        // Back off instead of hammering a failing model (which floods the log
        // with "Array buffer allocation failed"). Re-select DEPTH to retry.
        if (inferTimer) {
          clearInterval(inferTimer);
          inferTimer = null;
          logLine('inference paused after error — re-select DEPTH to retry');
        }
        return;
      }
      if (msg.type === 'depth') {
        const { width: w, height: h, channels } = msg;
        if (w !== gridW || h !== gridH) return; // a stale frame from before a resize
        const d = new Uint8Array(msg.data);
        if (!depthMeters || !depthU16) return;
        const dm = depthMeters;
        // Depth-Anything: brighter = nearer. Map to pseudo-meters (near..far).
        for (let i = 0; i < dm.length; i++) {
          const v = channels === 1 ? d[i] : d[i * channels];
          dm[i] = NEAR_M + ((255 - v) / 255) * (FAR_M - NEAR_M);
        }
        if (!emaBuf) emaBuf = dm.slice();
        else for (let i = 0; i < dm.length; i++) emaBuf[i] += (dm[i] - emaBuf[i]) * EMA;
        for (let i = 0; i < emaBuf.length; i++) depthU16[i] = Math.min(65535, Math.round(emaBuf[i] * 1000));
        renderer?.pushFrame(w, h, depthU16, pendingColor);
        pendingColor = null; // the renderer owns it now

        inferCount += 1;
        const now = performance.now();
        if (now - fpsT0 >= 1000) {
          patch({ fps: Math.round((inferCount * 1000) / (now - fpsT0)) });
          inferCount = 0;
          fpsT0 = now;
        }
      }
    };
    worker.onerror = (e) => fail(`depth worker crashed: ${e.message}`);
    worker.postMessage({ type: 'init', precision: engine.precision });

    const tick = async () => {
      if (closed || sending || !sctx) return;
      if (video.readyState < 2 || !video.videoWidth) return;
      if (typeof document !== 'undefined' && document.hidden) return;
      sending = true;
      try {
        const w = targetW;
        const h = Math.max(2, Math.round((targetW * video.videoHeight) / video.videoWidth));
        ensureGrid(w, h);
        sctx.drawImage(video, 0, 0, w, h);
        const imgData = sctx.getImageData(0, 0, w, h);
        // Pair the colour bitmap with the depth this frame will produce.
        if (pendingColor) pendingColor.close();
        pendingColor = await createImageBitmap(small);
        if (closed) {
          pendingColor.close();
          pendingColor = null;
          return;
        }
        worker.postMessage({ type: 'frame', data: imgData.data.buffer, width: w, height: h }, [imgData.data.buffer]);
      } catch (e) {
        logLine(`frame skipped: ${(e as Error)?.message ?? e}`);
      } finally {
        sending = false;
      }
    };

    const startInput = async () => {
      try {
        if (clipUrl) {
          if (!clipUrl.startsWith('blob:')) video.crossOrigin = 'anonymous';
          video.src = clipUrl;
        } else {
          mediaStreamForCam = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
          if (closed) {
            mediaStreamForCam.getTracks().forEach((t) => t.stop());
            return;
          }
          video.srcObject = mediaStreamForCam;
        }
        await video.play().catch(() => {});
        inferTimer = setInterval(() => void tick(), inferMs);
      } catch (e) {
        fail(`could not open the ${clipUrl ? 'clip' : 'webcam'}: ${(e as Error)?.message ?? e}`);
      }
    };
    void startInput();

    return () => {
      closed = true;
      logLine('depthcloud disabled');
      if (inferTimer) clearInterval(inferTimer);
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
      pendingColor?.close();
      mediaStreamForCam?.getTracks().forEach((t) => t.stop());
      try {
        video.pause();
        video.removeAttribute('src');
        video.srcObject = null;
        video.load();
      } catch {
        /* ignore */
      }
      renderer?.dispose();
      renderer = null;
      rendererRef.current = null;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [enabled, clipUrl, engine.precision, engine.res, engine.fps]);

  // Style + param changes reuse the live renderer (no rebuild).
  useEffect(() => {
    rendererRef.current?.setStyle(mode);
  }, [mode]);
  useEffect(() => {
    rendererRef.current?.setParams(params);
  }, [params.spin, params.speed, params.size, params.density, params.bright, params.bloom, params.wind, params.trails, params.distance]);

  return feed;
}
