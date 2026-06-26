import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Minus, Upload, Music, X, ChevronUp, ChevronDown } from 'lucide-react';
import { VJState } from '../types';
import type { PoolItem } from '../useLibraryPool';
import { POOL_DND_TYPE } from './LibraryPool';

/** DnD type for reordering an already-staged clip between bank slots. */
const CLIP_MOVE_DND_TYPE = 'application/x-vj-clip-move';

/**
 * Resolume-style clip grid, the headline of the standard VJ layout.
 *
 * Banks = ROWS. Each horizontal row is one bank (B1, B2, ...) stacked top to
 * bottom; the flat `videoBucket` fills row by row, `gridCols` clips per bank.
 * A trailing empty "+" bank is always shown to import a fresh row into.
 *
 * Navigation matches a VJ deck: a plain mouse wheel scrolls the stack up/down
 * (through banks), and Ctrl/Shift+wheel scrolls a wide row left/right. Cells
 * are fixed squares (icon size is independent of clip length). Clicking a clip
 * loads it live (MEM source); clicking an empty slot imports.
 */

interface ClipGridProps {
  state: VJState;
  updateState: (updates: Partial<VJState>) => void;
  /** Wired to App.handleFiles so imports append to the shared bucket. */
  onFiles: (files: FileList) => void;
  /** Stage a pool item dropped on the grid background (append). */
  onStagePoolItem?: (item: PoolItem) => void;
  /** Stage a pool item dropped on a specific cell (exact slot). */
  onStagePoolItemAt?: (item: PoolItem, index: number) => void;
  /** Reorder an already-staged clip to a specific slot. */
  onMoveClipToIndex?: (clipId: string, index: number) => void;
}

