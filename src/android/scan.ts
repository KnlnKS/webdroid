// Skia's raster rules in device pixels, which a 2D context's own rasterization does not follow:
// SkScan::FillPath's scan conversion, which Region.setPath and a bitmap's fills without
// anti-aliasing share (and, supersampled as SkScan_AntiPath does, its thinnest anti-aliased fills),
// and hairlines stepped as SkScan_Hairline steps them. bitmap-raster.ts decides which draws take them.

import type { Ctx2D, Mat2D } from "./recording.ts";
import { type NativePath, type Sink, chopCubicAt, chopQuadAt, walkPath } from "./path.ts";
import type { Box } from "./graphics.ts";

type Point = [number, number];
const f = Math.fround;

/** SkMatrix::mapPoints under an affine matrix, in float */
export function devicePoint(m: Mat2D, x: number, y: number): Point { return [deviceX(m, x, y), deviceY(m, x, y)]; }
const deviceX = (m: Mat2D, x: number, y: number) => f(f(f(m.a * x) + f(m.c * y)) + m.e);
const deviceY = (m: Mat2D, x: number, y: number) => f(f(f(m.b * x) + f(m.d * y)) + m.f);

function clipLine(start: Point, end: Point, width: number, height: number): [Point, Point] | null {
  const points: [Point, Point] = [[...start], [...end]];
  for (const [axis, limit] of [[1, height], [0, width]]) {
    const low = start[axis] < end[axis] ? 0 : 1, high = 1 - low;
    if (points[high][axis] < 0 || points[low][axis] > limit) return null;
    const span = end[axis] - start[axis];
    if (points[low][axis] < 0) {
      const t = -start[axis] / span;
      points[low] = [Math.fround(start[0] + t * (end[0] - start[0])), Math.fround(start[1] + t * (end[1] - start[1]))];
      points[low][axis] = 0;
    }
    if (points[high][axis] > limit) {
      const t = (limit - start[axis]) / span;
      points[high] = [Math.fround(start[0] + t * (end[0] - start[0])), Math.fround(start[1] + t * (end[1] - start[1]))];
      points[high][axis] = limit;
    }
  }
  return points;
}

