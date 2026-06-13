import { useState, useEffect, useRef, useCallback } from 'react';
import { VJState, VideoClip, DEFAULT_VJ_STATE } from './types';
import { useMedia } from './useMedia';
import { useAudioAnalyzer } from './useAudioAnalyzer';
import { useMidi } from './useMidi';
import { VideoOutput } from './components/VideoOutput';
import { ControlDeck } from './components/VJControls';
import { MidiPanel } from './components/MidiPanel';
import { routeFiles, VJ_FILE_ACCEPT } from './fileRouter';
import { uploadMediaToLibrary } from './libraryUpload';
import {
  subscribeToLoadSet,
  subscribeToLoadTrack,
  subscribeToMidi,
  subscribeToControlSet,
  subscribeToControlRequests,
  subscribeToCamera,
  sendControlManifest,
  sendControlChanged,
  sendCameraState,
  sendSetLoaded,
  ExternalLoadItem,
} from './sa3Bridge';
import {
  CONTROL_MANIFEST,
  snapshotControlValues,
  coerceControlValue,
  readControlValue,
} from './controlManifest';
import { AlertTriangle, Film, Upload, X as XIcon, ChevronRight, ChevronLeft } from 'lucide-react';

const LOCAL_STORAGE_KEY = 'gantasmo_veejay_state_2';

const loadSavedState = (): VJState => {
  if (typeof window === 'undefined') return DEFAULT_VJ_STATE;
  try {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);

      // Clean up dynamic or temporary runtime attributes to avoid bad states
      parsed.recording = false;
      parsed.layoutMode = 'standard'; // Always reset back to standard to prevent being trapped on refresh

      // Drop session-only blob URLs which won't survive refresh.
      if (parsed.clipUrl && parsed.clipUrl.startsWith('blob:')) {
        parsed.clipUrl = null;
        parsed.clipLabel = null;
        parsed.clipKind = null;
        parsed.activeClipId = null;
      }
      if (parsed.imageUrl && parsed.imageUrl.startsWith('blob:')) {
        parsed.imageUrl = null;
        parsed.imageLabel = null;
      }

      // MIGRATION: Fix old default saturation/contrast values
      if (parsed.saturation === 150) parsed.saturation = 100;
      if (parsed.contrast === 130) parsed.contrast = 100;

      if (parsed.videoBucket) {
        parsed.videoBucket = parsed.videoBucket.filter((c: any) => c && c.url && !c.url.startsWith('blob:'));
      } else {
        parsed.videoBucket = [];
      }

      return { ...DEFAULT_VJ_STATE, ...parsed };
    }
  } catch (e) {
    console.error('Failed to parse VJ state from localStorage:', e);
  }
  return DEFAULT_VJ_STATE;
};

