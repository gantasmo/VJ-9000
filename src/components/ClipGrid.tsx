import React, { useMemo, useRef } from 'react';
import { Plus, Minus, Upload, Music, X, ChevronUp, ChevronDown } from 'lucide-react';
import { VJState } from '../types';

/**
 * Resolume-style clip grid — the headline of the standard VJ layout.
 *
 * Square clip cells (icon size is independent of clip length, exactly like a
 * VJ deck), laid out in a fixed grid of `gridCols × gridRows`. Both dimensions
 * can be grown with the steppers. The flat `videoBucket` is paged into "banks"
 * of `cols × rows` cells, with a tab per bank. Clicking a clip loads it live
 * (MEM source); empty cells import.
 */

interface ClipGridProps {
  state: VJState;
  updateState: (updates: Partial<VJState>) => void;
  /** Wired to App.handleFiles so imports append to the shared bucket. */
  onFiles: (files: FileList) => void;
}

function ClipGridImpl({ state, updateState, onFiles }: ClipGridProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const cols = Math.max(1, Math.min(20, state.gridCols ?? 10));
  const rows = Math.max(1, Math.min(8, state.gridRows ?? 2));
  const perBank = cols * rows;

  const clips = state.videoBucket ?? [];
  const bankCount = Math.max(1, Math.ceil(clips.length / perBank));
  const bank = Math.max(0, Math.min(state.gridBank ?? 0, bankCount - 1));
  const cells = useMemo(() => {
    const start = bank * perBank;
    return Array.from({ length: perBank }, (_, i) => clips[start + i] ?? null);
  }, [clips, bank, perBank]);

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
      {/* Bank tabs + grid-size + import — compact strip, no wide buttons. */}
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
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
          {Array.from({ length: bankCount }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => updateState({ gridBank: i })}
              className={`px-2 py-0.5 rounded text-[9px] font-mono uppercase tracking-widest shrink-0 border transition-colors ${
                i === bank
                  ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-200'
                  : 'border-zinc-800 bg-black text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
              }`}
              title={`Bank ${i + 1}`}
            >
              {`Bank ${i + 1}`}
            </button>
          ))}
        </div>

        <span className="ml-auto text-[9px] font-mono text-zinc-600 shrink-0">
          {clips.length} clip{clips.length === 1 ? '' : 's'}
        </span>

        {/* Grid-size steppers. */}
        <div className="flex items-center gap-1 shrink-0" title="Grid columns">
          <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">Col</span>
          <Stepper
            value={cols}
            onDec={() => updateState({ gridCols: Math.max(1, cols - 1) })}
            onInc={() => updateState({ gridCols: Math.min(20, cols + 1) })}
          />
        </div>
        <div className="flex items-center gap-1 shrink-0" title="Grid rows">
          <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-600">Row</span>
          <Stepper
            value={rows}
            onDec={() => updateState({ gridRows: Math.max(1, rows - 1) })}
            onInc={() => updateState({ gridRows: Math.min(8, rows + 1) })}
          />
        </div>

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

      {/* The grid itself — square cells, capped so the bar stays compact and
          left-aligned (Resolume-style) instead of ballooning on wide screens. */}
      {!collapsed && (
      <div
        className="grid gap-1 p-1.5 justify-start"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 84px))` }}
      >
        {cells.map((clip, i) => {
          if (!clip) {
            return (
              <button
                key={`empty-${bank}-${i}`}
                type="button"
                onClick={openImport}
                aria-label="Empty clip slot — click to import"
                className="aspect-square rounded-sm border border-dashed border-zinc-800/80 bg-black/40 text-zinc-700 hover:border-purple-500/40 hover:text-purple-400/70 transition-colors flex items-center justify-center"
              >
                <Plus className="w-3 h-3" />
              </button>
            );
          }
          const isActive = state.activeClipId === clip.id;
          const isAudio = clip.kind === 'audio';
          return (
            <div
              key={clip.id}
              className={`group relative aspect-square rounded-sm overflow-hidden border transition-all ${
                isActive
                  ? 'border-cyan-400/80 shadow-[0_0_10px_rgba(34,211,238,0.35)]'
                  : 'border-zinc-800 hover:border-zinc-600'
              }`}
            >
              <button
                type="button"
                onClick={() => loadClip(clip.id, clip.url)}
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
                <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 bg-gradient-to-t from-black/90 to-transparent text-[7px] font-mono text-zinc-300 truncate text-left leading-tight">
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
                  removeClip(clip.id);
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
      )}
    </div>
  );
}

const Stepper: React.FC<{ value: number; onDec: () => void; onInc: () => void }> = ({ value, onDec, onInc }) => (
  <div className="flex items-center border border-zinc-800 rounded overflow-hidden">
    <button type="button" onClick={onDec} className="px-1 py-0.5 text-zinc-500 hover:text-white hover:bg-zinc-800" aria-label="decrease">
      <Minus className="w-2.5 h-2.5" />
    </button>
    <span className="px-1 text-[9px] font-mono text-zinc-300 tabular-nums min-w-4 text-center">{value}</span>
    <button type="button" onClick={onInc} className="px-1 py-0.5 text-zinc-500 hover:text-white hover:bg-zinc-800" aria-label="increase">
      <Plus className="w-2.5 h-2.5" />
    </button>
  </div>
);

export const ClipGrid = React.memo(ClipGridImpl);
