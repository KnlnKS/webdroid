// OpenGL ES 3.0 over WebGL2, registered as libGLESv2.so and libGLESv3.so. Closed: a name outside
// ES 3.0 core (KHR_debug, the ES 3.1 entry points) is NULL from dlsym and eglGetProcAddress, so
// an engine feature-gates as on a device. Handles are gl.ts's per-context tables, shared with the
// Java GLES20 bindings. Pointer arguments are guest memory, or offsets while a pixel or element
// buffer is bound, as in GL.

import { mem, wrote } from "./mem";
import { hostLib, cstr, PTR, ldp, stp, calledMissing, type HostFn, type ArgReader } from "./host";
import { gl as current, tables as T, put, takeError } from "../android/gl";
import { yieldToLoop } from "./cpu";
import { perf } from "../perf";
import { rewriteTextureSwizzles, visibleUniforms, type SwizzleRewrite, type VisibleUniforms } from "./swizzle";
import { activateEglCurrent } from "./egl-current";
const dec = new TextDecoder();
export let gles3Procs: Record<string, HostFn> = {};
export const glProbe = !!(globalThis as { __wdGlProbe?: boolean }).__wdGlProbe;

type GL = WebGL2RenderingContext;
const g = (): GL => { if (!current) throw new Error("GL call without a current context"); return current as GL; };
/** an error GL raises that WebGL would not: kept until glGetError, the first one winning as in GL */
const raise = (e: number): void => { const t = T(); t.err ||= e; };
const mapped = new WeakMap<object, { ptr: number; off: number; len: number; access: number }>();   // a mapping belongs to the buffer, not the target

const TEXTURE0 = 0x84c0, ACTIVE_TEXTURE = 0x84e0, CURRENT_PROGRAM = 0x8b8d;
const IDENTITY_SWIZZLE = 0x688;
const ETC2_EAC_FIRST = 0x9270, ETC2_EAC_LAST = 0x9279;
const etc2Contexts = new WeakSet<GL>();
function glForTextureFormat(format: number): GL {
  const gl = g();
  if (format >= ETC2_EAC_FIRST && format <= ETC2_EAC_LAST && !etc2Contexts.has(gl)) {
    // WebGL gates GLES3-core ETC2/EAC formats behind extension activation.
    gl.getExtension("WEBGL_compressed_texture_etc");
    etc2Contexts.add(gl);
  }
  return gl;
}
const shaderRecs = new WeakMap<WebGLShader, { original: string; rewrite: SwizzleRewrite }>();
/** `target`: 0 until first bound when glGenTextures made it, -1 when made elsewhere (unknown);
 *  an immutable texture's storage is `levels` of `format` from width x height */
interface TexRec { channels: [number, number, number, number]; code: number; deleted: boolean; target: number; immutable: boolean;
  format: number; width: number; height: number; levels: number }
const texRecs = new WeakMap<WebGLTexture, TexRec>();
interface SamplerBinding { target: number; units: Int32Array }
interface ProgramMap { binding: SamplerBinding; location: WebGLUniformLocation; pending: Int32Array; uploaded: Int32Array }
interface ProgramRec {
  hidden: ReadonlySet<string>;
  uniforms: VisibleUniforms;
  samplers: ReadonlyMap<string, SamplerBinding>;
  maps: ProgramMap[];
  bindingRevision: number;
}
const programRecs = new WeakMap<WebGLProgram, ProgramRec>();
/** a guest uniform location naming a swizzled sampler: the program's record, its binding and element */
const samplerSlots = new WeakMap<WebGLUniformLocation, { rec: ProgramRec; binding: SamplerBinding; index: number }>();
interface ContextState {
  activeUnit: number;
  bindings: Map<number, Map<number, WebGLTexture | null>>;
  revision: number;
  program: WebGLProgram | null;
  /** buffer target → the record bound there; the element binding belongs to the vertex array */
  buffers: Map<number, BufRec | null>;
  elements: Map<WebGLVertexArrayObject | null, BufRec | null>;
  vao: WebGLVertexArrayObject | null;
  /** the default vertex array's client arrays by attribute, with its enables and divisors */
  clients: Map<number, ClientArray>;
  enabled: Uint8Array;
  divisors: Uint32Array;
  /** the buffers client vertex arrays and indices are streamed into at each draw */
  streams: WebGLBuffer[];
  indexStream: WebGLBuffer | null;
  /** the bound renderbuffer, undefined when unknown */
  renderbuffer: WebGLRenderbuffer | null | undefined;
  /** transform feedback has run, which WebGL restricts buffer writes around */
  feedback: boolean;
  /** MAX_COMBINED_TEXTURE_IMAGE_UNITS, MAX_TEXTURE_SIZE, MAX_CUBE_MAP_TEXTURE_SIZE, MAX_RENDERBUFFER_SIZE */
  limits: Int32Array;
}
interface ClientArray { size: number; type: number; normalized: boolean; stride: number; ptr: number; integer: boolean }
const contextStates = new WeakMap<GL, ContextState>();

function contextState(): ContextState {
  const gl = g();
  let state = contextStates.get(gl);
  if (!state) {
    const active = gl.getParameter(ACTIVE_TEXTURE) as number;
    const attribs = gl.getParameter(0x8869) as number;                         // MAX_VERTEX_ATTRIBS
    state = { activeUnit: Math.max(0, active - TEXTURE0), bindings: new Map(), revision: 0, program: null, buffers: new Map(), elements: new Map(), vao: null,
      clients: new Map(), enabled: new Uint8Array(attribs), divisors: new Uint32Array(attribs), streams: [], indexStream: null, renderbuffer: undefined, feedback: false,
      limits: Int32Array.from([0x8b4d, 0x0d33, 0x851c, 0x84e8], (pname) => gl.getParameter(pname) as number) };
    contextStates.set(gl, state);
  }
  return state;
}

function textureRec(texture: WebGLTexture): TexRec {
  let rec = texRecs.get(texture);
  if (!rec) { rec = { channels: [0, 1, 2, 3], code: IDENTITY_SWIZZLE, deleted: false, target: -1, immutable: false, format: 0, width: 0, height: 0, levels: 0 }; texRecs.set(texture, rec); }
  return rec;
}

/** GL_TEXTURE_EXTERNAL_OES names TEXTURE_2D: SurfaceTexture fills its texture as 2D storage */
export const textureTarget = (target: number): number => (target === 0x8d65 ? 0x0de1 : target);
/** the samplerExternalOES uniforms each shader declared */
const externalSamplers = new WeakMap<WebGLShader, Set<string>>();
/** WebGL has no external samplers, so a shader's samplerExternalOES reads that storage as a
 *  sampler2D; the #extension line is blanked in place to keep compile errors' line numbers. */
export function externalSamplersAs2D(shader: WebGLShader, source: string): string {
  if (!source.includes("samplerExternalOES")) { externalSamplers.delete(shader); return source; }
  externalSamplers.set(shader, new Set(Array.from(source.matchAll(/\bsamplerExternalOES\s+(\w+)/g), (m) => m[1])));
  return source.replace(/^[ \t]*#extension[ \t]+GL_OES_EGL_image_external(?:_essl3)?[ \t]*:.*$/gm, "").replace(/\bsamplerExternalOES\b/g, "sampler2D");
}
/** glGetActiveUniform's view: a sampler2D the program's shaders declared samplerExternalOES
 *  reports SAMPLER_EXTERNAL_OES */
export function activeUniformInfo(gl: WebGL2RenderingContext | WebGLRenderingContext, program: WebGLProgram, info: WebGLActiveInfo | null): WebGLActiveInfo | null {
  if (info?.type !== 0x8b5e) return info;
  const name = info.name.endsWith("[0]") ? info.name.slice(0, -3) : info.name;
  for (const shader of gl.getAttachedShaders(program) ?? []) {
    if (externalSamplers.get(shader)?.has(name)) return { name: info.name, size: info.size, type: 0x8d66 };
  }
  return info;
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
  const maps: ProgramMap[] = [];
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
      // a freshly linked program's samplers all read unit 0
      binding = { target, units: new Int32Array(Math.min(map.size, info.size)) };
      bindingsByName.set(map.sampler, binding);
    }
    const size = Math.min(binding.units.length, hiddenInfo.size);
    maps.push({ binding, location: mapLocation, pending: new Int32Array(size), uploaded: new Int32Array(size).fill(-1) });
  }
  programRecs.set(program, { hidden, uniforms, samplers: bindingsByName, maps, bindingRevision: -1 });
}

