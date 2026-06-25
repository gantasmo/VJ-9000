/**
 * AkvjCloudRenderer — renders a live Azure Kinect depth+colour stream as a GPU
 * point cloud (or Battlezone-style wireframe), the native ``akvj3d`` VJ source.
 * The headless pyk4a sidecar streams a one-time XY unprojection table plus
 * per-frame depth16 + depth-aligned colour, and this unprojects
 * ``position = (rayX, rayY, 1) * depthMeters`` in the vertex shader, so the deck
 * owns the look: point size, per-style BEHAVIOUR (drift / evaporate / swirl /
 * scatter), voxelisation, colour mode, wireframe, audio reactivity, and camera
 * spin — none of which a pre-rendered video could expose.
 *
 * Caller-owned offscreen canvas at a fixed size (so it can be ``captureStream()``
 * -ed into the VJ feed), driven by the VJ's ``getLevels()`` (bass/mid/high/volume).
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';

export interface AkvjLevels {
  bass: number;
  mid: number;
  high: number;
  volume: number;
}

// Per-style vertex behaviour (animation), selected by uBehavior.
const DRIFT = 0;
const EVAPORATE = 1;
const SWIRL = 2;
const SCATTER = 3;

export interface AkvjStyle {
  key: string;
  label: string;
  size: number; // base point size (depth-attenuated + clamped in shader)
  displace: number; // displacement amount (meaning depends on behaviour)
  colorMode: number; // 0 rgb, 1 depth-gradient, 2 chrome, 3 neon, 4 electric, 5 ferro
  additive: boolean; // additive blending (glow) vs normal
  square: boolean; // square sprites vs round points
  behavior?: number; // DRIFT | EVAPORATE | SWIRL | SCATTER (default DRIFT)
  voxel?: number; // voxel grid size in meters, snaps positions (0 = off)
  wire?: boolean; // render as the green wireframe instead of points
  noiseFreq?: number; // spatial frequency of the flow noise (default 0.9)
  flowSpeed?: number; // time scroll speed of the flow noise (default 0.25)
  spike?: number; // radial outward spike magnitude (ferrofluid) (default 0)
}

/** Global cloud controls (shared by KINECT + DEPTH), live-tweakable. */
export interface AkvjParams {
  spin: number; // -1..1 orbit speed (0 = frozen, face-on)
  speed: number; // animation-speed multiplier
  size: number; // particle-size multiplier
  density: number; // 0..1 fraction of points shown
  bright: number; // brightness multiplier
  bloom: number; // bloom strength
  wind: number; // wind affector strength
  trails: number; // motion-trail (afterimage) amount
  distance: number; // camera distance multiplier
  renderFps: number; // render-loop cap (>=60 = uncapped); throttles GPU work
}

export const AKVJ_PARAMS_DEFAULT: AkvjParams = {
  spin: 0,
  speed: 1,
  size: 1,
  density: 1,
  bright: 1,
  bloom: 0.5,
  wind: 0,
  trails: 0,
  distance: 1,
  renderFps: 60,
};

