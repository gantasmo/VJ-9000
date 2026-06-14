/**
 * CymaticsRenderer — framework-free port of theDAW's CymaticsVisualizer
 * (Three.js reflective black-chrome modes) for use as a VJ source.
 *
 * The original is a React component sized to a container and driven by a Web
 * Audio AnalyserNode. Here it renders to a caller-owned offscreen canvas at a
 * fixed size (so it can be `captureStream()`-ed into the VJ feed) and is driven
 * by the VJ's `getAudioLevels()` (bass/mid/high/volume, 0..1) instead of an
 * AnalyserNode — we synthesise the 16-bin frequency buffer the render loop
 * expects from those bands so the look matches the host visualizer.
 *
 * Modes: orb (ferrofluid blob), cymatics (Chladni plate), landscape-chrome,
 * landscape-ferrofluid. Every mesh is gated on the EXR env map loading, so
 * `/piz_compressed.exr` must be served from the app root (it is copied into
 * this app's public/).
 */
import * as THREE from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { fs as backdropFS, vs as backdropVS } from './backdrop-shader';
import { vs as sphereVS } from './sphere-shader';
import { vs as cymaticsVS } from './cymatics-shader';
import { vs as landscapeVS } from './landscape-shader';
import { plasmaVS, plasmaFS, haloFS } from './plasma-shader';

export type CymaticsMode = 'orb' | 'cymatics' | 'landscape-chrome' | 'landscape-ferrofluid';

export interface CymaticsLevels {
  bass: number;
  mid: number;
  high: number;
  volume: number;
}

const EXR_URL = '/piz_compressed.exr';
const FOV = 65;
const TAN_HALF_FOV = Math.tan(THREE.MathUtils.degToRad(FOV) / 2);

export class CymaticsRenderer {
  private mode: CymaticsMode;
  private readonly getLevels: () => CymaticsLevels;
  private readonly width: number;
  private readonly height: number;
  private rafId = 0;
  private disposed = false;
  private renderer!: THREE.WebGLRenderer;
  private dispose_: (() => void) | null = null;

  /** Filled from getLevels() each frame, mimicking a 16-bin FFT. */
  private readonly bins = new Uint8Array(16);

  constructor(
    canvas: HTMLCanvasElement,
    getLevels: () => CymaticsLevels,
    opts?: { mode?: CymaticsMode; width?: number; height?: number },
  ) {
    this.mode = opts?.mode ?? 'orb';
    this.getLevels = getLevels;
    this.width = opts?.width ?? 1280;
    this.height = opts?.height ?? 720;
    this.build(canvas);
  }

  setMode(mode: CymaticsMode): void {
    this.mode = mode;
  }

  /** Refresh the synthetic frequency buffer from the live bands. */
  private sampleBins(): void {
    const { bass, mid, high } = this.getLevels();
    const b = Math.max(0, Math.min(255, Math.round(bass * 255)));
    const m = Math.max(0, Math.min(255, Math.round(mid * 255)));
    const h = Math.max(0, Math.min(255, Math.round(high * 255)));
    for (let i = 0; i < 4; i++) this.bins[i] = b;
    for (let i = 4; i < 11; i++) this.bins[i] = m;
    for (let i = 11; i < 16; i++) this.bins[i] = h;
  }

  private build(canvas: HTMLCanvasElement): void {
    const renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
    this.renderer = renderer;
    renderer.setPixelRatio(1);
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault(), false);

