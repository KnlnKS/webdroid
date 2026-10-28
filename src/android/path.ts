// The native half of android.graphics.Path (the geometry behind mNativePath) and PathIterator,
// following SkPath and AOSP's PathUtils. PathMeasure is pathmeasure.ts; Path.op and the stroker
// are CanvasKit's (skia.ts).
//
// A path is one flat list of ops, each a numeric tag and its arguments. Compound shapes (rect,
// round rect, oval, arc) stay whole so Path2D can draw them natively; `Pen` expands them into the
// verbs and point order SkPath stores (a conic becomes the cubic that approximates it), in the
// same flat form, which iteration, measurement, bounds and every non-native Path2D build read.

import { rt, noops, peerField } from "../jvm/runtime.ts";
import { deref, handle, release, FINALIZER } from "./handles.ts";
import { type Mat, mapPoint, matrixAt, snap } from "./matrix.ts";
import { setEdges, type Box } from "./graphics.ts";
import type { Ctx2D } from "./recording.ts";
import { conicToQuads } from "./scan.ts";

/** SkPath::Verb, which PathIterator reports; a path's ops extend them with the compound shapes:
 *  RECT l t r b dir start, RRECT l t r b (8 radii) dir, OVAL l t r b dir start, ARC l t r b start sweep forceMoveTo */
export const MOVE = 0, LINE = 1, QUAD = 2, CONIC = 3, CUBIC = 4, CLOSE = 5, DONE = 6;
export const RECT = 7, RRECT = 8, OVAL = 9, ARC = 10;
/** each op's argument count, and how many leading (x, y) pairs of them are points */
const ARGS = [2, 2, 4, 5, 6, 0, 0, 6, 13, 6, 7];
const PAIRS = [1, 1, 2, 2, 3, 0, 0, 2, 2, 2, 2];
/** how many numbers SkPath::RawIter gives a verb: its points from the segment's start, a conic's weight after them */
export const RAW_SIZE = [2, 4, 6, 7, 8, 0];
/** what the pen writes to: Path2D itself, the verb list, or a scan converter */
export interface Sink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(x1: number, y1: number, x2: number, y2: number): void;
  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void;
  /** a sink that takes conics gets them as Skia stores them; the others get the cubic */
  conicTo?(x1: number, y1: number, x2: number, y2: number, w: number): void;
  closePath(): void;
}

/** Path$Direction.nativeInt */
const CW = 0, CCW = 1;
const NEARLY_ZERO = 1 / 4096;

// SkPath_PointIterator's rectangle (tl, tr, br, bl) and oval (top, right, bottom, left) points
const cornerX = (i: number, l: number, r: number) => (i === 1 || i === 2 ? r : l);
const cornerY = (i: number, t: number, b: number) => (i < 2 ? t : b);
const ovalX = (i: number, l: number, r: number) => (i === 1 ? r : i === 3 ? l : (l + r) / 2);
const ovalY = (i: number, t: number, b: number) => (i === 0 ? t : i === 2 ? b : (t + b) / 2);
// SkRRect's eight radius points, clockwise from the top edge's left end; q holds (x, y) per corner tl, tr, br, bl
function rrX(i: number, l: number, r: number, q: number[]) {
  return i === 0 ? l + q[0] : i === 1 ? r - q[2] : i === 2 || i === 3 ? r : i === 4 ? r - q[4] : i === 5 ? l + q[6] : l;
}
function rrY(i: number, t: number, b: number, q: number[]) {
  return i < 2 ? t : i === 2 ? t + q[3] : i === 3 ? b - q[5] : i < 6 ? b : i === 6 ? b - q[7] : t + q[1];
}

/**
 * SkRRect::setRectRadii's radii for the RRECT op at `i` of a w x h rect: a corner with either
 * radius not positive is square, and every radius shrinks by the one factor that keeps each
 * edge's pair of corners within its length.
 */
function rrRadii(o: number[], i: number, w: number, h: number): number[] {
  const q = o.slice(i + 5, i + 13);
  for (let k = 0; k < 8; k += 2) if (!(q[k] > 0 && q[k + 1] > 0 && Number.isFinite(q[k]) && Number.isFinite(q[k + 1]))) q[k] = q[k + 1] = 0;
  let f = 1;
  const fit = (sum: number, ext: number) => { if (sum > ext) f = Math.min(f, ext / sum); };
  fit(q[0] + q[2], w); fit(q[3] + q[5], h); fit(q[4] + q[6], w); fit(q[7] + q[1], h);
  return f < 1 ? q.map((v) => v * f) : q;
}
const nearly = (a: number, b: number) => Math.abs(a - b) <= NEARLY_ZERO;

/**
 * Walks ops as SkPath stores them: tracks the last point and the contour's start (SkPath injects a
 * moveTo there before a segment that follows a close), and writes to a sink, a bounds box, or
 * neither when only the position matters.
 */
