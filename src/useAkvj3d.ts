import { useEffect, useRef, useState } from 'react';
import { backendBase, backendWsBase } from './libraryUpload';
import { AkvjCloudRenderer, AKVJ_PARAMS_DEFAULT, type AkvjLevels, type AkvjParams } from './akvj/AkvjCloudRenderer';

/**
 * Native ``akvj3d`` VJ source — a live Azure Kinect point cloud rendered in the
 * browser, no Unity in the loop.
 *
 * A headless pyk4a sidecar (auto-spawned via POST /api/akvj/start) opens the
 * Kinect and streams, over the akvj relay, a one-time XY unprojection table
 * (chunked) plus per-frame depth16 + depth-aligned colour, framed with a small
 * ``AKV1`` header. This hook parses those frames, feeds an AkvjCloudRenderer that
 * unprojects them into a GPU point cloud, and exposes ``canvas.captureStream()``
 * so the existing ``useMedia`` pipeline (CAM<->MEM crossfade, all deck effects)
 * mixes it like any other source.
 *
 * Sibling of ``useAkvj`` (the flat MJPEG video path), but here the browser owns
 * the geometry, so the look (point size, noise displacement, audio reactivity)
 * lives in the deck instead of being frozen in Unity.
 */

type Akvj3dState = 'idle' | 'connecting' | 'waiting' | 'live' | 'error';

export interface Akvj3dFeed {
  stream: MediaStream | null;
  state: Akvj3dState;
  error: string | null;
  fps: number;
  width: number | null;
  height: number | null;
  log: string[];
  /** Sensor-side lifecycle, polled from /api/akvj/sidecar — the real answer to
   *  "is it actually Kinected" (the WS `state` above only knows the VIEW side). */
  sidecarState: string;
  sidecarLabel: string;
  sidecarFps: number;
  sidecarLog: string[];
}

const initialFeed: Akvj3dFeed = {
  stream: null,
  state: 'idle',
  error: null,
  fps: 0,
  width: null,
  height: null,
  log: [],
  sidecarState: 'unknown',
  sidecarLabel: 'checking sensor…',
  sidecarFps: 0,
  sidecarLog: [],
};

/** Human label for a raw sidecar lifecycle state (see backend LIFECYCLE_STATES). */
function sidecarLabelFor(
  state: string,
  fps: number,
  percent: number | null | undefined,
  message: string | null | undefined,
): string {
  switch (state) {
    case 'streaming':
      return `streaming ${fps}fps`;
    case 'building_table':
      return `building point map ${typeof percent === 'number' ? percent + '%' : '…'}`;
    case 'table_ready':
    case 'table_packed':
      return 'point map ready, connecting…';
    case 'opening':
      return 'opening sensor…';
    case 'opened':
    case 'device':
      return 'sensor opened, preparing…';
    case 'connecting':
    case 'relay_connected':
      return 'connecting stream…';
    case 'starting':
      return 'starting sensor…';
    case 'error':
      return message ? `error: ${message}` : 'sensor error';
    case 'stopped':
      return 'sensor not running';
    default:
      return state;
  }
}

const LOG_CAP = 200;
const MAGIC0 = 0x41; // 'A'
const MAGIC1 = 0x4b; // 'K'
const MAGIC2 = 0x56; // 'V'
const MAGIC3 = 0x31; // '1'

// Viewer WS goes DIRECT to the backend (the dev proxy drops /api WS upgrades).
const wsUrl = (): string => `${backendWsBase()}/api/akvj/ws/view`;
const startUrl = (): string => `${backendBase()}/api/akvj/start`;
const sidecarUrl = (): string => `${backendBase()}/api/akvj/sidecar`;

