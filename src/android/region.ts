// The native half of android.graphics.Region and RegionIterator, following SkRegion: an integer
// area held as y-sorted bands of x-sorted, disjoint spans, in the canonical form SkRegion keeps
// (touching spans merged, vertically adjacent bands with the same spans merged, no empty band),
// so iteration, equality, toString and the boundary path all see the rectangles a device does.

import { declaredField } from "../jvm/runtime.ts";
import { deref } from "./handles.ts";
import { type NativePath, type Sink, walkPath } from "./path.ts";
import type { Box } from "./graphics.ts";

/** rows [top, bottom) covered by the spans [xs[0], xs[1]), [xs[2], xs[3]), ... */
interface Band { top: number; bottom: number; xs: readonly number[] }

/** SkRegion::Op, which Region.Op's nativeInt carries: difference, intersect, union, xor,
 *  reverse difference, replace */
const DIFFERENCE = 0, INTERSECT = 1, UNION = 2, REPLACE = 5;
const KEEP: ((a: boolean, b: boolean) => boolean)[] = [
  (a, b) => a && !b, (a, b) => a && b, (a, b) => a || b, (a, b) => a !== b, (a, b) => b && !a, (_a, b) => b,
];
/** SkRegion_kRunTypeSentinel: a rect reaching it is refused */
const SENTINEL = 0x7fffffff;
const NONE: readonly number[] = [];

/** SkRegion. Bands are never mutated once built, so copies share them. */
export class NativeRegion {
  bands: readonly Band[] = [];

  isEmpty(): boolean { return !this.bands.length; }
  isRect(): boolean { return this.bands.length === 1 && this.bands[0].xs.length === 2; }
  isComplex(): boolean { return !this.isEmpty() && !this.isRect(); }
  setEmpty(): boolean { this.bands = []; return false; }
  set(src: NativeRegion): boolean { this.bands = src.bands; return !this.isEmpty(); }
  setRect(l: number, t: number, r: number, b: number): boolean {
    if (l >= r || t >= b || r === SENTINEL || b === SENTINEL) return this.setEmpty();
    this.bands = [{ top: t, bottom: b, xs: [l, r] }];
    return true;
  }
  /** the bounds, or null for an empty region */
  bounds(): Box | null {
    const bands = this.bands;
    if (!bands.length) return null;
    let l = Infinity, r = -Infinity;
    for (const { xs } of bands) { if (xs[0] < l) l = xs[0]; if (xs[xs.length - 1] > r) r = xs[xs.length - 1]; }
    return { left: l, top: bands[0].top, right: r, bottom: bands[bands.length - 1].bottom };
  }
  /** this = a op b */
  op(a: NativeRegion, b: NativeRegion, op: number): boolean {
    this.bands = combine(a.bands, b.bands, KEEP[op] ?? KEEP[REPLACE]);
    return !this.isEmpty();
  }
  contains(x: number, y: number): boolean {
    for (const { top, bottom, xs } of this.bands) {
      if (y < top) return false;
      if (y >= bottom) continue;
      for (let i = 0; i < xs.length; i += 2) if (x >= xs[i] && x < xs[i + 1]) return true;
      return false;
    }
    return false;
  }
  /** SkRegion::quickContains: only a rectangular region answers yes */
  quickContains(l: number, t: number, r: number, b: number): boolean {
    if (!(l < r && t < b) || !this.isRect()) return false;
    const { top, bottom, xs } = this.bands[0];
    return xs[0] <= l && top <= t && xs[1] >= r && bottom >= b;
  }
  quickReject(l: number, t: number, r: number, b: number): boolean {
    const box = this.bounds();
    if (!box || l >= r || t >= b) return true;
    return !(l < box.right && box.left < r && t < box.bottom && box.top < b);
  }
  translate(dx: number, dy: number, dst: NativeRegion = this) {
    dst.bands = this.bands.map(({ top, bottom, xs }) => ({ top: top + dy, bottom: bottom + dy, xs: xs.map((x) => x + dx) }));
  }
  /** SkRegion::Iterator: each band's spans, left to right, top to bottom */
  forEachRect(fn: (l: number, t: number, r: number, b: number) => void) {
    for (const { top, bottom, xs } of this.bands) for (let i = 0; i < xs.length; i += 2) fn(xs[i], top, xs[i + 1], bottom);
  }
  rects(): number[] {
    const out: number[] = [];
    this.forEachRect((l, t, r, b) => out.push(l, t, r, b));
    return out;
  }
  /** the union of rects (l, t, r, b quadruples), as SkRegion::op(rect, kUnion) one at a time */
  setRects(rects: ArrayLike<number>): boolean {
    const r = new NativeRegion(), one = new NativeRegion();
    for (let i = 0; i + 4 <= rects.length; i += 4) if (one.setRect(rects[i], rects[i + 1], rects[i + 2], rects[i + 3])) r.op(r, one, UNION);
    return this.set(r);
  }
  equals(o: NativeRegion): boolean {
    const a = this.bands, b = o.bands;
    return a.length === b.length && a.every((x, i) => x.top === b[i].top && x.bottom === b[i].bottom && sameSpans(x.xs, b[i].xs));
  }
  toString(): string {
    let s = "SkRegion(";
    this.forEachRect((l, t, r, b) => { s += `(${l},${t},${r},${b})`; });
    return s + ")";
  }

