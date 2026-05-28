import { useState } from 'react';
import { VJState, DEFAULT_VJ_STATE } from './types';
import { useMedia } from './useMedia';
import { useAudioAnalyzer } from './useAudioAnalyzer';
import { VideoOutput } from './components/VideoOutput';
import { ControlDeck } from './components/VJControls';
import { AlertTriangle, Film, Upload } from 'lucide-react';

export default function App() {
  const [vjState, setVjState] = useState<VJState>(DEFAULT_VJ_STATE);
  const { videoRef, error, isInitializing } = useMedia(vjState.sourceType, vjState.clipUrl);
  const { getAudioLevels } = useAudioAnalyzer(vjState.audioReactive);

  const updateState = (updates: Partial<VJState>) => {
    setVjState((prev) => ({ ...prev, ...updates }));
  };

  const resetState = () => setVjState(DEFAULT_VJ_STATE);

  return (
    <div className="w-full h-screen flex bg-black text-white overflow-hidden font-sans">
      
      {/* Master Visualizer Component */}
      <main className="flex-1 relative cursor-crosshair bg-black">
        <VideoOutput 
           vjState={vjState} 
           videoRef={videoRef as any} 
           getAudioLevels={getAudioLevels} 
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
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const url = URL.createObjectURL(file);
                    updateState({ clipUrl: url, sourceType: 'clip' });
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
