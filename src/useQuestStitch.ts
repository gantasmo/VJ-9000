import { useEffect, useRef, useState } from 'react';
import { backendBase } from './libraryUpload';

/**
 * Direct Quest CLEAN-STITCH video source for the VJ.
 *
 * This is the sibling of `useQuestCast` (delinQuest). delinQuest mirrors the
 * whole Quest *display* via scrcpy, so it carries the MR scene + MIDI surface
 * the performer is looking at. THIS source carries only the clean stitched
 * passthrough: the Quest app (`GantasmoStitchStreamer`) MediaCodec-encodes the
 * stitch RenderTexture to H.264 and pushes it over `adb reverse` to theDAW's
 * `queststitch` backend module, which relays it over a WebSocket in the SAME
 * wire format questcast uses. So the decode path here is identical to
 * useQuestCast — only the transport differs (one FastAPI WebSocket on the
 * backend origin, no ws_port poll, no stereo crop).
 *
 *   1. POST /api/queststitch/start (idempotent) so the listener + adb reverse are up.
 *   2. Open ws(s)://<backend>/api/queststitch/ws and decode H.264 with WebCodecs.
 *   3. Draw each frame onto an offscreen canvas; canvas.captureStream() exposes
 *      it as a live MediaStream the existing `useMedia` pipeline treats like a webcam.
 */

type QuestStitchState =
  | 'idle'
  | 'starting'
  | 'connecting'
  | 'waiting-video'
  | 'live'
  | 'error';

export interface QuestStitchFeed {
  /** Stable canvas-captured MediaStream, or null until the relay is ready. */
  stream: MediaStream | null;
  state: QuestStitchState;
  error: string | null;
  fps: number;
  width: number | null;
  height: number | null;
  /** Human-readable event log (newest last), surfaced in the UI + console. */
  log: string[];
}

const initialFeed: QuestStitchFeed = {
  stream: null,
  state: 'idle',
  error: null,
  fps: 0,
  width: null,
  height: null,
  log: [],
};

const LOG_CAP = 200;

