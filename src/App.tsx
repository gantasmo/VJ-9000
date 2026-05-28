import { useState, useEffect } from 'react';
import { VJState, DEFAULT_VJ_STATE, PlaylistEntry } from './types';
import { useMedia } from './useMedia';
import { useAudioAnalyzer } from './useAudioAnalyzer';
import { VideoOutput } from './components/VideoOutput';
import { ControlDeck } from './components/VJControls';
import { MidiPanel } from './components/MidiPanel';
import { AlertTriangle, Film, Upload, X as XIcon, SkipForward, SkipBack, ListMusic, Maximize2, Minimize2, ChevronDown, ChevronUp } from 'lucide-react';
import { routeFiles, VJ_FILE_ACCEPT } from './fileRouter';
import { useMidi } from './useMidi';

export default function App() {
  const [vjState, setVjState] = useState<VJState>(DEFAULT_VJ_STATE);
  const [routerError, setRouterError] = useState<string | null>(null);
  const [lastSeenCc, setLastSeenCc] = useState<{ cc: number; value: number; channel: number } | null>(null);
  const { videoRef, error, isInitializing } = useMedia(vjState.sourceType, vjState.clipUrl);
  const { getAudioLevels } = useAudioAnalyzer(vjState.audioReactive);

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

  /** Multi-file router entry point used by the welcome-state file
   *  picker, the controls deck picker, and the drop handler. Detects
   *  video / audio / image per file; multi-select queues audio/video
   *  into the playlist. Rejects anything else with a soft error
   *  banner instead of crashing the renderer. */
  const handleFiles = (files: FileList | File[] | null) => {
    if (!files) return;
    const arr = Array.from(files);
    if (arr.length === 0) return;
    const { patch, errors } = routeFiles(arr);
    if (errors.length > 0) {
      const first = errors[0];
      setRouterError(
        `${errors.length} file${errors.length === 1 ? '' : 's'} skipped — unsupported type (e.g. ${first.mime || '?'} / ${first.name}). Use video / audio / image.`,
      );
      window.setTimeout(() => setRouterError(null), 4500);
    } else {
      setRouterError(null);
    }
    if (Object.keys(patch).length > 0) {
      // If we're appending audio/video to an existing playlist
      // instead of replacing, prepend the existing entries.
      const incoming = patch.playlist as PlaylistEntry[] | undefined;
      const existing = vjState.playlist ?? [];
      if (incoming && incoming.length > 0 && existing.length > 0 && vjState.clipUrl) {
        // Append behaviour: keep current playing, queue new tracks.
        const merged = [...existing, ...incoming];
        updateState({ ...patch, playlist: merged, playlistIndex: vjState.playlistIndex ?? 0, clipUrl: vjState.clipUrl, clipLabel: vjState.clipLabel, clipKind: vjState.clipKind });
      } else {
        updateState(patch);
      }
    }
  };

  /** Switch the active clip to the entry at `idx` in the playlist. */
  const playPlaylistEntry = (idx: number) => {
    const pl = vjState.playlist ?? [];
    if (idx < 0 || idx >= pl.length) return;
    const e = pl[idx];
    updateState({
      clipUrl: e.url,
      clipLabel: e.label,
      clipKind: e.kind,
      sourceType: 'clip',
      playlistIndex: idx,
    });
  };

  const playlistNext = () => {
    const pl = vjState.playlist ?? [];
    if (pl.length === 0) return;
    const i = (vjState.playlistIndex ?? 0) + 1;
    playPlaylistEntry(i >= pl.length ? 0 : i);
  };

  const playlistPrev = () => {
    const pl = vjState.playlist ?? [];
    if (pl.length === 0) return;
    const i = (vjState.playlistIndex ?? 0) - 1;
    playPlaylistEntry(i < 0 ? pl.length - 1 : i);
  };

  // Auto-advance: when the current clip ends, hop to the next entry
  // in the playlist. The video element loops by default for single
  // clips; with a playlist of 2+ we disable loop and listen for
  // 'ended' to advance.
  useEffect(() => {
    const pl = vjState.playlist ?? [];
    if (!vjState.playlistAutoAdvance || pl.length < 2) return;
    const id = window.setInterval(() => {
      // Poll the underlying <video> for 'ended' since useMedia owns
      // the ref and we don't want to plumb listeners up.
      const v = document.querySelector('video');
      if (v && v.ended) playlistNext();
    }, 250);
    return () => window.clearInterval(id);
  }, [vjState.playlist, vjState.playlistAutoAdvance, vjState.playlistIndex, playlistNext]);

  const resetState = () => setVjState(DEFAULT_VJ_STATE);

  // Controls deck collapse/expand. When collapsed the aside shrinks
  // to a thin handle the user can click to expand. When expanded the
  // full ControlDeck is visible.
  const [controlsOpen, setControlsOpen] = useState(true);

  // Fullscreen toggle for the canvas. Uses the document's Fullscreen
  // API; when invoked inside SA3's VJ iframe, the iframe element
  // itself goes fullscreen which is exactly the live-performance
  // workflow the user wants.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {
        /* swallow — some browsers reject if user gesture timed out */
      });
    } else {
      void document.documentElement.requestFullscreen().catch(() => {
        /* swallow */
      });
    }
  };

  return (
    <div
      className="w-full h-screen flex flex-col md:flex-row bg-black text-white overflow-hidden font-sans"
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
      <main className="flex-1 relative cursor-crosshair bg-black">
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
        />

        {/* "Now loaded" pill — shows what file is currently feeding
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
                  onClick={() => updateState({ clipUrl: null, clipLabel: null, clipKind: null })}
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

        {/* Tiny fullscreen toggle pinned to the bottom-right of the
            canvas. Uses the Fullscreen API — when running inside
            SA3's VJ iframe this fullscreens the iframe itself, which
            is what the user wants for live performance. */}
        <button
          type="button"
          onClick={toggleFullscreen}
          className="absolute bottom-2 right-2 z-30 p-1.5 rounded border border-cyan-500/30 bg-black/60 backdrop-blur-sm text-cyan-300 hover:text-cyan-100 hover:bg-cyan-500/15 hover:border-cyan-400/60 transition-colors"
          title={isFullscreen ? 'Exit fullscreen (Esc)' : 'Enter fullscreen'}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
        >
          {isFullscreen ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
        </button>

        {/* MIDI overlay — top-right pill that expands into the
            mapper. Sits above the rest of the canvas overlays. */}
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

        {/* Playlist strip — shown when 2+ audio/video entries queued.
            Lives at the bottom of the canvas; click an entry to jump,
            or use prev/next buttons. Auto-advance toggle on the right. */}
        {(vjState.playlist?.length ?? 0) >= 2 && (
          <div className="absolute bottom-2 left-2 right-2 z-30 bg-black/70 backdrop-blur-sm border border-cyan-500/40 rounded p-2 flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest">
            <ListMusic className="w-3.5 h-3.5 text-cyan-300 shrink-0" />
            <span className="text-cyan-300 font-black">PLAYLIST</span>
            <span className="text-zinc-500">
              {(vjState.playlistIndex ?? 0) + 1} / {vjState.playlist?.length}
            </span>
            <button
              onClick={playlistPrev}
              className="p-1 rounded border border-white/10 hover:bg-white/5 text-zinc-400 hover:text-zinc-100"
              title="Previous track"
            >
              <SkipBack className="w-3 h-3" />
            </button>
            <button
              onClick={playlistNext}
              className="p-1 rounded border border-white/10 hover:bg-white/5 text-zinc-400 hover:text-zinc-100"
              title="Next track"
            >
              <SkipForward className="w-3 h-3" />
            </button>
            <div className="flex-1 min-w-0 overflow-x-auto no-scrollbar flex items-center gap-1">
              {vjState.playlist?.map((e, i) => (
                <button
                  key={e.id}
                  onClick={() => playPlaylistEntry(i)}
                  className={`px-2 py-0.5 rounded border whitespace-nowrap text-[9px] tracking-wider truncate max-w-40 ${
                    i === (vjState.playlistIndex ?? 0)
                      ? 'border-cyan-400/60 bg-cyan-500/20 text-cyan-100'
                      : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
                  }`}
                  title={e.label}
                >
                  <span className="text-cyan-500/70 mr-1">{e.kind === 'audio' ? '♪' : '▶'}</span>
                  {e.label.length > 24 ? e.label.slice(0, 24) + '…' : e.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1 cursor-pointer shrink-0 text-zinc-500 hover:text-zinc-200">
              <input
                type="checkbox"
                checked={vjState.playlistAutoAdvance ?? true}
                onChange={(e) => updateState({ playlistAutoAdvance: e.target.checked })}
                className="accent-cyan-500"
              />
              <span>AUTO</span>
            </label>
            <button
              onClick={() => updateState({ playlist: [], playlistIndex: 0 })}
              className="p-1 rounded border border-rose-500/30 hover:bg-rose-500/10 text-rose-400 hover:text-rose-200"
              title="Clear playlist"
            >
              <XIcon className="w-3 h-3" />
            </button>
          </div>
        )}

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
      </main>

      {/* Controller Bus — full-width strip below the canvas on narrow
          viewports (< md), inline right-side panel on wider screens.
          Collapsible via the handle button; collapsed state is just
          a thin re-open strip so the canvas reclaims that space.
          h-2/5 below md gives the canvas the top 60% when expanded.

          NOTE: when controlsOpen=false the canvas extends to use the
          freed space — both axes (height on narrow, width on wide). */}
      {controlsOpen ? (
        <aside className="w-full md:w-96 h-2/5 md:h-auto flex-shrink-0 relative z-50 shadow-[-10px_0_30px_rgba(0,0,0,0.8)] border-t md:border-t-0 md:border-l border-cyan-900/40 overflow-hidden">
          {/* Collapse handle — pinned at the corner closest to the
              canvas (top edge on narrow viewports, left edge on
              wide). Click to fold the deck. */}
          <button
            type="button"
            onClick={() => setControlsOpen(false)}
            className="absolute z-50 top-1 right-1 md:top-2 md:-left-3 md:right-auto p-1 rounded border border-cyan-500/40 bg-black/70 backdrop-blur-sm text-cyan-300 hover:text-cyan-100 hover:bg-cyan-500/15 hover:border-cyan-400/60 transition-colors"
            title="Collapse controls"
            aria-label="Collapse controls"
          >
            <ChevronDown className="md:hidden w-3 h-3" />
            <XIcon className="hidden md:block w-3 h-3" />
          </button>
          <ControlDeck
            state={vjState}
            updateState={updateState}
            reset={resetState}
            hasCameraError={!!error && vjState.sourceType === 'camera'}
          />
        </aside>
      ) : (
        // Re-open handle when collapsed. Narrow: thin strip across the
        // bottom of the screen. Wide: thin vertical strip pinned to
        // the right edge. Either way clicking it brings the controls
        // back without losing any state.
        <button
          type="button"
          onClick={() => setControlsOpen(true)}
          className="w-full md:w-6 h-6 md:h-auto shrink-0 z-50 flex items-center justify-center border-t md:border-t-0 md:border-l border-cyan-500/40 bg-black/80 text-cyan-300 hover:bg-cyan-500/10 hover:text-cyan-100 transition-colors"
          title="Show controls"
          aria-label="Show controls"
        >
          <ChevronUp className="md:hidden w-4 h-4" />
          <ChevronDown className="hidden md:block w-4 h-4 rotate-90" />
        </button>
      )}
      
    </div>
  );
}