function prepareDraw(): ContextState {
  const gl = g(), state = contextState();
  if (!state.program) state.program = gl.getParameter(CURRENT_PROGRAM) as WebGLProgram | null;
  const rec = state.program && programRecs.get(state.program);
  if (!rec || rec.bindingRevision === state.revision) return state;
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
  return state;
}

/** glUniform1i[v] on a swizzled sampler: its texture units, kept here rather than read back from GL */
function setSamplerUnits(u: WebGLUniformLocation, units: ArrayLike<number>): void {
  const slot = samplerSlots.get(u);
  if (!slot) return;
  const { binding, index } = slot;
  for (let i = 0; i < units.length && index + i < binding.units.length; i++) binding.units[index + i] = units[i];
  slot.rec.bindingRevision = -1;
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
function pixelArray(type: number): Ctor<ArrayBufferView> {
  return type === 0x1406 ? Float32Array : type === 0x1404 ? Int32Array : type === 0x1402 ? Int16Array : type === 0x1400 ? Int8Array
    : type === 0x1401 ? Uint8Array : (type === 0x1403 || type === 0x140b || type === 0x8d61 || type === 0x8033 || type === 0x8034 || type === 0x8363) ? Uint16Array : Uint32Array;
}
function pixels(type: number, p: number): ArrayBufferView {
  const K = pixelArray(type);
  const n = Math.floor((mem.u8.length - p) / K.BYTES_PER_ELEMENT);
  return p % K.BYTES_PER_ELEMENT ? new K(mem.u8.slice(p, p + Math.min(n, 1 << 26) * K.BYTES_PER_ELEMENT).buffer) : new K(mem.buf, p, n);
}
function pixelByteSize(format: number, type: number): number {
  const channels = format === 0x1908 || format === 0x8d99 ? 4 : format === 0x1907 || format === 0x8d98 ? 3
    : format === 0x190a || format === 0x8227 || format === 0x8228 ? 2
    : [0x1902, 0x1903, 0x1906, 0x1909, 0x8d94].includes(format) ? 1 : 0;
  const packed = [0x8033, 0x8034, 0x8363].includes(type) ? 2
    : [0x8368, 0x8c3b, 0x8c3e, 0x84fa].includes(type) ? 4 : type === 0x8dad ? 8 : 0;
  return packed || channels * pixelArray(type).BYTES_PER_ELEMENT;
}
function pixelRows(width: number, height: number, bytes: number, alignment: number, rowLength: number, skipRows: number, skipPixels: number) {
  const stride = Math.ceil(rowLength * bytes / alignment) * alignment;
  const skip = skipRows * stride + skipPixels * bytes;
  return { stride, skip, extent: skip + (height - 1) * stride + width * bytes };
}
// glGetIntegerv is a synchronous round trip to the GPU process that waits for every queued
// command, so the pixel-store state an upload or readback needs is tracked here instead.
const pixelStores = new WeakMap<WebGLRenderingContext | WebGL2RenderingContext, Map<number, number>>();
const ALIGNMENTS = [1, 2, 4, 8];
export function pixelStore(gl: WebGLRenderingContext | WebGL2RenderingContext, pname: number, value: number): void {
  gl.pixelStorei(pname, value);
  const alignment = pname === 0x0cf5 || pname === 0x0d05;
  if (alignment ? !ALIGNMENTS.includes(value) : value < 0 || !("UNPACK_ROW_LENGTH" in gl)) return;
  let store = pixelStores.get(gl);
  if (!store) pixelStores.set(gl, store = new Map());
  store.set(pname, value);
}
const pixelParam = (gl: WebGLRenderingContext | WebGL2RenderingContext, pname: number): number =>
  pixelStores.get(gl)?.get(pname) ?? (pname === 0x0cf5 || pname === 0x0d05 ? 4 : 0);
type PixelDimensions = readonly [width: number, height: number] | readonly [width: number, height: number, depth: number];
/** the bytes an upload reads from its pointer under the unpack state, -1 when not computable */
function uploadExtent(type: number, format: number, dimensions: PixelDimensions): number {
  const [width, height] = dimensions;
  const bytes = pixelByteSize(format, type);
  const layers = dimensions.length === 3 ? dimensions[2] : 1;
  if (!bytes || width < 0 || height < 0 || layers < 0) return -1;
  const gl = g();
  const rowLength = pixelParam(gl, 0x0cf2) || width;
  const { stride, extent } = pixelRows(width, height, bytes, pixelParam(gl, 0x0cf5), rowLength, pixelParam(gl, 0x0cf3), pixelParam(gl, 0x0cf4));
  let required = extent;
  if (dimensions.length === 3) {
    const imageHeight = pixelParam(gl, 0x806e) || height;
    required += (pixelParam(gl, 0x806d) + dimensions[2] - 1) * imageHeight * stride;
  }
  return Number.isSafeInteger(required) && required >= 0 ? required : -1;
}
// Bound uploads to the bytes WebGL may read; a guest-memory-sized view stalls getError after each frame.
function uploadPixels(type: number, p: number, format: number, dimensions: PixelDimensions): ArrayBufferView {
  const required = uploadExtent(type, format, dimensions), K = pixelArray(type);
  if (required < 0) return pixels(type, p);
  return view(K, p, Math.floor(Math.min(required, mem.u8.length - p) / K.BYTES_PER_ELEMENT));
}
export function readGuestPixels(gl: WebGLRenderingContext | WebGL2RenderingContext, x: number, y: number, w: number, h: number, format: number, type: number, p: number): void {
  const K = pixelArray(type), element = K.BYTES_PER_ELEMENT;
  const bytes = pixelByteSize(format, type);
  if (!bytes || w <= 0 || h <= 0) { gl.readPixels(x, y, w, h, format, type, pixels(type, p)); return; }
  const rowLength = pixelParam(gl, 0x0d02) || w;
  const { stride, skip, extent } = pixelRows(w, h, bytes, pixelParam(gl, 0x0d05), rowLength, pixelParam(gl, 0x0d03), pixelParam(gl, 0x0d04));
  const data = view(K, p, Math.floor(Math.min(extent, mem.u8.length - p) / element));
  gl.readPixels(x, y, w, h, format, type, data);
  // A short destination is rejected by WebGL. Padding and skipped pixels are never written.
  if (extent > data.byteLength) return;
  if (data.buffer !== mem.buf) mem.u8.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), p);
  for (let row = 0; row < h; row++) wrote(p + skip + row * stride, w * bytes);
}
const PACK = 0x88eb, UNPACK = 0x88ec;
const pbo = (t: number): boolean => !!contextState().buffers.get(t);
const texData = (type: number, p: number, format: number, dimensions: PixelDimensions): number | ArrayBufferView | null =>
  (pbo(UNPACK) ? p : p ? uploadPixels(type, p, format, dimensions) : null);
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
function gen(tbl: (object | null)[], n: number, p: number, make: () => object | null): void { if (n < 0) raise(0x501); for (let i = 0; i < n; i++) mem.st32(p + 4 * i, put(tbl, make())); }
function del(tbl: (object | null)[], n: number, p: number, kill: (o: never) => void): void {
  for (let i = 0; i < n; i++) { const h = mem.ld32(p + 4 * i), o = tbl[h]; if (o) { kill(o as never); tbl[h] = null; } }
}

