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
uniform vec4 inputData; // Packed audio tracking data (x: bass, y: mids, z: highs, w: amplitude)
uniform vec4 outputData; // Same packed format for output stream

uniform float spikeDensity;
uniform float spikeAmplitude;
uniform float noiseViscosity;
uniform float isFerrofluid; // 0.0 (smooth ripples) to 1.0 (sharp ferrofluid needles)

float rosensweig(vec3 p, float t, vec4 audio) {
  // Normalize p to unit sphere to compute pure angular coordinates
  vec3 np = normalize(p);

  // 1. Natural magnetic pole field dropoff:
  // Strongest field at the top and bottom poles, dropping off smoothly at the equator.
  float fieldStrength = abs(np.y); // Ranges from 0 at equator to 1 at poles
  fieldStrength = pow(fieldStrength, 1.5);

  float totalAudio = max(audio.x, max(audio.y, audio.z));

  // 2. Fibonacci / Sunflower phyllotaxis cross-hatching spiral wave grid
  // Introduce a highly dynamic, audio-reactive rotational swing.
  // Slow background drift + energetic transient rotation on mids (audio.y) and highs (audio.z).
  float beatSpin = (audio.y * 1.8 + audio.z * 1.4);
  float theta = atan(np.z, np.x) + t * 0.08 + beatSpin;  // Longitude angle with reactive spin
  float phi = acos(clamp(np.y, -0.999, 0.999));       // Latitude angle from north pole

  // Symmetricize north/south hemispheres for uniform polar alignment
  float symPhi = phi;
  if (symPhi > 1.5707963) {
    symPhi = 3.14159265 - symPhi;
  }

  // Logarithmic spiral coordinates
  float logR = log(max(0.01, symPhi));

  // Consecutive Fibonacci winding numbers (13, 21, 34)
  // This produces Golden Ratio cross-hatching sunflower seed lattice centers
  float arm1 = cos(13.0 * theta - 21.0 * logR);
  float arm2 = cos(-21.0 * theta - 34.0 * logR);

  // Combine intersecting spiral wave fronts
  float grid = (arm1 + arm2) / 2.0;
  grid = grid * 0.5 + 0.5; // Map to [0.0, 1.0]

  // Implement the physical double-curvature Hershey's Kiss / "Witch's Hat" silhouette:
  // 1. Broad candle-foot flare near base (low exponent) — widened so adjacent
  //    spike bases flare out and touch.
  float foot = pow(grid, 1.3);

  // 2. High-strength magnetic apex needle core (high exponent, scales dynamically with total audio response)
  float magneticStrength = isFerrofluid * (0.15 + 0.85 * totalAudio) * fieldStrength;

  // Higher magnetic intensity creates sharper, narrower, taller spikes
  float apexExp = mix(5.0, 28.0, magneticStrength);
  float apexMultiplier = mix(0.1, 7.0, magneticStrength);
  float apex = pow(grid, apexExp) * apexMultiplier;

  // Combine base and apex to construct splayed profile
  float profile = (foot + apex) / (1.0 + apexMultiplier);

  // 3. Apply a sharp-tapering micro-cusp filter near the extreme point (grid == 1.0)
  // to avoid standard rounded vertex blunting, giving is perfect needle tips under high fields
  float sharpTip = 1.0 - pow(1.5 * (1.0 - grid), 0.75);
  profile = mix(profile, profile * clamp(sharpTip, 0.0, 1.0), isFerrofluid);

  return profile * fieldStrength;
}

vec3 calc( vec3 pos, vec3 norm ) {
  float t = time * noiseViscosity;

  vec4 totalAudio = inputData + outputData;
  float bass = totalAudio.x;
  float mids = totalAudio.y;
  float highs = totalAudio.z;
  float volume = max(bass, max(mids, highs));

  // Strictly enforce complete stillness when silent
  if (volume < 0.01) {
    return pos;
  }

  // Organic, slow, low-intensity fluid pulsation (pulsing on bass)
  // Highly subtle and low amplitude to prevent excessive shape distortion/shaking
  float pulsation = (0.015 * bass) * sin(t * 0.4 + pos.y * 0.6) * cos(t * 0.35 + pos.x * 0.5);

  // High-frequency structured ferrofluid spikes
  float spikeValue = rosensweig(pos, t, totalAudio);

  // Spacing stays LOCKED. Only height and sharpness scale dynamically with audio intensity.
  float dynamicAmp = spikeAmplitude * volume * (0.2 + 0.8 * (bass + mids + highs * 1.2));

  float displacement = pulsation + (spikeValue * dynamicAmp);

  return pos + norm * displacement;
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

  float inc = 0.005;

  vec3 np = calc( position, objectNormal );

  // Construct a tangent-space coordinate frame at this vertex
  vec3 t1 = cross(objectNormal, vec3(0.0, 1.0, 0.0));
  if (length(t1) < 0.01) {
    t1 = cross(objectNormal, vec3(0.0, 0.0, 1.0));
  }
  t1 = normalize(t1);
  vec3 t2 = cross(objectNormal, t1); // Orthonormal second tangent

  // Sample displacements of neighboring vertices in tangent plane
  vec3 p1 = position + t1 * inc;
  vec3 p2 = position + t2 * inc;

  vec3 np1 = calc( p1, objectNormal );
  vec3 np2 = calc( p2, objectNormal );

  vec3 tangent = normalize( np1 - np );
  vec3 bitangent = normalize( np2 - np );

  // Recalculating the exact surface normal post-displacement
  transformedNormal = normalMatrix * normalize( cross( tangent, bitangent ) );
  vNormal = normalize( transformedNormal );

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
}`;

export {vs};
