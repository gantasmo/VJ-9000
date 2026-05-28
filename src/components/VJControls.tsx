import React from 'react';
import { VJState } from '../types';
import { Activity, RefreshCcw, Upload, Sliders, Cpu, Radio, Hash, Video } from 'lucide-react';
import { routeFile, VJ_FILE_ACCEPT } from '../fileRouter';

interface ControlsProps {
  state: VJState;
  updateState: (updates: Partial<VJState>) => void;
  reset: () => void;
  hasCameraError: boolean;
}

export function ControlDeck({ state, updateState, reset, hasCameraError }: ControlsProps) {
  
  const Fader = ({ label, value, min, max, step=0.01, onChange, unit="", paramKey }: any) => {
    const percentage = ((value - min) / (max - min)) * 100;
    const apActiveGlobally = state.autoPilot;
    const apWeight = paramKey && state.apWeights ? (state.apWeights[paramKey] ?? 1.0) : 1.0;
    
    return (
      <div className="flex flex-col mb-4 group relative">
        <div className="flex justify-between items-center text-[10px] text-zinc-500 uppercase tracking-widest font-mono mb-1.5 focus-within:text-cyan-400">
          <div className="flex items-center gap-2">
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
        <div className={`relative w-full h-6 bg-black rounded-sm overflow-hidden cursor-crosshair border shadow-inner transition-colors ${apActiveGlobally && apWeight > 0 ? 'border-red-900/50 opacity-70' : 'border-zinc-800 group-hover:border-zinc-700'}`}>
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
           className={`h-10 px-2 text-[10px] uppercase font-mono tracking-widest border transition-all select-none rounded-sm w-full ${
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

  return (
    <div className="h-full bg-[#111] border-l border-zinc-800 flex flex-col items-stretch overflow-y-auto w-96 shrink-0 custom-scrollbar">
      {/* Header */}
      <div className="p-4 border-b border-zinc-800 flex items-center justify-between sticky top-0 bg-[#111] z-50 shadow-md">
        <div className="flex flex-col">
          <h1 className="text-white font-mono font-bold tracking-widest text-lg flex items-center gap-2">
            <Activity className="w-5 h-5 text-cyan-500" />
            LUMINA // OMEGA
          </h1>
          <span className={`text-[10px] uppercase tracking-[0.2em] mt-1 ${hasCameraError ? 'text-red-500' : 'text-zinc-500'}`}>
            {hasCameraError ? 'CAMERA OFFLINE // SYS ERR' : 'OPTO-SENSOR ACTIVE // LIVE'}
          </span>
        </div>
        <button onClick={reset} className="p-2.5 text-zinc-600 bg-black border border-zinc-800 rounded hover:text-white hover:border-zinc-500 hover:bg-zinc-800 transition-colors" title="Master Reset">
          <RefreshCcw className="w-4 h-4" />
        </button>
      </div>

      {/* RECORD BAR */}
      <div className="bg-zinc-950 border-b border-zinc-800 p-3 flex justify-center">
        <button 
          onClick={() => updateState({ recording: !state.recording })}
          className={`flex items-center gap-2 px-4 py-2 text-[10px] uppercase font-mono tracking-widest border rounded transition-all ${
            state.recording 
              ? 'bg-red-900/30 border-red-500 text-red-300 shadow-[0_0_15px_rgba(239,68,68,0.5)] animate-pulse'
              : 'bg-black border-zinc-700 text-zinc-400 hover:border-red-500 hover:text-red-400'
          }`}
        >
          <div className={`w-2.5 h-2.5 rounded-full ${state.recording ? 'bg-red-500' : 'bg-red-900/50'}`}></div>
          {state.recording ? 'RECORDING... (CLICK TO STOP & SAVE)' : 'REC EXPORT TO FILE'}
        </button>
      </div>
      
      {apActive && (
         <div className="m-4 mb-0 p-4 border border-red-900/50 bg-red-950/20 rounded shadow-[inset_0_0_20px_rgba(239,68,68,0.05)]">
            <h2 className="text-red-500 font-mono text-[11px] uppercase tracking-widest mb-4 flex items-center gap-2 font-bold">
               <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.8)]"></span>
               NEURAL AUTOPILOT OVERRIDE
            </h2>
            
            <div className="flex gap-2 mb-5">
               <TogglePad label="GEO // A" active={state.apConfig.geo} onClick={() => updateApConfig('geo', !state.apConfig.geo)} highlight="red" flex />
               <TogglePad label="CRPT // B" active={state.apConfig.corrupt} onClick={() => updateApConfig('corrupt', !state.apConfig.corrupt)} highlight="red" flex />
               <TogglePad label="CLR // C" active={state.apConfig.color} onClick={() => updateApConfig('color', !state.apConfig.color)} highlight="red" flex />
            </div>
            
            <Fader label="Cycle Frequency (Speed)" min={0.1} max={5} step={0.1} value={state.apConfig.speed} onChange={(v: number) => updateApConfig('speed', v)} unit="x" />
            <Fader label="Entropy (Chaos)" min={0.1} max={1.5} step={0.05} value={state.apConfig.chaos} onChange={(v: number) => updateApConfig('chaos', v)} />
         </div>
      )}

      <div className="p-5 flex-1 space-y-8">
        {/* INPUT DECK */}
        <section>
          <h2 className="text-[10px] text-zinc-400 uppercase tracking-widest font-mono border-b border-zinc-800 pb-2 mb-4 flex items-center gap-2">
            <Radio className="w-3 h-3 text-fuchsia-500" /> SOURCE // MATRIX
          </h2>
          <div className="grid grid-cols-2 gap-2 mb-4">
            <TogglePad label="CAM (Live)" active={state.sourceType === 'camera'} onClick={() => updateState({ sourceType: 'camera' })} highlight="purple" />
            <TogglePad label="MEM (Clip)" active={state.sourceType === 'clip'} onClick={() => updateState({ sourceType: 'clip' })} highlight="purple" />
          </div>

          <div className="mb-4 flex flex-col gap-1.5">
            <span className="text-[10px] text-zinc-500 uppercase tracking-widest font-mono mb-1">Canvas Format</span>
            <div className="grid grid-cols-4 gap-1">
               <TogglePad label="FREE" active={state.aspectRatio === 'free'} onClick={() => updateState({ aspectRatio: 'free' })} highlight="purple" />
               <TogglePad label="16:9" active={state.aspectRatio === '16:9'} onClick={() => updateState({ aspectRatio: '16:9' })} highlight="purple" />
               <TogglePad label="4:3" active={state.aspectRatio === '4:3'} onClick={() => updateState({ aspectRatio: '4:3' })} highlight="purple" />
               <TogglePad label="9:16" active={state.aspectRatio === '9:16'} onClick={() => updateState({ aspectRatio: '9:16' })} highlight="purple" />
               <TogglePad label="1:1" active={state.aspectRatio === '1:1'} onClick={() => updateState({ aspectRatio: '1:1' })} highlight="purple" />
               <TogglePad label="21:9" active={state.aspectRatio === '21:9'} onClick={() => updateState({ aspectRatio: '21:9' })} highlight="purple" />
            </div>
          </div>

          {state.sourceType === 'clip' && (
            <div className="relative overflow-hidden">
              <button className="w-full h-10 flex items-center justify-center gap-2 text-[10px] uppercase font-mono tracking-widest border border-zinc-700 bg-zinc-800/50 text-zinc-300 hover:bg-purple-900/30 hover:border-purple-500 hover:text-purple-400 transition-colors rounded-sm cursor-pointer">
                <Upload className="w-4 h-4" />
                {state.clipUrl || state.imageUrl ? 'Load New Media' : 'Select Video / Audio / Image'}
              </button>
              <input
                type="file"
                accept={VJ_FILE_ACCEPT}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    const route = routeFile(file);
                    if (route.kind !== 'unsupported') updateState(route.patch);
                  }
                  e.target.value = '';
                }}
              />
            </div>
          )}
        </section>

        {/* DECK A */}
        <section className={`transition-all duration-500 ${apGeo ? 'opacity-30 pointer-events-none' : 'opacity-100'}`}>
          <h2 className="text-[10px] text-zinc-400 uppercase tracking-widest font-mono border-b border-zinc-800 pb-2 mb-4 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Hash className="w-3 h-3 text-cyan-500" /> DECK A // GEOMETRICS
            </span>
            {apGeo && <span className="text-red-500 animate-pulse">[AUTO]</span>}
          </h2>
          
          <div className="grid grid-cols-3 gap-2 mb-5">
             <TogglePad paramKey="mirrorX" label="Mirror X" active={state.mirrorX} onClick={() => updateState({ mirrorX: !state.mirrorX })} />
             <TogglePad paramKey="mirrorY" label="Mirror Y" active={state.mirrorY} onClick={() => updateState({ mirrorY: !state.mirrorY })} />
             <TogglePad paramKey="kaleido" label="Kaleido" active={state.kaleidoscope} onClick={() => updateState({ kaleidoscope: !state.kaleidoscope })} />
          </div>
          
          <div className="grid grid-cols-2 gap-2 mb-5">
             <TogglePad paramKey="equirect" label="HDR/EQUI" active={state.equirect} onClick={() => updateState({ equirect: !state.equirect })} />
             <TogglePad paramKey="softEdges" label="Soft Edges" active={state.softEdges} onClick={() => updateState({ softEdges: !state.softEdges })} />
             <TogglePad paramKey="stereoMode" label="SBS 3D" active={state.stereoMode === 'sbs'} onClick={() => updateState({ stereoMode: state.stereoMode === 'sbs' ? 'none' : 'sbs' })} />
             <TogglePad paramKey="stereoMode" label="TB 3D" active={state.stereoMode === 'tb'} onClick={() => updateState({ stereoMode: state.stereoMode === 'tb' ? 'none' : 'tb' })} />
          </div>
          
          <Fader paramKey="tiling" label="Grid Tiling" min={1} max={8} step={1} value={state.tiling} onChange={(v: number) => updateState({ tiling: v })} unit="x" />
          <Fader paramKey="feedback" label="Feedback Wash" min={0} max={0.99} step={0.01} value={state.feedback} onChange={(v: number) => updateState({ feedback: v })} />
          <Fader paramKey="strobe" label="Strobe Burst" min={0} max={1} step={0.01} value={state.strobe} onChange={(v: number) => updateState({ strobe: v })} />
        </section>

        {/* DECK B */}
        <section className={`transition-all duration-500 ${apCorrupt ? 'opacity-30 pointer-events-none' : 'opacity-100'}`}>
          <h2 className="text-[10px] text-zinc-400 uppercase tracking-widest font-mono border-b border-zinc-800 pb-2 mb-4 flex items-center justify-between">
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
          <h2 className="text-[10px] text-zinc-400 uppercase tracking-widest font-mono border-b border-zinc-800 pb-2 mb-4 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Sliders className="w-3 h-3 text-yellow-500" /> DECK C // CHROMATICS
            </span>
            {apColor && <span className="text-red-500 animate-pulse">[AUTO]</span>}
          </h2>
          <Fader paramKey="hue" label="Hue Cycle" min={0} max={360} step={1} value={state.hue} unit="°" onChange={(v: number) => updateState({ hue: v })} />
          <Fader paramKey="saturation" label="Saturation" min={0} max={300} step={1} value={state.saturation} unit="%" onChange={(v: number) => updateState({ saturation: v })} />
          <Fader paramKey="contrast" label="Contrast" min={0} max={300} step={1} value={state.contrast} unit="%" onChange={(v: number) => updateState({ contrast: v })} />
          <Fader paramKey="brightness" label="Brightness" min={0} max={200} step={1} value={state.brightness} unit="%" onChange={(v: number) => updateState({ brightness: v })} />
          
          <div className="grid grid-cols-5 gap-2 mt-5">
             <TogglePad paramKey="invert" label="INV" active={state.invert} onClick={() => updateState({ invert: !state.invert })} />
             <TogglePad paramKey="edgeDetect" label="EDG" active={state.edgeDetect} onClick={() => updateState({ edgeDetect: !state.edgeDetect })} />
             <TogglePad label="CRT" active={state.crt} onClick={() => updateState({ crt: !state.crt })} />
             <TogglePad label="SCN" active={state.scanlines} onClick={() => updateState({ scanlines: !state.scanlines })} />
             <TogglePad label="VIG" active={state.vignette} onClick={() => updateState({ vignette: !state.vignette })} />
          </div>
        </section>
      </div>
      
      {/* DECK D */}
      <div className="p-5 flex-1 space-y-8 border-t border-zinc-900 border-dashed">
        <section>
          <h2 className="text-[10px] text-zinc-400 uppercase tracking-widest font-mono border-b border-zinc-800 pb-2 mb-4 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <Activity className="w-3 h-3 text-emerald-500" /> DECK D // TIMECODE
            </span>
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

      {/* SEQUENCER BLOCK */}
      <div className="p-5 bg-[#0a0a0a] border-t border-cyan-900/30 shadow-[0_-10px_20px_rgba(0,0,0,0.5)] z-10 sticky bottom-0">
         <div className="flex justify-between items-center mb-4">
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
