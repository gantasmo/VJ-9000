/**
 * MIDI panel — controller status + mapping editor.
 *
 * Floats in the top-right of the visualizer (collapsed by default).
 * When expanded, lists each mappable VJ param with its current
 * binding + a MIDI LEARN button. Click LEARN, move a knob on the
 * controller, and that CC/note gets bound to the param.
 *
 * Works alongside audio reactivity — MIDI mappings adjust state
 * values directly, the audio analyser continues to drive whatever
 * the visualiser already reads from state.
 */
import React, { useEffect, useState } from 'react';
import { Music2, Plug, X, RotateCcw, Crosshair, Zap, Activity } from 'lucide-react';
import { MIDI_PARAMS, type NumericVJField } from '../midiParams';
import type { MidiMapping, MidiInputInfo } from '../useMidi';
import {
  getAudioRoutes,
  setAudioRoute,
  clearAudioRoutes,
  subscribeToAudioRoutes,
  REACTIVE_BANDS,
  type AudioRoutes,
  type ReactiveBand,
} from '../audioRouting';

const BAND_DOT: Record<ReactiveBand, string> = {
  none: 'bg-zinc-700',
  bass: 'bg-rose-400',
  mid: 'bg-amber-400',
  high: 'bg-cyan-400',
  volume: 'bg-emerald-400',
};

interface MidiPanelProps {
  supported: boolean;
  ready: boolean;
  error: string | null;
  inputs: MidiInputInfo[];
  mappings: Record<NumericVJField, MidiMapping>;
  learning: NumericVJField | null;
  setLearning: (key: NumericVJField | null) => void;
  setMapping: (key: NumericVJField, mapping: MidiMapping | null) => void;
  resetMappings: () => void;
  /** Last raw CC seen — shown in learn mode so the user can verify
   *  their knob is reaching the browser. */
  lastSeenCc: { cc: number; value: number; channel: number } | null;
}

