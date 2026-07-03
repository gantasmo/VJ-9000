import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Minus, Upload, Music, X, ChevronUp, ChevronDown, ChevronLeft, Radio, Library, HardDrive, Pin } from 'lucide-react';
import { VJState, type SourceRef } from '../types';
import type { PoolItem } from '../useLibraryPool';
import { POOL_DND_TYPE } from './LibraryPool';
import { ResizeHandle } from './ResizeHandle';

/** DnD type for reordering an already-staged clip between bank slots. */
const CLIP_MOVE_DND_TYPE = 'application/x-vj-clip-move';

/** Live/generative sources that can be pinned into a bank slot. */
const SOURCE_OPTIONS: { id: string; label: string }[] = [
  { id: 'device', label: 'DEVICE' },
  { id: 'screen', label: 'SCREEN' },
  { id: 'quest', label: 'delinQuest' },
  { id: 'queststitch', label: 'STITCH' },
  { id: 'cymatics', label: 'CYMATICS' },
  { id: 'akvj3d', label: 'KINECT' },
  { id: 'depthcloud', label: 'DEPTH' },
  { id: 'spectra', label: 'SPECTRA' },
  { id: 'shader', label: 'SHADER' },
];

function labelForSource(ref: SourceRef): string {
  const base = SOURCE_OPTIONS.find((s) => s.id === ref.cameraSource)?.label ?? ref.cameraSource.toUpperCase();
  return ref.cameraSource === 'shader' && ref.shaderId ? `${base} · ${ref.shaderId}` : base;
}

const sourceKey = (ref: SourceRef): string =>
  `${ref.cameraSource}:${ref.cameraSource === 'shader' ? ref.shaderId ?? '' : ''}`;

/**
 * Resolume-style clip grid, the headline of the standard VJ layout.
 *
 * Banks = ROWS. Each horizontal row is one bank (B1, B2, ...) stacked top to
 * bottom; the flat `videoBucket` fills row by row, `gridCols` clips per bank.
 * A trailing empty "+" bank is always shown to import a fresh row into.
 *
 * A slot holds a clip (video/image/audio) OR a pinned SOURCE (a live/generative
 * source recalled on click). Add a source via the "Pin" button (snapshots the
 * current source) or by clicking an empty slot -> Library / Source / Local.
 *
 * Navigation matches a VJ deck: a plain mouse wheel scrolls the stack up/down
 * (through banks), and Ctrl/Shift+wheel scrolls a wide row left/right.
 */

interface ClipGridProps {
  state: VJState;
  updateState: (updates: Partial<VJState>) => void;
  /** Wired to App.handleFiles so imports append to the shared bucket. */
  onFiles: (files: FileList) => void;
  /** Stage a pool item dropped on the grid background (append). */
  onStagePoolItem?: (item: PoolItem) => void;
  /** Stage a pool item dropped on / chosen for a specific cell (exact slot). */
  onStagePoolItemAt?: (item: PoolItem, index: number) => void;
  /** Reorder an already-staged clip to a specific slot. */
  onMoveClipToIndex?: (clipId: string, index: number) => void;
  /** Library pool items, for the "Library" choice in the slot menu. */
  poolItems?: PoolItem[];
}

