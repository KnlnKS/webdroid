// OpenGL ES 3.0 over WebGL2, registered as libGLESv2.so and libGLESv3.so. Closed: a name outside
// ES 3.0 core (KHR_debug, the ES 3.1 entry points) is NULL from dlsym and eglGetProcAddress, so
// an engine feature-gates as on a device. Handles are gl.ts's per-context tables, shared with the
// Java GLES20 bindings. Pointer arguments are guest memory, or offsets while a pixel or element
// buffer is bound, as in GL.

import { mem } from "./mem";
import { hostLib, cstr, PTR, ldp, stp, calledMissing, type HostFn, type ArgReader } from "./host";
import { gl as current, tables as T, put } from "../android/gl";
import { yieldToLoop } from "./cpu";
import { perf } from "../perf";
import { rewriteTextureSwizzles, visibleUniforms, type SwizzleRewrite, type VisibleUniforms } from "./swizzle";
const dec = new TextDecoder();
export let gles3Procs: Record<string, HostFn> = {};
export const glProbe = !!(globalThis as { __wdGlProbe?: boolean }).__wdGlProbe;

type GL = WebGL2RenderingContext;
const g = (): GL => { if (!current) throw new Error("GL call without a current context"); return current as GL; };
let err = 0;                                  // an error we raised ourselves; glGetError reports it before WebGL's
let unpackPbo = false, packPbo = false;
const mapped = new WeakMap<object, { ptr: number; off: number; len: number; access: number }>();   // a mapping belongs to the buffer, not the target

const TEXTURE0 = 0x84c0, ACTIVE_TEXTURE = 0x84e0, CURRENT_PROGRAM = 0x8b8d;
const IDENTITY_SWIZZLE = 0x688;
const shaderRecs = new WeakMap<WebGLShader, { original: string; rewrite: SwizzleRewrite }>();
interface TexRec { channels: [number, number, number, number]; code: number; deleted: boolean }
const texRecs = new WeakMap<WebGLTexture, TexRec>();
interface SamplerBinding { locations: WebGLUniformLocation[]; target: number; units: Int32Array }
interface ProgramMap { binding: SamplerBinding; location: WebGLUniformLocation; pending: Int32Array; uploaded: Int32Array }
interface ProgramRec {
  hidden: ReadonlySet<string>;
  uniforms: VisibleUniforms;
  bindings: SamplerBinding[];
  maps: ProgramMap[];
  unitsDirty: boolean;
  bindingRevision: number;
}
const programRecs = new WeakMap<WebGLProgram, ProgramRec>();
interface ContextState {
  activeUnit: number;
  bindings: Map<number, Map<number, WebGLTexture | null>>;
  revision: number;
  program: WebGLProgram | null;
}
const contextStates = new WeakMap<GL, ContextState>();

function contextState(): ContextState {
  const gl = g();
  let state = contextStates.get(gl);
  if (!state) {
    const active = gl.getParameter(ACTIVE_TEXTURE) as number;
    state = { activeUnit: Math.max(0, active - TEXTURE0), bindings: new Map(), revision: 0, program: null };
    contextStates.set(gl, state);
  }
  return state;
}

function textureRec(texture: WebGLTexture): TexRec {
  let rec = texRecs.get(texture);
  if (!rec) { rec = { channels: [0, 1, 2, 3], code: IDENTITY_SWIZZLE, deleted: false }; texRecs.set(texture, rec); }
  return rec;
}

const bindingName = (target: number): number => target === 0x0de1 ? 0x8069 : target === 0x8513 ? 0x8514 : target === 0x806f ? 0x806a : target === 0x8c1a ? 0x8c1d : 0;
function boundTexture(state: ContextState, unit: number, target: number): WebGLTexture | null {
  let unitBindings = state.bindings.get(unit);
  if (unitBindings?.has(target)) return unitBindings.get(target) ?? null;
  const pname = bindingName(target);
  if (!pname) return null;
  const gl = g(), previous = gl.getParameter(ACTIVE_TEXTURE) as number;
  gl.activeTexture(TEXTURE0 + unit);
  const texture = gl.getParameter(pname) as WebGLTexture | null;
  gl.activeTexture(previous);
  state.activeUnit = Math.max(0, previous - TEXTURE0);
  if (!unitBindings) { unitBindings = new Map(); state.bindings.set(unit, unitBindings); }
  unitBindings.set(target, texture);
  return texture;
}

function samplerTarget(type: number): number {
  switch (type) {
    case 0x8b5e: case 0x8dca: case 0x8dd2: return 0x0de1;                       // sampler2D
    case 0x8b60: case 0x8dcc: case 0x8dd4: return 0x8513;                       // samplerCube
    case 0x8b5f: case 0x8dcb: case 0x8dd3: return 0x806f;                       // sampler3D
    case 0x8dc1: case 0x8dcf: case 0x8dd7: return 0x8c1a;                       // sampler2DArray
    default: return 0;
  }
}

function linkProgram(program: WebGLProgram): void {
  const gl = g();
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { programRecs.delete(program); return; }
  const rewrites = (gl.getAttachedShaders(program) ?? []).map((shader) => shaderRecs.get(shader)?.rewrite).filter((r): r is SwizzleRewrite => !!r);
  const hidden = new Set(rewrites.flatMap((rewrite) => [...rewrite.hidden]));
  if (!hidden.size) { programRecs.delete(program); return; }
  const uniforms = visibleUniforms(gl, program, hidden);
  const infoByName = new Map(uniforms.infos.map((info) => [info.name.endsWith("[0]") ? info.name.slice(0, -3) : info.name, info]));
  const bindingsByName = new Map<string, SamplerBinding>();
  const bindings: SamplerBinding[] = [], maps: ProgramMap[] = [];
  const rawCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  const rawInfo = new Map<string, WebGLActiveInfo>();
  for (let i = 0; i < rawCount; i++) {
    const info = gl.getActiveUniform(program, i);
    if (info) rawInfo.set(info.name.endsWith("[0]") ? info.name.slice(0, -3) : info.name, info);
  }
  for (const map of rewrites.flatMap((rewrite) => rewrite.maps)) {
    const info = infoByName.get(map.sampler), hiddenInfo = rawInfo.get(map.mapUniform);
    const target = info && samplerTarget(info.type);
    const mapLocation = gl.getUniformLocation(program, map.mapUniform);
    if (!info || !hiddenInfo || !target || !mapLocation) continue;
    let binding = bindingsByName.get(map.sampler);
    if (!binding) {
      const size = Math.min(map.size, info.size);
      const locations = Array.from({ length: size }, (_, i) => gl.getUniformLocation(program, size > 1 ? `${map.sampler}[${i}]` : map.sampler)).filter((location): location is WebGLUniformLocation => !!location);
      if (locations.length !== size) continue;
      binding = { locations, target, units: new Int32Array(size) };
      bindingsByName.set(map.sampler, binding);
      bindings.push(binding);
    }
    const size = Math.min(binding.units.length, hiddenInfo.size);
    maps.push({ binding, location: mapLocation, pending: new Int32Array(size), uploaded: new Int32Array(size).fill(-1) });
  }
  programRecs.set(program, { hidden, uniforms, bindings, maps, unitsDirty: false, bindingRevision: -1 });
}