export default function App() {
  const [vjState, setVjState] = useState<VJState>(() => loadSavedState());
  const [routerError, setRouterError] = useState<string | null>(null);
  const [lastSeenCc, setLastSeenCc] = useState<{ cc: number; value: number; channel: number } | null>(null);
  const pendingSa3PlayRef = useRef<Window | null>(null);
  const clipResumeMapRef = useRef<Record<string, number>>({});
  // Right-hand control deck collapse (standard layout only). Lets the user
  // reclaim the full width for the visualizer without leaving standard mode.
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  // ── Control-sync echo guard ──────────────────────────────────────
  // When the SA3 host writes a control into VJState we must NOT echo that same
  // change back to the host (it would fight the host's own fader). We stamp the
  // keys the host just set; the diff-emitter skips them for one tick. We also
  // keep the last-emitted snapshot so we only post controls that actually moved.
  const hostWroteRef = useRef<Set<string>>(new Set());
  const lastSentRef = useRef<Record<string, number | boolean>>({});

  const { videoRef, cameraVideoRef, clipVideoRef, error, isInitializing } = useMedia(vjState.sourceType, vjState.clipUrl);
  const { getAudioLevels } = useAudioAnalyzer(vjState.audioReactive);

  // SA3 → VJ playback commands. The PlayerFooter in SA3 sends
  // { type: 'sa3-vj/playback', action: 'play' | 'pause' } when the
  // user clicks the main Play/Pause button while on the VJ tab. We
  // forward that to the actual <video> element here. After the
  // play/pause settles we echo back the resulting state so SA3's UI
  // shows the right icon.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const d = event.data;
      if (!d || typeof d !== 'object') return;
      if (d.type !== 'sa3-vj/playback') return;
      const video = videoRef.current;
      const echo = (state: 'playing' | 'paused', detail?: string) => {
        try {
          (event.source as Window | null)?.postMessage(
            { type: 'sa3-vj/playback-state', state, detail },
            '*',
          );
        } catch { /* parent not reachable; ignore */ }
      };
      if (d.action === 'play') {
        if (!video) {
          echo('paused', 'video element unavailable');
          return;
        }
        if (vjState.sourceType === 'clip' && !vjState.clipUrl && vjState.videoBucket.length > 0) {
          const fallback = vjState.videoBucket.find((clip) => clip.id === vjState.activeClipId) ?? vjState.videoBucket[0];
          pendingSa3PlayRef.current = event.source as Window | null;
          setVjState((prev) => ({
            ...prev,
            sourceType: 'clip',
            activeClipId: fallback.id,
            clipUrl: fallback.url,
            clipLabel: fallback.name,
            clipKind: fallback.kind ?? 'video',
          }));
          return;
        }
        if (vjState.sourceType === 'clip' && !vjState.clipUrl) {
          echo('paused', 'no clip loaded');
          return;
        }
        video.play().then(() => echo('playing')).catch((err) => {
          echo('paused', err instanceof Error ? err.message : String(err));
        });
      } else if (d.action === 'pause') {
        pendingSa3PlayRef.current = null;
        if (!video) {
          echo('paused', 'video element unavailable');
          return;
        }
        video.pause();
        echo('paused');
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [videoRef, vjState.activeClipId, vjState.clipUrl, vjState.sourceType, vjState.videoBucket]);

  useEffect(() => {
    if (!pendingSa3PlayRef.current || !vjState.clipUrl) return;
    const source = pendingSa3PlayRef.current;
    const video = videoRef.current;
    if (!video) return;
    const echo = (state: 'playing' | 'paused', detail?: string) => {
      try {
        source.postMessage({ type: 'sa3-vj/playback-state', state, detail }, '*');
      } catch { /* parent not reachable; ignore */ }
    };
    const playAfterSrcSettles = () => {
      video.play().then(() => echo('playing')).catch((err) => {
        echo('paused', err instanceof Error ? err.message : String(err));
      });
    };
    if (video.readyState >= 2) playAfterSrcSettles();
    else video.addEventListener('loadeddata', playAfterSrcSettles, { once: true });
    pendingSa3PlayRef.current = null;
    return () => video.removeEventListener('loadeddata', playAfterSrcSettles);
  }, [videoRef, vjState.clipUrl]);

  // Stable identity so the memoized ControlDeck doesn't re-render on unrelated
  // App updates. setVjState is itself stable, so no deps are needed.
  const updateState = useCallback((updates: Partial<VJState>) => {
    setVjState((prev) => ({ ...prev, ...updates }));
  }, []);

  // ── Control sync: SA3 SLIDE tab ⇄ VJ controls ────────────────────
  // (1) Host → VJ: apply inbound control-set writes (range/toggle), marking
  //     each key so the diff-emitter below doesn't echo it back.
  // (2) Host handshake: answer request-controls with the manifest + a live
  //     snapshot so the SLIDE tab can build matching lanes at current values.
  useEffect(() => {
    const unsubSet = subscribeToControlSet(({ key, value }) => {
      const coerced = coerceControlValue(key, value);
      if (coerced === null) return;
      hostWroteRef.current.add(key);
      lastSentRef.current[key] = coerced; // host value is now the known state
      setVjState((prev) => ({ ...prev, [key]: coerced }) as VJState);
    });
    const unsubReq = subscribeToControlRequests(() => {
      setVjState((prev) => {
        const values = snapshotControlValues(prev);
        lastSentRef.current = { ...values };
        sendControlManifest(CONTROL_MANIFEST, values);
        return prev; // read-only snapshot
      });
    });
    return () => { unsubSet(); unsubReq(); };
  }, []);

  // SA3 VJ toolbar → camera on/off. Flip the source between the live camera and
  // the clip/memory buffer (the CAM↔MEM crossfader's two ends).
  useEffect(() => {
    const unsub = subscribeToCamera((on) => {
      setVjState((prev) => ({
        ...prev,
        sourceType: on ? 'camera' : 'clip',
        sourceBlend: on ? 0 : 1,
      }));
    });
    return unsub;
  }, []);

  // Echo the live camera state whenever the source (or its getUserMedia error)
  // changes, so the SA3 toolbar button stays honest even when the source is
  // switched from inside the VJ app (its own controls / the MIDI crossfader).
  useEffect(() => {
    sendCameraState(vjState.sourceType === 'camera', error);
  }, [vjState.sourceType, error]);

  // (3) VJ → Host: whenever VJState changes, emit control-changed for any
  //     manifest control whose value differs from what we last sent — EXCEPT
  //     keys the host just wrote (those are skipped once, then cleared).
  useEffect(() => {
    const skip = hostWroteRef.current;
    for (const entry of CONTROL_MANIFEST) {
      const current = readControlValue(vjState, entry.key);
      if (skip.has(entry.key)) {
        lastSentRef.current[entry.key] = current;
        continue;
      }
      if (lastSentRef.current[entry.key] !== current) {
        lastSentRef.current[entry.key] = current;
        sendControlChanged(entry.key, current);
      }
    }
    hostWroteRef.current = new Set();
  }, [vjState]);

  const normalizeIncomingClip = (item: ExternalLoadItem): VideoClip | null => {
    const rawUrl = typeof item.url === 'string' ? item.url.trim() : '';
    if (!rawUrl) return null;
    const rawKind = typeof item.kind === 'string' ? item.kind.toLowerCase() : '';
    if (rawKind === 'image') return null;
    const kind: VideoClip['kind'] = rawKind === 'audio' ? 'audio' : 'video';
    const label =
      (typeof item.label === 'string' && item.label.trim()) ||
      (typeof item.name === 'string' && item.name.trim()) ||
      (typeof item.title === 'string' && item.title.trim()) ||
      'Imported clip';
    const key =
      (typeof item.entryId === 'string' && item.entryId) ||
      (typeof item.id === 'string' && item.id) ||
      rawUrl;
    return {
      id: `sa3-${key}`,
      name: label.length > 25 ? `${label.slice(0, 21)}...` : label,
      url: rawUrl,
      kind,
    };
  };

  // Web MIDI integration. Mapped CCs / notes patch VJState directly;
  // audio analysis (mic / SA3 parent bridge) still flows independently
  // through useAudioAnalyzer — both drive the visualizer simultaneously.
  const midi = useMidi({
    onCcChange: (cc, value, channel) => setLastSeenCc({ cc, value, channel }),
    onParamChange: (key, value) => {
      setVjState((prev) => ({ ...prev, [key]: value }));
    },
  });

  useEffect(() => {
    try {
      const stateToSave: any = { ...vjState };
      if (stateToSave.videoBucket) {
        stateToSave.videoBucket = stateToSave.videoBucket.filter(
          (c: VideoClip) => c && c.url && !c.url.startsWith('blob:'),
        );
      }
      if (stateToSave.clipUrl && stateToSave.clipUrl.startsWith('blob:')) {
        stateToSave.clipUrl = DEFAULT_VJ_STATE.clipUrl;
        stateToSave.clipLabel = null;
        stateToSave.clipKind = null;
        stateToSave.activeClipId = DEFAULT_VJ_STATE.activeClipId;
      }
      if (stateToSave.imageUrl && stateToSave.imageUrl.startsWith('blob:')) {
        stateToSave.imageUrl = null;
        stateToSave.imageLabel = null;
      }
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(stateToSave));
    } catch (e) {
      console.error('Failed to persist VJState changes to localStorage:', e);
    }
  }, [vjState]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && vjState.layoutMode === 'fullscreen') {
        updateState({ layoutMode: 'standard' });
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [vjState.layoutMode]);

  // SA3 host -> sidecar set/track ingestion. Incoming set entries are
  // appended to the same archive bucket used by local imports, and we
  // activate the most recently loaded clip so DJ->VJ handoff is immediate.
  useEffect(() => {
    const ingest = (items: ExternalLoadItem[]): number => {
      const incoming = items.map(normalizeIncomingClip).filter((c): c is VideoClip => c !== null);
      if (incoming.length === 0) return 0;
      setVjState((prev) => {
        const dedup = new Map(prev.videoBucket.map((clip) => [clip.id, clip]));
        for (const clip of incoming) dedup.set(clip.id, clip);
        const merged = Array.from(dedup.values());
        const activate = incoming[incoming.length - 1];
        return {
          ...prev,
          videoBucket: merged,
          activeClipId: activate.id,
          clipUrl: activate.url,
          clipLabel: activate.name,
          clipKind: activate.kind ?? 'video',
          sourceType: 'clip',
          sourceBlend: 1,
        };
      });
      return incoming.length;
    };

    const unsubSet = subscribeToLoadSet((payload) => {
      sendSetLoaded(ingest(payload.items ?? []), payload.name ?? null);
    });
    const unsubTrack = subscribeToLoadTrack((payload) => {
      sendSetLoaded(ingest(payload.item ? [payload.item] : []), payload.name ?? null);
    });
    return () => {
      unsubSet();
      unsubTrack();
    };
  }, []);

  // Preserve playback position per clip, so switching clips and returning
  // resumes from last position instead of restarting from 0 every time.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onTimeUpdate = () => {
      const id = vjState.activeClipId;
      if (!id || !Number.isFinite(video.currentTime)) return;
      clipResumeMapRef.current[id] = video.currentTime;
    };
    video.addEventListener('timeupdate', onTimeUpdate);
    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
    };
  }, [videoRef, vjState.activeClipId]);

  useEffect(() => {
    const id = vjState.activeClipId;
    if (!id || !vjState.clipUrl) return;
    const resumeAt = clipResumeMapRef.current[id];
    if (typeof resumeAt !== 'number' || resumeAt <= 0) return;
    const video = videoRef.current;
    if (!video) return;
    const restore = () => {
      try {
        const maxStart = Number.isFinite(video.duration) && video.duration > 0
          ? Math.max(0, video.duration - 0.05)
          : Number.POSITIVE_INFINITY;
        video.currentTime = Math.min(resumeAt, maxStart);
      } catch {
        /* some streams reject random seek; ignore */
      }
    };
    if (video.readyState >= 1) restore();
    else video.addEventListener('loadedmetadata', restore, { once: true });
    return () => video.removeEventListener('loadedmetadata', restore);
  }, [videoRef, vjState.activeClipId, vjState.clipUrl]);

  // Host MIDI shortcuts for live set control:
  // - CC1 (mod wheel) maps to CAM↔MEM crossfader
  // - Note C3 (48) selects previous clip
  // - Note D3 (50) selects next clip
  useEffect(() => {
    const moveActive = (dir: -1 | 1) => {
      setVjState((prev) => {
        if (prev.videoBucket.length === 0) return prev;
        const currentIdx = prev.videoBucket.findIndex((c) => c.id === prev.activeClipId);
        const startIdx = currentIdx >= 0 ? currentIdx : 0;
        const nextIdx = (startIdx + dir + prev.videoBucket.length) % prev.videoBucket.length;
        const chosen = prev.videoBucket[nextIdx];
        return {
          ...prev,
          activeClipId: chosen.id,
          clipUrl: chosen.url,
          clipLabel: chosen.name,
          clipKind: chosen.kind ?? 'video',
          sourceType: 'clip',
          sourceBlend: 1,
        };
      });
    };

    const unsub = subscribeToMidi((msg) => {
      const [status, data1, data2] = msg.data;
      const command = status & 0xf0;
      if (command === 0xb0) {
        // CC 1 = crossfader
        if (data1 === 1) {
          const blend = Math.max(0, Math.min(1, (Number(data2) || 0) / 127));
          setVjState((prev) => ({
            ...prev,
            sourceBlend: blend,
            sourceType: blend < 0.5 ? 'camera' : 'clip',
          }));
        }
      } else if (command === 0x90 && data2 > 0) {
        if (data1 === 48) moveActive(-1);
        if (data1 === 50) moveActive(1);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (vjState.layoutMode === 'fullscreen') {
      const elem = document.documentElement;
      if (elem.requestFullscreen) {
        elem.requestFullscreen().catch(() => {});
      }
    } else {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    }
  }, [vjState.layoutMode]);

  // Listen for native exit fullscreen (like physical ESC key press handled by browser)
  useEffect(() => {
     const handleFullscreenChange = () => {
         if (!document.fullscreenElement && vjState.layoutMode === 'fullscreen') {
             updateState({ layoutMode: 'standard' });
         }
     };
     document.addEventListener('fullscreenchange', handleFullscreenChange);
     return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [vjState.layoutMode]);

  const resetState = () => setVjState(DEFAULT_VJ_STATE);

  const handleAutopilotSwitchClip = () => {
    setVjState((prev) => {
      if (prev.videoBucket.length <= 1) return prev;
      const choices = prev.videoBucket.filter(c => c.id !== prev.activeClipId);
      if (choices.length === 0) return prev;
      const index = Math.floor(Math.random() * choices.length);
      const chosen = choices[index];
      return {
        ...prev,
        activeClipId: chosen.id,
        clipUrl: chosen.url,
        clipLabel: chosen.name,
        clipKind: chosen.kind ?? 'video',
      };
    });
  };

  // Auto-advance: when the current clip ends, hop to the next entry
  // in the bucket. Polls the underlying <video> for 'ended' since
  // useMedia owns the ref and we don't want to plumb listeners up.
  useEffect(() => {
    if (!vjState.playlistAutoAdvance || vjState.videoBucket.length < 2) return;
    const id = window.setInterval(() => {
      const v = document.querySelector('video');
      if (v && v.ended) {
        setVjState((prev) => {
          if (prev.videoBucket.length === 0) return prev;
          const currentIdx = prev.videoBucket.findIndex(c => c.id === prev.activeClipId);
          const nextIdx = (currentIdx + 1) % prev.videoBucket.length;
          const chosen = prev.videoBucket[nextIdx];
          return {
            ...prev,
            activeClipId: chosen.id,
            clipUrl: chosen.url,
            clipLabel: chosen.name,
            clipKind: chosen.kind ?? 'video',
          };
        });
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [vjState.playlistAutoAdvance, vjState.videoBucket.length, vjState.activeClipId]);

  /** Multi-file router entry point used by the welcome-state file
   *  picker, the controls deck picker, and the drop handler. Detects
   *  video / audio / image per file. Audio/video clips append to the
   *  bucket; images set the backdrop. Rejects unsupported types with
   *  a soft error banner instead of crashing the renderer. */
  const handleFiles = (filesList: FileList | File[] | null) => {
    if (!filesList) return;
    const files = Array.from(filesList);
    if (files.length === 0) return;

    const { newClips, imagePatch, autoReactive, errors, clipFiles, imageFile } = routeFiles(files);

    if (errors.length > 0) {
      const first = errors[0];
      setRouterError(
        `${errors.length} file${errors.length === 1 ? '' : 's'} skipped — unsupported type (e.g. ${first.mime || '?'} / ${first.name}). Use video / audio / image.`,
      );
      window.setTimeout(() => setRouterError(null), 4500);
    } else {
      setRouterError(null);
    }

    if (newClips.length === 0 && !imagePatch) return;

    setVjState((prev) => {
      const next: VJState = { ...prev };
      if (imagePatch) {
        Object.assign(next, imagePatch);
      }
      if (newClips.length > 0) {
        next.videoBucket = [...prev.videoBucket, ...newClips];
        const activate = newClips[newClips.length - 1];
        next.activeClipId = activate.id;
        next.clipUrl = activate.url;
        next.clipLabel = activate.name;
        next.clipKind = activate.kind ?? 'video';
        next.sourceType = 'clip';
        if (autoReactive) next.audioReactive = true;
      }
      return next;
    });

    // Persist video clips + an image backdrop to the library so the cue
    // survives a reload. The blob URLs above are instant preview; once an
    // upload lands we swap in the stable /api/library/media/<id> URL and
    // revoke the blob. Audio clips stay session-only (not library media).
    void persistImports(clipFiles, imageFile);
  };

  /** Upload originals to the library and swap blob URLs for stable ones.
   *  Best-effort: a failed upload keeps the session blob (works until
   *  reload) so a backend hiccup never loses the clip mid-set. */
  const persistImports = async (
    clipFiles: Array<{ clipId: string; file: File }>,
    imageFile: File | null,
  ) => {
    for (const { clipId, file } of clipFiles) {
      try {
        const up = await uploadMediaToLibrary(file);
        let staleBlob: string | null = null;
        setVjState((prev) => {
          const existing = prev.videoBucket.find((c) => c.id === clipId);
          if (!existing) return prev; // removed before the upload finished
          if (existing.url.startsWith('blob:')) staleBlob = existing.url;
          const videoBucket = prev.videoBucket.map((c) =>
            c.id === clipId ? { ...c, url: up.mediaUrl } : c,
          );
          const patch: Partial<VJState> =
            prev.activeClipId === clipId ? { clipUrl: up.mediaUrl } : {};
          return { ...prev, videoBucket, ...patch };
        });
        // Revoke after the swap settles so the active <video> has already
        // re-pointed at the stable URL (avoids a decode-error flash).
        if (staleBlob) {
          const dead = staleBlob;
          window.setTimeout(() => {
            try { URL.revokeObjectURL(dead); } catch { /* already gone */ }
          }, 2000);
        }
      } catch (e) {
        console.warn('VJ: library persist failed; keeping session clip:', e);
      }
    }

    if (imageFile) {
      try {
        const up = await uploadMediaToLibrary(imageFile);
        let staleBlob: string | null = null;
        setVjState((prev) => {
          if (prev.imageUrl && prev.imageUrl.startsWith('blob:')) staleBlob = prev.imageUrl;
          return { ...prev, imageUrl: up.mediaUrl };
        });
        if (staleBlob) {
          const dead = staleBlob;
          window.setTimeout(() => {
            try { URL.revokeObjectURL(dead); } catch { /* already gone */ }
          }, 2000);
        }
      } catch (e) {
        console.warn('VJ: image persist failed; keeping session backdrop:', e);
      }
    }
  };

  return (
    <div
      className="w-full h-screen flex bg-black text-white overflow-hidden font-sans"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        e.preventDefault();
        handleFiles(e.dataTransfer.files);
      }}
    >

      {/* Master Visualizer Component */}
      <main
        onDoubleClick={() => {
          if (vjState.layoutMode === 'fullscreen') updateState({ layoutMode: 'standard' });
        }}
        title={vjState.layoutMode === 'fullscreen' ? 'Double click to exit fullscreen' : ''}
        className={`
          ${vjState.layoutMode === 'fullscreen' ? 'fixed inset-0 z-50' : 'relative'}
          ${vjState.layoutMode === 'split' ? 'w-1/2 flex-none' : ''}
          ${vjState.layoutMode === 'preview' ? 'w-1/4 flex-none' : ''}
          ${vjState.layoutMode === 'standard' ? 'flex-1' : ''}
          cursor-crosshair bg-black transition-all duration-500
        `}
      >
        {/* Image backdrop layer — sits BEHIND the WebGL canvas so the
            visualizer's effects still compose on top of it. Visible
            only when the user has loaded an image via the file router. */}
        {vjState.imageUrl && (
          <div
            className="absolute inset-0 bg-center bg-no-repeat bg-contain z-0 pointer-events-none"
            style={{ backgroundImage: `url(${vjState.imageUrl})` }}
          />
        )}

        <VideoOutput
           vjState={vjState}
           videoRef={videoRef as any}
           cameraVideoRef={cameraVideoRef as any}
           clipVideoRef={clipVideoRef as any}
           getAudioLevels={getAudioLevels}
           onAutopilotSwitchClip={handleAutopilotSwitchClip}
        />

        {/* "Now loaded" pills — show what file is currently feeding
            the renderer. Image gets its own dismiss button so the
            user can clear it without affecting the audio/video clip. */}
        {(vjState.clipUrl || vjState.imageUrl) && (
          <div className="absolute top-2 left-2 z-30 flex flex-col gap-1 pointer-events-none">
            {vjState.clipUrl && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-black/60 backdrop-blur-sm border border-cyan-500/40 rounded text-[10px] font-mono uppercase tracking-widest text-cyan-200 pointer-events-auto">
                <span className="text-cyan-400">{vjState.clipKind === 'audio' ? 'AUDIO' : 'VIDEO'}</span>
                <span className="text-zinc-300 truncate max-w-60">{vjState.clipLabel || '—'}</span>
                <button
                  className="text-zinc-500 hover:text-rose-300"
                  onClick={() => updateState({ clipUrl: null, clipLabel: null, clipKind: null, activeClipId: null })}
                  title="Eject clip"
                >
                  <XIcon className="w-2.5 h-2.5" />
                </button>
              </div>
            )}
            {vjState.imageUrl && (
              <div className="flex items-center gap-1.5 px-2 py-1 bg-black/60 backdrop-blur-sm border border-purple-500/40 rounded text-[10px] font-mono uppercase tracking-widest text-purple-200 pointer-events-auto">
                <span className="text-purple-400">IMAGE</span>
                <span className="text-zinc-300 truncate max-w-60">{vjState.imageLabel || '—'}</span>
                <button
                  className="text-zinc-500 hover:text-rose-300"
                  onClick={() => updateState({ imageUrl: null, imageLabel: null })}
                  title="Eject image"
                >
                  <XIcon className="w-2.5 h-2.5" />
                </button>
              </div>
            )}
          </div>
        )}

        {routerError && (
          <div className="absolute top-2 right-2 z-40 px-3 py-2 bg-rose-950/80 border border-rose-500/50 rounded text-[10px] font-mono uppercase tracking-widest text-rose-200 pointer-events-none">
            {routerError}
          </div>
        )}

        {/* MIDI overlay — top-right pill that expands into the mapper.
            Sits above the rest of the canvas overlays. */}
        <MidiPanel
          supported={midi.supported}
          ready={midi.ready}
          error={midi.error}
          inputs={midi.inputs}
          mappings={midi.mappings}
          learning={midi.learning}
          setLearning={midi.setLearning}
          setMapping={midi.setMapping}
          resetMappings={midi.resetMappings}
          lastSeenCc={lastSeenCc}
        />

        {isInitializing && (
          <div className="absolute inset-0 flex items-center justify-center flex-col text-zinc-500 font-mono tracking-widest uppercase text-sm bg-black z-30">
            <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin mb-6"></div>
            Loading OMEGA Engine // Wait...
          </div>
        )}

        {vjState.sourceType === 'clip' && !vjState.clipUrl && !vjState.imageUrl && !isInitializing && (
          <div className="absolute inset-0 flex items-center justify-center flex-col text-cyan-500 font-mono text-center p-8 bg-zinc-950 z-30">
            <Film className="w-16 h-16 mb-6 text-cyan-600 opacity-50" />
            <h2 className="text-2xl tracking-widest uppercase mb-3 font-bold text-cyan-500">Awaiting Data Core</h2>
            <p className="text-zinc-500 text-xs uppercase tracking-widest max-w-sm mb-6">
              No media in memory buffer. Drop or select a video / audio / image file to begin synthesizing.
            </p>
            <div className="relative overflow-hidden w-64 h-12 shadow-[0_0_20px_rgba(6,182,212,0.2)]">
              <button className="w-full h-full flex items-center justify-center gap-2 text-xs uppercase font-mono tracking-widest border border-cyan-500/50 bg-cyan-900/20 text-cyan-300 hover:bg-cyan-500/20 transition-colors cursor-pointer">
                <Upload className="w-4 h-4" />
                SELECT LOCAL FILE
              </button>
              <input
                type="file"
                accept={VJ_FILE_ACCEPT}
                multiple
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                onChange={(e) => {
                  handleFiles(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
            <p className="text-[9px] text-zinc-700 mt-4 max-w-sm leading-relaxed">
              Drop files anywhere on this panel. Audio plays and drives the visualizer; images sit as a backdrop behind the canvas.
            </p>
          </div>
        )}

        {error && vjState.sourceType === 'camera' && !isInitializing && (
           <div className="absolute inset-0 flex items-center justify-center flex-col text-red-500 font-mono text-center p-8 bg-zinc-950 z-30">
            <AlertTriangle className="w-16 h-16 mb-6 text-red-600 animate-pulse" />
            <h2 className="text-2xl tracking-widest uppercase mb-3 font-bold text-red-500">Optics Offline</h2>
            <p className="text-red-400 mb-6 bg-red-950/40 p-4 border border-red-900/50 rounded inline-block">
              SYS::ERR {error}
            </p>
            <p className="text-zinc-500 text-xs uppercase tracking-widest max-w-sm">
              Critical failure accessing physical video buffer. Check hardware connections to the mainboard or browser permissions.
            </p>
          </div>
        )}

        {vjState.layoutMode === 'fullscreen' && (
           <button
             onClick={(e) => { e.stopPropagation(); updateState({ layoutMode: 'standard' }); }}
             className="absolute top-4 right-4 bg-black/50 text-white/50 hover:text-white hover:bg-black/80 px-4 py-2 rounded border border-white/10 opacity-0 hover:opacity-100 transition-opacity flex items-center gap-2 group cursor-pointer z-50 text-xs tracking-widest font-mono font-bold"
           >
              ESC / DOUBLE CLICK / CLICK TO EXIT FULLSCREEN
           </button>
        )}
      </main>

      {/* Controller Bus */}
      <aside
         className={`
           ${vjState.layoutMode === 'fullscreen' ? 'translate-x-full absolute right-0 opacity-0 pointer-events-none' : 'relative'}
           ${vjState.layoutMode === 'split' ? 'w-1/2 flex-none' : ''}
           ${vjState.layoutMode === 'preview' ? 'flex-1' : ''}
           ${vjState.layoutMode === 'standard' ? 'w-96 flex-none' : ''}
           z-40 shadow-[-10px_0_30px_rgba(0,0,0,0.8)] border-l border-cyan-900/40 transition-all duration-500 bg-[#111] overflow-hidden
         `}
      >
        <ControlDeck
          state={vjState}
          updateState={updateState}
          reset={resetState}
          hasCameraError={!!error && vjState.sourceType === 'camera'}
        />
      </aside>

    </div>
  );
}
