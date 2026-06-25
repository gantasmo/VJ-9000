import { useEffect, useRef, useState } from 'react';
import { backendBase } from './libraryUpload';

/**
 * AKVJ video source for the VJ — a generic Unity-desktop visual streamed in.
 *
 * A Unity desktop app (e.g. Akvj, the Azure-Kinect depth VFX visualizer) running
 * separately JPEG-encodes its camera each frame and pushes the frames over a
 * WebSocket to theDAW's `akvj` backend module. This hook connects to that module's
 * viewer endpoint, decodes each JPEG with `createImageBitmap`, draws it onto an
 * offscreen canvas, and exposes `canvas.captureStream()` as a live MediaStream the
 * existing `useMedia` pipeline treats exactly like a webcam (CAM<->MEM crossfade,
 * all deck effects).
 *
 * MJPEG keeps the sender trivial (no native encoder / codec license) and the decode
 * is just `createImageBitmap`, so this is the sibling of `useQuestStitch` with the
 * WebCodecs H.264 path swapped for a per-frame image decode. The transport is the
 * same shape, so a future H.264 sender could reuse the queststitch decoder instead.
 */

type AkvjState = 'idle' | 'connecting' | 'waiting' | 'live' | 'error';

export interface AkvjFeed {
  /** Stable canvas-captured MediaStream, or null until the relay is ready. */
  stream: MediaStream | null;
  state: AkvjState;
  error: string | null;
  fps: number;
  width: number | null;
  height: number | null;
  log: string[];
}

const initialFeed: AkvjFeed = {
  stream: null,
  state: 'idle',
  error: null,
  fps: 0,
  width: null,
  height: null,
  log: [],
};

const LOG_CAP = 200;

const wsUrl = (): string => `${backendBase().replace(/^http/, 'ws')}/api/akvj/ws/view`;

