import React, { useRef } from 'react';

/**
 * A thin drag-divider for the 3-column VJ shell. Dependency-free: it captures the
 * pointer and reports the per-move pixel delta; the parent clamps and writes the
 * size into VJState (so column widths / strip height are real layout-data, which
 * is exactly what the future Layout Editor port consumes).
 *
 * orientation 'vertical' = a vertical bar dragged on X (resizes a column width).
 * orientation 'horizontal' = a horizontal bar dragged on Y (resizes a strip height).
 */
interface Props {
  orientation: 'vertical' | 'horizontal';
  onDrag: (deltaPx: number) => void;
  title?: string;
}

export const ResizeHandle: React.FC<Props> = ({ orientation, onDrag, title }) => {
  const last = useRef(0);
  const dragging = useRef(false);

  const onPointerDown = (e: React.PointerEvent): void => {
    dragging.current = true;
    last.current = orientation === 'vertical' ? e.clientX : e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!dragging.current) return;
    const cur = orientation === 'vertical' ? e.clientX : e.clientY;
    const d = cur - last.current;
    if (d !== 0) {
      onDrag(d);
      last.current = cur;
    }
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    dragging.current = false;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  const base =
    orientation === 'vertical'
      ? 'w-1 h-full cursor-col-resize'
      : 'h-1 w-full cursor-row-resize';

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={title ?? 'Resize'}
      title={title ?? 'Drag to resize'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className={`${base} shrink-0 bg-zinc-800 hover:bg-cyan-500/60 active:bg-cyan-400 transition-colors touch-none`}
    />
  );
};
