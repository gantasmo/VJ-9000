/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

const vs = `#define STANDARD
varying vec3 vViewPosition;
#ifdef USE_TRANSMISSION
  varying vec3 vWorldPosition;
#endif
#include <common>
#include <batching_pars_vertex>
#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>

uniform float time;
uniform vec4 audioData; // x: bass, y: mids, z: highs
uniform float scrollSpeed;
uniform float mountainHeight;
uniform float isFerrofluid; // 0.0 smooth chrome -> 1.0 ferrofluid spikes

// Base synthwave terrain (mountains + central valley), no spikes. Peaks are
// raised and always present so the landscape never looks like a flat slab.
float baseTerrain(vec3 pos) {
  vec2 p = pos.xy + vec2(0.0, time * scrollSpeed);
  float sideMask = smoothstep(1.2, 4.5, abs(pos.x));
  float n1 = sin(p.x * 0.35) * cos(p.y * 0.22);
  float n2 = sin(p.x * 0.8 + 1.2) * cos(p.y * 0.5) * 0.45;
  float n3 = sin(p.x * 1.6 - 0.5) * cos(p.y * 1.1) * 0.18;
  // Higher peaks (1.7x) with a gentle bass surge.
  float baseMountains = (n1 + n2 + n3) * mountainHeight * 1.7 * (1.0 + 0.45 * audioData.x);
  float valleyWave = sin(p.y * 1.4 - time * 1.6) * 0.25 * (audioData.x + audioData.y);
  return mix(valleyWave, baseMountains, sideMask);
}

// Closely-packed sunflower-seed (hex phyllotaxis) ferrofluid spike field.
// Uses the orb's witch's-hat profile, and a SLOW per-seed ebb so the spikes
// live and breathe in size instead of vanishing/regrowing in a flash.
float spikeField(vec3 pos) {
  if (isFerrofluid < 0.001) return 0.0;
  vec2 p = pos.xy + vec2(0.0, time * scrollSpeed);
  float totalAudio = max(audioData.x, max(audioData.y, audioData.z));

  // Dense golden-angle quasicrystal of spikes: a fuckload of tightly-packed
  // bumps in coherent phyllotaxis "crazy" patterns (the orb's spike field on a
  // plane). It's uniform everywhere — no tiles/centers — so nothing pops in and
  // out at seams; the whole pattern just scrolls smoothly with the terrain.
  float phi = 1.61803398875;
  float dens = 8.0; // higher = more tightly packed spikes
  float field = 0.0;
  for (int i = 0; i < 7; i++) {
    float a = float(i) * 2.39996323; // golden angle (137.5 deg)
    field += cos(dot(p, vec2(cos(a), sin(a))) * dens);
  }
  float grid = clamp(field / 7.0 * 0.5 + 0.5, 0.0, 1.0);

  // Low-frequency golden size variation (fractal feel) — slow, no flicker.
  float macro = cos(p.x / phi) * sin(p.y / phi);
  float romanesco = 0.6 + 0.4 * (macro * 0.5 + 0.5);

  // Orb's witch's-hat profile (broad foot + magnetic apex needle + micro-cusp).
  // Wider foot (low exponent) so adjacent spike bases flare out and touch.
  float foot = pow(grid, 1.3);
  float magneticStrength = isFerrofluid * (0.15 + 0.85 * totalAudio);
  float apexExp = mix(5.0, 28.0, magneticStrength);
  float apexMul = mix(0.1, 7.0, magneticStrength);
  float apex = pow(grid, apexExp) * apexMul;
  float profile = (foot + apex) / (1.0 + apexMul);
  float sharpTip = 1.0 - pow(1.5 * (1.0 - grid), 0.75);
  profile = mix(profile, profile * clamp(sharpTip, 0.0, 1.0), isFerrofluid);

  // Slow per-seed ebb-and-flow + persistent base + audio boost (never hits 0).
  float ebb = 0.55 + 0.45 * sin(time * 0.5 + p.x * 1.3 + p.y * 0.9);
  float amount = (0.4 + 0.9 * totalAudio) * ebb;

  return profile * mountainHeight * 3.0 * romanesco * amount * isFerrofluid;
}

// Full displaced position: base terrain + spikes grown ALONG the base surface
// normal, so the needles conform to the slopes instead of all standing
// straight up.
vec3 calcLandscape(vec3 pos) {
  float e = 0.18; // broad step -> spikes lean to follow the big contours/edges
  float b0 = baseTerrain(pos);
  float bx = baseTerrain(pos + vec3(e, 0.0, 0.0));
  float by = baseTerrain(pos + vec3(0.0, e, 0.0));
  vec3 baseN = normalize(cross(vec3(e, 0.0, bx - b0), vec3(0.0, e, by - b0)));
  float s = spikeField(pos);
  return pos + vec3(0.0, 0.0, b0) + baseN * s;
}

void main() {
  #include <uv_vertex>
  #include <color_vertex>
  #include <morphinstance_vertex>
  #include <morphcolor_vertex>
  #include <batching_vertex>
  #include <beginnormal_vertex>
  #include <morphnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <normal_vertex>
  #include <begin_vertex>

  float inc = 0.02;

  vec3 np = calcLandscape(position);

  // Central-difference normal from the fully displaced surface (captures the
  // tilted spikes for correct lighting).
  vec3 npDX = calcLandscape(position + vec3(inc, 0.0, 0.0));
  vec3 npDY = calcLandscape(position + vec3(0.0, inc, 0.0));

  vec3 tangent = normalize(npDX - np);
  vec3 bitangent = normalize(npDY - np);
  transformedNormal = normalMatrix * normalize(cross(tangent, bitangent));
  vNormal = normalize(transformedNormal);

  transformed = np;

  #include <morphtarget_vertex>
  #include <skinning_vertex>
  #include <displacementmap_vertex>
  #include <project_vertex>
  #include <logdepthbuf_vertex>
  #include <clipping_planes_vertex>
  vViewPosition = - mvPosition.xyz;
  #include <worldpos_vertex>
  #include <shadowmap_vertex>
  #include <fog_vertex>
  #ifdef USE_TRANSMISSION
    vWorldPosition = worldPosition.xyz;
  #endif
}
`;

export { vs };