function prepareDraw(): void {
  const gl = g(), state = contextState();
  if (!state.program) state.program = gl.getParameter(CURRENT_PROGRAM) as WebGLProgram | null;
  const rec = state.program && programRecs.get(state.program);
  if (!rec || (!rec.unitsDirty && rec.bindingRevision === state.revision)) return;
  if (rec.unitsDirty) {
    for (const binding of rec.bindings) {
      for (let i = 0; i < binding.locations.length; i++) binding.units[i] = gl.getUniform(state.program!, binding.locations[i]) as number;
    }
    rec.unitsDirty = false;
  }
  for (const map of rec.maps) {
    let changed = false;
    for (let i = 0; i < map.pending.length; i++) {
      const texture = boundTexture(state, map.binding.units[i], map.binding.target);
      const textureState = texture && texRecs.get(texture);
      map.pending[i] = textureState && !textureState.deleted ? textureState.code : IDENTITY_SWIZZLE;
      if (map.pending[i] !== map.uploaded[i]) changed = true;
    }
    if (changed) { gl.uniform1iv(map.location, map.pending); map.uploaded.set(map.pending); }
  }
  rec.bindingRevision = state.revision;
}

function markSamplerUnitsDirty(): void {
  const state = contextState();
  if (!state.program) state.program = g().getParameter(CURRENT_PROGRAM) as WebGLProgram | null;
  const rec = state.program && programRecs.get(state.program);
  if (rec) rec.unitsDirty = true;
}

// ── guest memory views (a misaligned pointer is copied, which GL data rarely is)
type Ctor<A> = { new (b: ArrayBuffer, off: number, n: number): A; new (b: ArrayBuffer): A; BYTES_PER_ELEMENT: number };
function view<A extends ArrayBufferView>(K: Ctor<A>, p: number, n: number): A {
  const bpe = K.BYTES_PER_ELEMENT;
  return p % bpe ? new K(mem.u8.slice(p, p + n * bpe).buffer) : new K(mem.buf, p, n);
}
const i32 = (p: number, n: number) => view(Int32Array, p, n);
const u32 = (p: number, n: number) => view(Uint32Array, p, n);
const f32 = (p: number, n: number) => view(Float32Array, p, n);
const u8 = (p: number, n: number) => mem.u8.subarray(p, p + n);
/** the typed view GL's pixel `type` implies, from p to the end of guest memory: WebGL reads what
 *  the size, format and unpack state need and only checks that the view is at least that long */
function pixels(type: number, p: number): ArrayBufferView {
  const K: Ctor<ArrayBufferView> = type === 0x1406 ? Float32Array : type === 0x1404 ? Int32Array : type === 0x1402 ? Int16Array : type === 0x1400 ? Int8Array
    : type === 0x1401 ? Uint8Array : (type === 0x1403 || type === 0x140b || type === 0x8d61 || type === 0x8033 || type === 0x8034 || type === 0x8363) ? Uint16Array : Uint32Array;
  const n = Math.floor((mem.u8.length - p) / K.BYTES_PER_ELEMENT);
  return p % K.BYTES_PER_ELEMENT ? new K(mem.u8.slice(p, p + Math.min(n, 1 << 26) * K.BYTES_PER_ELEMENT).buffer) : new K(mem.buf, p, n);
}
const texData = (type: number, p: number): unknown => (unpackPbo ? p : p ? pixels(type, p) : null);
/** GL's (bufsize, *length, char *buf) out-string */
function outStr(s: string, bufsize: number, lenp: number, buf: number): void {
  const n = Math.max(0, Math.min(s.length, bufsize - 1));
  if (buf && bufsize > 0) { for (let i = 0; i < n; i++) mem.st8(buf + i, s.charCodeAt(i)); mem.st8(buf + n, 0); }
  if (lenp) mem.st32(lenp, n);
}
/** a getParameter-style answer into guest memory: numbers, booleans, arrays, or a GL object (its handle) */
function out(v: unknown, p: number, st: (a: number, v: number) => void, bpe: number): void {
  if (typeof v === "number") st(p, v);
  else if (typeof v === "boolean") st(p, v ? 1 : 0);
  else if (v && typeof v === "object" && "length" in v) { const arr = v as ArrayLike<number>; for (let i = 0; i < arr.length; i++) st(p + i * bpe, arr[i]); }
  else if (v && typeof v === "object") st(p, T().ids.get(v) ?? 0);
  else st(p, 0);
}
const st32 = (a: number, v: number) => mem.st32(a, v), stf = (a: number, v: number) => mem.stf32(a, v), st8 = (a: number, v: number) => mem.st8(a, v);
const st64 = (a: number, v: number) => mem.st64(a, BigInt(Math.trunc(v)));
const H = <O extends object>(tbl: (O | null)[], h: number): O | null => (h ? tbl[h] ?? null : null);
const U = (h: number) => (h < 0 ? null : T().uniforms[h] ?? null);
function gen(tbl: (object | null)[], n: number, p: number, make: () => object | null): void { for (let i = 0; i < n; i++) mem.st32(p + 4 * i, put(tbl, make())); }
function del(tbl: (object | null)[], n: number, p: number, kill: (o: never) => void): void {
  for (let i = 0; i < n; i++) { const h = mem.ld32(p + 4 * i), o = tbl[h]; if (o) { kill(o as never); tbl[h] = null; } }
}

// ── buffer records: kind (element or not) decided at the first typed bind, data shadowed until then
interface BufRec { gl: WebGLBuffer | null; other: WebGLBuffer | null; elem: boolean | null; shadow: Uint8Array | null; usage: number }
const COPY_READ = 0x8f36, COPY_WRITE = 0x8f37, ELEM = 0x8893, ARRAY = 0x8892;
const recOf = new WeakMap<object, BufRec>();
const bound = new Map<number, number>();                         // target → the guest handle last bound there
const rec = (h: number): BufRec | null => { const o = H(T().buffers, h); return o ? recOf.get(o) ?? null : null; };
const recAt = (t: number): BufRec | null => t === ELEM ? recOf.get(g().getParameter(0x8895)) ?? null : rec(bound.get(t) ?? 0);
/** the record behind a data target while its kind is undecided: writes land in the shadow */
const shadowed = (t: number): BufRec | null => { if (t !== COPY_READ && t !== COPY_WRITE) return null; const r = recAt(t); return r && r.elem === null ? r : null; };
/** run an operation on a data target: a copy target stands in for the buffer's own kind, binding restored */
function withTarget<R>(t: number, fn: (tt: number) => R): R {
  if (t !== COPY_READ && t !== COPY_WRITE) return fn(t);
  const gl = g();
  const r = recAt(t), tt = r?.elem ? ELEM : ARRAY;
  const prev = gl.getParameter(tt === ELEM ? 0x8895 : 0x8894) as WebGLBuffer | null;
  gl.bindBuffer(tt, r?.gl ?? null);
  try { return fn(tt); } finally { gl.bindBuffer(tt, prev); }
}
function writeBuffers(t: number, fn: (target: number) => void): void {
  withTarget(t, fn);
  const r = recAt(t);
  if (!r?.other) return;
  const gl = g();
  const elem = t === COPY_READ || t === COPY_WRITE ? r.elem : t === ELEM;
  const target = elem ? ARRAY : ELEM, buffer = elem === r.elem ? r.other : r.gl;
  const prev = gl.getParameter(target === ELEM ? 0x8895 : 0x8894);
  gl.bindBuffer(target, buffer);
  try { fn(target); } finally { gl.bindBuffer(target, prev); }
}
const writeBack = (t: number, off: number, data: Uint8Array): void => { const r = shadowed(t); if (r) r.shadow!.set(data, off); else writeBuffers(t, (tt) => g().bufferSubData(tt, off, data)); };
function realize(t: number, h: number): WebGLBuffer | null {
  const r = rec(h);
  if (!r) return null;
  const gl = g();
  if (r.elem === null) {
    r.elem = t === ELEM; r.gl = gl.createBuffer();
    if (r.gl) { recOf.set(r.gl, r); T().ids.set(r.gl, h); }
    gl.bindBuffer(t, r.gl);
    if (r.shadow) { gl.bufferData(t, r.shadow, r.usage); r.shadow = null; }
  }
  if (r.elem === (t === ELEM)) return r.gl;
  if (!r.other) {
    // WebGL forbids sharing index and vertex storage, so copy only on the first mixed bind.
    const target = r.elem ? ELEM : ARRAY, prev = gl.getParameter(r.elem ? 0x8895 : 0x8894);
    gl.bindBuffer(target, r.gl);
    const data = new Uint8Array(gl.getBufferParameter(target, 0x8764));
    gl.getBufferSubData(target, 0, data);
    gl.bindBuffer(target, prev);
    r.other = gl.createBuffer();
    if (r.other) { recOf.set(r.other, r); T().ids.set(r.other, h); }
    gl.bindBuffer(t, r.other); gl.bufferData(t, data, r.usage);
  }
  return r.other;
}

