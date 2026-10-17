// What WebGL accepts without raising an error, mirrored from its validation so a call that keeps the
// context clean lets glGetError answer NO_ERROR without asking WebGL (android/gl.ts takeError). An
// entry point marked keepsClean judges each call itself, calling unsure() when WebGL may reject
// it (an argument not recognized here included); every other entry leaves the context unsure.

import { mem } from "./mem.ts";
import type { HostFn } from "./host.ts";
import { unsure } from "../android/gl.ts";
import { g, contextState, texRecs, pbo, imageKey, UNKNOWN, type ContextState, type Bound, type TexImage } from "./gles3-state.ts";
import { ALIGNMENTS, pixelParam, uploadExtent } from "./gles3-pixels.ts";

const kept = new WeakSet<HostFn>();
/** an entry point that judges for itself whether WebGL may reject a call */
export function keepsClean(fn: HostFn): HostFn { kept.add(fn); return fn; }
export const keptClean = (fn: HostFn): boolean => kept.has(fn);

export const TEXTURE_TARGETS = new Set([0x0de1, 0x8513, 0x806f, 0x8c1a]);
// ARRAY, ELEMENT_ARRAY, COPY_READ, COPY_WRITE, PIXEL_PACK, PIXEL_UNPACK and UNIFORM buffers
export const BUFFER_TARGETS = new Set([0x8892, 0x8893, 0x8f36, 0x8f37, 0x88eb, 0x88ec, 0x8a11]);
export const USAGES = new Set([0x88e0, 0x88e1, 0x88e2, 0x88e4, 0x88e5, 0x88e6, 0x88e8, 0x88e9, 0x88ea]);
// sized formats WebGL 2 stores without an extension
const STORAGE_FORMATS = new Set([0x8058, 0x8051, 0x8229, 0x822b, 0x8d62, 0x8056, 0x8057, 0x8c43, 0x8059, 0x881a, 0x881b, 0x822d, 0x822f,
  0x822e, 0x8230, 0x8814, 0x8815, 0x8c3a, 0x8c3d, 0x81a5, 0x81a6, 0x8cac, 0x88f0, 0x8cad]);
export const RENDERBUFFER_FORMATS = new Set([0x8056, 0x8d62, 0x8057, 0x81a5, 0x8d48, 0x8058, 0x8051, 0x88f0, 0x81a6, 0x8cac, 0x8cad, 0x8c43, 0x8229, 0x822b]);
// texImage2D's (internalformat, format, type) combinations from ES 3.0's table 3.2, byte and packed 16-bit
const IMAGE_FORMATS = new Set(["6408 6408 5121", "6407 6407 5121", "6410 6410 5121", "6409 6409 5121", "6406 6406 5121", "32856 6408 5121",
  "32849 6407 5121", "33321 6403 5121", "33323 33319 5121", "6407 6407 33635", "36194 6407 33635", "36194 6407 5121", "6408 6408 32819",
  "32854 6408 32819", "32854 6408 5121", "6408 6408 32820", "32855 6408 32820", "32855 6408 5121"]);
// the (format, type) pairs ES 3.0's table 3.2 accepts for a sized format's byte and packed 16-bit uploads
const SUB_FORMATS = new Map<number, string[]>([[0x8058, ["6408 5121"]], [0x8051, ["6407 5121"]], [0x8229, ["6403 5121"]], [0x822b, ["33319 5121"]],
  [0x8c43, ["6408 5121"]], [0x8d62, ["6407 5121", "6407 33635"]], [0x8056, ["6408 5121", "6408 32819"]], [0x8057, ["6408 5121", "6408 32820"]]]);
const PIXEL_STORES = [0x0cf2, 0x0cf3, 0x0cf4, 0x806d, 0x806e, 0x0d02, 0x0d03, 0x0d04];
const mipLevels = (size: number): number => Math.floor(Math.log2(size)) + 1;
const cube = (target: number): boolean => target >= 0x8515 && target <= 0x851a;
/** a 2D texture's target, or a cube face's cube map */
export const textureOf = (target: number): number => cube(target) ? 0x8513 : target;

