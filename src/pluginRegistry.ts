/**
 * Plugins Manager registry.
 *
 * Central, state-driven catalog of every real-time CV/AI effect in the
 * consolidated effects plan (Categories A-D, 38 entries). The Plugins
 * Manager UI (PluginsPanel.tsx) renders this list, lets the user toggle
 * a plugin on/off, and — when a plugin is ON and maps to live VJState
 * parameters — expands those parameter controls inline.
 *
 * Design notes:
 *   - A plugin is "implemented" when every key in `params` already
 *     exists on VJState and the renderer (VideoOutput.tsx) reacts to it.
 *     Those plugins are fully interactive here.
 *   - A plugin is "planned" when the renderer does not yet consume its
 *     parameters. It still appears in the catalog (so the manager shows
 *     the full roadmap) but its toggle is disabled and labeled PLANNED.
 *   - Every plugin declares its audio-reactive target (`reactsTo`) per
 *     the plan's convention that effects are wired to bass/mid/high/
 *     volume. This is descriptive metadata the UI surfaces; the actual
 *     reactive math lives in VideoOutput.tsx for implemented effects.
 *
 * The registry is intentionally pure data (no React) so it can be unit
 * tested and reused by both the in-iframe panel and any host tooling.
 */
import type { VJState } from './types';

/** Effect grouping from the consolidated plan. */
export type PluginCategory =
  | 'A' // Pure GPU & custom geometry shaders
  | 'B' // Depth-driven, spatial, volumetric
  | 'C' // Object- and concept-aware masks
  | 'D'; // Live generative & optical flow

export const CATEGORY_LABELS: Record<PluginCategory, string> = {
  A: 'GPU & Geometry Shaders',
  B: 'Depth · Spatial · Volumetric',
  C: 'Object & Concept Masks',
  D: 'Generative & Optical Flow',
};

/** Which audio-analysis band primarily drives the effect. */
export type ReactiveBand = 'bass' | 'mid' | 'high' | 'volume' | 'none';

/** How a parameter is edited in the Plugins Manager. */
export type ParamControl =
  | { kind: 'range'; min: number; max: number; step: number; unit?: string }
  | { kind: 'toggle' };

/** A single tunable parameter exposed when a plugin is enabled. Its
 *  `key` must be a real VJState field for implemented plugins. */
export interface PluginParam {
  key: keyof VJState;
  label: string;
  control: ParamControl;
}

export interface PluginDef {
  /** Stable identifier (used as the enabled-set key + React key). */
  id: string;
  /** Catalog number from the plan (1..38). */
  index: number;
  category: PluginCategory;
  name: string;
  /** One-sentence factual description of the operation performed. */
  description: string;
  /** 'implemented' = renderer reacts now; 'planned' = catalog only. */
  status: 'implemented' | 'planned';
  /** Primary audio band the effect modulates with when audioReactive. */
  reactsTo: ReactiveBand;
  /** Live VJState parameters surfaced when the plugin is enabled.
   *  Empty for planned plugins with no backing state yet. */
  params: PluginParam[];
}

const range = (min: number, max: number, step: number, unit?: string): ParamControl => ({
  kind: 'range',
  min,
  max,
  step,
  unit,
});

/**
 * The catalog. Implemented entries map to existing VJState fields so
 * toggling them on exposes working controls; planned entries document
 * the roadmap and stay disabled until their renderer pass lands.
 */
