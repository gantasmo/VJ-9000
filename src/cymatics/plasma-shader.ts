/**
 * Plasma-ball shader for the synthwave "sun" — a turbulent purple plasma sphere
 * (animated fbm filaments + a hot white core + a fresnel rim) and a matching
 * additive fresnel halo. Written for THREE.ShaderMaterial (GLSL ES 1.0).
 */

// Shared vertex shader: passes local position, view-space normal, view dir.
export const plasmaVS = `
varying vec3 vPos;
varying vec3 vNrm;
varying vec3 vView;
void main() {
  vPos = position;
  vNrm = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

export const plasmaFS = `
precision highp float;
uniform float time;
uniform float intensity;
uniform vec3 colorLow;
uniform vec3 colorHigh;
varying vec3 vPos;
varying vec3 vNrm;
varying vec3 vView;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i + vec3(0.0, 0.0, 0.0)), hash(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(hash(i + vec3(0.0, 1.0, 0.0)), hash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(hash(i + vec3(0.0, 0.0, 1.0)), hash(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(hash(i + vec3(0.0, 1.0, 1.0)), hash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
float fbm(vec3 p) {
  float v = 0.0;
  float a = 0.55;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}

void main() {
  vec3 q = normalize(vPos);
  // Two swirling octaves of turbulence = drifting plasma filaments.
  float n  = fbm(q * 3.0 + vec3(0.0, time * 0.6, time * 0.3));
  float n2 = fbm(q * 6.5 - vec3(time * 0.45, 0.0, time * 0.5));
  float plasma = pow(clamp(n * 0.65 + n2 * 0.6, 0.0, 1.0), 1.6);
  // Bright fresnel rim.
  float fres = pow(1.0 - max(dot(normalize(vNrm), normalize(vView)), 0.0), 2.5);
  vec3 col = mix(colorLow, colorHigh, plasma);
  col += colorHigh * fres * 0.55;
  col += vec3(1.0, 0.85, 1.0) * pow(plasma, 5.0) * 0.5; // hot white filament cores (tighter)
  gl_FragColor = vec4(col * intensity, 1.0);
}
`;

// Additive fresnel halo for the outer glow shell (BackSide sphere).
export const haloFS = `
precision highp float;
uniform vec3 color;
varying vec3 vPos;
varying vec3 vNrm;
varying vec3 vView;
void main() {
  float fres = pow(1.0 - max(dot(normalize(vNrm), normalize(vView)), 0.0), 3.0);
  gl_FragColor = vec4(color * fres, fres);
}
`;