/** Particle looks the user flips through (the "STYLE" selector). */
export const AKVJ_STYLES: AkvjStyle[] = [
  { key: 'points', label: 'POINTS', size: 1.0, displace: 0.06, colorMode: 0, additive: false, square: false, behavior: DRIFT },
  { key: 'dust', label: 'DUST', size: 0.7, displace: 0.18, colorMode: 0, additive: true, square: false, behavior: DRIFT },
  { key: 'flow', label: 'FLOW', size: 1.0, displace: 0.5, colorMode: 0, additive: false, square: false, behavior: DRIFT, noiseFreq: 1.1, flowSpeed: 0.5 },
  { key: 'swirl', label: 'SWIRL', size: 1.0, displace: 0.6, colorMode: 1, additive: false, square: false, behavior: SWIRL },
  { key: 'scatter', label: 'SCATTER', size: 1.1, displace: 0.3, colorMode: 0, additive: true, square: false, behavior: SCATTER },
  { key: 'neonvox', label: 'NEONVOX', size: 2.4, displace: 0.12, colorMode: 3, additive: true, square: true, behavior: EVAPORATE, voxel: 0.05 },
  { key: 'wire', label: 'WIRE', size: 1.0, displace: 0.0, colorMode: 0, additive: true, square: false, behavior: DRIFT, wire: true },
  { key: 'electric', label: 'ELECTRIC', size: 0.9, displace: 0.4, colorMode: 4, additive: true, square: false, behavior: DRIFT, noiseFreq: 2.3, flowSpeed: 1.6 },
  { key: 'ferro', label: 'FERRO', size: 1.3, displace: 0.05, colorMode: 5, additive: false, square: false, behavior: DRIFT, noiseFreq: 1.1, flowSpeed: 0.3, spike: 0.55 },
  { key: 'chrome', label: 'CHROME', size: 1.2, displace: 0.15, colorMode: 2, additive: false, square: false, behavior: DRIFT },
  { key: 'spectrum', label: 'SPECTRUM', size: 1.1, displace: 0.25, colorMode: 6, additive: true, square: false, behavior: SCATTER },
  { key: 'aurora', label: 'AURORA', size: 1.0, displace: 0.7, colorMode: 3, additive: true, square: false, behavior: SWIRL, noiseFreq: 0.8, flowSpeed: 0.4 },
  { key: 'embers', label: 'EMBERS', size: 1.4, displace: 0.16, colorMode: 3, additive: true, square: false, behavior: EVAPORATE },
  { key: 'confetti', label: 'CONFETTI', size: 2.6, displace: 0.3, colorMode: 0, additive: false, square: true, behavior: DRIFT },
];

// Shared GLSL: simplex noise + helpers, injected into the point + line shaders.
const NOISE = /* glsl */ `
  vec3 hsv2rgb(vec3 c){
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }
  float hash12(vec2 p){
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  vec4 permute(vec4 x){ return mod(((x*34.0)+1.0)*x, 289.0); }
  vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v){
    const vec2 C = vec2(1.0/6.0, 1.0/3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i  = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + 1.0 * C.xxx;
    vec3 x2 = x0 - i2 + 2.0 * C.xxx;
    vec3 x3 = x0 - 1.0 + 3.0 * C.xxx;
    i = mod(i, 289.0);
    vec4 p = permute(permute(permute(
              i.z + vec4(0.0, i1.z, i2.z, 1.0))
            + i.y + vec4(0.0, i1.y, i2.y, 1.0))
            + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 1.0/7.0;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m*m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
  }
  vec3 snoiseVec3(vec3 p){
    return vec3(snoise(p), snoise(p + vec3(31.4, 47.1, 12.7)), snoise(p + vec3(73.2, 19.8, 56.3)));
  }
`;