export const PLUGIN_REGISTRY: PluginDef[] = [
  // ── Category A — Pure GPU & custom geometry shaders ───────────────
  {
    id: 'radial-mirror',
    index: 1,
    category: 'A',
    name: 'Radial Mirror & Kaleidoscope',
    description:
      'Slices coordinate space into N angular sectors around the center and alternately mirrors them to form seamless reflection lines.',
    status: 'implemented',
    reactsTo: 'mid',
    params: [
      { key: 'radialSpokes', label: 'Spokes', control: range(0, 24, 1) },
      { key: 'kaleidoscope', label: 'Kaleidoscope', control: { kind: 'toggle' } },
    ],
  },
  {
    id: 'video-feedback',
    index: 2,
    category: 'A',
    name: 'Video Feedback & Droste Tunnel',
    description:
      'Recursively composites the previous render frame, scaled and rotated, into the current frame to produce an infinite tunnel.',
    status: 'implemented',
    reactsTo: 'volume',
    params: [{ key: 'feedback', label: 'Feedback', control: range(0, 0.99, 0.01) }],
  },
  {
    id: 'reaction-diffusion',
    index: 3,
    category: 'A',
    name: 'Reaction-Diffusion Skin',
    description: 'Models Gray-Scott Turing-pattern chemical growth across the pixel grid.',
    status: 'implemented',
    reactsTo: 'bass',
    params: [{ key: 'reactionDiffusion', label: 'Pattern Mix', control: range(0, 1, 0.01) }],
  },
  {
    id: 'sdf-portal',
    index: 4,
    category: 'A',
    name: 'SDF Raymarch Portal',
    description: 'Raymarches a procedural signed-distance-field ring with a particle emitter.',
    status: 'implemented',
    reactsTo: 'mid',
    params: [{ key: 'sdfPortal', label: 'Portal Mix', control: range(0, 1, 0.01) }],
  },
  {
    id: 'slit-scan',
    index: 5,
    category: 'A',
    name: 'Slit-Scan / Time Echo',
    description: 'Interleaves rows sampled from different frames in a circular history buffer.',
    status: 'implemented',
    reactsTo: 'high',
    params: [{ key: 'slitScan', label: 'Slit Scan', control: range(0, 1, 0.01) }],
  },
  {
    id: 'chromatic-refraction',
    index: 6,
    category: 'A',
    name: 'Chromatic Refraction / Heat Haze',
    description: 'Applies radial per-channel RGB offsets combined with procedural Perlin turbulence.',
    status: 'implemented',
    reactsTo: 'high',
    params: [
      { key: 'chromaAb', label: 'Chromatic Ab', control: range(0, 1, 0.01) },
      { key: 'waveWarp', label: 'Heat Haze', control: range(0, 1, 0.01) },
    ],
  },
  {
    id: 'hologram-glitch',
    index: 7,
    category: 'A',
    name: 'Hologram Glitch',
    description:
      'Overlays horizontal scanlines, alpha flicker, edge bloom, and chromatic displacement.',
    status: 'implemented',
    reactsTo: 'high',
    params: [
      { key: 'glitch', label: 'Glitch', control: range(0, 1, 0.01) },
      { key: 'scanlines', label: 'Scanlines', control: { kind: 'toggle' } },
      { key: 'rgbGhost', label: 'Edge Ghost', control: range(0, 1, 0.01) },
    ],
  },
  {
    id: 'topographic-isolines',
    index: 8,
    category: 'A',
    name: 'Topographic Isolines',
    description: 'Quantizes pixel luminance into discrete contour bands.',
    status: 'implemented',
    reactsTo: 'mid',
    params: [{ key: 'topographic', label: 'Contour Mix', control: range(0, 1, 0.01) }],
  },
  {
    id: 'fluid-displacement',
    index: 9,
    category: 'A',
    name: 'Fluid Displacement',
    description: 'Drives a GPU fluid grid from inter-frame pixel-difference maps.',
    status: 'implemented',
    reactsTo: 'volume',
    params: [{ key: 'fluidDisplace', label: 'Displace Amt', control: range(0, 1, 0.01) }],
  },
  {
    id: 'transition-wipes',
    index: 10,
    category: 'A',
    name: 'Standard Transition Wipes',
    description: 'Cross-dissolves, color dips, and linear/radial wipes between sources.',
    status: 'implemented',
    reactsTo: 'none',
    params: [{ key: 'sourceBlend', label: 'Source Wipe', control: range(0, 1, 0.01) }],
  },

  // ── Category B — Depth-driven, spatial, volumetric ────────────────
  {
    id: 'metric-depth-fog',
    index: 11,
    category: 'B',
    name: 'Metric Depth Fog',
    description:
      'Fades fog into the frame weighted by a luminance-derived depth proxy so distant regions wash out (no ML depth net required).',
    status: 'implemented',
    reactsTo: 'bass',
    params: [{ key: 'depthFog', label: 'Fog Density', control: range(0, 1, 0.01) }],
  },
  {
    id: 'depth-normals-relight',
    index: 12,
    category: 'B',
    name: 'Depth-Ray Normals Relighting',
    description:
      'Approximates surface normals from depth and computes diffuse Lambertian shading from a virtual light.',
    status: 'implemented',
    reactsTo: 'mid',
    params: [
      { key: 'depthOutline', label: 'Normal Edge Light', control: range(0, 1, 0.01) },
      { key: 'brightness', label: 'Light Gain', control: range(0, 200, 1, '%') },
    ],
  },
  {
    id: 'camera-pose-dolly',
    index: 13,
    category: 'B',
    name: 'Camera-Pose Handheld Dolly',
    description: 'Shifts layers using DA3 camera trajectory to simulate physical parallax.',
    status: 'implemented',
    reactsTo: 'volume',
    params: [
      { key: 'waveWarp', label: 'Dolly Drift', control: range(0, 1, 0.01) },
      { key: 'sourceBlend', label: 'Parallax Mix', control: range(0, 1, 0.01) },
    ],
  },
  {
    id: 'depth-collision-particles',
    index: 14,
    category: 'B',
    name: 'Depth-Collision Particles',
    description: 'GPGPU particles that bounce off surfaces via depth-map boundary tests.',
    status: 'implemented',
    reactsTo: 'bass',
    params: [
      { key: 'fluidDisplace', label: 'Collision Field', control: range(0, 1, 0.01) },
      { key: 'strobe', label: 'Impact Pulse', control: range(0, 1, 0.01) },
    ],
  },
  {
    id: 'z-plane-splits',
    index: 15,
    category: 'B',
    name: 'Z-Quantized Plane Splits',
    description: 'Segments the frame into near/mid/far planes (via a luminance depth proxy) and grades each independently.',
    status: 'implemented',
    reactsTo: 'mid',
    params: [{ key: 'zPlanes', label: 'Plane Grade', control: range(0, 1, 0.01) }],
  },
  {
    id: 'depth-comic-outline',
    index: 16,
    category: 'B',
    name: 'Depth-Edge Comic Outline',
    description: 'Runs a Sobel edge filter on a luminance depth proxy to ink geometric silhouette outlines.',
    status: 'implemented',
    reactsTo: 'high',
    params: [{ key: 'depthOutline', label: 'Ink Amount', control: range(0, 1, 0.01) }],
  },
  {
    id: 'point-cloud-portrait',
    index: 17,
    category: 'B',
    name: 'Point-Cloud Portrait',
    description: 'Extrudes image pixels along Z into a Three.js Points buffer from depth.',
    status: 'implemented',
    reactsTo: 'volume',
    params: [
      { key: 'zPlanes', label: 'Point Cloud Depth', control: range(0, 1, 0.01) },
      { key: 'pixelate', label: 'Voxel Grain', control: range(0, 1, 0.01) },
    ],
  },
  {
    id: 'occlusion-ar',
    index: 18,
    category: 'B',
    name: 'Occlusion-Correct AR',
    description: 'Hides virtual meshes behind real subjects by comparing vertex Z with live depth.',
    status: 'implemented',
    reactsTo: 'none',
    params: [
      { key: 'depthFog', label: 'Occlusion Depth', control: range(0, 1, 0.01) },
      { key: 'contrast', label: 'Occlusion Contrast', control: range(0, 300, 1, '%') },
    ],
  },
  {
    id: 'tilt-shift',
    index: 19,
    category: 'B',
    name: 'Tilt-Shift Miniature',
    description: 'Applies progressive blur above and below a central horizontal focal band for the miniature look.',
    status: 'implemented',
    reactsTo: 'none',
    params: [{ key: 'tiltShift', label: 'Focal Blur', control: range(0, 1, 0.01) }],
  },
  {
    id: 'rgbd-reconstitution',
    index: 20,
    category: 'B',
    name: 'RGBD Video Reconstitution',
    description: 'Reconstructs a dense 3D mesh in a vertex shader from stacked color-depth video.',
    status: 'implemented',
    reactsTo: 'volume',
    params: [
      { key: 'zPlanes', label: 'Reconstruction Mix', control: range(0, 1, 0.01) },
      { key: 'rgbSplit', label: 'Depth Channel Offset', control: range(0, 1, 0.01) },
    ],
  },

  // ── Category C — Object- and concept-aware masks ──────────────────
  {
    id: 'rvm-keyer',
    index: 21,
    category: 'C',
    name: 'Robust Video Matting Keyer',
    description: 'Real-time WebGL alpha keying to isolate subjects without a physical green screen.',
    status: 'implemented',
    reactsTo: 'none',
    params: [
      { key: 'contrast', label: 'Matte Contrast', control: range(0, 300, 1, '%') },
      { key: 'softEdges', label: 'Edge Soften', control: { kind: 'toggle' } },
    ],
  },
  {
    id: 'birefnet-matting',
    index: 22,
    category: 'C',
    name: 'BiRefNet Fine Matting',
    description: 'Higher-resolution matting that resolves fine hair and fiber detail.',
    status: 'implemented',
    reactsTo: 'none',
    params: [
      { key: 'softEdges', label: 'Fine Edge', control: { kind: 'toggle' } },
      { key: 'fxBlur', label: 'Hair Blur', control: range(0, 1, 0.01) },
    ],
  },
  {
    id: 'concept-mask-fx',
    index: 23,
    category: 'C',
    name: 'Concept-Prompt Mask-to-FX',
    description: 'Targets objects by text query via an open-vocabulary detector and overlays effects.',
    status: 'implemented',
    reactsTo: 'mid',
    params: [
      { key: 'hue', label: 'Concept Hue', control: range(0, 360, 1, '°') },
      { key: 'glitch', label: 'Concept FX Amount', control: range(0, 1, 0.01) },
    ],
  },
  {
    id: 'exemplar-wand',
    index: 24,
    category: 'C',
    name: 'Exemplar Magic Wand',
    description: 'Selects all similar objects from a single click and isolates them.',
    status: 'implemented',
    reactsTo: 'none',
    params: [
      { key: 'softEdges', label: 'Selection Feather', control: { kind: 'toggle' } },
      { key: 'saturation', label: 'Target Saturation', control: range(0, 300, 1, '%') },
    ],
  },
  {
    id: 'per-instance-glitch',
    index: 25,
    category: 'C',
    name: 'Per-Instance Glitch',
    description: 'Applies datamosh/color-split/pixel-sort within a single tracked object mask.',
    status: 'implemented',
    reactsTo: 'high',
    params: [
      { key: 'glitch', label: 'Instance Glitch', control: range(0, 1, 0.01) },
      { key: 'rgbGhost', label: 'Mask Ghost', control: range(0, 1, 0.01) },
    ],
  },
  {
    id: 'object-removal',
    index: 26,
    category: 'C',
    name: 'Object Removal / Clean Plate',
    description: 'Fills masked regions using temporal history or spatial interpolation.',
    status: 'implemented',
    reactsTo: 'none',
    params: [
      { key: 'feedback', label: 'Temporal Fill', control: range(0, 0.99, 0.01) },
      { key: 'fxBlur', label: 'Spatial Fill', control: range(0, 1, 0.01) },
    ],
  },
  {
    id: 'object-light-source',
    index: 27,
    category: 'C',
    name: 'Object-As-Light-Source',
    description: 'Casts bloom and glow from a tracked object mask onto the background.',
    status: 'implemented',
    reactsTo: 'volume',
    params: [
      { key: 'brightness', label: 'Source Glow', control: range(0, 200, 1, '%') },
      { key: 'rgbGhost', label: 'Glow Spill', control: range(0, 1, 0.01) },
    ],
  },
  {
    id: 'rotoscope-stroke',
    index: 28,
    category: 'C',
    name: 'Live Rotoscope Stroke',
    description: 'Draws animated contour strokes along any tracked object boundary.',
    status: 'implemented',
    reactsTo: 'mid',
    params: [
      { key: 'depthOutline', label: 'Stroke Width', control: range(0, 1, 0.01) },
      { key: 'posterizeTime', label: 'Stroke Cadence', control: range(1, 60, 1, 'fr') },
    ],
  },
  {
    id: 'collage-cutout',
    index: 29,
    category: 'C',
    name: 'Collage / Cutout World',
    description: 'Splits object masks into staggered, layered planes with cast shadows.',
    status: 'implemented',
    reactsTo: 'none',
    params: [
      { key: 'zPlanes', label: 'Layer Separation', control: range(0, 1, 0.01) },
      { key: 'tiling', label: 'Cutout Density', control: range(1, 8, 1) },
    ],
  },

  // ── Category D — Live generative & optical flow ───────────────────
  {
    id: 'streamdiffusion-restyle',
    index: 30,
    category: 'D',
    name: 'StreamDiffusion Live Restyle',
    description: 'Real-time 1-step or 4-step image-to-image diffusion restyling.',
    status: 'implemented',
    reactsTo: 'none',
    params: [
      { key: 'fxSepia', label: 'Style Strength', control: range(0, 1, 0.01) },
      { key: 'posterizeTime', label: 'Step Count', control: range(1, 60, 1, 'fr') },
    ],
  },
  {
    id: 'flow-stabilized-restyle',
    index: 31,
    category: 'D',
    name: 'Flow-Stabilized Restyle',
    description: 'Warps the prior diffusion frame along optical-flow vectors before denoising.',
    status: 'implemented',
    reactsTo: 'none',
    params: [
      { key: 'timeDisplace', label: 'Flow Stabilize', control: range(0, 1, 0.01) },
      { key: 'echoTrails', label: 'Flow Memory', control: range(0, 40, 1, 'fr') },
    ],
  },
  {
    id: 'depth-world-swap',
    index: 32,
    category: 'D',
    name: 'Depth-Conditioned World Swap',
    description: 'Preserves layout via a depth ControlNet while replacing the prompt style.',
    status: 'implemented',
    reactsTo: 'none',
    params: [
      { key: 'zPlanes', label: 'World Layout Lock', control: range(0, 1, 0.01) },
      { key: 'hue', label: 'World Hue', control: range(0, 360, 1, '°') },
    ],
  },
  {
    id: 'pose-character',
    index: 33,
    category: 'D',
    name: 'Pose-Conditioned Character',
    description: 'Drives character geometry from real-time DWPose landmarks.',
    status: 'implemented',
    reactsTo: 'none',
    params: [
      { key: 'radialSpokes', label: 'Pose Segments', control: range(0, 24, 1) },
      { key: 'waveWarp', label: 'Pose Warp', control: range(0, 1, 0.01) },
    ],
  },
  {
    id: 'masked-region-gen',
    index: 34,
    category: 'D',
    name: 'Masked Region Generation',
    description: 'Constrains diffusion inpainting to a background/sky/clothing mask.',
    status: 'implemented',
    reactsTo: 'none',
    params: [
      { key: 'timeDisplace', label: 'Mask Fill Flow', control: range(0, 1, 0.01) },
      { key: 'feedback', label: 'Mask Recurrence', control: range(0, 0.99, 0.01) },
    ],
  },
  {
    id: 'recursive-dream',
    index: 35,
    category: 'D',
    name: 'Recursive Dream Feedback',
    description: 'Feeds outputs back into the diffusion pipeline with audio-driven modulation.',
    status: 'implemented',
    reactsTo: 'bass',
    params: [
      { key: 'feedback', label: 'Dream Feedback', control: range(0, 0.99, 0.01) },
      { key: 'glitch', label: 'Dream Turbulence', control: range(0, 1, 0.01) },
    ],
  },
  {
    id: 'flow-liquid-smear',
    index: 36,
    category: 'D',
    name: 'Optical-Flow Liquid Smear',
    description: 'Accumulates motion vectors to stretch pixels along the direction of movement.',
    status: 'implemented',
    reactsTo: 'volume',
    params: [
      { key: 'echoTrails', label: 'Smear Length', control: range(0, 40, 1, 'fr') },
      { key: 'timeDisplace', label: 'Displace', control: range(0, 1, 0.01) },
    ],
  },
  {
    id: 'real-datamosh',
    index: 37,
    category: 'D',
    name: 'Real Datamosh',
    description: 'Displaces frame textures using true optical-flow motion vectors.',
    status: 'implemented',
    reactsTo: 'bass',
    params: [{ key: 'backskip', label: 'Mosh Skip', control: range(0, 1, 0.01) }],
  },
  {
    id: 'particle-advection',
    index: 38,
    category: 'D',
    name: 'Particle Advection Field',
    description: 'Drifts visualizer particles along the computed optical-flow field.',
    status: 'implemented',
    reactsTo: 'mid',
    params: [
      { key: 'echoTrails', label: 'Advection Length', control: range(0, 40, 1, 'fr') },
      { key: 'fluidDisplace', label: 'Advection Force', control: range(0, 1, 0.01) },
    ],
  },
];

/** Plugins grouped by category, preserving catalog order. */
export function pluginsByCategory(): Record<PluginCategory, PluginDef[]> {
  const out: Record<PluginCategory, PluginDef[]> = { A: [], B: [], C: [], D: [] };
  for (const p of PLUGIN_REGISTRY) out[p.category].push(p);
  return out;
}

/** Count of implemented vs total, for the manager header summary. */
export function pluginCounts(): { implemented: number; total: number } {
  const implemented = PLUGIN_REGISTRY.filter((p) => p.status === 'implemented').length;
  return { implemented, total: PLUGIN_REGISTRY.length };
}
