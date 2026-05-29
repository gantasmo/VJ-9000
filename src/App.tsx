import { useState, useEffect, useRef } from 'react';
import { VJState, VideoClip, DEFAULT_VJ_STATE } from './types';
import { useMedia } from './useMedia';
import { useAudioAnalyzer } from './useAudioAnalyzer';
import { useMidi } from './useMidi';
import { VideoOutput } from './components/VideoOutput';
import { ControlDeck } from './components/VJControls';
import { MidiPanel } from './components/MidiPanel';
import { routeFiles, VJ_FILE_ACCEPT } from './fileRouter';
// sa3Bridge has a module-level postMessage listener; importing for
// side effect so it starts listening as soon as the app mounts.
import './sa3Bridge';
import { AlertTriangle, Film, Upload, X as XIcon } from 'lucide-react';

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

  const { videoRef, error, isInitializing } = useMedia(vjState.sourceType, vjState.clipUrl);
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

  const updateState = (updates: Partial<VJState>) => {
    setVjState((prev) => ({ ...prev, ...updates }));
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

    const { newClips, imagePatch, autoReactive, errors } = routeFiles(files);

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