/** the texture bound at the active unit for `target`, undefined when not tracked */
const knownTexture = (state: ContextState, target: number): WebGLTexture | null | undefined => state.bindings.get(state.activeUnit)?.get(target);
/** the binding and storage of the texture bound for `target`, while they are known */
function trusted(state: ContextState, target: number): Bound | null {
  const texture = knownTexture(state, target), rec = texture && texRecs.get(texture);
  return rec && !rec.deleted && rec.tracking.kind === "bound" ? rec.tracking : null;
}
/** levels of the bound texture a call other than glTexImage2D specifies, which glTexSubImage2D then leaves to WebGL */
export function forgetImages(target: number, levels: (level: number) => boolean): void {
  const storage = trusted(contextState(), textureOf(target))?.storage;
  if (storage && !storage.immutable) for (const key of storage.images.keys()) if (Math.floor(key / 32) === target && levels(key % 32)) storage.images.delete(key);
}
/** a call WebGL may reject changed that texture: its state is no longer known */
export function untrust(target: number): void {
  unsure();
  const texture = knownTexture(contextState(), target), rec = texture && texRecs.get(texture);
  if (rec) rec.tracking = UNKNOWN;
}
export function texParamAccepted(target: number, pname: number, v: number): boolean {
  if (!TEXTURE_TARGETS.has(target) || !trusted(contextState(), target)) return false;
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
/** glTexStorage2D: the binding whose storage it makes immutable, null when WebGL may refuse it */
export function storageAccepted(target: number, levels: number, format: number, w: number, h: number): Bound | null {
  if (target !== 0x0de1 && target !== 0x8513) return null;
  const state = contextState(), bound = trusted(state, target), max = state.limits[target === 0x8513 ? 2 : 1];
  if (!bound || bound.storage.immutable || !STORAGE_FORMATS.has(format)) return null;
  return levels >= 1 && w >= 1 && h >= 1 && w <= max && h <= max && (target !== 0x8513 || w === h) && levels <= mipLevels(Math.max(w, h)) ? bound : null;
}
/** glTexImage2D: the level images it records the image in, null when WebGL may refuse it */
export function imageAccepted(target: number, level: number, internal: number, w: number, h: number, border: number, format: number, type: number, p: number): Map<number, TexImage> | null {
  if (target !== 0x0de1 && !cube(target)) return null;
  const state = contextState(), storage = trusted(state, textureOf(target))?.storage, max = state.limits[cube(target) ? 2 : 1];
  if (!storage || storage.immutable || border !== 0 || pbo(0x88ec) || !IMAGE_FORMATS.has(`${internal} ${format} ${type}`)) return null;
  if (level < 0 || level >= mipLevels(max) || w < 0 || h < 0 || w > max >> level || h > max >> level || (cube(target) && w !== h)) return null;
  return pixelSourceAccepted(type, format, w, h, p) ? storage.images : null;
}
export const recordImage = (images: Map<number, TexImage>, target: number, level: number, image: TexImage): void => { images.set(imageKey(target, level), image); };
/** texSubImage2D into a tracked texture's storage, or into a level glTexImage2D specified, with
 *  the format and type that specified it where its internal format is unsized */
export function subImageAccepted(target: number, level: number, x: number, y: number, w: number, h: number, format: number, type: number, p: number): boolean {
  if (target !== 0x0de1 && !cube(target)) return false;
  const storage = trusted(contextState(), textureOf(target))?.storage;
  if (!storage || pbo(0x88ec) || x < 0 || y < 0 || w < 0 || h < 0) return false;
  if (storage.immutable) {
    if (!SUB_FORMATS.get(storage.format)?.includes(`${format} ${type}`)) return false;
    if (level < 0 || level >= storage.levels || x + w > Math.max(1, storage.width >> level) || y + h > Math.max(1, storage.height >> level)) return false;
  } else {
    const image = storage.images.get(imageKey(target, level));
    if (!image || x + w > image.width || y + h > image.height) return false;
    if (image.internal === image.format ? format !== image.format || type !== image.type : !SUB_FORMATS.get(image.internal)?.includes(`${format} ${type}`)) return false;
  }
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
export function pixelStoreAccepted(pname: number, v: number): boolean {
  if (pname === 0x0cf5 || pname === 0x0d05) return ALIGNMENTS.includes(v);
  return v >= 0 && PIXEL_STORES.includes(pname);
}
