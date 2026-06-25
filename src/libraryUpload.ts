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

/**
 * WebSocket base for backend relays (e.g. the akvj point-cloud viewer).
 *
 * The Vite dev proxy forwards HTTP `/api` fine but does NOT reliably forward
 * `/api` WebSocket UPGRADES — the upgrade hangs and the socket never opens. So
 * connect WebSockets to the backend DIRECTLY (CORS is open with allow_origins=*).
 * In dev the `?api=` origin is the frontend dev server (5173) whose backend is on
 * :8600; in production the `?api=` origin IS the backend, so use it as-is. This
 * mirrors how the Quest sources connect straight to their relay ports rather than
 * through the frontend proxy.
 */
export function backendWsBase(): string {
  const http = backendBase();
  try {
    const u = new URL(http);
    const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    // Frontend dev-server origins → the backend is the same host on :8600. Map a
    // 'localhost' hostname to 127.0.0.1: the backend binds 0.0.0.0 (IPv4), and on
    // Windows 'localhost' can resolve to ::1 (IPv6) first and stall the upgrade.
    if (u.port === '5173' || u.port === '5187') {
      const host = u.hostname === 'localhost' ? '127.0.0.1' : u.hostname;
      return `${wsProto}//${host}:8600`;
    }
    return `${wsProto}//${u.host}`;
  } catch {
    return http.replace(/^http/, 'ws');
  }
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
