// OpenGL ES 1.1 fixed-function pipeline over WebGL (one uniform-switched program), plus the native
// EGL entry points (the real surface/context live Java-side in src/android/glview.ts).
//
// Client arrays are read from GUEST memory at draw time into per-attribute streaming VBOs;
// GL_FIXED data is converted on upload (WebGL has no fixed-point attributes). Matrices are
// column-major Float32Array(16) stacks; the shader takes the MVP product and the texture matrix.

import { mem } from "./mem";
import { hostLib, calledMissing, type HostFn, bitsf } from "./host";
import { gl } from "../android/gl";
import { perf } from "../perf";

type GL = WebGL2RenderingContext | WebGLRenderingContext;

/** getError probe after every GL entry point (perf.glErrors counts) */
export const glProbe = { on: false, capture: 0 };

type M4 = Float32Array;
const ident = (): M4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
function mul(a: M4, b: M4, out: M4): void {
  const t = tmpM;
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    t[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  out.set(t);
}
const tmpM = new Float32Array(16), tmpB = new Float32Array(16);
function mulRight(m: M4, b: M4): void { mul(m, b, m); }
const X = (v: number) => v / 65536;

interface ArrayState { on: boolean; size: number; type: number; stride: number; ptr: number; vbo: number }
const newArr = (size: number): ArrayState => ({ on: false, size, type: 0x1406, stride: 0, ptr: 0, vbo: 0 });

interface TexRec { tex: WebGLTexture | null; hasAlpha: boolean; genMip: boolean }

interface Ctx {
  gl: GL;
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
  aPos: number; aColor: number; aTex: number;
  vbos: WebGLBuffer[]; ebo: WebGLBuffer;
  textures: (TexRec | null)[];
  buffers: (WebGLBuffer | null)[];
  mode: number;
  mv: M4[]; pr: M4[]; tx: M4[][];
  vert: ArrayState; col: ArrayState; tex: ArrayState[]; norm: ArrayState;
  clientUnit: number; unit: number;
  texOn: boolean[]; texEnv: number[]; bound: number[];
  color: Float32Array;
  alphaTest: boolean; alphaFunc: number; alphaRef: number;
  arrayBuf: number; elemBuf: number;
  caps: Set<number>;
  err: number;
  unpackAlign: number;
  mvpDirty: boolean;
  scratch: Float32Array;
  warned: Set<string>;
}
const ctxs = new WeakMap<GL, Ctx>();
let C: Ctx | null = null;

const VS = `attribute vec4 aPos;attribute vec4 aColor;attribute vec4 aTex;
uniform mat4 uMVP;uniform mat4 uTexM;uniform bool uColArr;uniform vec4 uColor;uniform float uPointSize;
varying vec4 vColor;varying vec2 vTex;
void main(){gl_Position=uMVP*aPos;vColor=uColArr?aColor:uColor;vTex=(uTexM*aTex).xy;gl_PointSize=uPointSize;}`;
const FS = `precision mediump float;varying vec4 vColor;varying vec2 vTex;
uniform sampler2D uTex;uniform int uTexMode;uniform bool uTexAlpha;uniform int uAlphaFunc;uniform float uAlphaRef;
void main(){vec4 c=vColor;
if(uTexMode!=0){vec4 t=texture2D(uTex,vTex);
 if(uTexMode==1)c=c*t;else if(uTexMode==2)c=vec4(t.rgb,uTexAlpha?t.a:c.a);
 else if(uTexMode==3)c=vec4(mix(c.rgb,t.rgb,uTexAlpha?t.a:1.0),c.a);else if(uTexMode==4)c=vec4(c.rgb+t.rgb,c.a*t.a);else c=c*t;}
if(uAlphaFunc!=0){float a=c.a;bool p=true;
 if(uAlphaFunc==1)p=false;else if(uAlphaFunc==2)p=a<uAlphaRef;else if(uAlphaFunc==3)p=a==uAlphaRef;else if(uAlphaFunc==4)p=a<=uAlphaRef;
 else if(uAlphaFunc==5)p=a>uAlphaRef;else if(uAlphaFunc==6)p=a!=uAlphaRef;else if(uAlphaFunc==7)p=a>=uAlphaRef;
 if(!p)discard;}
gl_FragColor=c;}`;

function ctxFor(g: GL): Ctx {
  let c = ctxs.get(g);
  if (c) return c;
  const prog = g.createProgram()!;
  for (const [type, src] of [[g.VERTEX_SHADER, VS], [g.FRAGMENT_SHADER, FS]] as const) {
    const sh = g.createShader(type)!;
    g.shaderSource(sh, src); g.compileShader(sh);
    if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) console.error("[gles1] shader:", g.getShaderInfoLog(sh));
    g.attachShader(prog, sh);
  }
  g.linkProgram(prog);
  if (!g.getProgramParameter(prog, g.LINK_STATUS)) console.error("[gles1] link:", g.getProgramInfoLog(prog));
  const u: Record<string, WebGLUniformLocation | null> = {};
  for (const n of ["uMVP", "uTexM", "uColArr", "uColor", "uPointSize", "uTex", "uTexMode", "uTexAlpha", "uAlphaFunc", "uAlphaRef"]) u[n] = g.getUniformLocation(prog, n);
  c = {
    gl: g, prog, u, aPos: g.getAttribLocation(prog, "aPos"), aColor: g.getAttribLocation(prog, "aColor"), aTex: g.getAttribLocation(prog, "aTex"),
    vbos: [g.createBuffer()!, g.createBuffer()!, g.createBuffer()!, g.createBuffer()!], ebo: g.createBuffer()!,
    textures: [null], buffers: [null],
    mode: 0x1700, mv: [ident()], pr: [ident()], tx: [[ident()], [ident()]],
    vert: newArr(4), col: newArr(4), tex: [newArr(4), newArr(4)], norm: newArr(3),
    clientUnit: 0, unit: 0, texOn: [false, false], texEnv: [0x2100, 0x2100], bound: [0, 0],
    color: new Float32Array([1, 1, 1, 1]), alphaTest: false, alphaFunc: 0x207, alphaRef: 0,
    arrayBuf: 0, elemBuf: 0, caps: new Set(), err: 0, unpackAlign: 4, mvpDirty: true, scratch: new Float32Array(4096), warned: new Set(),
  };
  g.useProgram(prog);
  g.uniform1i(u.uTex, 0);
  ctxs.set(g, c);
  return c;
}
/** the GLES1 state for the current context (the Java EGL path selected it via setGL) */
function cur(): Ctx | null {
  if (!gl) return null;
  if (!C || C.gl !== gl) C = ctxFor(gl);
  return C;
}
function stack(c: Ctx): M4[] { return c.mode === 0x1701 ? c.pr : c.mode === 0x1702 ? c.tx[c.unit] : c.mv; }
function top(c: Ctx): M4 { const s = stack(c); return s[s.length - 1]; }
function once(c: Ctx, what: string): void {
  if (c.warned.has(what)) return;
  c.warned.add(what);
  calledMissing.add("gles1:" + what);
  console.warn("[gles1] unimplemented:", what);
}
const typeSize: Record<number, number> = { 0x1400: 1, 0x1401: 1, 0x1402: 2, 0x1403: 2, 0x1404: 4, 0x1405: 4, 0x1406: 4, 0x140c: 4 };