const VERT = /* glsl */ `
  precision highp float;
  attribute vec2 aUv;
  uniform sampler2D uXY;
  uniform sampler2D uDepth;
  uniform sampler2D uColor;
  uniform float uTime;
  uniform vec4 uAudio;          // bass, mid, high, volume (0..1)
  uniform float uPointSize;
  uniform float uDisplace;
  uniform float uColorMode;
  uniform float uSizeAtten;
  uniform float uNoiseFreq;
  uniform float uFlowSpeed;
  uniform float uSpike;
  uniform float uBehavior;
  uniform float uVoxel;
  uniform float uSpeed;
  uniform float uSizeMul;
  uniform float uDensity;
  uniform vec3 uWind;
  varying vec3 vColor;
  varying float vValid;
  varying float vFade;
  ${NOISE}

  void main(){
    float depth = texture2D(uDepth, aUv).r;       // meters
    vValid = depth > 0.05 ? 1.0 : 0.0;
    // Density: cull a per-point fraction so the cloud thins out smoothly.
    if (uDensity < 0.999 && hash12(aUv * vec2(317.0, 571.0)) > uDensity) vValid = 0.0;
    vec2 ray = texture2D(uXY, aUv).rg;
    // Image y is down; world y is up. Cloud sits in front of the camera (-Z).
    vec3 pos = vec3(ray.x * depth, -ray.y * depth, -depth);

    if (uVoxel > 0.0001) pos = (floor(pos / uVoxel) + 0.5) * uVoxel;

    float tt = uTime * uSpeed;  // animation clock (speed-scaled)
    float aud = uAudio.w;   // volume
    float beat = uAudio.x;  // bass (beat proxy)
    vFade = 1.0;

    if (uBehavior > 2.5) {                 // SCATTER: beat-driven explosion
      vec3 dir = normalize(pos + vec3(0.0001));
      float burst = (0.15 + beat * 1.4) * (0.5 + 0.5 * snoise(pos * 0.8 + tt * 0.5));
      pos += dir * burst * uDisplace * 5.0;
      pos += snoiseVec3(pos * uNoiseFreq + tt * uFlowSpeed) * uDisplace;
    } else if (uBehavior > 1.5) {          // SWIRL: vortex around view axis
      float ang = (tt * 0.5 + (-pos.z) * 1.2) * (0.4 + aud * 1.2) * (0.3 + uDisplace);
      float ca = cos(ang), sa = sin(ang);
      pos.xy = mat2(ca, -sa, sa, ca) * pos.xy;
      pos += snoiseVec3(pos * uNoiseFreq + tt * uFlowSpeed) * uDisplace * 0.3;
    } else if (uBehavior > 0.5) {          // EVAPORATE: rise + dissolve
      float ph = hash12(aUv * vec2(640.0, 576.0));
      float rise = fract(tt * (0.2 + aud * 0.6) + ph);
      pos.y += rise * (0.8 + beat * 0.9);
      pos += snoiseVec3(pos * uNoiseFreq + tt * uFlowSpeed) * (uDisplace + rise * 0.2);
      vFade = 1.0 - rise;                  // dissolve as it rises
    } else {                               // DRIFT (default)
      pos += snoiseVec3(pos * uNoiseFreq + vec3(0.0, 0.0, tt * uFlowSpeed)) * (uDisplace * (0.15 + aud * 0.85));
    }

    // Wind affector: a steady push with turbulence (the user's wind control).
    if (uWind.x != 0.0 || uWind.y != 0.0 || uWind.z != 0.0) {
      pos += uWind * (0.6 + 0.4 * snoise(pos * 0.5 + tt * 0.3));
    }

    if (uSpike > 0.001) {                  // ferrofluid spikes
      float s = snoise(pos * (uNoiseFreq * 2.0) + tt * 0.6);
      pos += normalize(pos + vec3(0.0001)) * abs(s) * uSpike * (0.4 + beat * 0.9);
    }

    vec3 rgb = texture2D(uColor, aUv).rgb;
    vec3 col = rgb;
    if (uColorMode > 5.5) {                // spectrum: bass->R mid->G high->B
      col = vec3(uAudio.x, uAudio.y, uAudio.z) * (0.4 + 0.9 * dot(rgb, vec3(0.333))) + 0.05;
    } else if (uColorMode > 4.5) {         // ferrofluid: dark chrome, now clearly lit
      float l = dot(rgb, vec3(0.299, 0.587, 0.114));
      float spark = pow(snoise(pos * 3.0 + tt * 0.8) * 0.5 + 0.5, 4.0);
      col = vec3(0.06, 0.07, 0.10) + vec3(0.85, 0.95, 1.15) * spark + l * 0.5 * vec3(0.6, 0.7, 0.9);
    } else if (uColorMode > 3.5) {         // electricity: blue/cyan hot filaments
      float f = pow(snoise(pos * 2.4 + tt * 1.4) * 0.5 + 0.5, 3.0);
      col = mix(vec3(0.1, 0.4, 1.0), vec3(0.85, 0.97, 1.0), f) + f * 0.6;
    } else if (uColorMode > 2.5) {         // neon: hue cycle by depth + time + audio
      col = hsv2rgb(vec3(fract(depth * 0.28 + tt * 0.05 + uAudio.z * 0.2), 0.9, 1.0));
    } else if (uColorMode > 1.5) {         // chrome: controlled metallic greyscale
      float l = dot(rgb, vec3(0.299, 0.587, 0.114));
      float meta = smoothstep(0.15, 0.85, l);
      col = mix(vec3(0.04, 0.05, 0.07), vec3(0.82, 0.86, 0.96), meta);
    } else if (uColorMode > 0.5) {         // depth gradient (warm near -> cool far)
      float tg = clamp((depth - 0.5) / 3.0, 0.0, 1.0);
      col = mix(vec3(1.0, 0.45, 0.2), vec3(0.2, 0.5, 1.0), tg);
    }
    vColor = col;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = projectionMatrix * mv;
    // Pixels, depth-attenuated, size-scaled, audio-pulsed, fade-shrunk, clamped.
    float att = uSizeAtten / max(0.1, -mv.z);
    float sz = uPointSize * uSizeMul * att * (0.7 + beat * 0.6) * (0.4 + vFade * 0.6);
    gl_PointSize = vValid * clamp(sz, 1.0, 28.0);
  }
`;