function syncVertexBuffer(buffer: WebGLBuffer | null): void {
  const r = buffer && recOf.get(buffer);
  if (!r?.other) return;
  const gl = g();
  const vertex = gl.getParameter(0x8894), element = gl.getParameter(0x8895);
  gl.bindBuffer(ARRAY, buffer);
  const data = new Uint8Array(gl.getBufferParameter(ARRAY, 0x8764));
  gl.getBufferSubData(ARRAY, 0, data);
  gl.bindBuffer(ELEM, r.elem ? r.gl : r.other);
  gl.bufferSubData(ELEM, 0, data);
  gl.bindBuffer(ARRAY, vertex); gl.bindBuffer(ELEM, element);
}

function syncFeedback(): void {
  const n = g().getParameter(0x8c8b);
  for (let i = 0; i < n; i++) syncVertexBuffer(g().getIndexedParameter(0x8c8f, i));
}

// ── what this context can do: a WebGL extension is advertised under its ES name only when
// getExtension answers, which is also what turns its formats on
const EXT: [string, string][] = [
  ["WEBGL_compressed_texture_etc1", "GL_OES_compressed_ETC1_RGB8_texture"], ["WEBGL_compressed_texture_etc", ""],
  ["WEBGL_compressed_texture_astc", "GL_KHR_texture_compression_astc_ldr"], ["WEBGL_compressed_texture_s3tc", "GL_EXT_texture_compression_s3tc"],
  ["WEBGL_compressed_texture_s3tc_srgb", "GL_EXT_texture_compression_s3tc_srgb"], ["WEBGL_compressed_texture_pvrtc", "GL_IMG_texture_compression_pvrtc"],
  ["EXT_texture_compression_rgtc", "GL_EXT_texture_compression_rgtc"], ["EXT_color_buffer_float", "GL_EXT_color_buffer_float"],
  ["EXT_color_buffer_half_float", "GL_EXT_color_buffer_half_float"], ["OES_texture_float_linear", "GL_OES_texture_float_linear"],
  ["EXT_texture_filter_anisotropic", "GL_EXT_texture_filter_anisotropic"], ["EXT_texture_norm16", "GL_EXT_texture_norm16"], ["EXT_float_blend", "GL_EXT_float_blend"],
];
// ES2 extensions that ES 3.0 core subsumes without a new entry point; an engine gating on the name sees them
const CORE = "GL_OES_element_index_uint GL_OES_depth24 GL_OES_packed_depth_stencil GL_OES_standard_derivatives GL_OES_texture_float GL_OES_texture_half_float GL_OES_texture_half_float_linear GL_OES_rgb8_rgba8 GL_OES_depth_texture GL_OES_texture_npot GL_OES_fbo_render_mipmap GL_EXT_texture_rg GL_EXT_sRGB GL_EXT_blend_minmax";
const extsOf = new WeakMap<GL, string[]>();
export function gles3Extensions(gl: GL): string[] {
  let e = extsOf.get(gl);
  if (!e) { e = CORE.split(" "); for (const [w, n] of EXT) if (gl.getExtension(w) && n) e.push(n); extsOf.set(gl, e); }
  return e;
}
function str(name: number): string {
  switch (name) {
    case 0x1f00: return "webdroid";
    case 0x1f01: return (g().getExtension("WEBGL_debug_renderer_info") && (g().getParameter(0x9246) as string)) || "WebGL2";
    case 0x1f02: return "OpenGL ES 3.0 webdroid";
    case 0x8b8c: return "OpenGL ES GLSL ES 3.00";
    case 0x1f03: return gles3Extensions(g()).join(" ");
    default: return "";
  }
}
function param(pname: number): unknown {
  switch (pname) {
    case 0x821b: return 3; case 0x821c: return 0;                                   // MAJOR/MINOR_VERSION
    case 0x821d: return gles3Extensions(g()).length;                               // NUM_EXTENSIONS
    case 0x87fe: case 0x8df9: return 0;                                             // NUM_PROGRAM/SHADER_BINARY_FORMATS
    case 0x86a2: return (g().getParameter(0x86a3) as Uint32Array).length;           // NUM_COMPRESSED_TEXTURE_FORMATS
    default: return g().getParameter(pname);
  }
}
const maxName = (p: WebGLProgram, n: number, q: (p: WebGLProgram, i: number) => { name: string } | null) => {
  let m = 0; for (let i = 0; i < n; i++) m = Math.max(m, (q(p, i)?.name.length ?? 0) + 1); return m;
};
function progParam(p: WebGLProgram, pname: number): unknown {
  const gl = g();
  const rec = programRecs.get(p);
  switch (pname) {
    case 0x8b84: return (gl.getProgramInfoLog(p)?.length ?? 0) + 1;                // INFO_LOG_LENGTH
    case 0x8b86: return rec?.uniforms.infos.length ?? gl.getProgramParameter(p, pname); // ACTIVE_UNIFORMS
    case 0x8b87: return rec ? Math.max(0, ...rec.uniforms.infos.map((info) => info.name.length + 1))
      : maxName(p, gl.getProgramParameter(p, 0x8b86), (q, i) => gl.getActiveUniform(q, i)); // ACTIVE_UNIFORM_MAX_LENGTH
    case 0x8b8a: return maxName(p, gl.getProgramParameter(p, 0x8b89), (q, i) => gl.getActiveAttrib(q, i));       // ACTIVE_ATTRIBUTE_MAX_LENGTH
    case 0x8a35: return maxName(p, gl.getProgramParameter(p, 0x8a36), (q, i) => ({ name: gl.getActiveUniformBlockName(q, i) ?? "" })); // ACTIVE_UNIFORM_BLOCK_MAX_NAME_LENGTH
    case 0x8c76: return maxName(p, gl.getProgramParameter(p, 0x8c83), (q, i) => gl.getTransformFeedbackVarying(q, i)); // TRANSFORM_FEEDBACK_VARYING_MAX_LENGTH
    case 0x8741: return 0;                                                         // PROGRAM_BINARY_LENGTH
    default: return gl.getProgramParameter(p, pname);
  }
}
function shaderParam(s: WebGLShader, pname: number): unknown {
  const gl = g();
  if (pname === 0x8b84) return (gl.getShaderInfoLog(s)?.length ?? 0) + 1;
  if (pname === 0x8b88) return (shaderRecs.get(s)?.original.length ?? gl.getShaderSource(s)?.length ?? 0) + 1; // SHADER_SOURCE_LENGTH
  return gl.getShaderParameter(s, pname);
}
/** glGetActive{Attrib,Uniform,TransformFeedbackVarying}: (prog, index, bufsize, *length, *size, *type, *name) */
const active = (q: (p: WebGLProgram, i: number) => WebGLActiveInfo | null): HostFn => (_c, a) => {
  const p = H(T().programs, a.i()); const i = a.i(), bufsize = a.i(), lenp = a.p(), sizep = a.p(), typep = a.p(), name = a.p();
  const info = p && q(p, i);
  if (!info) return;
  if (sizep) mem.st32(sizep, info.size);
  if (typep) mem.st32(typep, info.type);
  outStr(info.name, bufsize, lenp, name);
};
const names = (pp: number, n: number): string[] => { const r: string[] = []; for (let i = 0; i < n; i++) r.push(mem.cstr(ldp(pp + i * PTR))); return r; };

