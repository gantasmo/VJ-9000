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

// We pass the 16 frequency bands of our analyser
uniform float audioLevels[16];

// The smoothly interpolated continuous mode index (0.0 to 15.0)
uniform float activeModeIndex;

// The smoothly animated resonance amplitude based on physical inertia
uniform float smoothedAmplitude;

// Global parameters to fine-tune the liquid metal Cymatic effect
uniform float cymaticAmplitude;

// Predefined 16 distinct, highly beautiful, mathematically authentic Chladni & Faraday modes
// n, m indices correspond to the frequency bands
float ns[16] = float[16](2.0, 3.0, 3.0, 4.0, 4.0, 5.0, 5.0, 6.0, 6.0, 6.0, 7.0, 7.0, 8.0, 8.0, 10.0, 12.0);
float ms[16] = float[16](2.0, 1.0, 3.0, 2.0, 4.0, 3.0, 5.0, 2.0, 4.0, 6.0, 3.0, 5.0, 4.0, 8.0,  6.0,  10.0);
float signs[16] = float[16](1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0, 1.0, -1.0,  1.0,  -1.0);

float getCymaticValue(float u, float v, float r, float theta, int idx, float t) {
  float n = ns[idx];
  float m = ms[idx];
  float s = signs[idx];

  // 1. Classical Chladni plate standing wave solution converted to smooth traveling waves via quadrature phase offset.
  // Instead of multiplying the entire geometry by a single global sine carrier, we shift the phases of individual
  // components out-of-phase (sin/cos). This ensures the peaks and valleys continuously migrate/ripple across the surface
  // and the total wave energy never collapses to flat simultaneously (which is the source of reflective flash and strobing).
  float chladni1 = cos(n * PI * u) * cos(m * PI * v);
  float chladni2 = cos(m * PI * u) * cos(n * PI * v);
  float chladni = chladni1 * sin(t * 3.5) + s * chladni2 * cos(t * 3.5);

  // 2. Faraday liquid cell polar standing waves converted to centrifugal propagating ripples:
  // - cos(m * PI * r - t * 3.5) continuously translates circles outward/inward, simulating natural fluidic propagation.
  // - cos(n * theta - t * 0.4) smoothly rotates the nodal spokes.
  float polarCymatic = cos(m * PI * r - t * 3.5) * cos(n * theta - t * 0.4);

  // Even modes have a square tray look, odd modes have a round, polar fluidic look
  float geometryMix = mod(float(idx), 2.0) == 0.0 ? 0.3 : 0.7;
  float val = mix(chladni, polarCymatic, geometryMix);

  return val;
}

vec3 calcPlane( vec3 pos ) {
  // Normalize pos.x and pos.y from [-1.75, 1.75] to [-1.0, 1.0] for exact plate boundaries
  float u = pos.x / 1.75;
  float v = pos.y / 1.75;
  float r = length(vec2(u, v));
  float theta = atan(v, u);

  // Interpolate between the two adjacent mode indices for a seamless fluid morphing effect
  int idx0 = clamp(int(floor(activeModeIndex)), 0, 15);
  int idx1 = clamp(idx0 + 1, 0, 15);
  float tBlend = fract(activeModeIndex);

  float val0 = getCymaticValue(u, v, r, theta, idx0, time);
  float val1 = getCymaticValue(u, v, r, theta, idx1, time);
  float z = mix(val0, val1, tBlend);

  // 4. Physical Inertia & Amplitude scaling
  // Quiet baseline breathing is removed entirely so the surface rests perfectly on silence
  float excitation = 0.45 * smoothedAmplitude;
  z *= excitation;

  // 5. Clamped Boundary Conditions
  // Displacement goes to 0 gracefully at the edges of the square tray to contain the mercury
  float edgeDamping = (1.0 - smoothstep(0.85, 1.0, abs(u))) * (1.0 - smoothstep(0.85, 1.0, abs(v)));
  z *= edgeDamping;

  // Global scale factor
  z *= cymaticAmplitude;

  return pos + vec3(0.0, 0.0, z);
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

  float inc = 0.01; // central difference step size suitable for our vertex density

  vec3 np = calcPlane( position );

  // Central difference numerical differentiation to obtain exact mathematical surface normals
  vec3 npDX = calcPlane( position + vec3(inc, 0.0, 0.0) );
  vec3 npDY = calcPlane( position + vec3(0.0, inc, 0.0) );

  vec3 tangent = normalize( npDX - np );
  vec3 bitangent = normalize( npDY - np );

  // Cross product of tangent vectors produces correct normal in the local +Z coordinate system
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
}
`;

export { vs };
