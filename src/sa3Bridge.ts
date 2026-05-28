/**
 * SA3 bridge — listens for postMessage from the parent window (the
 * SA3 frontend, which embeds this app in an iframe in its VJ tab).
 *
 * When SA3 has a track loaded in its global player, it forwards the
 * master AnalyserNode's amplitude buckets (bass / mid / high / volume)
 * at requestAnimationFrame rate. Other messages carry the currently-
 * playing track's metadata.
 *
 * The bridge is INERT when the app runs standalone (no parent window
 * sending messages) — `getExternalLevels()` returns null and
 * useAudioAnalyzer falls back to its built-in mic capture.
 *
 * This module is the *only* SA3-specific addition to the VJ project.
 * It is self-contained, side-effect-free until first import, and does
 * not change any existing VJ behaviour. The VJ visualizer continues
 * to work exactly as before when run standalone.
 */

export interface ExternalAudioLevels {
  bass: number;
  mid: number;
  high: number;
  volume: number;
}

export interface ExternalTrackMeta {
  entryId: string | null;
  title: string | null;
  model: string | null;
  source: string | null;
  duration: number | null;
  isPlaying: boolean;
}

const LEVELS_STALE_MS = 200;

let latestLevels: ExternalAudioLevels | null = null;
let latestLevelsAt = 0;
let latestMeta: ExternalTrackMeta | null = null;
const metaListeners = new Set<(meta: ExternalTrackMeta) => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    if (data.type === 'sa3-vj/audio-levels') {
      latestLevels = {
        bass: Number(data.bass) || 0,
        mid: Number(data.mid) || 0,
        high: Number(data.high) || 0,
        volume: Number(data.volume) || 0,
      };
      latestLevelsAt = performance.now();
    } else if (data.type === 'sa3-vj/track-meta') {
      latestMeta = {
        entryId: data.entryId ?? null,
        title: data.title ?? null,
        model: data.model ?? null,
        source: data.source ?? null,
        duration: typeof data.duration === 'number' ? data.duration : null,
        isPlaying: Boolean(data.isPlaying),
      };
      metaListeners.forEach((cb) => {
        try {
          cb(latestMeta!);
        } catch {
          /* listener should not throw, but be defensive */
        }
      });
    }
  });
}

/**
 * Latest audio amplitude buckets from the SA3 player, or null if the
 * bridge hasn't received a frame in the last LEVELS_STALE_MS. Callers
 * (useAudioAnalyzer) treat null as "fall back to mic / nothing".
 */
export function getExternalLevels(): ExternalAudioLevels | null {
  if (!latestLevels) return null;
  if (performance.now() - latestLevelsAt > LEVELS_STALE_MS) {
    // Parent stopped sending — let the analyzer fall back so the user
    // isn't stuck staring at a frozen visualization.
    return null;
  }
  return latestLevels;
}

/** Latest track metadata received from SA3, or null if none yet. */
export function getExternalMeta(): ExternalTrackMeta | null {
  return latestMeta;
}

/** Subscribe to track-meta updates. Returns an unsubscribe fn. */
export function subscribeToMeta(
  cb: (meta: ExternalTrackMeta) => void,
): () => void {
  metaListeners.add(cb);
  if (latestMeta) cb(latestMeta);
  return () => {
    metaListeners.delete(cb);
  };
}

/** True if SA3's audio bridge has sent a frame recently. */
export function isBridgeActive(): boolean {
  return (
    latestLevels !== null &&
    performance.now() - latestLevelsAt <= LEVELS_STALE_MS
  );
}
