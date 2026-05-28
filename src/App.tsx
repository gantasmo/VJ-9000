import { useState } from 'react';
import { VJState, DEFAULT_VJ_STATE } from './types';
import { useMedia } from './useMedia';
import { useAudioAnalyzer } from './useAudioAnalyzer';
import { VideoOutput } from './components/VideoOutput';
import { ControlDeck } from './components/VJControls';
import { AlertTriangle, Film, Upload, X as XIcon } from 'lucide-react';
import { routeFile, VJ_FILE_ACCEPT } from './fileRouter';

export default function App() {
  const [vjState, setVjState] = useState<VJState>(DEFAULT_VJ_STATE);
  const [routerError, setRouterError] = useState<string | null>(null);
  const { videoRef, error, isInitializing } = useMedia(vjState.sourceType, vjState.clipUrl);
  const { getAudioLevels } = useAudioAnalyzer(vjState.audioReactive);

  const updateState = (updates: Partial<VJState>) => {
    setVjState((prev) => ({ ...prev, ...updates }));
  };

  /** Single file-router entry point used by the welcome-state file
   *  picker, the controls deck picker, and the drop handler. Detects
   *  video / audio / image; rejects anything else with a soft error
   *  banner instead of crashing the renderer. */
  const handleFile = (file: File | null) => {
    if (!file) return;
    const route = routeFile(file);
    if (route.kind === 'unsupported') {
      setRouterError(
        `Unsupported file type: ${route.mime || 'unknown'} (${route.name}). Use video / audio / image.`,
      );
      window.setTimeout(() => setRouterError(null), 4000);
      return;
    }
    setRouterError(null);
    updateState(route.patch);
  };

  const resetState = () => setVjState(DEFAULT_VJ_STATE);

  return (
    <div
      className="w-full h-screen flex bg-black text-white overflow-hidden font-sans"
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (file) handleFile(file);
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
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                onChange={(e) => {
                  handleFile(e.target.files?.[0] ?? null);
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

      {/* Controller Bus */}
      <aside className="w-96 flex-shrink-0 relative z-50 shadow-[-10px_0_30px_rgba(0,0,0,0.8)] border-l border-cyan-900/40">
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
