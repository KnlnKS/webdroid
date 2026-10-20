// The native half of android.graphics.Path (the geometry behind mNativePath), PathMeasure and
// PathIterator, following SkPath, SkContourMeasure and AOSP's PathUtils.
//
// Compound shapes stay whole in the op list so Path2D can draw them natively; `Pen` expands them
// into the verbs and point order SkPath stores (a conic becomes the cubic that approximates it),
// which is what iteration, measurement, bounds and every non-native Path2D build read.

import { rt, peerField } from "../jvm/runtime.ts";
import { deref, handle, release } from "./handles.ts";
import { type Mat, mapPoint, snap } from "./matrix.ts";
import { after } from "../jvm/natives/jentry.ts";
import { type PathCommands, pathOp as skiaPathOp } from "./skia.ts";
import type { Box } from "./graphics.ts";

type PathOp = [string, ...number[]];
type Verb = number[];
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

/** SkPath::Verb, which PathIterator reports */
const MOVE = 0, LINE = 1, QUAD = 2, CUBIC = 4, CLOSE = 5, DONE = 6;
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
 * SkRRect::setRectRadii's radii for an "rrect" op (l, t, r, b, eight radii, direction): a corner
 * with either radius not positive is square, and every radius shrinks by the one factor that keeps
 * each edge's pair of corners within its length.
 */
