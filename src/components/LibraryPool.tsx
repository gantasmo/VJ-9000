import React, { useMemo, useState } from 'react';
import { Library, RefreshCw, ChevronUp, ChevronDown, Check, Film, Image as ImageIcon, Search } from 'lucide-react';
import type { PoolItem } from '../useLibraryPool';

/**
 * Library Pool browser — the shared SA3 media library, shown inside the VJ as
 * a strip of thumbnails above the banks. Click an item to stage / unstage it
 * into the banks, or drag it onto the grid. Staging records a reference (it
 * never copies bytes); the only true import is a new file (handled elsewhere).
 *
 * The drag payload is the full `PoolItem` as JSON under POOL_DND_TYPE so the
 * bank grid can stage a dropped item without a shared module ref. This is a
 * same-document drag (pool → banks), so there's no cross-origin constraint.
 */

export const POOL_DND_TYPE = 'application/x-vj-pool-item';

interface LibraryPoolProps {
  items: PoolItem[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  /** Stage ids currently in the banks, for the "staged" highlight. */
  stagedIds: Set<string>;
  onStage: (item: PoolItem) => void;
  onUnstage: (id: string) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

function LibraryPoolImpl({
  items,
  loading,
  error,
  refresh,
  stagedIds,
  onStage,
  onUnstage,
  collapsed,
  onToggleCollapse,
}: LibraryPoolProps) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
  }, [items, query]);

  return (
    <div className="shrink-0 border-b border-zinc-800 bg-[#08080c]">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-zinc-900">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="shrink-0 p-0.5 rounded text-zinc-500 hover:text-white hover:bg-zinc-800"
          title={collapsed ? 'Expand library pool' : 'Collapse library pool'}
          aria-label={collapsed ? 'Expand library pool' : 'Collapse library pool'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
        </button>
        <Library className="w-3 h-3 text-cyan-400 shrink-0" />
        <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-400 shrink-0">Library Pool</span>
        <span className="text-[9px] font-mono text-zinc-600 shrink-0">{items.length}</span>
        {!collapsed && (
          <div className="relative ml-2 flex-1 min-w-0 max-w-48">
            <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 w-2.5 h-2.5 text-zinc-600 pointer-events-none" />
            <input
              id="vj-pool-search"
              name="vj-pool-search"
              aria-label="Search the library pool"
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="search…"
              spellCheck={false}
              className="w-full bg-black border border-zinc-800 rounded pl-5 pr-1.5 py-0.5 text-[9px] font-mono text-zinc-300 placeholder:text-zinc-700 focus:border-cyan-500/40 focus:outline-none"
            />
          </div>
        )}
        <button
          type="button"
          onClick={refresh}
          className="ml-auto shrink-0 p-0.5 rounded text-zinc-500 hover:text-cyan-200 hover:bg-zinc-800"
          title="Refresh the library pool"
          aria-label="Refresh library pool"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {!collapsed && (
        <div className="max-h-40 overflow-y-auto custom-scrollbar p-1.5">
          {error ? (
            <p className="text-[9px] font-mono text-rose-300/80 px-1 py-2 leading-snug">
              Library unreachable: {error}. Local file import still works; reconnect theDAW to browse the shared pool.
            </p>
          ) : filtered.length === 0 ? (
            <p className="text-[9px] font-mono text-zinc-600 px-1 py-2">
              {loading
                ? 'Loading library…'
                : items.length === 0
                ? 'No video / image media in the library yet. Import a clip to add it to the shared pool.'
                : 'No matches.'}
            </p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {filtered.map((item) => {
                const staged = stagedIds.has(item.id);
                return (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(POOL_DND_TYPE, JSON.stringify(item));
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    className={`group relative w-16 h-16 rounded-sm overflow-hidden border cursor-grab active:cursor-grabbing transition-all ${
                      staged
                        ? 'border-cyan-400/70 shadow-[0_0_8px_rgba(34,211,238,0.3)]'
                        : 'border-zinc-800 hover:border-zinc-600'
                    }`}
                    title={`${item.name} — click to ${staged ? 'unstage' : 'stage into banks'}, or drag onto the grid`}
                  >
                    <button
                      type="button"
                      onClick={() => (staged ? onUnstage(item.id) : onStage(item))}
                      className="absolute inset-0 w-full h-full"
                      aria-label={`${staged ? 'Unstage' : 'Stage'} ${item.name}`}
                    >
                      {item.thumbUrl ? (
                        <img
                          src={item.thumbUrl}
                          alt=""
                          loading="lazy"
                          className="absolute inset-0 w-full h-full object-cover bg-black"
                        />
                      ) : (
                        <span className="absolute inset-0 flex items-center justify-center bg-zinc-950 text-zinc-600">
                          {item.kind === 'image' ? <ImageIcon className="w-4 h-4" /> : <Film className="w-4 h-4" />}
                        </span>
                      )}
                      <span className="absolute inset-x-0 bottom-0 px-1 py-0.5 bg-linear-to-t from-black/90 to-transparent text-[6px] font-mono text-zinc-300 truncate text-left leading-tight">
                        {item.name}
                      </span>
                      {staged && (
                        <span className="absolute top-0.5 right-0.5 w-3 h-3 rounded-sm bg-cyan-500/90 text-black flex items-center justify-center">
                          <Check className="w-2 h-2" />
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const LibraryPool = React.memo(LibraryPoolImpl);