class Pen {
  sink: Sink | null; readonly box: Box | null;
  x = 0; y = 0; sx = 0; sy = 0;
  /** a contour is open: segments continue it rather than starting one at (sx, sy) */
  open = false;
  /** no verb yet: an arc then starts with a moveTo */
  empty = true;
  constructor(sink: Sink | null = null, box: Box | null = null) { this.sink = sink; this.box = box; }
  clear() { this.x = this.y = this.sx = this.sy = 0; this.open = false; this.empty = true; }
  copy(o: Pen) { this.x = o.x; this.y = o.y; this.sx = o.sx; this.sy = o.sy; this.open = o.open; this.empty = o.empty; }
  private pt(x: number, y: number) {
    const b = this.box;
    if (!b) return;
    if (x < b.left) b.left = x;
    if (x > b.right) b.right = x;
    if (y < b.top) b.top = y;
    if (y > b.bottom) b.bottom = y;
  }
  private begin() { if (!this.open) this.move(this.x, this.y); }
  move(x: number, y: number) {
    this.sink?.moveTo(x, y); this.pt(x, y);
    this.x = this.sx = x; this.y = this.sy = y; this.open = true; this.empty = false;
  }
  line(x: number, y: number) { this.begin(); this.sink?.lineTo(x, y); this.pt(x, y); this.x = x; this.y = y; }
  quad(x1: number, y1: number, x2: number, y2: number) {
    this.begin(); this.sink?.quadraticCurveTo(x1, y1, x2, y2); this.pt(x1, y1); this.pt(x2, y2); this.x = x2; this.y = y2;
  }
  cubic(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
    this.begin(); this.sink?.bezierCurveTo(x1, y1, x2, y2, x3, y3);
    this.pt(x1, y1); this.pt(x2, y2); this.pt(x3, y3); this.x = x3; this.y = y3;
  }
  /** an elliptical conic (weight cos(θ/2) for an arc of θ ≤ 90°) as its cubic; bounds keep the conic's control point, as Skia's do */
  conic(x1: number, y1: number, x2: number, y2: number, w: number) {
    this.begin();
    const k = 4 * w / (3 * (1 + w));
    if (this.sink?.conicTo) this.sink.conicTo(x1, y1, x2, y2, w);
    else this.sink?.bezierCurveTo(this.x + (x1 - this.x) * k, this.y + (y1 - this.y) * k, x2 + (x1 - x2) * k, y2 + (y1 - y2) * k, x2, y2);
    this.pt(x1, y1); this.pt(x2, y2); this.x = x2; this.y = y2;
  }
  close() {
    if (this.open) { this.sink?.closePath(); this.open = false; }
    this.x = this.sx; this.y = this.sy;
  }
  /** SkPath::addRect: the four corners from `start`, then a close */
  rect(l: number, t: number, r: number, b: number, dir: number, start: number) {
    const step = dir === CW ? 1 : 3;
    let i = start;
    this.move(cornerX(i, l, r), cornerY(i, t, b));
    for (let n = 0; n < 3; n++) { i = (i + step) & 3; this.line(cornerX(i, l, r), cornerY(i, t, b)); }
    this.close();
  }
  /** SkPath::addOval: four quarter conics from `start`, each controlled by the corner behind it */
  oval(l: number, t: number, r: number, b: number, dir: number, start: number) {
    const step = dir === CW ? 1 : 3;
    let o = start, c = start + (dir === CW ? 0 : 1);
    this.move(ovalX(o, l, r), ovalY(o, t, b));
    for (let n = 0; n < 4; n++) {
      o = (o + step) & 3; c = (c + step) & 3;
      this.conic(cornerX(c, l, r), cornerY(c, t, b), ovalX(o, l, r), ovalY(o, t, b), Math.SQRT1_2);
    }
    this.close();
  }
  /** SkPath::addRRect of the RRECT op at `i`, with its default start (the left edge's lower end
   *  clockwise, upper counterclockwise) */
  rrect(o: number[], i: number) {
    const l = Math.min(o[i + 1], o[i + 3]), r = Math.max(o[i + 1], o[i + 3]), t = Math.min(o[i + 2], o[i + 4]), b = Math.max(o[i + 2], o[i + 4]);
    const dir = o[i + 13], start = dir === CW ? 6 : 7, q = rrRadii(o, i, r - l, b - t);
    if (r === l || b === t || q.every((v) => v === 0)) return this.rect(l, t, r, b, dir, (start + 1) >> 1);
    if (q.every((v, k) => v === q[k & 1]) && q[0] >= (r - l) / 2 && q[1] >= (b - t) / 2) return this.oval(l, t, r, b, dir, start >> 1);
    const step = dir === CW ? 1 : 7, cstep = dir === CW ? 1 : 3;
    // from an edge's end: that edge, then the corner conic, four times over
    let p = start, c = (start >> 1) + (dir === CW ? 0 : 1);
    this.move(rrX(p, l, r, q), rrY(p, t, b, q));
    for (let n = 0; n < 4; n++) {
      p = (p + step) & 7;
      this.line(rrX(p, l, r, q), rrY(p, t, b, q));
      p = (p + step) & 7; c = (c + cstep) & 3;
      this.conic(cornerX(c, l, r), cornerY(c, t, b), rrX(p, l, r, q), rrY(p, t, b, q), Math.SQRT1_2);
    }
    this.close();
  }
  /** SkPath::arcTo: the arc's start joined by a moveTo (forced) or a line, then a conic per quadrant */
  arc(l: number, t: number, r: number, b: number, startDeg: number, sweepDeg: number, force: boolean) {
    if (this.empty) force = true;
    const cx = (l + r) / 2, cy = (t + b) / 2, rx = (r - l) / 2, ry = (b - t) / 2;
    const addPt = (x: number, y: number) => {
      if (force) this.move(x, y);
      else if (this.empty || !nearly(this.x, x) || !nearly(this.y, y)) this.line(x, y);
    };
    if (sweepDeg === 0 && (startDeg === 0 || startDeg === 360)) return addPt(r, cy);
    if (r === l && b === t) return addPt(r, t);
    // angles_to_unit_vectors, in float as Skia computes them
    const f = Math.fround, rad = Math.PI / 180, startRad = f(f(startDeg) * rad);
    let stopRad = f(f(startDeg + sweepDeg) * rad);
    const ux = snap(f(Math.cos(startRad))), uy = snap(f(Math.sin(startRad)));
    let vx = snap(f(Math.cos(stopRad))), vy = snap(f(Math.sin(stopRad)));
    const sw = Math.abs(sweepDeg);
    if (ux === vx && uy === vy && sw < 360 && sw > 359) {
      const delta = Math.sign(sweepDeg) / 512;
      do { stopRad = f(stopRad - delta); vx = snap(f(Math.cos(stopRad))); vy = snap(f(Math.sin(stopRad))); } while (ux === vx && uy === vy);
    }
    if (ux === vx && uy === vy) return addPt(cx + rx * Math.cos(stopRad), cy + ry * Math.sin(stopRad));
    // SkConic::BuildUnitArc: in the frame where the start is (1, 0), a quarter conic per full
    // quadrant and one for the rest, then rotated to the start, mirrored for counterclockwise
    const ccw = !(sweepDeg > 0), x = ux * vx + uy * vy;
    let y = ux * vy - uy * vx;
    const map = (px: number, py: number): [number, number] => {
      if (ccw) py = -py;
      return [cx + rx * (ux * px - uy * py), cy + ry * (uy * px + ux * py)];
    };
    if (Math.abs(y) <= NEARLY_ZERO && x > 0 && (y >= 0 && !ccw || y <= 0 && ccw)) return addPt(cx + rx * vx, cy + ry * vy);
    if (ccw) y = -y;
    const quadrant = y === 0 ? 2 : x === 0 ? (y > 0 ? 1 : 3) : (y < 0 ? 2 : 0) + ((x < 0) !== (y < 0) ? 1 : 0);
    addPt(...map(1, 0));
    for (let i = 0; i < quadrant; i++) {
      const [c1x, c1y] = map(QUADRANT_PTS[i * 4 + 2], QUADRANT_PTS[i * 4 + 3]);
      const [ex, ey] = map(QUADRANT_PTS[i * 4 + 4], QUADRANT_PTS[i * 4 + 5]);
      this.conic(c1x, c1y, ex, ey, Math.SQRT1_2);
    }
    const qx = QUADRANT_PTS[quadrant * 4], qy = QUADRANT_PTS[quadrant * 4 + 1], dot = qx * x + qy * y;
    if (dot < 1) {
      const cosHalf = Math.sqrt((1 + dot) / 2);
      let ox = qx + x, oy = qy + y;
      const k = 1 / cosHalf / Math.hypot(ox, oy);
      ox *= k; oy *= k;
      if (Math.hypot(ox - qx, oy - qy) > NEARLY_ZERO) {
        const [c1x, c1y] = map(ox, oy), [ex, ey] = map(x, y);
        this.conic(c1x, c1y, ex, ey, cosHalf);
      }
    }
  }
  /** the op at `i` of `o` */
  op(o: number[], i: number) {
    switch (o[i]) {
      case MOVE: this.move(o[i + 1], o[i + 2]); break;
      case LINE: this.line(o[i + 1], o[i + 2]); break;
      case QUAD: this.quad(o[i + 1], o[i + 2], o[i + 3], o[i + 4]); break;
      case CONIC: this.conic(o[i + 1], o[i + 2], o[i + 3], o[i + 4], o[i + 5]); break;
      case CUBIC: this.cubic(o[i + 1], o[i + 2], o[i + 3], o[i + 4], o[i + 5], o[i + 6]); break;
      case CLOSE: this.close(); break;
      case RECT: this.rect(o[i + 1], o[i + 2], o[i + 3], o[i + 4], o[i + 5], o[i + 6]); break;
      case RRECT: this.rrect(o, i); break;
      case OVAL: this.oval(o[i + 1], o[i + 2], o[i + 3], o[i + 4], o[i + 5], o[i + 6]); break;
      case ARC: this.arc(o[i + 1], o[i + 2], o[i + 3], o[i + 4], o[i + 5], o[i + 6], !!o[i + 7]); break;
    }
  }
}
/** the unit quadrant conics' points: (1,0) (1,1) (0,1) (-1,1) (-1,0) (-1,-1) (0,-1) (1,-1) */
const QUADRANT_PTS = [1, 0, 1, 1, 0, 1, -1, 1, -1, 0, -1, -1, 0, -1, 1, -1];

