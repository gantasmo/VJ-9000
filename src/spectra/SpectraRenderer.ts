/**
 * SpectraRenderer -- framework-free port of SPECTRA-RIDER (a React Three Fiber
 * audio spectrogram-terrain visualizer) for use as a VJ source.
 *
 * The original drives itself from its own AnalyserNode + a module-global
 * scrolling spectrogram buffer. Here the scene is rebuilt as a plain three.js
 * class (no R3F, no reconciler, no second three instance) that renders to a
 * caller-owned offscreen canvas at a fixed size so it can be captureStream()-ed
 * into the VJ feed, and is fed the VJ's audio instead of opening its own mic:
 *   - getSpectrum() returns the VJ's live 128-bin frequency buffer (preferred);
 *   - getLevels() (bass/mid/high/volume 0..1) is the fallback, synthesised into
 *     a coarse 128-bin spectrum when no real spectrum is available (e.g. when the
 *     VJ runs embedded in theDAW with only the 4-band bridge). In that case the
 *     terrain reads as a few broad ridges rather than a true spectrogram; the
 *     richer embedded path (host-forwarded spectrogram column) is a follow-up.
 *
 * Because an offscreen captureStream canvas has no pointer/keyboard, the five
 * camera modes are reimplemented as autonomous motion (no OrbitControls, no key
 * steering). Default is the hands-off Dynamic Orbit (Auto-Pan).
 *
 * Vignette has no three/addons pass (it was drei-only); v1 ships Bloom-only,
 * matching CymaticsRenderer. The terrain, walls, particles, and Bloom are GPU
 * heavy; expose density/quality later if it drops below live.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

export type SpectraMode = 'flight' | 'dynamic' | 'overhead' | 'horizon' | 'freecam';

export interface SpectraLevels {
  bass: number;
  mid: number;
  high: number;
  volume: number;
}

export interface SpectraSettings {
  sensitivity: number;
  smoothing: number;
  noiseGate: number;
  heightMulti: number;
  energyImpact: number;
}

export interface SpectraTheme {
  id: string;
  name: string;
  colorLow: string;
  colorMid: string;
  colorHigh: string;
  colorPeak: string;
  gridColor: string;
  bgFogColor: string;
  /** When 'inferno', the terrain uses the exact inferno spectrogram colormap
   *  (polynomial) instead of the four theme colours. */
  colormap?: 'inferno';
}

export const SPECTRA_THEMES: SpectraTheme[] = [
  { id: 'mel-spectrogram', name: 'Spectrogram', colorLow: '#000004', colorMid: '#932667', colorHigh: '#ed6925', colorPeak: '#fcffa4', gridColor: '#bb3754', bgFogColor: '#000004', colormap: 'inferno' },
  { id: 'deep-space', name: 'Deep Cosmos', colorLow: '#050114', colorMid: '#1a004a', colorHigh: '#d10073', colorPeak: '#00e1ff', gridColor: '#4f1ab3', bgFogColor: '#020008' },
  { id: 'emerald-grid', name: 'Emerald Tech', colorLow: '#010f08', colorMid: '#004a25', colorHigh: '#00e575', colorPeak: '#ffffff', gridColor: '#007542', bgFogColor: '#000804' },
  { id: 'solar-flare', name: 'Solar Inferno', colorLow: '#0f0200', colorMid: '#5c0c00', colorHigh: '#ff3700', colorPeak: '#ffea00', gridColor: '#961100', bgFogColor: '#0a0100' },
  { id: 'ice-glace', name: 'Polar Glace', colorLow: '#000714', colorMid: '#02184d', colorHigh: '#0084ff', colorPeak: '#d0f0ff', gridColor: '#0a3399', bgFogColor: '#00040a' },
  { id: 'cyber-horizon', name: 'Cyber Horizon', colorLow: '#0c001a', colorMid: '#ff00aa', colorHigh: '#7b00ff', colorPeak: '#00ffff', gridColor: '#bc00dd', bgFogColor: '#07000d' },
  { id: 'carbon', name: 'Carbon Steel', colorLow: '#050505', colorMid: '#242426', colorHigh: '#787880', colorPeak: '#ffffff', gridColor: '#3a3a3c', bgFogColor: '#050505' },
];

export const SPECTRA_MODES: { id: SpectraMode; name: string }[] = [
  { id: 'dynamic', name: 'Dynamic Orbit' },
  { id: 'flight', name: 'Canyon Flight' },
  { id: 'overhead', name: "Bird's Eye" },
  { id: 'horizon', name: 'Deep Horizon' },
  { id: 'freecam', name: 'Free Flight' },
];

export const SPECTRA_SETTINGS_DEFAULT: SpectraSettings = {
  sensitivity: 1.0,
  smoothing: 0.65,
  noiseGate: 0.06,
  heightMulti: 1.0,
  energyImpact: 1.0,
};

