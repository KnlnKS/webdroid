// android.graphics.NinePatch's native half: its chunk (Res_png_9patch, deserialized) and the lattice
// SkCanvas::drawImageLattice stretches it by.

import { rt } from "../jvm/runtime.ts";
import { deref, release, ownedHandle } from "./handles.ts";
import type { NativeBitmap } from "./bitmap.ts";
import { edges } from "./graphics.ts";
import { NativeRegion } from "./region.ts";
import type { Ctx2D } from "./recording.ts";

/** Res_png_9patch deserialized, as NinePatch's native chunk holds it; colors are per patch (0 transparent) */
export interface NinePatchChunk { xDivs: number[]; yDivs: number[]; padding: [left: number, top: number, right: number, bottom: number]; colors: number[] }
/** Res_png_9patch: flags and counts, int32 offsets and padding (left, right, top, bottom), then xDivs, yDivs and colors */
function readNinePatchChunk(chunk: Int8Array): NinePatchChunk | null {
  if (chunk.length < 32) return null;
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const nx = chunk[1] & 0xff, ny = chunk[2] & 0xff, nc = chunk[3] & 0xff;
  if (32 + (nx + ny + nc) * 4 > chunk.length) return null;
  const at = (i: number) => view.getInt32(i, true);
  const ints = (from: number, n: number) => Array.from({ length: n }, (_, i) => at(from + i * 4));
  return { xDivs: ints(32, nx), yDivs: ints(32 + nx * 4, ny), padding: [at(12), at(20), at(16), at(24)], colors: ints(32 + (nx + ny) * 4, nc) };
}
/** NinePatch.isNinePatchChunk: long enough, and its first byte (wasDeserialized) is not -1 */
const isNinePatchChunk = (chunk: Int8Array | null): chunk is Int8Array => !!chunk && chunk.length >= 32 && chunk[0] !== -1;
/** NinePatch.validateNinePatchChunk's deserialized copy */
function validNinePatchChunk(chunk: Int8Array | null): NinePatchChunk {
  if (!chunk) throw rt.npe();
  const parsed = readNinePatchChunk(chunk);
  if (!parsed) throw rt.mkThrowable("java/lang/RuntimeException", "Array too small for chunk.");
  return parsed;
}

// ── nine-patch geometry: SkCanvas::drawImageLattice over NinePatchUtils::SetLatticeDivs
/** one axis of SkLatticeIter: the source boundaries, whether the first patch stretches, and the stretching total */
interface LatticeAxis { src: number[]; scalableFirst: boolean; scalable: number }
interface Lattice { w: number; h: number; x: LatticeAxis; y: LatticeAxis }
function latticeAxis(divs: number[], size: number): LatticeAxis | null {
  // a last div at the edge says nothing, and Skia refuses it
  const n = divs.length && divs[divs.length - 1] === size ? divs.length - 1 : divs.length;
  for (let i = 0, prev = -1; i < n; prev = divs[i++]) if (prev >= divs[i] || divs[i] >= size) return null;
  const scalableFirst = n > 0 && divs[0] === 0, src = [0];
  for (let i = scalableFirst ? 1 : 0; i < n; i++) src.push(divs[i]);
  src.push(size);
  let scalable = 0;
  for (let i = 1, s = scalableFirst; i < src.length; i++, s = !s) if (s) scalable += src[i] - src[i - 1];
  return { src, scalableFirst, scalable };
}
const lattices = new WeakMap<NinePatchChunk, Lattice | null>();
/** the chunk's lattice over a w x h image, or null where SkLatticeIter::Valid refuses it (no divs on either axis) */
function latticeOf(chunk: NinePatchChunk, w: number, h: number): Lattice | null {
  let l = lattices.get(chunk);
  if (l === undefined || l && (l.w !== w || l.h !== h)) {
    const x = latticeAxis(chunk.xDivs, w), y = latticeAxis(chunk.yDivs, h);
    lattices.set(chunk, l = x && y && (x.src.length > 2 || y.src.length > 2) ? { w, h, x, y } : null);
  }
  return l;
}
/** SkLatticeIter's set_points: each source boundary's place between start and end; fixed patches keep
 *  their size and the stretching ones share the rest, or, when the fixed ones do not fit, they shrink */
