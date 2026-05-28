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
import React, { useState } from 'react';
import { Music2, Plug, X, RotateCcw, Crosshair, Zap } from 'lucide-react';
import { MIDI_PARAMS, type NumericVJField } from '../midiParams';
import type { MidiMapping, MidiInputInfo } from '../useMidi';

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
  const connectedCount = inputs.filter((i) => i.state === 'connected').length;

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
        className={`absolute top-2 right-32 z-30 flex items-center gap-1.5 px-2 py-1 rounded border text-[9px] font-mono uppercase tracking-widest ${status.cls}`}
        title={`MIDI · ${status.label}`}
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.dot}`} />
        <Music2 className="w-3 h-3" />
        <span>MIDI {connectedCount > 0 ? `· ${connectedCount}` : ''}</span>
      </button>
    );
  }

  return (
    <div className="absolute top-2 right-2 z-40 w-80 max-h-[80%] flex flex-col bg-black/90 backdrop-blur-md border border-cyan-500/40 rounded text-[10px] font-mono text-zinc-200 shadow-[0_8px_24px_rgba(0,0,0,0.6)]">
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

      {/* Mappings list */}
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

      {/* Footer actions */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-white/5 shrink-0">
        <button
          onClick={resetMappings}
          className="flex items-center gap-1.5 px-2 py-1 rounded border border-white/10 text-[9px] uppercase tracking-widest text-zinc-400 hover:text-zinc-100 hover:bg-white/5"
          title="Restore auto-map defaults"
        >
          <RotateCcw className="w-3 h-3" /> Defaults
        </button>
        <span className="text-[8px] text-zinc-700">audio + MIDI run side-by-side</span>
      </div>
    </div>
  );
};