export function useAkvj(enabled: boolean): AkvjFeed {
  const [feed, setFeed] = useState<AkvjFeed>(initialFeed);

  // Created once and kept stable so the downstream camera <video> binds srcObject
  // exactly one time, like the other generative sources.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (!enabled) {
      setFeed((prev) => ({ ...initialFeed, stream: prev.stream, log: prev.log }));
      return;
    }

    let closed = false;
    let socket: WebSocket | null = null;
    let framesThisSecond = 0;
    let totalFrames = 0;
    let everLive = false;
    let decoding = false; // skip frames while a decode is in flight (stay near-live)
    let lastTick = performance.now();
    let lastFrameAt = performance.now();
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;

    const patch = (next: Partial<AkvjFeed>) => {
      if (!closed) setFeed((prev) => ({ ...prev, ...next }));
    };
    const logLine = (msg: string) => {
      // eslint-disable-next-line no-console
      console.info('[akvj]', msg);
      if (closed) return;
      const stamped = `${new Date().toLocaleTimeString()} ${msg}`;
      setFeed((prev) => ({ ...prev, log: [...prev.log, stamped].slice(-LOG_CAP) }));
    };
    const fail = (message: string) => {
      logLine(`ERROR: ${message}`);
      patch({ state: 'error', error: message });
    };

    logLine(`AKVJ source enabled, origin=${window.location.origin}`);

    if (typeof createImageBitmap === 'undefined') {
      fail('This browser cannot decode the AKVJ feed (createImageBitmap unavailable).');
      return;
    }

    // Stable offscreen canvas + capture stream.
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
      canvasRef.current.width = 1280;
      canvasRef.current.height = 720;
    }
    const canvas = canvasRef.current;
    if (!streamRef.current && typeof canvas.captureStream === 'function') {
      streamRef.current = canvas.captureStream(30);
    }
    const stream = streamRef.current;
    const ctx = canvas.getContext('2d');
    patch({ stream });

    const drawBitmap = (bmp: ImageBitmap) => {
      if (!ctx) {
        bmp.close();
        return;
      }
      if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
        canvas.width = bmp.width;
        canvas.height = bmp.height;
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      framesThisSecond += 1;
      totalFrames += 1;
      lastFrameAt = performance.now();
      if (totalFrames === 1) {
        everLive = true;
        logLine(`FIRST FRAME ${canvas.width}x${canvas.height}`);
        patch({ state: 'live', width: canvas.width, height: canvas.height });
      }
      const now = performance.now();
      if (now - lastTick >= 1000) {
        const fps = Math.round((framesThisSecond * 1000) / (now - lastTick));
        patch({ state: 'live', fps, width: canvas.width, height: canvas.height, error: null });
        framesThisSecond = 0;
        lastTick = now;
      }
    };

    const onFrame = async (buffer: ArrayBuffer) => {
      // MJPEG has no inter-frame deps, so dropping a frame that arrives mid-decode
      // costs nothing and keeps the feed near-live under a slow decode.
      if (decoding) return;
      decoding = true;
      try {
        const bmp = await createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }));
        if (closed) bmp.close();
        else drawBitmap(bmp);
      } catch {
        /* corrupt / partial frame — skip it */
      } finally {
        decoding = false;
      }
    };

    const teardownSocket = (s: WebSocket | null) => {
      if (!s) return;
      s.onopen = null;
      s.onmessage = null;
      s.onerror = null;
      s.onclose = null;
      try {
        s.close();
      } catch {
        /* already closed */
      }
    };

    const scheduleReconnect = (why: string) => {
      if (closed || reconnectTimer) return;
      reconnectAttempts += 1;
      const delay = Math.min(5000, 800 * reconnectAttempts);
      logLine(`recovering (${why}) — retry in ${delay}ms (attempt ${reconnectAttempts})`);
      patch({ state: 'connecting' });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (!closed) connect();
      }, delay);
    };

    const connect = () => {
      teardownSocket(socket);
      const url = wsUrl();
      logLine(`connecting WebSocket -> ${url}`);
      socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      patch({ state: everLive ? 'connecting' : 'waiting', error: null });

      socket.onopen = () => {
        reconnectAttempts = 0;
        lastFrameAt = performance.now();
        logLine('WebSocket open');
      };
      socket.onerror = () => logLine(`WebSocket error on ${url}`);
      socket.onclose = (e) => {
        logLine(`WebSocket closed (code=${e.code} reason=${e.reason || 'none'})`);
        socket = null;
        if (!closed) scheduleReconnect(`ws close ${e.code}`);
      };
      socket.onmessage = (event) => {
        if (closed) return;
        // Park while the VJ tab is hidden — don't burn cycles decoding unseen frames.
        if (typeof document !== 'undefined' && document.hidden) return;
        const buffer = event.data instanceof ArrayBuffer ? event.data : null;
        if (buffer && buffer.byteLength > 0) void onFrame(buffer);
      };
    };

    // Watchdog: recover only a feed that was actually live and then stopped. An
    // open socket with no frames yet is the normal "desktop app not pushing" wait.
    const STALL_MS = 5000;
    watchdog = setInterval(() => {
      if (closed || (typeof document !== 'undefined' && document.hidden)) return;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (!everLive) return;
      if (performance.now() - lastFrameAt > STALL_MS) {
        logLine('feed stalled (no frames for 5s), recovering');
        scheduleReconnect('stall');
      }
    }, 2000);

    const onVisible = () => {
      if (closed || document.hidden) return;
      if (everLive && performance.now() - lastFrameAt > 3000) {
        logLine('tab visible again, refreshing the AKVJ feed');
        scheduleReconnect('wake');
      }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

    connect();

    return () => {
      closed = true;
      logLine('AKVJ source disabled, closing WebSocket');
      if (watchdog) clearInterval(watchdog);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      teardownSocket(socket);
    };
  }, [enabled]);

  return feed;
}