  /** SkRegion::getBoundaryPath: each connected outline as vertical and horizontal lines, appended */
  boundaryPath(path: NativePath): boolean {
    if (this.isEmpty()) return false;
    if (this.isRect()) {
      const { top, bottom, xs } = this.bands[0];
      path.addRect(xs[0], top, xs[1], bottom, 0);
      return true;
    }
    // a left edge runs up (bottom to top), a right edge down; sorted by x, then by top
    const edges: Edge[] = [];
    this.forEachRect((l, t, r, b) => { edges.push(new Edge(l, b, t), new Edge(r, t, b)); });
    edges.sort((a, b) => (a.x === b.x ? Math.min(a.y0, a.y1) - Math.min(b.y0, b.y1) : a.x - b.x));
    for (let i = 0; i < edges.length; i++) findLink(edges, i);
    let count = edges.length, start = 0;
    while (count > 0) {
      while (!edges[start].flags) start++;
      const base = edges[start];
      let prev = base, e = base.next!, n = 1;
      path.moveTo(prev.x, prev.y0);
      prev.flags = 0;
      do {
        if (prev.x !== e.x || prev.y1 !== e.y0) { path.lineTo(prev.x, prev.y1); path.lineTo(e.x, e.y0); }
        prev = e; e = e.next!; n++;
        prev.flags = 0;
      } while (e !== base);
      path.lineTo(prev.x, prev.y1);
      path.close();
      count -= n;
    }
    return true;
  }

  /** SkRegion::setPath: the path scan-converted without anti-aliasing (SkScan::FillPath), within clip */
  setPath(path: NativePath, clip: NativeRegion): boolean {
    const box = clip.bounds();
    if (!box || !path.ops.length || !finite(path)) return path.inverseFill ? this.set(clip) : this.setEmpty();
    const filled = new NativeRegion();
    filled.bands = scan(path, box);
    if (path.inverseFill) {
      const whole = new NativeRegion();
      whole.setRect(box.left, box.top, box.right, box.bottom);
      filled.op(whole, filled, DIFFERENCE);
    }
    return this.op(filled, clip, INTERSECT);
  }
}

