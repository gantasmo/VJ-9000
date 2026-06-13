/**
 * Library persistence for VJ media.
 *
 * Clips dropped/picked in the VJ are blob: URLs by default, which die on
 * reload (App.tsx strips them from saved state). To make the cue survive
 * a reload we upload the original file to theDAW's library
 * (`POST /api/library/import-media`) and swap the blob URL for the stable
 * `/api/library/media/<id>` URL it returns. The bucket already persists
 * non-blob URLs, so once swapped the clip survives reloads for free.
 *
 * The backend origin is passed in by the host on the iframe URL
 * (`?api=<origin>`); the host always serves `/api` (directly in
 * production, via the Vite dev proxy in development). The fallback covers
 * the standalone case (VJ opened directly, conventional backend port).
 */

export interface UploadedMedia {
  id: string;
  /** Absolute, reload-stable URL for the file. */
  mediaUrl: string;
  kind: 'video' | 'image';
  hasAlpha: boolean;
}

/** Resolve the host's backend origin (no trailing slash). */
export function backendBase(): string {
  try {
    const api = new URLSearchParams(window.location.search).get('api');
    if (api) return api.replace(/\/+$/, '');
  } catch {
    /* search unparseable — fall through */
  }
  return `${window.location.protocol}//${window.location.hostname}:8600`;
}

/** True when a URL is already a stable (non-blob) http(s) URL. */
export function isStableUrl(url: string | null | undefined): boolean {
  return !!url && !url.startsWith('blob:') && !url.startsWith('data:');
}

/** Upload one video/image file to the library and return its stable entry. */
export async function uploadMediaToLibrary(file: File): Promise<UploadedMedia> {
  const base = backendBase();
  const form = new FormData();
  form.append('file', file, file.name);
  form.append('metadata', JSON.stringify({ source: 'vj' }));
  const res = await fetch(`${base}/api/library/import-media`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail) detail = String(body.detail);
    } catch {
      /* ignore */
    }
    throw new Error(`library import-media failed: ${detail}`);
  }
  const rec = await res.json();
  const rel: string = rec.media_url || `/api/library/media/${rec.id}`;
  const mediaUrl = rel.startsWith('http') ? rel : `${base}${rel}`;
  return {
    id: String(rec.id),
    mediaUrl,
    kind: rec.kind === 'image' ? 'image' : 'video',
    hasAlpha: !!rec.has_alpha,
  };
}
