import { useState, useEffect, useRef } from 'react';

/**
 * A play() promise rejected because the element was paused / swapped mid-load
 * is NOT a failure — it's the normal outcome of a quick source switch. These
 * AbortErrors must never surface as an on-screen error.
 */
function isBenignPlayInterruption(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? '';
  const msg = String((e as { message?: string })?.message ?? e ?? '').toLowerCase();
  return (
    name === 'AbortError' ||
    msg.includes('interrupted by a call to pause') ||
    msg.includes('request was interrupted') ||
    msg.includes('media was removed from the document')
  );
}

/**
 * Turn a getUserMedia / getDisplayMedia DOMException into a plain-language
 * instruction the user can act on, instead of surfacing the raw "Permission
 * denied" / "Requested device not found" text. Keyed on the spec error names,
 * which are stable across browsers (the human-readable .message is not).
 */
function describeMediaError(err: unknown, mode: 'device' | 'screen'): string {
  const name = (err as { name?: string })?.name ?? '';
  if (mode === 'screen') {
    switch (name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Screen share was cancelled or blocked — click SCREEN again and pick a window or display.';
      case 'NotFoundError':
        return 'No screen or window was available to capture.';
      case 'NotReadableError':
        return 'The selected window/display could not be captured — try another one.';
      default: {
        const msg = (err as { message?: string })?.message;
        return msg ? `Screen capture unavailable: ${msg}` : 'Could not capture the screen.';
      }
    }
  }
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Give the browser access to your camera in the site permissions, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera found — plug one in (or pick a different device) and try again.';
    case 'NotReadableError':
      return 'The camera is in use by another app — close it and try again.';
    default: {
      const msg = (err as { message?: string })?.message;
      return msg ? `Camera unavailable: ${msg}` : 'Could not access a camera.';
    }
  }
}