const SPECTRUM_SIZE = 256;
const HISTORY_SIZE = 256;
const TERRAIN_SEGS = 384; // mesh density (decoupled from texture res, for finer relief)
const FOV = 55;
// Slow, song-length sweep: one full pass of the 256-row history takes ~128s so the
// scroll reads as a single long spectrogram rather than a short looping treadmill.
// The leading column still refreshes every frame, so the front edge stays reactive.
// (Exact per-song sync would need the host to forward track duration; not done here.)
const SCROLL_ROWS_PER_SEC = 2.0;

function themeById(id: string): SpectraTheme {
  return SPECTRA_THEMES.find((t) => t.id === id) ?? SPECTRA_THEMES[0];
}

export class SpectraRenderer {
  private mode: SpectraMode;
  private theme: SpectraTheme;
  private settings: SpectraSettings;
  private autoRotate: boolean;
  private readonly getSpectrum: () => Uint8Array | null;
  private readonly getLevels: () => SpectraLevels;
  private readonly width: number;
  private readonly height: number;

  private rafId = 0;
  private disposed = false;
  private renderer!: THREE.WebGLRenderer;
  private dispose_: (() => void) | null = null;

  /** Own scrolling spectrogram history (RedFormat source for the DataTexture). */
  private readonly dataArray = new Uint8Array(SPECTRUM_SIZE * HISTORY_SIZE);
  /** Per-bin EMA-smoothed column the mel mapping writes through. */
  private readonly smoothed = new Float32Array(SPECTRUM_SIZE);
  private currentRow = 0;
  private rowAccum = 0;
  private energy = 0;
  /** Reused 128-bin buffer for the level-synthesised fallback. */
  private readonly synthBins = new Uint8Array(SPECTRUM_SIZE);

  constructor(
    canvas: HTMLCanvasElement,
    getSpectrum: () => Uint8Array | null,
    getLevels: () => SpectraLevels,
    opts?: { mode?: SpectraMode; theme?: string; settings?: SpectraSettings; autoRotate?: boolean; width?: number; height?: number },
  ) {
    this.mode = opts?.mode ?? 'dynamic';
    this.theme = themeById(opts?.theme ?? 'mel-spectrogram');
    this.settings = opts?.settings ?? { ...SPECTRA_SETTINGS_DEFAULT };
    this.autoRotate = opts?.autoRotate ?? true;
    this.getSpectrum = getSpectrum;
    this.getLevels = getLevels;
    this.width = opts?.width ?? 1280;
    this.height = opts?.height ?? 720;
    this.build(canvas);
  }

  setMode(mode: SpectraMode): void {
    this.mode = mode;
  }

  setTheme(themeId: string): void {
    this.theme = themeById(themeId);
    this.applyTheme();
  }

  setSettings(settings: SpectraSettings): void {
    this.settings = settings;
  }

  setAutoRotate(on: boolean): void {
    this.autoRotate = on;
  }

  private applyTheme!: () => void;

  /** Fill spectrogram column `row` from the VJ's live audio, EMA-smoothed. */
  private fillColumn(row: number): void {
    const real = this.getSpectrum();
    let src: Uint8Array;
    if (real && real.length >= 8) {
      src = real;
    } else {
      // Fallback: synthesise a coarse 128-bin spectrum from the 4 bands.
      const { bass, mid, high } = this.getLevels();
      const b = Math.max(0, Math.min(1, bass));
      const m = Math.max(0, Math.min(1, mid));
      const h = Math.max(0, Math.min(1, high));
      for (let i = 0; i < SPECTRUM_SIZE; i++) {
        const p = i / (SPECTRUM_SIZE - 1);
        const band = p < 0.18 ? b : p < 0.5 ? m : h;
        this.synthBins[i] = Math.min(255, Math.round(band * 255 * (0.7 + 0.3 * Math.sin(p * 9))));
      }
      src = this.synthBins;
    }

    const sensitivity = this.settings.sensitivity;
    const ema = Math.max(0, Math.min(0.95, this.settings.smoothing));
    const srcLen = src.length;
    const minHz = 40;
    const nyquist = 22050;
    const maxHz = Math.min(9000, nyquist);
    const hzToMel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
    const melToHz = (mel: number) => 700 * (Math.pow(10, mel / 2595) - 1);
    const minMel = hzToMel(minHz);
    const maxMel = hzToMel(maxHz);

    const offset = row * SPECTRUM_SIZE;
    let sum = 0;
    const trackingBands = 30;

    for (let i = 0; i < SPECTRUM_SIZE; i++) {
      const pct = i / (SPECTRUM_SIZE - 1);
      const targetHz = melToHz(minMel + pct * (maxMel - minMel));
      const targetIndex = Math.max(2, (targetHz / nyquist) * (srcLen - 1));
      const lowBin = Math.floor(targetIndex);
      const highBin = Math.min(srcLen - 1, Math.ceil(targetIndex));
      const fraction = targetIndex - lowBin;
      let val = src[lowBin];
      if (highBin !== lowBin) val = val * (1 - fraction) + src[highBin] * fraction;
      const eq = 0.85 + pct * 0.55;
      const normalized = Math.pow((val / 255) * sensitivity * eq, 1.15);
      const finalVal = Math.min(255, normalized * 255);
      this.smoothed[i] = this.smoothed[i] * ema + finalVal * (1 - ema);
      const out = Math.min(255, Math.round(this.smoothed[i]));
      this.dataArray[offset + i] = out;
      if (i < trackingBands) sum += out;
    }

    this.energy = sum / (trackingBands * 255.0);
  }

