import { useEffect, useRef, useState } from 'react';
import { backendBase } from './libraryUpload';

/**
 * Direct Quest (or any ADB device) video source for the VJ.
 *
 * theDAW's backend runs a `questcast` Node sidecar that speaks the scrcpy
 * protocol over ADB and relays the raw H.264 packets over a WebSocket. This
 * hook (running INSIDE the VJ app) drives that relay end-to-end:
 *
 *   1. POST /api/questcast/start (idempotent) so the relay is up.
 *   2. Poll /api/questcast/status until it reports `ready` + a `ws_port`.
 *   3. Open the WebSocket, decode the H.264 stream with WebCodecs, and draw
 *      each frame onto an offscreen canvas.
 *   4. `canvas.captureStream()` exposes that canvas as a live MediaStream, so
 *      the existing `useMedia` camera pipeline can treat the Quest exactly
 *      like a webcam -no getDisplayMedia window picker, no OBS.
 *
 * The relay fans out to multiple WebSocket clients, so the host's diagnostic
 * preview and this in-VJ source can decode the same feed in parallel without
 * conflict. We never auto-stop the relay on disable (that would kill the host
 * preview and re-spawn scrcpy on re-enable); the host owns Stop.
 */

type QuestCastState =
  | 'idle'
  | 'starting'
  | 'connecting'
  | 'waiting-video'
  | 'live'
  | 'error';

export interface QuestCastFeed {
  /** Stable canvas-captured MediaStream, or null until the relay is ready. */
  stream: MediaStream | null;
  state: QuestCastState;
  error: string | null;
  fps: number;
  width: number | null;
  height: number | null;
  /** Human-readable event log (newest last), surfaced in the UI + console. */
  log: string[];
}

const initialFeed: QuestCastFeed = {
  stream: null,
  state: 'idle',
  error: null,
  fps: 0,
  width: null,
  height: null,
  log: [],
};

const LOG_CAP = 200;

const wsUrlForPort = (port: number): string => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.hostname || 'localhost';
  return `${protocol}//${host}:${port}`;
};

const byteHex = (value: number) => value.toString(16).padStart(2, '0').toUpperCase();

const findStartCode = (data: Uint8Array, from: number): number => {
  for (let i = from; i + 3 < data.length; i += 1) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) return i;
    if (i + 4 < data.length && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) return i;
  }
  return -1;
};

