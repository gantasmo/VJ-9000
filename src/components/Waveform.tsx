import React, { useEffect, useRef } from 'react';

/**
 * Top-of-layout audio scope. Inside the VJ app the only audio signal available
 * is the bridge's band levels (bass/mid/high/volume) — the full PCM waveform of
 * the playing track lives in the SA3 host — so this renders a live scrolling
 * level scope, colored by band, rather than a literal PCM waveform. Parks when
 * the tab is hidden.
 */
export const Waveform: React.FC<{
  getAudioLevels: () => { bass: number; mid: number; high: number; volume: number };
}> = ({ getAudioLevels }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(r.width));
      canvas.height = Math.max(1, Math.floor(r.height));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (typeof document !== 'undefined' && document.hidden) return;
      const w = canvas.width;
      const h = canvas.height;
      if (w < 2) return;
      // Scroll the existing image 1px left, then draw the newest column at right.
      const prev = ctx.getImageData(1, 0, w - 1, h);
      ctx.putImageData(prev, 0, 0);
      ctx.fillStyle = '#07070b';
      ctx.fillRect(w - 1, 0, 1, h);

      const { bass, mid, high, volume } = getAudioLevels();
      const v = Math.min(1, volume * 1.6);
      const half = (v * h) / 2;
      const r = Math.min(255, Math.round(bass * 420));
      const g = Math.min(255, Math.round(mid * 420));
      const b = Math.min(255, Math.round(high * 420));
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(w - 1, h / 2 - half, 1, half * 2);
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [getAudioLevels]);

  return <canvas ref={canvasRef} className="block w-full h-full" />;
};