function walk(ops: number[], pen: Pen) { for (let i = 0; i < ops.length; i += 1 + ARGS[ops[i]]) pen.op(ops, i); }
/** the verbs SkPath stores for ops, in the ops' flat form: a conic as its cubic, or with
 *  `conics` as itself (CanvasKit's commands) */
export function expand(ops: number[], conics = false): number[] {
  const out: number[] = [];
  const sink: Sink = {
    moveTo: (x, y) => out.push(MOVE, x, y), lineTo: (x, y) => out.push(LINE, x, y), quadraticCurveTo: (a, b, x, y) => out.push(QUAD, a, b, x, y),
    bezierCurveTo: (a, b, c, d, x, y) => out.push(CUBIC, a, b, c, d, x, y), closePath: () => out.push(CLOSE),
  };
  if (conics) sink.conicTo = (a, b, x, y, w) => out.push(CONIC, a, b, x, y, w);
  walk(ops, new Pen(sink));
  return out;
}
const compound = (ops: number[]) => { for (let i = 0; i < ops.length; i += 1 + ARGS[ops[i]]) if (ops[i] > DONE) return true; return false; };

function offsetOps(ops: number[], dx: number, dy: number) {
  for (let i = 0; i < ops.length; i += 1 + ARGS[ops[i]]) for (let k = i + 1, n = PAIRS[ops[i]]; n--; k += 2) { ops[k] += dx; ops[k + 1] += dy; }
}
/**
 * SkPath::transform. A positive scale and translation keeps every compound op (an arc's angles
 * are parametric, so they survive a non-uniform scale); anything else expands them into the
 * curves Skia holds and maps each point, projectively under perspective.
 */
function transformOps(ops: number[], m: Mat): number[] {
  const kept = m[1] === 0 && m[3] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 1 && m[0] > 0 && m[4] > 0;
  const out = kept ? ops : expand(ops);
  for (let i = 0; i < out.length; i += 1 + ARGS[out[i]]) {
    for (let k = i + 1, n = PAIRS[out[i]]; n--; k += 2) {
      if (kept) { out[k] = m[0] * out[k] + m[2]; out[k + 1] = m[4] * out[k + 1] + m[5]; }
      else [out[k], out[k + 1]] = mapPoint(m, out[k], out[k + 1]);
    }
    if (out[i] === RRECT) for (let k = 0; k < 8; k++) out[i + 5 + k] *= k & 1 ? m[4] : m[0];
  }
  return out;
}