export const MidiPanel: React.FC<MidiPanelProps> = ({
  supported,
  ready,
  error,
  inputs,
  mappings,
  learning,
  setLearning,
  setMapping,
  resetMappings,
  lastSeenCc,
}) => {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'midi' | 'audio'>('midi');
  // Mirror the audio-route store into local state so the panel
  // re-renders when a band/amount changes (the store is framework-free).
  const [routes, setRoutes] = useState<AudioRoutes>(() => getAudioRoutes());
  useEffect(() => subscribeToAudioRoutes(setRoutes), []);
  const connectedCount = inputs.filter((i) => i.state === 'connected').length;
  const routedCount = (Object.values(routes) as Array<AudioRoutes[NumericVJField]>).filter(
    (r) => r && r.band !== 'none' && r.amount > 0,
  ).length;

  const status: { label: string; cls: string; dot: string } = !supported
    ? { label: 'Web MIDI not supported', cls: 'border-zinc-700 text-zinc-500', dot: 'bg-zinc-700' }
    : error
    ? { label: error, cls: 'border-rose-500/40 bg-rose-500/10 text-rose-200', dot: 'bg-rose-400' }
    : !ready
    ? { label: 'Requesting MIDI…', cls: 'border-amber-500/40 bg-amber-500/10 text-amber-200', dot: 'bg-amber-400 animate-pulse' }
    : connectedCount === 0
    ? { label: 'No controller', cls: 'border-zinc-700 text-zinc-500', dot: 'bg-zinc-700' }
    : { label: `${connectedCount} connected`, cls: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-200', dot: 'bg-cyan-400 animate-pulse' };

  // Pill (collapsed state) — top-right corner. Clicking opens panel.
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`absolute top-2 right-32 z-50 flex items-center gap-1.5 px-2 py-1 rounded border text-[9px] font-mono uppercase tracking-widest ${status.cls}`}
        title={`MIDI · ${status.label}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.dot}`} />
        <Music2 className="w-3 h-3" />
        <span>MIDI {connectedCount > 0 ? `· ${connectedCount}` : ''}</span>
      </button>
    );
  }

  return (
    <div className="absolute top-2 right-2 z-50 w-80 max-h-[80%] flex flex-col bg-black/90 backdrop-blur-md border border-cyan-500/40 rounded text-[10px] font-mono text-zinc-200 shadow-[0_8px_24px_rgba(0,0,0,0.6)]">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-cyan-500/20 shrink-0">
        <div className="flex items-center gap-1.5">
          <Music2 className="w-3.5 h-3.5 text-cyan-300" />
          <span className="font-black uppercase tracking-widest text-cyan-200">MIDI Mapper</span>
        </div>
        <button onClick={() => setOpen(false)} className="p-1 text-zinc-500 hover:text-white">
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Tab switcher — MIDI mapping vs. audio-reactivity routing. Both
          target the same MIDI_PARAMS list so every effect is reachable
          from a controller AND an audio band. */}
      <div className="flex shrink-0 border-b border-white/5 text-[9px] uppercase tracking-widest font-mono">
        <button
          onClick={() => setTab('midi')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 ${
            tab === 'midi' ? 'text-cyan-200 bg-cyan-500/10 border-b border-cyan-400' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Music2 className="w-3 h-3" /> MIDI Map
        </button>
        <button
          onClick={() => setTab('audio')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 ${
            tab === 'audio' ? 'text-emerald-200 bg-emerald-500/10 border-b border-emerald-400' : 'text-zinc-500 hover:text-zinc-300'
          }`}
        >
          <Activity className="w-3 h-3" /> Audio React {routedCount > 0 ? `· ${routedCount}` : ''}
        </button>
      </div>

      {/* Status block */}
      <div className="px-3 py-2 border-b border-white/5 shrink-0 flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          <Plug className={`w-3 h-3 ${connectedCount > 0 ? 'text-cyan-300' : 'text-zinc-500'}`} />
          <span className="text-zinc-400">{status.label}</span>
        </div>
        {inputs.length > 0 && (
          <div className="flex flex-col gap-0.5 mt-1">
            {inputs.map((i) => (
              <div key={i.id} className="flex items-center gap-1.5 text-[9px] text-zinc-500">
                <span className={`w-1 h-1 rounded-full ${i.state === 'connected' ? 'bg-cyan-400' : 'bg-zinc-700'}`} />
                <span className="truncate flex-1">{i.name}</span>
                <span className="text-zinc-700 normal-case">{i.manufacturer || '—'}</span>
              </div>
            ))}
          </div>
        )}
        {lastSeenCc && (
          <div className="text-[9px] text-zinc-600 mt-0.5">
            last seen: CC <span className="text-cyan-300">{lastSeenCc.cc}</span>{' '}
            = <span className="text-cyan-300">{lastSeenCc.value}</span>{' '}
            (ch <span className="text-cyan-300">{lastSeenCc.channel + 1}</span>)
          </div>
        )}
        {learning && (
          <div className="text-[9px] text-amber-300 animate-pulse mt-0.5 flex items-center gap-1">
            <Crosshair className="w-2.5 h-2.5" />
            LEARN: move a knob to bind {learning}
          </div>
        )}
      </div>

      {/* Mappings list (MIDI tab) */}
      {tab === 'midi' && (
      <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1">
        {MIDI_PARAMS.map((param) => {
          const m = mappings[param.key];
          const isLearning = learning === param.key;
          return (
            <div
              key={param.key}
              className="flex items-center gap-2 px-2 py-1 rounded border border-white/5 bg-white/3 hover:bg-white/5"
            >
              <div className="flex flex-col flex-1 min-w-0">
                <span className="text-[10px] text-zinc-200 truncate">{param.label}</span>
                <span className="text-[8px] font-mono text-zinc-600 uppercase tracking-wider">
                  {m
                    ? `${m.kind === 'cc' ? 'CC' : 'NOTE'} ${m.number}${
                        m.channel !== null ? ` · ch ${m.channel + 1}` : ''
                      }${m.inverted ? ' · INV' : ''}`
                    : 'unmapped'}
                </span>
              </div>
              <button
                onClick={() => setLearning(isLearning ? null : param.key)}
                className={`p-1 rounded border ${
                  isLearning
                    ? 'border-amber-400/60 bg-amber-500/15 text-amber-200 animate-pulse'
                    : 'border-white/10 text-zinc-500 hover:text-cyan-200 hover:border-cyan-500/40'
                }`}
                title={isLearning ? 'Cancel learn' : 'MIDI LEARN — move a knob to bind'}
              >
                <Crosshair className="w-3 h-3" />
              </button>
              {m && (
                <>
                  <button
                    onClick={() => setMapping(param.key, { ...m, inverted: !m.inverted })}
                    className={`p-1 rounded border ${
                      m.inverted
                        ? 'border-purple-500/40 text-purple-200 bg-purple-500/15'
                        : 'border-white/10 text-zinc-500 hover:text-purple-200'
                    }`}
                    title="Invert range"
                  >
                    <Zap className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => setMapping(param.key, null)}
                    className="p-1 rounded border border-white/10 text-zinc-500 hover:text-rose-300 hover:border-rose-500/40"
                    title="Clear mapping"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      )}

      {/* Audio reactivity routing list (AUDIO tab). Each param can be
          driven by a band (none/bass/mid/high/volume) at an adjustable
          0-100% depth. Applied in VideoOutput when audioReactive is on. */}
      {tab === 'audio' && (
        <div className="flex-1 min-h-0 overflow-y-auto px-2 py-2 space-y-1">
          {MIDI_PARAMS.map((param) => {
            const route = routes[param.key];
            const band: ReactiveBand = route?.band ?? 'none';
            const amount = route?.amount ?? 0.5;
            const active = band !== 'none' && amount > 0;
            return (
              <div
                key={param.key}
                className={`flex flex-col gap-1 px-2 py-1.5 rounded border ${
                  active ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-white/5 bg-white/3'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${BAND_DOT[band]}`} />
                  <span className="text-[10px] text-zinc-200 truncate flex-1">{param.label}</span>
                  <div className="flex gap-0.5">
                    {REACTIVE_BANDS.map((b) => (
                      <button
                        key={b}
                        onClick={() => setAudioRoute(param.key, { band: b, amount })}
                        className={`px-1 py-0.5 rounded text-[7px] uppercase tracking-wider border ${
                          band === b
                            ? 'border-emerald-400/60 bg-emerald-500/15 text-emerald-200'
                            : 'border-white/10 text-zinc-500 hover:text-zinc-200'
                        }`}
                        title={`Drive ${param.label} from ${b}`}
                      >
                        {b === 'none' ? 'off' : b}
                      </button>
                    ))}
                  </div>
                </div>
                {active && (
                  <div className="flex items-center gap-2 pl-3.5">
                    <span className="text-[8px] text-zinc-600 uppercase tracking-wider">depth</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={amount}
                      onChange={(e) => setAudioRoute(param.key, { band, amount: Number(e.target.value) })}
                      className="flex-1 h-1 accent-emerald-500 bg-zinc-900 rounded-sm cursor-col-resize"
                    />
                    <span className="text-[8px] text-emerald-300 w-7 text-right">
                      {Math.round(amount * 100)}%
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-white/5 shrink-0">
        {tab === 'midi' ? (
          <button
            onClick={resetMappings}
            className="flex items-center gap-1.5 px-2 py-1 rounded border border-white/10 text-[9px] uppercase tracking-widest text-zinc-400 hover:text-zinc-100 hover:bg-white/5"
            title="Restore auto-map defaults"
          >
            <RotateCcw className="w-3 h-3" /> Defaults
          </button>
        ) : (
          <button
            onClick={clearAudioRoutes}
            className="flex items-center gap-1.5 px-2 py-1 rounded border border-white/10 text-[9px] uppercase tracking-widest text-zinc-400 hover:text-zinc-100 hover:bg-white/5"
            title="Clear every audio route"
          >
            <RotateCcw className="w-3 h-3" /> Clear Routes
          </button>
        )}
        <span className="text-[8px] text-zinc-700">audio + MIDI run side-by-side</span>
      </div>
    </div>
  );
};
