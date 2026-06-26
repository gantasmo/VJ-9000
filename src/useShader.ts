import { useEffect, useRef, useState } from 'react';
import { ShaderRenderer, type ShaderLevels } from './shader/ShaderRenderer';
import { SHADER_PRESETS } from './shader/shaderPresets';

/**
 * Generic GLSL shader visual as a VJ source. Renders a fullscreen atzedent-style
 * fragment shader (yotta seeds the library) to an offscreen WebGL2 canvas driven
 * by the VJ's live audio, then `captureStream()`s it into a MediaStream so the
 * existing camera pipeline (CAM<->MEM crossfader + all effects) can mix it like
 * any other source.
 *
 * A FRESH canvas is created on each enable: disposing the renderer loses the WebGL
 * context, and a canvas only ever yields its first context, so reusing one would
 * hand a re-enable a dead context. Shader/audio-drive switches reuse the live
 * program (no canvas churn).
 */
export function useShader(
  enabled: boolean,
  getLevels: () => ShaderLevels,
  shaderId: string,
  audioDrive: number,
): { stream: MediaStream | null } {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const rendererRef = useRef<ShaderRenderer | null>(null);
  const getLevelsRef = useRef(getLevels);
  getLevelsRef.current = getLevels;
  const shaderIdRef = useRef(shaderId);
  shaderIdRef.current = shaderId;
  const audioDriveRef = useRef(audioDrive);
  audioDriveRef.current = audioDrive;

  useEffect(() => {
    if (!enabled) {
      setStream(null);
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const preset = SHADER_PRESETS.find((p) => p.id === shaderIdRef.current) ?? SHADER_PRESETS[0];
    let renderer: ShaderRenderer | null = null;
    try {
      renderer = new ShaderRenderer(canvas, () => getLevelsRef.current(), {
        source: preset.source,
        audioDrive: audioDriveRef.current,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[shader] renderer init failed', e);
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
    const preset = SHADER_PRESETS.find((p) => p.id === shaderId) ?? SHADER_PRESETS[0];
    rendererRef.current?.setSource(preset.source);
  }, [shaderId]);

  useEffect(() => {
    rendererRef.current?.setAudioDrive(audioDrive);
  }, [audioDrive]);

  return { stream };
}