const FRAG = /* glsl */ `
  precision highp float;
  uniform vec4 uAudio;
  uniform float uSquare;
  uniform float uBright;
  varying vec3 vColor;
  varying float vValid;
  varying float vFade;
  void main(){
    if (vValid < 0.5) discard;
    if (uSquare < 0.5) {
      vec2 d = gl_PointCoord - vec2(0.5);
      if (dot(d, d) > 0.25) discard;            // round points
    }
    vec3 c = vColor * (0.85 + uAudio.z * 0.6) * (0.3 + vFade * 0.7) * uBright;
    gl_FragColor = vec4(c, 1.0);
  }
`;

// Battlezone-style wireframe: line segments between neighbouring depth pixels,
// collapsed where the depth discontinuity is too large (so no streaks across gaps).
const LINE_VERT = /* glsl */ `
  precision highp float;
  attribute vec2 aUv;
  attribute vec2 aUvN;       // the segment's OTHER endpoint (for the gap test)
  uniform sampler2D uXY;
  uniform sampler2D uDepth;
  varying float vKeep;
  void main(){
    float dA = texture2D(uDepth, aUv).r;
    float dB = texture2D(uDepth, aUvN).r;
    vKeep = (dA > 0.05 && dB > 0.05 && abs(dA - dB) < 0.15) ? 1.0 : 0.0;
    vec2 ray = texture2D(uXY, aUv).rg;
    vec3 pos = vec3(ray.x * dA, -ray.y * dA, -dA);
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    gl_Position = vKeep > 0.5 ? projectionMatrix * mv : vec4(2.0, 2.0, 2.0, 1.0);
  }
`;

const LINE_FRAG = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec4 uAudio;
  varying float vKeep;
  void main(){
    if (vKeep < 0.5) discard;
    float flick = 0.8 + 0.2 * sin(uTime * 38.0);          // CRT shimmer
    vec3 green = vec3(0.12, 1.0, 0.25) * (flick + uAudio.z * 0.5);
    gl_FragColor = vec4(green, 1.0);
  }