function ClipGridImpl({
  state,
  updateState,
  onFiles,
  onStagePoolItem,
  onStagePoolItemAt,
  onMoveClipToIndex,
  poolItems = [],
}: ClipGridProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [poolDragOver, setPoolDragOver] = useState(false);
  // Cell index currently hovered by a drag, for the drop highlight.
  const [dropCell, setDropCell] = useState<number | null>(null);
  // Slot whose "add from" menu is open, its anchor position, and the menu page.
  const [menuSlot, setMenuSlot] = useState<number | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({ x: 8, y: 8 });
  const [menuTab, setMenuTab] = useState<'root' | 'src' | 'lib'>('root');

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

  // Recall a pinned source (and its preset).
  const activateSource = (ref: SourceRef) =>
    updateState({
      sourceType: 'camera',
      sourceBlend: 0,
      cameraSource: ref.cameraSource as VJState['cameraSource'],
      ...(ref.shaderId ? { shaderId: ref.shaderId } : {}),
      cameraReinit: (state.cameraReinit ?? 0) + 1,
    });

  const makeSourceClip = (ref: SourceRef) => ({
    id: `src-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
    name: labelForSource(ref),
    url: '',
    kind: 'source' as const,
    source: ref,
  });

  const addSourceAt = (ref: SourceRef, index: number) => {
    const next = [...clips];
    const clip = makeSourceClip(ref);
    if (index >= next.length) next.push(clip);
    else next.splice(index, 0, clip);
    updateState({ videoBucket: next });
  };

  // "Pin" the current source into the next free slot (auto-placed; drag to move).
  const snapshotSource = () => {
    const ref: SourceRef = {
      cameraSource: state.cameraSource ?? 'device',
      shaderId: state.cameraSource === 'shader' ? state.shaderId ?? 'yotta' : undefined,
    };
    updateState({ videoBucket: [...clips, makeSourceClip(ref)] });
  };

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
  // Anchor the "add from" menu at the click point, clamped to stay inside the
  // banks panel, and raise it in front.
  const openSlotMenu = (flat: number, clientX: number, clientY: number) => {
    const rect = rootRef.current?.getBoundingClientRect();
    const W = 228;
    const H = 250;
    const cw = rect?.width ?? 800;
    const ch = rect?.height ?? 400;
    const x = Math.max(4, Math.min(clientX - (rect?.left ?? 0), cw - W - 4));
    const y = Math.max(4, Math.min(clientY - (rect?.top ?? 0), ch - H - 4));
    setMenuPos({ x, y });
    setMenuSlot(flat);
    setMenuTab('root');
  };
  const closeMenu = () => {
    setMenuSlot(null);
    setMenuTab('root');
  };

  const collapsed = !!state.banksCollapsed;
  // Key of the live source, so a pinned source tile lights up when it is active.
  const activeSourceKey =
    state.sourceType === 'camera'
      ? sourceKey({ cameraSource: state.cameraSource ?? 'device', shaderId: state.shaderId })
      : null;

  return (
    <div ref={rootRef} className="relative shrink-0 border-b border-zinc-800 bg-[#0a0a0d]">
      {/* Control strip: collapse + grid size (cols / banks) + pin source + import. */}
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

        <span className="flex items-center gap-0.5 ml-1">
          <span className="text-[8px] font-mono uppercase text-zinc-600 select-none">Col</span>
          <AxisButton kind="dec" label="Remove column" onClick={() => updateState({ gridCols: Math.max(1, cols - 1) })} />
          <AxisButton kind="inc" label="Add column" onClick={() => updateState({ gridCols: Math.min(20, cols + 1) })} />
        </span>
        <span className="flex items-center gap-0.5">
          <span className="text-[8px] font-mono uppercase text-zinc-600 select-none">Bank</span>
          <AxisButton kind="dec" label="Remove bank" onClick={() => updateState({ gridRows: Math.max(1, bankCount - 1) })} />
          <AxisButton kind="inc" label="Add bank" onClick={() => updateState({ gridRows: Math.min(12, bankCount + 1) })} />
        </span>

        <button
          type="button"
          onClick={snapshotSource}
          className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded border border-fuchsia-500/40 bg-fuchsia-500/10 hover:bg-fuchsia-500/20 text-fuchsia-200 text-[9px] font-black uppercase tracking-widest shrink-0"
          title="Pin the current source into the banks (drag to reposition)"
        >
          <Pin className="w-3 h-3" /> Pin
        </button>
        <button
          type="button"
          onClick={openImport}
          className="flex items-center gap-1 px-2 py-0.5 rounded border border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/20 text-purple-200 text-[9px] font-black uppercase tracking-widest shrink-0"
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

      {/* "Add from" menu for an empty slot: Library / Source / Local. */}
      {menuSlot !== null && (
        <div
          className="absolute z-50 w-56 rounded-md border border-zinc-700 bg-[#0c0c12] shadow-xl p-1.5"
          style={{ left: menuPos.x, top: menuPos.y }}
          role="menu"
        >
          <div className="flex items-center justify-between mb-1">
            <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-400">
              {menuTab === 'root'
                ? `Add to slot ${menuSlot + 1}`
                : menuTab === 'src'
                  ? 'Pick a source'
                  : 'Pick from library'}
            </span>
            <button
              type="button"
              onClick={menuTab === 'root' ? closeMenu : () => setMenuTab('root')}
              className="p-0.5 rounded text-zinc-500 hover:text-white hover:bg-zinc-800"
              title={menuTab === 'root' ? 'Close' : 'Back'}
              aria-label={menuTab === 'root' ? 'Close menu' : 'Back'}
            >
              {menuTab === 'root' ? <X className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
            </button>
          </div>

          {menuTab === 'root' && (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setMenuTab('lib')}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded border border-white/10 text-zinc-200 hover:border-cyan-400/50 hover:text-cyan-200 text-[10px] font-mono uppercase tracking-widest"
              >
                <Library className="w-3 h-3" /> Library
              </button>
              <button
                type="button"
                onClick={() => setMenuTab('src')}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded border border-white/10 text-zinc-200 hover:border-fuchsia-400/50 hover:text-fuchsia-200 text-[10px] font-mono uppercase tracking-widest"
              >
                <Radio className="w-3 h-3" /> Source
              </button>
              <button
                type="button"
                onClick={() => {
                  openImport();
                  closeMenu();
                }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded border border-white/10 text-zinc-200 hover:border-purple-400/50 hover:text-purple-200 text-[10px] font-mono uppercase tracking-widest"
              >
                <HardDrive className="w-3 h-3" /> Local file
              </button>
            </div>
          )}

          {menuTab === 'src' && (
            <div className="max-h-48 overflow-auto custom-scrollbar grid grid-cols-2 gap-1">
              {SOURCE_OPTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => {
                    addSourceAt(
                      { cameraSource: s.id, shaderId: s.id === 'shader' ? state.shaderId ?? 'yotta' : undefined },
                      menuSlot,
                    );
                    closeMenu();
                  }}
                  className="px-2 py-1.5 rounded border border-white/10 text-zinc-300 hover:border-fuchsia-400/50 hover:text-fuchsia-200 text-[9px] font-mono uppercase tracking-widest text-left truncate"
                >
                  {s.label}
                </button>
              ))}
            </div>
          )}

          {menuTab === 'lib' && (
            <div className="max-h-48 overflow-auto custom-scrollbar space-y-0.5">
              {poolItems.length === 0 && (
                <div className="text-[9px] font-mono text-zinc-600 p-2">Library is empty — import media first.</div>
              )}
              {poolItems.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => {
                    onStagePoolItemAt?.(it, menuSlot);
                    closeMenu();
                  }}
                  className="w-full px-2 py-1 rounded border border-white/5 text-zinc-300 hover:border-cyan-400/50 hover:text-cyan-200 text-[9px] font-mono truncate text-left"
                >
                  {it.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* The bank stack: vertical scroll through banks, horizontal scroll per
          row (Ctrl/Shift+wheel). A sticky left gutter keeps the bank tag in
          view while a wide row scrolls. */}
      {!collapsed && (
        <>
          <div
            ref={scrollRef}
            onDragOver={onPoolDragOver}
            onDragLeave={() => { setPoolDragOver(false); setDropCell(null); }}
            onDrop={onPoolDrop}
            style={{ maxHeight: state.vjBanksH ?? 288 }}
            className={`overflow-auto custom-scrollbar p-1.5 transition-colors ${
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
                  activeSourceKey={activeSourceKey}
                  onLoad={loadClip}
                  onActivateSource={activateSource}
                  onRemove={removeClip}
                  onSlotMenu={openSlotMenu}
                  cellDragOver={onCellDragOver}
                  cellDrop={onCellDrop}
                  clipDragStart={onClipDragStart}
                  dropCell={dropCell}
                />
              ))}
            </div>
          </div>
          {/* Drag the bottom edge to set how tall the banks grow before scrolling. */}
          <ResizeHandle
            orientation="horizontal"
            title="Resize banks height"
            onDrag={(d) => updateState({ vjBanksH: Math.max(96, Math.min(640, (state.vjBanksH ?? 288) + d)) })}
          />
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
  activeSourceKey: string | null;
  onLoad: (id: string, url: string) => void;
  onActivateSource: (ref: SourceRef) => void;
  onRemove: (id: string) => void;
  onSlotMenu: (flat: number, x: number, y: number) => void;
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
  activeSourceKey,
  onLoad,
  onActivateSource,
  onRemove,
  onSlotMenu,
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
            onClick={(e) => onSlotMenu(flat, e.clientX, e.clientY)}
            onDragOver={cellDragOver(flat)}
            onDrop={cellDrop(flat)}
            aria-label="Empty slot, click to add a clip or source, or drop a clip here"
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
      // Pinned SOURCE tile.
      if (clip.kind === 'source' && clip.source) {
        const isActive = activeSourceKey === sourceKey(clip.source);
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
                ? 'border-fuchsia-400/80 shadow-[0_0_10px_rgba(232,121,249,0.4)]'
                : 'border-zinc-800 hover:border-fuchsia-500/50'
            }`}
          >
            <button
              type="button"
              onClick={() => onActivateSource(clip.source!)}
              className="absolute inset-0 w-full h-full flex flex-col items-center justify-center gap-1 bg-fuchsia-950/20"
              title={`Recall source: ${clip.name}`}
              aria-label={`Recall source ${clip.name}`}
            >
              <Radio className="w-4 h-4 text-fuchsia-300/80" />
              <span className="px-1 text-[7px] font-mono text-fuchsia-200/90 truncate max-w-full leading-tight text-center">
                {clip.name}
              </span>
              {isActive && (
                <span className="absolute top-0.5 left-0.5 px-1 rounded-sm bg-fuchsia-500/80 text-black text-[6px] font-black uppercase tracking-widest">
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
              title="Remove source from bank"
              aria-label={`Remove source ${clip.name}`}
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
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
            ) : clip.thumbUrl ? (
              /* Poster image instead of a per-cell <video>: N live video
                 elements hold N media connections and starve the HTTP/1.1
                 per-origin pool, which is what made every video load slowly. */
              <img
                src={clip.thumbUrl}
                alt=""
                loading="lazy"
                className="absolute inset-0 w-full h-full object-cover bg-black pointer-events-none"
              />
            ) : (
              <video
                src={clip.url}
                muted
                playsInline
                /* blob: URLs are local (no network); http(s) clips without a
                   thumb stay preload="none" so they never join the fetch storm. */
                preload={clip.url.startsWith('blob:') ? 'metadata' : 'none'}
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
