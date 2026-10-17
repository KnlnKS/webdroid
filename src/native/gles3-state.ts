// The state gles3 keeps beside WebGL for each context: texture records (swizzles, and what is known
// of each texture's binding and storage), programs' sampler maps for texture swizzles, the buffer
// and vertex array bindings, and the default vertex array's client arrays.

import { gl as current } from "../android/gl.ts";
import { uniformBase, visibleUniforms, IDENTITY_SWIZZLE, type SwizzleRewrite, type VisibleUniforms } from "./swizzle.ts";
import type { BufRec } from "./gles3-buffers.ts";

export type GL = WebGL2RenderingContext;
export const g = (): GL => { if (!current) throw new Error("GL call without a current context"); return current as GL; };
/** a handle's object in one of the context's tables; 0 is none */
export const H = <O extends object>(tbl: (O | null)[], h: number): O | null => (h ? tbl[h] ?? null : null);

export const TEXTURE0 = 0x84c0;
const ACTIVE_TEXTURE = 0x84e0, CURRENT_PROGRAM = 0x8b8d;
const ETC2_EAC_FIRST = 0x9270, ETC2_EAC_LAST = 0x9279;
const etc2Contexts = new WeakSet<GL>();
export function glForTextureFormat(format: number): GL {
  const gl = g();
  if (format >= ETC2_EAC_FIRST && format <= ETC2_EAC_LAST && !etc2Contexts.has(gl)) {
    // WebGL gates GLES3-core ETC2/EAC formats behind extension activation.
    gl.getExtension("WEBGL_compressed_texture_etc");
    etc2Contexts.add(gl);
  }
  return gl;
}
export const shaderRecs = new WeakMap<WebGLShader, { original: string; rewrite: SwizzleRewrite }>();
export interface TexImage { width: number; height: number; internal: number; format: number; type: number }
/** a texture's storage: immutable `levels` of `format` from width x height, or the levels
 *  glTexImage2D specified, by face target and level (imageKey) */
export type Storage = { immutable: true; format: number; width: number; height: number; levels: number } | { immutable: false; images: Map<number, TexImage> };
/** what is known of a texture for judging whether WebGL accepts a call on it: nothing (made
 *  elsewhere, or changed by a call WebGL may have rejected), not yet bound (glGenTextures made it),
 *  or its target and storage */
