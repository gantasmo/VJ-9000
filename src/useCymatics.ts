import { useEffect, useRef, useState } from 'react';
import { CymaticsRenderer, type CymaticsMode, type CymaticsLevels } from './cymatics/CymaticsRenderer';

/**
 * Cymatics visual as a VJ source. Renders theDAW's reflective black-chrome
 * cymatics modes to an offscreen Three.js canvas driven by the VJ's live audio
 * levels, then `captureStream()`s it into a MediaStream so the existing camera
 * pipeline (and the CAM↔MEM crossfader + all effects) can mix it like any other
 * source.
 *
 * A FRESH canvas is created on each enable: disposing the renderer force-loses
 * the WebGL context, and a canvas only ever yields its first context, so reusing
 * one would hand a re-enable a dead context.
 */
export function useCymatics(
  enabled: boolean,
  mode: CymaticsMode,
  getLevels: () => CymaticsLevels,
): { stream: MediaStream | null } {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const rendererRef = useRef<CymaticsRenderer | null>(null);
  const getLevelsRef = useRef(getLevels);
  getLevelsRef.current = getLevels;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    if (!enabled) {
      setStream(null);
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    let renderer: CymaticsRenderer | null = null;
    try {
      renderer = new CymaticsRenderer(canvas, () => getLevelsRef.current(), { mode: modeRef.current });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[cymatics] renderer init failed', e);
      return;
    }
    rendererRef.current = renderer;
    let captured: MediaStream | null = null;
    if (typeof canvas.captureStream === 'function') {
      captured = canvas.captureStream(30);
    }
    setStream(captured);
    return () => {
      renderer?.dispose();
      rendererRef.current = null;
      captured?.getTracks().forEach((t) => t.stop());
      setStream(null);
    };
  }, [enabled]);

  // Mode switches reuse the live scene (no rebuild / context churn).
  useEffect(() => {
    rendererRef.current?.setMode(mode);
  }, [mode]);

  return { stream };
}