  /** CPU height query mirroring the terrain vertex shader (for canyon flight). */
  private terrainHeightAt(worldX: number, worldZ: number): number {
    const u = (worldX + 25.0) / 50.0;
    const v = (25.0 - worldZ) / 50.0;
    const uClamp = Math.max(0, Math.min(1, u));
    const vClamp = Math.max(0, Math.min(1, v));
    const offsetProgress = this.currentRow / HISTORY_SIZE;
    const rawY = offsetProgress + vClamp;
    const sampleY = rawY - Math.floor(rawY);
    const freqUv = Math.abs(uClamp - 0.5) * 2.0;
    const spectrumIdx = Math.max(0, Math.min(SPECTRUM_SIZE - 1, Math.floor(freqUv * (SPECTRUM_SIZE - 1))));
    const historyIdx = Math.max(0, Math.min(HISTORY_SIZE - 1, Math.floor(sampleY * (HISTORY_SIZE - 1))));
    const rawVal = this.dataArray[historyIdx * SPECTRUM_SIZE + spectrumIdx] / 255.0;
    const noiseGate = this.settings.noiseGate;
    const clampT = Math.max(0, Math.min(1, (rawVal - noiseGate) / (1.0 - noiseGate)));
    const boosted = clampT * clampT * (3 - 2 * clampT);
    const centerSmoothT = Math.max(0, Math.min(1, freqUv / 0.02));
    const centerSmooth = centerSmoothT * centerSmoothT * (3 - 2 * centerSmoothT) * 0.1 + 0.9;
    const vHeight = boosted * this.settings.heightMulti * centerSmooth;
    return -2.0 + vHeight * (4.0 + this.energy * this.settings.energyImpact * 4.0);
  }

  private build(canvas: HTMLCanvasElement): void {
    const renderer = new THREE.WebGLRenderer({ antialias: true, canvas, alpha: false });
    this.renderer = renderer;
    renderer.setPixelRatio(1);
    renderer.setSize(this.width, this.height, false);
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault(), false);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(this.theme.bgFogColor);
    const fog = new THREE.Fog(new THREE.Color(this.theme.bgFogColor).getHex(), 12, 35);
    scene.fog = fog;

    const camera = new THREE.PerspectiveCamera(FOV, this.width / this.height, 0.1, 1000);
    camera.position.set(0, 4, 18);

    // --- Spectrogram DataTexture ---
    const dataTexture = new THREE.DataTexture(this.dataArray, SPECTRUM_SIZE, HISTORY_SIZE, THREE.RedFormat, THREE.UnsignedByteType);
    dataTexture.minFilter = THREE.LinearFilter;
    dataTexture.magFilter = THREE.LinearFilter;
    dataTexture.generateMipmaps = false;
    dataTexture.wrapS = THREE.ClampToEdgeWrapping;
    dataTexture.wrapT = THREE.RepeatWrapping;
    dataTexture.needsUpdate = true;

    const terrainUniforms: Record<string, THREE.IUniform> = {
      u_texture: { value: dataTexture },
      u_offset: { value: 0.0 },
      u_time: { value: 0.0 },
      u_energy: { value: 0.0 },
      u_noiseGate: { value: this.settings.noiseGate },
      u_heightMulti: { value: this.settings.heightMulti },
      u_energyImpact: { value: this.settings.energyImpact },
      u_useColormap: { value: this.theme.colormap === 'inferno' ? 1.0 : 0.0 },
      u_colorLow: { value: new THREE.Color(this.theme.colorLow) },
      u_colorMid: { value: new THREE.Color(this.theme.colorMid) },
      u_colorHigh: { value: new THREE.Color(this.theme.colorHigh) },
      u_colorPeak: { value: new THREE.Color(this.theme.colorPeak) },
      u_gridColor: { value: new THREE.Color(this.theme.gridColor) },
    };

    const worldGroup = new THREE.Group();
    scene.add(worldGroup);

