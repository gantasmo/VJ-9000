/**
 * ShaderRenderer -- a generic fullscreen GLSL fragment-shader source for the VJ.
 *
 * Modeled on yotta's own raw WebGL2 Renderer (no three.js): one fullscreen
 * triangle-strip quad, a fragment shader source string, and the atzedent uniform
 * convention plus audio uniforms. It renders to a caller-owned offscreen canvas at
 * a fixed size so the hook can captureStream() it into the VJ feed exactly like
 * Cymatics and Spectra.
 *
 * Audio reactivity:
 *   - The renderer exposes u_bass / u_mid / u_high / u_volume (0..1) that an
 *     audio-aware shader MAY declare and use directly.
 *   - For shaders that do not (e.g. yotta), it accelerates the camera scrub
 *     (wheel.y) with the audio energy, so an unmodified atzedent flythrough flies
 *     faster on louder passages. A small constant base drift keeps it moving in
 *     silence, so the source always runs hands-off.
 *
 * Uniforms a shader may declare are bound only if present (getUniformLocation
 * returns null otherwise, and a uniform call on a null location is a silent no-op),
 * so any subset of the convention compiles and runs.
 */
import { SHADER_PRESETS, type ShaderParamConfig } from './shaderPresets';

export interface ShaderLevels {
  bass: number;
  mid: number;
  high: number;
  volume: number;
}

const VERT = `#version 300 es
precision highp float;
in vec4 position;
void main(){ gl_Position = position; }`;

// Camera-scrub drive (wheel.y units per second). yotta reads T = time + wheel.y/1e3,
// so ~1000 wheel units add ~1.0 to the flythrough parameter per second.
const BASE_DRIFT = 220; // hands-off constant flight, so it never freezes in silence
const AUDIO_GAIN = 1700; // how hard audio energy accelerates the flythrough

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

const UNIFORM_NAMES = [
  'time',
  'resolution',
  'wheel',
  'move',
  'zoom',
  'startRandom',
  'u_bass',
  'u_mid',
  'u_high',
  'u_volume',
  'u_material',
] as const;

