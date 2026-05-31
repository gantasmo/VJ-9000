/**
 * Plugins Manager panel.
 *
 * Renders the PLUGIN_REGISTRY catalog grouped by category (A-D). Each
 * plugin can be toggled on/off. Implemented plugins expose their live
 * VJState parameters inline when enabled; planned plugins are listed for
 * roadmap visibility but their toggle is disabled and labeled PLANNED.
 *
 * Styling mirrors VJControls' dark/cyan aesthetic (bg-[#111],
 * text-[10px] uppercase font-mono tracking-widest).
 */
import React, { useState } from 'react';
import { Boxes, ChevronRight } from 'lucide-react';
import type { VJState } from '../types';
import {
  PLUGIN_REGISTRY,
  CATEGORY_LABELS,
  pluginsByCategory,
  pluginCounts,
  type PluginCategory,
  type PluginDef,
  type PluginParam,
  type ReactiveBand,
} from '../pluginRegistry';

interface PluginsPanelProps {
  state: VJState;
  updateState: (updates: Partial<VJState>) => void;
}

const BAND_COLOR: Record<ReactiveBand, string> = {
  bass: 'text-red-400 border-red-900/60',
  mid: 'text-amber-400 border-amber-900/60',
  high: 'text-cyan-400 border-cyan-900/60',
  volume: 'text-emerald-400 border-emerald-900/60',
  none: 'text-zinc-500 border-zinc-800',
};

const CATEGORY_ORDER: PluginCategory[] = ['A', 'B', 'C', 'D'];

interface ParamRowProps {
  param: PluginParam;
  state: VJState;
  updateState: (updates: Partial<VJState>) => void;
}