/** bind one client array to a shader attribute for vertices [first, first+count) */
function bindArray(c: Ctx, a: ArrayState, loc: number, slot: number, first: number, count: number, normalized: boolean): void {
  const g = c.gl;
  const es = typeSize[a.type] ?? 4;
  const stride = a.stride || a.size * es;
  if (a.vbo) {
    g.bindBuffer(g.ARRAY_BUFFER, c.buffers[a.vbo]!);
    g.enableVertexAttribArray(loc);
    if (a.type === 0x140c) { once(c, "GL_FIXED attributes in a VBO"); g.vertexAttribPointer(loc, a.size, g.FLOAT, false, stride, a.ptr); }
    else g.vertexAttribPointer(loc, a.size, a.type, normalized, stride, a.ptr);
    return;
  }
  g.bindBuffer(g.ARRAY_BUFFER, c.vbos[slot]);
  const start = a.ptr + first * stride;
  if (a.type === 0x140c) {
    // 16.16 → float, compacted
    const n = count * a.size;
    const out = c.scratch.length >= n ? c.scratch.subarray(0, n) : (c.scratch = new Float32Array(n * 2)).subarray(0, n);
    for (let v = 0, o = 0; v < count; v++) { const p = start + v * stride; for (let k = 0; k < a.size; k++) out[o++] = mem.i32[(p >>> 2) + k] / 65536; }
    g.bufferData(g.ARRAY_BUFFER, out, g.STREAM_DRAW);
    g.enableVertexAttribArray(loc);
    g.vertexAttribPointer(loc, a.size, g.FLOAT, false, 0, 0);
    return;
  }
  const bytes = (count - 1) * stride + a.size * es;
  g.bufferData(g.ARRAY_BUFFER, mem.u8.subarray(start, start + bytes), g.STREAM_DRAW);
  g.enableVertexAttribArray(loc);
  g.vertexAttribPointer(loc, a.size, a.type, normalized, stride, 0);
}

function prepareDraw(c: Ctx, first: number, count: number): boolean {
  const g = c.gl;
  if (!c.vert.on) return false;
  g.useProgram(c.prog);
  const mv = c.mv[c.mv.length - 1], pr = c.pr[c.pr.length - 1];
  mul(pr, mv, tmpB);
  g.uniformMatrix4fv(c.u.uMVP, false, tmpB);
  bindArray(c, c.vert, c.aPos, 0, first, count, false);
  if (c.col.on) { g.uniform1i(c.u.uColArr, 1); bindArray(c, c.col, c.aColor, 1, first, count, true); }
  else { g.uniform1i(c.u.uColArr, 0); g.disableVertexAttribArray(c.aColor); g.uniform4fv(c.u.uColor, c.color); }
  // texturing: unit 0 only feeds the shader; a second enabled unit is reported once
  const texOn = c.texOn[0] && c.bound[0] !== 0 && c.textures[c.bound[0]];
  if (texOn) {
    const rec = c.textures[c.bound[0]]!;
    const env = c.texEnv[0];
    g.uniform1i(c.u.uTexMode, env === 0x2100 ? 1 : env === 0x1e01 ? 2 : env === 0x2101 ? 3 : env === 0x0104 ? 4 : 1);
    g.uniform1i(c.u.uTexAlpha, rec.hasAlpha ? 1 : 0);
    g.activeTexture(g.TEXTURE0);
    g.bindTexture(g.TEXTURE_2D, rec.tex);
    g.uniformMatrix4fv(c.u.uTexM, false, c.tx[0][c.tx[0].length - 1]);
    const ta = c.tex[0];
    if (ta.on) bindArray(c, ta, c.aTex, 2, first, count, false);
    else { g.disableVertexAttribArray(c.aTex); g.vertexAttrib4f(c.aTex, 0, 0, 0, 1); }
    if (c.texOn[1] && c.bound[1]) once(c, "multitexture unit 1");
  } else {
    g.uniform1i(c.u.uTexMode, 0);
    g.disableVertexAttribArray(c.aTex);
  }
  if (c.alphaTest) { g.uniform1i(c.u.uAlphaFunc, c.alphaFunc - 0x200); g.uniform1f(c.u.uAlphaRef, c.alphaRef); }
  else g.uniform1i(c.u.uAlphaFunc, 0);
  if (c.caps.has(0x0b50)) once(c, "GL_LIGHTING");
  if (c.caps.has(0x0b60)) once(c, "GL_FOG");
  return true;
}