export class ShaderRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly getLevels: () => ShaderLevels;
  private audioDrive: number;
  private source: string;

  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private uni: Partial<Record<(typeof UNIFORM_NAMES)[number], WebGLUniformLocation | null>> = {};
  // Editable param uniforms (per preset): live config + resolved locations.
  private params: ShaderParamConfig[] = [];
  private paramUni: Record<string, WebGLUniformLocation | null> = {};
  // Global shading material (u_material) + envelope-smoothed audio + eased params.
  private material = 0;
  private readonly sm = { bass: 0, mid: 0, high: 0, vol: 0 };
  private cur: Record<string, number> = {};
  private readonly startRandom = Math.random();

  private rafId = 0;
  private disposed = false;
  private startMs = 0;
  private prevMs = 0;
  private wheelOffset = 0;
  private lastError: string | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    getLevels: () => ShaderLevels,
    opts?: { source?: string; audioDrive?: number; params?: ShaderParamConfig[]; material?: number },
  ) {
    this.canvas = canvas;
    this.getLevels = getLevels;
    this.audioDrive = opts?.audioDrive ?? 1;
    this.source = opts?.source ?? SHADER_PRESETS[0].source;
    this.params = opts?.params ?? [];
    this.material = opts?.material ?? 0;
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault(), false);
    this.buildQuad();
    this.compile(this.source);
    this.startMs = performance.now();
    this.prevMs = this.startMs;
    this.rafId = requestAnimationFrame(this.loop);
  }

  setAudioDrive(n: number): void {
    this.audioDrive = n;
  }

  setMaterial(n: number): void {
    this.material = n;
  }

  /** Swap the fragment source live (and optionally its param set). A failed
   *  compile keeps the previous program and reports the error rather than
   *  rendering silent black. */
  setSource(src: string, params?: ShaderParamConfig[]): void {
    const err = this.test(src);
    if (err) {
      this.lastError = err;
      // eslint-disable-next-line no-console
      console.warn('[shader] compile failed, keeping previous source:\n', err);
      return;
    }
    if (params) this.params = params;
    this.source = src;
    this.compile(src);
  }

  /** Update the editable-param config without recompiling (slider / audio-band
   *  tweaks on the current shader). Re-queries locations against the live program. */
  setParams(params: ShaderParamConfig[]): void {
    this.params = params;
    if (this.program) this.bindParamLocations();
  }

  private bindParamLocations(): void {
    const gl = this.gl;
    this.paramUni = {};
    if (!this.program) return;
    for (const p of this.params) {
      this.paramUni[p.id] = gl.getUniformLocation(this.program, p.id);
    }
  }

  getLastError(): string | null {
    return this.lastError;
  }

  /** Compile-test a fragment source. Returns the info log on failure, else null. */
  test(src: string): string | null {
    const gl = this.gl;
    const sh = gl.createShader(gl.FRAGMENT_SHADER);
    if (!sh) return 'could not create shader';
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    let err: string | null = null;
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      err = gl.getShaderInfoLog(sh);
    }
    gl.deleteShader(sh);
    return err;
  }

  private buildQuad(): void {
    const gl = this.gl;
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, 1, -1, -1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  }

  private compile(fragSrc: string): void {
    const gl = this.gl;
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vs || !fs) {
      this.lastError = 'could not create shaders';
      return;
    }
    gl.shaderSource(vs, VERT);
    gl.compileShader(vs);
    gl.shaderSource(fs, fragSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      this.lastError = gl.getShaderInfoLog(fs);
      // eslint-disable-next-line no-console
      console.warn('[shader] fragment compile error:\n', this.lastError);
    }
    const program = gl.createProgram();
    if (!program) {
      this.lastError = 'could not create program';
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      return;
    }
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      this.lastError = gl.getProgramInfoLog(program);
      // eslint-disable-next-line no-console
      console.warn('[shader] link error:\n', this.lastError);
    }
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;

    const pos = gl.getAttribLocation(program, 'position');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);

    this.uni = {};
    for (const n of UNIFORM_NAMES) {
      this.uni[n] = gl.getUniformLocation(program, n);
    }
    this.bindParamLocations();
  }

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.disposed || !this.program) return;
    const gl = this.gl;
    if (gl.isContextLost()) return;

    const now = performance.now();
    const dt = Math.min((now - this.prevMs) / 1000, 0.1);
    this.prevMs = now;
    const t = (now - this.startMs) / 1000;

    // Envelope-follow the audio (fast attack, slow release) so reactivity is
    // punchy on transients but smooth on the decay -- no jitter.
    const lv = this.getLevels();
    const tcUp = 1 - Math.exp(-dt / 0.025);
    const tcDn = 1 - Math.exp(-dt / 0.18);
    const sm = this.sm;
    const rb = clamp01(lv.bass), rm = clamp01(lv.mid), rh = clamp01(lv.high), rv = clamp01(lv.volume);
    sm.bass += (rb - sm.bass) * (rb > sm.bass ? tcUp : tcDn);
    sm.mid += (rm - sm.mid) * (rm > sm.mid ? tcUp : tcDn);
    sm.high += (rh - sm.high) * (rh > sm.high ? tcUp : tcDn);
    sm.vol += (rv - sm.vol) * (rv > sm.vol ? tcUp : tcDn);
    const bass = sm.bass, mid = sm.mid, high = sm.high, vol = sm.vol;
    const energy = clamp01(vol * 0.7 + bass * 0.5);
    this.wheelOffset += dt * (BASE_DRIFT + energy * AUDIO_GAIN * this.audioDrive);

    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

    const u = this.uni;
    if (u.resolution) gl.uniform2f(u.resolution, w, h);
    if (u.time) gl.uniform1f(u.time, t);
    if (u.wheel) gl.uniform2f(u.wheel, 0, this.wheelOffset);
    if (u.move) gl.uniform2f(u.move, 0, 0);
    if (u.zoom) gl.uniform1f(u.zoom, bass);
    if (u.startRandom) gl.uniform1f(u.startRandom, this.startRandom);
    if (u.u_bass) gl.uniform1f(u.u_bass, bass);
    if (u.u_mid) gl.uniform1f(u.u_mid, mid);
    if (u.u_high) gl.uniform1f(u.u_high, high);
    if (u.u_volume) gl.uniform1f(u.u_volume, vol);
    if (u.u_material) gl.uniform1f(u.u_material, this.material);

    // Editable params: slider base + an audio-band push, eased toward the target
    // so slider drags / preset switches / audio all morph smoothly.
    const tcPar = 1 - Math.exp(-dt / 0.08);
    for (const pm of this.params) {
      const loc = this.paramUni[pm.id];
      if (!loc) continue;
      const level =
        pm.audio === 'bass' ? bass : pm.audio === 'mid' ? mid : pm.audio === 'high' ? high : pm.audio === 'volume' ? vol : 0;
      let target = pm.base + (pm.max - pm.min) * pm.amt * level;
      target = target < pm.min ? pm.min : target > pm.max ? pm.max : target;
      const prev = this.cur[pm.id];
      const val = prev === undefined ? target : prev + (target - prev) * tcPar;
      this.cur[pm.id] = val;
      gl.uniform1f(loc, val);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    const gl = this.gl;
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