export type Tracking = { kind: "unknown" } | { kind: "unbound" } | Bound;
export type Bound = { kind: "bound"; target: number; storage: Storage };
export interface TexRec { channels: [number, number, number, number]; code: number; deleted: boolean; tracking: Tracking }
export const UNKNOWN: Tracking = { kind: "unknown" }, UNBOUND: Tracking = { kind: "unbound" };
export const imageKey = (target: number, level: number): number => target * 32 + level;
export const texRecs = new WeakMap<WebGLTexture, TexRec>();
interface SamplerBinding { target: number; units: Int32Array }
interface ProgramMap { binding: SamplerBinding; location: WebGLUniformLocation; pending: Int32Array; uploaded: Int32Array }
interface ProgramRec {
  hidden: ReadonlySet<string>;
  uniforms: VisibleUniforms;
  samplers: ReadonlyMap<string, SamplerBinding>;
  maps: ProgramMap[];
  bindingRevision: number;
}
export const programRecs = new WeakMap<WebGLProgram, ProgramRec>();
/** a guest uniform location naming a swizzled sampler: the program's record, its binding and element */
export const samplerSlots = new WeakMap<WebGLUniformLocation, { rec: ProgramRec; binding: SamplerBinding; index: number }>();
export interface ContextState {
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
export interface ClientArray { size: number; type: number; normalized: boolean; stride: number; ptr: number; integer: boolean }
const contextStates = new WeakMap<GL, ContextState>();

export function contextState(): ContextState {
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

export function textureRec(texture: WebGLTexture): TexRec {
  let rec = texRecs.get(texture);
  if (!rec) { rec = { channels: [0, 1, 2, 3], code: IDENTITY_SWIZZLE, deleted: false, tracking: UNKNOWN }; texRecs.set(texture, rec); }
  return rec;
}
/** GL_TEXTURE_EXTERNAL_OES names TEXTURE_2D: SurfaceTexture fills its texture as 2D storage */
export const textureTarget = (target: number): number => (target === 0x8d65 ? 0x0de1 : target);
/** the samplerExternalOES uniforms each shader declared */
const externalSamplers = new WeakMap<WebGLShader, Set<string>>();
/** WebGL has no external samplers, so a shader's samplerExternalOES reads that storage as a
 *  sampler2D; the #extension line is blanked in place to keep compile errors' line numbers, in
 *  every stage that requires it, sampler or not. */
export function externalSamplersAs2D(shader: WebGLShader, source: string): string {
  if (!source.includes("GL_OES_EGL_image_external")) { externalSamplers.delete(shader); return source; }
  externalSamplers.set(shader, new Set(Array.from(source.matchAll(/\bsamplerExternalOES\s+(\w+)/g), (m) => m[1])));
  return source.replace(/^[ \t]*#extension[ \t]+GL_OES_EGL_image_external(?:_essl3)?[ \t]*:.*$/gm, "").replace(/\bsamplerExternalOES\b/g, "sampler2D");
}
/** glGetActiveUniform's view: a sampler2D the program's shaders declared samplerExternalOES
 *  reports SAMPLER_EXTERNAL_OES */
export function activeUniformInfo(gl: WebGL2RenderingContext | WebGLRenderingContext, program: WebGLProgram, info: WebGLActiveInfo | null): WebGLActiveInfo | null {
  if (info?.type !== 0x8b5e) return info;
  const name = uniformBase(info);
  for (const shader of gl.getAttachedShaders(program) ?? []) {
    if (externalSamplers.get(shader)?.has(name)) return { name: info.name, size: info.size, type: 0x8d66 };
  }
  return info;
}
const bindingName = (target: number): number => target === 0x0de1 ? 0x8069 : target === 0x8513 ? 0x8514 : target === 0x806f ? 0x806a : target === 0x8c1a ? 0x8c1d : 0;
export function boundTexture(state: ContextState, unit: number, target: number): WebGLTexture | null {
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

export function linkProgram(program: WebGLProgram): void {
  const gl = g();
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { programRecs.delete(program); return; }
  const rewrites = (gl.getAttachedShaders(program) ?? []).map((shader) => shaderRecs.get(shader)?.rewrite).filter((r): r is SwizzleRewrite => !!r);
  const hidden = new Set(rewrites.flatMap((rewrite) => [...rewrite.hidden]));
  if (!hidden.size) { programRecs.delete(program); return; }
  const uniforms = visibleUniforms(gl, program, hidden);
  const infoByName = new Map(uniforms.infos.map((info) => [uniformBase(info), info]));
  const bindingsByName = new Map<string, SamplerBinding>();
  const maps: ProgramMap[] = [];
  const rawCount = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  const rawInfo = new Map<string, WebGLActiveInfo>();
  for (let i = 0; i < rawCount; i++) {
    const info = gl.getActiveUniform(program, i);
    if (info) rawInfo.set(uniformBase(info), info);
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

export function prepareDraw(): ContextState {
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
export function setSamplerUnits(u: WebGLUniformLocation, units: ArrayLike<number>): void {
  const slot = samplerSlots.get(u);
  if (!slot) return;
  const { binding, index } = slot;
  for (let i = 0; i < units.length && index + i < binding.units.length; i++) binding.units[index + i] = units[i];
  slot.rec.bindingRevision = -1;
}
/** a buffer is bound at PIXEL_PACK_BUFFER or PIXEL_UNPACK_BUFFER */
export const pbo = (t: number): boolean => !!contextState().buffers.get(t);

