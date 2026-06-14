import { useState, useEffect, useRef } from 'react';

/**
 * Turn a getUserMedia DOMException into a plain-language instruction the user
 * can act on, instead of surfacing the raw "Permission denied" / "Requested
 * device not found" text. Keyed on the spec error names, which are stable
 * across browsers (the human-readable .message is not).
 */
function describeCameraError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
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

export function useMedia(sourceType: 'camera' | 'clip', clipUrl: string | null) {
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const clipVideoRef = useRef<HTMLVideoElement>(null);
  const activeVideoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const streamRef = useRef<MediaStream | null>(null);

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
            if (active) setError('Video Decode Failure: ' + (e?.message ?? String(e)));
          });
      } else {
          memVideo.onerror = null;
          memVideo.src = '';
      }

      // Camera boot / reuse sequence (kept alive even when MEM selected).
      camVideo.onerror = null;
      if (streamRef.current) {
        // Reuse the existing camera pipe. Verify the tracks haven't
        // been silently stopped (some browsers end tracks after
        // permission revoke / device disconnect). If any track is
        // 'ended', drop the cached stream and re-request below.
        const tracks = streamRef.current.getTracks();
        const stale = tracks.some((t) => t.readyState === 'ended');
        if (!stale) {
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
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: true
        });
        if (!active) {
          stream.getTracks().forEach(t => t.stop());
          return;
        }
        streamRef.current = stream;
        camVideo.srcObject = stream;
        camVideo.play().catch(e => {
          if (active) setError(e.message);
        });
        if (active) setError(null);
      } catch (err: any) {
        if (active) setError(describeCameraError(err));
      } finally {
        if (active) setIsInitializing(false);
      }
    };

    setupSource();

    return () => {
      active = false;
    };
  }, [sourceType, clipUrl]);

  useEffect(() => {
    activeVideoRef.current = sourceType === 'clip' ? clipVideoRef.current : cameraVideoRef.current;
  }, [sourceType]);

  return { videoRef: activeVideoRef, cameraVideoRef, clipVideoRef, error, isInitializing };
}