function ClipGridImpl({
  state,
  updateState,
  onFiles,
  onStagePoolItem,
  onStagePoolItemAt,
  onMoveClipToIndex,
}: ClipGridProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [poolDragOver, setPoolDragOver] = useState(false);
  // Cell index currently hovered by a drag, for the drop highlight.
  const [dropCell, setDropCell] = useState<number | null>(null);

  const dragHasClip = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(POOL_DND_TYPE) || e.dataTransfer.types.includes(CLIP_MOVE_DND_TYPE);

  // Background drop (on padding/gaps) appends a pool item.
  const onPoolDragOver = (e: React.DragEvent) => {
    if (!dragHasClip(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!poolDragOver) setPoolDragOver(true);
  };
  const onPoolDrop = (e: React.DragEvent) => {
    setPoolDragOver(false);
    const raw = e.dataTransfer.getData(POOL_DND_TYPE);
    if (raw && onStagePoolItem) {
      e.preventDefault();
      try {
        onStagePoolItem(JSON.parse(raw) as PoolItem);
      } catch {
        /* malformed payload, ignore */
      }
    }
  };

  // Per-cell drop (exact slot). `flat` is the cell's flat index (bank*cols + i).
  const onCellDragOver = (flat: number) => (e: React.DragEvent) => {
    if (!dragHasClip(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (dropCell !== flat) setDropCell(flat);
  };
  const onCellDrop = (flat: number) => (e: React.DragEvent) => {
    if (!dragHasClip(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropCell(null);
    setPoolDragOver(false);
    const poolRaw = e.dataTransfer.getData(POOL_DND_TYPE);
    if (poolRaw && onStagePoolItemAt) {
      try {
        onStagePoolItemAt(JSON.parse(poolRaw) as PoolItem, flat);
      } catch {
        /* malformed payload, ignore */
      }
      return;
    }
    const clipId = e.dataTransfer.getData(CLIP_MOVE_DND_TYPE);
    if (clipId && onMoveClipToIndex) onMoveClipToIndex(clipId, flat);
  };
  const onClipDragStart = (clipId: string) => (e: React.DragEvent) => {
    e.dataTransfer.setData(CLIP_MOVE_DND_TYPE, clipId);
    e.dataTransfer.effectAllowed = 'move';
  };

  const cols = Math.max(1, Math.min(20, state.gridCols ?? 10));
  const minBanks = Math.max(1, Math.min(12, state.gridRows ?? 2));

  const clips = state.videoBucket ?? [];
  // Banks derive from the bucket: enough rows to hold every clip, never fewer
  // than the requested minimum. One extra empty bank is always appended as the
  // "add a new row" target.
  const filledBanks = Math.ceil(clips.length / cols);
  const bankCount = Math.max(minBanks, filledBanks);

  const banks = useMemo(
    () =>
      Array.from({ length: bankCount }, (_, b) =>
        Array.from({ length: cols }, (_, i) => clips[b * cols + i] ?? null),
      ),
    [clips, bankCount, cols],
  );

  // Ctrl/Shift+wheel does horizontal scroll of a wide row (and suppress the
  // browser's ctrl-wheel zoom). Attached non-passively so preventDefault bites;
  // a plain wheel falls through to the container's native vertical scroll.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.shiftKey)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      el.scrollLeft += e.deltaY || e.deltaX;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const loadClip = (id: string, url: string) =>
    updateState({ activeClipId: id, clipUrl: url, sourceType: 'clip', sourceBlend: 1 });

  const removeClip = (id: string) => {
    const filtered = clips.filter((c) => c.id !== id);
    const patch: Partial<VJState> = { videoBucket: filtered };
    if (id === state.activeClipId) {
      patch.activeClipId = filtered[0]?.id ?? null;
      patch.clipUrl = filtered[0]?.url ?? null;
    }
    updateState(patch);
  };

  const openImport = () => fileInputRef.current?.click();

  const collapsed = !!state.banksCollapsed;

  return (
    <div className="shrink-0 border-b border-zinc-800 bg-[#0a0a0d]">
      {/* Control strip: collapse + import. Grid grow/shrink lives on the axes. */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-zinc-900">
        <button
          type="button"
          onClick={() => updateState({ banksCollapsed: !collapsed })}
          className="shrink-0 p-0.5 rounded text-zinc-500 hover:text-white hover:bg-zinc-800"
          title={collapsed ? 'Expand video banks' : 'Collapse video banks'}
          aria-label={collapsed ? 'Expand video banks' : 'Collapse video banks'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
        <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-500 select-none">Banks</span>

        <button
          type="button"
          onClick={openImport}
          className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded border border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/20 text-purple-200 text-[9px] font-black uppercase tracking-widest shrink-0"
          title="Import video / image clips"
        >
          <Upload className="w-3 h-3" /> Import
        </button>
        <input
          ref={fileInputRef}
          id="vj-clipgrid-import"
          name="vj-clipgrid-import"
          aria-label="Import video or image clips"
          type="file"
          accept="video/*,image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) onFiles(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {/* The bank stack: vertical scroll through banks, horizontal scroll per
          row (Ctrl/Shift+wheel). A sticky left gutter keeps the bank tag in
          view while a wide row scrolls. */}
      {!collapsed && (
        <>
          <div className="flex items-stretch">
            <div
              ref={scrollRef}
              onDragOver={onPoolDragOver}
              onDragLeave={() => { setPoolDragOver(false); setDropCell(null); }}
              onDrop={onPoolDrop}
              className={`flex-1 overflow-auto custom-scrollbar max-h-72 p-1.5 transition-colors ${
                poolDragOver ? 'bg-cyan-500/5 ring-1 ring-inset ring-cyan-500/40' : ''
              }`}
            >
              <div className="flex flex-col gap-1 w-max">
                {banks.map((row, b) => (
                  <BankRow
                    key={b}
                    tag={`B${b + 1}`}
                    row={row}
                    bank={b}
                    cols={cols}
                    activeClipId={state.activeClipId ?? null}
                    onLoad={loadClip}
                    onRemove={removeClip}
                    onImport={openImport}
                    cellDragOver={onCellDragOver}
                    cellDrop={onCellDrop}
                    clipDragStart={onClipDragStart}
                    dropCell={dropCell}
                  />
                ))}
              </div>
            </div>
            {/* X axis (columns): +/- on the right edge of the grid. */}
            <div className="shrink-0 flex flex-col items-center justify-center gap-1 px-1 border-l border-zinc-900">
              <AxisButton kind="inc" label="Add column" onClick={() => updateState({ gridCols: Math.min(20, cols + 1) })} />
              <AxisButton kind="dec" label="Remove column" onClick={() => updateState({ gridCols: Math.max(1, cols - 1) })} />
            </div>
          </div>
          {/* Y axis (banks): +/- at the bottom of the grid. */}
          <div className="flex items-center gap-1 px-1.5 py-1 border-t border-zinc-900">
            <AxisButton kind="inc" label="Add bank" onClick={() => updateState({ gridRows: Math.min(12, bankCount + 1) })} />
            <AxisButton kind="dec" label="Remove bank" onClick={() => updateState({ gridRows: Math.max(1, bankCount - 1) })} />
          </div>
        </>
      )}
    </div>
  );
}

interface BankRowProps {
  tag: string;
  row: (VJState['videoBucket'][number] | null)[];
  bank: number;
  cols: number;
  activeClipId: string | null;
  onLoad: (id: string, url: string) => void;
  onRemove: (id: string) => void;
  onImport: () => void;
  /** Drag handlers, keyed by the cell's flat index (bank*cols + i). */
  cellDragOver: (flat: number) => (e: React.DragEvent) => void;
  cellDrop: (flat: number) => (e: React.DragEvent) => void;
  clipDragStart: (clipId: string) => (e: React.DragEvent) => void;
  dropCell: number | null;
  muted?: boolean;
}

const BankRow: React.FC<BankRowProps> = ({
  tag,
  row,
  bank,
  cols,
  activeClipId,
  onLoad,
  onRemove,
  onImport,
  cellDragOver,
  cellDrop,
  clipDragStart,
  dropCell,
  muted,
}) => (
  <div className="flex items-stretch gap-1">
    <span
      className={`sticky left-0 z-10 shrink-0 w-6 flex items-center justify-center rounded-sm text-[8px] font-mono uppercase tracking-widest bg-[#0a0a0d] border ${
        muted ? 'border-zinc-900 text-zinc-700' : 'border-zinc-800 text-zinc-500'
      }`}
    >
      {tag}
    </span>
    {row.map((clip, i) => {
      const flat = bank * cols + i;
      const isDropTarget = dropCell === flat;
      if (!clip) {
        return (
          <button
            key={`empty-${bank}-${i}`}
            type="button"
            onClick={onImport}
            onDragOver={cellDragOver(flat)}
            onDrop={cellDrop(flat)}
            aria-label="Empty clip slot, click to import or drop a clip here"
            className={`w-21 h-21 shrink-0 rounded-sm border border-dashed bg-black/40 transition-colors flex items-center justify-center ${
              isDropTarget
                ? 'border-cyan-400/80 bg-cyan-500/10 text-cyan-300'
                : 'border-zinc-800/80 text-zinc-700 hover:border-purple-500/40 hover:text-purple-400/70'
            }`}
          >
            <Plus className="w-3 h-3" />
          </button>
        );
      }
      const isActive = activeClipId === clip.id;
      const isAudio = clip.kind === 'audio';
      return (
        <div
          key={clip.id}
          draggable
          onDragStart={clipDragStart(clip.id)}
          onDragOver={cellDragOver(flat)}
          onDrop={cellDrop(flat)}
          className={`group relative w-21 h-21 shrink-0 rounded-sm overflow-hidden border transition-all cursor-grab active:cursor-grabbing ${
            isDropTarget
              ? 'border-cyan-400 shadow-[0_0_10px_rgba(34,211,238,0.5)]'
              : isActive
              ? 'border-cyan-400/80 shadow-[0_0_10px_rgba(34,211,238,0.35)]'
              : 'border-zinc-800 hover:border-zinc-600'
          }`}
        >
          <button
            type="button"
            onClick={() => onLoad(clip.id, clip.url)}
            className="absolute inset-0 w-full h-full"
            title={clip.name}
            aria-label={`Load clip ${clip.name}`}
          >
            {isAudio ? (
              <span className="absolute inset-0 flex items-center justify-center bg-zinc-950 text-zinc-600">
                <Music className="w-4 h-4" />
              </span>
            ) : (
              <video
                src={clip.url}
                muted
                playsInline
                preload="metadata"
                className="absolute inset-0 w-full h-full object-cover bg-black pointer-events-none"
              />
            )}
            <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 bg-linear-to-t from-black/90 to-transparent text-[7px] font-mono text-zinc-300 truncate text-left leading-tight">
              {clip.name}
            </span>
            {isActive && (
              <span className="absolute top-0.5 left-0.5 px-1 rounded-sm bg-cyan-500/80 text-black text-[6px] font-black uppercase tracking-widest">
                Live
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(clip.id);
            }}
            className="absolute top-0.5 right-0.5 p-0.5 rounded-sm bg-black/70 text-zinc-500 opacity-0 group-hover:opacity-100 hover:text-red-400 transition-opacity"
            title="Remove clip from bank"
            aria-label={`Remove clip ${clip.name}`}
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      );
    })}
  </div>
);

/** Bare +/- axis button: small, compact, high-contrast. */
const AxisButton: React.FC<{ kind: 'inc' | 'dec'; label: string; onClick: () => void }> = ({ kind, label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    title={label}
    className="flex items-center justify-center w-5 h-5 rounded border border-zinc-600 bg-black text-zinc-200 hover:border-cyan-400/70 hover:text-cyan-200 transition-colors"
  >
    {kind === 'inc' ? <Plus className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
  </button>
);

export const ClipGrid = React.memo(ClipGridImpl);
