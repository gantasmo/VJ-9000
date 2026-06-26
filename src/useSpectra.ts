import { useEffect, useRef, useState } from 'react';
import { SpectraRenderer, type SpectraMode, type SpectraSettings, type SpectraLevels } from './spectra/SpectraRenderer';

/**
 * SPECTRA-RIDER as a VJ source. Renders the 3D audio spectrogram-terrain to an
 * offscreen Three.js canvas driven by the VJ's live audio (a 128-bin spectrum
 * when available, else the 4 bands), then captureStream()s it into a MediaStream
 * so the existing camera pipeline (CAM<->MEM crossfader + all effects) can mix it
 * like any other source.
 *
 * A FRESH canvas is created on each enable: disposing the renderer force-loses the
 * WebGL context, and a canvas only ever yields its first context, so reusing one
 * would hand a re-enable a dead context. Mode/theme/settings switches reuse the
 * live scene (no rebuild / context churn).
 */
export function useSpectra(
  enabled: boolean,
  getSpectrum: () => Uint8Array | null,
  getLevels: () => SpectraLevels,
  mode: SpectraMode,
  theme: string,
  settings: SpectraSettings,
  autoRotate: boolean,
): { stream: MediaStream | null } {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const rendererRef = useRef<SpectraRenderer | null>(null);
  const getSpectrumRef = useRef(getSpectrum);
  getSpectrumRef.current = getSpectrum;
  const getLevelsRef = useRef(getLevels);
  getLevelsRef.current = getLevels;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const autoRotateRef = useRef(autoRotate);
  autoRotateRef.current = autoRotate;

  useEffect(() => {
    if (!enabled) {
      setStream(null);
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    let renderer: SpectraRenderer | null = null;
    try {
      renderer = new SpectraRenderer(
        canvas,
        () => getSpectrumRef.current(),
        () => getLevelsRef.current(),
        { mode: modeRef.current, theme: themeRef.current, settings: settingsRef.current, autoRotate: autoRotateRef.current },
      );
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[spectra] renderer init failed', e);
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

  useEffect(() => {
    rendererRef.current?.setMode(mode);
  }, [mode]);
  useEffect(() => {
    rendererRef.current?.setTheme(theme);
  }, [theme]);
  useEffect(() => {
    rendererRef.current?.setSettings(settings);
  }, [settings]);
  useEffect(() => {
    rendererRef.current?.setAutoRotate(autoRotate);
  }, [autoRotate]);

  return { stream };
}