/** Extract an avc1.PPCCLL codec string from the SPS in an Annex-B config NAL. */
const h264CodecFromAnnexB = (data: Uint8Array): string | null => {
  let cursor = 0;
  while (cursor < data.length) {
    const start = findStartCode(data, cursor);
    if (start < 0) break;
    const startCodeLength = data[start + 2] === 1 ? 3 : 4;
    const nalStart = start + startCodeLength;
    const next = findStartCode(data, nalStart);
    const nalEnd = next < 0 ? data.length : next;
    if (nalStart < nalEnd && (data[nalStart] & 0x1f) === 7 && nalEnd - nalStart >= 4) {
      return `avc1.${byteHex(data[nalStart + 1])}${byteHex(data[nalStart + 2])}${byteHex(data[nalStart + 3])}`;
    }
    cursor = nalEnd;
  }
  return null;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type QuestView = 'full' | 'left' | 'right';

export function useQuestCast(enabled: boolean, view: QuestView = 'full'): QuestCastFeed {
  const [feed, setFeed] = useState<QuestCastFeed>(initialFeed);

  // The captured canvas + its stream are created once and kept stable so the
  // downstream camera <video> element only has to bind the srcObject one time.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // Live crop selection read by the decode loop (changes without rebuilding).
  const viewRef = useRef<QuestView>(view);
  viewRef.current = view;

  useEffect(() => {
    if (!enabled) {
      setFeed((prev) => ({ ...initialFeed, stream: prev.stream, log: prev.log }));
      return;
    }

    let closed = false;
    let socket: WebSocket | null = null;
    let decoder: VideoDecoder | null = null;
    let configured = false;
    let waitingForKeyframe = true;
    let framesThisSecond = 0;
    let totalFrames = 0;
    let dataPkts = 0;
    let droppedPkts = 0;
    let lastTick = performance.now();
    let lastFrameAt = performance.now(); // watchdog: time of the last decoded frame
    let backendShown = 0; // how many backend relay log lines already mirrored
    let logPoll: ReturnType<typeof setInterval> | null = null;
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    // scrcpy sends SPS/PPS as a SEPARATE Annex-B config packet, not in-band with
    // the keyframe. WebCodecs (configured without a `description`, i.e. Annex-B
    // mode) needs those NALs present in the access unit or it accepts chunks but
    // never produces a frame. Keep the config bytes and prepend them to each
    // keyframe so the decoder has SPS/PPS.
    let configBytes: Uint8Array | null = null;
    let loggedPreConfig = false; // throttle the "data before config" log to once per connect

    const patch = (next: Partial<QuestCastFeed>) => {
      if (closed) return;
      setFeed((prev) => ({ ...prev, ...next }));
    };

    // Central log sink: console + UI ring buffer, so we can see EVERYTHING.
    const logLine = (msg: string) => {
      // eslint-disable-next-line no-console
      console.info('[questcast]', msg);
      if (closed) return;
      const stamped = `${new Date().toLocaleTimeString()} ${msg}`;
      setFeed((prev) => ({ ...prev, log: [...prev.log, stamped].slice(-LOG_CAP) }));
    };

    const fail = (message: string) => {
      logLine(`ERROR: ${message}`);
      patch({ state: 'error', error: message });
    };

    logLine(`QUEST source enabled, origin=${window.location.origin}`);

    if (!('VideoDecoder' in window)) {
      fail('This browser cannot decode the Quest feed (WebCodecs VideoDecoder unavailable). Use current Chrome or Edge.');
      return;
    }
    logLine('WebCodecs VideoDecoder available');

    // Lazily create the stable offscreen canvas + capture stream. A fixed
    // capture rate is more reliable for an OFFSCREEN canvas than the
    // draw-driven default (which some Chrome builds stall on when the canvas
    // is detached from the DOM).
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
      canvasRef.current.width = 1280;
      canvasRef.current.height = 720;
    }
    const canvas = canvasRef.current;
    if (!streamRef.current && typeof canvas.captureStream === 'function') {
      streamRef.current = canvas.captureStream(30);
      const t = streamRef.current.getVideoTracks()[0];
      logLine(`captureStream(30) created, track=${t ? `${t.label || 'canvas'} state=${t.readyState} enabled=${t.enabled}` : 'NONE'}`);
    } else if (typeof canvas.captureStream !== 'function') {
      logLine('WARNING: canvas.captureStream is not a function in this browser');
    }
    const stream = streamRef.current;

    const configureDecoder = (codec: string) => {
      logLine(`configuring VideoDecoder codec=${codec}`);
      try {
        decoder?.close();
      } catch {
        /* already closed */
      }
      decoder = new VideoDecoder({
        output(frame) {
          try {
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            const width = frame.displayWidth || frame.codedWidth || 1280;
            const height = frame.displayHeight || frame.codedHeight || 720;
            // The Quest mirrors a side-by-side stereo image. `view` lets the
            // user pick the full SBS frame or crop one eye to a clean 16:9.
            const view = viewRef.current;
            if (view === 'full') {
              if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
              }
              ctx.drawImage(frame, 0, 0, width, height);
            } else {
              // One eye = a half-width column; crop a centered 16:9 band from it.
              const eyeW = Math.floor(width / 2);
              const sx = view === 'right' ? width - eyeW : 0;
              const cropH = Math.min(height, Math.round((eyeW * 9) / 16));
              const sy = Math.floor((height - cropH) / 2);
              const outW = 1280;
              const outH = 720;
              if (canvas.width !== outW || canvas.height !== outH) {
                canvas.width = outW;
                canvas.height = outH;
              }
              ctx.drawImage(frame, sx, sy, eyeW, cropH, 0, 0, outW, outH);
            }
            framesThisSecond += 1;
            totalFrames += 1;
            lastFrameAt = performance.now();
            if (totalFrames === 1) {
              logLine(`FIRST FRAME decoded ${width}x${height}, drawing to canvas`);
              patch({ state: 'live', width, height });
            }
            const now = performance.now();
            if (now - lastTick >= 1000) {
              const elapsed = now - lastTick;
              const fps = Math.round((framesThisSecond * 1000) / elapsed);
              logLine(`live ${fps}fps ${width}x${height} (total ${totalFrames} frames, dropped ${droppedPkts} pkts)`);
              patch({ state: 'live', width, height, fps, error: null });
              framesThisSecond = 0;
              lastTick = now;
            }
          } finally {
            frame.close();
          }
        },
        error(err) {
          fail(`decoder error: ${err instanceof Error ? err.message : String(err)}`);
        },
      });
      decoder.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
      configured = true;
      waitingForKeyframe = true;
      patch({ state: 'waiting-video', error: null });
      logLine('decoder configured, waiting for first keyframe');
    };

    // Detach handlers BEFORE closing so the socket's own onclose can't schedule
    // yet another reconnect (deliberate teardown != a dropped stream). Without
    // this, a reconnect orphaned the still-open socket, whose onmessage kept
    // firing into a reset decode state and flooded "data before config".
    const teardownSocket = (s: WebSocket | null) => {
      if (!s) return;
      s.onopen = null;
      s.onmessage = null;
      s.onerror = null;
      s.onclose = null;
      try { s.close(); } catch { /* already closed */ }
    };

    // Robustness: if the stream drops mid-show (headset display change, relay
    // restart, scrcpy `video-ended`), auto-recover by re-booting the relay and
    // reconnecting, with a short backoff. Never give up while still enabled.
    const scheduleReconnect = (why: string) => {
      if (closed || reconnectTimer) return;
      reconnectAttempts += 1;
      const delay = Math.min(5000, 800 * reconnectAttempts);
      logLine(`stream dropped (${why}), reconnecting in ${delay}ms (attempt ${reconnectAttempts})`);
      patch({ state: 'connecting' });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (closed) return;
        // Drop the old socket + decoder; the relay replays its config on reconnect.
        teardownSocket(socket);
        socket = null;
        try { decoder?.close(); } catch { /* already closed */ }
        decoder = null;
        configured = false;
        waitingForKeyframe = true;
        configBytes = null;
        void boot();
      }, delay);
    };

    const connect = (port: number) => {
      // Never leave a prior socket open (it would double-decode and flood the log).
      teardownSocket(socket);
      socket = null;
      loggedPreConfig = false;
      const wsUrl = wsUrlForPort(port);
      logLine(`connecting WebSocket -> ${wsUrl}`);
      socket = new WebSocket(wsUrl);
      socket.binaryType = 'arraybuffer';
      patch({ state: 'connecting', stream, error: null });

      socket.onopen = () => {
        reconnectAttempts = 0; // healthy connection resets the backoff
        logLine('WebSocket open');
      };
      socket.onerror = () => logLine(`WebSocket error on ${wsUrl}`);
      socket.onclose = (e) => {
        logLine(`WebSocket closed (code=${e.code} reason=${e.reason || 'none'})`);
        socket = null;
        if (!closed) scheduleReconnect(`ws close ${e.code}`);
      };

      socket.onmessage = (event) => {
        if (closed) return;
        if (typeof event.data === 'string') {
          logLine(`metadata: ${event.data.slice(0, 160)}`);
          return;
        }
        const buffer = event.data instanceof ArrayBuffer ? event.data : null;
        if (!buffer || buffer.byteLength < 16) return;
        const view = new DataView(buffer);
        const packetType = view.getUint8(0);
        const keyframe = view.getUint8(1) === 1;
        const timestamp = Math.max(0, Math.round(view.getFloat64(8, true) || performance.now() * 1000));
        const data = new Uint8Array(buffer, 16);

        // Efficiency: when the VJ tab is hidden, the output render loop is
        // parked anyway -don't burn the HW decoder. Drop data packets and
        // re-sync on a keyframe when the tab comes back. Full quality whenever
        // the tab is visible (no quality/feature loss while you're using it).
        if (packetType === 1 && typeof document !== 'undefined' && document.hidden) {
          waitingForKeyframe = true;
          return;
        }

        if (packetType === 0) {
          logLine(`config packet (${data.byteLength}B) received`);
          // Copy out of the WS buffer; we prepend it to keyframes below.
          configBytes = new Uint8Array(data);
          configureDecoder(h264CodecFromAnnexB(data) ?? 'avc1.42E01E');
          return;
        }
        if (packetType !== 1 || !decoder || !configured) {
          if (packetType === 1 && !configured && !loggedPreConfig) {
            loggedPreConfig = true;
            logLine('data arriving before the config packet, waiting for config');
          }
          return;
        }
        dataPkts += 1;
        if (waitingForKeyframe && !keyframe) {
          if (dataPkts % 30 === 1) logLine(`waiting for keyframe... (${dataPkts} data pkts seen)`);
          return;
        }
        if (waitingForKeyframe && keyframe) logLine('FIRST KEYFRAME received, starting decode');
        waitingForKeyframe = false;
        if (decoder.decodeQueueSize > 8) {
          droppedPkts += 1;
          return; // drop to stay near-live
        }
        // Prepend SPS/PPS to keyframes so the Annex-B decoder has them in-band.
        let chunkData: Uint8Array = data;
        if (keyframe && configBytes) {
          chunkData = new Uint8Array(configBytes.length + data.length);
          chunkData.set(configBytes, 0);
          chunkData.set(data, configBytes.length);
        }
        try {
          decoder.decode(new EncodedVideoChunk({ type: keyframe ? 'key' : 'delta', timestamp, data: chunkData }));
        } catch (err) {
          fail(`decode() threw: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
    };

    // Mirror new backend relay log lines into our UI log so the WHOLE pipeline
    // is visible in one place (frontend + relay + scrcpy + adb).
    const drainBackendLog = (status: { log?: unknown }) => {
      const lines = Array.isArray(status.log) ? (status.log as string[]) : null;
      if (!lines) return;
      if (lines.length < backendShown) backendShown = 0; // relay restarted
      for (let i = backendShown; i < lines.length; i += 1) {
        logLine(`[backend] ${lines[i]}`);
      }
      backendShown = lines.length;
    };

    const boot = async () => {
      patch({ state: 'starting', stream, error: null });
      const base = backendBase();
      logLine(`backend base = ${base}`);
      // 1. Start (idempotent -returns current status if already running).
      logLine('POST /api/questcast/start ...');
      try {
        const r = await fetch(`${base}/api/questcast/start`, { method: 'POST' });
        const body = await r.json().catch(() => ({}));
        logLine(`start -> HTTP ${r.status} state=${body?.state ?? '?'} ws_port=${body?.ws_port ?? '?'}${body?.error ? ` error=${body.error}` : ''}`);
        drainBackendLog(body);
      } catch (err) {
        fail(`Could not reach theDAW backend to start the Quest relay (${err instanceof Error ? err.message : String(err)}).`);
        return;
      }
      // 2. Poll status until ready or error (~30s budget).
      const deadline = performance.now() + 30000;
      while (!closed && performance.now() < deadline) {
        let status: { state?: string; running?: boolean; ws_port?: number; error?: string; message?: string; log?: unknown } | null = null;
        try {
          const res = await fetch(`${base}/api/questcast/status`);
          status = await res.json();
        } catch (err) {
          logLine(`status poll failed (transient): ${err instanceof Error ? err.message : String(err)}`);
        }
        if (status) {
          drainBackendLog(status);
          logLine(`status: state=${status.state ?? '?'} running=${status.running ?? '?'} ws_port=${status.ws_port ?? '?'}`);
          if (status.state === 'error' || status.error) {
            fail(status.error || status.message || 'Quest relay reported an error.');
            return;
          }
          const ready = status.state === 'ready' && typeof status.ws_port === 'number';
          if (ready && status.ws_port) {
            connect(status.ws_port);
            // Keep draining backend log (packet-stats etc.) while live.
            logPoll = setInterval(async () => {
              if (closed) return;
              try {
                const r = await fetch(`${base}/api/questcast/status`);
                drainBackendLog(await r.json());
              } catch {
                /* ignore */
              }
            }, 2000);
            return;
          }
        }
        await sleep(600);
      }
      if (!closed) fail('Quest relay did not become ready within 30s. Check the log above (adb device? scrcpy? ws port?).');
    };

    // Watchdog: when the feed is visible but frames stop arriving (the Quest
    // slept / display turned off -> scrcpy video-ended), recover on our own so
    // the user never has to refresh or toggle. While the tab is hidden we drop
    // packets on purpose, so we only count a stall when visible.
    const STALL_MS = 5000;
    watchdog = setInterval(() => {
      if (closed || (typeof document !== 'undefined' && document.hidden)) return;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (performance.now() - lastFrameAt > STALL_MS) {
        logLine('feed stalled (no frames for 5s), recovering');
        scheduleReconnect('stall');
      }
    }, 2000);

    // Coming back from sleep / tab-switch: recover immediately if stale.
    const onVisible = () => {
      if (closed || document.hidden) return;
      if (performance.now() - lastFrameAt > 3000) {
        logLine('tab visible again, refreshing the Quest feed');
        scheduleReconnect('wake');
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }

    void boot();

    return () => {
      closed = true;
      logLine('QUEST source disabled, tearing down WebSocket + decoder');
      if (logPoll) clearInterval(logPoll);
      if (watchdog) clearInterval(watchdog);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisible);
      }
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      try {
        decoder?.close();
      } catch {
        /* already closed */
      }
    };
  }, [enabled]);

  return feed;
}