/** Path2D forms of the compound op at `i` it can draw itself */
function drawNative(p: Path2D, o: number[], i: number): boolean {
  const k = o[i], l = o[i + 1], t = o[i + 2], r = o[i + 3], b = o[i + 4];
  if (k === RECT && o[i + 5] === CW && o[i + 6] === 0) p.rect(l, t, r - l, b - t);
  else if (k === RRECT && o[i + 13] === CW) {
    const x = Math.min(l, r), y = Math.min(t, b), w = Math.abs(r - l), h = Math.abs(b - t), q = rrRadii(o, i, w, h);
    p.roundRect(x, y, w, h, [{ x: q[0], y: q[1] }, { x: q[2], y: q[3] }, { x: q[4], y: q[5] }, { x: q[6], y: q[7] }]);
  } else if (k === OVAL && l <= r && t <= b) {
    const start = o[i + 6], a = (start - 1) * Math.PI / 2, ccw = o[i + 5] === CCW;
    p.moveTo(ovalX(start, l, r), ovalY(start, t, b));
    p.ellipse((l + r) / 2, (t + b) / 2, (r - l) / 2, (b - t) / 2, 0, a, ccw ? a - 2 * Math.PI : a + 2 * Math.PI, ccw);
    p.closePath();
  } else if (k === ARC && l < r && t < b && o[i + 6] !== 0 && Math.abs(o[i + 6]) <= 359) {
    // a sweep near a whole turn is left to the pen, which snaps its ends as SkPath::arcTo does
    const start = o[i + 5] * Math.PI / 180, end = (o[i + 5] + o[i + 6]) * Math.PI / 180;
    const cx = (l + r) / 2, cy = (t + b) / 2, rx = (r - l) / 2, ry = (b - t) / 2;
    // Path2D's ellipse lines to the arc from the last point, or starts the first subpath at it
    if (o[i + 7] && i > 0) p.moveTo(cx + rx * Math.cos(start), cy + ry * Math.sin(start));
    p.ellipse(cx, cy, rx, ry, 0, start, end, o[i + 6] < 0);
  } else return false;
  return true;
}

let generations = 1;
/** SkPath: the geometry a Java Path's mNativePath names */
export class NativePath {
  /** the ops, flat: each tag, then its arguments */
  ops: number[] = [];
  fillRule: CanvasFillRule = "nonzero";
  inverseFill = false;
  /** where the next verb starts */
  readonly pen = new Pen();
  private p2d: Path2D | null = null;
  private vs: number[] | null = null;
  /** SkPathRef's generation ID, assigned when asked after a change; the empty path's is 1 */
  private gen = 1;

  path(): Path2D {
    if (!this.p2d) {
      const p = new Path2D(), pen = new Pen(p), ops = this.ops;
      for (let i = 0; i < ops.length; i += 1 + ARGS[ops[i]]) {
        if (!drawNative(p, ops, i)) { pen.op(ops, i); continue; }
        pen.sink = null; pen.op(ops, i); pen.sink = p;
      }
      this.p2d = p;
    }
    return this.p2d;
  }
  /** the path filled on `ctx` by its fill rule, whatever its inverseness; a lone rect by fillRect */
  fill(ctx: Ctx2D): void {
    const o = this.ops;
    if (o.length === 7 && o[0] === RECT && o[5] === CW && o[6] === 0) ctx.fillRect(o[1], o[2], o[3] - o[1], o[4] - o[2]);
    else ctx.fill(this.path(), this.fillRule);
  }
  stroke(ctx: Ctx2D): void {
    const o = this.ops;
    if (o.length === 7 && o[0] === RECT && o[5] === CW && o[6] === 0) ctx.strokeRect(o[1], o[2], o[3] - o[1], o[4] - o[2]);
    else ctx.stroke(this.path());
  }
  readonly clips = true;
  clip(ctx: Ctx2D): void { ctx.clip(this.path(), this.fillRule); }
  /** the verbs SkPath stores, until the path changes; they are not to be modified */
  verbs(): number[] { return this.vs ??= expand(this.ops); }
  private changed() { this.p2d = null; this.vs = null; this.gen = 0; }
  /** SkPath::injectMoveToIfNeeded: a segment with no open contour starts one where the pen is */
  private begin() { if (!this.pen.open) this.moveTo(this.pen.x, this.pen.y); }
  private replaceOps(ops: number[]) {
    this.ops = ops;
    this.pen.clear();
    walk(ops, this.pen);
    this.changed();
  }

  generation(): number {
    if (!this.gen) {
      if (!this.ops.length) this.gen = 1;
      else do this.gen = ++generations & 0x3fffffff; while (this.gen < 2);
    }
    return (this.gen | this.fillType() << 30) | 0;
  }
  fillType(): number { return (this.fillRule === "evenodd" ? 1 : 0) | (this.inverseFill ? 2 : 0); }
  setFillType(ft: number) { this.fillRule = ft & 1 ? "evenodd" : "nonzero"; this.inverseFill = !!(ft & 2); this.p2d = null; }

