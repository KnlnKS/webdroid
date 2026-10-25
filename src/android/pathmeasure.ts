// android.graphics.PathMeasure's native half: SkContourMeasure over a snapshot of a path's verbs,
// and the curve chopping (SkGeometry) it and the scan converter share.

import { rt } from "../jvm/runtime.ts";
import { deref, ownedHandle, release } from "./handles.ts";
import { type Mat, matrixAt } from "./matrix.ts";
import { type NativePath, VerbIterator, pathAt, MOVE, LINE, QUAD, CUBIC, CLOSE, DONE } from "./path.ts";

const LINE_SEG = 0, QUAD_SEG = 1, CUBIC_SEG = 2;
/** SkContourMeasure's fixed-point t, which bounds subdivision */
const MAX_T = 0x3fffffff;
/** CHEAP_DIST_LIMIT at a resolution scale of 1 */
const TOLERANCE = 0.5;
class Contour {
  /** per segment: distance at its end, index of its curve's first point, type and end t */
  d: number[] = []; pi: number[] = []; ty: number[] = []; tv: number[] = [];
  /** the contour's points, x and y interleaved; curves share their end points */
  pts: number[] = [];
  length = 0;
  closed = false;
  seg(d: number, pi: number, ty: number, tv: number) { this.d.push(d); this.pi.push(pi); this.ty.push(ty); this.tv.push(tv); }
}
function lineSeg(c: Contour, x0: number, y0: number, x1: number, y1: number, d: number, pi: number) {
  const next = d + Math.hypot(x1 - x0, y1 - y0);
  if (next > d) c.seg(next, pi, LINE_SEG, MAX_T);
  return next;
}
function quadSegs(c: Contour, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, d: number, mint: number, maxt: number, pi: number): number {
  const dx = x1 / 2 - (x0 + x2) / 4, dy = y1 / 2 - (y0 + y2) / 4;
  if (maxt - mint >= 1024 && Math.max(Math.abs(dx), Math.abs(dy)) > TOLERANCE) {
    const half = (mint + maxt) >>> 1;
    const ax = (x0 + x1) / 2, ay = (y0 + y1) / 2, bx = (x1 + x2) / 2, by = (y1 + y2) / 2, mx = (ax + bx) / 2, my = (ay + by) / 2;
    d = quadSegs(c, x0, y0, ax, ay, mx, my, d, mint, half, pi);
    return quadSegs(c, mx, my, bx, by, x2, y2, d, half, maxt, pi);
  }
  const next = d + Math.hypot(x2 - x0, y2 - y0);
  if (next > d) c.seg(next, pi, QUAD_SEG, maxt);
  return next;
}
const tooFar = (x: number, y: number, px: number, py: number) => Math.max(Math.abs(px - x), Math.abs(py - y)) > TOLERANCE;
function cubicSegs(c: Contour, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, d: number, mint: number, maxt: number, pi: number): number {
  if (maxt - mint >= 1024 && (tooFar(x1, y1, x0 + (x3 - x0) / 3, y0 + (y3 - y0) / 3) || tooFar(x2, y2, x0 + (x3 - x0) * 2 / 3, y0 + (y3 - y0) * 2 / 3))) {
    const half = (mint + maxt) >>> 1;
    const abx = (x0 + x1) / 2, aby = (y0 + y1) / 2, bcx = (x1 + x2) / 2, bcy = (y1 + y2) / 2, cdx = (x2 + x3) / 2, cdy = (y2 + y3) / 2;
    const abcx = (abx + bcx) / 2, abcy = (aby + bcy) / 2, bcdx = (bcx + cdx) / 2, bcdy = (bcy + cdy) / 2;
    const mx = (abcx + bcdx) / 2, my = (abcy + bcdy) / 2;
    d = cubicSegs(c, x0, y0, abx, aby, abcx, abcy, mx, my, d, mint, half, pi);
    return cubicSegs(c, mx, my, bcdx, bcdy, cdx, cdy, x3, y3, d, half, maxt, pi);
  }
  const next = d + Math.hypot(x3 - x0, y3 - y0);
  if (next > d) c.seg(next, pi, CUBIC_SEG, maxt);
  return next;
}
/** SkScalarInterp, in float as Skia's geometry is */
export const lerp = (a: number, b: number, t: number) => Math.fround(a + Math.fround(Math.fround(b - a) * t));

