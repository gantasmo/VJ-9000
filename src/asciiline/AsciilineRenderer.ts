/**
 * AsciilineRenderer -- a GPU ASCII source for the VJ.
 *
 * A faithful port of ASCILINE's AsciiMapper (YusufB5/ASCILINE, MIT with an
 * anti-advertisement clause) to a WebGL2 fragment pass. The upstream frame (the
 * loaded clip, else the webcam) is downscaled to the cell grid each frame (the
 * cv2.resize step), then a fragment shader picks a glyph per cell from the 93-char
 * luminance ramp and tints it with the cell's source colour (true colour) or a
 * single accent (mono). The glyph atlas is baked once with Canvas2D; that is the
 * only Canvas2D use, and the slow per-cell fillText render path from the original
 * is replaced by the GPU pass.
 *
 * Per the spec (docs/plans/2026-06-25-asciiline-glsl-port-spec.md) the glyph index
 * uses the corrected even spread over the whole ramp rather than ASCILINE's
 * integer-step saturation, so highlights use the full character set.
 *
 * License: ASCILINE is MIT with an ANTI-ADVERTISEMENT RESTRICTION. This source
 * must not be used to render advertising. Attribution: YusufB5/ASCILINE.
 */
export interface AsciiLevels {
  bass: number;
  mid: number;
  high: number;
  volume: number;
}

export interface AsciiSettings {
  /** Cell columns (density). Rows follow from the canvas + glyph aspect. */
  cols: number;
  /** Mono accent (true) vs source true-colour tint (false). */
  mono: boolean;
  /** Accent colour (hex) used in mono mode. */
  accent: string;
}

export const ASCII_SETTINGS_DEFAULT: AsciiSettings = {
  cols: 160,
  mono: false,
  accent: '#00ff41',
};

// ASCILINE's 93-char ramp, dark (space) to light (@). Verbatim.
const RAMP = " `.-':_,^=;><+!rc*/z?sLTv)J7(|Fi{C}fI31tlu[neoZ5Yxjya]2ESwqkP6h9d4VpOGbUAKXHm8RD#$Bg0MNWQ%&@";
const N = RAMP.length; // 93
const CELL_W = 16;
const CELL_H = 32; // glyph cell aspect 0.5 (monospace)
const GLYPH_ASPECT = CELL_W / CELL_H;

const VERT = `#version 300 es
precision highp float;
in vec4 position;
void main(){ gl_Position = position; }`;