function placeAxis(a: LatticeAxis, start: number, end: number, out: number[]) {
  const f = Math.fround, src = a.src, len = f(end - start), fixed = src[src.length - 1] - a.scalable, fits = fixed <= len;
  const scale = fits ? f(f(len - fixed) / a.scalable) : f(len / fixed);
  out[0] = start;
  for (let i = 1, s = a.scalableFirst; i < src.length - 1; i++, s = !s) {
    const d = src[i] - src[i - 1];
    out[i] = f(out[i - 1] + (fits ? (s ? f(scale * d) : d) : (s ? 0 : f(scale * d))));
  }
  out[src.length - 1] = end;
}
const patchXs: number[] = [], patchYs: number[] = [];
/** a nine-patch image (sw x sh) stretched into the destination rectangle */
export function drawNinePatch(ctx: Ctx2D, img: CanvasImageSource, sw: number, sh: number, chunk: NinePatchChunk, dx: number, dy: number, dw: number, dh: number) {
  if (!(dw > 0 && dh > 0)) return;
  const lattice = latticeOf(chunk, sw, sh);
  if (!lattice) { ctx.drawImage(img, 0, 0, sw, sh, dx, dy, dw, dh); return; }
  const sx = lattice.x.src, sy = lattice.y.src;
  placeAxis(lattice.x, dx, dx + dw, patchXs);
  placeAxis(lattice.y, dy, dy + dh, patchYs);
  for (let j = 0; j + 1 < sy.length; j++) {
    const top = patchYs[j], h = patchYs[j + 1] - top;
    if (!(h > 0)) continue;
    for (let i = 0; i + 1 < sx.length; i++) {
      const left = patchXs[i], w = patchXs[i + 1] - left;
      if (w > 0) ctx.drawImage(img, sx[i], sy[j], sx[i + 1] - sx[i], sy[j + 1] - sy[j], left, top, w, h);
    }
  }
}
/** hwui's NinePatch getTransparentRegion: the destination patches whose chunk color is transparent,
 *  each rounded, as (l, t, r, b) quadruples; none unless the chunk has a color for every patch */
function transparentPatches(chunk: NinePatchChunk, sw: number, sh: number, l: number, t: number, r: number, b: number): number[] {
  const lattice = latticeOf(chunk, sw, sh), out: number[] = [];
  if (!lattice) return out;
  const nx = lattice.x.src.length - 1, ny = lattice.y.src.length - 1, xs: number[] = [], ys: number[] = [];
  if (nx * ny !== chunk.colors.length) return out;
  placeAxis(lattice.x, l, r, xs);
  placeAxis(lattice.y, t, b, ys);
  const round = (v: number) => Math.floor(v + 0.5);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (chunk.colors[j * nx + i] === 0 && xs[i] < xs[i + 1] && ys[j] < ys[j + 1]) out.push(round(xs[i]), round(ys[j]), round(xs[i + 1]), round(ys[j + 1]));
  }
  return out;
}

// ── the natives
// NinePatch frees its chunk from finalize(), which never runs here
rt.registerJnis("android/graphics/NinePatch", {
  "isNinePatchChunk([B)Z": (chunk: Int8Array | null) => +isNinePatchChunk(chunk),
  "validateNinePatchChunk([B)J": (chunk: Int8Array | null) => ownedHandle(validNinePatchChunk(chunk)),
  "nativeFinalize(J)V": release,
  "nativeGetTransparentRegion(JJLandroid/graphics/Rect;)J": (b: bigint, chunk: bigint, rect: object) => {
    const dst = edges(rect), bmp = deref<NativeBitmap>(b), rects = transparentPatches(deref<NinePatchChunk>(chunk), bmp.w, bmp.h, dst.left, dst.top, dst.right, dst.bottom);
    if (!rects.length) return 0n;
    const r = new NativeRegion();
    r.setRects(rects);
    return ownedHandle(r);
  },
});