function rrRadii(op: PathOp, w: number, h: number): number[] {
  const q = op.slice(5, 13) as number[];
  for (let i = 0; i < 8; i += 2) if (!(q[i] > 0 && q[i + 1] > 0 && Number.isFinite(q[i]) && Number.isFinite(q[i + 1]))) q[i] = q[i + 1] = 0;
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
  /** SkPath::addRRect with its default start (the left edge's lower end clockwise, upper counterclockwise) */
  rrect(op: PathOp) {
    const l = Math.min(op[1], op[3]), r = Math.max(op[1], op[3]), t = Math.min(op[2], op[4]), b = Math.max(op[2], op[4]);
    const dir = op[13], start = dir === CW ? 6 : 7, q = rrRadii(op, r - l, b - t);
    if (r === l || b === t || q.every((v) => v === 0)) return this.rect(l, t, r, b, dir, (start + 1) >> 1);
    if (q.every((v, i) => v === q[i & 1]) && q[0] >= (r - l) / 2 && q[1] >= (b - t) / 2) return this.oval(l, t, r, b, dir, start >> 1);
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
  op(op: PathOp) {
    switch (op[0]) {
      case "m": this.move(op[1], op[2]); break;
      case "l": this.line(op[1], op[2]); break;
      case "q": this.quad(op[1], op[2], op[3], op[4]); break;
      case "c": this.cubic(op[1], op[2], op[3], op[4], op[5], op[6]); break;
      case "z": this.close(); break;
      case "rect": this.rect(op[1], op[2], op[3], op[4], op[5], op[6]); break;
      case "rrect": this.rrect(op); break;
      case "oval": this.oval(op[1], op[2], op[3], op[4], op[5], op[6]); break;
      case "arc": this.arc(op[1], op[2], op[3], op[4], op[5], op[6], !!op[7]); break;
    }
  }
}
/** the unit quadrant conics' points: (1,0) (1,1) (0,1) (-1,1) (-1,0) (-1,-1) (0,-1) (1,-1) */
const QUADRANT_PTS = [1, 0, 1, 1, 0, 1, -1, 1, -1, 0, -1, -1, 0, -1, 1, -1];

/** [verb, ...floats]: Move its point; Line/Quad/Cubic the current point then 1/2/3 points; Close none */
class VerbSink implements Sink {
  verbs: Verb[] = [];
  private x = 0; private y = 0;
  moveTo(x: number, y: number) { this.verbs.push([MOVE, x, y]); this.x = x; this.y = y; }
  lineTo(x: number, y: number) { this.verbs.push([LINE, this.x, this.y, x, y]); this.x = x; this.y = y; }
  quadraticCurveTo(a: number, b: number, x: number, y: number) { this.verbs.push([QUAD, this.x, this.y, a, b, x, y]); this.x = x; this.y = y; }
  bezierCurveTo(a: number, b: number, c: number, d: number, x: number, y: number) { this.verbs.push([CUBIC, this.x, this.y, a, b, c, d, x, y]); this.x = x; this.y = y; }
  closePath() { this.verbs.push([CLOSE]); }
}
function walkOps(ops: PathOp[], pen: Pen) { for (const op of ops) pen.op(op); }
function pathVerbs(ops: PathOp[]): Verb[] {
  const sink = new VerbSink();
  walkOps(ops, new Pen(sink));
  return sink.verbs;
}
/** the inverse of pathVerbs: a flattened path back as ops */
function verbsToOps(vs: Verb[]): PathOp[] {
  const out: PathOp[] = [];
  for (const v of vs) {
    if (v[0] === MOVE) out.push(["m", v[1], v[2]]);
    else if (v[0] === LINE) out.push(["l", v[3], v[4]]);
    else if (v[0] === QUAD) out.push(["q", v[3], v[4], v[5], v[6]]);
    else if (v[0] === CUBIC) out.push(["c", v[3], v[4], v[5], v[6], v[7], v[8]]);
    else if (v[0] === CLOSE) out.push(["z"]);
  }
  return out;
}
/** the points SkPath stores for these verbs (a segment's start is the previous verb's end) */
const verbPoints = (vs: Verb[]) => vs.flatMap((v) => (v[0] === MOVE ? v.slice(1) : v.slice(3)));

/** Leading (x,y) pairs each op carries; everything after them is a scalar (radius, angle, direction). */
const opPairs: Record<string, number> = { m: 1, l: 1, q: 2, c: 3, z: 0, rect: 2, rrect: 2, oval: 2, arc: 2 };
/** an op's numbers, index for index */
const nums = (op: PathOp) => op as unknown as number[];
function offsetOps(ops: PathOp[], dx: number, dy: number) {
  for (const op of ops) for (let i = 1, n = opPairs[op[0]], v = nums(op); n--; i += 2) { v[i] += dx; v[i + 1] += dy; }
}
/**
 * SkPath::transform. A positive scale and translation keeps every compound op (an arc's angles
 * are parametric, so they survive a non-uniform scale); anything else expands them into the
 * curves Skia holds and maps each point, projectively under perspective.
 */
function transformOps(ops: PathOp[], m: Mat): PathOp[] {
  if (m[1] === 0 && m[3] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 1 && m[0] > 0 && m[4] > 0) {
    for (const op of ops) {
      const v = nums(op);
      for (let i = 1, n = opPairs[op[0]]; n--; i += 2) { v[i] = m[0] * v[i] + m[2]; v[i + 1] = m[4] * v[i + 1] + m[5]; }
      if (op[0] === "rrect") for (let i = 5; i < 13; i++) v[i] *= i & 1 ? m[0] : m[4];
    }
    return ops;
  }
  const out = verbsToOps(pathVerbs(ops));
  for (const op of out) for (let i = 1, n = opPairs[op[0]], v = nums(op); n--; i += 2) [v[i], v[i + 1]] = mapPoint(m, v[i], v[i + 1]);
  return out;
}

/** Path2D forms of the compound ops it can draw itself */
function drawNative(p: Path2D, op: PathOp): boolean {
  const [k, l, t, r, b] = op;
  if (k === "rect" && op[5] === CW && op[6] === 0) p.rect(l, t, r - l, b - t);
  else if (k === "rrect" && op[13] === CW) {
    const x = Math.min(l, r), y = Math.min(t, b), w = Math.abs(r - l), h = Math.abs(b - t), q = rrRadii(op, w, h);
    p.roundRect(x, y, w, h, [{ x: q[0], y: q[1] }, { x: q[2], y: q[3] }, { x: q[4], y: q[5] }, { x: q[6], y: q[7] }]);
  } else if (k === "oval" && l <= r && t <= b) {
    const a = (op[6] - 1) * Math.PI / 2, ccw = op[5] === CCW;
    p.moveTo(ovalX(op[6], l, r), ovalY(op[6], t, b));
    p.ellipse((l + r) / 2, (t + b) / 2, (r - l) / 2, (b - t) / 2, 0, a, ccw ? a - 2 * Math.PI : a + 2 * Math.PI, ccw);
    p.closePath();
  } else return false;
  return true;
}

let generations = 1;
/** SkPath: the geometry a Java Path's mNativePath names */
export class NativePath {
  ops: PathOp[] = [];
  fillRule: CanvasFillRule = "nonzero";
  inverseFill = false;
  /** where the next verb starts */
  readonly pen = new Pen();
  private p2d: Path2D | null = null;
  /** SkPathRef's generation ID, assigned when asked after a change; the empty path's is 1 */
  private gen = 1;

  path(): Path2D {
    if (!this.p2d) {
      const p = new Path2D(), pen = new Pen(p);
      for (const op of this.ops) {
        if (!drawNative(p, op)) { pen.op(op); continue; }
        pen.sink = null; pen.op(op); pen.sink = p;
      }
      this.p2d = p;
    }
    return this.p2d;
  }
  private changed() { this.p2d = null; this.gen = 0; }
  private add(op: PathOp) { this.ops.push(op); this.pen.op(op); this.changed(); }
  /** SkPath::injectMoveToIfNeeded: a segment with no open contour starts one where the pen is */
  private begin() { if (!this.pen.open) this.moveTo(this.pen.x, this.pen.y); }
  private replaceOps(ops: PathOp[]) {
    this.ops = ops;
    this.pen.clear();
    walkOps(ops, this.pen);
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

  moveTo(x: number, y: number) { this.add(["m", x, y]); }
  lineTo(x: number, y: number) { this.begin(); this.add(["l", x, y]); }
  quadTo(x1: number, y1: number, x2: number, y2: number) { this.begin(); this.add(["q", x1, y1, x2, y2]); }
  cubicTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number) { this.begin(); this.add(["c", x1, y1, x2, y2, x3, y3]); }
  /** SkPath::conicTo, with the rational quadratic subdivided into quadratics by Skia's error estimate */
  conicTo(x1: number, y1: number, x2: number, y2: number, w: number) {
    if (!(w > 0)) return this.lineTo(x2, y2);
    if (!Number.isFinite(w)) { this.lineTo(x1, y1); return this.lineTo(x2, y2); }
    if (w === 1) return this.quadTo(x1, y1, x2, y2);
    this.begin();
    const chop = (a: number, b: number, c: number, d: number, e: number, f: number, weight: number, depth: number) => {
      const error = Math.abs((weight - 1) / (4 * (weight + 1))) * Math.hypot(a - 2 * c + e, b - 2 * d + f);
      if (!(error > 0.25) || depth === 5) { this.add(["q", c, d, e, f]); return; }
      const s = 1 / (1 + weight), ws = weight * s;
      const ax = a * s + c * ws, ay = b * s + d * ws;
      const bx = e * s + c * ws, by = f * s + d * ws;
      const mx = (ax + bx) / 2, my = (ay + by) / 2, next = Math.sqrt((1 + weight) / 2);
      chop(a, b, ax, ay, mx, my, next, depth + 1);
      chop(mx, my, bx, by, e, f, next, depth + 1);
    };
    chop(this.pen.x, this.pen.y, x1, y1, x2, y2, w, 0);
  }
  close() { if (this.pen.open) this.add(["z"]); else this.pen.close(); }
  addRect(l: number, t: number, r: number, b: number, dir: number) { this.add(["rect", l, t, r, b, dir, 0]); }
  addOval(l: number, t: number, r: number, b: number, dir: number, start = 1) { this.add(["oval", l, t, r, b, dir, start]); }
  addCircle(x: number, y: number, r: number, dir: number) { if (r > 0) this.addOval(x - r, y - r, x + r, y + r, dir); }
  /** radii: (x, y) per corner, clockwise from top-left */
  addRoundRect(l: number, t: number, r: number, b: number, radii: ArrayLike<number>, dir: number) {
    this.add(["rrect", l, t, r, b, radii[0], radii[1], radii[2], radii[3], radii[4], radii[5], radii[6], radii[7], dir]);
  }
  arcTo(l: number, t: number, r: number, b: number, start: number, sweep: number, force: boolean) {
    if (r - l < 0 || b - t < 0) return;
    this.add(["arc", l, t, r, b, start, sweep, force || !this.ops.length ? 1 : 0]);
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
    this.ops = [];
    this.fillRule = "nonzero"; this.inverseFill = false;
    this.pen.clear();
    this.p2d = null; this.gen = 1;
  }
  set(src: NativePath) {
    if (src === this) return;
    this.ops = src.ops.map((op) => op.slice() as PathOp);
    this.fillRule = src.fillRule; this.inverseFill = src.inverseFill;
    this.pen.copy(src.pen);
    this.changed();
  }
  /** SkPath::addPath in append mode, through `m` when given */
  append(src: NativePath, m?: Mat, dx = 0, dy = 0) {
    if (!src.ops.length) return;
    let ops = src.ops.map((op) => op.slice() as PathOp);
    if (m) ops = transformOps(ops, m);
    if (dx || dy) offsetOps(ops, dx, dy);
    for (const op of ops) { this.ops.push(op); this.pen.op(op); }
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
    const ops = this.ops.some((op) => !(op[0] in SIMPLE)) ? verbsToOps(pathVerbs(this.ops)) : this.ops;
    let i = ops.length - 1;
    while (ops[i][0] === "z") i--;
    const op = ops[i];
    op[op.length - 2] = x; op[op.length - 1] = y;
    this.replaceOps(ops);
  }
  /** SkPath::getBounds: every stored point, conic control points included */
  bounds(): Box {
    const box = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
    walkOps(this.ops, new Pen(null, box));
    return box.left === Infinity ? { left: 0, top: 0, right: 0, bottom: 0 } : box;
  }
  /** SkPath::isRect: one contour of axis-aligned lines turning four right angles, closed or implicitly */
  isRect(): Box | null {
    const vs = pathVerbs(this.ops), xs: number[] = [], ys: number[] = [];
    let i = 0;
    for (; i < vs.length; i++) {
      const v = vs[i];
      if (v[0] === MOVE) { if (xs.length) break; xs.push(v[1]); ys.push(v[2]); }
      else if (v[0] === LINE) { if (v[3] !== xs.at(-1) || v[4] !== ys.at(-1)) { xs.push(v[3]); ys.push(v[4]); } }
      else if (v[0] === CLOSE) { i++; break; }
      else return null;
    }
    for (; i < vs.length; i++) if (vs[i][0] !== MOVE) return null;
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
    const a = pathVerbs(this.ops), b = pathVerbs(o.ops);
    return a.length === b.length && a.every((v, i) => v[0] === b[i][0]);
  }
  /** SkPath::interpolate: out holds this path's verbs over points weighted `w` toward this path */
  interpolate(end: NativePath, w: number, out: NativePath): boolean {
    const verbs = pathVerbs(this.ops), a = verbPoints(verbs), b = verbPoints(pathVerbs(end.ops));
    if (a.length !== b.length) return false;
    if (!a.length) return true;
    let k = 0;
    const ops = verbsToOps(verbs);
    for (const op of ops) for (let i = 1; i < op.length; i++, k++) op[i] = Math.fround(b[k] + (a[k] - b[k]) * w);
    out.reset();
    out.replaceOps(ops);
    return true;
  }
}
const SIMPLE: Record<string, true> = { m: true, l: true, q: true, c: true, z: true };
/** a path's verbs, as SkPath stores them, into `sink` */
export const walkPath = (path: NativePath, sink: Sink) => walkOps(path.ops, new Pen(sink));

export const pathAt = (h: bigint) => deref<NativePath>(h);
const mNativePath = peerField<bigint>("android/graphics/Path", "mNativePath");
/** the geometry behind a Java Path */
export const nativePathOf = (p: object): NativePath => pathAt(mNativePath(p));

// ── Path.op: SkPathOps, through the tab's CanvasKit
/** the path as CanvasKit's commands */
export function skCommands(path: NativePath): number[] {
  const cmds: number[] = [];
  walkPath(path, {
    moveTo: (x, y) => cmds.push(0, x, y), lineTo: (x, y) => cmds.push(1, x, y), quadraticCurveTo: (a, b, x, y) => cmds.push(2, a, b, x, y),
    conicTo: (a, b, x, y, w) => cmds.push(3, a, b, x, y, w), bezierCurveTo: (a, b, c, d, x, y) => cmds.push(4, a, b, c, d, x, y), closePath: () => cmds.push(5),
  });
  return cmds;
}
/** `dst` set to CanvasKit's commands */
export function setSkCommands(dst: NativePath, cmds: PathCommands): void {
  dst.reset();
  for (let i = 0; i < cmds.length;) {
    const verb = cmds[i++];
    if (verb === 0) dst.moveTo(cmds[i++], cmds[i++]);
    else if (verb === 1) dst.lineTo(cmds[i++], cmds[i++]);
    else if (verb === 2) { dst.quadTo(cmds[i], cmds[i + 1], cmds[i + 2], cmds[i + 3]); i += 4; }
    else if (verb === 3) { dst.conicTo(cmds[i], cmds[i + 1], cmds[i + 2], cmds[i + 3], cmds[i + 4]); i += 5; }
    else if (verb === 4) { dst.cubicTo(cmds[i], cmds[i + 1], cmds[i + 2], cmds[i + 3], cmds[i + 4], cmds[i + 5]); i += 6; }
    else dst.close();
  }
}
/** SkPathOp, which Path$Op's ordinals follow */
const DIFFERENCE = 0;
/** Path.op: Skia's result and its fill type into `dst`; false where Skia finds none */
export function pathOp(dst: NativePath, a: NativePath, b: NativePath, op: number): boolean | Promise<boolean> {
  return after(skiaPathOp(skCommands(a), a.fillType(), skCommands(b), b.fillType(), op), (r) => {
    if (!r) return false;
    setSkCommands(dst, r.cmds);
    dst.setFillType(r.fill);
    return true;
  });
}

/** a path's inverse fill within [l, t, r, b], as Canvas2D can fill it */
export function inversePath(path: NativePath, l: number, t: number, r: number, b: number): [Path2D, CanvasFillRule] {
  if (path.fillRule === "evenodd") {
    const inverse = new Path2D();
    inverse.rect(l, t, r - l, b - t);
    inverse.addPath(path.path());
    return [inverse, "evenodd"];
  }
  // the bounds less the path under its plain fill; the page's CanvasKit is loaded before anything draws
  const outer = new NativePath(), plain = new NativePath(), result = new NativePath();
  outer.addRect(l, t, r, b, CW);
  plain.set(path);
  plain.setFillType(path.fillType() & 1);
  if (pathOp(result, outer, plain, DIFFERENCE) instanceof Promise) throw new Error("CanvasKit is not loaded");
  return [result.path(), result.fillRule];
}

type Pt = [number, number];
// Skia tests the control polygon, including implicit closure, rather than sampling curves.
export function pathIsConvex(path: NativePath): boolean {
  const points: Pt[] = [];
  let start: Pt = [0, 0], ended = false;
  for (const verb of pathVerbs(path.ops)) {
    if (verb.slice(1).some(value => !Number.isFinite(Math.fround(value)))) return false;
    if (verb[0] === MOVE) {
      if (points.length) ended = true;
      start = [Math.fround(verb[1]), Math.fround(verb[2])];
      continue;
    }
    if (ended) return false;
    if (!points.length) points.push(start);
    if (verb[0] === CLOSE) { ended = true; continue; }
    for (let i = 3; i < verb.length; i += 2) {
      const x = Math.fround(verb[i]), y = Math.fround(verb[i + 1]), last = points[points.length - 1];
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
  const verbs = pathVerbs(p.ops);
  let mx = 0, my = 0;
  for (let i = 0; i < verbs.length; i++) {
    const v = verbs[i];
    switch (v[0]) {
      // SkPath::Iter reports no trailing moveTo
      case MOVE: if (i < verbs.length - 1) { move(mx = v[1], my = v[2]); } break;
      case LINE: line(v[3], v[4]); break;
      case QUAD: case CUBIC: {
        const at = v[0] === QUAD ? quadAt : cubicAt;
        const sub = (t0: number, x0: number, y0: number, t1: number, x1: number, y1: number) => {
          const tm = (t0 + t1) / 2, xm = at(v, tm, 0), ym = at(v, tm, 1);
          const dx = (x0 + x1) / 2 - xm, dy = (y0 + y1) / 2 - ym;
          if (dx * dx + dy * dy > err2) { sub(t0, x0, y0, tm, xm, ym); sub(tm, xm, ym, t1, x1, y1); }
          else line(x1, y1);
        };
        sub(0, v[1], v[2], 1, v[v.length - 2], v[v.length - 1]);
        break;
      }
      case CLOSE: line(mx, my); break;
    }
  }
  if (!xs.length) move(verbs.length === 1 ? verbs[0][1] : 0, verbs.length === 1 ? verbs[0][2] : 0);
  let total = lens.at(-1)!;
  // a lone point still animates, holding its value
  if (total === 0) { xs.push(xs.at(-1)!); ys.push(ys.at(-1)!); lens.push(total = 1); }
  const out = new Float32Array(xs.length * 3);
  for (let i = 0; i < xs.length; i++) { out[i * 3] = lens[i] / total; out[i * 3 + 1] = xs[i]; out[i * 3 + 2] = ys[i]; }
  return out;
}
/** coordinate `c` (0 = x, 1 = y) of a quadratic or cubic verb at t */
function quadAt(v: Verb, t: number, c: number) {
  const u = 1 - t;
  return u * (u * v[1 + c] + t * v[3 + c]) + t * (u * v[3 + c] + t * v[5 + c]);
}
function cubicAt(v: Verb, t: number, c: number) {
  const u = 1 - t;
  return u * u * u * v[1 + c] + 3 * u * u * t * v[3 + c] + 3 * u * t * t * v[5 + c] + t * t * t * v[7 + c];
}

// ── PathMeasure: SkContourMeasure over a snapshot of the path's verbs
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
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class PathMeasure {
  private verbs: Verb[] = [];
  private i = 0;
  private forceClosed = false;
  private contour: Contour | null = null;
  /** position and unit tangent from the last posTan */
  private readonly pt = new Float64Array(4);
  /** the t distanceToSegment found */
  private t = 0;
  private readonly chop = new Float64Array(14);
  private readonly chop2 = new Float64Array(14);

  /** SkPathMeasure::setPath: the path is copied, and the first contour with length measured */
  setPath(p: NativePath | undefined, forceClosed: boolean) {
    this.verbs = p ? pathVerbs(p.ops) : [];
    this.i = 0;
    this.forceClosed = forceClosed;
    this.nextContour();
  }
  /** SkContourMeasureIter::next skips contours of zero length */
  nextContour(): boolean {
    this.contour = null;
    while (!this.contour && this.i < this.verbs.length) this.contour = this.build();
    return !!this.contour;
  }
  length(): number { return this.contour?.length ?? 0; }
  isClosed(): boolean { return !!this.contour?.closed; }
  private build(): Contour | null {
    const c = new Contour(), vs = this.verbs;
    let pi = -1, d = 0, seenClose = this.forceClosed, seenMove = false;
    for (; this.i < vs.length; this.i++) {
      const v = vs[this.i];
      if (seenMove && v[0] === MOVE) break;
      const prev = d;
      switch (v[0]) {
        case MOVE: pi++; c.pts.push(v[1], v[2]); seenMove = true; break;
        case LINE:
          d = lineSeg(c, v[1], v[2], v[3], v[4], d, pi);
          if (d > prev) { c.pts.push(v[3], v[4]); pi++; }
          break;
        case QUAD:
          d = quadSegs(c, v[1], v[2], v[3], v[4], v[5], v[6], d, 0, MAX_T, pi);
          if (d > prev) { c.pts.push(v[3], v[4], v[5], v[6]); pi += 2; }
          break;
        case CUBIC:
          d = cubicSegs(c, v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8], d, 0, MAX_T, pi);
          if (d > prev) { c.pts.push(v[3], v[4], v[5], v[6], v[7], v[8]); pi += 3; }
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
          chopQuad(a, stopT, b);
          return dst.quadTo(b[2], b[3], b[4], b[5]);
        }
        chopQuad(a, startT, b);
        if (stopT === 1) return dst.quadTo(b[6], b[7], b[8], b[9]);
        chopQuad(b.subarray(4), (stopT - startT) / (1 - startT), a);
        return dst.quadTo(a[2], a[3], a[4], a[5]);
      case CUBIC_SEG:
        for (let k = 0; k < 8; k++) a[k] = p[i + k];
        if (startT === 0) {
          if (stopT === 1) return dst.cubicTo(a[2], a[3], a[4], a[5], a[6], a[7]);
          chopCubic(a, stopT, b);
          return dst.cubicTo(b[2], b[3], b[4], b[5], b[6], b[7]);
        }
        chopCubic(a, startT, b);
        if (stopT === 1) return dst.cubicTo(b[8], b[9], b[10], b[11], b[12], b[13]);
        chopCubic(b.subarray(6), (stopT - startT) / (1 - startT), a);
        return dst.cubicTo(a[2], a[3], a[4], a[5], a[6], a[7]);
    }
  }
}
/** SkChopQuadAt: src's three points split at t into five (the middle one shared) */
function chopQuad(src: Float64Array, t: number, dst: Float64Array) {
  const [x0, y0, x1, y1, x2, y2] = src;
  const ax = lerp(x0, x1, t), ay = lerp(y0, y1, t), bx = lerp(x1, x2, t), by = lerp(y1, y2, t);
  dst.set([x0, y0, ax, ay, lerp(ax, bx, t), lerp(ay, by, t), bx, by, x2, y2]);
}
/** SkChopCubicAt: src's four points split at t into seven */
function chopCubic(src: Float64Array, t: number, dst: Float64Array) {
  const [x0, y0, x1, y1, x2, y2, x3, y3] = src;
  const abx = lerp(x0, x1, t), aby = lerp(y0, y1, t), bcx = lerp(x1, x2, t), bcy = lerp(y1, y2, t), cdx = lerp(x2, x3, t), cdy = lerp(y2, y3, t);
  const abcx = lerp(abx, bcx, t), abcy = lerp(aby, bcy, t), bcdx = lerp(bcx, cdx, t), bcdy = lerp(bcy, cdy, t);
  dst.set([x0, y0, abx, aby, abcx, abcy, lerp(abcx, bcdx, t), lerp(abcy, bcdy, t), bcdx, bcdy, cdx, cdy, x3, y3]);
}

/** SkPath::RawIter over a snapshot of the verbs, as PathIterator and androidx's pre-34 iterator walk them */
export class VerbIterator {
  private i = 0;
  readonly verbs: Verb[];
  constructor(p: NativePath) { this.verbs = pathVerbs(p.ops); }
  peek(): number { return this.verbs[this.i]?.[0] ?? DONE; }
  next(pts: Float32Array, off: number): number {
    const v = this.verbs[this.i];
    if (!v) return DONE;
    this.i++;
    for (let k = 1; k < v.length; k++) pts[off + k - 1] = v[k];
    return v[0];
  }
}

// ── androidx.graphics.path (Compose/Material3 below API 34): its JNI walks Skia's verb and
// point arrays, as PathIterator does. Arcs come out as cubics rather than conics, so the
// conic-evaluation mode and tolerance have nothing to convert and Conic never appears.
const iter = (h: bigint) => deref<VerbIterator>(h);
rt.registerJnis("androidx/graphics/path/PathIteratorPreApi34Impl", {
  "createInternalPathIterator(Landroid/graphics/Path;IF)J": (p: object) => handle(new VerbIterator(nativePathOf(p))),
  "destroyInternalPathIterator(J)V": release,
  "internalPathIteratorHasNext(J)Z": (h: bigint) => (iter(h).peek() !== DONE ? 1 : 0),
  "internalPathIteratorPeek(J)I": (h: bigint) => iter(h).peek(),
  "internalPathIteratorNext(J[FI)I": (h: bigint, pts: Float32Array, off: number) => iter(h).next(pts, off),
  "internalPathIteratorSize(J)I": (h: bigint) => iter(h).verbs.length,
  "internalPathIteratorRawSize(J)I": (h: bigint) => iter(h).verbs.length,
});
rt.claimNativeLib("androidx.graphics.path");