/** A single live parameter control bound to a VJState field. */
const ParamRow: React.FC<ParamRowProps> = ({ param, state, updateState }) => {
  if (param.control.kind === 'toggle') {
    const active = Boolean(state[param.key]);
    return (
      <div className="flex items-center justify-between py-1">
        <span className="text-[9px] uppercase font-mono tracking-widest text-zinc-400">
          {param.label}
        </span>
        <button
          onClick={() => updateState({ [param.key]: !active } as Partial<VJState>)}
          className={`h-5 px-2 text-[8px] uppercase font-mono tracking-widest border rounded-sm transition-all ${
            active
              ? 'bg-cyan-900/30 border-cyan-500 text-cyan-300'
              : 'bg-black border-zinc-800 text-zinc-600 hover:border-zinc-500 hover:text-zinc-300'
          }`}
        >
          {active ? 'ON' : 'OFF'}
        </button>
      </div>
    );
  }

  const { min, max, step, unit } = param.control;
  const value = Number(state[param.key] ?? min);
  const percentage = ((value - min) / (max - min)) * 100;

  return (
    <div className="flex flex-col py-1">
      <div className="flex justify-between items-center text-[9px] uppercase font-mono tracking-widest text-zinc-400 mb-1">
        <span>{param.label}</span>
        <span className="text-zinc-300">
          {value.toFixed(step >= 1 ? 0 : 2)}
          {unit ?? ''}
        </span>
      </div>
      <div className="relative w-full h-4 bg-black rounded-sm overflow-hidden border border-zinc-800">
        <div
          className="absolute top-0 left-0 h-full bg-gradient-to-r from-cyan-900 to-cyan-500 pointer-events-none"
          style={{ width: `${percentage}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => updateState({ [param.key]: Number(e.target.value) } as Partial<VJState>)}
          className="absolute inset-0 w-full h-full opacity-0 cursor-crosshair"
        />
      </div>
    </div>
  );
};

interface PluginRowProps {
  plugin: PluginDef;
  enabled: boolean;
  onToggle: () => void;
  state: VJState;
  updateState: (updates: Partial<VJState>) => void;
}

/** A single plugin row with toggle + inline params when enabled. */
const PluginRow: React.FC<PluginRowProps> = ({ plugin, enabled, onToggle, state, updateState }) => {
  const isPlanned = plugin.status === 'planned';
  const open = enabled && !isPlanned;
  const soloed = state.soloPluginId === plugin.id;


  return (
    <div
      className={`border rounded-sm transition-colors ${
        soloed
          ? 'border-amber-500 bg-amber-950/20'
          : open
          ? 'border-cyan-900/50 bg-cyan-950/10'
          : 'border-zinc-900 bg-black/40'
      }`}
    >
      <div className="flex items-stretch">
      <button
        onClick={onToggle}
        disabled={isPlanned}
        className={`flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left transition-colors ${
          isPlanned ? 'opacity-50 cursor-not-allowed' : 'hover:bg-zinc-900/40'
        }`}
        title={plugin.description}
      >

        <ChevronRight
          className={`w-3 h-3 shrink-0 transition-transform ${open ? 'rotate-90 text-cyan-400' : 'text-zinc-600'}`}
        />
        <span className="text-[8px] font-mono text-zinc-600 w-5 shrink-0">
          {String(plugin.index).padStart(2, '0')}
        </span>
        <span
          className={`flex-1 text-[10px] uppercase font-mono tracking-widest truncate ${
            open ? 'text-cyan-300' : 'text-zinc-400'
          }`}
        >
          {plugin.name}
        </span>
        <span
          className={`text-[7px] uppercase font-mono tracking-widest px-1 py-0.5 border rounded-sm shrink-0 ${BAND_COLOR[plugin.reactsTo]}`}
          title={`Reacts to ${plugin.reactsTo}`}
        >
          {plugin.reactsTo}
        </span>
        {isPlanned ? (
          <span className="text-[7px] uppercase font-mono tracking-widest text-zinc-600 border border-zinc-800 rounded-sm px-1 py-0.5 shrink-0">
            PLANNED
          </span>
        ) : (
          <span
            className={`text-[8px] uppercase font-mono tracking-widest px-1.5 py-0.5 border rounded-sm shrink-0 ${
              enabled
                ? 'bg-cyan-900/30 border-cyan-500 text-cyan-300'
                : 'bg-black border-zinc-700 text-zinc-500'
            }`}
          >
            {enabled ? 'ON' : 'OFF'}
          </span>
        )}
      </button>

      {!isPlanned && (
        <button
          onClick={() =>
            updateState({ soloPluginId: soloed ? null : plugin.id })
          }
          title={
            soloed
              ? 'Exit SOLO — restore all effects'
              : 'SOLO this effect — bypass every other effect so you can set up its MIDI mapping in isolation'
          }
          className={`shrink-0 px-2 my-1 mr-1 text-[8px] uppercase font-mono tracking-widest border rounded-sm transition-all ${
            soloed
              ? 'bg-amber-500 border-amber-400 text-black font-bold animate-pulse'
              : 'bg-black border-zinc-700 text-zinc-500 hover:border-amber-500 hover:text-amber-300'
          }`}
        >
          SOLO
        </button>
      )}
      </div>

      {open && (

        <div className="px-3 pb-2 pt-1 border-t border-zinc-900/80 space-y-0.5">
          <p className="text-[8px] font-mono text-zinc-600 leading-relaxed mb-1">
            {plugin.description}
          </p>
          {plugin.params.map((param) => (
            <ParamRow
              key={String(param.key)}
              param={param}
              state={state}
              updateState={updateState}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export function PluginsPanel({ state, updateState }: PluginsPanelProps) {
  // Local enabled set. Implemented plugins default to ON when their
  // backing params already hold non-default values, but to keep this
  // panel a pure UI surface we simply start empty and let the user opt
  // in; the underlying VJState is the real source of truth either way.
  const [enabled, setEnabled] = useState<Set<string>>(new Set());

  const groups = pluginsByCategory();
  const counts = pluginCounts();

  const toggle = (id: string) => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="mx-3 my-3 p-3 border border-zinc-800 bg-[#111] rounded space-y-3">
      <h2 className="text-[10px] text-zinc-400 uppercase tracking-widest font-mono border-b border-zinc-800 pb-1 mb-1 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <Boxes className="w-3 h-3 text-cyan-500" /> PLUGINS // MANAGER
        </span>
        <span className="text-[8px] text-zinc-600">
          {counts.implemented}/{counts.total} LIVE
        </span>
      </h2>

      {state.soloPluginId && (
        <div className="flex items-center justify-between gap-2 px-2 py-1.5 border border-amber-500 bg-amber-950/30 rounded-sm animate-pulse">
          <span className="text-[9px] uppercase font-mono tracking-widest text-amber-300 font-bold">
            ◉ SOLO ACTIVE —{' '}
            {PLUGIN_REGISTRY.find((p) => p.id === state.soloPluginId)?.name ?? state.soloPluginId}
          </span>
          <button
            onClick={() => updateState({ soloPluginId: null })}
            className="shrink-0 px-2 py-0.5 text-[8px] uppercase font-mono tracking-widest border border-amber-400 text-amber-200 rounded-sm hover:bg-amber-500 hover:text-black transition-all"
          >
            CLEAR
          </button>
        </div>
      )}

      {CATEGORY_ORDER.map((cat) => (

        <div key={cat} className="space-y-1">
          <h3 className="text-[9px] uppercase font-mono tracking-widest text-zinc-500 flex items-center gap-1.5 pt-1">
            <span className="text-cyan-600 font-bold">{cat}</span>
            <span>{CATEGORY_LABELS[cat]}</span>
          </h3>
          <div className="space-y-1">
            {groups[cat].map((plugin) => (
              <PluginRow
                key={plugin.id}
                plugin={plugin}
                enabled={enabled.has(plugin.id)}
                onToggle={() => toggle(plugin.id)}
                state={state}
                updateState={updateState}
              />
            ))}
          </div>
        </div>
      ))}

      <p className="text-[8px] font-mono text-zinc-600 leading-relaxed border-t border-zinc-900 pt-2">
        {PLUGIN_REGISTRY.length} effects cataloged. Implemented plugins expose live controls; planned
        entries activate as their renderer passes land.
      </p>
    </section>
  );
}
