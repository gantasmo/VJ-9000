import { useEffect, useRef, useState } from 'react';
import { AsciilineRenderer, type AsciiLevels, type AsciiSettings } from './asciiline/AsciilineRenderer';

/**
 * ASCII visual as a VJ source. Turns the upstream frame (the loaded clip, else the
 * webcam) into a live GPU ASCII render and `captureStream()`s it into a MediaStream
 * so the existing camera pipeline (CAM<->MEM crossfader + all effects) can mix it
 * like any other source.
 *
 * Like the depthcloud source, this owns a hidden <video> for the input frame; the
 * renderer downscales it to the cell grid each frame and maps glyphs on the GPU.
 * A FRESH canvas is created on each enable so a re-enable never gets a dead WebGL
 * context. Settings changes reuse the live renderer.
 */
export function useAsciiline(
  enabled: boolean,
  getLevels: () => AsciiLevels,
  clipUrl: string | null,
  settings: AsciiSettings,
): { stream: MediaStream | null } {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const rendererRef = useRef<AsciilineRenderer | null>(null);
  const getLevelsRef = useRef(getLevels);
  getLevelsRef.current = getLevels;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  useEffect(() => {
    if (!enabled) {
      setStream(null);
      return;
    }
    let closed = false;
    let camStream: MediaStream | null = null;
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;

    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;

    let renderer: AsciilineRenderer | null = null;
    try {
      renderer = new AsciilineRenderer(canvas, () => video, () => getLevelsRef.current(), {
        settings: settingsRef.current,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[asciiline] renderer init failed', e);
      return;
    }
    rendererRef.current = renderer;

    let captured: MediaStream | null = null;
    if (typeof canvas.captureStream === 'function') {
      captured = canvas.captureStream(30);
    }
    setStream(captured);

    const startInput = async () => {
      try {
        if (clipUrl) {
          if (!clipUrl.startsWith('blob:')) video.crossOrigin = 'anonymous';
          video.src = clipUrl;
        } else {
          camStream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
          if (closed) {
            camStream.getTracks().forEach((t) => t.stop());
            return;
          }
          video.srcObject = camStream;
        }
        await video.play().catch(() => {});
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[asciiline] could not open source', e);
      }
    };
    void startInput();

    return () => {
      closed = true;
      renderer?.dispose();
      rendererRef.current = null;
      camStream?.getTracks().forEach((t) => t.stop());
      try {
        video.pause();
        video.removeAttribute('src');
        video.srcObject = null;
        video.load();
      } catch {
        /* ignore */
      }
      captured?.getTracks().forEach((t) => t.stop());
      setStream(null);
    };
  }, [enabled, clipUrl]);

  useEffect(() => {
    rendererRef.current?.setSettings(settings);
  }, [settings]);

  return { stream };
}
