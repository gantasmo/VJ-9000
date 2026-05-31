import React, { useState } from 'react';
import { VJState, DEFAULT_VJ_STATE } from '../types';
import { Activity, RefreshCcw, Upload, Sliders, Cpu, Radio, Hash, Video, LayoutPanelLeft, Columns, Monitor, Maximize, FolderOpen } from 'lucide-react';
import { PluginsPanel } from './PluginsPanel';

const AUTOPILOT_EFFECTS = [
  { key: 'feedback', label: 'Feedback Wash' },
  { key: 'glitch', label: 'Digital Glitch' },
  { key: 'rgbSplit', label: 'Anaglyph Split' },
  { key: 'waveWarp', label: 'Wave Warp' },
  { key: 'pixelate', label: 'Pixel Destroy' },
  { key: 'chromaAb', label: 'Chroma Ab' },
  { key: 'backskip', label: 'Buffer Skip' },
  { key: 'playbackSpeed', label: 'Playback Speed' },
  { key: 'reversePlayback', label: 'Reverse Shuttles' },
  { key: 'posterizeTime', label: 'Stutter Limit' },
  { key: 'echoTrails', label: 'Motion Echoes' },
  { key: 'slitScan', label: 'Slit Scan' },
  { key: 'timeDisplace', label: 'Time Displace' },
  { key: 'kaleido', label: 'Kaleidoscope' },
  { key: 'mirrorX', label: 'Horizontal Mirror' },
  { key: 'mirrorY', label: 'Vertical Mirror' },
  { key: 'edgeDetect', label: 'Neon Edge Trace' },
  { key: 'equirect', label: 'Panoramic Warp' },
];

interface ControlsProps {
  state: VJState;
  updateState: (updates: Partial<VJState>) => void;
  reset: () => void;
  hasCameraError: boolean;
}