const FRAG = `#version 300 es
precision highp float;
out vec4 O;
uniform sampler2D u_source;
uniform sampler2D u_atlas;
uniform vec2 u_resolution;
uniform vec2 u_grid;
uniform float u_n;
uniform float u_mono;
uniform vec3 u_accent;
uniform float u_bass;
uniform float u_volume;
void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  vec2 cell = floor(uv * u_grid);
  vec2 inCell = fract(uv * u_grid);
  vec2 cuv = (cell + 0.5) / u_grid;
  vec3 src = texture(u_source, cuv).rgb;
  float luma = dot(src, vec3(0.299, 0.587, 0.114));
  // Corrected even spread over the whole ramp (see spec).
  float idx = clamp(floor(luma * u_n), 0.0, u_n - 1.0);
  vec2 auv = vec2((idx + inCell.x) / u_n, inCell.y);
  float ink = texture(u_atlas, auv).a;
  vec3 col = (u_mono > 0.5) ? (u_accent * ink) : (src * ink);
  // Gentle audio pulse on the ink brightness.
  col *= 0.85 + 0.25 * u_volume + 0.15 * u_bass;
  O = vec4(col, 1.0);
}`;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 1, 0.25];
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export class AsciilineRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly getVideo: () => HTMLVideoElement | null;
  private readonly getLevels: () => AsciiLevels;
  private settings: AsciiSettings;

  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private srcTex: WebGLTexture | null = null;
  private atlasTex: WebGLTexture | null = null;
  private readonly small: HTMLCanvasElement;
  private readonly sctx: CanvasRenderingContext2D | null;
  private uni: Record<string, WebGLUniformLocation | null> = {};

  private rafId = 0;
  private disposed = false;
  private gridW = 0;
  private gridH = 0;

  constructor(
    canvas: HTMLCanvasElement,
    getVideo: () => HTMLVideoElement | null,
    getLevels: () => AsciiLevels,
    opts?: { settings?: AsciiSettings },
  ) {
    this.canvas = canvas;
    this.getVideo = getVideo;
    this.getLevels = getLevels;
    this.settings = opts?.settings ?? { ...ASCII_SETTINGS_DEFAULT };
    const gl = canvas.getContext('webgl2');
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // both textures upright vs gl_FragCoord
    canvas.addEventListener('webglcontextlost', (e) => e.preventDefault(), false);
    this.small = document.createElement('canvas');
    this.sctx = this.small.getContext('2d', { willReadFrequently: true });
    this.build();
    this.rafId = requestAnimationFrame(this.loop);
  }

  setSettings(s: AsciiSettings): void {
    this.settings = s;
  }

  private build(): void {
    const gl = this.gl;
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, 1, -1, -1, 1, 1, 1, -1]), gl.STATIC_DRAW);

    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!vs || !fs) throw new Error('shader create failed');
    gl.shaderSource(vs, VERT);
    gl.compileShader(vs);
    gl.shaderSource(fs, FRAG);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      // eslint-disable-next-line no-console
      console.warn('[asciiline] fragment compile error:\n', gl.getShaderInfoLog(fs));
    }
    const program = gl.createProgram();
    if (!program) throw new Error('program create failed');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    this.program = program;

    const pos = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['u_source', 'u_atlas', 'u_resolution', 'u_grid', 'u_n', 'u_mono', 'u_accent', 'u_bass', 'u_volume']) {
      this.uni[n] = gl.getUniformLocation(program, n);
    }

    this.srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.atlasTex = this.bakeAtlas();
  }

  /** Bake the 93 glyphs into a horizontal strip atlas (white on transparent). */
  private bakeAtlas(): WebGLTexture | null {
    const gl = this.gl;
    const c = document.createElement('canvas');
    c.width = N * CELL_W;
    c.height = CELL_H;
    const ctx = c.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `bold ${Math.round(CELL_H * 0.78)}px ui-monospace, monospace`;
      for (let i = 0; i < N; i++) {
        ctx.fillText(RAMP[i], i * CELL_W + CELL_W / 2, CELL_H / 2 + 1);
      }
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private loop = (): void => {
    this.rafId = requestAnimationFrame(this.loop);
    if (this.disposed || !this.program) return;
    const gl = this.gl;
    if (gl.isContextLost()) return;

    const W = this.canvas.width;
    const H = this.canvas.height;
    const cols = Math.max(8, Math.round(this.settings.cols));
    const rows = Math.max(2, Math.round(GLYPH_ASPECT * cols * (H / W)));
    if (cols !== this.gridW || rows !== this.gridH) {
      this.gridW = cols;
      this.gridH = rows;
      this.small.width = cols;
      this.small.height = rows;
    }

    // Downscale the upstream frame to the cell grid (the cv2.resize step), then
    // upload it as the source texture so each texel is exactly one averaged cell.
    const video = this.getVideo();
    if (video && this.sctx && video.readyState >= 2 && video.videoWidth) {
      this.sctx.drawImage(video, 0, 0, cols, rows);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.small);
    }

    const lv = this.getLevels();
    const [ar, ag, ab] = hexToRgb(this.settings.accent);

    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    if (this.uni.u_source) gl.uniform1i(this.uni.u_source, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.atlasTex);
    if (this.uni.u_atlas) gl.uniform1i(this.uni.u_atlas, 1);

    if (this.uni.u_resolution) gl.uniform2f(this.uni.u_resolution, W, H);
    if (this.uni.u_grid) gl.uniform2f(this.uni.u_grid, cols, rows);
    if (this.uni.u_n) gl.uniform1f(this.uni.u_n, N);
    if (this.uni.u_mono) gl.uniform1f(this.uni.u_mono, this.settings.mono ? 1 : 0);
    if (this.uni.u_accent) gl.uniform3f(this.uni.u_accent, ar, ag, ab);
    if (this.uni.u_bass) gl.uniform1f(this.uni.u_bass, clamp01(lv.bass));
    if (this.uni.u_volume) gl.uniform1f(this.uni.u_volume, clamp01(lv.volume));

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    const gl = this.gl;
    if (this.program) gl.deleteProgram(this.program);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.srcTex) gl.deleteTexture(this.srcTex);
    if (this.atlasTex) gl.deleteTexture(this.atlasTex);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
