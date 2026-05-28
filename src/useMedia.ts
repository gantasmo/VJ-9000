import { useState, useEffect, useRef } from 'react';

export function useMedia(sourceType: 'camera' | 'clip', clipUrl: string | null) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let active = true;

    const setupSource = async () => {
      const video = videoRef.current;
      if (!video) return;

      if (sourceType === 'clip') {
        // Halt camera feed memory leak
        if (streamRef.current) {
          streamRef.current.getTracks().forEach(t => t.stop());
          streamRef.current = null;
        }
        video.srcObject = null;
        
        if (clipUrl) {
          video.src = clipUrl;
          video.loop = true;
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
            const code = video.error?.code;
            const msg = video.error?.message || `MediaError code ${code ?? '?'}`;
            setError(`Video Decode Failure: ${msg}`);
          };
          video.onerror = onErr;
          video.play().catch((e) => {
            if (active) setError('Video Decode Failure: ' + (e?.message ?? String(e)));
          });
          if (active) {
            // Clear any prior error optimistically; onerror above will
            // set it again if the new clip is broken.
            setError(null);
            setIsInitializing(false);
          }
        } else {
          video.onerror = null;
          video.src = '';
          if (active) {
            setError(null);
            setIsInitializing(false);
          }
        }
        return;
      }

      // Camera Boot Sequence
      video.onerror = null;
      video.src = '';
      if (streamRef.current) {
        // Reuse the existing camera pipe. Verify the tracks haven't
        // been silently stopped (some browsers end tracks after
        // permission revoke / device disconnect). If any track is
        // 'ended', drop the cached stream and re-request below.
        const tracks = streamRef.current.getTracks();
        const stale = tracks.some((t) => t.readyState === 'ended');
        if (!stale) {
          video.srcObject = streamRef.current;
          video.play().catch(e => console.error("Play err:", e));
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
        video.srcObject = stream;
        video.play().catch(e => {
          if (active) setError(e.message);
        });
        if (active) setError(null);
      } catch (err: any) {
        if (active) setError(err.message || 'Failed to acquire optical hardware.');
      } finally {
        if (active) setIsInitializing(false);
      }
    };

    setupSource();

    return () => {
      active = false;
    };
  }, [sourceType, clipUrl]);

  return { videoRef, error, isInitializing };
}