const wsUrl = (): string => {
  const base = backendBase().replace(/^http/, 'ws');
  return `${base}/api/queststitch/ws`;
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

export function useQuestStitch(enabled: boolean): QuestStitchFeed {
  const [feed, setFeed] = useState<QuestStitchFeed>(initialFeed);

  // The captured canvas + its stream are created once and kept stable so the
  // downstream camera <video> element only has to bind the srcObject one time.
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

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
    // True once we've decoded at least one frame. The Quest streamer is a
    // separate app that is often simply idle, so an OPEN WebSocket with no
    // frames yet is the normal waiting state — NOT a stall. We only treat a
    // gap as a stall (and reconnect) after the feed has actually been live.
    let everLive = false;
    let dataPkts = 0;
    let droppedPkts = 0;
    let lastTick = performance.now();
    let lastFrameAt = performance.now(); // watchdog: time of the last decoded frame
    let watchdog: ReturnType<typeof setInterval> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempts = 0;
    // SPS/PPS arrive as a SEPARATE Annex-B config packet; WebCodecs (Annex-B
    // mode) needs them present in the access unit, so keep them and prepend to
    // each keyframe.
    let configBytes: Uint8Array | null = null;
    let loggedPreConfig = false;

    const patch = (next: Partial<QuestStitchFeed>) => {
      if (closed) return;
      setFeed((prev) => ({ ...prev, ...next }));
    };

    const logLine = (msg: string) => {
      // eslint-disable-next-line no-console
      console.info('[queststitch]', msg);
      if (closed) return;
      const stamped = `${new Date().toLocaleTimeString()} ${msg}`;
      setFeed((prev) => ({ ...prev, log: [...prev.log, stamped].slice(-LOG_CAP) }));
    };

    const fail = (message: string) => {
      logLine(`ERROR: ${message}`);
      patch({ state: 'error', error: message });
    };

    logLine(`QUEST STITCH source enabled, origin=${window.location.origin}`);

    if (!('VideoDecoder' in window)) {
      fail('This browser cannot decode the Quest stitch (WebCodecs VideoDecoder unavailable). Use current Chrome or Edge.');
      return;
    }

    // Lazily create the stable offscreen canvas + capture stream.
    if (!canvasRef.current) {
      canvasRef.current = document.createElement('canvas');
      canvasRef.current.width = 1280;
      canvasRef.current.height = 720;
    }
    const canvas = canvasRef.current;
    if (!streamRef.current && typeof canvas.captureStream === 'function') {
      streamRef.current = canvas.captureStream(30);
      const t = streamRef.current.getVideoTracks()[0];
      logLine(`captureStream(30) created, track=${t ? `${t.label || 'canvas'} state=${t.readyState}` : 'NONE'}`);
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
            // The stitch is a single 16:9 image — draw it whole (no stereo crop).
            if (canvas.width !== width || canvas.height !== height) {
              canvas.width = width;
              canvas.height = height;
            }
            ctx.drawImage(frame, 0, 0, width, height);
            framesThisSecond += 1;
            totalFrames += 1;
            lastFrameAt = performance.now();
            if (totalFrames === 1) {
              everLive = true;
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

    const teardownSocket = (s: WebSocket | null) => {
      if (!s) return;
      s.onopen = null;
      s.onmessage = null;
      s.onerror = null;
      s.onclose = null;
      try { s.close(); } catch { /* already closed */ }
    };

    const scheduleReconnect = (why: string) => {
      if (closed || reconnectTimer) return;
      reconnectAttempts += 1;
      const delay = Math.min(5000, 800 * reconnectAttempts);
      logLine(`recovering (${why}) — retrying in ${delay}ms (attempt ${reconnectAttempts})`);
      patch({ state: 'connecting' });
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (closed) return;
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

    const connect = () => {
      teardownSocket(socket);
      socket = null;
      loggedPreConfig = false;
      const url = wsUrl();
      logLine(`connecting WebSocket -> ${url}`);
      socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      patch({ state: 'connecting', stream, error: null });

      socket.onopen = () => {
        reconnectAttempts = 0;
        lastFrameAt = performance.now(); // fresh grace window; don't trip the watchdog instantly
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

        // When the VJ tab is hidden the output loop is parked; don't burn the
        // HW decoder. Drop data packets and re-sync on a keyframe when visible.
        if (packetType === 1 && typeof document !== 'undefined' && document.hidden) {
          waitingForKeyframe = true;
          return;
        }

        if (packetType === 0) {
          // The streamer re-sends config before EVERY keyframe so late joiners can
          // configure. Only (re)build the decoder when the config actually changes —
          // otherwise we'd tear the decoder down ~once a second and stutter.
          const next = new Uint8Array(data);
          const prev = configBytes;
          const changed = !prev || prev.length !== next.length || !next.every((b, i) => b === prev[i]);
          configBytes = next;
          if (!configured || changed) {
            logLine(`config packet (${next.byteLength}B) received${configured ? ' (changed -> reconfigure)' : ''}`);
            configureDecoder(h264CodecFromAnnexB(next) ?? 'avc1.42E01E');
          }
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

    const boot = async () => {
      patch({ state: 'starting', stream, error: null });
      const base = backendBase();
      logLine(`backend base = ${base}`);
      // Start (idempotent): ensures the TCP listener + adb reverse are up.
      try {
        const r = await fetch(`${base}/api/queststitch/start`, { method: 'POST' });
        const body = await r.json().catch(() => ({}));
        logLine(`start -> HTTP ${r.status} adb_reverse_ok=${body?.adb_reverse_ok ?? '?'} quest=${body?.quest_connected ?? '?'}`);
      } catch (err) {
        logLine(`could not reach backend to start the relay: ${err instanceof Error ? err.message : String(err)}`);
        scheduleReconnect('backend unreachable');
        return;
      }
      connect();
    };

    // Watchdog: when the feed is visible but frames stop arriving, recover.
    const STALL_MS = 5000;
    watchdog = setInterval(() => {
      if (closed || (typeof document !== 'undefined' && document.hidden)) return;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      // Open WS but never live yet = idle waiting for the Quest to start pushing;
      // the same socket will deliver frames the moment it does, so don't reconnect.
      if (!everLive) return;
      if (performance.now() - lastFrameAt > STALL_MS) {
        logLine('feed stalled (no frames for 5s), recovering');
        scheduleReconnect('stall');
      }
    }, 2000);

    const onVisible = () => {
      if (closed || document.hidden) return;
      // Only recover a feed that was actually live; if it never started, the open
      // socket is already waiting and will deliver whenever the Quest connects.
      if (everLive && performance.now() - lastFrameAt > 3000) {
        logLine('tab visible again, refreshing the Quest stitch feed');
        scheduleReconnect('wake');
      }
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisible);
    }

    void boot();

    return () => {
      closed = true;
      logLine('QUEST STITCH source disabled, tearing down WebSocket + decoder');
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