  moveTo(x: number, y: number) { this.ops.push(MOVE, x, y); this.pen.move(x, y); this.changed(); }
  lineTo(x: number, y: number) { this.begin(); this.ops.push(LINE, x, y); this.pen.line(x, y); this.changed(); }
  quadTo(x1: number, y1: number, x2: number, y2: number) { this.begin(); this.ops.push(QUAD, x1, y1, x2, y2); this.pen.quad(x1, y1, x2, y2); this.changed(); }
  cubicTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) {
    this.begin(); this.ops.push(CUBIC, x1, y1, x2, y2, x3, y3); this.pen.cubic(x1, y1, x2, y2, x3, y3); this.changed();
  }
  /** SkPath::conicTo, the rational quadratic kept as the quadratics SkAutoConicToQuads makes of it */
  conicTo(x1: number, y1: number, x2: number, y2: number, w: number) {
    if (!(w > 0)) return this.lineTo(x2, y2);
    if (!Number.isFinite(w)) { this.lineTo(x1, y1); return this.lineTo(x2, y2); }
    if (w === 1) return this.quadTo(x1, y1, x2, y2);
    this.begin();
    const q = conicToQuads(this.pen.x, this.pen.y, x1, y1, x2, y2, w);
    for (let i = 0; i < q.length; i += 4) this.quadTo(q[i], q[i + 1], q[i + 2], q[i + 3]);
  }
  close() {
    if (this.pen.open) { this.ops.push(CLOSE); this.changed(); }
    this.pen.close();
  }
  addRect(l: number, t: number, r: number, b: number, dir: number) { this.ops.push(RECT, l, t, r, b, dir, 0); this.pen.rect(l, t, r, b, dir, 0); this.changed(); }
  addOval(l: number, t: number, r: number, b: number, dir: number, start = 1) {
    this.ops.push(OVAL, l, t, r, b, dir, start); this.pen.oval(l, t, r, b, dir, start); this.changed();
  }
  addCircle(x: number, y: number, r: number, dir: number) { if (r > 0) this.addOval(x - r, y - r, x + r, y + r, dir); }
  /** radii: (x, y) per corner, clockwise from top-left */
  addRoundRect(l: number, t: number, r: number, b: number, radii: ArrayLike<number>, dir: number) {
    const i = this.ops.length;
    this.ops.push(RRECT, l, t, r, b, radii[0], radii[1], radii[2], radii[3], radii[4], radii[5], radii[6], radii[7], dir);
    this.pen.rrect(this.ops, i);
    this.changed();
  }
  arcTo(l: number, t: number, r: number, b: number, start: number, sweep: number, force: boolean) {
    if (r - l < 0 || b - t < 0) return;
    force ||= !this.ops.length;
    this.ops.push(ARC, l, t, r, b, start, sweep, +force);
    this.pen.arc(l, t, r, b, start, sweep, force);
    this.changed();
  }
  /** SkPath::addArc: a whole turn from a quadrant point is an oval; anything else a new contour */
  addArc(l: number, t: number, r: number, b: number, start: number, sweep: number) {
    if (!(l < r && t < b) || sweep === 0) return;
    if (sweep >= 360 || sweep <= -360) {
      const q = start / 90, qi = Math.floor(q + 0.5);
      if (nearly(q, qi)) return this.addOval(l, t, r, b, sweep > 0 ? CW : CCW, (((qi + 1) % 4) + 4) % 4);
    }
    this.arcTo(l, t, r, b, start, sweep, true);
  }
  reset() {
    this.ops.length = 0;
    this.fillRule = "nonzero"; this.inverseFill = false;
    this.pen.clear();
    this.p2d = this.vs = null; this.gen = 1;
  }
  set(src: NativePath) {
    if (src === this) return;
    this.ops = src.ops.slice();
    this.fillRule = src.fillRule; this.inverseFill = src.inverseFill;
    this.pen.copy(src.pen);
    this.changed();
  }
  /** SkPath::addPath in append mode, through `m` when given */
  append(src: NativePath, m?: Mat, dx = 0, dy = 0) {
    if (!src.ops.length) return;
    let ops = src.ops.slice();
    if (m) ops = transformOps(ops, m);
    if (dx || dy) offsetOps(ops, dx, dy);
    for (let i = 0; i < ops.length; i += 1 + ARGS[ops[i]]) {
      for (let k = i, end = i + 1 + ARGS[ops[i]]; k < end; k++) this.ops.push(ops[k]);
      this.pen.op(ops, i);
    }
    this.changed();
  }
  offset(dx: number, dy: number) {
    offsetOps(this.ops, dx, dy);
    const pen = this.pen;
    pen.x += dx; pen.y += dy; pen.sx += dx; pen.sy += dy;
    this.changed();
  }
  transform(m: Mat) {
    this.ops = transformOps(this.ops, m);
    const pen = this.pen;
    [pen.x, pen.y] = mapPoint(m, pen.x, pen.y);
    [pen.sx, pen.sy] = mapPoint(m, pen.sx, pen.sy);
    this.changed();
  }
  /** SkPath::setLastPt: moves the last stored point, or starts the path there */
  setLastPoint(x: number, y: number) {
    if (!this.ops.length) return this.moveTo(x, y);
    const ops = compound(this.ops) ? expand(this.ops) : this.ops;
    let last = 0;
    for (let i = 0; i < ops.length; i += 1 + ARGS[ops[i]]) if (ops[i] !== CLOSE) last = i;
    const at = last + 2 * PAIRS[ops[last]] - 1;
    ops[at] = x; ops[at + 1] = y;
    this.replaceOps(ops);
  }
  /** SkPath::getBounds: every stored point, conic control points included */
  bounds(): Box {
    const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    walk(this.ops, new Pen(null, box));
    return box.left === Infinity ? { left: 0, top: 0, right: 0, bottom: 0 } : box;
  }
  /** SkPath::isFinite */
  finite(): boolean {
    const b = this.bounds();
    return Number.isFinite(b.left + b.top + b.right + b.bottom);
  }
  /** SkPath::isRect: one contour of axis-aligned lines turning four right angles, closed or implicitly */
  isRect(): Box | null {
    const vs = this.verbs(), xs: number[] = [], ys: number[] = [];
    let i = 0;
    for (; i < vs.length; i += 1 + ARGS[vs[i]]) {
      const v = vs[i];
      if (v === MOVE) { if (xs.length) break; xs.push(vs[i + 1]); ys.push(vs[i + 2]); }
      else if (v === LINE) { if (vs[i + 1] !== xs.at(-1) || vs[i + 2] !== ys.at(-1)) { xs.push(vs[i + 1]); ys.push(vs[i + 2]); } }
      else if (v === CLOSE) { i++; break; }
      else return null;
    }
    for (; i < vs.length; i += 1 + ARGS[vs[i]]) if (vs[i] !== MOVE) return null;
    if (xs.length > 1 && xs[0] === xs.at(-1) && ys[0] === ys.at(-1)) { xs.pop(); ys.pop(); }
    const dirs: number[] = [];
    for (let k = 0; k < xs.length; k++) {
      const dx = xs[(k + 1) % xs.length] - xs[k], dy = ys[(k + 1) % xs.length] - ys[k];
      if ((dx === 0) === (dy === 0)) return null;
      const d = dx > 0 ? 0 : dy > 0 ? 1 : dx < 0 ? 2 : 3;
      if (d !== dirs.at(-1)) dirs.push(d);
    }
    if (dirs.length > 1 && dirs[0] === dirs.at(-1)) dirs.pop();
    if (dirs.length !== 4 || dirs.some((d, k) => ((dirs[(k + 1) & 3] - d) & 1) === 0)) return null;
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
  }
  /** SkPath::isInterpolatable: the same verbs */
  isInterpolatable(o: NativePath): boolean {
    const a = this.verbs(), b = o.verbs();
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1 + ARGS[a[i]]) if (a[i] !== b[i]) return false;
    return true;
  }
  /** SkPath::interpolate: out holds this path's verbs over points weighted `w` toward this path */
  interpolate(end: NativePath, w: number, out: NativePath): boolean {
    const a = this.verbs(), b = pointsOf(end.verbs());
    if (pointsOf(a).length !== b.length) return false;
    if (!b.length) return true;
    const ops = a.slice();
    for (let i = 0, k = 0; i < ops.length; i += 1 + ARGS[ops[i]]) {
      for (let j = i + 1, n = 2 * PAIRS[ops[i]]; n--; j++, k++) ops[j] = Math.fround(b[k] + (ops[j] - b[k]) * w);
    }
    out.reset();
    out.replaceOps(ops);
    return true;
  }
}
/** the points of flat ops, x and y in turn */
function pointsOf(ops: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < ops.length; i += 1 + ARGS[ops[i]]) for (let k = i + 1, n = 2 * PAIRS[ops[i]]; n--; k++) out.push(ops[k]);
  return out;
}
/** a path's verbs, as SkPath stores them, into `sink` */
export const walkPath = (path: NativePath, sink: Sink) => walk(path.ops, new Pen(sink));

