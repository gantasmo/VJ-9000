/**
 * File router — detects the MIME type of a dropped/selected file and
 * returns a partial VJState patch that loads it into the right slot:
 *
 *   * video/*       → clipUrl (HTMLVideoElement renders frames)
 *   * audio/*       → clipUrl + clipKind='audio' (same <video> element
 *                     plays audio through the analyzer; canvas stays
 *                     black, autopilot + reactive visuals still drive
 *                     based on amplitude). Also auto-enables
 *                     audioReactive so the visualizer responds.
 *   * image/*       → imageUrl (rendered as a still backdrop layered
 *                     behind the visualizer canvas)
 *   * anything else → null (caller can show an error toast)
 *
 * Centralised so the file picker, drag-drop handler, and any future
 * "paste" / playlist entry hooks all share one rule set. Previously
 * the file picker had `accept="video/*"` hard-coded which a drag-drop
 * easily bypassed — and a non-video file then froze the renderer when
 * <video>.play() rejected and nothing caught it.
 */
import type { VJState } from './types';

export type FileRoute =
  | { kind: 'video'; patch: Partial<VJState> }
  | { kind: 'audio'; patch: Partial<VJState> }
  | { kind: 'image'; patch: Partial<VJState> }
  | { kind: 'unsupported'; mime: string; name: string };

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|avi)$/i;
const AUDIO_EXT = /\.(wav|mp3|flac|ogg|aac|m4a|opus|aiff)$/i;
const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp|avif|bmp)$/i;

export function routeFile(file: File): FileRoute {
  const url = URL.createObjectURL(file);
  const mime = file.type || '';
  const name = file.name || '';

  // MIME first; fall back to extension matching for clips that come
  // through drag-drop with empty MIME (common on Windows).
  if (mime.startsWith('video/') || VIDEO_EXT.test(name)) {
    return {
      kind: 'video',
      patch: {
        clipUrl: url,
        clipLabel: name,
        clipKind: 'video',
        sourceType: 'clip',
      },
    };
  }
  if (mime.startsWith('audio/') || AUDIO_EXT.test(name)) {
    return {
      kind: 'audio',
      patch: {
        clipUrl: url,
        clipLabel: name,
        clipKind: 'audio',
        sourceType: 'clip',
        // Auto-enable audio reactivity — the whole point of loading
        // an audio file in VJ is to react to it. The user can flip
        // it off in the controls if they don't want that.
        audioReactive: true,
      },
    };
  }
  if (mime.startsWith('image/') || IMAGE_EXT.test(name)) {
    return {
      kind: 'image',
      patch: {
        imageUrl: url,
        imageLabel: name,
      },
    };
  }
  URL.revokeObjectURL(url);
  return { kind: 'unsupported', mime, name };
}

/** Accept= attribute that covers everything routeFile() handles. */
export const VJ_FILE_ACCEPT = 'video/*,audio/*,image/*';
