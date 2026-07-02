import { useEffect, useMemo, useRef, useState } from 'react';
import { ShaderRenderer, type ShaderLevels } from './shader/ShaderRenderer';
import { SHADER_PRESETS, type ShaderParamConfig } from './shader/shaderPresets';

/**
 * Generic GLSL shader visual as a VJ source. Renders a fullscreen atzedent-style
 * fragment shader (yotta seeds the library) to an offscreen WebGL2 canvas driven
 * by the VJ's live audio, then `captureStream()`s it into a MediaStream so the
 * existing camera pipeline (LIVE<->CLIP blend + all effects) can mix it like any
 * other source.
 *
 * A FRESH canvas is created on each enable: disposing the renderer loses the WebGL
 * context, and a canvas only ever yields its first context, so reusing one would
 * hand a re-enable a dead context. Shader / audio-drive / param switches reuse the
 * live program (no canvas churn); only a fragment-source swap recompiles.
 */
export function useShader(
  enabled: boolean,
  getLevels: () => ShaderLevels,
  shaderId: string,
  audioDrive: number,
  params: ShaderParamConfig[],
  material: number,
): { stream: MediaStream | null } {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const rendererRef = useRef<ShaderRenderer | null>(null);
  const getLevelsRef = useRef(getLevels);
  getLevelsRef.current = getLevels;
  const shaderIdRef = useRef(shaderId);
  shaderIdRef.current = shaderId;
  const audioDriveRef = useRef(audioDrive);
  audioDriveRef.current = audioDrive;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const materialRef = useRef(material);
  materialRef.current = material;

  // Stable key so the param effect only fires on a real value/band change.
  const paramsKey = useMemo(() => JSON.stringify(params), [params]);

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
        params: paramsRef.current,
        material: materialRef.current,
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

  // Source swap: recompile and rebind this preset's params in one call.
  useEffect(() => {
    const preset = SHADER_PRESETS.find((p) => p.id === shaderId) ?? SHADER_PRESETS[0];
    rendererRef.current?.setSource(preset.source, paramsRef.current);
  }, [shaderId]);

  // Slider / audio-band tweaks on the current shader (no recompile).
  useEffect(() => {
    rendererRef.current?.setParams(paramsRef.current);
    // paramsKey is the serialized params; paramsRef holds the live array.
  }, [paramsKey]);

  useEffect(() => {
    rendererRef.current?.setAudioDrive(audioDrive);
  }, [audioDrive]);

  useEffect(() => {
    rendererRef.current?.setMaterial(material);
  }, [material]);

  return { stream };
}