/** SkPath::RawIter over a snapshot of the verbs, as PathIterator, androidx's pre-34 iterator and
 *  the measures walk them: each verb with its RAW_SIZE numbers */
export class VerbIterator {
  private readonly vs: number[];
  private i = 0;
  /** the point a segment starts from */
  private x = 0; private y = 0;
  constructor(p: NativePath) { this.vs = p.verbs(); }
  peek(): number { return this.i < this.vs.length ? this.vs[this.i] : DONE; }
  /** how many verbs there are */
  get count(): number {
    let n = 0;
    for (let i = 0; i < this.vs.length; i += 1 + ARGS[this.vs[i]]) n++;
    return n;
  }
  next(pts: { [k: number]: number }, off = 0): number {
    const vs = this.vs, i = this.i;
    if (i >= vs.length) return DONE;
    const verb = vs[i], n = ARGS[verb];
    this.i = i + 1 + n;
    if (verb === CLOSE) return verb;
    let k = off;
    if (verb !== MOVE) { pts[k++] = this.x; pts[k++] = this.y; }
    for (let j = i + 1; j <= i + n; j++) pts[k++] = vs[j];
    const end = i + 2 * PAIRS[verb] - 1;
    this.x = vs[end]; this.y = vs[end + 1];
    return verb;
  }
}

export const pathAt = (h: bigint) => deref<NativePath>(h);
const mNativePath = peerField<bigint>("android/graphics/Path", "mNativePath");
/** the geometry behind a Java Path */
export const nativePathOf = (p: object): NativePath => pathAt(mNativePath(p));

type Pt = [number, number];
const scratch = new Float64Array(8);
// Skia tests the control polygon, including implicit closure, rather than sampling curves.
export function pathIsConvex(path: NativePath): boolean {
  const points: Pt[] = [], it = new VerbIterator(path), v = scratch;
  let start: Pt = [0, 0], ended = false;
  for (let verb; (verb = it.next(v)) !== DONE;) {
    for (let k = 0; k < RAW_SIZE[verb]; k++) if (!Number.isFinite(Math.fround(v[k]))) return false;
    if (verb === MOVE) {
      if (points.length) ended = true;
      start = [Math.fround(v[0]), Math.fround(v[1])];
      continue;
    }
    if (ended) return false;
    if (!points.length) points.push(start);
    if (verb === CLOSE) { ended = true; continue; }
    for (let k = 2; k < 2 + 2 * PAIRS[verb]; k += 2) {
      const x = Math.fround(v[k]), y = Math.fround(v[k + 1]), last = points[points.length - 1];
      if (last[0] !== x || last[1] !== y) points.push([x, y]);
    }
  }
  if (points.length < 2) return true;
  const vectors: Pt[] = [];
  let xChanges = 0, yChanges = 0, lastX = -1, lastY = -1;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const x = Math.fround(b[0] - a[0]), y = Math.fround(b[1] - a[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x === 0 && y === 0) continue;
    const sx = x < 0 ? 1 : 0, sy = y < 0 ? 1 : 0;
    if (sx !== lastX) xChanges++;
    if (sy !== lastY) yChanges++;
    if (xChanges > 3 || yChanges > 3) return false;
    lastX = sx; lastY = sy;
    vectors.push([x, y]);
  }
  let direction = 0, reversals = 0;
  let [lastVX, lastVY] = vectors[0];
  for (let i = 1; i <= vectors.length; i++) {
    const [x, y] = vectors[i % vectors.length];
    const cross = Math.fround(Math.fround(lastVX * y) - Math.fround(lastVY * x));
    if (!Number.isFinite(cross)) return false;
    if (cross !== 0) {
      const turn = Math.sign(cross);
      if (direction && turn !== direction) return false;
      direction = turn;
    } else {
      if (Math.fround(Math.fround(lastVX * x) + Math.fround(lastVY * y)) >= 0) continue;
      if (++reversals > 2) return false;
    }
    lastVX = x; lastVY = y;
  }
  return true;
}