// ── buffer records: kind (element or not) decided at the first typed bind, data shadowed until then
/** `size`: the data store's bytes as WebGL holds them, -1 when not known */
interface BufRec { gl: WebGLBuffer | null; other: WebGLBuffer | null; elem: boolean | null; shadow: Uint8Array | null; usage: number; size: number }
const COPY_READ = 0x8f36, COPY_WRITE = 0x8f37, ELEM = 0x8893, ARRAY = 0x8892;
const recOf = new WeakMap<object, BufRec>();
const rec = (h: number): BufRec | null => { const o = H(T().buffers, h); return o ? recOf.get(o) ?? null : null; };
function recAt(t: number): BufRec | null {
  const state = contextState();
  return (t === ELEM ? state.elements.get(state.vao) : state.buffers.get(t)) ?? null;
}
function bindRec(t: number, r: BufRec | null): void {
  const state = contextState();
  if (t === ELEM) state.elements.set(state.vao, r); else state.buffers.set(t, r);
}
/** the WebGL storage a record presents at ARRAY_BUFFER or ELEMENT_ARRAY_BUFFER */
const storage = (r: BufRec | null, elem: boolean): WebGLBuffer | null => (r ? (r.elem === elem ? r.gl : r.other) : null);
/** what WebGL has bound at ARRAY_BUFFER or ELEMENT_ARRAY_BUFFER */
const boundStorage = (t: number): WebGLBuffer | null => storage(recAt(t), t === ELEM);
/** the record behind a data target while its kind is undecided: writes land in the shadow */
const shadowed = (t: number): BufRec | null => { if (t !== COPY_READ && t !== COPY_WRITE) return null; const r = recAt(t); return r && r.elem === null ? r : null; };
/** run an operation on a data target: a copy target stands in for the buffer's own kind, binding restored */
function withTarget<R>(t: number, fn: (tt: number) => R): R {
  if (t !== COPY_READ && t !== COPY_WRITE) return fn(t);
  const gl = g();
  const r = recAt(t), tt = r?.elem ? ELEM : ARRAY;
  gl.bindBuffer(tt, r?.gl ?? null);
  try { return fn(tt); } finally { gl.bindBuffer(tt, boundStorage(tt)); }
}
function writeBuffers(t: number, fn: (target: number) => void): void {
  withTarget(t, fn);
  const r = recAt(t);
  if (!r?.other) return;
  const gl = g();
  const elem = t === COPY_READ || t === COPY_WRITE ? r.elem : t === ELEM;
  const target = elem ? ARRAY : ELEM;
  gl.bindBuffer(target, storage(r, target === ELEM));
  try { fn(target); } finally { gl.bindBuffer(target, boundStorage(target)); }
}
const writeBack = (t: number, off: number, data: Uint8Array): void => { const r = shadowed(t); if (r) r.shadow!.set(data, off); else writeBuffers(t, (tt) => g().bufferSubData(tt, off, data)); };
function realize(t: number, r: BufRec | null, h: number): WebGLBuffer | null {
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
    const target = r.elem ? ELEM : ARRAY;
    gl.bindBuffer(target, r.gl);
    const data = new Uint8Array(gl.getBufferParameter(target, 0x8764));
    gl.getBufferSubData(target, 0, data);
    gl.bindBuffer(target, boundStorage(target));
    r.other = gl.createBuffer();
    if (r.other) { recOf.set(r.other, r); T().ids.set(r.other, h); }
    gl.bindBuffer(t, r.other); gl.bufferData(t, data, r.usage);
  }
  return r.other;
}

/** after GL wrote a buffer's vertex storage, refresh its index copy */
function syncVertexBuffer(r: BufRec | null | undefined): void {
  if (!r?.other) return;
  const gl = g();
  gl.bindBuffer(ARRAY, storage(r, false));
  const data = new Uint8Array(gl.getBufferParameter(ARRAY, 0x8764));
  gl.getBufferSubData(ARRAY, 0, data);
  gl.bindBuffer(ELEM, storage(r, true));
  gl.bufferSubData(ELEM, 0, data);
  gl.bindBuffer(ARRAY, boundStorage(ARRAY)); gl.bindBuffer(ELEM, boundStorage(ELEM));
}

// ── calls WebGL accepts without raising an error keep the context clean for glGetError
// (android/gl.ts takeError); for anything else, or an argument not recognized here, WebGL judges
const unsure = (): void => { T().clean = false; };
const TEXTURE_TARGETS = new Set([0x0de1, 0x8513, 0x806f, 0x8c1a]);
const BUFFER_TARGETS = new Set([ARRAY, ELEM, COPY_READ, COPY_WRITE, PACK, UNPACK, 0x8a11]);
const USAGES = new Set([0x88e0, 0x88e1, 0x88e2, 0x88e4, 0x88e5, 0x88e6, 0x88e8, 0x88e9, 0x88ea]);
// sized formats WebGL 2 stores without an extension
const STORAGE_FORMATS = new Set([0x8058, 0x8051, 0x8229, 0x822b, 0x8d62, 0x8056, 0x8057, 0x8c43, 0x8059, 0x881a, 0x881b, 0x822d, 0x822f,
  0x822e, 0x8230, 0x8814, 0x8815, 0x8c3a, 0x8c3d, 0x81a5, 0x81a6, 0x8cac, 0x88f0, 0x8cad]);
const RENDERBUFFER_FORMATS = new Set([0x8056, 0x8d62, 0x8057, 0x81a5, 0x8d48, 0x8058, 0x8051, 0x88f0, 0x81a6, 0x8cac, 0x8cad, 0x8c43, 0x8229, 0x822b]);
// texImage2D's (internalformat, format, type) combinations from ES 3.0's table 3.2, byte and packed 16-bit
const IMAGE_FORMATS = new Set(["6408 6408 5121", "6407 6407 5121", "6410 6410 5121", "6409 6409 5121", "6406 6406 5121", "32856 6408 5121",
  "32849 6407 5121", "33321 6403 5121", "33323 33319 5121", "6407 6407 33635", "36194 6407 33635", "36194 6407 5121", "6408 6408 32819",
  "32854 6408 32819", "32854 6408 5121", "6408 6408 32820", "32855 6408 32820", "32855 6408 5121"]);
const mipLevels = (size: number): number => Math.floor(Math.log2(size)) + 1;
/** the texture bound at the active unit for `target`, undefined when not tracked */
const knownTexture = (state: ContextState, target: number): WebGLTexture | null | undefined => state.bindings.get(state.activeUnit)?.get(target);
/** the record of the texture bound for `target` while its state is tracked */
function trustedTexture(state: ContextState, target: number): TexRec | null {
  const texture = knownTexture(state, target), rec = texture && texRecs.get(texture);
  return rec && rec.target > 0 && !rec.deleted ? rec : null;
}
/** a call WebGL may reject changed that texture: its state is no longer known */
function untrust(target: number): void {
  unsure();
  const texture = knownTexture(contextState(), target), rec = texture && texRecs.get(texture);
  if (rec) rec.target = -1;
}
function texParamAccepted(target: number, pname: number, v: number): boolean {
  if (!TEXTURE_TARGETS.has(target) || !trustedTexture(contextState(), target)) return false;
  switch (pname) {
    case 0x2800: return v === 0x2600 || v === 0x2601;                                       // MAG_FILTER
    case 0x2801: return v === 0x2600 || v === 0x2601 || (v >= 0x2700 && v <= 0x2703);       // MIN_FILTER
    case 0x2802: case 0x2803: case 0x8072: return v === 0x2901 || v === 0x812f || v === 0x8370; // WRAP_S/T/R
    case 0x813c: case 0x813d: return v >= 0;                                                // BASE/MAX_LEVEL
    case 0x884c: return v === 0 || v === 0x884e;                                            // COMPARE_MODE
    case 0x884d: return v >= 0x0200 && v <= 0x0207;                                         // COMPARE_FUNC
    case 0x813a: case 0x813b: return true;                                                  // MIN/MAX_LOD
    default: return false;
  }
}
function storageAccepted(target: number, levels: number, format: number, w: number, h: number): TexRec | null {
  if (target !== 0x0de1 && target !== 0x8513) return null;
  const state = contextState(), rec = trustedTexture(state, target), max = state.limits[target === 0x8513 ? 2 : 1];
  if (!rec || rec.immutable || !STORAGE_FORMATS.has(format)) return null;
  return levels >= 1 && w >= 1 && h >= 1 && w <= max && h <= max && (target !== 0x8513 || w === h) && levels <= mipLevels(Math.max(w, h)) ? rec : null;
}
function imageAccepted(target: number, level: number, internal: number, w: number, h: number, border: number, format: number, type: number, p: number): boolean {
  const cube = target >= 0x8515 && target <= 0x851a;
  if (target !== 0x0de1 && !cube) return false;
  const state = contextState(), rec = trustedTexture(state, cube ? 0x8513 : target), max = state.limits[cube ? 2 : 1];
  if (!rec || rec.immutable || border !== 0 || pbo(UNPACK) || !IMAGE_FORMATS.has(`${internal} ${format} ${type}`)) return false;
  if (level < 0 || level >= mipLevels(max) || w < 0 || h < 0 || w > max >> level || h > max >> level || (cube && w !== h)) return false;
  return pixelSourceAccepted(type, format, w, h, p);
}
// the (format, type) pairs ES 3.0's table 3.2 accepts for a sized format's byte and packed 16-bit uploads
const SUB_FORMATS = new Map<number, string[]>([[0x8058, ["6408 5121"]], [0x8051, ["6407 5121"]], [0x8229, ["6403 5121"]], [0x822b, ["33319 5121"]],
  [0x8c43, ["6408 5121"]], [0x8d62, ["6407 5121", "6407 33635"]], [0x8056, ["6408 5121", "6408 32819"]], [0x8057, ["6408 5121", "6408 32820"]]]);