function texFormat(fmt: number): { hasAlpha: boolean; bpp: number } {
  switch (fmt) {
    case 0x1908: return { hasAlpha: true, bpp: 4 };   // RGBA
    case 0x1907: return { hasAlpha: false, bpp: 3 };  // RGB
    case 0x1906: return { hasAlpha: true, bpp: 1 };   // ALPHA
    case 0x1909: return { hasAlpha: false, bpp: 1 };  // LUMINANCE
    case 0x190a: return { hasAlpha: true, bpp: 2 };   // LUMINANCE_ALPHA
    default: return { hasAlpha: true, bpp: 4 };
  }
}
function pixelView(c: Ctx, w: number, h: number, fmt: number, type: number, p: number): ArrayBufferView | null {
  if (!p) return null;
  let bpp = texFormat(fmt).bpp;
  if (type === 0x8033 || type === 0x8034 || type === 0x8363) bpp = 2;
  let row = w * bpp;
  const al = c.unpackAlign;
  row = (row + al - 1) & -al;
  const n = row * h;
  if (bpp === 2 && type !== 0x1401) return new Uint16Array(mem.buf, p, n >> 1);
  return mem.u8.subarray(p, p + n);
}
const ETC1 = 0x8d64;
/** ETC1 (RGB8, 4x4 blocks) → RGBA8 */
function decodeEtc1(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  const MOD = [[2, 8], [5, 17], [9, 29], [13, 42], [18, 60], [24, 80], [33, 106], [47, 183]];
  const bw = (w + 3) >> 2, bh = (h + 3) >> 2;
  const cl = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const o = (by * bw + bx) * 8;
    const hi = (src[o] << 24) | (src[o + 1] << 16) | (src[o + 2] << 8) | src[o + 3];
    const lo = (src[o + 4] << 24) | (src[o + 5] << 16) | (src[o + 6] << 8) | src[o + 7];
    const diff = (hi >>> 1) & 1, flip = hi & 1;
    let r1: number, g1: number, b1: number, r2: number, g2: number, b2: number;
    if (diff) {
      const r = (hi >>> 27) & 31, g = (hi >>> 19) & 31, b = (hi >>> 11) & 31;
      const dr = ((hi >>> 24) & 7) << 29 >> 29, dg = ((hi >>> 16) & 7) << 29 >> 29, db = ((hi >>> 8) & 7) << 29 >> 29;
      r1 = (r << 3) | (r >> 2); g1 = (g << 3) | (g >> 2); b1 = (b << 3) | (b >> 2);
      const r2_ = r + dr, g2_ = g + dg, b2_ = b + db;
      r2 = (r2_ << 3) | (r2_ >> 2); g2 = (g2_ << 3) | (g2_ >> 2); b2 = (b2_ << 3) | (b2_ >> 2);
    } else {
      r1 = ((hi >>> 28) & 15) * 17; g1 = ((hi >>> 20) & 15) * 17; b1 = ((hi >>> 12) & 15) * 17;
      r2 = ((hi >>> 24) & 15) * 17; g2 = ((hi >>> 16) & 15) * 17; b2 = ((hi >>> 8) & 15) * 17;
    }
    const t1 = (hi >>> 5) & 7, t2 = (hi >>> 2) & 7;
    for (let i = 0; i < 16; i++) {
      const px = i >> 2, py = i & 3;   // ETC1 pixel order is column-major within the block
      const sub = flip ? (py >= 2 ? 1 : 0) : (px >= 2 ? 1 : 0);
      const msb = (lo >>> (i + 16)) & 1, lsb = (lo >>> i) & 1;
      const idx = (msb << 1) | lsb;
      const tab = MOD[sub ? t2 : t1];
      const m = idx === 0 ? tab[0] : idx === 1 ? tab[1] : idx === 2 ? -tab[0] : -tab[1];
      const x = bx * 4 + px, y = by * 4 + py;
      if (x >= w || y >= h) continue;
      const q = (y * w + x) * 4;
      if (sub) { out[q] = cl(r2 + m); out[q + 1] = cl(g2 + m); out[q + 2] = cl(b2 + m); }
      else { out[q] = cl(r1 + m); out[q + 1] = cl(g1 + m); out[q + 2] = cl(b1 + m); }
      out[q + 3] = 255;
    }
  }
  return out;
}

const EXTENSIONS = "GL_OES_blend_subtract GL_OES_blend_func_separate GL_OES_blend_equation_separate GL_OES_texture_npot GL_OES_compressed_ETC1_RGB8_texture GL_OES_read_format GL_OES_point_size_array GL_OES_point_sprite GL_OES_single_precision";
export let gles1Procs: Record<string, HostFn> = {};