/**
 * Path.approximate (AOSP's PathUtils over SkPath::Iter): [fraction of length, x, y] per point, curves
 * subdivided until each chord's midpoint lies within `error` of the curve's.
 */
export function approximate(p: NativePath, error: number): Float32Array {
  const xs: number[] = [], ys: number[] = [], lens: number[] = [];
  const err2 = error * error;
  const move = (x: number, y: number) => { lens.push(lens.at(-1) ?? 0); xs.push(x); ys.push(y); };
  const line = (x: number, y: number) => {
    const lx = xs.at(-1)!, ly = ys.at(-1)!;
    if (lx === x && ly === y) return;
    lens.push(lens.at(-1)! + Math.hypot(x - lx, y - ly)); xs.push(x); ys.push(y);
  };
  const vs = p.verbs(), it = new VerbIterator(p), v = scratch;
  let mx = 0, my = 0;
  for (let verb; (verb = it.next(v)) !== DONE;) {
    switch (verb) {
      // SkPath::Iter reports no trailing moveTo
      case MOVE: if (it.peek() !== DONE) { move(mx = v[0], my = v[1]); } break;
      case LINE: line(v[2], v[3]); break;
      case QUAD: case CUBIC: {
        const at = verb === QUAD ? quadAt : cubicAt, end = 2 * PAIRS[verb];
        const sub = (t0: number, x0: number, y0: number, t1: number, x1: number, y1: number) => {
          const tm = (t0 + t1) / 2, xm = at(v, tm, 0), ym = at(v, tm, 1);
          const dx = (x0 + x1) / 2 - xm, dy = (y0 + y1) / 2 - ym;
          if (dx * dx + dy * dy > err2) { sub(t0, x0, y0, tm, xm, ym); sub(tm, xm, ym, t1, x1, y1); }
          else line(x1, y1);
        };
        sub(0, v[0], v[1], 1, v[end], v[end + 1]);
        break;
      }
      case CLOSE: line(mx, my); break;
    }
  }
  const lone = vs.length === 3;
  if (!xs.length) move(lone ? vs[1] : 0, lone ? vs[2] : 0);
  let total = lens.at(-1)!;
  // a lone point still animates, holding its value
  if (total === 0) { xs.push(xs.at(-1)!); ys.push(ys.at(-1)!); lens.push(total = 1); }
  const out = new Float32Array(xs.length * 3);
  for (let i = 0; i < xs.length; i++) { out[i * 3] = lens[i] / total; out[i * 3 + 1] = xs[i]; out[i * 3 + 2] = ys[i]; }
  return out;
}
/** coordinate `c` (0 = x, 1 = y) of a quadratic or cubic's raw points at t */
function quadAt(v: Float64Array, t: number, c: number) {
  const u = 1 - t;
  return u * (u * v[c] + t * v[2 + c]) + t * (u * v[2 + c] + t * v[4 + c]);
}
function cubicAt(v: Float64Array, t: number, c: number) {
  const u = 1 - t;
  return u * u * u * v[c] + 3 * u * u * t * v[2 + c] + 3 * u * t * t * v[4 + c] + t * t * t * v[6 + c];
}