    const spikeDensity = 5.0;
    const spikeAmplitude = 0.45;
    const noiseViscosity = 1.2;
    const isFerrofluid = 1.0;
    const landscapeHeight = 1.5;
    const scrollSpeed = 1.0;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0e0912);
    const landscapeFog = new THREE.Fog(0x000000, 5, 16);

    const backdrop = new THREE.Mesh(
      new THREE.IcosahedronGeometry(12, 5),
      new THREE.RawShaderMaterial({
        uniforms: { resolution: { value: new THREE.Vector2(1, 1) }, rand: { value: 0 } },
        vertexShader: backdropVS,
        fragmentShader: backdropFS,
        glslVersion: THREE.GLSL3,
      }),
    );
    (backdrop.material as THREE.RawShaderMaterial).side = THREE.BackSide;
    scene.add(backdrop);

    const camera = new THREE.PerspectiveCamera(FOV, this.width / this.height, 0.1, 1000);
    camera.position.set(2, -2, 5);

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();

    // 1. Ferrofluid blob
    const sphereMaterial = new THREE.MeshStandardMaterial({ color: 0x010101, metalness: 0.99, roughness: 0.003, emissive: 0x000000 });
    sphereMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.time = { value: 0 };
      shader.uniforms.inputData = { value: new THREE.Vector4() };
      shader.uniforms.outputData = { value: new THREE.Vector4() };
      shader.uniforms.spikeDensity = { value: spikeDensity };
      shader.uniforms.spikeAmplitude = { value: spikeAmplitude };
      shader.uniforms.noiseViscosity = { value: noiseViscosity };
      shader.uniforms.isFerrofluid = { value: isFerrofluid };
      sphereMaterial.userData.shader = shader;
      shader.vertexShader = sphereVS;
    };
    const sphere = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 64), sphereMaterial);
    sphere.visible = false;
    scene.add(sphere);

    // 2. Cymatic platform
    const planeMaterial = new THREE.MeshStandardMaterial({ color: 0x010101, metalness: 0.98, roughness: 0.005, emissive: 0x000000 });
    planeMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.time = { value: 0 };
      shader.uniforms.audioLevels = { value: new Float32Array(16) };
      shader.uniforms.activeModeIndex = { value: 0.0 };
      shader.uniforms.smoothedAmplitude = { value: 0.0 };
      shader.uniforms.cymaticAmplitude = { value: 1.0 };
      planeMaterial.userData.shader = shader;
      shader.vertexShader = cymaticsVS;
    };
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(3.5, 3.5, 160, 160), planeMaterial);
    plane.visible = false;
    scene.add(plane);

    // 3. Infinite-scroll landscape
    const landscapeMaterial = new THREE.MeshStandardMaterial({ color: 0x010101, metalness: 0.99, roughness: 0.008, emissive: 0x000000 });
    landscapeMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.time = { value: 0 };
      shader.uniforms.audioData = { value: new THREE.Vector4() };
      shader.uniforms.scrollSpeed = { value: scrollSpeed };
      shader.uniforms.mountainHeight = { value: landscapeHeight };
      shader.uniforms.isFerrofluid = { value: 0.0 };
      landscapeMaterial.userData.shader = shader;
      shader.vertexShader = landscapeVS;
    };
    const landscape = new THREE.Mesh(new THREE.PlaneGeometry(34, 40, 300, 300), landscapeMaterial);
    landscape.rotation.x = -Math.PI / 2.3;
    landscape.position.set(0, -1.15, -8);
    landscape.visible = false;
    scene.add(landscape);

    // 3b. Plasma sun
    const SUN_POS = new THREE.Vector3(0, 2.4, -16);
    const sun = new THREE.Group();
    const plasmaMat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, intensity: { value: 0.85 }, colorLow: { value: new THREE.Color(0x2a0a4e) }, colorHigh: { value: new THREE.Color(0xc24dff) } },
      vertexShader: plasmaVS,
      fragmentShader: plasmaFS,
    });
    const sunCore = new THREE.Mesh(new THREE.IcosahedronGeometry(3.0, 6), plasmaMat);
    const haloMat = new THREE.ShaderMaterial({
      uniforms: { color: { value: new THREE.Color(0x9b30ff) } },
      vertexShader: plasmaVS,
      fragmentShader: haloFS,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const sunHalo = new THREE.Mesh(new THREE.IcosahedronGeometry(4.7, 5), haloMat);
    sun.add(sunHalo, sunCore);
    sun.position.copy(SUN_POS);
    sun.visible = false;
    scene.add(sun);

    const sunLight = new THREE.PointLight(0xc24dff, 0, 70, 1.3);
    sunLight.position.copy(SUN_POS);
    scene.add(sunLight);

    // 3c. Starfield
    const starCount = 240;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const gx = ((i * 0.61803398875) % 1) * 2 - 1;
      const gy = (i * 0.7548776662) % 1;
      const gz = (i * 0.5698402909) % 1;
      starPos[i * 3] = gx * 34;
      starPos[i * 3 + 1] = 2.5 + gy * 24;
      starPos[i * 3 + 2] = -20 - gz * 26;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({ color: 0x8fa8d8, size: 0.13, sizeAttenuation: true, transparent: true, opacity: 0.6, depthWrite: false, fog: false });
    const stars = new THREE.Points(starGeo, starMat);
    stars.visible = false;
    scene.add(stars);

    // 4. Lighting
    const keyLight = new THREE.DirectionalLight(0xfff5ea, 1.4);
    keyLight.position.set(6, 9, 5);
    scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0xb14dff, 0.9);
    rimLight.position.set(-6, -3, -4);
    scene.add(rimLight);
    const fillLight = new THREE.DirectionalLight(0x00d2ff, 0.4);
    fillLight.position.set(0, -6, 5);
    scene.add(fillLight);
    const ambientLight = new THREE.AmbientLight(0x0c0714, 0.15);
    scene.add(ambientLight);

    // Env map
    let isEnvMapLoaded = false;
    let envRenderTarget: THREE.WebGLRenderTarget | null = null;
    let pmremDisposed = false;
    const exrLoader = new EXRLoader();
    exrLoader.load(EXR_URL, (texture: THREE.Texture) => {
      if (this.disposed) {
        texture.dispose();
        return;
      }
      texture.mapping = THREE.EquirectangularReflectionMapping;
      const rt = pmremGenerator.fromEquirectangular(texture);
      envRenderTarget = rt;
      sphereMaterial.envMap = rt.texture;
      planeMaterial.envMap = rt.texture;
      landscapeMaterial.envMap = rt.texture;
      texture.dispose();
      pmremGenerator.dispose();
      pmremDisposed = true;
      isEnvMapLoaded = true;
    });

    const renderPass = new RenderPass(scene, camera);
    const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.65, 0.4, 0.6);
    const composer = new EffectComposer(renderer);
    composer.addPass(renderPass);
    composer.addPass(bloomPass);

    const w = this.width;
    const h = this.height;
    (backdrop.material as THREE.RawShaderMaterial).uniforms.resolution.value.set(w, h);
    renderer.setSize(w, h, false);
    composer.setSize(w, h);

    // --- Animation state ---
    let prevTime = performance.now();
    const rotation = new THREE.Vector3(0, 0, 0);
    let smoothedMode = 0;
    let smoothedAmplitude = 0;
    let envB = 0, envM = 0, envH = 0;

    const animate = () => {
      this.rafId = requestAnimationFrame(animate);
      if (this.disposed) return;
      if (renderer.getContext().isContextLost()) return;

      this.sampleBins();
      const inData = this.bins;
      const outData = this.bins;

      const t = performance.now();
      const dt = (t - prevTime) / (1000 / 60);
      prevTime = t;

      let rawInB = 0, rawInM = 0, rawInH = 0, rawOutB = 0, rawOutM = 0, rawOutH = 0;
      for (let i = 0; i < 4; i++) { rawInB += inData[i] || 0; rawOutB += outData[i] || 0; }
      for (let i = 4; i < 11; i++) { rawInM += inData[i] || 0; rawOutM += outData[i] || 0; }
      for (let i = 11; i < 16; i++) { rawInH += inData[i] || 0; rawOutH += outData[i] || 0; }
      const tgtB = Math.max(rawInB, rawOutB) / 1020;
      const tgtM = Math.max(rawInM, rawOutM) / 1785;
      const tgtH = Math.max(rawInH, rawOutH) / 1275;
      const envK = Math.min(1, 0.035 * dt);
      envB += (tgtB - envB) * envK;
      envM += (tgtM - envM) * envK;
      envH += (tgtH - envH) * envK;

      const backdropMaterial = backdrop.material as THREE.RawShaderMaterial;
      backdropMaterial.uniforms.rand.value = Math.random() * 10000;

      const m = this.mode;
      const isOrb = m === 'orb';
      const isCymatics = m === 'cymatics';
      const isLandscape = m === 'landscape-chrome' || m === 'landscape-ferrofluid';

      sphere.visible = isOrb && isEnvMapLoaded;
      plane.visible = isCymatics && isEnvMapLoaded;
      landscape.visible = isLandscape && isEnvMapLoaded;
      sun.visible = isLandscape;
      stars.visible = isLandscape;
      if (!isLandscape) sunLight.intensity = 0;
      scene.fog = isLandscape ? landscapeFog : null;

      if (isOrb) {
        const shader = sphereMaterial.userData.shader;
        if (shader) {
          shader.uniforms.spikeDensity.value = spikeDensity;
          shader.uniforms.spikeAmplitude.value = spikeAmplitude;
          shader.uniforms.noiseViscosity.value = noiseViscosity;
          shader.uniforms.isFerrofluid.value = isFerrofluid;

          const combinedBass = envB, combinedMids = envM, combinedHighs = envH;
          const amp = (combinedBass + combinedMids + combinedHighs) / 3.0;

          sphere.scale.setScalar(1.0 + 0.04 * combinedBass);

          const f = 0.001;
          rotation.x += dt * f * 0.45;
          rotation.y += dt * f * 0.18 + combinedMids * 0.005;
          rotation.z += dt * f * 0.15;

          const euler = new THREE.Euler(rotation.x, rotation.y, rotation.z);
          const quaternion = new THREE.Quaternion().setFromEuler(euler);
          const vector = new THREE.Vector3(0, 0, 3.3);
          vector.applyQuaternion(quaternion);
          camera.position.copy(vector);
          camera.up.set(0, 1, 0);
          camera.lookAt(sphere.position);

          const speedScale = 0.015 * (1.0 + 0.6 * combinedBass);
          shader.uniforms.time.value += dt * speedScale;

          shader.uniforms.inputData.value.set(combinedBass, combinedMids, combinedHighs, amp);
          shader.uniforms.outputData.value.set(0, 0, 0, 0);
        }
      } else if (isCymatics) {
        const shader = planeMaterial.userData.shader;
        if (shader) {
          const audioLevels = new Float32Array(16);
          let avgVolume = 0;
          let sumWeights = 0;
          let sumIndices = 0;
          for (let i = 0; i < 16; i++) {
            const val = Math.max(inData[i] || 0, outData[i] || 0) / 255;
            audioLevels[i] = val;
            avgVolume += val;
            const weight = i === 0 ? val * 0.15 : val * val;
            sumWeights += weight;
            sumIndices += weight * i;
          }
          avgVolume /= 16;

          const targetMode = sumWeights > 0.005 ? sumIndices / sumWeights : 0.0;
          const modeSmoothFactor = targetMode < smoothedMode ? 0.04 : 0.08;
          smoothedMode += (targetMode - smoothedMode) * modeSmoothFactor * dt;
          smoothedMode = Math.max(0, Math.min(15, smoothedMode));

          const ampSmoothFactor = avgVolume > smoothedAmplitude ? 0.28 : 0.07;
          smoothedAmplitude += (avgVolume - smoothedAmplitude) * ampSmoothFactor * dt;

          shader.uniforms.time.value += dt * 0.04;
          shader.uniforms.audioLevels.value.set(audioLevels);
          shader.uniforms.activeModeIndex.value = smoothedMode;
          shader.uniforms.smoothedAmplitude.value = smoothedAmplitude;
          shader.uniforms.cymaticAmplitude.value = 1.0;

          const d = 1.45 / (TAN_HALF_FOV * Math.max(1, camera.aspect));
          camera.position.set(0, 0, d);
          camera.up.set(0, 1, 0);
          camera.lookAt(0, 0, 0);
        }
      } else if (isLandscape) {
        const shader = landscapeMaterial.userData.shader;
        if (shader) {
          const b = envB, mid = envM, h = envH;
          shader.uniforms.audioData.value.set(b, mid, h, 0);

          const speedMultiplier = scrollSpeed * (1.0 + b * 0.6);
          shader.uniforms.time.value += dt * 0.012 * speedMultiplier;
          shader.uniforms.scrollSpeed.value = scrollSpeed;
          shader.uniforms.mountainHeight.value = landscapeHeight;

          const ferrofluidWeight = m === 'landscape-ferrofluid' ? isFerrofluid : 0.0;
          shader.uniforms.isFerrofluid.value = ferrofluidWeight;

          plasmaMat.uniforms.time.value += dt * 0.02;
          plasmaMat.uniforms.intensity.value = 0.75 + 0.45 * b + 0.2 * mid;
          sunCore.scale.setScalar(1 + 0.06 * Math.sin(t * 0.003) + 0.3 * b);
          sunHalo.scale.setScalar(1 + 0.1 * Math.sin(t * 0.004) + 0.4 * mid);
          sunLight.intensity = 30 + 70 * b;
          stars.rotation.z += dt * 0.0006;
          starMat.opacity = 0.3 + 0.45 * h;

          camera.position.set(0, 0.6, 2.4);
          camera.up.set(0, 1, 0);
          camera.lookAt(0, 2.2, -6.5);
        }
      }

      composer.render();
    };
    this.rafId = requestAnimationFrame(animate);

    this.dispose_ = () => {
      cancelAnimationFrame(this.rafId);
      if (!pmremDisposed) pmremGenerator.dispose();
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = (mesh as THREE.Mesh).material;
        if (mat) (Array.isArray(mat) ? mat : [mat]).forEach((mm) => mm.dispose());
      });
      envRenderTarget?.dispose();
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