function sameSpans(a: readonly number[], b: readonly number[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** a op b band by band, merging bands that continue the one above with the same spans */
function combine(a: readonly Band[], b: readonly Band[], keep: (a: boolean, b: boolean) => boolean): Band[] {
  const ys = [...new Set([...a.flatMap((x) => [x.top, x.bottom]), ...b.flatMap((x) => [x.top, x.bottom])])].sort((p, q) => p - q);
  const out: Band[] = [];
  let ia = 0, ib = 0;
  for (let k = 0; k + 1 < ys.length; k++) {
    const y0 = ys[k], y1 = ys[k + 1];
    while (ia < a.length && a[ia].bottom <= y0) ia++;
    while (ib < b.length && b[ib].bottom <= y0) ib++;
    const xa = ia < a.length && a[ia].top <= y0 ? a[ia].xs : NONE, xb = ib < b.length && b[ib].top <= y0 ? b[ib].xs : NONE;
    const xs = combineSpans(xa, xb, keep);
    if (!xs.length) continue;
    const last = out[out.length - 1];
    if (last && last.bottom === y0 && sameSpans(last.xs, xs)) last.bottom = y1;
    else out.push({ top: y0, bottom: y1, xs });
  }
  return out;
}
function combineSpans(a: readonly number[], b: readonly number[], keep: (a: boolean, b: boolean) => boolean): number[] {
  const out: number[] = [];
  let i = 0, j = 0, inA = false, inB = false, on = false;
  while (i < a.length || j < b.length) {
    const x = Math.min(i < a.length ? a[i] : Infinity, j < b.length ? b[j] : Infinity);
    while (i < a.length && a[i] === x) { inA = !inA; i++; }
    while (j < b.length && b[j] === x) { inB = !inB; j++; }
    const now = keep(inA, inB);
    if (now !== on) { out.push(x); on = now; }
  }
  return out;
}

class Edge {
  readonly x: number; readonly y0: number; readonly y1: number;
  flags = 0;
  next: Edge | null = null;
  constructor(x: number, y0: number, y1: number) { this.x = x; this.y0 = y0; this.y1 = y1; }
}
const Y0_LINK = 1, Y1_LINK = 2, COMPLETE = 3;
/** SkRegion's find_link: chain each edge to the one starting where it ends */
function findLink(edges: Edge[], i: number) {
  const base = edges[i];
  if (base.flags === COMPLETE) return;
  if (!(base.flags & Y0_LINK)) {
    for (let k = i + 1; ; k++) {
      const e = edges[k];
      if (!(e.flags & Y1_LINK) && base.y0 === e.y1) { e.next = base; e.flags |= Y1_LINK; break; }
    }
  }
  if (!(base.flags & Y1_LINK)) {
    for (let k = i + 1; ; k++) {
      const e = edges[k];
      if (!(e.flags & Y0_LINK) && base.y1 === e.y0) { base.next = e; e.flags |= Y0_LINK; break; }
    }
  }
  base.flags = COMPLETE;
}

function finite(path: NativePath) {
  const b = path.bounds();
  return Number.isFinite(b.left + b.top + b.right + b.bottom);
}

// ── SkScan::FillPath without anti-aliasing ─────────────────────────────────────────────
// SkEdgeBuilder's edges in SkEdge's fixed point: points truncated to 1/64 (FDot6), each row
// sampled at its centre in 16.16, x rounded to a pixel boundary. Curves step through the line
// pieces SkQuadraticEdge and SkCubicEdge forward-difference, conics first becoming the quads
// SkAutoConicToQuads makes, so a curve's pixels are the device's.
/** one line piece: rows first..last, x (16.16) on the first row's centre, dx per row */
interface ScanEdge { first: number; last: number; x: number; dx: number; winding: number }
const f = Math.fround;
const MAX_COEFF_SHIFT = 6;
/** SkFDot6Div: a / b in 16.16 */
const fdot6Div = (a: number, b: number) => (a >= -32768 && a <= 32767 ? Math.trunc(a * 65536 / b)
  : Math.max(-0x80000000, Math.min(0x7fffffff, Math.trunc(a * 65536 / b))));
const fixedMul = (a: number, b: number) => Math.floor(a * b / 65536);
const cheapDistance = (dx: number, dy: number) => {
  dx = Math.abs(dx); dy = Math.abs(dy);
  return dx > dy ? dx + (dy >> 1) : dy + (dx >> 1);
};
/** SkEdge's diff_to_shift: subdivisions (as a power of two) for a curve this far off its chord */
const diffToShift = (dx: number, dy: number, shiftAA = 2) => {
  const dist = (cheapDistance(dx, dy) + (1 << 4)) >> (3 + shiftAA);
  return (32 - Math.clz32(dist)) >> 1;
};
const between = (a: number, b: number, c: number) => (a - b) * (c - b) <= 0;

class EdgeSink implements Sink {
  readonly edges: ScanEdge[] = [];
  private x = 0; private y = 0; private sx = 0; private sy = 0; private open = false;
  moveTo(x: number, y: number) { this.closePath(); this.x = this.sx = x; this.y = this.sy = y; this.open = true; }
  lineTo(x: number, y: number) { this.line(this.x, this.y, x, y); this.x = x; this.y = y; }
  quadraticCurveTo(x1: number, y1: number, x2: number, y2: number) { this.monoQuads(this.x, this.y, x1, y1, x2, y2); this.x = x2; this.y = y2; }
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
    this.monoCubics([this.x, this.y, x1, y1, x2, y2, x3, y3]);
    this.x = x3; this.y = y3;
  }
  /** SkAutoConicToQuads at the edge builder's quarter-pixel tolerance */
  conicTo(x1: number, y1: number, x2: number, y2: number, w: number) {
    const a = f(w - 1), k = f(a / f(4 * f(2 + a)));
    let error = f(Math.hypot(f(k * f(f(this.x - f(2 * x1)) + x2)), f(k * f(f(this.y - f(2 * y1)) + y2))));
    let pow2 = 0;
    for (; pow2 < 5 && error > 0.25; pow2++) error = f(error * 0.25);
    const pts: number[] = [this.x, this.y];
    subdivideConic([this.x, this.y, x1, y1, x2, y2], w, pow2, pts);
    for (let i = 0; i + 5 < pts.length; i += 4) this.monoQuads(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5]);
    this.x = x2; this.y = y2;
  }
  /** a fill closes every contour */
  closePath() {
    if (this.open && (this.x !== this.sx || this.y !== this.sy)) this.line(this.x, this.y, this.sx, this.sy);
    this.x = this.sx; this.y = this.sy; this.open = false;
  }

  /** SkEdge::setLine */
  private line(px0: number, py0: number, px1: number, py1: number) {
    let x0 = Math.trunc(px0 * 64), y0 = Math.trunc(py0 * 64), x1 = Math.trunc(px1 * 64), y1 = Math.trunc(py1 * 64), winding = 1;
    if (y0 > y1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; winding = -1; }
    this.piece(x0, y0, x1, y1, winding);
  }
  /** SkEdge::updateLine's body, in FDot6 */
  private piece(x0: number, y0: number, x1: number, y1: number, winding: number) {
    const top = (y0 + 32) >> 6, bot = (y1 + 32) >> 6;
    if (top === bot) return;
    const slope = fdot6Div(x1 - x0, y1 - y0), dy = (top << 6) + 32 - y0;
    this.edges.push({ first: top, last: bot - 1, x: (x0 + fixedMul(slope, dy)) * 1024, dx: slope, winding });
  }
  /** SkChopQuadAtYExtrema, then an SkQuadraticEdge per monotonic piece */
  private monoQuads(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number) {
    const ab = y0 - y1;
    let bc = y1 - y2;
    if (ab < 0) bc = -bc;
    if (ab === 0 || bc < 0) {
      const t = unitDivide(f(y0 - y1), f(f(f(y0 - y1) - y1) + y2));
      if (t) {
        const p01x = lerp(x0, x1, t), p01y = lerp(y0, y1, t), p12x = lerp(x1, x2, t), p12y = lerp(y1, y2, t);
        const mx = lerp(p01x, p12x, t), my = lerp(p01y, p12y, t);
        this.quadEdge(x0, y0, p01x, my, mx, my);
        this.quadEdge(mx, my, p12x, my, x2, y2);
        return;
      }
      y1 = Math.abs(y0 - y1) < Math.abs(y1 - y2) ? y0 : y2;
    }
    this.quadEdge(x0, y0, x1, y1, x2, y2);
  }
  /** SkQuadraticEdge::setQuadratic and its updateQuadratic steps */
  private quadEdge(px0: number, py0: number, px1: number, py1: number, px2: number, py2: number) {
    let x0 = Math.trunc(px0 * 64), y0 = Math.trunc(py0 * 64), x2 = Math.trunc(px2 * 64), y2 = Math.trunc(py2 * 64), winding = 1;
    const x1 = Math.trunc(px1 * 64), y1 = Math.trunc(py1 * 64);
    if (y0 > y2) { [x0, x2] = [x2, x0]; [y0, y2] = [y2, y0]; winding = -1; }
    if ((y0 + 32) >> 6 === (y2 + 32) >> 6) return;
    let shift = diffToShift((x1 * 2 - x0 - x2) >> 2, (y1 * 2 - y0 - y2) >> 2, 0);
    shift = shift === 0 ? 1 : Math.min(shift, MAX_COEFF_SHIFT);
    // A and B at half their value, so the steps shift by one less
    const ax = (x0 - x1 - x1 + x2) << 9, ay = (y0 - y1 - y1 + y2) << 9, cshift = shift - 1;
    let qx = x0 << 10, qy = y0 << 10, dx = ((x1 - x0) << 10) + (ax >> shift), dy = ((y1 - y0) << 10) + (ay >> shift);
    const ddx = ax >> cshift, ddy = ay >> cshift;
    for (let count = 1 << shift; count > 0;) {
      let nx: number, ny: number;
      if (--count > 0) { nx = qx + (dx >> cshift); dx += ddx; ny = qy + (dy >> cshift); dy += ddy; }
      else { nx = x2 << 10; ny = y2 << 10; }
      this.piece(qx >> 10, qy >> 10, nx >> 10, ny >> 10, winding);
      qx = nx; qy = ny;
    }
  }
  /** SkChopCubicAtYExtrema, then an SkCubicEdge per monotonic piece */
  private monoCubics(p: number[]) {
    const pieces = chopCubic(p, cubicExtrema(p[1], p[3], p[5], p[7]));
    for (let i = 0; i + 7 < pieces.length; i += 6) this.cubicEdge(pieces.slice(i, i + 8));
  }
  /** SkCubicEdge::setCubic and its updateCubic steps */
  private cubicEdge(p: number[]) {
    let [x0, y0, x1, y1, x2, y2, x3, y3] = p.map((v) => Math.trunc(v * 64)), winding = 1;
    if (y0 > y3) { [x0, x3] = [x3, x0]; [x1, x2] = [x2, x1]; [y0, y3] = [y3, y0]; [y1, y2] = [y2, y1]; winding = -1; }
    if ((y0 + 32) >> 6 === (y3 + 32) >> 6) return;
    const shift = Math.min(diffToShift(cubicDeltaFromLine(x0, x1, x2, x3), cubicDeltaFromLine(y0, y1, y2, y3)) + 1, MAX_COEFF_SHIFT);
    let upShift = 6, downShift = shift + upShift - 10;
    if (downShift < 0) { downShift = 0; upShift = 10 - shift; }
    const coeffs = (v0: number, v1: number, v2: number, v3: number) => {
      const b = (3 * (v1 - v0)) << upShift, c = (3 * (v0 - v1 - v1 + v2)) << upShift, d = (v3 + 3 * (v1 - v2) - v0) << upShift;
      return [v0 << 10, b + (c >> shift) + (d >> 2 * shift), 2 * c + ((3 * d) >> (shift - 1)), (3 * d) >> (shift - 1)];
    };
    const cx0 = coeffs(x0, x1, x2, x3), cy0 = coeffs(y0, y1, y2, y3), cdddx = cx0[3], cdddy = cy0[3];
    let [cx, cdx, cddx] = cx0, [cy, cdy, cddy] = cy0;
    for (let count = -(1 << shift); count < 0;) {
      let nx: number, ny: number;
      if (++count < 0) {
        nx = cx + (cdx >> downShift); cdx += cddx >> shift; cddx += cdddx;
        ny = cy + (cdy >> downShift); cdy += cddy >> shift; cddy += cdddy;
      } else { nx = x3 << 10; ny = y3 << 10; }
      if (ny < cy) ny = cy;
      this.piece(cx >> 10, cy >> 10, nx >> 10, ny >> 10, winding);
      cx = nx; cy = ny;
    }
  }
}
const lerp = (a: number, b: number, t: number) => f(a + f(f(b - a) * t));
/** valid_unit_divide: numer / denom when it lies strictly inside (0, 1), else 0 */
function unitDivide(numer: number, denom: number): number {
  if (numer < 0) { numer = -numer; denom = -denom; }
  if (denom === 0 || numer === 0 || numer >= denom) return 0;
  const r = f(numer / denom);
  return Number.isNaN(r) ? 0 : r;
}
/** SkFindCubicExtrema: t in (0, 1) where the cubic's derivative is zero, ascending */
function cubicExtrema(a: number, b: number, c: number, d: number): number[] {
  const A = f(f(d - a) + f(3 * f(b - c))), B = f(2 * f(f(f(a - b) - b) + c)), C = f(b - a);
  if (A === 0) { const t = unitDivide(-C, B); return t ? [t] : []; }
  const dr = B * B - 4 * A * C;
  if (dr < 0) return [];
  const R = f(Math.sqrt(dr)), Q = B < 0 ? f(-f(B - R) / 2) : f(-f(B + R) / 2);
  const roots = [unitDivide(Q, A), unitDivide(C, Q)].filter((t) => t);
  if (roots.length === 2) {
    if (roots[0] > roots[1]) roots.reverse();
    else if (roots[0] === roots[1]) roots.pop();
  }
  return roots;
}
/** SkChopCubicAt over ascending ts, with each extremum's neighbours flattened onto it */
function chopCubic(p: number[], ts: number[]): number[] {
  const out = p.slice(0, 2);
  let src = p, prev = 0;
  for (const t0 of ts) {
    const t = prev ? unitDivide(f(t0 - prev), f(1 - prev)) : t0;
    if (!t) break;
    const [x0, y0, x1, y1, x2, y2, x3, y3] = src;
    const abx = lerp(x0, x1, t), aby = lerp(y0, y1, t), bcx = lerp(x1, x2, t), bcy = lerp(y1, y2, t), cdx = lerp(x2, x3, t), cdy = lerp(y2, y3, t);
    const abcx = lerp(abx, bcx, t), abcy = lerp(aby, bcy, t), bcdx = lerp(bcx, cdx, t), bcdy = lerp(bcy, cdy, t);
    const mx = lerp(abcx, bcdx, t), my = lerp(abcy, bcdy, t);
    out.push(abx, aby, abcx, my, mx, my);
    src = [mx, my, bcdx, my, cdx, cdy, x3, y3];
    prev = t0;
  }
  out.push(...src.slice(2));
  return out;
}
/** SkEdge's cubic_delta_from_line: roughly the larger distance of the thirds from the chord */
function cubicDeltaFromLine(a: number, b: number, c: number, d: number): number {
  const oneThird = ((a * 8 - b * 15 + 6 * c + d) * 19) >> 9, twoThird = ((a + 6 * b - c * 15 + d * 8) * 19) >> 9;
  return Math.max(Math.abs(oneThird), Math.abs(twoThird));
}
/** SkConic::chopIntoQuadsPOW2: the conic halved `level` times, each piece's control points kept */
function subdivideConic(c: number[], w: number, level: number, out: number[]) {
  if (!level) { out.push(c[2], c[3], c[4], c[5]); return; }
  const scale = f(1 / f(1 + w)), ws = f(w * scale);
  const t0x = f(c[0] * scale), t0y = f(c[1] * scale), t1x = f(c[2] * ws), t1y = f(c[3] * ws), t2x = f(c[4] * scale), t2y = f(c[5] * scale);
  const p2x = f(f(f(0.5 * t0x) + t1x) + f(0.5 * t2x)), p2y = f(f(f(0.5 * t0y) + t1y) + f(0.5 * t2y));
  const a = [c[0], c[1], f(t0x + t1x), f(t0y + t1y), p2x, p2y], b = [p2x, p2y, f(t1x + t2x), f(t1y + t2y), c[4], c[5]];
  // a monotonic conic stays monotonic in its halves, or the scan converter would hang
  const startY = c[1], endY = c[5];
  if (between(startY, c[3], endY)) {
    if (!between(startY, p2y, endY)) a[5] = b[1] = Math.abs(p2y - startY) < Math.abs(p2y - endY) ? startY : endY;
    if (!between(startY, a[3], a[5])) a[3] = startY;
    if (!between(b[1], b[3], endY)) b[3] = endY;
  }
  const next = f(Math.sqrt(f(0.5 + f(w * 0.5))));
  subdivideConic(a, next, level - 1, out);
  subdivideConic(b, next, level - 1, out);
}