// Memoized so the deck only re-renders when its props actually change — not
// every time the parent App re-renders for an unrelated reason. updateState is
// stabilized with useCallback in App so this memo bites.
function ControlDeckImpl({ state, updateState, reset, hasCameraError }: ControlsProps) {
  const [showWeights, setShowWeights] = useState(true);
  const [showApDynamics, setShowApDynamics] = useState(false);
  const [showExportFolder, setShowExportFolder] = useState(false);
  
  const Fader = ({ label, value, min, max, step=0.01, onChange, unit="", paramKey }: any) => {
    const percentage = ((value - min) / (max - min)) * 100;
    const apActiveGlobally = state.autoPilot;
    const apWeight = paramKey && state.apWeights ? (state.apWeights[paramKey] ?? 1.0) : 1.0;
    
    const handleDoubleClick = () => {
      if (paramKey && (DEFAULT_VJ_STATE as any)[paramKey] !== undefined) {
          onChange((DEFAULT_VJ_STATE as any)[paramKey]);
      }
    };
    
    return (
      <div className="flex flex-col mb-2.5 group relative">
        <div className="flex justify-between items-center text-[10px] text-zinc-500 uppercase tracking-widest font-mono mb-1 focus-within:text-cyan-400">
          <div className="flex items-center gap-2 cursor-pointer" onDoubleClick={handleDoubleClick} title="Double click to reset">
            <span className="group-hover:text-cyan-400 transition-colors">{label}</span>
          </div>
          <div className="flex gap-2 items-center">
             {apActiveGlobally && paramKey && (
                <div className="flex items-center gap-1 group/ap tooltip" title="Autopilot Probability (0=Off, 1=Max)">
                   <span className="text-[8px] text-red-500/70">AP:</span>
                   <input
                      type="range" min="0" max="1" step="0.05"
                      value={apWeight}
                      onChange={(e) => updateState({ apWeights: { ...(state.apWeights || {}), [paramKey]: parseFloat(e.target.value) } })}
                      className="w-12 h-1 accent-red-500 bg-red-950 rounded-sm cursor-col-resize opacity-50 group-hover/ap:opacity-100 transition-opacity"
                   />
                </div>
             )}
             <span className="text-zinc-300">{typeof value === 'number' ? value.toFixed(step >= 1 ? 0 : 2) : value}{unit}</span>
          </div>
        </div>
        <div className={`relative w-full h-5 bg-black rounded-sm overflow-hidden cursor-crosshair border shadow-inner transition-colors ${apActiveGlobally && apWeight > 0 ? 'border-red-900/50 opacity-70' : 'border-zinc-800 group-hover:border-zinc-700'}`}>
           <div 
             className="absolute top-0 left-0 h-full bg-gradient-to-r from-cyan-900 to-cyan-500 border-r border-cyan-300 pointer-events-none" 
             style={{ width: `${percentage}%` }} 
           />
           <input
              type="range" min={min} max={max} step={step} value={value}
              onChange={(e) => onChange(Number(e.target.value))}
              className="absolute inset-0 w-full h-full opacity-0 cursor-crosshair"
           />
        </div>
      </div>
    );
  };

  const TogglePad = ({ label, active, onClick, highlight = 'cyan', flex = false, paramKey }: any) => {
    const activeColors: Record<string, string> = {
      cyan: 'bg-cyan-900/30 border-cyan-500 text-cyan-300 shadow-[0_0_15px_rgba(6,182,212,0.3)]',
      red: 'bg-red-900/30 border-red-500 text-red-300 shadow-[0_0_15px_rgba(239,68,68,0.3)]',
      purple: 'bg-purple-900/30 border-purple-500 text-purple-300 shadow-[0_0_15px_rgba(168,85,247,0.3)]'
    };

    const apActiveGlobally = state.autoPilot;
    const apWeight = paramKey && state.apWeights ? (state.apWeights[paramKey] ?? 1.0) : 1.0;

    return (
      <div className={`relative flex flex-col ${flex ? 'flex-1' : ''}`}>
        {apActiveGlobally && paramKey && (
           <div className="absolute -top-2 left-0 right-0 flex justify-center z-10 group/ap tooltip" title="AutoPilot Probability (0=Off, 1=Max)">
               <input
                  type="range" min="0" max="1" step="0.05"
                  value={apWeight}
                  onChange={(e) => updateState({ apWeights: { ...(state.apWeights || {}), [paramKey]: parseFloat(e.target.value) } })}
                  className="w-8 h-[2px] accent-red-500 bg-red-950 rounded-sm cursor-col-resize opacity-50 group-hover/ap:opacity-100 transition-opacity"
               />
           </div>
        )}
        <button
           onClick={onClick}
           className={`h-7 px-2 text-[10px] uppercase font-mono tracking-widest border transition-all select-none rounded-sm w-full ${
              active
                ? activeColors[highlight]
                : `bg-black border-zinc-800 hover:border-zinc-500 transition-colors ${apActiveGlobally && apWeight > 0 ? 'text-red-900/50' : 'text-zinc-600 hover:text-zinc-400'}`
           }`}
        >
          {label}
        </button>
      </div>
    );
  };

  const updateApConfig = (key: keyof VJState['apConfig'], val: any) => {
    updateState({ apConfig: { ...state.apConfig, [key]: val } });
  };

  const apActive = state.autoPilot;
  const apGeo = apActive && state.apConfig.geo;
  const apCorrupt = apActive && state.apConfig.corrupt;
  const apColor = apActive && state.apConfig.color;
  const apTimecode = apActive && state.apConfig.timecode;

  return (
    <div className="h-full bg-[#111] border-l border-zinc-800 flex flex-col items-stretch overflow-y-auto w-full shrink-0 custom-scrollbar">
      {/* Header — tightened: smaller title font, single line of padding,
          subtitle sits flush under title. Layout-mode + reset buttons
          shrink to icon-fit. */}
      <div className="px-2 py-1.5 border-b border-zinc-800 flex items-center justify-between gap-1 sticky top-0 bg-[#111] z-50 shadow-md">
        {/* REC + export controls — replaces the former LUMINA // OMEGA
            branding. Viewport-layout + reset buttons stay on the right. */}
        <div className="flex items-center gap-1 min-w-0">
          <button
            onClick={() => updateState({ recording: !state.recording })}
            className={`flex items-center gap-1 px-2 py-1 text-[9px] uppercase font-mono tracking-widest border rounded transition-all shrink-0 ${
              state.recording
                ? 'bg-red-900/30 border-red-500 text-red-300 shadow-[0_0_12px_rgba(239,68,68,0.5)] animate-pulse'
                : 'bg-black border-zinc-700 text-zinc-400 hover:border-red-500 hover:text-red-400'
            }`}
            title={state.recording ? 'Stop & export the take to the selected codec' : 'Start recording — exports to the selected codec on stop'}
          >
            <span className={`w-2 h-2 rounded-full ${state.recording ? 'bg-red-500' : 'bg-red-900/50'}`} />
            {state.recording ? 'STOP' : 'REC'}
          </button>
          {/* Resolution — locked mid-take so a switch can't tear the
              captureStream output. */}
          <select
            value={state.recordQuality ?? '1080p'}
            onChange={(e) => updateState({ recordQuality: e.target.value as '720p' | '1080p' | '4K' })}
            disabled={state.recording}
            className="bg-black border border-zinc-700 text-[9px] font-mono uppercase tracking-wider text-zinc-300 px-1 py-1 rounded cursor-pointer hover:border-red-500/50 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            title="Recording resolution — HD 720p · FHD 1080p · UHD 4K. Locks during a take."
          >
            <option value="720p">HD</option>
            <option value="1080p">FHD</option>
            <option value="4K">UHD</option>
          </select>
          {/* Delivery codec — the backend ffmpeg-transcodes the webm take
              into this on stop. */}
          <select
            value={state.recordCodec ?? 'h264'}
            onChange={(e) => updateState({ recordCodec: e.target.value as VJState['recordCodec'] })}
            disabled={state.recording}
            className="bg-black border border-zinc-700 text-[9px] font-mono uppercase tracking-wider text-zinc-300 px-1 py-1 rounded cursor-pointer hover:border-red-500/50 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
            title="Export codec — H264/H265 → .mp4 · ProRes → .mov · PNG SEQ → zipped frames + WAV. Locks during a take."
          >
            <option value="h264">H264</option>
            <option value="h265">H265</option>
            <option value="prores">ProRes</option>
            <option value="pngseq">PNG SEQ</option>
          </select>
          <button
            type="button"
            onClick={() => setShowExportFolder((v) => !v)}
            disabled={state.recording}
            className={`p-1 rounded border transition-colors shrink-0 disabled:opacity-50 disabled:cursor-not-allowed ${
              showExportFolder
                ? 'border-red-500/50 bg-red-500/10 text-red-300'
                : 'border-zinc-700 bg-black text-zinc-400 hover:border-red-500/50 hover:text-red-300'
            }`}
            title="Set export subfolder"
            aria-label="Set export subfolder"
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
          {hasCameraError && (
            <span
              className="text-[8px] font-mono uppercase tracking-wider text-red-500 shrink-0"
              title="Camera offline / sys error"
            >
              CAM ERR
            </span>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <button
             onClick={() => updateState({ layoutMode: 'standard' })}
             className={`p-1 rounded transition-colors ${state.layoutMode === 'standard' ? 'text-cyan-400 bg-cyan-900/40 border border-cyan-800' : 'text-zinc-600 bg-black border border-zinc-800 hover:text-white hover:border-zinc-500 hover:bg-zinc-800'}`}
             title="Standard Layout"
          >
            <LayoutPanelLeft className="w-3.5 h-3.5" />
          </button>
          <button
             onClick={() => updateState({ layoutMode: 'split' })}
             className={`p-1 rounded transition-colors ${state.layoutMode === 'split' ? 'text-cyan-400 bg-cyan-900/40 border border-cyan-800' : 'text-zinc-600 bg-black border border-zinc-800 hover:text-white hover:border-zinc-500 hover:bg-zinc-800'}`}
             title="50/50 Split Layout"
          >
            <Columns className="w-3.5 h-3.5" />
          </button>
          <button
             onClick={() => updateState({ layoutMode: 'preview' })}
             className={`p-1 rounded transition-colors ${state.layoutMode === 'preview' ? 'text-cyan-400 bg-cyan-900/40 border border-cyan-800' : 'text-zinc-600 bg-black border border-zinc-800 hover:text-white hover:border-zinc-500 hover:bg-zinc-800'}`}
             title="Preview (Resolume Style)"
          >
            <Monitor className="w-3.5 h-3.5" />
          </button>
          <button
             onClick={() => updateState({ layoutMode: 'fullscreen' })}
             className={`p-1 rounded transition-colors ${state.layoutMode === 'fullscreen' ? 'text-cyan-400 bg-cyan-900/40 border border-cyan-800' : 'text-zinc-600 bg-black border border-zinc-800 hover:text-white hover:border-zinc-500 hover:bg-zinc-800'}`}
             title="Fullscreen Output"
          >
            <Maximize className="w-3.5 h-3.5" />
          </button>

          <div className="w-px h-5 bg-zinc-800 mx-0.5"></div>

          <button onClick={reset} className="p-1 text-zinc-600 bg-black border border-zinc-800 rounded hover:text-white hover:border-zinc-500 hover:bg-zinc-800 transition-colors" title="Master Reset">
            <RefreshCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {showExportFolder && (
        <div className="bg-zinc-950 border-b border-zinc-800 px-2 py-1 flex items-center gap-1.5">
          <FolderOpen className="w-3 h-3 text-zinc-500 shrink-0" />
          <input
            type="text"
            value={state.exportSubfolder ?? ''}
            onChange={(e) => updateState({ exportSubfolder: e.target.value })}
            disabled={state.recording}
            placeholder="export subfolder (optional)"
            spellCheck={false}
            className="flex-1 min-w-0 bg-black border border-zinc-800 text-[9px] font-mono text-zinc-300 px-1.5 py-1 rounded placeholder:text-zinc-700 focus:border-red-500/50 focus:outline-none disabled:opacity-50"
            title="Subfolder under the configured export root. Leave blank to save into the root."
          />
        </div>
      )}
      
      {/* INPUT DECK — moved up above the autopilot override per UX
          spec. Houses the CAM/MEM crossfader, Canvas Format, MUTE +
          IMPORT controls, and the Archive Bin. */}
      <section className="mx-3 mt-3 mb-0 p-3 border border-zinc-800 bg-black/30 rounded space-y-3">
        <h2 className="text-[10px] text-zinc-400 uppercase tracking-widest font-mono border-b border-zinc-800 pb-1 mb-1 flex items-center gap-2">
          <Radio className="w-3 h-3 text-fuchsia-500" /> SOURCE // MATRIX
        </h2>

        {/* CAM/MEM toggles + crossfader. sourceBlend is the canonical
            control; sourceType is derived from it (<0.5 = CAM, >=0.5 =
            MEM) so the current renderer keeps working at the extremes. */}
        <div>
          <div className="grid grid-cols-2 gap-2 mb-1.5">
            <TogglePad
              label="CAM (Live)"
              active={state.sourceType === 'camera'}
              onClick={() => updateState({ sourceType: 'camera', sourceBlend: 0 })}
              highlight="purple"
            />
            <TogglePad
              label="MEM (Clip)"
              active={state.sourceType === 'clip'}
              onClick={() => updateState({ sourceType: 'clip', sourceBlend: 1 })}
              highlight="purple"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[8px] font-mono uppercase tracking-widest text-purple-300/60 shrink-0">CAM</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={state.sourceBlend ?? (state.sourceType === 'clip' ? 1 : 0)}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                updateState({
                  sourceBlend: v,
                  sourceType: v < 0.5 ? 'camera' : 'clip',
                });
              }}
              className="flex-1 h-1.5 accent-purple-500 bg-zinc-900 rounded-sm cursor-col-resize"
              title="Crossfade CAM ↔ MEM"
            />
            <span className="text-[8px] font-mono uppercase tracking-widest text-purple-300/60 shrink-0">MEM</span>
          </div>
        </div>

        {/* Canvas Format */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono">Canvas Format</span>
          <div className="grid grid-cols-6 gap-1">
            <TogglePad label="FREE" active={state.aspectRatio === 'free'} onClick={() => updateState({ aspectRatio: 'free' })} highlight="purple" />
            <TogglePad label="16:9" active={state.aspectRatio === '16:9'} onClick={() => updateState({ aspectRatio: '16:9' })} highlight="purple" />
            <TogglePad label="4:3" active={state.aspectRatio === '4:3'} onClick={() => updateState({ aspectRatio: '4:3' })} highlight="purple" />
            <TogglePad label="9:16" active={state.aspectRatio === '9:16'} onClick={() => updateState({ aspectRatio: '9:16' })} highlight="purple" />
            <TogglePad label="1:1" active={state.aspectRatio === '1:1'} onClick={() => updateState({ aspectRatio: '1:1' })} highlight="purple" />
            <TogglePad label="21:9" active={state.aspectRatio === '21:9'} onClick={() => updateState({ aspectRatio: '21:9' })} highlight="purple" />
          </div>
        </div>

        {/* MUTE (square) + SELECT & IMPORT VIDEO CLIPS row. MUTE is the
            user-requested rename of the old "CLIP AUDIO ON/OFF" wide bar. */}
        <div className="flex gap-2 items-stretch">
          <button
            onClick={() => updateState({ clipAudio: !state.clipAudio })}
            className={`w-12 h-12 shrink-0 flex flex-col items-center justify-center text-[9px] uppercase font-mono font-bold tracking-widest border rounded transition-all ${
              state.clipAudio
                ? 'bg-purple-900/40 border-purple-500/60 text-purple-200 shadow-[0_0_10px_rgba(168,85,247,0.2)]'
                : 'bg-black border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300'
            }`}
            title={state.clipAudio ? 'Clip audio is ON — click to MUTE' : 'Clip audio is MUTED — click to unmute'}
            aria-label="Mute clip audio"
          >
            {state.clipAudio ? 'AUDIO' : 'MUTE'}
            <span className="text-[7px] mt-0.5 opacity-70">{state.clipAudio ? 'ON' : 'OFF'}</span>
          </button>
          <div className="relative overflow-hidden flex-1">
            <button className="w-full h-12 flex items-center justify-center gap-2 text-[10px] uppercase font-mono tracking-widest border border-dashed border-zinc-700 bg-zinc-800/10 text-zinc-400 hover:bg-purple-950/20 hover:border-purple-500 hover:text-purple-300 transition-all rounded-sm cursor-pointer">
              <Upload className="w-4 h-4" />
              SELECT &amp; IMPORT VIDEO CLIPS
            </button>
            <input
              type="file"
              accept="video/*,audio/*,image/*"
              multiple
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer text-[0px]"
              onChange={(e) => {
                const files = e.target.files;
                if (files && files.length > 0) {
                  const newClips = Array.from(files).map((file: any) => {
                    const url = URL.createObjectURL(file as File);
                    const id = `clip-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
                    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
                    return {
                      id,
                      name: file.name.length > 25 ? file.name.substring(0, 21) + "..." : file.name,
                      url,
                      size: `${sizeMB} MB`,
                    };
                  });
                  const mergedBucket = [...(state.videoBucket || []), ...newClips];
                  updateState({
                    videoBucket: mergedBucket,
                    activeClipId: newClips[newClips.length - 1].id,
                    clipUrl: newClips[newClips.length - 1].url,
                    sourceType: 'clip',
                    sourceBlend: 1,
                  });
                  e.target.value = '';
                }
              }}
            />
          </div>
        </div>

        {/* Archive Bin — only shown when MEM clips exist. Moved up
            with the rest of the input controls. */}
        {state.videoBucket && state.videoBucket.length > 0 && (
          <div className="border border-zinc-800/70 bg-black/60 p-2 rounded-sm shadow-inner">
            <div className="flex justify-between items-center mb-1.5 pb-1 border-b border-zinc-900">
              <span className="text-[9px] text-zinc-500 uppercase tracking-widest font-mono">
                ARCHIVE BIN / CLIPS ({state.videoBucket.length})
              </span>
              <button
                onClick={() => updateState({ videoBucket: [], activeClipId: null, clipUrl: null })}
                className="text-[8px] text-zinc-600 hover:text-red-400 uppercase font-mono tracking-wider transition-colors"
              >
                Purge Bin
              </button>
            </div>
            <div className="space-y-1 max-h-40 overflow-y-auto custom-scrollbar">
              {state.videoBucket.map((clip) => {
                const isActive = state.activeClipId === clip.id;
                return (
                  <div
                    key={clip.id}
                    className={`flex items-center justify-between p-1.5 rounded transition-all ${
                      isActive
                        ? 'bg-purple-950/20 border border-purple-500/50 text-purple-300 shadow-[0_0_10px_rgba(168,85,247,0.1)]'
                        : 'bg-zinc-950/80 border border-zinc-900 text-zinc-500 hover:border-zinc-800 hover:text-zinc-300'
                    }`}
                  >
                    <button
                      onClick={() => {
                        updateState({ activeClipId: clip.id, clipUrl: clip.url, sourceType: 'clip', sourceBlend: 1 });
                      }}
                      className="flex-1 flex flex-col min-w-0 pr-2 align-middle text-left cursor-pointer"
                    >
                      <span className="text-[10px] font-mono truncate font-medium tracking-wide">
                        {clip.name}
                      </span>
                      {clip.size && (
                        <span className="text-[8px] font-mono text-zinc-600">
                          SIZE: {clip.size}
                        </span>
                      )}
                    </button>
                    {state.videoBucket.length > 1 && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const filtered = state.videoBucket.filter(c => c.id !== clip.id);
                          let nextActive = state.activeClipId;
                          let nextUrl = state.clipUrl;
                          if (clip.id === state.activeClipId) {
                            nextActive = filtered[0]?.id || null;
                            nextUrl = filtered[0]?.url || null;
                          }
                          updateState({
                            videoBucket: filtered,
                            activeClipId: nextActive,
                            clipUrl: nextUrl,
                          });
                        }}
                        className="p-1 hover:bg-red-950/30 text-zinc-600 hover:text-red-400 rounded transition-colors"
                        title="Delete clip"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {apActive && (
         <div className="mx-3 mt-3 mb-0 p-3 border border-red-900/50 bg-red-950/20 rounded shadow-[inset_0_0_20px_rgba(239,68,68,0.05)]">
            <h2 className="text-red-500 font-mono text-[11px] uppercase tracking-widest mb-3 flex items-center gap-2 font-bold">
               <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.8)]"></span>
               NEURAL AUTOPILOT OVERRIDE
            </h2>
            
            <div className="grid grid-cols-4 gap-1 mb-3">
               <TogglePad label="GEO // A" active={state.apConfig.geo} onClick={() => updateApConfig('geo', !state.apConfig.geo)} highlight="red" flex />
               <TogglePad label="CRPT // B" active={state.apConfig.corrupt} onClick={() => updateApConfig('corrupt', !state.apConfig.corrupt)} highlight="red" flex />
               <TogglePad label="CLR // C" active={state.apConfig.color} onClick={() => updateApConfig('color', !state.apConfig.color)} highlight="red" flex />
               <TogglePad label="TIME // D" active={state.apConfig.timecode} onClick={() => updateApConfig('timecode', !state.apConfig.timecode)} highlight="red" flex />
            </div>
            
            <Fader label="Cycle Frequency (Speed)" min={0.1} max={5} step={0.1} value={state.apConfig.speed} onChange={(v: number) => updateApConfig('speed', v)} unit="x" />
            <Fader label="Entropy (Chaos)" min={0.1} max={1.5} step={0.05} value={state.apConfig.chaos} onChange={(v: number) => updateApConfig('chaos', v)} />
            
            {/* LIKELIHOOD RATIO DECK */}
            <div className="pt-3 border-t border-red-950/40 mt-3 space-y-3">
               <button 
                 type="button"
                 onClick={() => setShowWeights(!showWeights)}
                 className="w-full flex items-center justify-between text-left cursor-pointer group"
               >
                  <span className="text-[10px] text-red-400 uppercase tracking-widest font-mono font-bold flex items-center gap-1.5 select-none">
                     <Sliders className="w-3.5 h-3.5 text-red-505" />
                     AUTOPILOT PROBABILITY SLIDERS
                  </span>
                  <span className="text-[9px] text-zinc-500 group-hover:text-red-400 transition-colors font-mono uppercase select-none">
                     {showWeights ? '[ Hide ]' : '[ Customise ]'}
                  </span>
               </button>

               {showWeights && (
                  <div className="space-y-3">
                     <div className="flex gap-1">
                        <button
                           type="button"
                           onClick={() => {
                              const maxed: Record<string, number> = {};
                              AUTOPILOT_EFFECTS.forEach(e => { maxed[e.key] = 2.0; });
                              updateState({ apWeights: maxed });
                           }}
                           className="flex-1 py-1 font-mono text-[8px] uppercase tracking-wider bg-red-950/20 border border-red-900/30 text-red-400 hover:border-red-500 hover:text-red-350 rounded transition-all cursor-pointer text-center select-none"
                        >
                           MAX LIKELIHOOD
                        </button>
                        <button
                           type="button"
                           onClick={() => {
                              const muted: Record<string, number> = {};
                              AUTOPILOT_EFFECTS.forEach(e => { muted[e.key] = 0.0; });
                              updateState({ apWeights: muted });
                           }}
                           className="flex-1 py-1 font-mono text-[8px] uppercase tracking-wider bg-black border border-zinc-900 text-zinc-500 hover:border-zinc-700 hover:text-zinc-350 hover:bg-zinc-950 rounded transition-all cursor-pointer text-center select-none"
                        >
                           DISABLE ALL
                        </button>
                        <button
                           type="button"
                           onClick={() => {
                              updateState({ apWeights: {} });
                           }}
                           className="flex-1 py-1 font-mono text-[8px] uppercase tracking-wider bg-zinc-900/50 border border-zinc-805 text-zinc-400 hover:border-zinc-650 hover:text-zinc-200 rounded transition-all cursor-pointer text-center select-none"
                        >
                           BALANCED (1x)
                        </button>
                     </div>

                     <div className="space-y-2.5 max-h-56 overflow-y-auto custom-scrollbar pr-1 border border-red-950/20 bg-black/40 p-2 rounded shadow-inner">
                        {AUTOPILOT_EFFECTS.map(({ key, label }) => {
                           const val = state.apWeights?.[key] !== undefined ? state.apWeights[key] : 1.0;
                           const percent = Math.round(val * 105);
                           let pctLabel = `${percent}%`;
                           
                           if (val === 0) {
                              pctLabel = "DISABLED";
                           } else if (val === 1.0) {
                              pctLabel = "100% (BALANCED)";
                           } else if (val === 2.0) {
                              pctLabel = "200% (MAX FREQ)";
                           }

                           return (
                              <div key={key} className="space-y-1">
                                 <div className="flex justify-between font-mono text-[8.5px] uppercase tracking-wider leading-none select-none">
                                    <span className="text-zinc-500">{label}</span>
                                    <span className={val === 0 ? "text-zinc-650 font-normal" : "text-red-400 font-bold"}>
                                       {pctLabel}
                                    </span>
                                 </div>
                                 <div className={`relative w-full h-3 bg-zinc-950 rounded border transition-colors ${val === 0 ? 'border-zinc-900' : 'border-red-950/40'}`}>
                                    <div 
                                       className="absolute top-0 left-0 h-full bg-gradient-to-r from-red-950 to-red-650 pointer-events-none opacity-40 transition-all" 
                                       style={{ width: `${(val / 2.0) * 100}%` }} 
                                    />
                                    <input 
                                       type="range"
                                       min="0"
                                       max="2"
                                       step="0.1"
                                       value={val}
                                       onChange={(e) => {
                                          updateState({
                                             apWeights: {
                                                ...(state.apWeights || {}),
                                                [key]: parseFloat(e.target.value)
                                             }
                                          });
                                        }}
                                       className="absolute inset-0 w-full h-full opacity-0 cursor-col-resize z-10"
                                    />
                                 </div>
                              </div>
                           );
                        })}
                     </div>
                  </div>
               )}
            </div>

            {/* DYNAMIC TRIGGERS AND ATTENUATORS ENGINE */}
            <div className="pt-3 border-t border-red-950/40 mt-3 space-y-3">
               <button 
                 type="button"
                 onClick={() => setShowApDynamics(!showApDynamics)}
                 className="w-full flex items-center justify-between text-left cursor-pointer group"
               >
                  <span className="text-[10px] text-red-400 uppercase tracking-widest font-mono font-bold flex items-center gap-1.5 select-none">
                     <Cpu className="w-3.5 h-3.5 text-red-500" />
                     TRIGGERS & DAMPING ENGINE
                  </span>
                  <span className="text-[9px] text-zinc-500 group-hover:text-red-400 transition-colors font-mono uppercase select-none">
                     {showApDynamics ? '[ Hide ]' : '[ Customise ]'}
                  </span>
               </button>

               {showApDynamics && (
                  <div className="space-y-4 border border-red-950/20 bg-black/40 p-2.5 rounded shadow-inner animate-fade-in text-white">
                     {/* Trigger Source */}
                     <div className="space-y-1.5">
                        <span className="text-[8.5px] uppercase tracking-wider text-zinc-500 font-mono font-bold select-none">
                           Select Trigger Source
                        </span>
                        <div className="grid grid-cols-3 gap-1">
                           {(['mixed', 'volume', 'bass', 'mid-high', 'time', 'chaos'] as const).map((src) => {
                              const isActive = state.apTriggerSource === src;
                              return (
                                 <button
                                    key={src}
                                    type="button"
                                    onClick={() => updateState({ apTriggerSource: src })}
                                    className={`py-1 px-0.5 font-mono text-[8px] uppercase tracking-wider border rounded transition-all cursor-pointer text-center select-none truncate ${
                                       isActive 
                                          ? 'bg-red-950/40 border-red-300 text-red-300 font-bold' 
                                          : 'bg-zinc-950/60 border-zinc-900 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400'
                                    }`}
                                 >
                                    {src}
                                 </button>
                              );
                           })}
                        </div>
                     </div>

                     {/* Dynamic Output Curve Ramp */}
                     <div className="space-y-1.5">
                        <span className="text-[8.5px] uppercase tracking-wider text-zinc-500 font-mono font-bold select-none">
                           Dynamic Output Ramp Curve
                        </span>
                        <div className="grid grid-cols-4 gap-1">
                           {(['none', 'linear', 'exponential', 'sigmoid'] as const).map((ramp) => {
                              const isActive = state.apRampType === ramp;
                              return (
                                 <button
                                    key={ramp}
                                    type="button"
                                    onClick={() => updateState({ apRampType: ramp })}
                                    className={`py-1 px-0.5 font-mono text-[7.5px] uppercase tracking-wider border rounded transition-all cursor-pointer text-center select-none truncate ${
                                       isActive 
                                          ? 'bg-red-950/40 border-red-300 text-red-300 font-bold' 
                                          : 'bg-zinc-950/60 border-zinc-900 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400'
                                    }`}
                                 >
                                    {ramp}
                                 </button>
                              );
                           })}
                        </div>
                     </div>

                     {/* Sensitivity Slider */}
                     <div className="space-y-1">
                        <div className="flex justify-between font-mono text-[8.5px] uppercase tracking-wider select-none leading-none">
                           <span className="text-zinc-500">Gating Threshold (Sensitivity)</span>
                           <span className="text-red-400 font-bold font-mono">
                              {Math.round(state.apSensitivity * 100)}%
                           </span>
                        </div>
                        <p className="text-[7.5px] text-zinc-600 font-mono select-none">
                           Below this signal level, effects fade out and rotation pauses.
                        </p>
                        <div className="relative w-full h-3 bg-zinc-950 rounded border border-red-950/30">
                           <div 
                              className="absolute top-0 left-0 h-full bg-gradient-to-r from-red-950 to-red-650 pointer-events-none opacity-40 transition-all" 
                              style={{ width: `${state.apSensitivity * 100}%` }} 
                           />
                           <input 
                              type="range"
                              min="0.0"
                              max="0.8"
                              step="0.05"
                              value={state.apSensitivity}
                              onChange={(e) => updateState({ apSensitivity: parseFloat(e.target.value) })}
                              className="absolute inset-0 w-full h-full opacity-0 cursor-col-resize z-10"
                           />
                        </div>
                     </div>

                     {/* Subdue Depth Slider */}
                     <div className="space-y-1">
                        <div className="flex justify-between font-mono text-[8.5px] uppercase tracking-wider select-none leading-none">
                           <span className="text-zinc-500">Subdue Capacity (Floor level)</span>
                           <span className="text-red-400 font-bold font-mono">
                              {state.apSubdueDepth === 0 ? "0% (MUTED)" : `${Math.round(state.apSubdueDepth * 100)}%`}
                           </span>
                        </div>
                        <p className="text-[7.5px] text-zinc-600 font-mono select-none">
                           The leftover intensity of autonomic effects when signal drops to 0.
                        </p>
                        <div className="relative w-full h-3 bg-zinc-950 rounded border border-red-950/30">
                           <div 
                              className="absolute top-0 left-0 h-full bg-gradient-to-r from-red-950 to-red-650 pointer-events-none opacity-40 transition-all" 
                              style={{ width: `${state.apSubdueDepth * 100}%` }} 
                           />
                           <input 
                              type="range"
                              min="0.0"
                              max="0.5"
                              step="0.05"
                              value={state.apSubdueDepth}
                              onChange={(e) => updateState({ apSubdueDepth: parseFloat(e.target.value) })}
                              className="absolute inset-0 w-full h-full opacity-0 cursor-col-resize z-10"
                           />
                        </div>
                     </div>

                     {/* Real-time scaling toggle */}
                     <div className="flex items-center justify-between pt-1 font-mono text-[8.5px] uppercase tracking-wider select-none leading-none">
                        <span className="text-zinc-500">Scale Energy In Real-Time</span>
                        <button
                           type="button"
                           onClick={() => updateState({ apModulateIntensity: !state.apModulateIntensity })}
                           className={`px-3 py-1 font-mono text-[8px] uppercase tracking-wider border rounded select-none transition-all cursor-pointer ${
                              state.apModulateIntensity 
                                 ? 'bg-red-950/40 border-red-500 text-red-300 font-bold' 
                                 : 'bg-zinc-950 border-zinc-900 text-zinc-600 hover:border-zinc-700'
                           }`}
                        >
                           {state.apModulateIntensity ? 'ENABLED' : 'DISABLED'}
                        </button>
                     </div>
                  </div>
               )}
            </div>
            
            <div className="pt-3 border-t border-red-950/40 mt-3 space-y-2">
               <div className="flex items-center justify-between">
                  <span className="text-[9px] text-red-400 uppercase tracking-widest font-mono">
                     Autopilot Clip Rotation
                  </span>
                  <button 
                     onClick={() => updateState({ autoSwitchClips: !state.autoSwitchClips })}
                     className={`px-3 py-1 font-mono text-[8px] uppercase tracking-wider border rounded select-none transition-all cursor-pointer ${
                        state.autoSwitchClips 
                          ? 'bg-red-950 text-red-350 border-red-500/50 shadow-[0_0_8px_rgba(239,68,68,0.15)] animate-pulse font-bold' 
                          : 'bg-black text-zinc-650 border-zinc-900 hover:border-zinc-805'
                     }`}
                  >
                     {state.autoSwitchClips ? "AUTO CYCLE ACTIVE" : "LOCK CURRENT CLIP"}
                  </button>
               </div>
               {state.autoSwitchClips && (
                  <div className="text-[8px] font-mono text-zinc-550 uppercase tracking-widest leading-relaxed">
                     • ROTATION TRIGGERS ON PHRASE SEQUENCE CYCLE<br/>
                     • HIGH-ENTROPY BEAT DROP TRANSLATIONS DETECTED
                  </div>
               )}
            </div>
         </div>
      )}

      <div className="px-3 py-3 flex-1 space-y-4">

        {/* DECK A */}
        <section className={`transition-all duration-500 ${apGeo ? 'opacity-30 pointer-events-none' : 'opacity-100'}`}>
          <h2 className="text-[10px] text-zinc-400 uppercase tracking-widest font-mono border-b border-zinc-800 pb-1 mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Hash className="w-3 h-3 text-cyan-500" /> DECK A // GEOMETRICS
            </span>
            {apGeo && <span className="text-red-500 animate-pulse">[AUTO]</span>}
          </h2>
          
          <div className="grid grid-cols-3 gap-2 mb-3">
             <TogglePad paramKey="mirrorX" label="Mirror X" active={state.mirrorX} onClick={() => updateState({ mirrorX: !state.mirrorX })} />
             <TogglePad paramKey="mirrorY" label="Mirror Y" active={state.mirrorY} onClick={() => updateState({ mirrorY: !state.mirrorY })} />
             <TogglePad paramKey="kaleido" label="Kaleido" active={state.kaleidoscope} onClick={() => updateState({ kaleidoscope: !state.kaleidoscope })} />
          </div>
          
          <div className="grid grid-cols-2 gap-2 mb-3">
             <TogglePad paramKey="equirect" label="HDR/EQUI" active={state.equirect} onClick={() => updateState({ equirect: !state.equirect })} />
             <TogglePad paramKey="softEdges" label="Soft Edges" active={state.softEdges} onClick={() => updateState({ softEdges: !state.softEdges })} />
             <TogglePad paramKey="stereoMode" label="SBS 3D" active={state.stereoMode === 'sbs'} onClick={() => updateState({ stereoMode: state.stereoMode === 'sbs' ? 'none' : 'sbs' })} />
             <TogglePad paramKey="stereoMode" label="TB 3D" active={state.stereoMode === 'tb'} onClick={() => updateState({ stereoMode: state.stereoMode === 'tb' ? 'none' : 'tb' })} />
          </div>
          
          <Fader paramKey="tiling" label="Grid Tiling" min={1} max={8} step={1} value={state.tiling} onChange={(v: number) => updateState({ tiling: v })} unit="x" />
          <Fader paramKey="radialSpokes" label="Radial Mirror (Spokes)" min={0} max={24} step={1} value={state.radialSpokes ?? 0} onChange={(v: number) => updateState({ radialSpokes: v })} unit="" />
          <Fader paramKey="feedback" label="Feedback Wash" min={0} max={0.99} step={0.01} value={state.feedback} onChange={(v: number) => updateState({ feedback: v })} />
          <Fader paramKey="strobe" label="Strobe Burst" min={0} max={1} step={0.01} value={state.strobe} onChange={(v: number) => updateState({ strobe: v })} />

          {/* Performance tier — scales the renderer's internal canvas
              resolution. Lower tiers trade sharpness for frame rate on
              weaker GPUs. */}
          <div className="mt-3 pt-2 border-t border-cyan-900/20 flex flex-col gap-1.5">
            <span className="text-[8px] font-mono uppercase tracking-widest text-cyan-500/60 flex items-center gap-1">
              <Cpu className="w-2.5 h-2.5" /> RENDER PERFORMANCE
            </span>
            <div className="grid grid-cols-3 gap-1">
              {(['high', 'medium', 'low'] as const).map((tier) => (
                <TogglePad
                  key={tier}
                  label={tier === 'high' ? 'HIGH 1.0x' : tier === 'medium' ? 'MED 0.75x' : 'LOW 0.5x'}
                  active={(state.performanceMode ?? 'high') === tier}
                  onClick={() => updateState({ performanceMode: tier })}
                />
              ))}
            </div>
          </div>
        </section>

        {/* DECK B */}
        <section className={`transition-all duration-500 ${apCorrupt ? 'opacity-30 pointer-events-none' : 'opacity-100'}`}>
          <h2 className="text-[10px] text-zinc-400 uppercase tracking-widest font-mono border-b border-zinc-800 pb-1 mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Cpu className="w-3 h-3 text-red-500" /> DECK B // CORRUPTION
            </span>
            {apCorrupt && <span className="text-red-500 animate-pulse">[AUTO]</span>}
          </h2>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
             <Fader paramKey="glitch" label="Glitch" min={0} max={1} step={0.01} value={state.glitch} onChange={(v: number) => updateState({ glitch: v })} />
             <Fader paramKey="rgbGhost" label="Ghosting" min={0} max={1} step={0.01} value={state.rgbGhost} onChange={(v: number) => updateState({ rgbGhost: v })} />
             <Fader paramKey="rgbSplit" label="Anaglyph" min={0} max={1} step={0.01} value={state.rgbSplit} onChange={(v: number) => updateState({ rgbSplit: v })} />
             <Fader paramKey="waveWarp" label="Wave Warp" min={0} max={1} step={0.01} value={state.waveWarp} onChange={(v: number) => updateState({ waveWarp: v })} />
             <Fader paramKey="chromaAb" label="Chroma Ab" min={0} max={1} step={0.01} value={state.chromaAb} onChange={(v: number) => updateState({ chromaAb: v })} />
             <Fader paramKey="backskip" label="Backskip" min={0} max={1} step={0.01} value={state.backskip} onChange={(v: number) => updateState({ backskip: v })} />
             <Fader paramKey="pixelate" label="Pixel Destroy" min={0} max={1} step={0.01} value={state.pixelate} onChange={(v: number) => updateState({ pixelate: v })} />
          </div>
        </section>

        {/* DECK C */}
        <section className={`transition-all duration-500 ${apColor ? 'opacity-30 pointer-events-none' : 'opacity-100'}`}>
          <h2 className="text-[10px] text-zinc-400 uppercase tracking-widest font-mono border-b border-zinc-800 pb-1 mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Sliders className="w-3 h-3 text-yellow-500" /> DECK C // CHROMATICS
            </span>
            {apColor && <span className="text-red-500 animate-pulse">[AUTO]</span>}
          </h2>
          <Fader paramKey="hue" label="Hue Cycle" min={0} max={360} step={1} value={state.hue} unit="°" onChange={(v: number) => updateState({ hue: v })} />
          <Fader paramKey="saturation" label="Saturation" min={0} max={300} step={1} value={state.saturation} unit="%" onChange={(v: number) => updateState({ saturation: v })} />
          <Fader paramKey="contrast" label="Contrast" min={0} max={300} step={1} value={state.contrast} unit="%" onChange={(v: number) => updateState({ contrast: v })} />
          <Fader paramKey="brightness" label="Brightness" min={0} max={200} step={1} value={state.brightness} unit="%" onChange={(v: number) => updateState({ brightness: v })} />
          
          <div className="grid grid-cols-5 gap-2 mt-3">
             <TogglePad paramKey="invert" label="INV" active={state.invert} onClick={() => updateState({ invert: !state.invert })} />
             <TogglePad paramKey="edgeDetect" label="EDG" active={state.edgeDetect} onClick={() => updateState({ edgeDetect: !state.edgeDetect })} />
             <TogglePad label="CRT" active={state.crt} onClick={() => updateState({ crt: !state.crt })} />
             <TogglePad label="SCN" active={state.scanlines} onClick={() => updateState({ scanlines: !state.scanlines })} />
             <TogglePad label="VIG" active={state.vignette} onClick={() => updateState({ vignette: !state.vignette })} />
          </div>

          {/* G1 effect tier — new looks layered onto the existing CSS
              filter chain. Cheap (GPU-accelerated by the browser),
              composable with everything above. */}
          <div className="mt-3 space-y-1 pt-2 border-t border-yellow-900/20">
            <span className="text-[8px] font-mono uppercase tracking-widest text-yellow-500/60 block mb-1">FX TIER · LOOKS</span>
            <Fader paramKey="fxSepia" label="Sepia" min={0} max={1} step={0.01} value={state.fxSepia ?? 0} onChange={(v: number) => updateState({ fxSepia: v })} />
            <Fader paramKey="fxGrayscale" label="Grayscale" min={0} max={1} step={0.01} value={state.fxGrayscale ?? 0} onChange={(v: number) => updateState({ fxGrayscale: v })} />
            <Fader paramKey="fxBlur" label="Soft Blur" min={0} max={1} step={0.01} value={state.fxBlur ?? 0} onChange={(v: number) => updateState({ fxBlur: v })} />
          </div>
        </section>
      </div>
      
      {/* DECK D */}
      <div className="px-3 py-3 flex-1 space-y-4 border-t border-zinc-900 border-dashed">
        <section className={`transition-all duration-500 ${apTimecode ? 'opacity-30 pointer-events-none' : 'opacity-100'}`}>
          <h2 className="text-[10px] text-zinc-400 uppercase tracking-widest font-mono border-b border-zinc-800 pb-1 mb-2 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Activity className="w-3 h-3 text-emerald-500" /> DECK D // TIMECODE
            </span>
            {apTimecode && <span className="text-red-500 animate-pulse">[AUTO]</span>}
          </h2>
          
          <div className="grid grid-cols-2 gap-2 mb-4">
            <TogglePad paramKey="reversePlayback" label="Reverse [!] " active={state.reversePlayback} onClick={() => updateState({ reversePlayback: !state.reversePlayback })} highlight="red" />
            <TogglePad paramKey="playbackSpeed" label="FREEZE PAUSE" active={state.playbackSpeed === 0} onClick={() => updateState({ playbackSpeed: state.playbackSpeed === 0 ? 1 : 0 })} highlight="cyan" />
          </div>

          <Fader paramKey="playbackSpeed" label="Playback Speed %" min={0} max={4} step={0.01} value={state.playbackSpeed} unit="x" onChange={(v: number) => updateState({ playbackSpeed: v })} />
          <Fader paramKey="posterizeTime" label="Posterize Time (Stutter)" min={1} max={60} step={1} value={state.posterizeTime} unit="fps" onChange={(v: number) => updateState({ posterizeTime: v })} />
          <Fader paramKey="echoTrails" label="Echo/Motion Trails" min={0} max={40} step={1} value={state.echoTrails} unit="fr" onChange={(v: number) => updateState({ echoTrails: v })} />
          <Fader paramKey="timeDisplace" label="Time Displace" min={0} max={1} step={0.01} value={state.timeDisplace} onChange={(v: number) => updateState({ timeDisplace: v })} />
          <Fader paramKey="slitScan" label="Slit Scan (Y)" min={0} max={1} step={0.01} value={state.slitScan} onChange={(v: number) => updateState({ slitScan: v })} />
        </section>
      </div>

      {/* PLUGINS MANAGER — full effects catalog (Categories A-D) with
          live controls for implemented plugins. */}
      <PluginsPanel state={state} updateState={updateState} />

      {/* SEQUENCER BLOCK */}
      <div className="px-3 py-2.5 bg-[#0a0a0a] border-t border-cyan-900/30 shadow-[0_-10px_20px_rgba(0,0,0,0.5)] z-10 sticky bottom-0">
         <div className="flex justify-between items-center mb-2">
           <h3 className="text-[10px] font-mono text-cyan-500 tracking-widest flex items-center gap-2 font-bold">
             <span className="w-2 h-2 rounded-full bg-cyan-500 animate-pulse shadow-[0_0_8px_rgba(6,182,212,0.8)]"></span>
             MASTER SYNC BUS
           </h3>
           <div className="flex gap-2">
             <TogglePad 
               label={state.autoPilot ? "AUTOPILOT" : "AUTO OFF"} 
               active={state.autoPilot} 
               onClick={() => updateState({ autoPilot: !state.autoPilot })} 
               highlight="red"
             />
             <TogglePad 
               label={state.audioReactive ? "AUDIO FIX" : "MIC OFF"} 
               active={state.audioReactive} 
               onClick={() => updateState({ audioReactive: !state.audioReactive })} 
               highlight="cyan"
             />
             <TogglePad 
               label={state.autoLFO ? "LFO RUN" : "LFO OFF"} 
               active={state.autoLFO} 
               onClick={() => updateState({ autoLFO: !state.autoLFO })} 
               highlight="purple"
             />
           </div>
         </div>
         
         <div className={`transition-all duration-300 overflow-hidden ${state.autoLFO || state.audioReactive ? 'h-16 opacity-100' : 'h-0 opacity-0 pointer-events-none'}`}>
            <Fader label="BPM Clock Base" min={60} max={200} step={1} value={state.bpm} onChange={(v: number) => updateState({ bpm: v })} />
            <p className="text-[9px] font-mono text-zinc-600 mt-2 uppercase tracking-widest text-center">
              {state.audioReactive ? "Audio Reactive drops drive parameters" : "LFO Modulates Spikes & Ghosting"}
            </p>
         </div>
      </div>
    </div>
  );
}

export const ControlDeck = React.memo(ControlDeckImpl);
