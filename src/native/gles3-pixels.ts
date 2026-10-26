// Pixel data in guest memory: typed views over it, the pixel-store state an upload or readback
// reads (tracked here, since glGetIntegerv waits for the GPU), and the extents uploads read.

import { mem, wrote } from "./mem.ts";
import { g, pbo } from "./gles3-state.ts";

type Ctor<A> = { new (b: ArrayBuffer, off: number, n: number): A; new (b: ArrayBuffer): A; BYTES_PER_ELEMENT: number };
/** a typed view over guest memory; a misaligned pointer is copied, which GL data rarely is */
export function view<A extends ArrayBufferView>(K: Ctor<A>, p: number, n: number): A {
  const bpe = K.BYTES_PER_ELEMENT;
  const b = mem.bytes(p, n * bpe);
  return b.byteOffset % bpe ? new K(b.slice().buffer) : new K(b.buffer as ArrayBuffer, b.byteOffset, n);
}
export const i32 = (p: number, n: number) => view(Int32Array, p, n);
export const u32 = (p: number, n: number) => view(Uint32Array, p, n);
export const f32 = (p: number, n: number) => view(Float32Array, p, n);
export const u8 = (p: number, n: number) => mem.bytes(p, n);
export function pixelArray(type: number): Ctor<ArrayBufferView> {
  return type === 0x1406 ? Float32Array : type === 0x1404 ? Int32Array : type === 0x1402 ? Int16Array : type === 0x1400 ? Int8Array
    : type === 0x1401 ? Uint8Array : (type === 0x1403 || type === 0x140b || type === 0x8d61 || type === 0x8033 || type === 0x8034 || type === 0x8363) ? Uint16Array : Uint32Array;
}
/** the data of a call whose size is not computable (an unknown format or type, a negative or empty extent): WebGL
 *  refuses or reads nothing before it would read past the view's type, which still picks its error */
const pixels = (type: number, p: number): ArrayBufferView => view(pixelArray(type), p, 0);
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
export const ALIGNMENTS = [1, 2, 4, 8];
export function pixelStore(gl: WebGLRenderingContext | WebGL2RenderingContext, pname: number, value: number): void {
  gl.pixelStorei(pname, value);
  const alignment = pname === 0x0cf5 || pname === 0x0d05;
  if (alignment ? !ALIGNMENTS.includes(value) : value < 0 || !("UNPACK_ROW_LENGTH" in gl)) return;
  let store = pixelStores.get(gl);
  if (!store) pixelStores.set(gl, store = new Map());
  store.set(pname, value);
}
export const pixelParam = (gl: WebGLRenderingContext | WebGL2RenderingContext, pname: number): number =>
  pixelStores.get(gl)?.get(pname) ?? (pname === 0x0cf5 || pname === 0x0d05 ? 4 : 0);
type PixelDimensions = readonly [width: number, height: number] | readonly [width: number, height: number, depth: number];
/** the bytes an upload reads from its pointer under the unpack state, -1 when not computable */
export function uploadExtent(type: number, format: number, dimensions: PixelDimensions): number {
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
  return view(K, p, Math.floor(required / K.BYTES_PER_ELEMENT));
}
export function readGuestPixels(gl: WebGLRenderingContext | WebGL2RenderingContext, x: number, y: number, w: number, h: number, format: number, type: number, p: number): void {
  const K = pixelArray(type), element = K.BYTES_PER_ELEMENT;
  const bytes = pixelByteSize(format, type);
  if (!bytes || w <= 0 || h <= 0) { gl.readPixels(x, y, w, h, format, type, pixels(type, p)); return; }
  const rowLength = pixelParam(gl, 0x0d02) || w;
  const { stride, skip, extent } = pixelRows(w, h, bytes, pixelParam(gl, 0x0d05), rowLength, pixelParam(gl, 0x0d03), pixelParam(gl, 0x0d04));
  const data = view(K, p, Math.floor(extent / element));
  gl.readPixels(x, y, w, h, format, type, data);
  // A short destination is rejected by WebGL. Padding and skipped pixels are never written.
  if (extent > data.byteLength) return;
  if (p % element) mem.write(p, new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  for (let row = 0; row < h; row++) wrote(p + skip + row * stride, w * bytes);
}
export const PACK = 0x88eb, UNPACK = 0x88ec;
/** an upload's source: an offset into the bound unpack buffer, else its guest bytes */
export const texData = (type: number, p: number, format: number, dimensions: PixelDimensions): number | ArrayBufferView | null =>
  (pbo(UNPACK) ? p : p ? uploadPixels(type, p, format, dimensions) : null);