    const terrainMat = new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      uniforms: terrainUniforms,
      vertexShader: `
        uniform sampler2D u_texture;
        uniform float u_offset;
        uniform float u_energy;
        uniform float u_noiseGate;
        uniform float u_heightMulti;
        uniform float u_energyImpact;
        varying float v_height;
        varying float v_amp;
        varying vec2 v_uv;
        void main() {
          v_uv = uv;
          float sampleY = fract((u_offset / float(${HISTORY_SIZE}.0)) + uv.y);
          float freqUv = abs(uv.x - 0.5) * 2.0;
          float rawHeight = texture2D(u_texture, vec2(freqUv, sampleY)).r;
          v_amp = rawHeight;
          float boosted = smoothstep(u_noiseGate, 1.0, rawHeight);
          float centerSmooth = smoothstep(0.0, 0.02, freqUv) * 0.1 + 0.9;
          // Flatten both ends so the ring-buffer wrap seam (pinned at the far edge)
          // sits in flat terrain -> seamless scroll, no periodic restart.
          float edge = smoothstep(0.0, 0.12, uv.y) * smoothstep(1.0, 0.82, uv.y);
          v_height = boosted * u_heightMulti * centerSmooth * edge;
          vec3 newPosition = position;
          newPosition.z += v_height * (5.0 + (u_energy * u_energyImpact) * 5.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D u_texture;
        uniform float u_offset;
        uniform float u_noiseGate;
        uniform float u_useColormap;
        uniform float u_energy;
        uniform float u_time;
        uniform vec3 u_colorLow;
        uniform vec3 u_colorMid;
        uniform vec3 u_colorHigh;
        uniform vec3 u_colorPeak;
        varying float v_height;
        varying float v_amp;
        varying vec2 v_uv;
        // Accurate inferno colormap (Matt Zucker polynomial fit) -- the standard
        // spectrogram palette: near-black -> deep purple -> magenta -> orange ->
        // pale yellow. Used for the default 'Spectrogram' theme.
        vec3 inferno(float t) {
          t = clamp(t, 0.0, 1.0);
          const vec3 c0 = vec3(0.00021894037, 0.0016510046, -0.019480898);
          const vec3 c1 = vec3(0.10651341949, 0.5639564368, 3.9327123889);
          const vec3 c2 = vec3(11.602493082, -3.972853966, -15.942394106);
          const vec3 c3 = vec3(-41.703996131, 17.436398882, 44.354145199);
          const vec3 c4 = vec3(77.162935699, -33.402358942, -81.807309257);
          const vec3 c5 = vec3(-71.319428245, 32.626064264, 73.209519858);
          const vec3 c6 = vec3(25.131126225, -12.242668952, -23.070325003);
          return c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6)))));
        }
        // Theme-colour heatmap for the non-spectrogram themes.
        vec3 heat(float t) {
          t = clamp(t, 0.0, 1.0);
          vec3 c = mix(u_colorLow, u_colorMid, smoothstep(0.0, 0.35, t));
          c = mix(c, u_colorHigh, smoothstep(0.30, 0.72, t));
          c = mix(c, u_colorPeak, smoothstep(0.66, 1.0, t));
          return c;
        }
        // Reconstruct the geometric height at an arbitrary uv (mirrors the vertex
        // displacement) so a surface normal can be derived in-shader: bump/normal
        // relief lit from the spectrogram itself, no external normal map.
        float terrainH(vec2 uvc) {
          float sY = fract((u_offset / float(${HISTORY_SIZE}.0)) + uvc.y);
          float fU = abs(uvc.x - 0.5) * 2.0;
          float rh = texture2D(u_texture, vec2(fU, sY)).r;
          float b = smoothstep(u_noiseGate, 1.0, rh);
          float cs = smoothstep(0.0, 0.02, fU) * 0.1 + 0.9;
          float ed = smoothstep(0.0, 0.12, uvc.y) * smoothstep(1.0, 0.82, uvc.y);
          return b * cs * ed;
        }
        void main() {
          float amp = clamp(v_amp * (1.0 + u_energy * 0.6), 0.0, 1.0);
          vec3 base = clamp((u_useColormap > 0.5) ? inferno(amp) : heat(amp), 0.0, 1.0);
          // Bump/normal relief: sample the height field around this fragment, build
          // a normal, light it so ridges shade in 3D and gain micro-detail.
          float e = 1.0 / float(${SPECTRUM_SIZE}.0);
          float hL = terrainH(v_uv - vec2(e, 0.0));
          float hR = terrainH(v_uv + vec2(e, 0.0));
          float hD = terrainH(v_uv - vec2(0.0, e));
          float hU = terrainH(v_uv + vec2(0.0, e));
          float nScale = 7.0;
          vec3 nrm = normalize(vec3((hL - hR) * nScale, (hD - hU) * nScale, 1.0));
          vec3 L = normalize(vec3(0.35, 0.45, 0.82));
          float diff = clamp(dot(nrm, L), 0.0, 1.0);
          vec3 hVec = normalize(L + vec3(0.0, 0.0, 1.0));
          float spec = pow(clamp(dot(nrm, hVec), 0.0, 1.0), 28.0) * amp;
          float light = 0.72 + 0.55 * diff + 0.7 * spec;
          vec3 col = base * light;
          float edgeFade = smoothstep(0.0, 0.12, v_uv.x) * smoothstep(1.0, 0.88, v_uv.x);
          float depthFade = smoothstep(0.0, 0.05, v_uv.y) * smoothstep(1.0, 0.72, v_uv.y);
          float alpha = (0.55 + amp * 0.45) * edgeFade * depthFade;
          gl_FragColor = vec4(col, alpha);
        }
      `,
    });
    const terrain = new THREE.Mesh(new THREE.PlaneGeometry(50, 50, TERRAIN_SEGS, TERRAIN_SEGS), terrainMat);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.set(0, -2, 0);
    worldGroup.add(terrain);

    // --- Curved spectrogram walls (scrolling CanvasTexture) ---
    const wallCanvas = document.createElement('canvas');
    wallCanvas.width = 2048;
    wallCanvas.height = 512;
    const wallCtx = wallCanvas.getContext('2d', { willReadFrequently: true });
    const wallTexture = new THREE.CanvasTexture(wallCanvas);
    wallTexture.wrapS = THREE.ClampToEdgeWrapping;
    wallTexture.wrapT = THREE.ClampToEdgeWrapping;
    wallTexture.magFilter = THREE.LinearFilter;
    wallTexture.minFilter = THREE.LinearFilter;

    const wallUniforms = {
      u_time: terrainUniforms.u_time,
      u_energy: terrainUniforms.u_energy,
      u_colorLow: terrainUniforms.u_colorLow,
      u_colorMid: terrainUniforms.u_colorMid,
      u_colorHigh: terrainUniforms.u_colorHigh,
      u_colorPeak: terrainUniforms.u_colorPeak,
    };
    const makeWall = (x: number, rotY: number, flipX: boolean): THREE.Mesh => {
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.NormalBlending,
        uniforms: {
          u_texture: { value: wallTexture },
          u_curveRadius: { value: 400.0 },
          u_flipX: { value: flipX ? 1.0 : 0.0 },
          ...wallUniforms,
        },
        vertexShader: `
          uniform float u_curveRadius;
          varying vec2 v_uv;
          void main() {
            v_uv = uv;
            vec3 pos = position;
            float theta = pos.x / u_curveRadius;
            pos.z += u_curveRadius * (1.0 - cos(theta));
            pos.x = u_curveRadius * sin(theta);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
          }
        `,
        fragmentShader: `
          uniform sampler2D u_texture;
          uniform float u_flipX;
          uniform float u_energy;
          uniform vec3 u_colorLow;
          uniform vec3 u_colorMid;
          uniform vec3 u_colorHigh;
          uniform vec3 u_colorPeak;
          varying vec2 v_uv;
          vec3 getPalette(float t, float energy) {
            vec3 low = u_colorLow;
            vec3 midCheck = mix(u_colorMid, u_colorHigh, clamp(energy * 0.4, 0.0, 1.0));
            vec3 highCheck = mix(u_colorHigh, u_colorPeak, clamp(energy * 0.6, 0.0, 1.0));
            vec3 peak = u_colorPeak;
            if (t < 0.1) { return mix(low, midCheck, t / 0.1); }
            else if (t < 0.4) { return mix(midCheck, highCheck, (t - 0.1) / 0.3); }
            else if (t < 0.8) { return mix(highCheck, peak, (t - 0.4) / 0.4); }
            else { return mix(peak, vec3(1.0), min((t - 0.8) / 0.2, 1.0)); }
          }
          void main() {
            vec2 sampleUv = v_uv;
            if (u_flipX > 0.5) sampleUv.x = 1.0 - sampleUv.x;
            vec4 texColor = texture2D(u_texture, sampleUv);
            float t = texColor.a;
            vec3 col = getPalette(t, u_energy);
            float edgeX = smoothstep(0.0, 0.2, v_uv.x) * smoothstep(1.0, 0.8, v_uv.x);
            float edgeY = smoothstep(0.0, 0.2, v_uv.y) * smoothstep(1.0, 0.6, v_uv.y);
            gl_FragColor = vec4(col * 0.45, t * edgeX * edgeY * 0.25);
          }
        `,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1000, 320, 128, 64), mat);
      mesh.position.set(x, 0, 0);
      mesh.rotation.set(0, rotY, 0);
      return mesh;
    };
    const wallGroup = new THREE.Group();
    wallGroup.position.set(0, 45, 0);
    wallGroup.add(makeWall(-280, Math.PI / 2, true));
    wallGroup.add(makeWall(280, -Math.PI / 2, false));
    worldGroup.add(wallGroup);

    // --- Particles ---
    const PARTICLE_COUNT = 1200;
    const pPos = new Float32Array(PARTICLE_COUNT * 3);
    const pScale = new Float32Array(PARTICLE_COUNT);
    const pColor = new Float32Array(PARTICLE_COUNT * 3);
    const particleUniforms = { u_time: { value: 0 }, u_energy: { value: 0 } };
    const particleGeo = new THREE.BufferGeometry();
    const particleMat = new THREE.ShaderMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: particleUniforms,
      vertexShader: `
        uniform float u_time;
        uniform float u_energy;
        attribute float aScale;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vec3 p = position;
          p.x += sin(u_time * 0.5 + p.y * 0.1) * 3.0;
          p.z += cos(u_time * 0.3 + p.y * 0.2) * 3.0;
          p.x *= 1.0 + (u_energy * 0.2 * aScale);
          p.z *= 1.0 + (u_energy * 0.2 * aScale);
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          gl_PointSize = (8.0 * aScale * (1.0 + u_energy * 2.0)) / -mvPosition.z;
          gl_Position = projectionMatrix * mvPosition;
          vAlpha = aScale * (0.06 + u_energy * 0.18);
        }
      `,
      fragmentShader: `
        uniform float u_energy;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float dist = length(gl_PointCoord - vec2(0.5));
          if (dist > 0.5) discard;
          float intensity = (0.5 - dist) * 2.0;
          vec3 finalColor = mix(vColor, vec3(0.7, 0.9, 1.0), u_energy * 0.25);
          gl_FragColor = vec4(finalColor, vAlpha * intensity);
        }
      `,
    });
    const particles = new THREE.Points(particleGeo, particleMat);
    worldGroup.add(particles);

    // --- Bloom composer ---
    const renderPass = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(this.width, this.height), 0.9, 0.6, 0.5);
    const composer = new EffectComposer(renderer);
    composer.addPass(renderPass);
    composer.addPass(bloomPass);
    composer.setSize(this.width, this.height);

    // Theme application (re-seeds particle colours + scene bg/fog).
    let seededTheme = '';
    const seedParticleColors = () => {
      const opts = [new THREE.Color(this.theme.colorPeak), new THREE.Color(this.theme.colorHigh), new THREE.Color(this.theme.colorMid)];
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        if (seededTheme === '') {
          pPos[i * 3] = (Math.random() - 0.5) * 80;
          pPos[i * 3 + 1] = (Math.random() - 0.5) * 30 + 10;
          pPos[i * 3 + 2] = (Math.random() - 0.5) * 80;
          pScale[i] = Math.random();
        }
        const c = opts[i % opts.length];
        pColor[i * 3] = c.r;
        pColor[i * 3 + 1] = c.g;
        pColor[i * 3 + 2] = c.b;
      }
      if (seededTheme === '') {
        particleGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
        particleGeo.setAttribute('aScale', new THREE.BufferAttribute(pScale, 1));
        particleGeo.setAttribute('color', new THREE.BufferAttribute(pColor, 3));
      } else {
        (particleGeo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
      }
      seededTheme = this.theme.id;
    };
    seedParticleColors();

    this.applyTheme = () => {
      scene.background = new THREE.Color(this.theme.bgFogColor);
      fog.color.set(this.theme.bgFogColor);
      terrainUniforms.u_useColormap.value = this.theme.colormap === 'inferno' ? 1.0 : 0.0;
      terrainUniforms.u_colorLow.value.set(this.theme.colorLow);
      terrainUniforms.u_colorMid.value.set(this.theme.colorMid);
      terrainUniforms.u_colorHigh.value.set(this.theme.colorHigh);
      terrainUniforms.u_colorPeak.value.set(this.theme.colorPeak);
      terrainUniforms.u_gridColor.value.set(this.theme.gridColor);
      seedParticleColors();
    };

    // --- Wall canvas scroll/draw ---
    const drawWallColumn = (spectrum: Uint8Array) => {
      if (!wallCtx) return;
      const scrollSpeed = 1;
      const noiseFloor = 0.08;
      wallCtx.drawImage(wallCanvas, 0, 0, wallCanvas.width - scrollSpeed, wallCanvas.height, scrollSpeed, 0, wallCanvas.width - scrollSpeed, wallCanvas.height);
      wallCtx.clearRect(0, 0, scrollSpeed, wallCanvas.height);
      for (let y = 0; y < wallCanvas.height; y += 2) {
        const p = y / (wallCanvas.height - 1);
        const bin = Math.floor((1 - p) * (spectrum.length - 1));
        const amp = spectrum[bin] / 255;
        if (amp < noiseFloor) continue;
        const alpha = Math.pow((amp - noiseFloor) / (1 - noiseFloor), 1.15) * 0.7;
        wallCtx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
        wallCtx.fillRect(0, y, scrollSpeed, 2);
      }
      wallTexture.needsUpdate = true;
    };

    // --- Camera: keyboard-flyable flight + freecam, autonomous orbit modes ---
    // Flight (Canyon Flight) and Free Flight are STEERABLE: A/D or arrows turn,
    // W/S or up/down climb/dive, Space/Shift change freecam speed. Dynamic Orbit,
    // Bird's Eye and Deep Horizon run hands-off. Keys are window-level, so they
    // work even though this canvas renders offscreen for captureStream.
    const startClock = performance.now();
    let prevTime = startClock;
    let lastCamMode: SpectraMode | null = null;
    const keys: Record<string, boolean> = {};
    let shipYaw = 0;
    let shipPitch = 0;
    let shipRoll = 0;
    let flightAlt = 1.5;
    let steerXs = 0;
    let steerYs = 0;
    const onKeyDown = (ev: KeyboardEvent) => { keys[ev.code] = true; };
    const onKeyUp = (ev: KeyboardEvent) => { keys[ev.code] = false; };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    const lerp = (a: number, b: number, t: number) => a + (b - a) * Math.min(1, Math.max(0, t));

    const applyCamera = (tSec: number, dt: number) => {
      const e = this.energy * this.settings.energyImpact;

      // Reset the rig when switching INTO a flight mode.
      if (this.mode !== lastCamMode) {
        if (this.mode === 'flight') {
          camera.position.set(0, -0.5, 12);
          camera.quaternion.identity();
          flightAlt = 1.5;
        } else if (this.mode === 'freecam') {
          camera.position.set(0, 4, 18);
          camera.quaternion.identity();
        }
        shipYaw = 0; shipPitch = 0; shipRoll = 0;
        lastCamMode = this.mode;
      }

      if (this.mode === 'flight') {
        let steerX = 0;
        if (keys['KeyA'] || keys['ArrowLeft']) steerX = -1;
        if (keys['KeyD'] || keys['ArrowRight']) steerX = 1;
        let steerY = 0;
        if (keys['KeyW'] || keys['ArrowUp']) steerY = 1;
        if (keys['KeyS'] || keys['ArrowDown']) steerY = -1;
        // Ease the raw key input so starts/stops ramp instead of snapping.
        steerXs = lerp(steerXs, steerX, 4.0 * dt);
        steerYs = lerp(steerYs, steerY, 4.0 * dt);
        camera.position.x = Math.max(-19, Math.min(19, camera.position.x + steerXs * 13 * dt));
        flightAlt = Math.max(0, Math.min(15, flightAlt + steerYs * 8 * dt));
        shipRoll = lerp(shipRoll, -steerXs * 0.38, 3.0 * dt);
        shipYaw = lerp(shipYaw, -steerXs * 0.15, 3.0 * dt);
        shipPitch = lerp(shipPitch, -0.1 + steerYs * 0.12, 3.0 * dt);
        camera.up.set(0, 1, 0);
        camera.quaternion.setFromEuler(new THREE.Euler(shipPitch, shipYaw, shipRoll, 'YXZ'));
        const under = this.terrainHeightAt(camera.position.x, camera.position.z);
        const ahead = this.terrainHeightAt(camera.position.x, camera.position.z - 4.5);
        const targetY = Math.max(under, ahead) + 0.8 + flightAlt;
        const damp = targetY > camera.position.y ? 1.1 : 2.5;
        camera.position.y = Math.max(-1.5, lerp(camera.position.y, targetY, damp * dt));
        camera.position.z = 12;
      } else if (this.mode === 'freecam') {
        let steerX = 0;
        let steerY = 0;
        if (keys['KeyA'] || keys['ArrowLeft']) steerX = -1;
        if (keys['KeyD'] || keys['ArrowRight']) steerX = 1;
        if (keys['KeyW'] || keys['ArrowUp']) steerY = -1;
        if (keys['KeyS'] || keys['ArrowDown']) steerY = 1;
        let speedMul = 1;
        if (keys['Space']) speedMul = 1.8;
        if (keys['ShiftLeft'] || keys['ShiftRight']) speedMul = 0.5;
        // Ease the raw key input so turns ramp instead of snapping.
        steerXs = lerp(steerXs, steerX, 3.5 * dt);
        steerYs = lerp(steerYs, steerY, 3.5 * dt);
        shipYaw -= steerXs * 1.6 * dt;
        shipPitch -= steerYs * 1.2 * dt;
        shipPitch = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, shipPitch));
        shipRoll = lerp(shipRoll, -steerXs * 0.45, 3.0 * dt);
        camera.up.set(0, 1, 0);
        camera.quaternion.setFromEuler(new THREE.Euler(shipPitch, shipYaw, shipRoll, 'YXZ'));
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        camera.position.addScaledVector(fwd, 12 * speedMul * dt);
        if (camera.position.z < -25) camera.position.z += 50;
        if (camera.position.z > 25) camera.position.z -= 50;
        if (camera.position.x < -25) camera.position.x += 50;
        if (camera.position.x > 25) camera.position.x -= 50;
        camera.position.y = Math.max(1.5, Math.min(18, camera.position.y));
      } else if (this.mode === 'overhead') {
        const a = this.autoRotate ? tSec * 0.25 : 0;
        camera.position.set(Math.sin(a) * 2, 30, Math.cos(a) * 2);
        camera.up.set(0, 0, -1);
        camera.lookAt(0, 0, 0);
      } else if (this.mode === 'horizon') {
        const sway = Math.sin(tSec * 0.3) * 3;
        camera.position.set(sway, 1 + e * 2, 30);
        camera.up.set(0, 1, 0);
        camera.lookAt(0, 3, -8);
      } else {
        // dynamic orbit (Auto-Pan default)
        const a = this.autoRotate ? tSec * 0.18 : 0.6;
        const r = 22 - e * 3;
        camera.position.set(Math.sin(a) * r, 7 + Math.sin(tSec * 0.3) * 1.5, Math.cos(a) * r);
        camera.up.set(0, 1, 0);
        camera.lookAt(0, 1, -2);
      }
    };

    const animate = () => {
      this.rafId = requestAnimationFrame(animate);
      if (this.disposed) return;
      if (renderer.getContext().isContextLost()) return;

      const nowMs = performance.now();
      const tSec = (nowMs - startClock) / 1000;
      const dt = Math.min((nowMs - prevTime) / 1000, 0.1);
      prevTime = nowMs;

      // Time-based scroll (fps-independent): advance the history head at a fixed
      // rate; refresh the live head column even between advances so it reacts.
      this.rowAccum += dt * SCROLL_ROWS_PER_SEC;
      let steps = Math.floor(this.rowAccum);
      this.rowAccum -= steps;
      if (steps > 4) steps = 4;
      if (steps <= 0) {
        this.fillColumn(this.currentRow);
      } else {
        for (let s = 0; s < steps; s++) {
          this.fillColumn(this.currentRow);
          this.currentRow = (this.currentRow + 1) % HISTORY_SIZE;
        }
      }
      dataTexture.needsUpdate = true;

      const spectrum = this.getSpectrum() ?? this.synthBins;
      drawWallColumn(spectrum);

      terrainUniforms.u_offset.value = this.currentRow;
      terrainUniforms.u_time.value = tSec;
      const lerpE = (terrainUniforms.u_energy.value as number);
      terrainUniforms.u_energy.value = lerpE + (this.energy - lerpE) * 0.15;
      terrainUniforms.u_noiseGate.value = this.settings.noiseGate;
      terrainUniforms.u_heightMulti.value = this.settings.heightMulti;
      terrainUniforms.u_energyImpact.value = this.settings.energyImpact;

      particleUniforms.u_time.value = tSec;
      particleUniforms.u_energy.value += (this.energy * this.settings.energyImpact - particleUniforms.u_energy.value) * 0.15;
      particles.position.y = this.energy * this.settings.energyImpact * 8.0;

      // World sway (only in non-flight modes, for a drifting feel).
      if (this.mode === 'flight' || this.mode === 'freecam') {
        worldGroup.position.set(0, 0, 0);
        worldGroup.rotation.set(0, 0, 0);
      } else {
        const eScaled = this.energy * this.settings.energyImpact;
        const swayTurn = Math.sin(tSec * 0.4);
        worldGroup.position.x += (swayTurn * -8.0 - worldGroup.position.x) * 0.02;
        worldGroup.position.z += (eScaled * -4.0 - worldGroup.position.z) * 0.1;
        worldGroup.position.y += (eScaled * -2.5 - worldGroup.position.y) * 0.1;
        const rotX = Math.sin(tSec * 1.1) * -0.02 * (1.0 + eScaled * 2);
        const rotZ = swayTurn * 0.15 + Math.cos(tSec * 0.8) * -0.02 * (1.0 + eScaled * 2);
        const rotY = swayTurn * 0.1;
        worldGroup.rotation.x += (rotX - worldGroup.rotation.x) * 0.1;
        worldGroup.rotation.y += (rotY - worldGroup.rotation.y) * 0.1;
        worldGroup.rotation.z += (rotZ - worldGroup.rotation.z) * 0.1;
      }

      applyCamera(tSec, dt);
      composer.render();
    };
    this.rafId = requestAnimationFrame(animate);

    this.dispose_ = () => {
      cancelAnimationFrame(this.rafId);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = (mesh as THREE.Mesh).material;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((mm) => mm.dispose());
      });
      dataTexture.dispose();
      wallTexture.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dispose_?.();
    this.dispose_ = null;
  }
}
