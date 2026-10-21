// Buffer records: a GL buffer's kind (element or not) is decided at its first typed bind, its data
// shadowed until then; WebGL forbids sharing index and vertex storage, so a buffer bound both ways
// keeps a copy of each.

import { tables as T } from "./gl-context.ts";
import { g, H, contextState } from "./gles3-state.ts";

/** `size`: the data store's bytes as WebGL holds them, -1 when not known; `mirror`: its contents on the
 *  host once a mapping needed them, kept by each write so later mappings read nothing back */
export interface BufRec { gl: WebGLBuffer | null; other: WebGLBuffer | null; elem: boolean | null; shadow: Uint8Array | null; mirror: Uint8Array | null; usage: number; size: number }
export const COPY_READ = 0x8f36, COPY_WRITE = 0x8f37, ELEM = 0x8893, ARRAY = 0x8892;
export const recOf = new WeakMap<object, BufRec>();
export const rec = (h: number): BufRec | null => { const o = H(T().buffers, h); return o ? recOf.get(o) ?? null : null; };
export function recAt(t: number): BufRec | null {
  const state = contextState();
  return (t === ELEM ? state.elements.get(state.vao) : state.buffers.get(t)) ?? null;
}
export function bindRec(t: number, r: BufRec | null): void {
  const state = contextState();
  if (t === ELEM) state.elements.set(state.vao, r); else state.buffers.set(t, r);
}
/** the WebGL storage a record presents at ARRAY_BUFFER or ELEMENT_ARRAY_BUFFER */
const storage = (r: BufRec | null, elem: boolean): WebGLBuffer | null => (r ? (r.elem === elem ? r.gl : r.other) : null);
/** what WebGL has bound at ARRAY_BUFFER or ELEMENT_ARRAY_BUFFER */
export const boundStorage = (t: number): WebGLBuffer | null => storage(recAt(t), t === ELEM);
/** the record behind a data target while its kind is undecided: writes land in the shadow */
export const shadowed = (t: number): BufRec | null => { if (t !== COPY_READ && t !== COPY_WRITE) return null; const r = recAt(t); return r && r.elem === null ? r : null; };
/** run an operation on a data target: a copy target stands in for the buffer's own kind, binding restored */
export function withTarget<R>(t: number, fn: (tt: number) => R): R {
  if (t !== COPY_READ && t !== COPY_WRITE) return fn(t);
  const gl = g();
  const r = recAt(t), tt = r?.elem ? ELEM : ARRAY;
  gl.bindBuffer(tt, r?.gl ?? null);
  try { return fn(tt); } finally { gl.bindBuffer(tt, boundStorage(tt)); }
}
export function writeBuffers(t: number, fn: (target: number) => void): void {
  withTarget(t, fn);
  const r = recAt(t);
  if (!r?.other) return;
  const gl = g();
  const elem = t === COPY_READ || t === COPY_WRITE ? r.elem : t === ELEM;
  const target = elem ? ARRAY : ELEM;
  gl.bindBuffer(target, storage(r, target === ELEM));
  try { fn(target); } finally { gl.bindBuffer(target, boundStorage(target)); }
}
export function writeBack(t: number, off: number, data: Uint8Array): void {
  const r = shadowed(t);
  if (r) { r.shadow!.set(data, off); return; }
  recAt(t)?.mirror?.set(data, off);
  writeBuffers(t, (tt) => g().bufferSubData(tt, off, data));
}
/** the contents of the buffer bound to `t` */
export const contents = (t: number, r: BufRec): Uint8Array => shadowed(t)?.shadow ?? (r.mirror ??= withTarget(t, (tt) => readBound(g(), tt)));
/** the whole of the buffer bound to `target`, read back (WebGL copies nothing between index and vertex storage) */
function readBound(gl: WebGL2RenderingContext, target: number): Uint8Array {
  const data = new Uint8Array(gl.getBufferParameter(target, gl.BUFFER_SIZE));
  gl.getBufferSubData(target, 0, data);
  return data;
}
export function realize(t: number, r: BufRec | null, h: number): WebGLBuffer | null {
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
    const data = readBound(gl, target);
    gl.bindBuffer(target, boundStorage(target));
    r.other = gl.createBuffer();
    if (r.other) { recOf.set(r.other, r); T().ids.set(r.other, h); }
    gl.bindBuffer(t, r.other); gl.bufferData(t, data, r.usage);
  }
  return r.other;
}

/** after GL wrote a buffer's vertex storage, refresh its index copy and forget its mirror */
export function syncVertexBuffer(r: BufRec | null | undefined): void {
  if (r) r.mirror = null;
  if (!r?.other) return;
  const gl = g();
  gl.bindBuffer(ARRAY, storage(r, false));
  const data = readBound(gl, ARRAY);
  gl.bindBuffer(ELEM, storage(r, true));
  gl.bufferSubData(ELEM, 0, data);
  gl.bindBuffer(ARRAY, boundStorage(ARRAY)); gl.bindBuffer(ELEM, boundStorage(ELEM));
}

/** transform feedback wrote its buffers' vertex storage */
export function syncFeedback(): void {
  const n = g().getParameter(0x8c8b);
  for (let i = 0; i < n; i++) { const buffer = g().getIndexedParameter(0x8c8f, i); syncVertexBuffer(buffer && recOf.get(buffer)); }
}