/** texSubImage2D into a tracked immutable texture */
function subImageAccepted(target: number, level: number, x: number, y: number, w: number, h: number, format: number, type: number, p: number): boolean {
  const cube = target >= 0x8515 && target <= 0x851a;
  if (target !== 0x0de1 && !cube) return false;
  const rec = trustedTexture(contextState(), cube ? 0x8513 : target);
  if (!rec?.immutable || pbo(UNPACK) || !SUB_FORMATS.get(rec.format)?.includes(`${format} ${type}`)) return false;
  if (level < 0 || level >= rec.levels || x < 0 || y < 0 || w < 0 || h < 0 || x + w > Math.max(1, rec.width >> level) || y + h > Math.max(1, rec.height >> level)) return false;
  return pixelSourceAccepted(type, format, w, h, p);
}
/** the unpack state and guest memory hold the rows an upload reads */
function pixelSourceAccepted(type: number, format: number, w: number, h: number, p: number): boolean {
  const gl = g(), rowLength = pixelParam(gl, 0x0cf2);
  if (rowLength && pixelParam(gl, 0x0cf4) + w > rowLength) return false;
  if (!p || !w || !h) return true;
  const extent = uploadExtent(type, format, [w, h]);
  return extent >= 0 && p + extent <= mem.u8.length;
}
function pixelStoreAccepted(pname: number, v: number): boolean {
  if (pname === 0x0cf5 || pname === 0x0d05) return ALIGNMENTS.includes(v);
  return v >= 0 && [0x0cf2, 0x0cf3, 0x0cf4, 0x806d, 0x806e, 0x0d02, 0x0d03, 0x0d04].includes(pname);
}
/** the entry points that call unsure() themselves when WebGL may reject them; every other one
 *  leaves the context unsure. glGen and glDelete pass only this context's objects (deleting an
 *  active transform feedback is an error, so that one is left to WebGL). */
const TRACKED = new Set(["glGetError", "glGetString", "glGetStringi", "glFlush", "glWaitSync", "glDeleteSync", "glPixelStorei", "glActiveTexture",
  "glBindTexture", "glTexParameteri", "glTexParameteriv", "glTexParameterf", "glTexParameterfv", "glTexStorage2D", "glTexImage2D",
  "glTexSubImage2D", "glFenceSync", "glBindBuffer", "glBufferData", "glBufferSubData", "glBindRenderbuffer", "glRenderbufferStorage", "glDeleteShader", "glDeleteProgram",
  "glGenTransformFeedbacks", ...["Buffers", "Textures", "VertexArrays", "Samplers", "Framebuffers", "Renderbuffers", "Queries"].flatMap((k) => [`glGen${k}`, `glDelete${k}`]),
  ...["Buffer", "Texture", "Shader", "Program", "VertexArray", "Sampler", "Framebuffer", "Renderbuffer", "Query", "TransformFeedback", "Sync"].map((k) => `glIs${k}`)]);

function syncFeedback(): void {
  const n = g().getParameter(0x8c8b);
  for (let i = 0; i < n; i++) { const buffer = g().getIndexedParameter(0x8c8f, i); syncVertexBuffer(buffer && recOf.get(buffer)); }
}

// ── client arrays: the default vertex array reads attributes and indices from guest memory at
// the draw, which WebGL cannot, so each draw streams what it reaches into reused buffers
/** bytes per vertex attribute component */
export const vertexTypeBytes = (type: number): number =>
  type === 0x1400 || type === 0x1401 ? 1 : type === 0x1402 || type === 0x1403 || type === 0x140b ? 2 : 4;