/** the state entry points ES 1.1 and ES 3.0 share */
export const glCommon: Record<string, HostFn> = {
  glViewport: (_c, a) => g().viewport(a.i(), a.i(), a.i(), a.i()), glScissor: (_c, a) => g().scissor(a.i(), a.i(), a.i(), a.i()),
  glClear: (_c, a) => g().clear(a.i()), glClearColor: (_c, a) => g().clearColor(a.f(), a.f(), a.f(), a.f()),
  glClearDepthf: (_c, a) => g().clearDepth(a.f()), glClearStencil: (_c, a) => g().clearStencil(a.i()),
  glFlush: () => g().flush(), glFinish: () => g().finish(),
  glBlendFunc: (_c, a) => g().blendFunc(a.i(), a.i()), glBlendFuncSeparate: (_c, a) => g().blendFuncSeparate(a.i(), a.i(), a.i(), a.i()),
  glBlendEquation: (_c, a) => g().blendEquation(a.i()), glBlendEquationSeparate: (_c, a) => g().blendEquationSeparate(a.i(), a.i()),
  glBlendColor: (_c, a) => g().blendColor(a.f(), a.f(), a.f(), a.f()),
  glColorMask: (_c, a) => g().colorMask(!!(a.i() & 255), !!(a.i() & 255), !!(a.i() & 255), !!(a.i() & 255)),
  glDepthFunc: (_c, a) => g().depthFunc(a.i()), glDepthMask: (_c, a) => g().depthMask(!!(a.i() & 255)), glDepthRangef: (_c, a) => g().depthRange(a.f(), a.f()),
  glStencilFunc: (_c, a) => g().stencilFunc(a.i(), a.i(), a.i()), glStencilOp: (_c, a) => g().stencilOp(a.i(), a.i(), a.i()), glStencilMask: (_c, a) => g().stencilMask(a.i()),
  glCullFace: (_c, a) => g().cullFace(a.i()), glFrontFace: (_c, a) => g().frontFace(a.i()),
  glPolygonOffset: (_c, a) => g().polygonOffset(a.f(), a.f()), glLineWidth: (_c, a) => g().lineWidth(a.f()),
  glSampleCoverage: (_c, a) => g().sampleCoverage(a.f(), !!(a.i() & 255)),
  glCopyTexImage2D: (_c, a) => g().copyTexImage2D(a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i()),
  glCopyTexSubImage2D: (_c, a) => g().copyTexSubImage2D(a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i()),
};
const draw = (): GL => { perf.glDraws++; prepareDraw(); return g(); };
type Setter = (this: GL, ...v: unknown[]) => void;
const method = (name: string): (() => Setter) => { let m: Setter | undefined; return () => (m ??= (g() as unknown as Record<string, Setter>)[name]); };