/** SkScan::FillPath's walk_edges over the rows of `clip`, winding or even-odd */
function scan(path: NativePath, clip: Box): Band[] {
  const sink = new EdgeSink();
  walkPath(path, sink);
  sink.closePath();
  const edges = sink.edges, evenOdd = path.fillRule === "evenodd", out: Band[] = [];
  let lo = Infinity, hi = -Infinity;
  for (const e of edges) { lo = Math.min(lo, e.first); hi = Math.max(hi, e.last + 1); }
  lo = Math.max(lo, clip.top); hi = Math.min(hi, clip.bottom);
  const row: ScanEdge[] = [], xs: number[] = [];
  for (let y = lo; y < hi; y++) {
    row.length = 0;
    for (const e of edges) if (e.first <= y && e.last >= y) row.push(e);
    const xAt = (e: ScanEdge) => e.x + e.dx * (y - e.first);
    row.sort((a, b) => xAt(a) - xAt(b));
    xs.length = 0;
    let w = 0, left = 0;
    for (const e of row) {
      const x = Math.floor((xAt(e) + 0x8000) / 65536);
      if (!(evenOdd ? w & 1 : w)) left = x;
      w += e.winding;
      if (evenOdd ? w & 1 : w) continue;
      const l = Math.max(left, clip.left), r = Math.min(x, clip.right);
      if (l >= r) continue;
      if (xs.length && xs[xs.length - 1] >= l) xs[xs.length - 1] = Math.max(xs[xs.length - 1], r);
      else xs.push(l, r);
    }
    if (!xs.length) continue;
    const last = out[out.length - 1];
    if (last && last.bottom === y && sameSpans(last.xs, xs)) last.bottom = y + 1;
    else out.push({ top: y, bottom: y + 1, xs: xs.slice() });
  }
  return out;
}

let mNativeRegion = "";
/** the area behind a Java Region */
export const nativeRegionOf = (r: object): NativeRegion =>
  deref<NativeRegion>((r as Record<string, bigint>)[mNativeRegion ||= declaredField("android/graphics/Region", "mNativeRegion")]);