// ── the natives of Path and PathIterator
rt.registerJnis("android/graphics/Path", {
  "nInit()J": () => handle(new NativePath()),
  // a null source is an empty path
  "nInit(J)J": (h: bigint) => { const p = new NativePath(); if (h) p.set(pathAt(h)); return handle(p); },
  "nGetFinalizer()J": () => FINALIZER,
  "nReset(J)V": (h: bigint) => pathAt(h).reset(),
  "nRewind(J)V": (h: bigint) => pathAt(h).reset(),
  "nSet(JJ)V": (h: bigint, s: bigint) => pathAt(h).set(pathAt(s)),
  "nIsEmpty(J)Z": (h: bigint) => +!pathAt(h).ops.length,
  "nGetGenerationID(J)I": (h: bigint) => pathAt(h).generation(),
  "nGetFillType(J)I": (h: bigint) => pathAt(h).fillType(),
  "nSetFillType(JI)V": (h: bigint, ft: number) => pathAt(h).setFillType(ft),

  "nMoveTo(JFF)V": (h: bigint, x: number, y: number) => pathAt(h).moveTo(x, y),
  "nLineTo(JFF)V": (h: bigint, x: number, y: number) => pathAt(h).lineTo(x, y),
  "nQuadTo(JFFFF)V": (h: bigint, x1: number, y1: number, x2: number, y2: number) => pathAt(h).quadTo(x1, y1, x2, y2),
  "nCubicTo(JFFFFFF)V": (h: bigint, a: number, b: number, c: number, d: number, e: number, f: number) => pathAt(h).cubicTo(a, b, c, d, e, f),
  "nConicTo(JFFFFF)V": (h: bigint, x1: number, y1: number, x2: number, y2: number, w: number) => pathAt(h).conicTo(x1, y1, x2, y2, w),
  // relative to the last point, which a close returns to the contour's start
  "nRMoveTo(JFF)V": (h: bigint, dx: number, dy: number) => { const p = pathAt(h); p.moveTo(p.pen.x + dx, p.pen.y + dy); },
  "nRLineTo(JFF)V": (h: bigint, dx: number, dy: number) => { const p = pathAt(h); p.lineTo(p.pen.x + dx, p.pen.y + dy); },
  "nRQuadTo(JFFFF)V": (h: bigint, a: number, b: number, c: number, d: number) => {
    const p = pathAt(h), { x, y } = p.pen;
    p.quadTo(x + a, y + b, x + c, y + d);
  },
  "nRCubicTo(JFFFFFF)V": (h: bigint, a: number, b: number, c: number, d: number, e: number, f: number) => {
    const p = pathAt(h), { x, y } = p.pen;
    p.cubicTo(x + a, y + b, x + c, y + d, x + e, y + f);
  },
  "nRConicTo(JFFFFF)V": (h: bigint, a: number, b: number, c: number, d: number, w: number) => {
    const p = pathAt(h), { x, y } = p.pen;
    p.conicTo(x + a, y + b, x + c, y + d, w);
  },
  "nClose(J)V": (h: bigint) => pathAt(h).close(),
  "nSetLastPoint(JFF)V": (h: bigint, x: number, y: number) => pathAt(h).setLastPoint(x, y),

  "nAddRect(JFFFFI)V": (h: bigint, l: number, t: number, r: number, b: number, d: number) => pathAt(h).addRect(l, t, r, b, d),
  "nAddOval(JFFFFI)V": (h: bigint, l: number, t: number, r: number, b: number, d: number) => pathAt(h).addOval(l, t, r, b, d),
  "nAddCircle(JFFFI)V": (h: bigint, x: number, y: number, r: number, d: number) => pathAt(h).addCircle(x, y, r, d),
  "nAddArc(JFFFFFF)V": (h: bigint, l: number, t: number, r: number, b: number, start: number, sweep: number) => pathAt(h).addArc(l, t, r, b, start, sweep),
  "nArcTo(JFFFFFFZ)V": (h: bigint, l: number, t: number, r: number, b: number, start: number, sweep: number, force: number) =>
    pathAt(h).arcTo(l, t, r, b, start, sweep, !!force),
  // SkPath::addRoundRect ignores a negative radius
  "nAddRoundRect(JFFFFFFI)V": (h: bigint, l: number, t: number, r: number, b: number, rx: number, ry: number, d: number) => {
    if (rx >= 0 && ry >= 0) pathAt(h).addRoundRect(l, t, r, b, [rx, ry, rx, ry, rx, ry, rx, ry], d);
  },
  "nAddRoundRect(JFFFF[FI)V": (h: bigint, l: number, t: number, r: number, b: number, radii: Float32Array, d: number) => pathAt(h).addRoundRect(l, t, r, b, radii, d),
  "nAddPath(JJ)V": (h: bigint, o: bigint) => pathAt(h).append(pathAt(o)),
  "nAddPath(JJFF)V": (h: bigint, o: bigint, dx: number, dy: number) => pathAt(h).append(pathAt(o), undefined, dx, dy),
  "nAddPath(JJJ)V": (h: bigint, o: bigint, mat: bigint) => pathAt(h).append(pathAt(o), matrixAt(mat)),

  "nOffset(JFF)V": (h: bigint, dx: number, dy: number) => pathAt(h).offset(dx, dy),
  "nTransform(JJ)V": (h: bigint, mat: bigint) => pathAt(h).transform(matrixAt(mat)),
  // a null destination transforms in place
  "nTransform(JJJ)V": (h: bigint, mat: bigint, dst: bigint) => {
    const d = dst ? pathAt(dst) : pathAt(h);
    d.set(pathAt(h));
    d.transform(matrixAt(mat));
  },
  "nComputeBounds(JLandroid/graphics/RectF;)V": (h: bigint, r: object) => setEdges(r, pathAt(h).bounds()),
  "nIsRect(JLandroid/graphics/RectF;)Z": (h: bigint, r: object) => {
    const b = pathAt(h).isRect();
    if (b) setEdges(r, b);
    return +!!b;
  },
  "nIsConvex(J)Z": (h: bigint) => +pathIsConvex(pathAt(h)),
  "nIsInterpolatable(JJ)Z": (a: bigint, b: bigint) => +pathAt(a).isInterpolatable(pathAt(b)),
  "nInterpolate(JJFJ)Z": (a: bigint, b: bigint, t: number, out: bigint) => +pathAt(a).interpolate(pathAt(b), t, pathAt(out)),
  "nApproximate(JF)[F": (h: bigint, error: number) => approximate(pathAt(h), error),
  ...noops("nIncReserve(JI)V"),
});

// nNext writes into the non-movable float[8] whose address is its handle (VMRuntime.addressOf)
const iter = (h: bigint) => deref<VerbIterator>(h);
rt.registerJnis("android/graphics/PathIterator", {
  "nCreate(J)J": (p: bigint) => handle(new VerbIterator(pathAt(p))),
  "nGetFinalizer()J": () => FINALIZER,
  "nPeek(J)I": (h: bigint) => iter(h).peek(),
  "nNext(JJ)I": (h: bigint, pts: bigint) => iter(h).next(deref<Float32Array>(pts), 0),
});

// ── androidx.graphics.path (Compose/Material3 below API 34): its JNI walks Skia's verb and
// point arrays, as PathIterator does. Arcs come out as cubics rather than conics, so the
// conic-evaluation mode and tolerance have nothing to convert and Conic never appears.
rt.registerJnis("androidx/graphics/path/PathIteratorPreApi34Impl", {
  "createInternalPathIterator(Landroid/graphics/Path;IF)J": (p: object) => handle(new VerbIterator(nativePathOf(p))),
  "destroyInternalPathIterator(J)V": release,
  "internalPathIteratorHasNext(J)Z": (h: bigint) => +(iter(h).peek() !== DONE),
  "internalPathIteratorPeek(J)I": (h: bigint) => iter(h).peek(),
  "internalPathIteratorNext(J[FI)I": (h: bigint, pts: Float32Array, off: number) => iter(h).next(pts, off),
  "internalPathIteratorSize(J)I": (h: bigint) => iter(h).count,
  "internalPathIteratorRawSize(J)I": (h: bigint) => iter(h).count,
});
rt.claimNativeLib("androidx.graphics.path");