const attribBytes = (c: ClientArray): number => (c.type === 0x8d9f || c.type === 0x8368 ? 4 : c.size * vertexTypeBytes(c.type));
/** a draw's index array in guest memory */
export function guestIndices(type: number, p: number, count: number): Uint8Array | Uint16Array | Uint32Array {
  return type === 0x1405 ? u32(p, count) : type === 0x1403 ? view(Uint16Array, p, count) : u8(p, count);
}
/** the vertices [lo, hi) an index array reaches; WebGL 2 always restarts at the all-ones index */
export function indexBounds(indices: Uint8Array | Uint16Array | Uint32Array): [number, number] {
  const restart = indices.BYTES_PER_ELEMENT === 4 ? 0xffffffff : indices.BYTES_PER_ELEMENT === 2 ? 0xffff : 0xff;
  let lo = Infinity, hi = -1;
  for (let i = 0; i < indices.length; i++) { const v = indices[i]; if (v !== restart) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  return hi < 0 ? [0, 0] : [lo, hi + 1];
}

function vertexAttribPointer(integer: boolean, i: number, size: number, type: number, normalized: boolean, stride: number, ptr: number): void {
  const gl = g(), state = contextState();
  if (recAt(ARRAY) || !ptr) {
    if (!state.vao) state.clients.delete(i);
    if (integer) gl.vertexAttribIPointer(i, size, type, stride, ptr); else gl.vertexAttribPointer(i, size, type, normalized, stride, ptr);
    return;
  }
  if (state.vao) { raise(0x502); return; }                                    // ES 3.0 keeps client arrays to the default vertex array
  // WebGL validates the format against no buffer at offset 0; each draw binds the streamed data
  if (integer) gl.vertexAttribIPointer(i, size, type, stride, 0); else gl.vertexAttribPointer(i, size, type, normalized, stride, 0);
  if (i < state.enabled.length && size >= 1 && size <= 4 && stride >= 0) state.clients.set(i, { size, type, normalized, stride, ptr, integer });
}
const clientArray = (state: ContextState, i: number): ClientArray | undefined => (state.vao ? undefined : state.clients.get(i));

/** 2 when an enabled client array is per-vertex, 1 when all of them are per-instance, 0 without any */
function clientUse(state: ContextState): number {
  let use = 0;
  for (const i of state.clients.keys()) if (state.enabled[i]) { if (!state.divisors[i]) return 2; use = 1; }
  return use;
}

interface Span { index: number; array: ClientArray; start: number; end: number }
const spans: Span[] = [];
/**
 * Upload the guest bytes the enabled client arrays reach for vertices [lo, hi) and `instances`
 * instances. Arrays whose ranges overlap (an interleaved struct) share one upload. Each vertex
 * keeps its guest offset from the group's lowest pointer, so draws keep `first` and the indices.
 */
function streamClientArrays(state: ContextState, lo: number, hi: number, instances: number): void {
  const gl = g();
  let n = 0;
  for (const [index, array] of state.clients) {
    if (!state.enabled[index]) continue;
    const divisor = state.divisors[index], from = divisor ? 0 : lo, to = divisor ? Math.ceil(instances / divisor) : hi;
    const span = spans[n] ??= { index, array, start: 0, end: 0 };
    span.index = index; span.array = array;
    span.start = array.ptr + from * (array.stride || attribBytes(array));
    span.end = array.ptr + Math.max(from, to - 1) * (array.stride || attribBytes(array)) + attribBytes(array);
    let k = n++;
    while (k > 0 && spans[k - 1].start > span.start) { spans[k] = spans[k - 1]; k--; }
    spans[k] = span;
  }
  for (let k = 0, group = 0; k < n; group++) {
    let end = spans[k].end, base = spans[k].array.ptr, j = k + 1;
    for (; j < n && spans[j].start <= end; j++) { end = Math.max(end, spans[j].end); base = Math.min(base, spans[j].array.ptr); }
    base -= base % 4;                                                          // offsets keep the guest alignment
    const start = spans[k].start, data = mem.u8.subarray(start, end);
    gl.bindBuffer(ARRAY, state.streams[group] ??= gl.createBuffer());
    if (start === base) gl.bufferData(ARRAY, data, gl.STREAM_DRAW);
    else { gl.bufferData(ARRAY, end - base, gl.STREAM_DRAW); gl.bufferSubData(ARRAY, start - base, data); }
    for (; k < j; k++) {
      const { index, array: c } = spans[k];
      if (c.integer) gl.vertexAttribIPointer(index, c.size, c.type, c.stride, c.ptr - base);
      else gl.vertexAttribPointer(index, c.size, c.type, c.normalized, c.stride, c.ptr - base);
    }
  }
  gl.bindBuffer(ARRAY, boundStorage(ARRAY));
}

function drawClientArrays(state: ContextState, first: number, count: number, instances: number): void {
  if (count > 0 && instances > 0 && clientUse(state)) streamClientArrays(state, first, first + count, instances);
}

/**
 * An indexed draw in the default vertex array. Client indices are streamed into a reused element
 * buffer. The vertex range comes from client indices, else from glDrawRangeElements' own range,
 * else from reading the bound element buffer back, since the host does not keep its data.
 */
function drawClientElements(state: ContextState, count: number, type: number, p: number, instances: number,
  range: readonly [number, number] | null, drawAt: (offset: number) => void): void {
  const gl = g(), elements = state.elements.get(null);
  if (count < 0 || instances < 0) { raise(0x501); return; }
  if (!count || !instances) return;
  const indices = elements ? null : guestIndices(type, p, count), use = clientUse(state);
  if (use) {
    let bounds: [number, number] = [0, 0];
    if (use === 2) {
      if (indices) bounds = indexBounds(indices);
      else if (range) bounds = [range[0], range[1] + 1];
      else {
        const read = new (type === 0x1405 ? Uint32Array : type === 0x1403 ? Uint16Array : Uint8Array)(count);
        if (p + read.byteLength <= (gl.getBufferParameter(ELEM, 0x8764) as number)) { gl.getBufferSubData(ELEM, p, read); bounds = indexBounds(read); }
      }
    }
    streamClientArrays(state, bounds[0], bounds[1], instances);
  }
  if (!indices) { drawAt(p); return; }
  gl.bindBuffer(ELEM, state.indexStream ??= gl.createBuffer());
  gl.bufferData(ELEM, new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength), gl.STREAM_DRAW);
  drawAt(0);
  gl.bindBuffer(ELEM, null);
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
    case 0x8d67: return g().getParameter(0x8069);                                   // TEXTURE_BINDING_EXTERNAL_OES
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
const draw = (): ContextState => { perf.glDraws++; return prepareDraw(); };
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
      if (size < 0) { raise(0x501); return; }
      const values: unknown = g().getInternalformatParameter(t, f, pn === 0x9380 ? 0x80a9 : pn);
      if (!(values instanceof Int32Array) || !size) return;
      if (pn === 0x9380) mem.st32(p, values.length);
      else for (let i = 0; i < Math.min(size, values.length); i++) mem.st32(p + i * 4, values[i]);
    },
    glGetShaderPrecisionFormat: (_c, a) => {
      const f = g().getShaderPrecisionFormat(a.i(), a.i()), range = a.p(), prec = a.p();
      if (f) { mem.st32(range, f.rangeMin); mem.st32(range + 4, f.rangeMax); mem.st32(prec, f.precision); }
    },
    glGetError: () => takeError(),
    glIsEnabled: (_c, a) => (g().isEnabled(a.i()) ? 1 : 0),
    glEnable: (_c, a) => g().enable(a.i()), glDisable: (_c, a) => g().disable(a.i()),
    glHint: (_c, a) => g().hint(a.i(), a.i()),
    glClearBufferfv: (_c, a) => { const b = a.i(), d = a.i(); g().clearBufferfv(b, d, f32(a.p(), b === 0x1800 ? 4 : 1)); },
    glClearBufferiv: (_c, a) => { const b = a.i(), d = a.i(); g().clearBufferiv(b, d, i32(a.p(), b === 0x1800 ? 4 : 1)); },
    glClearBufferuiv: (_c, a) => { const b = a.i(), d = a.i(); g().clearBufferuiv(b, d, u32(a.p(), 4)); },
    glClearBufferfi: (_c, a) => g().clearBufferfi(a.i(), a.i(), a.f(), a.i()),
    glStencilFuncSeparate: (_c, a) => g().stencilFuncSeparate(a.i(), a.i(), a.i(), a.i()), glStencilOpSeparate: (_c, a) => g().stencilOpSeparate(a.i(), a.i(), a.i(), a.i()),
    glStencilMaskSeparate: (_c, a) => g().stencilMaskSeparate(a.i(), a.i()),
    glPixelStorei: (_c, a) => { const pn = a.i(), v = a.i(); if (!pixelStoreAccepted(pn, v)) unsure(); pixelStore(g(), pn, v); },

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
        const rewrite = rewriteTextureSwizzles(externalSamplersAs2D(s, src), handle);
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
    glShaderBinary: () => { raise(0x500); },                                       // INVALID_ENUM: no binary formats
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
    glGetProgramBinary: (_c, a) => { a.i(); a.i(); const lenp = a.p(); if (lenp) mem.st32(lenp, 0); raise(0x502); },  // INVALID_OPERATION
    glProgramBinary: () => { raise(0x500); },
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
      const p = H(T().programs, a.i()), name = a.str(), [, base, index] = /^(.*?)(?:\[(\d+)\])?$/.exec(name)!;
      const rec = p && programRecs.get(p);
      if (rec && rec.hidden.has(base)) return -1;
      const u = p && g().getUniformLocation(p, name);
      if (!u) return -1;
      const binding = rec && rec.samplers.get(base);
      if (rec && binding) samplerSlots.set(u, { rec, binding, index: Number(index ?? 0) });
      return put(T().uniforms, u);
    },
    glGetActiveAttrib: active((p, i) => g().getActiveAttrib(p, i)),
    glGetActiveUniform: active((p, i) => { const rec = programRecs.get(p); return activeUniformInfo(g(), p, rec ? rec.uniforms.infos[i] ?? null : g().getActiveUniform(p, i)); }),
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
      let value = p && g().getActiveUniforms(p, indices, pn);
      if (p && value && pn === 0x8a37) value = Array.from(value as number[], (type, i) => type === 0x8b5e ? activeUniformInfo(g(), p, g().getActiveUniform(p, indices[i]))!.type : type); // UNIFORM_TYPE
      out(value, a.p(), st32, 4);
    },
    glTransformFeedbackVaryings: (_c, a) => { const p = H(T().programs, a.i()); const n = a.i(), pp = a.p(), mode = a.i(); if (p) g().transformFeedbackVaryings(p, names(pp, n), mode); },

    // ── buffers
    glGenBuffers: (_c, a) => { const n = a.i(); gen(T().buffers, n, a.p(), () => { const o = {} as WebGLBuffer; recOf.set(o, { gl: null, other: null, elem: null, shadow: null, usage: 0x88e4, size: 0 }); return o; }); },
    glDeleteBuffers: (_c, a) => {
      const n = a.i(), state = contextState();
      del(T().buffers, n, a.p(), (o) => {
        const r = recOf.get(o);
        if (!r) return;
        if (r.gl) g().deleteBuffer(r.gl);
        if (r.other) g().deleteBuffer(r.other);
        // as in GL, only this context's bindings and its current vertex array's element binding reset
        for (const [t, b] of state.buffers) if (b === r) state.buffers.set(t, null);
        if (state.elements.get(state.vao) === r) state.elements.set(state.vao, null);
      });
    },
    glIsBuffer: (_c, a) => (H(T().buffers, a.i()) ? 1 : 0),
    glBindBuffer: (_c, a) => {
      const t = a.i(), h = a.i();
      const r = rec(h);
      if (!BUFFER_TARGETS.has(t) || contextState().feedback) unsure();
      bindRec(t, r);
      if (t === COPY_READ || t === COPY_WRITE) return;
      g().bindBuffer(t, realize(t, r, h));
    },
    glBindBufferBase: (_c, a) => { const t = a.i(), i = a.i(), h = a.i(), r = rec(h); bindRec(t, r); g().bindBufferBase(t, i, realize(t, r, h)); },
    glBindBufferRange: (_c, a) => { const t = a.i(), i = a.i(), h = a.i(), r = rec(h); bindRec(t, r); const gl = realize(t, r, h); g().bindBufferRange(t, i, gl, a.i(), a.i()); },
    glBufferData: (_c, a) => {
      const t = a.i(), n = a.i(), p = a.p(), usage = a.i(), r = shadowed(t), bound = recAt(t), data = p ? u8(p, n) : null;
      const accepted = BUFFER_TARGETS.has(t) && !!bound && n >= 0 && USAGES.has(usage) && !contextState().feedback;
      if (!accepted) unsure();
      if (bound) bound.size = accepted ? data?.length ?? n : -1;
      if (r) { r.shadow = new Uint8Array(n); if (data) r.shadow.set(data); r.usage = usage; }
      else { if (bound) bound.usage = usage; writeBuffers(t, (tt) => { if (data) g().bufferData(tt, data, usage); else g().bufferData(tt, n, usage); }); }
    },
    glBufferSubData: (_c, a) => {
      const t = a.i(), off = a.i(), n = a.i(), p = a.p(), r = recAt(t), data = u8(p, n);
      if (!BUFFER_TARGETS.has(t) || !r || r.size < 0 || off < 0 || n < 0 || off + data.length > r.size || contextState().feedback) unsure();
      writeBack(t, off, data);
    },
    glCopyBufferSubData: (_c, a) => {
      const rt = a.i(), wt = a.i(), roff = a.i(), woff = a.i(), n = a.i(), rs = shadowed(rt);
      const src = rs ? rs.shadow!.subarray(roff, roff + n) : withTarget(rt, (tt) => { const d = new Uint8Array(n); g().getBufferSubData(tt, roff, d); return d; });
      writeBack(wt, woff, src);
    },
    // a mapping is a guest copy of the range: read in on map, written back on unmap or flush
    glMapBufferRange: (_c, a) => {
      const t = a.i(), off = a.i(), len = a.i(), access = a.i(), b = recAt(t);
      if (!b) { raise(0x502); return 0; }
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
    glBindVertexArray: (_c, a) => { const vao = H(T().vaos, a.i()); g().bindVertexArray(vao); contextState().vao = vao; },
    glEnableVertexAttribArray: (_c, a) => { const i = a.i(), state = contextState(); g().enableVertexAttribArray(i); if (!state.vao && i < state.enabled.length) state.enabled[i] = 1; },
    glDisableVertexAttribArray: (_c, a) => { const i = a.i(), state = contextState(); g().disableVertexAttribArray(i); if (!state.vao && i < state.enabled.length) state.enabled[i] = 0; },
    glVertexAttribPointer: (_c, a) => vertexAttribPointer(false, a.i(), a.i(), a.i(), !!(a.i() & 255), a.i(), a.p()),
    glVertexAttribIPointer: (_c, a) => vertexAttribPointer(true, a.i(), a.i(), a.i(), false, a.i(), a.p()),
    glVertexAttribDivisor: (_c, a) => { const i = a.i(), d = a.u(), state = contextState(); g().vertexAttribDivisor(i, d); if (!state.vao && i < state.divisors.length) state.divisors[i] = d; },
    glVertexAttrib1f: (_c, a) => g().vertexAttrib1f(a.i(), a.f()), glVertexAttrib2f: (_c, a) => g().vertexAttrib2f(a.i(), a.f(), a.f()),
    glVertexAttrib3f: (_c, a) => g().vertexAttrib3f(a.i(), a.f(), a.f(), a.f()), glVertexAttrib4f: (_c, a) => g().vertexAttrib4f(a.i(), a.f(), a.f(), a.f(), a.f()),
    glVertexAttrib1fv: (_c, a) => g().vertexAttrib1fv(a.i(), f32(a.p(), 1)), glVertexAttrib2fv: (_c, a) => g().vertexAttrib2fv(a.i(), f32(a.p(), 2)),
    glVertexAttrib3fv: (_c, a) => g().vertexAttrib3fv(a.i(), f32(a.p(), 3)), glVertexAttrib4fv: (_c, a) => g().vertexAttrib4fv(a.i(), f32(a.p(), 4)),
    glVertexAttribI4i: (_c, a) => g().vertexAttribI4i(a.i(), a.i(), a.i(), a.i(), a.i()), glVertexAttribI4ui: (_c, a) => g().vertexAttribI4ui(a.i(), a.u(), a.u(), a.u(), a.u()),
    glVertexAttribI4iv: (_c, a) => g().vertexAttribI4iv(a.i(), i32(a.p(), 4)), glVertexAttribI4uiv: (_c, a) => g().vertexAttribI4uiv(a.i(), u32(a.p(), 4)),
    glGetVertexAttribPointerv: (_c, a) => {
      const i = a.i(), pn = a.i(), client = pn === 0x8645 && clientArray(contextState(), i);
      stp(a.p(), client ? client.ptr : g().getVertexAttribOffset(i, pn));
    },

    // ── draws
    // the default vertex array's client arrays are all that needs more than the WebGL call
    glDrawArrays: (_c, a) => {
      const mode = a.i(), first = a.i(), count = a.i(), state = draw();
      if (!state.vao && state.clients.size) drawClientArrays(state, first, count, 1);
      g().drawArrays(mode, first, count);
    },
    glDrawArraysInstanced: (_c, a) => {
      const mode = a.i(), first = a.i(), count = a.i(), n = a.i(), state = draw();
      if (!state.vao && state.clients.size) drawClientArrays(state, first, count, n);
      g().drawArraysInstanced(mode, first, count, n);
    },
    glDrawElements: (_c, a) => {
      const mode = a.i(), count = a.i(), type = a.i(), p = a.p(), state = draw();
      if (state.vao || (state.elements.get(null) && !state.clients.size)) g().drawElements(mode, count, type, p);
      else drawClientElements(state, count, type, p, 1, null, (at) => g().drawElements(mode, count, type, at));
    },
    glDrawElementsInstanced: (_c, a) => {
      const mode = a.i(), count = a.i(), type = a.i(), p = a.p(), n = a.i(), state = draw();
      if (state.vao || (state.elements.get(null) && !state.clients.size)) g().drawElementsInstanced(mode, count, type, p, n);
      else drawClientElements(state, count, type, p, n, null, (at) => g().drawElementsInstanced(mode, count, type, at, n));
    },
    glDrawRangeElements: (_c, a) => {
      const mode = a.i(), start = a.i(), end = a.i(), count = a.i(), type = a.i(), p = a.p(), state = draw();
      if (state.vao || (state.elements.get(null) && !state.clients.size)) g().drawRangeElements(mode, start, end, count, type, p);
      else drawClientElements(state, count, type, p, 1, [start, end], (at) => g().drawRangeElements(mode, start, end, count, type, at));
    },

    // ── textures and samplers
    glActiveTexture: (_c, a) => {
      const texture = a.i(), state = contextState();
      g().activeTexture(texture);
      if (texture >= TEXTURE0 && texture < TEXTURE0 + state.limits[0]) state.activeUnit = texture - TEXTURE0; else unsure();
    },
    glGenTextures: (_c, a) => { const n = a.i(); gen(T().textures, n, a.p(), () => { const texture = g().createTexture(); if (texture) textureRec(texture).target = 0; return texture; }); },
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
      const target = textureTarget(a.i()), texture = H(T().textures, a.i()), state = contextState();
      g().bindTexture(target, texture);
      const rec = texture && texRecs.get(texture);
      let unit = state.bindings.get(state.activeUnit);
      if (!unit) { unit = new Map(); state.bindings.set(state.activeUnit, unit); }
      // a texture takes its target at its first bind; WebGL refuses another one
      if (!TEXTURE_TARGETS.has(target) || (texture && (!rec || rec.deleted || (rec.target !== 0 && rec.target !== target)))) {
        unsure();
        if (unit.delete(target)) state.revision++;
        return;
      }
      if (rec && !rec.target) rec.target = target;
      if (unit.get(target) !== texture) { unit.set(target, texture); state.revision++; }
    },
    glTexImage2D: (_c, a) => {
      const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(), b = a.i(), fmt = a.i(), ty = a.i(), p = a.p();
      if (!imageAccepted(t, l, f, w, h, b, fmt, ty, p)) untrust(t >= 0x8515 && t <= 0x851a ? 0x8513 : t);
      (g().texImage2D as Function)(t, l, f, w, h, b, fmt, ty, texData(ty, p, fmt, [w, h]));
    },
    glTexSubImage2D: (_c, a) => {
      const t = a.i(), l = a.i(), x = a.i(), y = a.i(), w = a.i(), h = a.i(), fmt = a.i(), ty = a.i(), p = a.p();
      if (!subImageAccepted(t, l, x, y, w, h, fmt, ty, p)) unsure();
      (g().texSubImage2D as Function)(t, l, x, y, w, h, fmt, ty, texData(ty, p, fmt, [w, h]));
    },
    glTexImage3D: (_c, a) => { const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(), d = a.i(), b = a.i(), fmt = a.i(), ty = a.i(); (g().texImage3D as Function)(t, l, f, w, h, d, b, fmt, ty, texData(ty, a.p(), fmt, [w, h, d])); },
    glTexSubImage3D: (_c, a) => { const t = a.i(), l = a.i(), x = a.i(), y = a.i(), z = a.i(), w = a.i(), h = a.i(), d = a.i(), fmt = a.i(), ty = a.i(); (g().texSubImage3D as Function)(t, l, x, y, z, w, h, d, fmt, ty, texData(ty, a.p(), fmt, [w, h, d])); },
    glCompressedTexImage2D: (_c, a) => {
      const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(); a.i(); const n = a.i(), p = a.p();
      const gl = glForTextureFormat(f);
      if (pbo(UNPACK)) gl.compressedTexImage2D(t, l, f, w, h, 0, n, p); else gl.compressedTexImage2D(t, l, f, w, h, 0, u8(p, n));
    },
    glCompressedTexSubImage2D: (_c, a) => {
      const t = a.i(), l = a.i(), x = a.i(), y = a.i(), w = a.i(), h = a.i(), f = a.i(), n = a.i(), p = a.p();
      const gl = glForTextureFormat(f);
      if (pbo(UNPACK)) gl.compressedTexSubImage2D(t, l, x, y, w, h, f, n, p); else gl.compressedTexSubImage2D(t, l, x, y, w, h, f, u8(p, n));
    },
    glCompressedTexImage3D: (_c, a) => {
      const t = a.i(), l = a.i(), f = a.i(), w = a.i(), h = a.i(), d = a.i(); a.i(); const n = a.i(), p = a.p();
      const gl = glForTextureFormat(f);
      if (pbo(UNPACK)) gl.compressedTexImage3D(t, l, f, w, h, d, 0, n, p); else gl.compressedTexImage3D(t, l, f, w, h, d, 0, u8(p, n));
    },
    glCompressedTexSubImage3D: (_c, a) => {
      const t = a.i(), l = a.i(), x = a.i(), y = a.i(), z = a.i(), w = a.i(), h = a.i(), d = a.i(), f = a.i(), n = a.i(), p = a.p();
      const gl = glForTextureFormat(f);
      if (pbo(UNPACK)) gl.compressedTexSubImage3D(t, l, x, y, z, w, h, d, f, n, p); else gl.compressedTexSubImage3D(t, l, x, y, z, w, h, d, f, u8(p, n));
    },
    glTexStorage2D: (_c, a) => {
      const target = a.i(), levels = a.i(), format = a.i(), width = a.i(), height = a.i(), gl = glForTextureFormat(format);
      const rec = storageAccepted(target, levels, format, width, height);
      if (rec) Object.assign(rec, { immutable: true, format, width, height, levels }); else untrust(target);
      gl.texStorage2D(target, levels, format, width, height);
    },
    glTexStorage3D: (_c, a) => {
      const target = a.i(), levels = a.i(), format = a.i(), width = a.i(), height = a.i(), depth = a.i(), gl = glForTextureFormat(format);
      gl.texStorage3D(target, levels, format, width, height, depth);
    },
    glCopyTexSubImage3D: (_c, a) => g().copyTexSubImage3D(a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i(), a.i()),
    glGenerateMipmap: (_c, a) => g().generateMipmap(a.i()),
    glBindSampler: (_c, a) => g().bindSampler(a.i(), H(T().samplers, a.i())),

    // ── framebuffers and renderbuffers
    glBindFramebuffer: (_c, a) => g().bindFramebuffer(a.i(), H(T().fbos, a.i())),
    glFramebufferTexture2D: (_c, a) => g().framebufferTexture2D(a.i(), a.i(), textureTarget(a.i()), H(T().textures, a.i()), a.i()),
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
      if (pbo(PACK)) { g().readPixels(x, y, w, h, f, ty, p); syncVertexBuffer(recAt(PACK)); } else readGuestPixels(g(), x, y, w, h, f, ty, p);
    },
    glBindRenderbuffer: (_c, a) => {
      const t = a.i(), rbo = H(T().rbos, a.i());
      if (t === 0x8d41) contextState().renderbuffer = rbo; else unsure();
      g().bindRenderbuffer(t, rbo);
    },
    glRenderbufferStorage: (_c, a) => {
      const t = a.i(), f = a.i(), w = a.i(), h = a.i(), state = contextState(), max = state.limits[3];
      if (t !== 0x8d41 || !state.renderbuffer || !RENDERBUFFER_FORMATS.has(f) || w < 0 || h < 0 || w > max || h > max) unsure();
      g().renderbufferStorage(t, f, w, h);
    },
    glRenderbufferStorageMultisample: (_c, a) => g().renderbufferStorageMultisample(a.i(), a.i(), a.i(), a.i(), a.i()),
    glGetRenderbufferParameteriv: (_c, a) => { const t = a.i(), pn = a.i(); out(g().getRenderbufferParameter(t, pn), a.p(), st32, 4); },

    // ── queries, sync, transform feedback
    glBeginQuery: (_c, a) => { const t = a.i(), q = H(T().queries, a.i()); if (q) g().beginQuery(t, q); },
    glEndQuery: (_c, a) => g().endQuery(a.i()),
    glGetQueryiv: (_c, a) => { const t = a.i(), pn = a.i(); out(g().getQuery(t, pn), a.p(), st32, 4); },
    glGetQueryObjectuiv: (_c, a) => { const q = H(T().queries, a.i()); const pn = a.i(); out(q && g().getQueryParameter(q, pn), a.p(), st32, 4); },
    glFenceSync: (_c, a) => { const condition = a.i(), flags = a.i(); if (condition !== 0x9117 || flags) unsure(); return put(T().syncs, g().fenceSync(condition, flags)); },
    glIsSync: (_c, a) => (H(T().syncs, a.i()) ? 1 : 0),
    glDeleteSync: (_c, a) => { const h = a.i(), s = T().syncs[h]; if (s) { g().deleteSync(s); T().syncs[h] = null; } },
    glWaitSync: (_c, a) => { const s = H(T().syncs, a.i()); if (s) g().waitSync(s, 0, -1); },
    // a wait longer than the fence takes is spent yielding, one macrotask per look
    glClientWaitSync: async (_c, a) => {
      const s = H(T().syncs, a.i()); const flags = a.i(), until = performance.now() + Number(a.ul()) / 1e6;
      if (!s) return 0x911d;                                                    // WAIT_FAILED
      const context = g();
      let r = context.clientWaitSync(s, flags, 0);
      while (r === 0x911b && performance.now() < until) { await yieldToLoop(); r = context.clientWaitSync(s, 0, 0); }
      return r;
    },
    glGetSynciv: (_c, a) => { const s = H(T().syncs, a.i()); const pn = a.i(); a.i(); const lenp = a.p(); if (lenp) mem.st32(lenp, 1); out(s && g().getSyncParameter(s, pn), a.p(), st32, 4); },
    glBindTransformFeedback: (_c, a) => g().bindTransformFeedback(a.i(), H(T().tfs, a.i())),
    glBeginTransformFeedback: (_c, a) => { contextState().feedback = true; g().beginTransformFeedback(a.i()); }, glEndTransformFeedback: () => { g().endTransformFeedback(); syncFeedback(); },
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
  G.glDeleteRenderbuffers = (_c, a) => { const n = a.i(); del(T().rbos, n, a.p(), (o: WebGLRenderbuffer) => g().deleteRenderbuffer(o)); contextState().renderbuffer = undefined; };
  G.glDeleteVertexArrays = (_c, a) => {
    const n = a.i(), state = contextState();
    // deleting the bound vertex array rebinds the default one, with its element binding
    del(T().vaos, n, a.p(), (vao: WebGLVertexArrayObject) => { g().deleteVertexArray(vao); state.elements.delete(vao); if (state.vao === vao) state.vao = null; });
  };
  for (const [s, st, bpe] of [["Integer", st32, 4], ["Integer64", st64, 8], ["Float", stf, 4], ["Boolean", st8, 1]] as const) G[`glGet${s}v`] = (_c, a) => { const n = a.i(); out(param(n), a.p(), st, bpe); };
  for (const [s, st, bpe] of [["iv", st32, 4], ["i64v", st64, 8]] as const) {
    G[`glGetBufferParameter${s}`] = (_c, a) => { const t = a.i(), pn = a.i(), r = shadowed(t); out(r ? (pn === 0x8765 ? r.usage : r.shadow!.length) : withTarget(t, (tt) => g().getBufferParameter(tt, pn)), a.p(), st, bpe); };
  }
  for (const [s, st] of [["iv", st32], ["fv", stf]] as const) {
    G[`glGetTexParameter${s}`] = (_c, a) => { const t = textureTarget(a.i()), pn = a.i(); out(texParameter(t, pn), a.p(), st, 4); };
    G[`glGetSamplerParameter${s}`] = (_c, a) => { const smp = H(T().samplers, a.i()); const pn = a.i(); out(smp && g().getSamplerParameter(smp, pn), a.p(), st, 4); };
  }
  for (const [s, st] of [["f", stf], ["i", st32], ["ui", st32]] as const) G[`glGetUniform${s}v`] = (_c, a) => { const p = H(T().programs, a.i()), u = U(a.i()); out(p && u && g().getUniform(p, u), a.p(), st, 4); };
  for (const [s, st] of [["fv", stf], ["iv", st32], ["Iiv", st32], ["Iuiv", st32]] as const) G[`glGetVertexAttrib${s}`] = (_c, a) => {
    const i = a.i(), pn = a.i();
    // a client array's attribute reads a stream buffer in WebGL, and none in GL
    out(pn === 0x889f && clientArray(contextState(), i) ? 0 : g().getVertexAttrib(i, pn), a.p(), st, 4);
  };
  const I = (a: ArgReader) => a.i(), LD = (a: ArgReader) => mem.ld32(a.p()), F = (a: ArgReader) => a.f(), LDF = (a: ArgReader) => mem.ldf32(a.p());
  for (const [s, read, int] of [["i", I, true], ["f", F, false], ["iv", LD, true], ["fv", LDF, false]] as const) {
    G[`glTexParameter${s}`] = (_c, a) => { const t = textureTarget(a.i()), pn = a.i(); (int ? texParam : texParamf)(t, pn, read(a)); };
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
      if (sampler) setSamplerUnits(u, [x]);
    };
    G[`glUniform${n}${k}v`] = (_c, a) => {
      const u = U(a.i()), cnt = a.i(), p = a.p();
      if (!u) return;
      const values = vw(p, cnt * n);
      setv().call(g(), u, values);
      if (sampler) setSamplerUnits(u, values);
    };
  }
  for (const [m, e] of [["2", 4], ["3", 9], ["4", 16], ["2x3", 6], ["3x2", 6], ["2x4", 8], ["4x2", 8], ["3x4", 12], ["4x3", 12]] as const) {
    const set = method(`uniformMatrix${m}fv`);
    G[`glUniformMatrix${m}fv`] = (_c, a) => { const u = U(a.i()), cnt = a.i(), t = !!(a.i() & 255), p = a.p(); if (u) set().call(g(), u, t, f32(p, cnt * e)); };
  }
  // libEGL turns a call with no current context into a logged no-op; it never faults the thread
  // (MapLibre deletes its textures on a GLThread whose context is already released)
  const noContext = new WeakSet<object>();
  for (const [name, fn] of Object.entries(G)) G[name] = TRACKED.has(name) ? (cpu, args) => {
    activateEglCurrent(cpu.jthread);
    if (current) return fn(cpu, args);
    return noCurrent(cpu, name);
  } : (cpu, args) => {
    activateEglCurrent(cpu.jthread);
    if (current) { T().clean = false; return fn(cpu, args); }
    return noCurrent(cpu, name);
  };
  function noCurrent(cpu: Parameters<HostFn>[0], name: string): number {
    if (!noContext.has(cpu.jthread)) { noContext.add(cpu.jthread); console.warn(`[gl] ${name}: call to OpenGL ES API with no current context`); }
    return 0;
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
  if (!texParamAccepted(t, pn, v)) unsure();
  g().texParameteri(t, pn, v);
}

