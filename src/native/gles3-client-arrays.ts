// Client arrays: the default vertex array reads attributes and indices from guest memory at the
// draw, which WebGL cannot, so each draw streams what it reaches into reused buffers.

import { mem } from "./mem.ts";
import { raise } from "./gl-context.ts";
import { g, contextState, type ContextState, type ClientArray } from "./gles3-state.ts";
import { view, u32, u8 } from "./gles3-pixels.ts";
import { recAt, boundStorage, contents, ARRAY, ELEM } from "./gles3-buffers.ts";

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

export function vertexAttribPointer(integer: boolean, i: number, size: number, type: number, normalized: boolean, stride: number, ptr: number): void {
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
export const clientArray = (state: ContextState, i: number): ClientArray | undefined => (state.vao ? undefined : state.clients.get(i));

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
    const start = spans[k].start, data = mem.bytes(start, end - start);
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

export function drawClientArrays(state: ContextState, first: number, count: number, instances: number): void {
  if (count > 0 && instances > 0 && clientUse(state)) streamClientArrays(state, first, first + count, instances);
}

/**
 * An indexed draw in the default vertex array. Client indices are streamed into a reused element
 * buffer. The vertex range comes from client indices, else from glDrawRangeElements' own range,
 * else from the bound element buffer's contents, read back once and then kept by its writes.
 */
export function drawClientElements(state: ContextState, count: number, type: number, p: number, instances: number,
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
        const data = contents(ELEM, elements!), K = type === 0x1405 ? Uint32Array : type === 0x1403 ? Uint16Array : Uint8Array;
        // WebGL refuses an offset that is not a multiple of the index size
        if (p % K.BYTES_PER_ELEMENT === 0 && p + count * K.BYTES_PER_ELEMENT <= data.length) bounds = indexBounds(new K(data.buffer as ArrayBuffer, data.byteOffset + p, count));
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
