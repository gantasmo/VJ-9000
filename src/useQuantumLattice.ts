import { useEffect, useRef, useState } from 'react';
import {
  QuantumLatticeEngine,
  type QuantumLevels,
  type QuantumParamConfig,
} from './quantum/QuantumLatticeEngine';

/**
 * Quantum Lattice visual as a VJ source. Renders the morphing sacred-geometry
 * lattice (Torus / Cube / Star / Cage) to an offscreen Three.js canvas driven by
 * the VJ's live audio levels, then `captureStream()`s it into a MediaStream so
 * the existing camera pipeline (CAM↔MEM crossfader + all effects) can mix it like
 * any other source. Shape, palette, master audio drive and the full per-param
 * config (with per-param audio bands) are live-updatable.
 *
 * A FRESH canvas is created on each enable: disposing the engine force-loses the
 * WebGL context, and a canvas only ever yields its first context, so reusing one
 * would hand a re-enable a dead context. Capture is pinned at 720p (pixelRatio 1).
 */
export function useQuantumLattice(
  enabled: boolean,
  shape: number,
  getLevels: () => QuantumLevels,
  params: QuantumParamConfig[],
  paletteIdx: number,
  audioDrive: number,
): { stream: MediaStream | null } {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const engineRef = useRef<QuantumLatticeEngine | null>(null);
  const getLevelsRef = useRef(getLevels);
  getLevelsRef.current = getLevels;
  const shapeRef = useRef(shape);
  shapeRef.current = shape;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const paletteRef = useRef(paletteIdx);
  paletteRef.current = paletteIdx;
  const driveRef = useRef(audioDrive);
  driveRef.current = audioDrive;

  useEffect(() => {
    if (!enabled) {
      setStream(null);
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    let engine: QuantumLatticeEngine | null = null;
    try {
      engine = new QuantumLatticeEngine({
        canvas,
        width: 1280,
        height: 720,
        pixelRatio: 1,
        interactive: false,
        getLevels: () => getLevelsRef.current(),
      });
      engine.setShape(shapeRef.current);
      engine.setParams(paramsRef.current);
      engine.setPaletteIndex(paletteRef.current < 0 ? null : paletteRef.current);
      engine.setAudioDrive(driveRef.current);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[quantum] engine init failed', e);
      return;
    }
    engineRef.current = engine;
    let captured: MediaStream | null = null;
    if (typeof canvas.captureStream === 'function') {
      captured = canvas.captureStream(30);
    }
    setStream(captured);
    return () => {
      engine?.dispose();
      engineRef.current = null;
      captured?.getTracks().forEach((t) => t.stop());
      setStream(null);
    };
  }, [enabled]);

  // Live updates reuse the running scene (no rebuild / context churn).
  useEffect(() => { engineRef.current?.setShape(shape); }, [shape]);
  useEffect(() => { engineRef.current?.setParams(params); }, [params]);
  useEffect(() => { engineRef.current?.setPaletteIndex(paletteIdx < 0 ? null : paletteIdx); }, [paletteIdx]);
  useEffect(() => { engineRef.current?.setAudioDrive(audioDrive); }, [audioDrive]);

  return { stream };
}