export function gles1Init(): void {
  const strs = new Map<string, number>();
  const cstr = (s: string) => { let p = strs.get(s); if (!p) strs.set(s, (p = mem.hostStr(s))); return p; };
  const noCtx = () => { calledMissing.add("gles1:call without a current context"); };
  /** wrap: current-context guard + optional getError probe */
  const W = (name: string, fn: (c: Ctx, a: Parameters<HostFn>[1]) => number | void | bigint): HostFn => (_cpu, a) => {
    const c = cur();
    if (!c) { noCtx(); return 0; }
    const r = fn(c, a);
    if (glProbe.on) { const e = c.gl.getError(); if (e) { perf.glErrors++; console.warn("[gles1] error", e.toString(16), "after", name); } }
    return r === undefined ? 0 : r;
  };
  const m4 = (a: { i(): number }, fixed: boolean): M4 => { const p = a.i(); const m = new Float32Array(16); for (let i = 0; i < 16; i++) m[i] = fixed ? mem.i32[(p >>> 2) + i] / 65536 : mem.f32[(p >>> 2) + i]; return m; };
  const F = (a: { i(): number }) => bitsf(a.i());
  const Xa = (a: { i(): number }) => X(a.i());
  const translate = (c: Ctx, x: number, y: number, z: number) => { const m = ident(); m[12] = x; m[13] = y; m[14] = z; mulRight(top(c), m); };
  const scale = (c: Ctx, x: number, y: number, z: number) => { const m = ident(); m[0] = x; m[5] = y; m[10] = z; mulRight(top(c), m); };
  const rotate = (c: Ctx, ang: number, x: number, y: number, z: number) => {
    const l = Math.hypot(x, y, z); if (!l) return; x /= l; y /= l; z /= l;
    const r = ang * Math.PI / 180, s = Math.sin(r), co = Math.cos(r), t = 1 - co;
    const m = new Float32Array([t * x * x + co, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + co, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + co, 0, 0, 0, 0, 1]);
    mulRight(top(c), m);
  };
  const ortho = (c: Ctx, l: number, r: number, b: number, t: number, n: number, f: number) => {
    const m = ident(); m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n); m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n);
    mulRight(top(c), m);
  };
  const frustum = (c: Ctx, l: number, r: number, b: number, t: number, n: number, f: number) => {
    const m = new Float32Array(16); m[0] = 2 * n / (r - l); m[5] = 2 * n / (t - b); m[8] = (r + l) / (r - l); m[9] = (t + b) / (t - b); m[10] = -(f + n) / (f - n); m[11] = -1; m[14] = -2 * f * n / (f - n);
    mulRight(top(c), m);
  };
  const setArr = (get: (c: Ctx) => ArrayState) => W("glPointer", (c, a) => { const s = get(c); s.size = a.i(); s.type = a.i(); s.stride = a.i(); s.ptr = a.i() >>> 0; s.vbo = c.arrayBuf; });
  const capSet = (c: Ctx, cap: number, on: boolean) => {
    const g = c.gl;
    switch (cap) {
      case 0x0de1: c.texOn[c.unit] = on; return;
      case 0x0bc0: c.alphaTest = on; return;
      case 0x0be2: case 0x0b71: case 0x0b44: case 0x0c11: case 0x0b90: case 0x0bd0: case 0x8037: case 0x809e: case 0x80a0:
        if (on) g.enable(cap); else g.disable(cap); return;
      default: if (on) c.caps.add(cap); else c.caps.delete(cap);
    }
  };
  const isOn = (c: Ctx, cap: number): number => cap === 0x0de1 ? +c.texOn[c.unit] : cap === 0x0bc0 ? +c.alphaTest : [0x0be2, 0x0b71, 0x0b44, 0x0c11, 0x0b90, 0x0bd0, 0x8037].includes(cap) ? +c.gl.isEnabled(cap) : cap === 0x8074 ? +c.vert.on : cap === 0x8076 ? +c.col.on : cap === 0x8078 ? +c.tex[c.clientUnit].on : cap === 0x8075 ? +c.norm.on : +c.caps.has(cap);
  const getv = (c: Ctx, pname: number): number[] | null => {
    const g = c.gl;
    switch (pname) {
      case 0x0d33: return [g.getParameter(g.MAX_TEXTURE_SIZE)];
      case 0x84e2: return [2];                                     // MAX_TEXTURE_UNITS
      case 0x0ba2: return Array.from(g.getParameter(g.VIEWPORT) as Int32Array);
      case 0x0c10: return Array.from(g.getParameter(g.SCISSOR_BOX) as Int32Array);
      case 0x0ba0: return [c.mode];
      case 0x0ba6: return Array.from(c.mv[c.mv.length - 1]);
      case 0x0ba7: return Array.from(c.pr[c.pr.length - 1]);
      case 0x0ba8: return Array.from(c.tx[c.unit][c.tx[c.unit].length - 1]);
      case 0x0d36: return [32]; case 0x0d38: return [2]; case 0x0d39: return [2];
      case 0x0d31: return [8]; case 0x0d32: return [6];
      case 0x0d52: return [8]; case 0x0d53: return [8]; case 0x0d54: return [8]; case 0x0d55: return [8];   // R/G/B/A bits
      case 0x0d56: return [g.getParameter(g.DEPTH_BITS)]; case 0x0d57: return [g.getParameter(g.STENCIL_BITS)];
      case 0x86a2: return [1]; case 0x86a3: return [ETC1];         // NUM_COMPRESSED_TEXTURE_FORMATS / COMPRESSED_TEXTURE_FORMATS
      case 0x846d: return Array.from(g.getParameter(g.ALIASED_POINT_SIZE_RANGE) as Float32Array);
      case 0x846e: return Array.from(g.getParameter(g.ALIASED_LINE_WIDTH_RANGE) as Float32Array);
      case 0x0d50: return [4];                                     // SUBPIXEL_BITS
      case 0x8b9a: return [0x1401]; case 0x8b9b: return [0x1908];  // IMPLEMENTATION_COLOR_READ_TYPE/FORMAT
      case 0x80e8: return [65536]; case 0x80e9: return [65536];    // MAX_ELEMENTS_VERTICES/INDICES
      case 0x8069: return [c.bound[c.unit]];                       // TEXTURE_BINDING_2D
      case 0x8894: return [c.arrayBuf]; case 0x8895: return [c.elemBuf];
      case 0x0b00: return Array.from(c.color);
      case 0x0cf5: return [c.unpackAlign];
      case 0x0d05: return [4];
      case 0x8872: return [2];                                     // MAX_TEXTURE_IMAGE_UNITS
      case 0x0b21: return [1]; case 0x0b12: return [1];            // LINE_WIDTH / POINT_SIZE
      case 0x80a9: return [g.getParameter(g.SAMPLES)]; case 0x80a8: return [g.getParameter(g.SAMPLE_BUFFERS)];
      case 0x0b70: return Array.from(g.getParameter(g.DEPTH_RANGE) as Float32Array);
      case 0x8038: return [0]; case 0x2a00: return [0];
      default: return null;
    }
  };
  const getInto = (kind: "i" | "f" | "x" | "b") => W("glGet", (c, a) => {
    const pname = a.i(), out = a.p();
    const v = getv(c, pname);
    if (!v) { once(c, `glGet*v(0x${pname.toString(16)})`); mem.st32(out, 0); return; }
    for (let i = 0; i < v.length; i++) {
      if (kind === "f") mem.stf32(out + i * 4, v[i]);
      else if (kind === "x") mem.st32(out + i * 4, Math.round(v[i] * 65536));
      else if (kind === "b") mem.st8(out + i, v[i] ? 1 : 0);
      else mem.st32(out + i * 4, pname === 0x0b00 ? Math.round(v[i] * 2147483647) : v[i] | 0);
    }
  });
  const texImage = (c: Ctx, target: number, level: number, ifmt: number, w: number, h: number, fmt: number, type: number, p: number, sub: { x: number; y: number } | null) => {
    const g = c.gl;
    const rec = c.textures[c.bound[c.unit]];
    if (!rec) return;
    g.pixelStorei(g.UNPACK_ALIGNMENT, c.unpackAlign);
    g.bindTexture(g.TEXTURE_2D, rec.tex);
    const data = pixelView(c, w, h, fmt, type, p);
    if (sub) g.texSubImage2D(target, level, sub.x, sub.y, w, h, fmt, type, data);
    else { g.texImage2D(target, level, ifmt, w, h, 0, fmt, type, data); if (level === 0) rec.hasAlpha = texFormat(fmt).hasAlpha; }
    if (rec.genMip && level === 0) g.generateMipmap(g.TEXTURE_2D);
  };
  const texParam = W("glTexParameter", (c, a) => {
    const target = a.i(), pname = a.i(), v = a.i();
    const rec = c.textures[c.bound[c.unit]];
    if (pname === 0x8191) { if (rec) rec.genMip = v !== 0; return; }   // GL_GENERATE_MIPMAP
    if (rec) c.gl.bindTexture(target, rec.tex);
    c.gl.texParameteri(target, pname, v);
  });
  const texParamF = W("glTexParameterf", (c, a) => {
    const target = a.i(), pname = a.i(), v = bitsf(a.i()) | 0;
    const rec = c.textures[c.bound[c.unit]];
    if (pname === 0x8191) { if (rec) rec.genMip = v !== 0; return; }
    if (rec) c.gl.bindTexture(target, rec.tex);
    c.gl.texParameteri(target, pname, v);
  });
  const texParamV = W("glTexParameterv", (c, a) => { const target = a.i(), pname = a.i(), p = a.p(); const v = pname === 0x8191 ? mem.ld32(p) : mem.ld32(p); const rec = c.textures[c.bound[c.unit]]; if (pname === 0x8191) { if (rec) rec.genMip = v !== 0; return; } if (rec) c.gl.bindTexture(target, rec.tex); c.gl.texParameteri(target, pname, v); });
  const draw = (c: Ctx, mode: number, count: number, indices: { type: number; ptr: number } | null, first: number) => {
    const g = c.gl;
    if (count <= 0) return;
    if (indices) {
      const es = indices.type === 0x1403 ? 2 : 1;
      let max = 0;
      if (c.elemBuf) { once(c, "glDrawElements with a bound ELEMENT_ARRAY_BUFFER (vertex range unknown)"); max = 65535; }
      else {
        const p = indices.ptr;
        if (es === 2) for (let i = 0; i < count; i++) { const v = mem.u16[(p >>> 1) + i]; if (v > max) max = v; }
        else for (let i = 0; i < count; i++) { const v = mem.u8[p + i]; if (v > max) max = v; }
      }
      if (!prepareDraw(c, 0, max + 1)) return;
      if (c.elemBuf) g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, c.buffers[c.elemBuf]!);
      else { g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, c.ebo); g.bufferData(g.ELEMENT_ARRAY_BUFFER, mem.u8.subarray(indices.ptr, indices.ptr + count * es), g.STREAM_DRAW); }
      g.drawElements(mode, count, indices.type, c.elemBuf ? indices.ptr : 0);
    } else {
      if (!prepareDraw(c, first, count)) return;
      // uploaded arrays start at `first`, so the draw starts at 0 (VBO-backed ones keep the offset)
      g.drawArrays(mode, c.vert.vbo ? first : 0, count);
    }
    perf.glDraws++;
  };

  const G: Record<string, HostFn> = {
    glMatrixMode: W("glMatrixMode", (c, a) => { c.mode = a.i(); }),
    glLoadIdentity: W("glLoadIdentity", (c) => { top(c).set(ident()); }),
    glLoadMatrixf: W("glLoadMatrixf", (c, a) => { top(c).set(m4(a, false)); }),
    glLoadMatrixx: W("glLoadMatrixx", (c, a) => { top(c).set(m4(a, true)); }),
    glMultMatrixf: W("glMultMatrixf", (c, a) => { mulRight(top(c), m4(a, false)); }),
    glMultMatrixx: W("glMultMatrixx", (c, a) => { mulRight(top(c), m4(a, true)); }),
    glPushMatrix: W("glPushMatrix", (c) => { const s = stack(c); const lim = c.mode === 0x1700 ? 32 : 2; if (s.length >= lim) { c.err = 0x503; return; } s.push(new Float32Array(s[s.length - 1])); }),
    glPopMatrix: W("glPopMatrix", (c) => { const s = stack(c); if (s.length <= 1) { c.err = 0x504; return; } s.pop(); }),
    glOrthof: W("glOrthof", (c, a) => ortho(c, F(a), F(a), F(a), F(a), F(a), F(a))),
    glOrthox: W("glOrthox", (c, a) => ortho(c, Xa(a), Xa(a), Xa(a), Xa(a), Xa(a), Xa(a))),
    glFrustumf: W("glFrustumf", (c, a) => frustum(c, F(a), F(a), F(a), F(a), F(a), F(a))),
    glFrustumx: W("glFrustumx", (c, a) => frustum(c, Xa(a), Xa(a), Xa(a), Xa(a), Xa(a), Xa(a))),
    glTranslatef: W("glTranslatef", (c, a) => translate(c, F(a), F(a), F(a))),
    glTranslatex: W("glTranslatex", (c, a) => translate(c, Xa(a), Xa(a), Xa(a))),
    glScalef: W("glScalef", (c, a) => scale(c, F(a), F(a), F(a))),
    glScalex: W("glScalex", (c, a) => scale(c, Xa(a), Xa(a), Xa(a))),
    glRotatef: W("glRotatef", (c, a) => rotate(c, F(a), F(a), F(a), F(a))),
    glRotatex: W("glRotatex", (c, a) => rotate(c, Xa(a), Xa(a), Xa(a), Xa(a))),
    glVertexPointer: setArr((c) => c.vert),
    glColorPointer: setArr((c) => c.col),
    glTexCoordPointer: setArr((c) => c.tex[c.clientUnit]),
    glNormalPointer: W("glNormalPointer", (c, a) => { const s = c.norm; s.type = a.i(); s.stride = a.i(); s.ptr = a.i() >>> 0; s.vbo = c.arrayBuf; }),
    glPointSizePointerOES: W("glPointSizePointerOES", (c) => once(c, "glPointSizePointerOES")),
    glEnableClientState: W("glEnableClientState", (c, a) => { const s = a.i(); if (s === 0x8074) c.vert.on = true; else if (s === 0x8076) c.col.on = true; else if (s === 0x8078) c.tex[c.clientUnit].on = true; else if (s === 0x8075) c.norm.on = true; }),
    glDisableClientState: W("glDisableClientState", (c, a) => { const s = a.i(); if (s === 0x8074) c.vert.on = false; else if (s === 0x8076) c.col.on = false; else if (s === 0x8078) c.tex[c.clientUnit].on = false; else if (s === 0x8075) c.norm.on = false; }),
    glClientActiveTexture: W("glClientActiveTexture", (c, a) => { c.clientUnit = (a.i() - 0x84c0) & 1; }),
    glActiveTexture: W("glActiveTexture", (c, a) => { c.unit = (a.i() - 0x84c0) & 1; }),
    glDrawArrays: W("glDrawArrays", (c, a) => { const mode = a.i(), first = a.i(), count = a.i(); draw(c, mode, count, null, first); }),
    glDrawElements: W("glDrawElements", (c, a) => { const mode = a.i(), count = a.i(), type = a.i(), ptr = a.p(); draw(c, mode, count, { type, ptr }, 0); }),
    glColor4f: W("glColor4f", (c, a) => { c.color[0] = F(a); c.color[1] = F(a); c.color[2] = F(a); c.color[3] = F(a); }),
    glColor4x: W("glColor4x", (c, a) => { c.color[0] = Xa(a); c.color[1] = Xa(a); c.color[2] = Xa(a); c.color[3] = Xa(a); }),
    glColor4ub: W("glColor4ub", (c, a) => { c.color[0] = (a.i() & 255) / 255; c.color[1] = (a.i() & 255) / 255; c.color[2] = (a.i() & 255) / 255; c.color[3] = (a.i() & 255) / 255; }),
    glNormal3f: W("glNormal3f", () => {}), glNormal3x: W("glNormal3x", () => {}),
    glMultiTexCoord4f: W("glMultiTexCoord4f", (c) => once(c, "glMultiTexCoord4f")), glMultiTexCoord4x: W("glMultiTexCoord4x", (c) => once(c, "glMultiTexCoord4x")),
    glPointSize: W("glPointSize", (c, a) => { c.gl.useProgram(c.prog); c.gl.uniform1f(c.u.uPointSize, F(a)); }),
    glPointSizex: W("glPointSizex", (c, a) => { c.gl.useProgram(c.prog); c.gl.uniform1f(c.u.uPointSize, Xa(a)); }),
    glLineWidth: W("glLineWidth", (c, a) => c.gl.lineWidth(F(a))), glLineWidthx: W("glLineWidthx", (c, a) => c.gl.lineWidth(Xa(a))),
    glGenTextures: W("glGenTextures", (c, a) => { const n = a.i(), out = a.p(); for (let i = 0; i < n; i++) { c.textures.push({ tex: c.gl.createTexture(), hasAlpha: true, genMip: false }); mem.st32(out + i * 4, c.textures.length - 1); } }),
    glDeleteTextures: W("glDeleteTextures", (c, a) => { const n = a.i(), p = a.p(); for (let i = 0; i < n; i++) { const id = mem.ld32(p + i * 4); const r = c.textures[id]; if (r) { c.gl.deleteTexture(r.tex); c.textures[id] = null; } for (let u = 0; u < 2; u++) if (c.bound[u] === id) c.bound[u] = 0; } }),
    glBindTexture: W("glBindTexture", (c, a) => { a.i(); const id = a.i(); c.bound[c.unit] = id; if (id && !c.textures[id]) { while (c.textures.length <= id) c.textures.push(null); c.textures[id] = { tex: c.gl.createTexture(), hasAlpha: true, genMip: false }; } c.gl.activeTexture(c.gl.TEXTURE0 + c.unit); c.gl.bindTexture(c.gl.TEXTURE_2D, id ? c.textures[id]!.tex : null); }),
    glIsTexture: W("glIsTexture", (c, a) => (c.textures[a.i()] ? 1 : 0)),
    glTexImage2D: W("glTexImage2D", (c, a) => { const target = a.i(), level = a.i(), ifmt = a.i(), w = a.i(), h = a.i(); a.i(); const fmt = a.i(), type = a.i(), p = a.p(); texImage(c, target, level, ifmt, w, h, fmt, type, p, null); }),
    glTexSubImage2D: W("glTexSubImage2D", (c, a) => { const target = a.i(), level = a.i(), x = a.i(), y = a.i(), w = a.i(), h = a.i(), fmt = a.i(), type = a.i(), p = a.p(); texImage(c, target, level, fmt, w, h, fmt, type, p, { x, y }); }),
    glCompressedTexImage2D: W("glCompressedTexImage2D", (c, a) => {
      const target = a.i(), level = a.i(), fmt = a.i(), w = a.i(), h = a.i(); a.i(); const size = a.i(), p = a.p();
      const rec = c.textures[c.bound[c.unit]];
      if (!rec) return;
      if (fmt !== ETC1) { once(c, `glCompressedTexImage2D format 0x${fmt.toString(16)}`); c.err = 0x500; return; }
      const g = c.gl;
      g.bindTexture(g.TEXTURE_2D, rec.tex);
      g.pixelStorei(g.UNPACK_ALIGNMENT, 4);
      g.texImage2D(target, level, g.RGBA, w, h, 0, g.RGBA, g.UNSIGNED_BYTE, decodeEtc1(mem.u8.subarray(p, p + size), w, h));
      rec.hasAlpha = false;
    }),
    glCompressedTexSubImage2D: W("glCompressedTexSubImage2D", (c) => once(c, "glCompressedTexSubImage2D")),
    glCopyTexImage2D: W("glCopyTexImage2D", (c, a) => { const t = a.i(), l = a.i(), f = a.i(), x = a.i(), y = a.i(), w = a.i(), h = a.i(); c.gl.copyTexImage2D(t, l, f, x, y, w, h, 0); }),
    glCopyTexSubImage2D: W("glCopyTexSubImage2D", (c, a) => { c.gl.copyTexSubImage2D(a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i()); }),
    glTexParameteri: texParam, glTexParameterx: texParam, glTexParameterf: texParamF,
    glTexParameteriv: texParamV, glTexParameterxv: texParamV, glTexParameterfv: W("glTexParameterfv", (c, a) => { const target = a.i(), pname = a.i(), v = mem.ldf32(a.p()) | 0; const rec = c.textures[c.bound[c.unit]]; if (pname === 0x8191) { if (rec) rec.genMip = v !== 0; return; } if (rec) c.gl.bindTexture(target, rec.tex); c.gl.texParameteri(target, pname, v); }),
    glTexEnvi: W("glTexEnvi", (c, a) => { a.i(); const pn = a.i(), v = a.i(); if (pn === 0x2200) c.texEnv[c.unit] = v; }),
    glTexEnvx: W("glTexEnvx", (c, a) => { a.i(); const pn = a.i(), v = a.i(); if (pn === 0x2200) c.texEnv[c.unit] = v; }),
    glTexEnvf: W("glTexEnvf", (c, a) => { a.i(); const pn = a.i(), v = F(a); if (pn === 0x2200) c.texEnv[c.unit] = v | 0; }),
    glTexEnviv: W("glTexEnviv", (c, a) => { a.i(); const pn = a.i(), p = a.p(); if (pn === 0x2200) c.texEnv[c.unit] = mem.ld32(p); }),
    glTexEnvxv: W("glTexEnvxv", (c, a) => { a.i(); const pn = a.i(), p = a.p(); if (pn === 0x2200) c.texEnv[c.unit] = mem.ld32(p); }),
    glTexEnvfv: W("glTexEnvfv", (c, a) => { a.i(); const pn = a.i(), p = a.p(); if (pn === 0x2200) c.texEnv[c.unit] = mem.ldf32(p) | 0; }),
    glPixelStorei: W("glPixelStorei", (c, a) => { const pn = a.i(), v = a.i(); if (pn === 0x0cf5) c.unpackAlign = v; else c.gl.pixelStorei(pn, v); }),
    glGenerateMipmapOES: W("glGenerateMipmapOES", (c, a) => c.gl.generateMipmap(a.i())),
    glGenBuffers: W("glGenBuffers", (c, a) => { const n = a.i(), out = a.p(); for (let i = 0; i < n; i++) { c.buffers.push(c.gl.createBuffer()); mem.st32(out + i * 4, c.buffers.length - 1); } }),
    glDeleteBuffers: W("glDeleteBuffers", (c, a) => { const n = a.i(), p = a.p(); for (let i = 0; i < n; i++) { const id = mem.ld32(p + i * 4); const b = c.buffers[id]; if (b) { c.gl.deleteBuffer(b); c.buffers[id] = null; } if (c.arrayBuf === id) c.arrayBuf = 0; if (c.elemBuf === id) c.elemBuf = 0; } }),
    glBindBuffer: W("glBindBuffer", (c, a) => { const t = a.i(), id = a.i(); if (id && !c.buffers[id]) { while (c.buffers.length <= id) c.buffers.push(null); c.buffers[id] = c.gl.createBuffer(); } if (t === 0x8892) c.arrayBuf = id; else c.elemBuf = id; c.gl.bindBuffer(t, id ? c.buffers[id] : null); }),
    glBufferData: W("glBufferData", (c, a) => { const t = a.i(), n = a.i(), p = a.p(), usage = a.i(); const id = t === 0x8892 ? c.arrayBuf : c.elemBuf; c.gl.bindBuffer(t, c.buffers[id]!); if (p) c.gl.bufferData(t, mem.u8.subarray(p, p + n), usage); else c.gl.bufferData(t, n, usage); }),
    glBufferSubData: W("glBufferSubData", (c, a) => { const t = a.i(), off = a.i(), n = a.i(), p = a.p(); const id = t === 0x8892 ? c.arrayBuf : c.elemBuf; c.gl.bindBuffer(t, c.buffers[id]!); c.gl.bufferSubData(t, off, mem.u8.subarray(p, p + n)); }),
    glIsBuffer: W("glIsBuffer", (c, a) => (c.buffers[a.i()] ? 1 : 0)),
    glEnable: W("glEnable", (c, a) => capSet(c, a.i(), true)),
    glDisable: W("glDisable", (c, a) => capSet(c, a.i(), false)),
    glIsEnabled: W("glIsEnabled", (c, a) => isOn(c, a.i())),
    glBlendFunc: W("glBlendFunc", (c, a) => c.gl.blendFunc(a.i(), a.i())),
    glBlendFuncSeparate: W("glBlendFuncSeparate", (c, a) => c.gl.blendFuncSeparate(a.i(), a.i(), a.i(), a.i())),
    glBlendFuncSeparateOES: W("glBlendFuncSeparateOES", (c, a) => c.gl.blendFuncSeparate(a.i(), a.i(), a.i(), a.i())),
    glBlendEquation: W("glBlendEquation", (c, a) => c.gl.blendEquation(a.i())),
    glBlendEquationOES: W("glBlendEquationOES", (c, a) => c.gl.blendEquation(a.i())),
    glBlendEquationSeparate: W("glBlendEquationSeparate", (c, a) => c.gl.blendEquationSeparate(a.i(), a.i())),
    glBlendEquationSeparateOES: W("glBlendEquationSeparateOES", (c, a) => c.gl.blendEquationSeparate(a.i(), a.i())),
    glBlendColor: W("glBlendColor", (c, a) => c.gl.blendColor(F(a), F(a), F(a), F(a))),
    glAlphaFunc: W("glAlphaFunc", (c, a) => { c.alphaFunc = a.i(); c.alphaRef = F(a); }),
    glAlphaFuncx: W("glAlphaFuncx", (c, a) => { c.alphaFunc = a.i(); c.alphaRef = Xa(a); }),
    glDepthFunc: W("glDepthFunc", (c, a) => c.gl.depthFunc(a.i())),
    glDepthMask: W("glDepthMask", (c, a) => c.gl.depthMask(!!(a.i() & 255))),
    glDepthRangef: W("glDepthRangef", (c, a) => c.gl.depthRange(F(a), F(a))),
    glDepthRangex: W("glDepthRangex", (c, a) => c.gl.depthRange(Xa(a), Xa(a))),
    glClearColor: W("glClearColor", (c, a) => c.gl.clearColor(F(a), F(a), F(a), F(a))),
    glClearColorx: W("glClearColorx", (c, a) => c.gl.clearColor(Xa(a), Xa(a), Xa(a), Xa(a))),
    glClearDepthf: W("glClearDepthf", (c, a) => c.gl.clearDepth(F(a))),
    glClearDepthx: W("glClearDepthx", (c, a) => c.gl.clearDepth(Xa(a))),
    glClearStencil: W("glClearStencil", (c, a) => c.gl.clearStencil(a.i())),
    glClear: W("glClear", (c, a) => c.gl.clear(a.i())),
    glColorMask: W("glColorMask", (c, a) => c.gl.colorMask(!!(a.i() & 255), !!(a.i() & 255), !!(a.i() & 255), !!(a.i() & 255))),
    glCullFace: W("glCullFace", (c, a) => c.gl.cullFace(a.i())),
    glFrontFace: W("glFrontFace", (c, a) => c.gl.frontFace(a.i())),
    glScissor: W("glScissor", (c, a) => c.gl.scissor(a.i(), a.i(), a.i(), a.i())),
    glViewport: W("glViewport", (c, a) => c.gl.viewport(a.i(), a.i(), a.i(), a.i())),
    glPolygonOffset: W("glPolygonOffset", (c, a) => c.gl.polygonOffset(F(a), F(a))),
    glPolygonOffsetx: W("glPolygonOffsetx", (c, a) => c.gl.polygonOffset(Xa(a), Xa(a))),
    glStencilFunc: W("glStencilFunc", (c, a) => c.gl.stencilFunc(a.i(), a.i(), a.i())),
    glStencilMask: W("glStencilMask", (c, a) => c.gl.stencilMask(a.i())),
    glStencilOp: W("glStencilOp", (c, a) => c.gl.stencilOp(a.i(), a.i(), a.i())),
    glSampleCoverage: W("glSampleCoverage", (c, a) => c.gl.sampleCoverage(F(a), !!(a.i() & 255))),
    glSampleCoveragex: W("glSampleCoveragex", (c, a) => c.gl.sampleCoverage(Xa(a), !!(a.i() & 255))),
    glHint: W("glHint", () => {}), glShadeModel: W("glShadeModel", () => {}),
    glFinish: W("glFinish", (c) => c.gl.finish()), glFlush: W("glFlush", (c) => c.gl.flush()),
    // lighting / fog / clip planes: recorded, reported once if a draw depends on them
    glLightf: W("glLightf", () => {}), glLightx: W("glLightx", () => {}), glLightfv: W("glLightfv", () => {}), glLightxv: W("glLightxv", () => {}),
    glLightModelf: W("glLightModelf", () => {}), glLightModelx: W("glLightModelx", () => {}), glLightModelfv: W("glLightModelfv", () => {}), glLightModelxv: W("glLightModelxv", () => {}),
    glMaterialf: W("glMaterialf", () => {}), glMaterialx: W("glMaterialx", () => {}), glMaterialfv: W("glMaterialfv", () => {}), glMaterialxv: W("glMaterialxv", () => {}),
    glFogf: W("glFogf", () => {}), glFogx: W("glFogx", () => {}), glFogfv: W("glFogfv", () => {}), glFogxv: W("glFogxv", () => {}),
    glClipPlanef: W("glClipPlanef", (c) => once(c, "glClipPlanef")), glClipPlanex: W("glClipPlanex", (c) => once(c, "glClipPlanex")),
    glPointParameterf: W("glPointParameterf", () => {}), glPointParameterx: W("glPointParameterx", () => {}), glPointParameterfv: W("glPointParameterfv", () => {}), glPointParameterxv: W("glPointParameterxv", () => {}),
    glGetError: W("glGetError", (c) => { const e = c.err || c.gl.getError(); c.err = 0; return e; }),
    glGetString: W("glGetString", (c, a) => {
      const n = a.i();
      switch (n) {
        case 0x1f00: return cstr("webdroid");
        case 0x1f01: return cstr(String(c.gl.getParameter(c.gl.RENDERER) ?? "WebGL"));
        case 0x1f02: return cstr("OpenGL ES-CM 1.1");
        case 0x1f03: return cstr(EXTENSIONS);
        default: c.err = 0x500; return 0;
      }
    }),
    glGetIntegerv: getInto("i"), glGetFloatv: getInto("f"), glGetFixedv: getInto("x"), glGetBooleanv: getInto("b"),
    glGetPointerv: W("glGetPointerv", (c, a) => { const pn = a.i(), out = a.p(); const s = pn === 0x808e ? c.vert : pn === 0x8090 ? c.col : pn === 0x8092 ? c.tex[c.clientUnit] : c.norm; mem.st32(out, s.ptr); }),
    glGetTexEnviv: W("glGetTexEnviv", (c, a) => { a.i(); const pn = a.i(), out = a.p(); mem.st32(out, pn === 0x2200 ? c.texEnv[c.unit] : 0); }),
    glGetTexParameteriv: W("glGetTexParameteriv", (c, a) => { const t = a.i(), pn = a.i(), out = a.p(); mem.st32(out, Number(c.gl.getTexParameter(t, pn)) | 0); }),
    glGetBufferParameteriv: W("glGetBufferParameteriv", (c, a) => { const t = a.i(), pn = a.i(), out = a.p(); mem.st32(out, Number(c.gl.getBufferParameter(t, pn)) | 0); }),
    glReadPixels: W("glReadPixels", (c, a) => {
      const x = a.i(), y = a.i(), w = a.i(), h = a.i(), fmt = a.i(), type = a.i(), p = a.p();
      const bpp = fmt === 0x1908 ? 4 : fmt === 0x1907 ? 3 : 1;
      const n = w * h * (type === 0x1401 ? bpp : 2);
      const view = type === 0x1401 ? mem.u8.subarray(p, p + n) : new Uint16Array(mem.buf, p, n >> 1);
      c.gl.readPixels(x, y, w, h, fmt, type, view);
    }),
  };
  gles1Procs = G;
  hostLib("libGLESv1_CM.so", G, { closed: true });
}