// Android's Skia hairline scan uses 26.6 endpoints and 16.16 pixel stepping.
function rasterLine(start: Point, end: Point, width: number, height: number, pixels: Path2D): number {
  let x0 = Math.trunc(Math.fround(start[0] * 64)), y0 = Math.trunc(Math.fround(start[1] * 64));
  let x1 = Math.trunc(Math.fround(end[0] * 64)), y1 = Math.trunc(Math.fround(end[1] * 64));
  const dx = x1 - x0, dy = y1 - y0;
  let count = 0;
  if (Math.abs(dx) > Math.abs(dy)) {
    if (x0 > x1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
    const slope = Math.trunc(dy * 65536 / dx), endX = (x1 + 32) >> 6;
    let yFixed = (y0 << 10) + ((slope * ((32 - x0) & 63)) >> 6);
    for (let x = (x0 + 32) >> 6; x < endX; x++, yFixed += slope) {
      const y = yFixed >> 16;
      if (x >= 0 && x < width && y >= 0 && y < height) { pixels.rect(x, y, 1, 1); count++; }
    }
  } else if (dy) {
    if (y0 > y1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
    const slope = Math.trunc(dx * 65536 / dy), endY = (y1 + 32) >> 6;
    let xFixed = (x0 << 10) + ((slope * ((32 - y0) & 63)) >> 6);
    for (let y = (y0 + 32) >> 6; y < endY; y++, xFixed += slope) {
      const x = xFixed >> 16;
      if (x >= 0 && x < width && y >= 0 && y < height) { pixels.rect(x, y, 1, 1); count++; }
    }
  }
  return count;
}

export function hairlineRect(ctx: Ctx2D, left: number, top: number, right: number, bottom: number,
  cap: CanvasLineCap): Path2D | null {
  const width = ctx.canvas.width, height = ctx.canvas.height;
  if (!(right > left && bottom > top && width > 0 && height > 0)) return null;
  const matrix = ctx.getTransform(), f = Math.fround;
  const points: Point[] = [[left, top], [right, top], [right, bottom], [left, bottom]]
    .map(([x, y]) => devicePoint(matrix, x, y));
  if (!points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return null;
  const outset = cap === "square" ? 0.5 : cap === "round" ? Math.PI / 8 : 0;
  // The cap-adjusted first point is also the endpoint of the closing edge.
  const first: Point = [...points[0]];
  if (outset) {
    const dx = points[1][0] - first[0], dy = points[1][1] - first[1], length = Math.hypot(dx, dy);
    if (!length) return null;
    first[0] = f(first[0] - dx / length * outset);
    first[1] = f(first[1] - dy / length * outset);
  }
  const pixels = new Path2D();
  let count = 0;
  for (let index = 0; index < 4; index++) {
    const start: Point = [...(index === 0 ? first : points[index])];
    const end: Point = [...(index === 3 ? first : points[index + 1])];
    if (outset && index === 3) {
      const dx = end[0] - start[0], dy = end[1] - start[1], length = Math.hypot(dx, dy);
      if (!length) return null;
      end[0] = f(end[0] + dx / length * outset);
      end[1] = f(end[1] + dy / length * outset);
    }
    const clipped = clipLine(start, end, width, height);
    if (clipped) count += rasterLine(clipped[0], clipped[1], width, height, pixels);
  }
  return count ? pixels : null;
}

export function hairlineLine(ctx: Ctx2D, x0: number, y0: number, x1: number, y1: number,
  cap: CanvasLineCap): Path2D | null {
  const width = ctx.canvas.width, height = ctx.canvas.height;
  if (!(width > 0 && height > 0)) return null;
  const matrix = ctx.getTransform();
  const start = devicePoint(matrix, x0, y0), end = devicePoint(matrix, x1, y1);
  if (![...start, ...end].every(Number.isFinite)) return null;
  const outset = cap === "square" ? 0.5 : cap === "round" ? Math.PI / 8 : 0;
  if (outset) {
    const dx = end[0] - start[0], dy = end[1] - start[1], length = Math.hypot(dx, dy);
    if (!length) return null;
    start[0] -= dx / length * outset; start[1] -= dy / length * outset;
    end[0] += dx / length * outset; end[1] += dy / length * outset;
  }
  const clipped = clipLine(start, end, width, height);
  if (!clipped) return null;
  const pixels = new Path2D();
  return rasterLine(clipped[0], clipped[1], width, height, pixels) ? pixels : null;
}

// ── SkScan::FillPath ─────────────────────────────────────────────────────────────────────
// SkEdgeBuilder's edges in SkEdge's fixed point: points truncated to 1/64 (FDot6) of a pixel, or
// of a supersample, each row sampled at its centre in 16.16, x rounded to a pixel boundary. Curves
// step through the line pieces SkQuadraticEdge and SkCubicEdge forward-difference, conics first
// becoming the quads SkAutoConicToQuads makes, so a curve's pixels are the device's. Skia clips
// edges to the clip first (SkEdgeClipper), which keeps its 32-bit fixed point in range; edges here
// are whole, so shifts are floor divisions and products, exact where Skia's are.

/** rows [top, bottom) covered by the spans [xs[0], xs[1]), [xs[2], xs[3]), ... */
export interface Band { top: number; bottom: number; xs: readonly number[] }
export function sameSpans(a: readonly number[], b: readonly number[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** one line piece: rows first..last, x (16.16) on the first row's centre and `at` on the row being
 *  walked, dx per row */
interface ScanEdge { first: number; last: number; x: number; dx: number; winding: number; at: number }
const MAX_COEFF_SHIFT = 6;
/** v >> k */
const shr = (v: number, k: number) => Math.floor(v / 2 ** k);
/** SkFDot6Div: a / b in 16.16 */
const fdot6Div = (a: number, b: number) => (a >= -32768 && a <= 32767 ? Math.trunc(a * 65536 / b)
  : Math.max(-0x80000000, Math.min(0x7fffffff, Math.trunc(a * 65536 / b))));
const fixedMul = (a: number, b: number) => Math.floor(a * b / 65536);
const cheapDistance = (dx: number, dy: number) => {
  dx = Math.abs(dx); dy = Math.abs(dy);
  return dx > dy ? dx + shr(dy, 1) : dy + shr(dx, 1);
};
/** SkEdge's diff_to_shift: subdivisions (as a power of two) for a curve this far off its chord */
const diffToShift = (dx: number, dy: number, shiftAA = 2) => {
  const dist = shr(cheapDistance(dx, dy) + 16, 3 + shiftAA);
  return (32 - Math.clz32(dist)) >> 1;
};
const between = (a: number, b: number, c: number) => (a - b) * (c - b) <= 0;

class EdgeSink implements Sink {
  readonly edges: ScanEdge[] = [];
  private x = 0; private y = 0; private sx = 0; private sy = 0; private open = false;
  /** the path's matrix to device pixels */
  private readonly m: Mat2D | null;
  /** SkEdge's shift: 2^shift supersamples per pixel side, a supersample's 1/64 being FDot6's unit */
  private readonly shift: number;
  private readonly scale: number;
  private readonly chop = new Float64Array(10);
  constructor(m: Mat2D | null, shift: number) { this.m = m; this.shift = shift; this.scale = 64 * 2 ** shift; }
  private mapX(x: number, y: number) { return this.m ? deviceX(this.m, x, y) : x; }
  private mapY(x: number, y: number) { return this.m ? deviceY(this.m, x, y) : y; }
  moveTo(x: number, y: number) {
    this.closePath();
    this.x = this.sx = this.mapX(x, y); this.y = this.sy = this.mapY(x, y); this.open = true;
  }
  lineTo(x: number, y: number) {
    const px = this.mapX(x, y), py = this.mapY(x, y);
    this.line(this.x, this.y, px, py);
    this.x = px; this.y = py;
  }
  quadraticCurveTo(x1: number, y1: number, x2: number, y2: number) {
    const px = this.mapX(x2, y2), py = this.mapY(x2, y2);
    this.monoQuads(this.x, this.y, this.mapX(x1, y1), this.mapY(x1, y1), px, py);
    this.x = px; this.y = py;
  }
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
    const px = this.mapX(x3, y3), py = this.mapY(x3, y3);
    this.monoCubics([this.x, this.y, this.mapX(x1, y1), this.mapY(x1, y1), this.mapX(x2, y2), this.mapY(x2, y2), px, py]);
    this.x = px; this.y = py;
  }
  /** SkAutoConicToQuads at the edge builder's quarter-pixel tolerance; an affine map keeps the weight */
  conicTo(cx: number, cy: number, x2: number, y2: number, w: number) {
    const x1 = this.mapX(cx, cy), y1 = this.mapY(cx, cy), px = this.mapX(x2, y2), py = this.mapY(x2, y2);
    const a = f(w - 1), k = f(a / f(4 * f(2 + a)));
    let error = f(Math.hypot(f(k * f(f(this.x - f(2 * x1)) + px)), f(k * f(f(this.y - f(2 * y1)) + py))));
    let pow2 = 0;
    for (; pow2 < 5 && error > 0.25; pow2++) error = f(error * 0.25);
    const pts: number[] = [this.x, this.y];
    subdivideConic([this.x, this.y, x1, y1, px, py], w, pow2, pts);
    for (let i = 0; i + 5 < pts.length; i += 4) this.monoQuads(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5]);
    this.x = px; this.y = py;
  }
  /** a fill closes every contour */
  closePath() {
    if (this.open && (this.x !== this.sx || this.y !== this.sy)) this.line(this.x, this.y, this.sx, this.sy);
    this.x = this.sx; this.y = this.sy; this.open = false;
  }

  /** SkEdge::setLine */
  private line(px0: number, py0: number, px1: number, py1: number) {
    const s = this.scale;
    let x0 = Math.trunc(px0 * s), y0 = Math.trunc(py0 * s), x1 = Math.trunc(px1 * s), y1 = Math.trunc(py1 * s), winding = 1;
    if (y0 > y1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; winding = -1; }
    this.piece(x0, y0, x1, y1, winding);
  }
  /** SkEdge::updateLine's body, in FDot6 */
  private piece(x0: number, y0: number, x1: number, y1: number, winding: number) {
    const top = shr(y0 + 32, 6), bot = shr(y1 + 32, 6);
    if (top === bot) return;
    const slope = fdot6Div(x1 - x0, y1 - y0), dy = top * 64 + 32 - y0;
    this.edges.push({ first: top, last: bot - 1, x: (x0 + fixedMul(slope, dy)) * 1024, dx: slope, winding, at: 0 });
  }
  /** SkChopQuadAtYExtrema, then an SkQuadraticEdge per monotonic piece */
  private monoQuads(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number) {
    const ab = y0 - y1;
    let bc = y1 - y2;
    if (ab < 0) bc = -bc;
    if (ab === 0 || bc < 0) {
      const t = unitDivide(f(y0 - y1), f(f(f(y0 - y1) - y1) + y2));
      if (t) {
        const d = this.chop;
        chopQuadAt([x0, y0, x1, y1, x2, y2], t, d);
        // the extremum's neighbours flattened onto it
        this.quadEdge(d[0], d[1], d[2], d[5], d[4], d[5]);
        this.quadEdge(d[4], d[5], d[6], d[5], d[8], d[9]);
        return;
      }
      y1 = Math.abs(y0 - y1) < Math.abs(y1 - y2) ? y0 : y2;
    }
    this.quadEdge(x0, y0, x1, y1, x2, y2);
  }
  /** SkQuadraticEdge::setQuadratic and its updateQuadratic steps */
  private quadEdge(px0: number, py0: number, px1: number, py1: number, px2: number, py2: number) {
    const s = this.scale;
    let x0 = Math.trunc(px0 * s), y0 = Math.trunc(py0 * s), x2 = Math.trunc(px2 * s), y2 = Math.trunc(py2 * s), winding = 1;
    const x1 = Math.trunc(px1 * s), y1 = Math.trunc(py1 * s);
    if (y0 > y2) { [x0, x2] = [x2, x0]; [y0, y2] = [y2, y0]; winding = -1; }
    if (shr(y0 + 32, 6) === shr(y2 + 32, 6)) return;
    let shift = diffToShift(shr(x1 * 2 - x0 - x2, 2), shr(y1 * 2 - y0 - y2, 2), this.shift);
    shift = shift === 0 ? 1 : Math.min(shift, MAX_COEFF_SHIFT);
    // A and B at half their value, so the steps shift by one less
    const ax = (x0 - x1 - x1 + x2) * 512, ay = (y0 - y1 - y1 + y2) * 512, cshift = shift - 1;
    let qx = x0 * 1024, qy = y0 * 1024, dx = (x1 - x0) * 1024 + shr(ax, shift), dy = (y1 - y0) * 1024 + shr(ay, shift);
    const ddx = shr(ax, cshift), ddy = shr(ay, cshift);
    for (let count = 1 << shift; count > 0;) {
      let nx: number, ny: number;
      if (--count > 0) { nx = qx + shr(dx, cshift); dx += ddx; ny = qy + shr(dy, cshift); dy += ddy; }
      else { nx = x2 * 1024; ny = y2 * 1024; }
      this.piece(shr(qx, 10), shr(qy, 10), shr(nx, 10), shr(ny, 10), winding);
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
    const s = this.scale;
    let [x0, y0, x1, y1, x2, y2, x3, y3] = p.map((v) => Math.trunc(v * s)), winding = 1;
    if (y0 > y3) { [x0, x3] = [x3, x0]; [x1, x2] = [x2, x1]; [y0, y3] = [y3, y0]; [y1, y2] = [y2, y1]; winding = -1; }
    if (shr(y0 + 32, 6) === shr(y3 + 32, 6)) return;
    const shift = Math.min(diffToShift(cubicDeltaFromLine(x0, x1, x2, x3), cubicDeltaFromLine(y0, y1, y2, y3)) + 1, MAX_COEFF_SHIFT);
    let upShift = 6, downShift = shift + upShift - 10;
    if (downShift < 0) { downShift = 0; upShift = 10 - shift; }
    const up = 2 ** upShift;
    const coeffs = (v0: number, v1: number, v2: number, v3: number) => {
      const b = 3 * (v1 - v0) * up, c = 3 * (v0 - v1 - v1 + v2) * up, d = (v3 + 3 * (v1 - v2) - v0) * up;
      return [v0 * 1024, b + shr(c, shift) + shr(d, 2 * shift), 2 * c + shr(3 * d, shift - 1), shr(3 * d, shift - 1)];
    };
    const cx0 = coeffs(x0, x1, x2, x3), cy0 = coeffs(y0, y1, y2, y3), cdddx = cx0[3], cdddy = cy0[3];
    let [cx, cdx, cddx] = cx0, [cy, cdy, cddy] = cy0;
    for (let count = -(1 << shift); count < 0;) {
      let nx: number, ny: number;
      if (++count < 0) {
        nx = cx + shr(cdx, downShift); cdx += shr(cddx, shift); cddx += cdddx;
        ny = cy + shr(cdy, downShift); cdy += shr(cddy, shift); cddy += cdddy;
      } else { nx = x3 * 1024; ny = y3 * 1024; }
      if (ny < cy) ny = cy;
      this.piece(shr(cx, 10), shr(cy, 10), shr(nx, 10), shr(ny, 10), winding);
      cx = nx; cy = ny;
    }
  }
}
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
  const out = p.slice(0, 2), d = new Float64Array(14);
  let src: ArrayLike<number> = p, prev = 0;
  for (const t0 of ts) {
    const t = prev ? unitDivide(f(t0 - prev), f(1 - prev)) : t0;
    if (!t) break;
    chopCubicAt(src, t, d);
    d[5] = d[9] = d[7];
    out.push(d[2], d[3], d[4], d[5], d[6], d[7]);
    src = d.slice(6);
    prev = t0;
  }
  for (let i = 2; i < 8; i++) out.push(src[i]);
  return out;
}
/** SkEdge's cubic_delta_from_line: roughly the larger distance of the thirds from the chord */
function cubicDeltaFromLine(a: number, b: number, c: number, d: number): number {
  const oneThird = shr((a * 8 - b * 15 + 6 * c + d) * 19, 9), twoThird = shr((a + 6 * b - c * 15 + d * 8) * 19, 9);
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

const byFirst = (a: ScanEdge, b: ScanEdge) => a.first - b.first;
/** SkScan::FillPath's walk_edges over the rows of `clip`: the path under `m`, in 2^shift supersamples
 *  per pixel side, winding or even-odd, or with `inverse` the gaps its fill leaves within `clip`
 *  (SkScan's InverseBlitter) */
export function scan(path: NativePath, clip: Box, m: Mat2D | null = null, shift = 0, inverse = path.inverseFill): Band[] {
  const sink = new EdgeSink(m, shift);
  walkPath(path, sink);
  sink.closePath();
  const edges = sink.edges.sort(byFirst), evenOdd = path.fillRule === "evenodd", out: Band[] = [];
  let lo = clip.top, hi = clip.bottom;
  if (!inverse) {
    let end = -Infinity;
    for (const e of edges) if (e.last >= end) end = e.last + 1;
    lo = Math.max(lo, edges.length ? edges[0].first : hi);
    hi = Math.min(hi, end);
  }
  const active: ScanEdge[] = [], xs: number[] = [], gaps: number[] = [];
  let next = 0, count = 0;
  for (let y = lo; y < hi; y++) {
    let n = 0;
    for (let i = 0; i < count; i++) if (active[i].last >= y) active[n++] = active[i];
    for (; next < edges.length && edges[next].first <= y; next++) if (edges[next].last >= y) active[n++] = edges[next];
    count = n;
    // x on this row, insertion-sorted: the order changes little from row to row
    for (let i = 0; i < count; i++) {
      const e = active[i], at = e.at = e.x + e.dx * (y - e.first);
      let j = i;
      for (; j > 0 && active[j - 1].at > at; j--) active[j] = active[j - 1];
      active[j] = e;
    }
    xs.length = 0;
    let w = 0, left = 0;
    for (let i = 0; i < count; i++) {
      const e = active[i], x = Math.floor((e.at + 0x8000) / 65536);
      if (!(evenOdd ? w & 1 : w)) left = x;
      w += e.winding;
      if (evenOdd ? w & 1 : w) continue;
      const l = Math.max(left, clip.left), r = Math.min(x, clip.right);
      if (l >= r) continue;
      if (xs.length && xs[xs.length - 1] >= l) xs[xs.length - 1] = Math.max(xs[xs.length - 1], r);
      else xs.push(l, r);
    }
    let spans = xs;
    if (inverse) {
      gaps.length = 0;
      let x = clip.left;
      for (let i = 0; i < xs.length; i += 2) { if (xs[i] > x) gaps.push(x, xs[i]); x = xs[i + 1]; }
      if (x < clip.right) gaps.push(x, clip.right);
      spans = gaps;
    }
    if (!spans.length) continue;
    const last = out[out.length - 1];
    if (last && last.bottom === y && sameSpans(last.xs, spans)) last.bottom = y + 1;
    else out.push({ top: y, bottom: y + 1, xs: spans.slice() });
  }
  return out;
}
