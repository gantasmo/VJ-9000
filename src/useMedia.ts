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
          video.play().catch(e => {
            if (active) setError("Video Decode Failure: " + e.message);
          });
          if (active) {
            setError(null);
            setIsInitializing(false);
          }
        } else {
          video.src = '';
          if (active) {
            setError(null);
            setIsInitializing(false);
          }
        }
        return;
      }

      // Camera Boot Sequence
      video.src = '';
      if (streamRef.current) {
        // Keep existing pipe running
        video.srcObject = streamRef.current;
        video.play().catch(e => console.error("Play err:", e));
        if (active) setIsInitializing(false);
        return;
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