export function gles3Init(): void {
  const G: Record<string, HostFn> = {
    ...glCommon,
    // ── strings, state queries, errors
    glGetString: (_c, a) => cstr(str(a.i())),
    glGetStringi: (_c, a) => { const n = a.i(), i = a.i(); return cstr(n === 0x1f03 ? gles3Extensions(g())[i] ?? "" : ""); },
    glGetIntegeri_v: (_c, a) => { const t = a.i(), i = a.i(); out(g().getIndexedParameter(t, i), a.p(), st32, 4); },
    glGetInteger64i_v: (_c, a) => { const t = a.i(), i = a.i(); out(g().getIndexedParameter(t, i), a.p(), st64, 8); },
    glGetInternalformativ: (_c, a) => {
      const t = a.i(), f = a.i(), pn = a.i(), size = a.i(), p = a.p();
      if (size < 0) { err ||= 0x501; return; }
      const values: unknown = g().getInternalformatParameter(t, f, pn === 0x9380 ? 0x80a9 : pn);
      if (!(values instanceof Int32Array) || !size) return;
      if (pn === 0x9380) mem.st32(p, values.length);
      else for (let i = 0; i < Math.min(size, values.length); i++) mem.st32(p + i * 4, values[i]);
    },
    glGetShaderPrecisionFormat: (_c, a) => {
      const f = g().getShaderPrecisionFormat(a.i(), a.i()), range = a.p(), prec = a.p();
      if (f) { mem.st32(range, f.rangeMin); mem.st32(range + 4, f.rangeMax); mem.st32(prec, f.precision); }
    },
    glGetError: () => { const e = err; err = 0; return e || (current ? current.getError() : 0); },
    glIsEnabled: (_c, a) => (g().isEnabled(a.i()) ? 1 : 0),
    glEnable: (_c, a) => g().enable(a.i()), glDisable: (_c, a) => g().disable(a.i()),
    glHint: (_c, a) => g().hint(a.i(), a.i()),
    glClearBufferfv: (_c, a) => { const b = a.i(), d = a.i(); g().clearBufferfv(b, d, f32(a.p(), b === 0x1800 ? 4 : 1)); },
    glClearBufferiv: (_c, a) => { const b = a.i(), d = a.i(); g().clearBufferiv(b, d, i32(a.p(), b === 0x1800 ? 4 : 1)); },
    glClearBufferuiv: (_c, a) => { const b = a.i(), d = a.i(); g().clearBufferuiv(b, d, u32(a.p(), 4)); },
    glClearBufferfi: (_c, a) => g().clearBufferfi(a.i(), a.i(), a.f(), a.i()),
    glStencilFuncSeparate: (_c, a) => g().stencilFuncSeparate(a.i(), a.i(), a.i(), a.i()), glStencilOpSeparate: (_c, a) => g().stencilOpSeparate(a.i(), a.i(), a.i(), a.i()),
    glStencilMaskSeparate: (_c, a) => g().stencilMaskSeparate(a.i(), a.i()),
    glPixelStorei: (_c, a) => g().pixelStorei(a.i(), a.i()),

    // ── shaders and programs
    glCreateShader: (_c, a) => put(T().shaders, g().createShader(a.i())),
    glDeleteShader: (_c, a) => { const h = a.i(), s = T().shaders[h]; if (s) { g().deleteShader(s); T().shaders[h] = null; } },
    glIsShader: (_c, a) => (H(T().shaders, a.i()) ? 1 : 0),
    glShaderSource: (_c, a) => {
      const handle = a.i(), s = H(T().shaders, handle); const n = a.i(), pp = a.p(), lp = a.p();
      let src = "";
      for (let i = 0; i < n; i++) {
        const p = ldp(pp + i * PTR), len = lp ? mem.ld32(lp + 4 * i) : -1;
        src += len < 0 ? mem.cstr(p) : dec.decode(mem.bytes(p, len));
      }
      if (s) {
        const rewrite = rewriteTextureSwizzles(src, handle);
        shaderRecs.set(s, { original: src, rewrite });
        if (rewrite.unsupported.length) calledMissing.add("gles3:texture swizzle shader transform");
        g().shaderSource(s, rewrite.source);
      }
    },
    glCompileShader: (_c, a) => { const s = H(T().shaders, a.i()); if (s) g().compileShader(s); },
    glGetShaderiv: (_c, a) => { const s = H(T().shaders, a.i()), pn = a.i(); out(s ? shaderParam(s, pn) : 0, a.p(), st32, 4); },
    glGetShaderInfoLog: (_c, a) => { const s = H(T().shaders, a.i()); outStr((s && g().getShaderInfoLog(s)) ?? "", a.i(), a.p(), a.p()); },
    glGetShaderSource: (_c, a) => { const s = H(T().shaders, a.i()); outStr((s && (shaderRecs.get(s)?.original ?? g().getShaderSource(s))) ?? "", a.i(), a.p(), a.p()); },
    glReleaseShaderCompiler: () => {},
    glShaderBinary: () => { err = 0x500; },                                       // INVALID_ENUM: no binary formats
    glCreateProgram: () => put(T().programs, g().createProgram()),
    glDeleteProgram: (_c, a) => { const h = a.i(), p = T().programs[h]; if (p) { g().deleteProgram(p); T().programs[h] = null; } },
    glIsProgram: (_c, a) => (H(T().programs, a.i()) ? 1 : 0),
    glAttachShader: (_c, a) => { const p = H(T().programs, a.i()), s = H(T().shaders, a.i()); if (p && s) g().attachShader(p, s); },
    glDetachShader: (_c, a) => { const p = H(T().programs, a.i()), s = H(T().shaders, a.i()); if (p && s) g().detachShader(p, s); },
    glLinkProgram: (_c, a) => { const p = H(T().programs, a.i()); if (p) linkProgram(p); },
    glUseProgram: (_c, a) => { const p = H(T().programs, a.i()); g().useProgram(p); contextState().program = p; },
    glValidateProgram: (_c, a) => { const p = H(T().programs, a.i()); if (p) g().validateProgram(p); },
    glGetProgramiv: (_c, a) => { const p = H(T().programs, a.i()), pn = a.i(); out(p ? progParam(p, pn) : 0, a.p(), st32, 4); },
    glGetProgramInfoLog: (_c, a) => { const p = H(T().programs, a.i()); outStr((p && g().getProgramInfoLog(p)) ?? "", a.i(), a.p(), a.p()); },
    glProgramParameteri: () => {},
    glGetProgramBinary: (_c, a) => { a.i(); a.i(); const lenp = a.p(); if (lenp) mem.st32(lenp, 0); err = 0x502; },  // INVALID_OPERATION
    glProgramBinary: () => { err = 0x500; },
    glGetAttachedShaders: (_c, a) => {
      const p = H(T().programs, a.i()); const max = a.i(), countp = a.p(), outp = a.p();
      const sh = (p && g().getAttachedShaders(p)) ?? [];
      const n = Math.min(max, sh.length);
      for (let i = 0; i < n; i++) mem.st32(outp + 4 * i, T().ids.get(sh[i]) ?? 0);
      if (countp) mem.st32(countp, n);
    },
    glBindAttribLocation: (_c, a) => { const p = H(T().programs, a.i()); const i = a.i(), n = a.str(); if (p) g().bindAttribLocation(p, i, n); },
    glGetAttribLocation: (_c, a) => { const p = H(T().programs, a.i()); return p ? g().getAttribLocation(p, a.str()) : -1; },
    glGetFragDataLocation: (_c, a) => { const p = H(T().programs, a.i()); return p ? g().getFragDataLocation(p, a.str()) : -1; },
    glGetUniformLocation: (_c, a) => {
      const p = H(T().programs, a.i()), name = a.str();
      if (p && programRecs.get(p)?.hidden.has(name.replace(/\[\d+\]$/, ""))) return -1;
      const u = p && g().getUniformLocation(p, name); return u ? put(T().uniforms, u) : -1;
    },
    glGetActiveAttrib: active((p, i) => g().getActiveAttrib(p, i)),
    glGetActiveUniform: active((p, i) => { const rec = programRecs.get(p); return rec ? rec.uniforms.infos[i] ?? null : g().getActiveUniform(p, i); }),
    glGetTransformFeedbackVarying: active((p, i) => g().getTransformFeedbackVarying(p, i)),
    glGetUniformBlockIndex: (_c, a) => { const p = H(T().programs, a.i()); return p ? g().getUniformBlockIndex(p, a.str()) : 0xffffffff; },
    glUniformBlockBinding: (_c, a) => { const p = H(T().programs, a.i()); const i = a.i(), b = a.i(); if (p) g().uniformBlockBinding(p, i, b); },
    glGetActiveUniformBlockiv: (_c, a) => {
      const p = H(T().programs, a.i()); const i = a.i(), pn = a.i(), rec = p && programRecs.get(p);
      let value = p && (pn === 0x8a41 ? (g().getActiveUniformBlockName(p, i)?.length ?? 0) + 1 : g().getActiveUniformBlockParameter(p, i, pn));
      if (pn === 0x8a43 && rec && value && typeof value === "object" && "length" in value) {
        value = Uint32Array.from(value as ArrayLike<number>, (web) => rec.uniforms.webToGuest[web] >= 0 ? rec.uniforms.webToGuest[web] : 0xffffffff);
      }
      out(value, a.p(), st32, 4);
    },
    glGetActiveUniformBlockName: (_c, a) => { const p = H(T().programs, a.i()); const i = a.i(); outStr((p && g().getActiveUniformBlockName(p, i)) ?? "", a.i(), a.p(), a.p()); },
    glGetUniformIndices: (_c, a) => {
      const p = H(T().programs, a.i()); const n = a.i(), pp = a.p(), rec = p && programRecs.get(p);
      let value = p && g().getUniformIndices(p, names(pp, n));
      if (rec && value) value = Array.from(value, (web) => web === 0xffffffff || rec.uniforms.webToGuest[web] < 0 ? 0xffffffff : rec.uniforms.webToGuest[web]);
      out(value, a.p(), st32, 4);
    },
    glGetActiveUniformsiv: (_c, a) => {
      const p = H(T().programs, a.i()); const n = a.i(), ip = a.p(), pn = a.i(), rec = p && programRecs.get(p);
      const indices = Array.from(u32(ip, n), (guest) => rec ? rec.uniforms.guestToWeb[guest] ?? 0xffffffff : guest);
      out(p && g().getActiveUniforms(p, indices, pn), a.p(), st32, 4);
    },
    glTransformFeedbackVaryings: (_c, a) => { const p = H(T().programs, a.i()); const n = a.i(), pp = a.p(), mode = a.i(); if (p) g().transformFeedbackVaryings(p, names(pp, n), mode); },

    // ── buffers
    glGenBuffers: (_c, a) => { const n = a.i(); gen(T().buffers, n, a.p(), () => { const o = {} as WebGLBuffer; recOf.set(o, { gl: null, other: null, elem: null, shadow: null, usage: 0x88e4 }); return o; }); },
    glDeleteBuffers: (_c, a) => { const n = a.i(); del(T().buffers, n, a.p(), (o) => { const r = recOf.get(o); if (r?.gl) g().deleteBuffer(r.gl); if (r?.other) g().deleteBuffer(r.other); }); },
    glIsBuffer: (_c, a) => (H(T().buffers, a.i()) ? 1 : 0),
    glBindBuffer: (_c, a) => {
      const t = a.i(), h = a.i();
      if (t === 0x88ec) unpackPbo = !!h; else if (t === 0x88eb) packPbo = !!h;      // PIXEL_UNPACK/PACK_BUFFER
      bound.set(t, h);
      if (t === COPY_READ || t === COPY_WRITE) return;
      g().bindBuffer(t, realize(t, h));
    },
    glBindBufferBase: (_c, a) => { const t = a.i(), i = a.i(), h = a.i(); bound.set(t, h); g().bindBufferBase(t, i, realize(t, h)); },
    glBindBufferRange: (_c, a) => { const t = a.i(), i = a.i(), h = a.i(); bound.set(t, h); const gl = realize(t, h); g().bindBufferRange(t, i, gl, a.i(), a.i()); },
    glBufferData: (_c, a) => {
      const t = a.i(), n = a.i(), p = a.p(), usage = a.i(), r = shadowed(t);
      if (r) { r.shadow = new Uint8Array(n); if (p) r.shadow.set(u8(p, n)); r.usage = usage; }
      else { const r = recAt(t); if (r) r.usage = usage; writeBuffers(t, (tt) => { if (p) g().bufferData(tt, u8(p, n), usage); else g().bufferData(tt, n, usage); }); }
    },
    glBufferSubData: (_c, a) => { const t = a.i(), off = a.i(), n = a.i(), p = a.p(); writeBack(t, off, u8(p, n)); },
    glCopyBufferSubData: (_c, a) => {
      const rt = a.i(), wt = a.i(), roff = a.i(), woff = a.i(), n = a.i(), rs = shadowed(rt);
      const src = rs ? rs.shadow!.subarray(roff, roff + n) : withTarget(rt, (tt) => { const d = new Uint8Array(n); g().getBufferSubData(tt, roff, d); return d; });
      writeBack(wt, woff, src);
    },
    // a mapping is a guest copy of the range: read in on map, written back on unmap or flush
    glMapBufferRange: (_c, a) => {
      const t = a.i(), off = a.i(), len = a.i(), access = a.i(), b = recAt(t);
      if (!b) { err = 0x502; return 0; }
      const ptr = mem.malloc(len), r = shadowed(t);
      if (access & 1) { if (r) u8(ptr, len).set(r.shadow!.subarray(off, off + len)); else withTarget(t, (tt) => g().getBufferSubData(tt, off, u8(ptr, len))); }
      mapped.set(b, { ptr, off, len, access });
      return ptr;
    },
    glFlushMappedBufferRange: (_c, a) => { const t = a.i(), b = recAt(t), m = b && mapped.get(b), off = a.i(), len = a.i(); if (m) writeBack(t, m.off + off, u8(m.ptr + off, len)); },
    glUnmapBuffer: (_c, a) => {
      const t = a.i(), b = recAt(t), m = b && mapped.get(b);
      if (!b || !m) return 0;
      mapped.delete(b);
      if ((m.access & 2) && !(m.access & 0x10)) writeBack(t, m.off, u8(m.ptr, m.len));   // MAP_WRITE_BIT without MAP_FLUSH_EXPLICIT_BIT
      mem.free(m.ptr);
      return 1;
    },
    glGetBufferPointerv: (_c, a) => { const t = a.i(); a.i(); const b = recAt(t); stp(a.p(), (b && mapped.get(b)?.ptr) || 0); },

    // ── vertex arrays and attributes
    glBindVertexArray: (_c, a) => g().bindVertexArray(H(T().vaos, a.i())),
    glEnableVertexAttribArray: (_c, a) => g().enableVertexAttribArray(a.i()), glDisableVertexAttribArray: (_c, a) => g().disableVertexAttribArray(a.i()),
    glVertexAttribPointer: (_c, a) => g().vertexAttribPointer(a.i(), a.i(), a.i(), !!(a.i() & 255), a.i(), a.p()),
    glVertexAttribIPointer: (_c, a) => g().vertexAttribIPointer(a.i(), a.i(), a.i(), a.i(), a.p()),
    glVertexAttribDivisor: (_c, a) => g().vertexAttribDivisor(a.i(), a.i()),
    glVertexAttrib1f: (_c, a) => g().vertexAttrib1f(a.i(), a.f()), glVertexAttrib2f: (_c, a) => g().vertexAttrib2f(a.i(), a.f(), a.f()),
    glVertexAttrib3f: (_c, a) => g().vertexAttrib3f(a.i(), a.f(), a.f(), a.f()), glVertexAttrib4f: (_c, a) => g().vertexAttrib4f(a.i(), a.f(), a.f(), a.f(), a.f()),
    glVertexAttrib1fv: (_c, a) => g().vertexAttrib1fv(a.i(), f32(a.p(), 1)), glVertexAttrib2fv: (_c, a) => g().vertexAttrib2fv(a.i(), f32(a.p(), 2)),
    glVertexAttrib3fv: (_c, a) => g().vertexAttrib3fv(a.i(), f32(a.p(), 3)), glVertexAttrib4fv: (_c, a) => g().vertexAttrib4fv(a.i(), f32(a.p(), 4)),
    glVertexAttribI4i: (_c, a) => g().vertexAttribI4i(a.i(), a.i(), a.i(), a.i(), a.i()), glVertexAttribI4ui: (_c, a) => g().vertexAttribI4ui(a.i(), a.u(), a.u(), a.u(), a.u()),
    glVertexAttribI4iv: (_c, a) => g().vertexAttribI4iv(a.i(), i32(a.p(), 4)), glVertexAttribI4uiv: (_c, a) => g().vertexAttribI4uiv(a.i(), u32(a.p(), 4)),
    glGetVertexAttribPointerv: (_c, a) => { const i = a.i(), pn = a.i(); stp(a.p(), g().getVertexAttribOffset(i, pn)); },

    // ── draws
    glDrawArrays: (_c, a) => draw().drawArrays(a.i(), a.i(), a.i()),
    glDrawElements: (_c, a) => draw().drawElements(a.i(), a.i(), a.i(), a.p()),
    glDrawArraysInstanced: (_c, a) => draw().drawArraysInstanced(a.i(), a.i(), a.i(), a.i()),
    glDrawElementsInstanced: (_c, a) => draw().drawElementsInstanced(a.i(), a.i(), a.i(), a.p(), a.i()),
    glDrawRangeElements: (_c, a) => draw().drawRangeElements(a.i(), a.i(), a.i(), a.i(), a.i(), a.p()),

    // ── textures and samplers
    glActiveTexture: (_c, a) => { const texture = a.i(); g().activeTexture(texture); if (texture >= TEXTURE0) contextState().activeUnit = texture - TEXTURE0; },
    glGenTextures: (_c, a) => { const n = a.i(); gen(T().textures, n, a.p(), () => { const texture = g().createTexture(); if (texture) textureRec(texture); return texture; }); },
    glDeleteTextures: (_c, a) => {
      const n = a.i(), p = a.p(), state = contextState();
      del(T().textures, n, p, (texture) => {
        textureRec(texture).deleted = true;
        for (const unit of state.bindings.values()) for (const [target, bound] of unit) if (bound === texture) unit.set(target, null);
        g().deleteTexture(texture);
      });
      state.revision++;
    },
    glIsTexture: (_c, a) => (H(T().textures, a.i()) ? 1 : 0),
    glBindTexture: (_c, a) => {
      const target = a.i(), texture = H(T().textures, a.i()), state = contextState();
      g().bindTexture(target, texture);
      let unit = state.bindings.get(state.activeUnit);
      if (!unit) { unit = new Map(); state.bindings.set(state.activeUnit, unit); }
      if (unit.get(target) !== texture) { unit.set(target, texture); state.revision++; }
    },
    glTexImage2D: (_c, a) => { const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(), b = a.i(), fmt = a.i(), ty = a.i(); (g().texImage2D as Function)(t, l, f, w, h, b, fmt, ty, texData(ty, a.p())); },
    glTexSubImage2D: (_c, a) => { const t = a.i(), l = a.i(), x = a.i(), y = a.i(), w = a.i(), h = a.i(), fmt = a.i(), ty = a.i(); (g().texSubImage2D as Function)(t, l, x, y, w, h, fmt, ty, texData(ty, a.p())); },
    glTexImage3D: (_c, a) => { const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(), d = a.i(), b = a.i(), fmt = a.i(), ty = a.i(); (g().texImage3D as Function)(t, l, f, w, h, d, b, fmt, ty, texData(ty, a.p())); },
    glTexSubImage3D: (_c, a) => { const t = a.i(), l = a.i(), x = a.i(), y = a.i(), z = a.i(), w = a.i(), h = a.i(), d = a.i(), fmt = a.i(), ty = a.i(); (g().texSubImage3D as Function)(t, l, x, y, z, w, h, d, fmt, ty, texData(ty, a.p())); },
    glCompressedTexImage2D: (_c, a) => {
      const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(); a.i(); const n = a.i(), p = a.p();
      if (unpackPbo) g().compressedTexImage2D(t, l, f, w, h, 0, n, p); else g().compressedTexImage2D(t, l, f, w, h, 0, u8(p, n));
    },
    glCompressedTexSubImage2D: (_c, a) => {
      const t = a.i(), l = a.i(), x = a.i(), y = a.i(), w = a.i(), h = a.i(), f = a.i(), n = a.i(), p = a.p();
      if (unpackPbo) g().compressedTexSubImage2D(t, l, x, y, w, h, f, n, p); else g().compressedTexSubImage2D(t, l, x, y, w, h, f, u8(p, n));
    },
    glCompressedTexImage3D: (_c, a) => {
      const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(), d = a.i(); a.i(); const n = a.i(), p = a.p();
      if (unpackPbo) g().compressedTexImage3D(t, l, f, w, h, d, 0, n, p); else g().compressedTexImage3D(t, l, f, w, h, d, 0, u8(p, n));
    },
    glCompressedTexSubImage3D: (_c, a) => {
      const t = a.i(), l = a.i(), x = a.i(), y = a.i(), z = a.i(), w = a.i(), h = a.i(), d = a.i(), f = a.i(), n = a.i(), p = a.p();
      if (unpackPbo) g().compressedTexSubImage3D(t, l, x, y, z, w, h, d, f, n, p); else g().compressedTexSubImage3D(t, l, x, y, z, w, h, d, f, u8(p, n));
    },
    glTexStorage2D: (_c, a) => g().texStorage2D(a.i(), a.i(), a.i(), a.i(), a.i()),
    glTexStorage3D: (_c, a) => g().texStorage3D(a.i(), a.i(), a.i(), a.i(), a.i(), a.i()),
    glCopyTexSubImage3D: (_c, a) => g().copyTexSubImage3D(a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i()),
    glGenerateMipmap: (_c, a) => g().generateMipmap(a.i()),
    glBindSampler: (_c, a) => g().bindSampler(a.i(), H(T().samplers, a.i())),

    // ── framebuffers and renderbuffers
    glBindFramebuffer: (_c, a) => g().bindFramebuffer(a.i(), H(T().fbos, a.i())),
    glFramebufferTexture2D: (_c, a) => g().framebufferTexture2D(a.i(), a.i(), a.i(), H(T().textures, a.i()), a.i()),
    glFramebufferTextureLayer: (_c, a) => g().framebufferTextureLayer(a.i(), a.i(), H(T().textures, a.i()), a.i(), a.i()),
    glFramebufferRenderbuffer: (_c, a) => g().framebufferRenderbuffer(a.i(), a.i(), a.i(), H(T().rbos, a.i())),
    glCheckFramebufferStatus: (_c, a) => g().checkFramebufferStatus(a.i()),
    glGetFramebufferAttachmentParameteriv: (_c, a) => { const t = a.i(), at = a.i(), pn = a.i(); out(g().getFramebufferAttachmentParameter(t, at, pn), a.p(), st32, 4); },
    glBlitFramebuffer: (_c, a) => g().blitFramebuffer(a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i()),
    glInvalidateFramebuffer: (_c, a) => { const t = a.i(), n = a.i(); g().invalidateFramebuffer(t, Array.from(i32(a.p(), n))); },
    glInvalidateSubFramebuffer: (_c, a) => { const t = a.i(), n = a.i(), at = Array.from(i32(a.p(), n)); g().invalidateSubFramebuffer(t, at, a.i(), a.i(), a.i(), a.i()); },
    glDrawBuffers: (_c, a) => { const n = a.i(); g().drawBuffers(Array.from(i32(a.p(), n))); },
    glReadBuffer: (_c, a) => g().readBuffer(a.i()),
    glReadPixels: (_c, a) => {
      const x = a.i(), y = a.i(), w = a.i(), h = a.i(), f = a.i(), ty = a.i(), p = a.p();
      if (packPbo) { g().readPixels(x, y, w, h, f, ty, p); syncVertexBuffer(g().getParameter(0x88ed)); } else g().readPixels(x, y, w, h, f, ty, pixels(ty, p));
    },
    glBindRenderbuffer: (_c, a) => g().bindRenderbuffer(a.i(), H(T().rbos, a.i())),
    glRenderbufferStorage: (_c, a) => g().renderbufferStorage(a.i(), a.i(), a.i(), a.i()),
    glRenderbufferStorageMultisample: (_c, a) => g().renderbufferStorageMultisample(a.i(), a.i(), a.i(), a.i(), a.i()),
    glGetRenderbufferParameteriv: (_c, a) => { const t = a.i(), pn = a.i(); out(g().getRenderbufferParameter(t, pn), a.p(), st32, 4); },

    // ── queries, sync, transform feedback
    glBeginQuery: (_c, a) => { const t = a.i(), q = H(T().queries, a.i()); if (q) g().beginQuery(t, q); },
    glEndQuery: (_c, a) => g().endQuery(a.i()),
    glGetQueryiv: (_c, a) => { const t = a.i(), pn = a.i(); out(g().getQuery(t, pn), a.p(), st32, 4); },
    glGetQueryObjectuiv: (_c, a) => { const q = H(T().queries, a.i()); const pn = a.i(); out(q && g().getQueryParameter(q, pn), a.p(), st32, 4); },
    glFenceSync: (_c, a) => put(T().syncs, g().fenceSync(a.i(), a.i())),
    glIsSync: (_c, a) => (H(T().syncs, a.i()) ? 1 : 0),
    glDeleteSync: (_c, a) => { const h = a.i(), s = T().syncs[h]; if (s) { g().deleteSync(s); T().syncs[h] = null; } },
    glWaitSync: (_c, a) => { const s = H(T().syncs, a.i()); if (s) g().waitSync(s, 0, -1); },
    // a wait longer than the fence takes is spent yielding, one macrotask per look
    glClientWaitSync: async (_c, a) => {
      const s = H(T().syncs, a.i()); const flags = a.i(), until = performance.now() + Number(a.ul()) / 1e6;
      if (!s) return 0x911d;                                                    // WAIT_FAILED
      let r = g().clientWaitSync(s, flags, 0);
      while (r === 0x911b && performance.now() < until) { await yieldToLoop(); r = g().clientWaitSync(s, 0, 0); }
      return r;
    },
    glGetSynciv: (_c, a) => { const s = H(T().syncs, a.i()); const pn = a.i(); a.i(); const lenp = a.p(); if (lenp) mem.st32(lenp, 1); out(s && g().getSyncParameter(s, pn), a.p(), st32, 4); },
    glBindTransformFeedback: (_c, a) => g().bindTransformFeedback(a.i(), H(T().tfs, a.i())),
    glBeginTransformFeedback: (_c, a) => g().beginTransformFeedback(a.i()), glEndTransformFeedback: () => { g().endTransformFeedback(); syncFeedback(); },
    glPauseTransformFeedback: () => { g().pauseTransformFeedback(); syncFeedback(); }, glResumeTransformFeedback: () => g().resumeTransformFeedback(),
  };
  const objects = [["VertexArray", "VertexArrays", "vaos", "createVertexArray", "deleteVertexArray"], ["Sampler", "Samplers", "samplers", "createSampler", "deleteSampler"],
    ["Framebuffer", "Framebuffers", "fbos", "createFramebuffer", "deleteFramebuffer"], ["Renderbuffer", "Renderbuffers", "rbos", "createRenderbuffer", "deleteRenderbuffer"],
    ["Query", "Queries", "queries", "createQuery", "deleteQuery"], ["TransformFeedback", "TransformFeedbacks", "tfs", "createTransformFeedback", "deleteTransformFeedback"]] as const;
  for (const [one, many, key, create, remove] of objects) {
    G[`glGen${many}`] = (_c, a) => { const n = a.i(); gen(T()[key], n, a.p(), () => g()[create]()); };
    G[`glDelete${many}`] = (_c, a) => { const n = a.i(); del(T()[key], n, a.p(), (o) => g()[remove](o)); };
    G[`glIs${one}`] = (_c, a) => (H(T()[key], a.i()) ? 1 : 0);
  }
  for (const [s, st, bpe] of [["Integer", st32, 4], ["Integer64", st64, 8], ["Float", stf, 4], ["Boolean", st8, 1]] as const) G[`glGet${s}v`] = (_c, a) => { const n = a.i(); out(param(n), a.p(), st, bpe); };
  for (const [s, st, bpe] of [["iv", st32, 4], ["i64v", st64, 8]] as const) {
    G[`glGetBufferParameter${s}`] = (_c, a) => { const t = a.i(), pn = a.i(), r = shadowed(t); out(r ? (pn === 0x8765 ? r.usage : r.shadow!.length) : withTarget(t, (tt) => g().getBufferParameter(tt, pn)), a.p(), st, bpe); };
  }
  for (const [s, st] of [["iv", st32], ["fv", stf]] as const) {
    G[`glGetTexParameter${s}`] = (_c, a) => { const t = a.i(), pn = a.i(); out(texParameter(t, pn), a.p(), st, 4); };
    G[`glGetSamplerParameter${s}`] = (_c, a) => { const smp = H(T().samplers, a.i()); const pn = a.i(); out(smp && g().getSamplerParameter(smp, pn), a.p(), st, 4); };
  }
  for (const [s, st] of [["f", stf], ["i", st32], ["ui", st32]] as const) G[`glGetUniform${s}v`] = (_c, a) => { const p = H(T().programs, a.i()), u = U(a.i()); out(p && u && g().getUniform(p, u), a.p(), st, 4); };
  for (const [s, st] of [["fv", stf], ["iv", st32], ["Iiv", st32], ["Iuiv", st32]] as const) G[`glGetVertexAttrib${s}`] = (_c, a) => { const i = a.i(), pn = a.i(); out(g().getVertexAttrib(i, pn), a.p(), st, 4); };
  const I = (a: ArgReader) => a.i(), LD = (a: ArgReader) => mem.ld32(a.p()), F = (a: ArgReader) => a.f(), LDF = (a: ArgReader) => mem.ldf32(a.p());
  for (const [s, read, int] of [["i", I, true], ["f", F, false], ["iv", LD, true], ["fv", LDF, false]] as const) {
    G[`glTexParameter${s}`] = (_c, a) => { const t = a.i(), pn = a.i(); (int ? texParam : texParamf)(t, pn, read(a)); };
    G[`glSamplerParameter${s}`] = (_c, a) => { const smp = H(T().samplers, a.i()); const pn = a.i(), v = read(a); if (smp) { if (int) g().samplerParameteri(smp, pn, v); else g().samplerParameterf(smp, pn, v); } };
  }
  // ── uniforms: glUniform{1..4}{f,i,ui}[v] and the nine matrix shapes
  const kinds = [["f", (a: ArgReader) => a.f(), f32], ["i", (a: ArgReader) => a.i(), i32], ["ui", (a: ArgReader) => a.u(), u32]] as const;
  for (let n = 1; n <= 4; n++) for (const [k, rd, vw] of kinds) {
    const set = method(`uniform${n}${k}`), setv = method(`uniform${n}${k}v`), sampler = n === 1 && k === "i";
    G[`glUniform${n}${k}`] = (_c, a) => {
      const u = U(a.i()), x = rd(a), y = n > 1 ? rd(a) : 0, z = n > 2 ? rd(a) : 0, w = n > 3 ? rd(a) : 0;
      if (!u) return;
      set().call(g(), u, x, y, z, w);
      if (sampler) markSamplerUnitsDirty();
    };
    G[`glUniform${n}${k}v`] = (_c, a) => {
      const u = U(a.i()), cnt = a.i(), p = a.p();
      if (!u) return;
      setv().call(g(), u, vw(p, cnt * n));
      if (sampler) markSamplerUnitsDirty();
    };
  }
  for (const [m, e] of [["2", 4], ["3", 9], ["4", 16], ["2x3", 6], ["3x2", 6], ["2x4", 8], ["4x2", 8], ["3x4", 12], ["4x3", 12]] as const) {
    const set = method(`uniformMatrix${m}fv`);
    G[`glUniformMatrix${m}fv`] = (_c, a) => { const u = U(a.i()), cnt = a.i(), t = !!(a.i() & 255), p = a.p(); if (u) set().call(g(), u, t, f32(p, cnt * e)); };
  }
  // the probe: after each entry point, count and name a GL error
  if (glProbe) for (const [k, f] of Object.entries(G)) {
    if (k === "glGetError") continue;
    G[k] = (c, a) => {
      const args = `(${c.w[0] >>> 0},${c.w[2] >>> 0},${c.w[4] >>> 0})`;   // read before f consumes them
      const r = f(c, a), e = current?.getError();
      if (e) { perf.glErrors++; console.warn("[gl] 0x" + e.toString(16), "after", k + args); }
      return r;
    };
  }
  gles3Procs = G;
  hostLib("libGLESv2.so", G, { closed: true });
  hostLib("libGLESv3.so", G, { closed: true });
}
function texParam(t: number, pn: number, v: number): void {
  if (pn >= 0x8e42 && pn <= 0x8e45) { setSwizzle(t, pn, v); return; }
  g().texParameteri(t, pn, v);
}

