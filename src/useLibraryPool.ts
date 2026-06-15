import { useCallback, useEffect, useState } from 'react';
import { backendBase } from './libraryUpload';

/**
 * Library pool — the shared SA3 media library, browsable from inside the VJ.
 *
 * theDAW's library (`/api/library`) is the single source of truth for all
 * media: audio, video and image entries live there on disk. The VJ banks are
 * just an *arrangement* over that pool — staging an item adds a reference to
 * `videoBucket`, it never copies bytes. The only real "import" is a brand-new
 * file (uploaded into the library, after which it shows up here for free).
 *
 * This hook fetches the video/image entries (`?kind=media`) and maps them to a
 * flat `PoolItem`. URLs are resolved to the backend origin exactly the way
 * `uploadMediaToLibrary` already does, so a staged pool item loads through the
 * identical, known-good media path. Inert when the backend is unreachable
 * (standalone VJ) — `error` is set and local file import still works.
 */

export interface PoolItem {
  /** Stage id, `sa3-<entryId>`. Matches the host's load-track dedup key so a
   *  drag-from-pool and a DJ→VJ hand-off of the same track collapse to one. */
  id: string;
  entryId: string;
  name: string;
  /** Absolute, reload-stable media URL (same form local imports produce). */
  url: string;
  thumbUrl: string | null;
  kind: 'video' | 'image';
}

interface PoolState {
  items: PoolItem[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const abs = (rel: string | null | undefined): string | null => {
  if (!rel) return null;
  return rel.startsWith('http') ? rel : `${backendBase()}${rel}`;
};

export function useLibraryPool(enabled: boolean): PoolState {
  const [items, setItems] = useState<PoolItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`${backendBase()}/api/library/entries?kind=media`)
      .then((r) => {
        if (!r.ok) throw new Error(`library returned ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        const entries: unknown[] = Array.isArray(data?.entries) ? data.entries : [];
        const mapped = entries.map((raw): PoolItem => {
          const e = raw as Record<string, unknown>;
          const entryId = String(e.id);
          const kind = e.kind === 'image' ? 'image' : 'video';
          const url = abs(e.media_url as string) ?? `${backendBase()}/api/library/media/${entryId}`;
          return {
            id: `sa3-${entryId}`,
            entryId,
            name: typeof e.title === 'string' && e.title.trim() ? e.title : 'Untitled',
            url,
            thumbUrl: abs(e.thumb_url as string),
            kind,
          };
        });
        setItems(mapped);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, nonce]);

  return { items, loading, error, refresh };
}