function texParamf(t: number, pn: number, v: number): void {
  if (pn >= 0x8e42 && pn <= 0x8e45) { setSwizzle(t, pn, Math.trunc(v)); return; }
  unsure();
  g().texParameterf(t, pn, v);
}

function setSwizzle(target: number, pname: number, value: number): void {
  const selector = value === 0 ? 4 : value === 1 ? 5 : value >= 0x1903 && value <= 0x1906 ? value - 0x1903 : -1;
  if (selector < 0) { raise(0x500); return; }                                     // INVALID_ENUM
  const state = contextState(), texture = boundTexture(state, state.activeUnit, target);
  if (!texture) { raise(0x502); return; }                                         // INVALID_OPERATION
  const rec = textureRec(texture), channel = pname - 0x8e42;
  if (rec.channels[channel] === selector) return;
  rec.channels[channel] = selector;
  rec.code = rec.channels[0] | (rec.channels[1] << 3) | (rec.channels[2] << 6) | (rec.channels[3] << 9);
  state.revision++;
}

function texParameter(target: number, pname: number): unknown {
  if (pname < 0x8e42 || pname > 0x8e45) return g().getTexParameter(target, pname);
  const state = contextState(), texture = boundTexture(state, state.activeUnit, target);
  if (!texture) { raise(0x502); return 0; }
  const selector = textureRec(texture).channels[pname - 0x8e42];
  return selector < 4 ? 0x1903 + selector : selector === 4 ? 0 : 1;
}
