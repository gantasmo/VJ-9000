import React, { useEffect, useRef } from 'react';

/**
 * Right-panel source monitor. Binds an ALREADY-DECODED MediaStream (the Quest
 * or Cymatics canvas-capture from useQuestCast / useCymatics) to a <video> —
 * no second WebSocket/decoder, so showing the preview is essentially free.
 */
export const SourcePreview: React.FC<{ stream: MediaStream | null; label: string }> = ({ stream, label }) => {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (v.srcObject !== stream) {
      v.srcObject = stream;
      if (stream) v.play().catch(() => { /* autoplay of a muted MediaStream rarely fails */ });
    }
  }, [stream]);
  return (
    <div className="relative shrink-0 bg-black aspect-video border-b border-zinc-800">
      <video ref={ref} muted playsInline className="absolute inset-0 w-full h-full object-contain" />
      <span className="absolute top-1 left-1 px-1 rounded bg-black/60 text-[8px] font-mono uppercase tracking-widest text-cyan-300">
        {label}
      </span>
    </div>
  );
};