export function useMedia(
  sourceType: 'camera' | 'clip',
  clipUrl: string | null,
  cameraSource: 'device' | 'screen' | 'quest' | 'cymatics' = 'device',
  cameraDeviceId?: string | null,
  cameraReinit = 0,
  /** Live MediaStream for the direct Quest source (canvas-captured WebCodecs
   *  feed from useQuestCast). Null until the relay is ready. Owned by the
   *  caller — we bind it but never stop its tracks. */
  questStream: MediaStream | null = null,
  /** Live MediaStream for the Cymatics generative source (canvas-captured
   *  Three.js feed from useCymatics). Caller-owned, same binding contract. */
  cymaticsStream: MediaStream | null = null,
) {
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const clipVideoRef = useRef<HTMLVideoElement>(null);
  const activeVideoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const streamRef = useRef<MediaStream | null>(null);
  // Identifies which live stream is cached so a source/device/re-pick change
  // forces a fresh request instead of reusing the wrong stream.
  const streamKeyRef = useRef<string>('');

  useEffect(() => {
    let active = true;

    const setupSource = async () => {
      const camVideo = cameraVideoRef.current;
      const memVideo = clipVideoRef.current;
      if (!camVideo || !memVideo) return;

      activeVideoRef.current = sourceType === 'clip' ? memVideo : camVideo;

      // Keep memory clip loaded independently so CAM/MEM crossfade can
      // blend both sources live instead of hard switching.
      if (clipUrl) {
          memVideo.src = clipUrl;
          memVideo.loop = true;
          // Restored from upstream commit cedc007 — the 2f734dc
          // refactor dropped this and broke clip playback after the
          // first decode error (blob expired, codec mismatch, etc).
          // Without onerror the failure propagates uncaught and the
          // render loop's `if (!video.videoWidth)` guard wedges the
          // canvas on the last good frame — looks like "works then
          // fails." Surfacing the error here lets the renderer stay
          // alive and the user retry / pick another clip.
          const onErr = () => {
            if (!active) return;
            const code = memVideo.error?.code;
            const msg = memVideo.error?.message || `MediaError code ${code ?? '?'}`;
            setError(`Video Decode Failure: ${msg}`);
          };
          memVideo.onerror = onErr;
          memVideo.play().catch((e) => {
            // Ignore benign play/pause races (AbortError) — they're not failures.
            if (active && !isBenignPlayInterruption(e)) {
              setError('Video Decode Failure: ' + (e?.message ?? String(e)));
            }
          });
      } else {
          memVideo.onerror = null;
          memVideo.src = '';
      }

      // Generative sources (Quest relay / Cymatics): bind the caller-owned
      // canvas-captured stream. We don't own these (useQuestCast / useCymatics
      // do), so we never stop their tracks here.
      if (cameraSource === 'quest' || cameraSource === 'cymatics') {
        const genStream = cameraSource === 'quest' ? questStream : cymaticsStream;
        // Drop any live getUserMedia/getDisplayMedia pipe we still hold.
        if (streamRef.current) {
          streamRef.current.getTracks().forEach((t) => t.stop());
          streamRef.current = null;
          streamKeyRef.current = '';
        }
        if (!genStream) {
          // Source not ready yet — show initializing, retry when it lands.
          camVideo.srcObject = null;
          if (active) {
            setError(null);
            setIsInitializing(true);
          }
          return;
        }
        if (camVideo.srcObject !== genStream) {
          const t = genStream.getVideoTracks()[0];
          // eslint-disable-next-line no-console
          console.info(`[${cameraSource}] useMedia: binding stream to camVideo —`,
            t ? `track state=${t.readyState} enabled=${t.enabled}` : 'NO video track');
          camVideo.srcObject = genStream;
          camVideo.play()
            .then(() => console.info(`[${cameraSource}] useMedia: camVideo.play() ok`))
            .catch((e) => {
              console.warn(`[${cameraSource}] useMedia: camVideo.play() failed —`, e?.message ?? e);
              if (active && !isBenignPlayInterruption(e)) setError(e?.message ?? String(e));
            });
        }
        if (active) {
          setError(null);
          setIsInitializing(false);
        }
        return;
      }

      // Camera boot / reuse sequence (kept alive even when MEM selected).
      // The "want key" captures the requested live source so a switch between
      // a capture device and screen-grab (or a re-pick) drops the old stream.
      camVideo.onerror = null;
      const wantKey = `${cameraSource}:${cameraDeviceId ?? ''}:${cameraReinit}`;
      if (streamRef.current) {
        const tracks = streamRef.current.getTracks();
        const stale = tracks.some((t) => t.readyState === 'ended');
        // Reuse the existing pipe ONLY when it's the same source and still
        // live. Otherwise stop it and request the new one below.
        if (!stale && streamKeyRef.current === wantKey) {
          camVideo.srcObject = streamRef.current;
          camVideo.play().catch(e => console.error("Play err:", e));
          if (active) setIsInitializing(false);
          return;
        }
        tracks.forEach((t) => t.stop());
        streamRef.current = null;
      }

      try {
        if (active) setIsInitializing(true);
        let stream: MediaStream;
        if (cameraSource === 'screen') {
          // Screen/window capture — how a scrcpy-mirrored Quest (or any
          // window / capture card) is piped in. MUST be reached from a user
          // gesture; the in-iframe SCREEN button provides it. Needs the host
          // iframe to allow "display-capture".
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: 60 } },
            audio: false,
          });
        } else {
          stream = await navigator.mediaDevices.getUserMedia({
            video: cameraDeviceId
              ? { deviceId: { exact: cameraDeviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
              : { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
            audio: true,
          });
        }
        if (!active) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        streamRef.current = stream;
        streamKeyRef.current = wantKey;
        // When the user ends a screen share via the browser's own "Stop
        // sharing" UI, drop the cached stream so the next SCREEN click
        // re-opens the picker instead of reusing a dead stream.
        const primary = stream.getVideoTracks()[0];
        if (primary) {
          primary.addEventListener('ended', () => {
            if (streamRef.current === stream) {
              streamRef.current = null;
              streamKeyRef.current = '';
            }
          });
        }
        camVideo.srcObject = stream;
        camVideo.play().catch(e => {
          if (active && !isBenignPlayInterruption(e)) setError(e.message);
        });
        if (active) setError(null);
      } catch (err: any) {
        if (active) setError(describeMediaError(err, cameraSource));
      } finally {
        if (active) setIsInitializing(false);
      }
    };

    setupSource();

    return () => {
      active = false;
    };
  }, [sourceType, clipUrl, cameraSource, cameraDeviceId, cameraReinit, questStream, cymaticsStream]);

  useEffect(() => {
    activeVideoRef.current = sourceType === 'clip' ? clipVideoRef.current : cameraVideoRef.current;
  }, [sourceType]);

  return { videoRef: activeVideoRef, cameraVideoRef, clipVideoRef, error, isInitializing };
}