function texParamf(t: number, pn: number, v: number): void {
  if (pn >= 0x8e42 && pn <= 0x8e45) { setSwizzle(t, pn, Math.trunc(v)); return; }
  g().texParameterf(t, pn, v);
}

function setSwizzle(target: number, pname: number, value: number): void {
  const selector = value === 0 ? 4 : value === 1 ? 5 : value >= 0x1903 && value <= 0x1906 ? value - 0x1903 : -1;
  if (selector < 0) { err = 0x500; return; }                                     // INVALID_ENUM
  const state = contextState(), texture = boundTexture(state, state.activeUnit, target);
  if (!texture) { err = 0x502; return; }                                         // INVALID_OPERATION
  const rec = textureRec(texture), channel = pname - 0x8e42;
  if (rec.channels[channel] === selector) return;
  rec.channels[channel] = selector;
  rec.code = rec.channels[0] | (rec.channels[1] << 3) | (rec.channels[2] << 6) | (rec.channels[3] << 9);
  state.revision++;
}

function texParameter(target: number, pname: number): unknown {
  if (pname < 0x8e42 || pname > 0x8e45) return g().getTexParameter(target, pname);
  const state = contextState(), texture = boundTexture(state, state.activeUnit, target);
  if (!texture) { err = 0x502; return 0; }
  const selector = textureRec(texture).channels[pname - 0x8e42];
  return selector < 4 ? 0x1903 + selector : selector === 4 ? 0 : 1;
}