export class PathMeasure {
  private verbs: VerbIterator | null = null;
  private forceClosed = false;
  private contour: Contour | null = null;
  /** the raw points of the verb being measured */
  private readonly raw = new Float64Array(8);
  /** position and unit tangent from the last posTan */
  private readonly pt = new Float64Array(4);
  /** the t distanceToSegment found */
  private t = 0;
  private readonly chop = new Float64Array(14);
  private readonly chop2 = new Float64Array(14);

  /** SkPathMeasure::setPath: the path is copied, and the first contour with length measured */
  setPath(p: NativePath | undefined, forceClosed: boolean) {
    this.verbs = p ? new VerbIterator(p) : null;
    this.forceClosed = forceClosed;
    this.nextContour();
  }
  /** SkContourMeasureIter::next skips contours of zero length */
  nextContour(): boolean {
    this.contour = null;
    while (!this.contour && this.verbs && this.verbs.peek() !== DONE) this.contour = this.build(this.verbs);
    return !!this.contour;
  }
  length(): number { return this.contour?.length ?? 0; }
  isClosed(): boolean { return !!this.contour?.closed; }
  private build(it: VerbIterator): Contour | null {
    const c = new Contour(), v = this.raw;
    let pi = -1, d = 0, seenClose = this.forceClosed, seenMove = false;
    for (let verb; (verb = it.peek()) !== DONE;) {
      if (seenMove && verb === MOVE) break;
      it.next(v);
      const prev = d;
      switch (verb) {
        case MOVE: pi++; c.pts.push(v[0], v[1]); seenMove = true; break;
        case LINE:
          d = lineSeg(c, v[0], v[1], v[2], v[3], d, pi);
          if (d > prev) { c.pts.push(v[2], v[3]); pi++; }
          break;
        case QUAD:
          d = quadSegs(c, v[0], v[1], v[2], v[3], v[4], v[5], d, 0, MAX_T, pi);
          if (d > prev) { c.pts.push(v[2], v[3], v[4], v[5]); pi += 2; }
          break;
        case CUBIC:
          d = cubicSegs(c, v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], d, 0, MAX_T, pi);
          if (d > prev) { c.pts.push(v[2], v[3], v[4], v[5], v[6], v[7]); pi += 3; }
          break;
        case CLOSE: seenClose = true; break;
      }
    }
    if (!Number.isFinite(d) || !c.d.length) return null;
    if (seenClose) {
      const prev = d, fx = c.pts[0], fy = c.pts[1];
      d = lineSeg(c, c.pts[pi * 2], c.pts[pi * 2 + 1], fx, fy, d, pi);
      if (d > prev) c.pts.push(fx, fy);
    }
    c.length = d;
    c.closed = seenClose;
    return c;
  }
  /** SkContourMeasure::distanceToSegment: the first segment reaching `d`, and the t there in this.t */
  private segAt(c: Contour, d: number): number {
    let lo = 0, hi = c.d.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (c.d[mid] < d) lo = mid + 1; else hi = mid; }
    let startT = 0, startD = 0;
    if (lo > 0) { startD = c.d[lo - 1]; if (c.pi[lo - 1] === c.pi[lo]) startT = c.tv[lo - 1] / MAX_T; }
    this.t = startT + (c.tv[lo] / MAX_T - startT) * (d - startD) / (c.d[lo] - startD);
    return lo;
  }
  /** compute_pos_tan into this.pt */
  private posTan(c: Contour, seg: number, t: number) {
    const p = c.pts, i = c.pi[seg] * 2, out = this.pt;
    const x0 = p[i], y0 = p[i + 1], x1 = p[i + 2], y1 = p[i + 3];
    let tx: number, ty: number;
    if (c.ty[seg] === LINE_SEG) {
      out[0] = lerp(x0, x1, t); out[1] = lerp(y0, y1, t);
      tx = x1 - x0; ty = y1 - y0;
    } else if (c.ty[seg] === QUAD_SEG) {
      const x2 = p[i + 4], y2 = p[i + 5];
      out[0] = ((x2 - 2 * x1 + x0) * t + 2 * (x1 - x0)) * t + x0;
      out[1] = ((y2 - 2 * y1 + y0) * t + 2 * (y1 - y0)) * t + y0;
      // SkEvalQuadTangentAt: an end whose control point coincides takes the chord
      if ((t === 0 && x0 === x1 && y0 === y1) || (t === 1 && x1 === x2 && y1 === y2)) { tx = x2 - x0; ty = y2 - y0; }
      else { tx = (x2 - 2 * x1 + x0) * t + (x1 - x0); ty = (y2 - 2 * y1 + y0) * t + (y1 - y0); }
    } else {
      const x2 = p[i + 4], y2 = p[i + 5], x3 = p[i + 6], y3 = p[i + 7];
      const ax = x3 + 3 * (x1 - x2) - x0, ay = y3 + 3 * (y1 - y2) - y0;
      const bx = 3 * (x2 - 2 * x1 + x0), by = 3 * (y2 - 2 * y1 + y0);
      const cx = 3 * (x1 - x0), cy = 3 * (y1 - y0);
      out[0] = ((ax * t + bx) * t + cx) * t + x0;
      out[1] = ((ay * t + by) * t + cy) * t + y0;
      // SkEvalCubicAt: at an end whose neighbour coincides, the next control point or the chord
      if ((t === 0 && x0 === x1 && y0 === y1) || (t === 1 && x2 === x3 && y2 === y3)) {
        if (t === 0) { tx = x2 - x0; ty = y2 - y0; } else { tx = x3 - x1; ty = y3 - y1; }
        if (!tx && !ty) { tx = x3 - x0; ty = y3 - y0; }
      } else { tx = (ax * t + bx * 2 / 3) * t + cx / 3; ty = (ay * t + by * 2 / 3) * t + cy / 3; }
    }
    const len = Math.hypot(tx, ty);
    out[2] = len > 0 && Number.isFinite(len) ? tx / len : 0;
    out[3] = len > 0 && Number.isFinite(len) ? ty / len : 0;
  }
  /** SkContourMeasure::getPosTan into this.pt, the distance pinned to the contour */
  private at(d: number): boolean {
    const c = this.contour;
    if (!c || !c.length) return false;
    const seg = this.segAt(c, d < 0 ? 0 : d > c.length ? c.length : d);
    if (!Number.isFinite(this.t)) return false;
    this.posTan(c, seg, this.t);
    return true;
  }
  getPosTan(d: number, pos: Float32Array | null, tan: Float32Array | null): boolean {
    if (!this.at(d)) return false;
    if (pos) { pos[0] = this.pt[0]; pos[1] = this.pt[1]; }
    if (tan) { tan[0] = this.pt[2]; tan[1] = this.pt[3]; }
    return true;
  }
  /** SkContourMeasure::getMatrix: flags 1 = position, 2 = tangent */
  getMatrix(d: number, m: Mat, flags: number): boolean {
    if (!this.at(d)) return false;
    const [x, y, tx, ty] = this.pt;
    m.set(flags & 2 ? [tx, -ty, 0, ty, tx, 0, 0, 0, 1] : [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    if (flags & 1) { m[2] = x; m[5] = y; }
    return true;
  }
  /** SkContourMeasure::getSegment */
  getSegment(startD: number, stopD: number, dst: NativePath, moveTo: boolean): boolean {
    const c = this.contour;
    if (!c) return false;
    if (startD < 0) startD = 0;
    if (stopD > c.length) stopD = c.length;
    if (!(startD <= stopD)) return false;
    let seg = this.segAt(c, startD), startT = this.t;
    if (!Number.isFinite(startT)) return false;
    const stop = this.segAt(c, stopD), stopT = this.t;
    if (!Number.isFinite(stopT)) return false;
    if (moveTo) { this.posTan(c, seg, startT); dst.moveTo(this.pt[0], this.pt[1]); }
    if (c.pi[seg] === c.pi[stop]) {
      this.segTo(c, seg, startT, stopT, dst);
      return true;
    }
    do {
      this.segTo(c, seg, startT, 1, dst);
      const pi = c.pi[seg];
      do seg++; while (c.pi[seg] === pi);
      startT = 0;
    } while (c.pi[seg] < c.pi[stop]);
    this.segTo(c, seg, 0, stopT, dst);
    return true;
  }
  /** SkContourMeasure_segTo: the part of a segment's curve between two t, appended */
  private segTo(c: Contour, seg: number, startT: number, stopT: number, dst: NativePath) {
    if (startT === stopT) {
      // a zero-length piece still carries its end caps
      if (dst.ops.length) dst.lineTo(dst.pen.x, dst.pen.y);
      return;
    }
    const p = c.pts, i = c.pi[seg] * 2, a = this.chop, b = this.chop2;
    switch (c.ty[seg]) {
      case LINE_SEG:
        dst.lineTo(stopT === 1 ? p[i + 2] : lerp(p[i], p[i + 2], stopT), stopT === 1 ? p[i + 3] : lerp(p[i + 1], p[i + 3], stopT));
        break;
      case QUAD_SEG:
        for (let k = 0; k < 6; k++) a[k] = p[i + k];
        if (startT === 0) {
          if (stopT === 1) return dst.quadTo(a[2], a[3], a[4], a[5]);
          chopQuadAt(a, stopT, b);
          return dst.quadTo(b[2], b[3], b[4], b[5]);
        }
        chopQuadAt(a, startT, b);
        if (stopT === 1) return dst.quadTo(b[6], b[7], b[8], b[9]);
        chopQuadAt(b.subarray(4), (stopT - startT) / (1 - startT), a);
        return dst.quadTo(a[2], a[3], a[4], a[5]);
      case CUBIC_SEG:
        for (let k = 0; k < 8; k++) a[k] = p[i + k];
        if (startT === 0) {
          if (stopT === 1) return dst.cubicTo(a[2], a[3], a[4], a[5], a[6], a[7]);
          chopCubicAt(a, stopT, b);
          return dst.cubicTo(b[2], b[3], b[4], b[5], b[6], b[7]);
        }
        chopCubicAt(a, startT, b);
        if (stopT === 1) return dst.cubicTo(b[8], b[9], b[10], b[11], b[12], b[13]);
        chopCubicAt(b.subarray(6), (stopT - startT) / (1 - startT), a);
        return dst.cubicTo(a[2], a[3], a[4], a[5], a[6], a[7]);
    }
  }
}
/** SkChopQuadAt: the quad src[0..6) split at t into the five points dst[0..10), the middle one shared */
export function chopQuadAt(src: ArrayLike<number>, t: number, dst: Float64Array) {
  const x0 = src[0], y0 = src[1], x1 = src[2], y1 = src[3], x2 = src[4], y2 = src[5];
  const ax = lerp(x0, x1, t), ay = lerp(y0, y1, t), bx = lerp(x1, x2, t), by = lerp(y1, y2, t);
  dst[0] = x0; dst[1] = y0; dst[2] = ax; dst[3] = ay; dst[4] = lerp(ax, bx, t); dst[5] = lerp(ay, by, t);
  dst[6] = bx; dst[7] = by; dst[8] = x2; dst[9] = y2;
}
/** SkChopCubicAt: the cubic src[0..8) split at t into the seven points dst[0..14) */
export function chopCubicAt(src: ArrayLike<number>, t: number, dst: Float64Array) {
  const x0 = src[0], y0 = src[1], x1 = src[2], y1 = src[3], x2 = src[4], y2 = src[5], x3 = src[6], y3 = src[7];
  const abx = lerp(x0, x1, t), aby = lerp(y0, y1, t), bcx = lerp(x1, x2, t), bcy = lerp(y1, y2, t), cdx = lerp(x2, x3, t), cdy = lerp(y2, y3, t);
  const abcx = lerp(abx, bcx, t), abcy = lerp(aby, bcy, t), bcdx = lerp(bcx, cdx, t), bcdy = lerp(bcy, cdy, t);
  dst[0] = x0; dst[1] = y0; dst[2] = abx; dst[3] = aby; dst[4] = abcx; dst[5] = abcy; dst[6] = lerp(abcx, bcdx, t); dst[7] = lerp(abcy, bcdy, t);
  dst[8] = bcdx; dst[9] = bcdy; dst[10] = cdx; dst[11] = cdy; dst[12] = x3; dst[13] = y3;
}

// PathMeasure frees its native state from finalize(), which never runs here
const measure = (h: bigint) => deref<PathMeasure>(h);
rt.registerJnis("android/graphics/PathMeasure", {
  "native_create(JZ)J": (p: bigint, forceClosed: number) => {
    const m = new PathMeasure();
    m.setPath(p ? pathAt(p) : undefined, !!forceClosed);
    return ownedHandle(m);
  },
  "native_setPath(JJZ)V": (h: bigint, p: bigint, forceClosed: number) => measure(h).setPath(p ? pathAt(p) : undefined, !!forceClosed),
  "native_getLength(J)F": (h: bigint) => measure(h).length(),
  "native_getPosTan(JF[F[F)Z": (h: bigint, d: number, pos: Float32Array | null, tan: Float32Array | null) => +measure(h).getPosTan(d, pos, tan),
  "native_getMatrix(JFJI)Z": (h: bigint, d: number, m: bigint, flags: number) => +measure(h).getMatrix(d, matrixAt(m), flags),
  "native_getSegment(JFFJZ)Z": (h: bigint, start: number, stop: number, dst: bigint, moveTo: number) =>
    +measure(h).getSegment(start, stop, pathAt(dst), !!moveTo),
  "native_isClosed(J)Z": (h: bigint) => +measure(h).isClosed(),
  "native_nextContour(J)Z": (h: bigint) => +measure(h).nextContour(),
  "native_destroy(J)V": release,
});