`;

const TARGET = new THREE.Vector3(0, -0.15, -1.8);

export class AkvjCloudRenderer {
  private readonly getLevels: () => AkvjLevels;
  private readonly width: number;
  private readonly height: number;
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private points: THREE.Points | null = null;
  private lines: THREE.LineSegments | null = null;
  private material!: THREE.ShaderMaterial;
  private lineMaterial!: THREE.ShaderMaterial;
  private composer!: EffectComposer;
  private afterimage!: AfterimagePass;
  private bloom!: UnrealBloomPass;
  private distance = 1;

  private gridW = 0;
  private gridH = 0;
  private xyTex: THREE.DataTexture | null = null;
  private depthTex: THREE.DataTexture | null = null;
  private depthData: Float32Array | null = null;
  private colorTex: THREE.Texture | null = null;
  private dummyTex: THREE.DataTexture | null = null;
  private lastBitmap: ImageBitmap | null = null;

  private spin = 0; // camera orbit speed (0 = frozen front view; default still)
  private orbitAngle = 0;
  private renderFps = 60; // render-loop cap (>=60 = uncapped)
  private lastRender = 0;
  private rafId = 0;
  private lastT = performance.now();
  private disposed = false;
  private startT = performance.now();

  constructor(
    canvas: HTMLCanvasElement,
    getLevels: () => AkvjLevels,
    opts?: { width?: number; height?: number },
  ) {
    this.getLevels = getLevels;
    this.width = opts?.width ?? 1280;
    this.height = opts?.height ?? 720;
    this.build(canvas);
  }

  private build(canvas: HTMLCanvasElement): void {
    const renderer = new THREE.WebGLRenderer({ antialias: true, canvas, alpha: false });
    this.renderer = renderer;
    renderer.setPixelRatio(1);
    renderer.setSize(this.width, this.height, false);
    renderer.setClearColor(0x000000, 1);
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault(), false);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    this.camera = new THREE.PerspectiveCamera(60, this.width / this.height, 0.05, 60);
    this.camera.position.set(0, 0, 1.0);

    // 1x1 placeholder so the vertex shader always has a valid uColor sampler
    // before the first colour frame lands.
    this.dummyTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
    this.dummyTex.needsUpdate = true;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uXY: { value: null },
        uDepth: { value: null },
        uColor: { value: this.dummyTex },
        uTime: { value: 0 },
        uAudio: { value: new THREE.Vector4(0, 0, 0, 0) },
        uPointSize: { value: 1.0 },
        uDisplace: { value: 0.06 },
        uColorMode: { value: 0 },
        uSizeAtten: { value: 4.5 },
        uNoiseFreq: { value: 0.9 },
        uFlowSpeed: { value: 0.25 },
        uSpike: { value: 0 },
        uBehavior: { value: 0 },
        uVoxel: { value: 0 },
        uSquare: { value: 0 },
        uSpeed: { value: 1 },
        uSizeMul: { value: 1 },
        uDensity: { value: 1 },
        uWind: { value: new THREE.Vector3(0, 0, 0) },
        uBright: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: false,
      depthTest: true,
      depthWrite: true,
    });

    this.lineMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uXY: { value: null },
        uDepth: { value: null },
        uTime: { value: 0 },
        uAudio: { value: this.material.uniforms.uAudio.value },
      },
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthTest: true,
      depthWrite: false,
    });

    // Post chain: render -> afterimage (trails) -> bloom (glow). Both are driven
    // live by setParams (damp / strength), default off/low.
    const renderPass = new RenderPass(this.scene, this.camera);
    this.afterimage = new AfterimagePass(0.0);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(this.width, this.height), 0.5, 0.5, 0.15);
    this.composer = new EffectComposer(renderer);
    this.composer.setSize(this.width, this.height);
    this.composer.addPass(renderPass);
    this.composer.addPass(this.afterimage);
    this.composer.addPass(this.bloom);

    this.setStyle(AKVJ_STYLES[0].key);
    this.setParams(AKVJ_PARAMS_DEFAULT);
    this.animate();
  }

  /** Camera orbit speed: 0 freezes a face-on view, sign sets direction. */
  setSpin(v: number): void {
    this.spin = v;
  }

  /** Apply the global cloud controls (live-tweakable). */
  setParams(p: AkvjParams): void {
    this.spin = p.spin;
    this.distance = Math.max(0.2, p.distance);
    const u = this.material.uniforms;
    u.uSpeed.value = p.speed;
    u.uSizeMul.value = p.size;
    u.uDensity.value = Math.max(0.02, p.density);
    u.uBright.value = p.bright;
    (u.uWind.value as THREE.Vector3).set(p.wind * 0.6, p.wind * 0.12, 0);
    if (this.afterimage) (this.afterimage.uniforms as Record<string, { value: number }>).damp.value = Math.min(0.96, Math.max(0, p.trails));
    if (this.bloom) this.bloom.strength = Math.max(0, p.bloom);
    this.renderFps = Math.max(1, p.renderFps);
  }

  /** Switch the particle look (POINTS / NEONVOX / WIRE / ELECTRIC / FERRO / …). */
  setStyle(key: string): void {
    const s = AKVJ_STYLES.find((x) => x.key === key) ?? AKVJ_STYLES[0];
    const u = this.material.uniforms;
    u.uPointSize.value = s.size;
    u.uDisplace.value = s.displace;
    u.uColorMode.value = s.colorMode;
    u.uSquare.value = s.square ? 1 : 0;
    u.uNoiseFreq.value = s.noiseFreq ?? 0.9;
    u.uFlowSpeed.value = s.flowSpeed ?? 0.25;
    u.uSpike.value = s.spike ?? 0;
    u.uBehavior.value = s.behavior ?? DRIFT;
    u.uVoxel.value = s.voxel ?? 0;
    // Additive looks accumulate brightness; turn off depth write so far points
    // still add through near ones.
    this.material.blending = s.additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.material.depthWrite = !s.additive;
    this.material.needsUpdate = true;
    // Wireframe swaps the points object for the line object.
    const wire = !!s.wire;
    if (this.points) this.points.visible = !wire;
    if (this.lines) this.lines.visible = wire;
  }

  /** (Re)build the XY ray-slope texture + the point/line grids when the table lands. */
  setXYTable(w: number, h: number, data: Float32Array): void {
    if (this.disposed) return;
    if (w !== this.gridW || h !== this.gridH || !this.xyTex) {
      this.rebuildGrid(w, h);
    }
    if (this.xyTex) {
      this.xyTex.image.data.set(data);
      this.xyTex.needsUpdate = true;
    }
  }

  private rebuildGrid(w: number, h: number): void {
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
      this.points = null;
    }
    if (this.lines) {
      this.scene.remove(this.lines);
      this.lines.geometry.dispose();
      this.lines = null;
    }
    this.xyTex?.dispose();
    this.depthTex?.dispose();

    this.gridW = w;
    this.gridH = h;
    const count = w * h;

    const xyTex = new THREE.DataTexture(new Float32Array(count * 2), w, h, THREE.RGFormat, THREE.FloatType);
    xyTex.needsUpdate = true;
    this.xyTex = xyTex;

    this.depthData = new Float32Array(count);
    const depthTex = new THREE.DataTexture(this.depthData, w, h, THREE.RedFormat, THREE.FloatType);
    depthTex.needsUpdate = true;
    this.depthTex = depthTex;

    // --- points: one vertex per depth pixel ---
    const aUv = new Float32Array(count * 2);
    const positions = new Float32Array(count * 3); // placeholder; real pos in shader
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        aUv[i * 2] = (x + 0.5) / w;
        aUv[i * 2 + 1] = (y + 0.5) / h;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aUv', new THREE.BufferAttribute(aUv, 2));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -2), 12);

    this.material.uniforms.uXY.value = xyTex;
    this.material.uniforms.uDepth.value = depthTex;
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);

    // --- wireframe: sub-sampled grid of line segments to right + down neighbours ---
    const step = 2;
    const segVerts: number[] = [];
    const segSelf: number[] = [];
    const segOther: number[] = [];
    const uvAt = (px: number, py: number): [number, number] => [(px + 0.5) / w, (py + 0.5) / h];
    const pushSeg = (ax: number, ay: number, bx: number, by: number) => {
      const a = uvAt(ax, ay);
      const b = uvAt(bx, by);
      segVerts.push(0, 0, 0, 0, 0, 0);
      segSelf.push(a[0], a[1], b[0], b[1]);
      segOther.push(b[0], b[1], a[0], a[1]);
    };
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < w; x += step) {
        if (x + step < w) pushSeg(x, y, x + step, y);
        if (y + step < h) pushSeg(x, y, x, y + step);
      }
    }
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segVerts), 3));
    lgeo.setAttribute('aUv', new THREE.BufferAttribute(new Float32Array(segSelf), 2));
    lgeo.setAttribute('aUvN', new THREE.BufferAttribute(new Float32Array(segOther), 2));
    lgeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, -2), 12);

    this.lineMaterial.uniforms.uXY.value = xyTex;
    this.lineMaterial.uniforms.uDepth.value = depthTex;
    this.lines = new THREE.LineSegments(lgeo, this.lineMaterial);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.scene.add(this.lines);
  }

  /** Push one decoded frame: depth16 (mm) + the depth-aligned colour bitmap. */
  pushFrame(w: number, h: number, depthU16: Uint16Array, colorBitmap: ImageBitmap | null): void {
    if (this.disposed) return;
    if (w !== this.gridW || h !== this.gridH) {
      if (colorBitmap) colorBitmap.close();
      return;
    }
    if (this.depthData && this.depthTex) {
      const out = this.depthData;
      const n = Math.min(out.length, depthU16.length);
      for (let i = 0; i < n; i++) out[i] = depthU16[i] * 0.001; // mm -> m
      this.depthTex.needsUpdate = true;
    }
    if (colorBitmap) {
      if (!this.colorTex) {
        const tex = new THREE.Texture(colorBitmap);
        tex.flipY = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        this.colorTex = tex;
        this.material.uniforms.uColor.value = tex;
      } else {
        this.colorTex.image = colorBitmap;
      }
      this.colorTex.needsUpdate = true;
      this.lastBitmap?.close();
      this.lastBitmap = colorBitmap;
    }
  }

  private animate = (): void => {
    this.rafId = requestAnimationFrame(this.animate);
    if (this.disposed) return;
    if (this.renderer.getContext().isContextLost()) return;

    const now = performance.now();
    // Render-FPS cap: skip frames to throttle GPU work (60+ = effectively uncapped).
    if (this.renderFps < 59 && now - this.lastRender < 1000 / this.renderFps - 0.5) return;
    this.lastRender = now;

    const t = (now - this.startT) / 1000;
    const dt = Math.min(0.1, (now - this.lastT) / 1000);
    this.lastT = now;

    const { bass, mid, high, volume } = this.getLevels();
    this.material.uniforms.uTime.value = t;
    this.lineMaterial.uniforms.uTime.value = t;
    (this.material.uniforms.uAudio.value as THREE.Vector4).set(bass, mid, high, volume);

    // Camera: frozen face-on when spin≈0, else orbit at the chosen speed/direction.
    if (Math.abs(this.spin) <= 0.001) {
      this.camera.position.set(0, 0.05, 0.8 * this.distance);
    } else {
      this.orbitAngle += dt * this.spin * 0.9;
      const r = 2.6 * this.distance;
      this.camera.position.set(Math.sin(this.orbitAngle) * r, 0.25, TARGET.z + Math.cos(this.orbitAngle) * r);
    }
    this.camera.lookAt(TARGET);

    this.composer.render();
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
    }
    if (this.lines) {
      this.scene.remove(this.lines);
      this.lines.geometry.dispose();
    }
    this.xyTex?.dispose();
    this.depthTex?.dispose();
    this.colorTex?.dispose();
    this.dummyTex?.dispose();
    this.lastBitmap?.close();
    this.material.dispose();
    this.lineMaterial.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}
