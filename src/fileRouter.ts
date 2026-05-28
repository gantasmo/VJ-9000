/**
 * File router — detects the MIME type of a dropped/selected file and
 * returns either:
 *
 *   * `VideoClip` entries (kind='video' or 'audio') to be APPENDED to
 *     videoBucket. The caller decides whether to switch the active
 *     clip to the new entry.
 *   * An image patch with imageUrl + imageLabel (rendered as backdrop
 *     behind the visualizer canvas).
 *   * `unsupported` rejection with the original MIME + name so the
 *     caller can surface an error toast.
 *
 * Centralised so the file picker, drag-drop handler, and any future
 * paste / playlist entry hook all share one rule set.
 */
import type { VJState, VideoClip } from './types';

export type FileRoute =
  | { kind: 'video'; clip: VideoClip }
  | { kind: 'audio'; clip: VideoClip }
  | { kind: 'image'; patch: Partial<VJState> }
  | { kind: 'unsupported'; mime: string; name: string };

const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|avi)$/i;
const AUDIO_EXT = /\.(wav|mp3|flac|ogg|aac|m4a|opus|aiff)$/i;
const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp|avif|bmp)$/i;

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `clip-${Date.now()}-${idCounter}`;
}

function shortName(name: string): string {
  return name.length > 25 ? name.substring(0, 22) + '...' : name;
}

function sizeMB(file: File): string {
  return `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
}

export function routeFile(file: File): FileRoute {
  const mime = file.type || '';
  const name = file.name || '';

  // MIME first; fall back to extension matching for clips that come
  // through drag-drop with empty MIME (common on Windows).
  if (mime.startsWith('video/') || VIDEO_EXT.test(name)) {
    const url = URL.createObjectURL(file);
    return {
      kind: 'video',
      clip: {
        id: nextId(),
        name: shortName(name),
        url,
        size: sizeMB(file),
        kind: 'video',
      },
    };
  }
  if (mime.startsWith('audio/') || AUDIO_EXT.test(name)) {
    const url = URL.createObjectURL(file);
    return {
      kind: 'audio',
      clip: {
        id: nextId(),
        name: shortName(name),
        url,
        size: sizeMB(file),
        kind: 'audio',
      },
    };
  }
  if (mime.startsWith('image/') || IMAGE_EXT.test(name)) {
    const url = URL.createObjectURL(file);
    return {
      kind: 'image',
      patch: {
        imageUrl: url,
        imageLabel: name,
      },
    };
  }
  return { kind: 'unsupported', mime, name };
}

/** Accept= attribute that covers everything routeFile() handles. */
export const VJ_FILE_ACCEPT = 'video/*,audio/*,image/*';

export interface RouteFilesResult {
  /** Clips to append to videoBucket (in order). */
  newClips: VideoClip[];
  /** Image backdrop patch, or null. */
  imagePatch: Partial<VJState> | null;
  /** True if any audio file was routed — caller should
   *  auto-enable audioReactive. */
  autoReactive: boolean;
  /** Per-file rejections so the caller can show an error. */
  errors: Array<{ mime: string; name: string }>;
}

/** Multi-file router. Splits files by kind and returns the new bucket
 *  entries + optional image patch + reactivity hint. The caller is
 *  responsible for merging these into VJState — i.e. concatenating
 *  newClips onto the existing videoBucket and picking which becomes
 *  the active clip. */
export function routeFiles(files: File[]): RouteFilesResult {
  const errors: Array<{ mime: string; name: string }> = [];
  const newClips: VideoClip[] = [];
  let imagePatch: Partial<VJState> | null = null;
  let autoReactive = false;

  for (const file of files) {
    const route = routeFile(file);
    if (route.kind === 'unsupported') {
      errors.push({ mime: route.mime, name: route.name });
      continue;
    }
    if (route.kind === 'image') {
      imagePatch = route.patch;
      continue;
    }
    newClips.push(route.clip);
    if (route.kind === 'audio') autoReactive = true;
  }

  return { newClips, imagePatch, autoReactive, errors };
}
