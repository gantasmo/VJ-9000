import { useState, useEffect } from 'react';
import { VJState, DEFAULT_VJ_STATE, DEFAULT_CLIPS } from './types';
import { useMedia } from './useMedia';
import { useAudioAnalyzer } from './useAudioAnalyzer';
import { VideoOutput } from './components/VideoOutput';
import { ControlDeck } from './components/VJControls';
import { AlertTriangle, Film, Upload } from 'lucide-react';

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
      
      // If we saved a blob URL which is session-bound, we must drop it because it won't work across refreshes
      if (parsed.clipUrl && parsed.clipUrl.startsWith('blob:')) {
        parsed.clipUrl = null;
        parsed.activeClipId = null;
      }
      
      // MIGRATION: Fix old default saturation/contrast values
      if (parsed.saturation === 150) parsed.saturation = 100;
      if (parsed.contrast === 130) parsed.contrast = 100;

      if (parsed.videoBucket) {
        // filter out invalid blob clips
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
  const { videoRef, error, isInitializing } = useMedia(vjState.sourceType, vjState.clipUrl);
  const { getAudioLevels } = useAudioAnalyzer(vjState.audioReactive);

  useEffect(() => {
    try {
      const stateToSave = { ...vjState };
      // Filter out raw blob objects or blob URLs which are session-temporary
      if (stateToSave.videoBucket) {
        stateToSave.videoBucket = stateToSave.videoBucket.filter(c => c && c.url && !c.url.startsWith('blob:'));
      }
      if (stateToSave.clipUrl && stateToSave.clipUrl.startsWith('blob:')) {
        stateToSave.clipUrl = DEFAULT_VJ_STATE.clipUrl;
        stateToSave.activeClipId = DEFAULT_VJ_STATE.activeClipId;
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

  const updateState = (updates: Partial<VJState>) => {
    setVjState((prev) => ({ ...prev, ...updates }));
  };

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
        clipUrl: chosen.url
      };
    });
  };

  const addVideoToBucket = (filesList: FileList) => {
    const files = Array.from(filesList);
    if (files.length === 0) return;

    const newClips = files.map((file) => {
      const url = URL.createObjectURL(file);
      const id = `clip-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      return {
        id,
        name: file.name.length > 25 ? file.name.substring(0, 22) + "..." : file.name,
        url,
        size: `${sizeMB} MB`
      };
    });

    setVjState((prev) => ({
      ...prev,
      videoBucket: [...prev.videoBucket, ...newClips],
      activeClipId: newClips[newClips.length - 1].id,
      clipUrl: newClips[newClips.length - 1].url,
      sourceType: 'clip'
    }));
  };

  return (
    <div className="w-full h-screen flex bg-black text-white overflow-hidden font-sans">
      
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
        <VideoOutput 
           vjState={vjState} 
           videoRef={videoRef as any} 
           getAudioLevels={getAudioLevels} 
           onAutopilotSwitchClip={handleAutopilotSwitchClip}
        />

        {isInitializing && (
          <div className="absolute inset-0 flex items-center justify-center flex-col text-zinc-500 font-mono tracking-widest uppercase text-sm bg-black z-30">
            <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin mb-6"></div>
            Loading OMEGA Engine // Wait...
          </div>
        )}

        {vjState.sourceType === 'clip' && !vjState.clipUrl && !isInitializing && (
          <div className="absolute inset-0 flex items-center justify-center flex-col text-cyan-500 font-mono text-center p-8 bg-zinc-950 z-30">
            <Film className="w-16 h-16 mb-6 text-cyan-600 opacity-50" />
            <h2 className="text-2xl tracking-widest uppercase mb-3 font-bold text-cyan-500">Awaiting Data Core</h2>
            <p className="text-zinc-500 text-xs uppercase tracking-widest max-w-sm mb-6">
              No video media found in memory buffer. Please inject a clip below to begin synthesizing.
            </p>
            <div className="relative overflow-hidden w-64 h-12 shadow-[0_0_20px_rgba(6,182,212,0.2)]">
              <button className="w-full h-full flex items-center justify-center gap-2 text-xs uppercase font-mono tracking-widest border border-cyan-500/50 bg-cyan-900/20 text-cyan-300 hover:bg-cyan-500/20 transition-colors cursor-pointer">
                <Upload className="w-4 h-4" />
                SELECT LOCAL FILE
              </button>
              <input
                type="file"
                accept="video/*"
                multiple
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                onChange={(e) => {
                  const files = e.target.files;
                  if (files && files.length > 0) {
                    addVideoToBucket(files);
                  }
                }}
              />
            </div>
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