export function useAkvj3d(
  enabled: boolean,
  getLevels: () => AkvjLevels,
  mode = 'points',
  params: AkvjParams = AKVJ_PARAMS_DEFAULT,
): Akvj3dFeed {
  const [feed, setFeed] = useState<Akvj3dFeed>(initialFeed);
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

    let closed = false;
    let socket: WebSocket | null = null;
    let framesThisSecond = 0;
    let totalFrames = 0;
    let everLive = false;
    let decoding = false;
    let lastTick = performance.now();
    let lastFrameAt = performance.now();
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let sidecarPoll: ReturnType<typeof setInterval> | null = null;
    let reconnectAttempts = 0;
    let lastSidecarState = '';
    let lastSidecarLogLen = 0;

    // XY-table assembly across row-block chunks.
    let tableW = 0;
    let tableH = 0;
    let tableData: Float32Array | null = null;
    let tableRowsCovered = 0;
    let tableReady = false;

    const patch = (next: Partial<Akvj3dFeed>) => {
      if (!closed) setFeed((prev) => ({ ...prev, ...next }));
    };
    const logLine = (msg: string) => {
      // eslint-disable-next-line no-console
      console.info('[akvj3d]', msg);
      if (closed) return;
      const stamped = `${new Date().toLocaleTimeString()} ${msg}`;
      setFeed((prev) => ({ ...prev, log: [...prev.log, stamped].slice(-LOG_CAP) }));
    };
    const fail = (message: string) => {
      logLine(`ERROR: ${message}`);
      patch({ state: 'error', error: message });
    };

    logLine(`akvj3d source enabled, origin=${window.location.origin}`);

    if (typeof createImageBitmap === 'undefined') {
      fail('This browser cannot decode the Kinect colour stream (createImageBitmap unavailable).');
      return;
    }

    // Fresh canvas + renderer per enable (a disposed renderer force-loses its
    // WebGL context, and a canvas only yields its first context).
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    let renderer: AkvjCloudRenderer | null = null;
    try {
      renderer = new AkvjCloudRenderer(canvas, () => getLevelsRef.current());
    } catch (e) {
      fail(`point-cloud renderer init failed: ${(e as Error)?.message ?? e}`);
      return;
    }
    rendererRef.current = renderer;
    renderer.setStyle(modeRef.current);
    renderer.setParams(paramsRef.current);
    let stream: MediaStream | null = null;
    if (typeof canvas.captureStream === 'function') {
      stream = canvas.captureStream(30);
    }
    patch({ stream });

    // Auto-spawn the native Kinect sidecar (best-effort; a running Unity Akvj or
    // remote feed makes /start refuse, and that is fine — frames still arrive).
    void fetch(startUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then((r) => r.json())
      .then((j) =>
        logLine(
          j.ok === false
            ? `start: sidecar NOT spawned — ${j.error || j.message || 'refused'}`
            : `start: sidecar ${j.reused ? 'already running' : 'spawning'} (${j.state || 'ok'})`,
        ),
      )
      .catch((e) => logLine(`start request failed: ${e?.message ?? e}`));

    // Poll the sensor-side sidecar so the panel shows what is ACTUALLY happening
    // (opening / building point map / streaming / device-in-use), not just the
    // view-socket state. State changes + new sidecar log lines are echoed into the
    // feed log so the user can watch progress instead of guessing.
    const pollSidecar = async () => {
      if (closed) return;
      try {
        const r = await fetch(sidecarUrl());
        if (!r.ok || closed) return;
        const j = await r.json();
        const state: string = j.state || (j.running ? 'starting' : 'stopped');
        const fps: number = typeof j.fps === 'number' ? j.fps : 0;
        const label = sidecarLabelFor(state, fps, j.percent, j.message);
        const slog: string[] = Array.isArray(j.log) ? j.log : [];
        if (state !== lastSidecarState) {
          logLine(`sensor: ${label}`);
          lastSidecarState = state;
        }
        // Surface any NEW raw sidecar log lines (SDK errors, build progress, etc).
        if (slog.length > lastSidecarLogLen) {
          for (const line of slog.slice(lastSidecarLogLen)) logLine(`· ${line}`);
        }
        lastSidecarLogLen = slog.length;
        patch({ sidecarState: state, sidecarLabel: label, sidecarFps: fps, sidecarLog: slog });
      } catch {
        /* backend momentarily unreachable — keep polling */
      }
    };
    void pollSidecar();
    sidecarPoll = setInterval(() => void pollSidecar(), 1000);

    const markLive = () => {
      framesThisSecond += 1;
      totalFrames += 1;
      lastFrameAt = performance.now();
      if (totalFrames === 1) {
        everLive = true;
        logLine(`FIRST FRAME ${tableW}x${tableH}`);
        patch({ state: 'live', width: tableW, height: tableH });
      }
      const now = performance.now();
      if (now - lastTick >= 1000) {
        const fps = Math.round((framesThisSecond * 1000) / (now - lastTick));
        patch({ state: 'live', fps, width: tableW, height: tableH, error: null });
        framesThisSecond = 0;
        lastTick = now;
      }
    };

    const onTableChunk = (buffer: ArrayBuffer, dv: DataView) => {
      const w = dv.getUint16(6, true);
      const h = dv.getUint16(8, true);
      const rowStart = dv.getUint16(10, true);
      const rowCount = dv.getUint16(12, true);
      if (w !== tableW || h !== tableH || !tableData) {
        tableW = w;
        tableH = h;
        tableData = new Float32Array(w * h * 2);
        tableRowsCovered = 0;
        tableReady = false;
      }
      // slice() to get a 4-byte-aligned buffer (header is 14 bytes).
      const chunk = new Float32Array(buffer.slice(14, 14 + rowCount * w * 2 * 4));
      tableData.set(chunk, rowStart * w * 2);
      tableRowsCovered = Math.max(tableRowsCovered, rowStart + rowCount);
      if (!tableReady && tableRowsCovered >= h) {
        tableReady = true;
      }
      if (tableReady && renderer) {
        renderer.setXYTable(w, h, tableData);
        if (!everLive) logLine(`XY table ready ${w}x${h}`);
      }
    };

    const onDepthColorFrame = async (buffer: ArrayBuffer, dv: DataView) => {
      if (decoding) return; // stay near-live under a slow colour decode
      if (!tableReady || !renderer) return; // wait for the table to place points
      decoding = true;
      try {
        const w = dv.getUint16(6, true);
        const h = dv.getUint16(8, true);
        const depthLen = dv.getUint32(12, true);
        const colorLen = dv.getUint32(16, true);
        const depthOffset = 20;
        const colorOffset = depthOffset + depthLen;
        const depth = new Uint16Array(buffer, depthOffset, depthLen / 2);
        let bitmap: ImageBitmap | null = null;
        if (colorLen > 0) {
          const colorBytes = new Uint8Array(buffer, colorOffset, colorLen);
          bitmap = await createImageBitmap(new Blob([colorBytes], { type: 'image/jpeg' }));
        }
        if (closed) {
          bitmap?.close();
          return;
        }
        renderer.pushFrame(w, h, depth, bitmap);
        markLive();
      } catch {
        /* corrupt / partial frame — skip it */
      } finally {
        decoding = false;
      }
    };

    const onMessage = (buffer: ArrayBuffer) => {
      if (buffer.byteLength < 5) return;
      const dv = new DataView(buffer);
      if (
        dv.getUint8(0) !== MAGIC0 || dv.getUint8(1) !== MAGIC1 ||
        dv.getUint8(2) !== MAGIC2 || dv.getUint8(3) !== MAGIC3
      ) {
        return; // not an AKV1 message (e.g. a stray MJPEG frame) — ignore
      }
      const type = dv.getUint8(4);
      if (type === 1) onTableChunk(buffer, dv);
      else if (type === 2) void onDepthColorFrame(buffer, dv);
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
        if (typeof document !== 'undefined' && document.hidden) return;
        const buffer = event.data instanceof ArrayBuffer ? event.data : null;
        if (buffer && buffer.byteLength > 0) onMessage(buffer);
      };
    };

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
        logLine('tab visible again, refreshing the Kinect feed');
        scheduleReconnect('wake');
      }
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

    connect();

    return () => {
      closed = true;
      logLine('akvj3d source disabled, closing WebSocket + renderer');
      if (watchdog) clearInterval(watchdog);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (sidecarPoll) clearInterval(sidecarPoll);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      teardownSocket(socket);
      renderer?.dispose();
      renderer = null;
      rendererRef.current = null;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [enabled]);

  // Style + param changes reuse the live renderer (no rebuild / context churn).
  useEffect(() => {
    rendererRef.current?.setStyle(mode);
  }, [mode]);
  useEffect(() => {
    rendererRef.current?.setParams(params);
  }, [params.spin, params.speed, params.size, params.density, params.bright, params.bloom, params.wind, params.trails, params.distance]);

  return feed;
}
