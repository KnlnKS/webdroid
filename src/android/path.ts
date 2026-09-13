// android.graphics.Path: a Path2D op list rebuilt on demand, plus Path.op set operations.
// graphics.ts imports JPath for Canvas and this file imports JMatrix/JRectF back; the cycle
// is benign because nothing here touches those bindings before its own module body has run.

import { rt, JObj } from "../jvm/runtime";
import { mkEnumSet } from "../jvm/natives/jlang";
import { JMatrix, JRectF } from "./graphics";

const pathFillTypes = mkEnumSet("android/graphics/Path$FillType", ["WINDING", "EVEN_ODD", "INVERSE_WINDING", "INVERSE_EVEN_ODD"]);
mkEnumSet("android/graphics/Path$Op", ["DIFFERENCE", "INTERSECT", "REVERSE_DIFFERENCE", "UNION", "XOR"]);
type PathOp = ["m" | "l" | "q" | "c" | "z" | "arc" | "rect" | "rrect" | "oval" | "circle", ...number[]];
export class JPath extends JObj {
  ops: PathOp[] = [];
  curX = 0; curY = 0; startX = 0; startY = 0;
  fillRule: CanvasFillRule = "nonzero";
  p2d: Path2D | null = null;
  dirty = true;
  path(): Path2D {
    if (this.dirty || !this.p2d) {
      const p = new Path2D();
      for (const op of this.ops) applyPathOp(p, op);
      this.p2d = p;
      this.dirty = false;
    }
    return this.p2d;
  }
  add(op: PathOp) { this.ops.push(op); this.dirty = true; }
  conicTo(x1: number, y1: number, x2: number, y2: number, w: number, relative = false) {
    const last = this.ops.at(-1);
    let x = 0, y = 0;
    if (last?.[0] === "m" || last?.[0] === "l") { x = last[1]; y = last[2]; }
    else if (last?.[0] === "q") { x = last[3]; y = last[4]; }
    else if (last?.[0] === "c") { x = last[5]; y = last[6]; }
    else if (last) {
      let sx = 0, sy = 0;
      for (const v of pathVerbs(this.ops)) {
        if (v[0] === MOVE) { sx = v[1]; sy = v[2]; }
        if (v[0] === CLOSE) { x = sx; y = sy; }
        else { x = v[v.length - 2]; y = v[v.length - 1]; }
      }
    }
    if (relative) { x1 += x; y1 += y; x2 += x; y2 += y; }
    if (!last || last[0] === "z") this.add(["m", x, y]);
    if (w <= 0) this.add(["l", x2, y2]);
    else if (w === 1) this.add(["q", x1, y1, x2, y2]);
    else if (!Number.isFinite(w)) { this.add(["l", x1, y1]); this.add(["l", x2, y2]); }
    else {
      // Subdivide rational quadratics with Skia's error estimate and bounded depth; path consumers
      // can then share the existing quadratic representation.
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
      chop(x, y, x1, y1, x2, y2, w, 0);
    }
    this.curX = x2; this.curY = y2;
  }
}
/**
 * The eight radii of an "rrect" op (tl.x,tl.y,tr.x,tr.y,br.x,br.y,bl.x,bl.y), shrunk by the one
 * factor that keeps every edge's pair of corners within its length — the rule Path2D.roundRect
 * and Skia both apply, so the flattener and the Path2D build agree on the shape.
 */
function rrRadii(op: PathOp): number[] {
  const w = (op[3] as number) - (op[1] as number), h = (op[4] as number) - (op[2] as number);
  const q = (op as number[]).slice(5, 13).map((v) => Math.max(0, v || 0));
  let f = 1;
  const fit = (sum: number, ext: number) => { if (sum > ext && sum > 0) f = Math.min(f, ext / sum); };
  fit(q[0] + q[2], w); fit(q[6] + q[4], w); fit(q[1] + q[7], h); fit(q[3] + q[5], h);
  return f < 1 ? q.map((v) => v * f) : q;
}
function applyPathOp(p: Path2D, op: PathOp) {
  switch (op[0]) {
    case "m": p.moveTo(op[1], op[2]); break;
    case "l": p.lineTo(op[1], op[2]); break;
    case "q": p.quadraticCurveTo(op[1], op[2], op[3], op[4]); break;
    case "c": p.bezierCurveTo(op[1], op[2], op[3], op[4], op[5], op[6]); break;
    case "z": p.closePath(); break;
    // Direction is not decoration: a shape added CW inside a rect added CCW is how Material's
    // ShapeableImageView builds "everything outside the shape" for its non-zero-winding mask.
    case "rect":
      if (op[5]) { p.moveTo(op[1], op[2]); p.lineTo(op[1], op[4]); p.lineTo(op[3], op[4]); p.lineTo(op[3], op[2]); p.closePath(); }
      else p.rect(op[1], op[2], op[3] - op[1], op[4] - op[2]);
      break;
    case "rrect": {
      const [, l, t, r, b] = op;
      const q = rrRadii(op);
      p.roundRect(l, t, r - l, b - t, [{ x: q[0], y: q[1] }, { x: q[2], y: q[3] }, { x: q[4], y: q[5] }, { x: q[6], y: q[7] }]);
      break;
    }
    case "oval": p.ellipse((op[1] + op[3]) / 2, (op[2] + op[4]) / 2, (op[3] - op[1]) / 2, (op[4] - op[2]) / 2, 0, 0, Math.PI * 2, !!op[5]); break;
    case "circle": p.arc(op[1], op[2], op[3], 0, Math.PI * 2, !!op[4]); break;
    case "arc": {
      const [, l, t, r, b, startDeg, sweepDeg] = op;
      const cx = (l + r) / 2, cy = (t + b) / 2, rx = (r - l) / 2, ry = (b - t) / 2;
      p.ellipse(cx, cy, rx, ry, 0, startDeg * Math.PI / 180, (startDeg + sweepDeg) * Math.PI / 180, sweepDeg < 0);
      break;
    }
  }
}

// ── Path.op (set operations on paths)
// Path2D has no set operations and cannot be read back, so the operands are flattened to
// polygons here and recombined by classifying each boundary segment against the other operand:
// a segment survives exactly when it separates kept region from dropped region. The result is
// polygonal because the boundary of a boolean is in general NOT expressible in the operands'
// own primitives (a rounded rect minus an inset rounded rect has no rrect form).
type Pt = [number, number];
/** Leading (x,y) pairs each op carries; everything after them is a scalar (radius, angle). */
const opPairs: Record<string, number> = { m: 1, l: 1, q: 2, c: 3, z: 0, rect: 2, rrect: 2, oval: 2, circle: 1, arc: 2 };
/** Trailing scalars that are lengths and so scale with the path (radii, not angles). */
const opRadii: Record<string, [number, number]> = { rrect: [5, 13], circle: [3, 4] };

type Contour = Pt[] & { closed?: boolean };
/** Polylines for every contour; `all` keeps degenerate/open ones and marks which were closed
 *  (Path.op wants only real polygons, PathMeasure wants every stroke). */
function flattenPath(ops: PathOp[], all = false): Contour[] {
  const out: Contour[] = [];
  let cur: Contour | null = null, cx = 0, cy = 0, sx = 0, sy = 0;
  const move = (x: number, y: number) => { cur = [[x, y]]; out.push(cur); cx = sx = x; cy = sy = y; };
  const close = () => { if (cur) cur.closed = true; cur = null; };
  const line = (x: number, y: number) => { if (cur) cur.push([x, y]); else move(x, y); cx = x; cy = y; };
  // Steps grow with the square root of the arc length, which keeps the chord's sagitta under
  // about a quarter pixel for anything screen-sized without exploding the segment count.
  const steps = (span: number) => Math.max(2, Math.min(128, Math.ceil(Math.sqrt(Math.max(1, span)) * 2)));
  const arc = (ax: number, ay: number, rx: number, ry: number, a0: number, a1: number) => {
    const n = steps(Math.abs(a1 - a0) * Math.max(rx, ry));
    for (let i = 1; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; line(ax + rx * Math.cos(a), ay + ry * Math.sin(a)); }
  };
  const P = Math.PI;
  for (const op of ops) {
    const [k, a, b, c, d, e, f] = op as [string, ...number[]];
    switch (k) {
      case "m": move(a, b); break;
      case "l": line(a, b); break;
      case "q": {
        const x0 = cx, y0 = cy, n = steps(Math.hypot(a - x0, b - y0) + Math.hypot(c - a, d - b));
        for (let i = 1; i <= n; i++) { const t = i / n, u = 1 - t; line(u * u * x0 + 2 * u * t * a + t * t * c, u * u * y0 + 2 * u * t * b + t * t * d); }
        break;
      }
      case "c": {
        const x0 = cx, y0 = cy, n = steps(Math.hypot(a - x0, b - y0) + Math.hypot(c - a, d - b) + Math.hypot(e - c, f - d));
        for (let i = 1; i <= n; i++) {
          const t = i / n, u = 1 - t;
          line(u * u * u * x0 + 3 * u * u * t * a + 3 * u * t * t * c + t * t * t * e,
            u * u * u * y0 + 3 * u * u * t * b + 3 * u * t * t * d + t * t * t * f);
        }
        break;
      }
      case "z": close(); cx = sx; cy = sy; break;
      case "rect": { const r: Contour = [[a, b], [c, b], [c, d], [a, d]]; r.closed = true; out.push(r); cur = null; cx = sx = a; cy = sy = b; break; }
      case "rrect": {
        const q = rrRadii(op);
        move(a + q[0], b);
        line(c - q[2], b); arc(c - q[2], b + q[3], q[2], q[3], -P / 2, 0);
        line(c, d - q[5]); arc(c - q[4], d - q[5], q[4], q[5], 0, P / 2);
        line(a + q[6], d); arc(a + q[6], d - q[7], q[6], q[7], P / 2, P);
        line(a, b + q[1]); arc(a + q[0], b + q[1], q[0], q[1], P, P * 1.5);
        close();
        break;
      }
      case "oval": move(c, (b + d) / 2); arc((a + c) / 2, (b + d) / 2, (c - a) / 2, (d - b) / 2, 0, P * 2); close(); break;
      case "circle": move(a + c, b); arc(a, b, c, c, 0, P * 2); close(); break;
      case "arc": {
        const mx = (a + c) / 2, my = (b + d) / 2, rx = (c - a) / 2, ry = (d - b) / 2, a0 = e * P / 180;
        if (!cur || op[7]) move(mx + rx * Math.cos(a0), my + ry * Math.sin(a0)); else line(mx + rx * Math.cos(a0), my + ry * Math.sin(a0));
        arc(mx, my, rx, ry, a0, a0 + f * P / 180);
        break;
      }
    }
  }
  return all ? out : out.filter((c) => c.length > 2);
}

// ── PathMeasure: arc-length queries over the flattened contours, one contour at a time
class JPathMeasure extends JObj {
  contours: Contour[] = [];
  idx = 0;
  forceClosed = false;
  segs: number[] = []; // cumulative length at each vertex of the current contour
  pts: Pt[] = [];
  load(p: JPath | null, forceClosed: boolean) {
    this.forceClosed = forceClosed;
    this.contours = p ? flattenPath(p.ops, true).filter((c) => c.length > 1) : [];
    this.idx = 0;
    this.prep();
  }
  prep() {
    const c = this.contours[this.idx];
    this.pts = c ? (this.closed(c) && (c[0][0] !== c[c.length - 1][0] || c[0][1] !== c[c.length - 1][1]) ? [...c, c[0]] : [...c]) : [];
    this.segs = [0];
    for (let i = 1; i < this.pts.length; i++) this.segs.push(this.segs[i - 1] + Math.hypot(this.pts[i][0] - this.pts[i - 1][0], this.pts[i][1] - this.pts[i - 1][1]));
  }
  closed(c: Contour) { return this.forceClosed || !!c.closed; }
  length() { return this.segs[this.segs.length - 1] ?? 0; }
  /** position + unit tangent at distance d along the current contour */
  at(d: number): [number, number, number, number] | null {
    const n = this.pts.length;
    if (n < 2) return null;
    d = Math.max(0, Math.min(this.length(), d));
    let i = 1;
    while (i < n - 1 && this.segs[i] < d) i++;
    const [x0, y0] = this.pts[i - 1], [x1, y1] = this.pts[i];
    const L = this.segs[i] - this.segs[i - 1];
    const t = L > 0 ? (d - this.segs[i - 1]) / L : 0;
    const tx = L > 0 ? (x1 - x0) / L : 1, ty = L > 0 ? (y1 - y0) / L : 0;
    return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, tx, ty];
  }
}
rt.register({
  name: "android/graphics/PathMeasure", ctor: JPathMeasure,
  statics: { POSITION_MATRIX_FLAG: 1, TANGENT_MATRIX_FLAG: 2 },
  methods: {
    "<init>()V": function () {},
    "<init>(Landroid/graphics/Path;Z)V": function (this: JPathMeasure, p: JPath | null, fc: number) { this.load(p, !!fc); },
    "setPath(Landroid/graphics/Path;Z)V": function (this: JPathMeasure, p: JPath | null, fc: number) { this.load(p, !!fc); },
    "getLength()F": function (this: JPathMeasure) { return Math.fround(this.length()); },
    "isClosed()Z": function (this: JPathMeasure) { const c = this.contours[this.idx]; return c && this.closed(c) ? 1 : 0; },
    "nextContour()Z": function (this: JPathMeasure) {
      if (this.idx + 1 >= this.contours.length) return 0;
      this.idx++; this.prep(); return 1;
    },
    "getPosTan(F[F[F)Z": function (this: JPathMeasure, d: number, pos: Float32Array | null, tan: Float32Array | null) {
      const r = this.at(d);
      if (!r) return 0;
      if (pos) { pos[0] = r[0]; pos[1] = r[1]; }
      if (tan) { tan[0] = r[2]; tan[1] = r[3]; }
      return 1;
    },
    "getMatrix(FLandroid/graphics/Matrix;I)Z": function (this: JPathMeasure, d: number, m: JMatrix, flags: number) {
      const r = this.at(d);
      if (!r) return 0;
      const rot = flags & 2 ? Math.atan2(r[3], r[2]) : 0, c = Math.cos(rot), s = Math.sin(rot);
      const tx = flags & 1 ? r[0] : 0, ty = flags & 1 ? r[1] : 0;
      m.m = [c, s, -s, c, tx, ty]; // canvas affine [a, b, c, d, tx, ty]: rotation then translate
      return 1;
    },
    "getSegment(FFLandroid/graphics/Path;Z)Z": function (this: JPathMeasure, start: number, stop: number, dst: JPath, moveTo: number) {
      const len = this.length();
      if (this.pts.length < 2) return 0;
      start = Math.max(0, start); stop = Math.min(len, stop);
      if (start >= stop) return 0;
      const a = this.at(start)!, b = this.at(stop)!;
      if (moveTo || !dst.ops.length) dst.add(["m", a[0], a[1]]); else dst.add(["l", a[0], a[1]]);
      dst.curX = a[0]; dst.curY = a[1];
      for (let i = 1; i < this.pts.length - 1; i++) {
        if (this.segs[i] > start && this.segs[i] < stop) dst.add(["l", this.pts[i][0], this.pts[i][1]]);
      }
      dst.add(["l", b[0], b[1]]);
      dst.curX = b[0]; dst.curY = b[1];
      return 1;
    },
  },
});

function contourWinding(c: Pt[], x: number, y: number): number {
  let w = 0;
  for (let i = 0, n = c.length; i < n; i++) {
    const [x0, y0] = c[i], [x1, y1] = c[(i + 1) % n];
    const side = (x1 - x0) * (y - y0) - (x - x0) * (y1 - y0);
    if (y0 <= y) { if (y1 > y && side > 0) w++; }
    else if (y1 <= y && side < 0) w--;
  }
  return w;
}
const inside = (cs: Pt[][], p: Pt) => {
  let w = 0;
  for (const c of cs) w += contourWinding(c, p[0], p[1]);
  return w !== 0;
};
const signedArea = (c: Pt[]) => {
  let s = 0;
  for (let i = 0, n = c.length; i < n; i++) { const [x0, y0] = c[i], [x1, y1] = c[(i + 1) % n]; s += x0 * y1 - x1 * y0; }
  return s;
};

/**
 * Even-odd paths say "inside" with crossing parity and carry no orientation, but the classifier
 * and the polygonal result both read insideness as a winding number. Re-orient by nesting depth
 * so the two agree; winding paths already mean their orientation and are left alone.
 */
function orientEvenOdd(cs: Pt[][]): Pt[][] {
  return cs.map((c) => {
    let depth = 0;
    for (const o of cs) if (o !== c && contourWinding(o, c[0][0], c[0][1]) !== 0) depth++;
    const want = depth % 2 === 0 ? 1 : -1;
    return Math.sign(signedArea(c)) === -want ? c.slice().reverse() : c;
  });
}

type Seg = { a: Pt; b: Pt; from: 0 | 1 };
/**
 * Split every segment of `segs` where `other` crosses it OR overlaps it end-on. The overlap split
 * is what makes shared edges tractable: it leaves the coincident stretch as one segment on each
 * side with the same endpoints, which the classifier can then recognise as a shared boundary
 * instead of asking "is my midpoint inside the other path?" about a point sitting exactly on it.
 */
function splitSegs(segs: Seg[], other: Seg[]): Seg[] {
  const out: Seg[] = [];
  for (const s of segs) {
    const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], len2 = dx * dx + dy * dy;
    if (!len2) continue;
    const ts: number[] = [];
    for (const o of other) {
      const ex = o.b[0] - o.a[0], ey = o.b[1] - o.a[1];
      const den = dx * ey - dy * ex;
      const px = o.a[0] - s.a[0], py = o.a[1] - s.a[1];
      if (Math.abs(den) < 1e-9 * Math.sqrt(len2 * (ex * ex + ey * ey))) {
        if (Math.abs(px * dy - py * dx) > 1e-6 * Math.sqrt(len2)) continue;
        ts.push((px * dx + py * dy) / len2, ((o.b[0] - s.a[0]) * dx + (o.b[1] - s.a[1]) * dy) / len2);
        continue;
      }
      const t = (px * ey - py * ex) / den, u = (px * dy - py * dx) / den;
      if (u > -1e-9 && u < 1 + 1e-9) ts.push(t);
    }
    let prev = 0;
    const at = (t: number): Pt => (t === 0 ? s.a : t === 1 ? s.b : [s.a[0] + dx * t, s.a[1] + dy * t]);
    for (const t of [...ts.filter((t) => t > 1e-9 && t < 1 - 1e-9).sort((p, q) => p - q), 1]) {
      if (t - prev < 1e-9) continue;
      out.push({ a: at(prev), b: at(t), from: s.from });
      prev = t;
    }
  }
  return out;
}

const segKey = (p: Pt) => `${Math.round(p[0] * 64)}|${Math.round(p[1] * 64)}`;

/** Walk kept segments head-to-tail back into closed contours. */
function chainSegs(segs: Seg[]): Pt[][] {
  const key = segKey;
  const byStart = new Map<string, Seg[]>();
  for (const s of segs) {
    const k = key(s.a), l = byStart.get(k);
    if (l) l.push(s); else byStart.set(k, [s]);
  }
  const used = new Set<Seg>(), out: Pt[][] = [];
  for (const s0 of segs) {
    if (used.has(s0)) continue;
    const c: Pt[] = [s0.a];
    let s: Seg | undefined = s0;
    while (s && !used.has(s)) {
      used.add(s);
      c.push(s.b);
      s = byStart.get(key(s.b))?.find((n) => !used.has(n));
    }
    if (c.length > 3) out.push(c);
  }
  return out;
}

const PathOpMode = { DIFFERENCE: 0, INTERSECT: 1, REVERSE_DIFFERENCE: 2, UNION: 3, XOR: 4 };
function pathOp(dst: JPath, pa: JPath, pb: JPath, mode: number): number {
  if (mode === PathOpMode.REVERSE_DIFFERENCE) { [pa, pb] = [pb, pa]; mode = PathOpMode.DIFFERENCE; }
  const flat = (p: JPath) => {
    const cs = flattenPath(p.ops);
    return p.fillRule === "evenodd" ? orientEvenOdd(cs) : cs;
  };
  const A = flat(pa), B = flat(pb);
  const toSegs = (cs: Pt[][], from: 0 | 1): Seg[] => {
    const out: Seg[] = [];
    for (const c of cs) for (let i = 0; i < c.length; i++) out.push({ a: c[i], b: c[(i + 1) % c.length], from });
    return out;
  };
  const sa = toSegs(A, 0), sb = toSegs(B, 1);
  const all = [...splitSegs(sa, sb), ...splitSegs(sb, sa)];
  // Segments the two operands share, keyed without direction so the two copies collide.
  const shared = new Map<string, Seg[]>();
  for (const s of all) {
    const k = segKey(s.a) < segKey(s.b) ? segKey(s.a) + "/" + segKey(s.b) : segKey(s.b) + "/" + segKey(s.a);
    const l = shared.get(k);
    if (l) l.push(s); else shared.set(k, [s]);
    (s as Seg & { key: string }).key = k;
  }
  const kept: Seg[] = [];
  for (const s of all) {
    const twins = shared.get((s as Seg & { key: string }).key)!;
    const twin = twins.find((o) => o.from !== s.from);
    if (twin) {
      // Both operands run along here, so neither's interior can be sampled beside it. The two
      // interiors are on the same side when the edges run the same way; the result then has a
      // boundary here only for union and intersect, and the opposite case only for difference.
      if (s.from === 1) continue;
      const same = (s.b[0] - s.a[0]) * (twin.b[0] - twin.a[0]) + (s.b[1] - s.a[1]) * (twin.b[1] - twin.a[1]) > 0;
      if (mode === PathOpMode.UNION || mode === PathOpMode.INTERSECT ? same : mode === PathOpMode.DIFFERENCE && !same) kept.push(s);
      continue;
    }
    const mid: Pt = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2];
    const inOther = inside(s.from ? A : B, mid);
    // A segment bounds the result iff the region on its far side is classified differently from
    // the region on its near side; which side is which flips when the other operand covers it.
    if (mode === PathOpMode.UNION ? !inOther
      : mode === PathOpMode.INTERSECT ? inOther
        : mode === PathOpMode.XOR ? true
          : s.from === 0 ? !inOther : inOther) {
      const flip = mode === PathOpMode.XOR ? inOther : mode === PathOpMode.DIFFERENCE && s.from === 1;
      kept.push(flip ? { a: s.b, b: s.a, from: s.from } : s);
    }
  }
  dst.ops = chainSegs(kept).flatMap((c) => [["m", c[0][0], c[0][1]] as PathOp, ...c.slice(1).map((p) => ["l", p[0], p[1]] as PathOp), ["z"] as PathOp]);
  dst.fillRule = "nonzero";
  dst.curX = dst.startX = dst.ops.length ? (dst.ops[0][1] as number) : 0;
  dst.curY = dst.startY = dst.ops.length ? (dst.ops[0][2] as number) : 0;
  dst.dirty = true;
  return 1;
}

function copyPath(this: JPath, source: JPath) {
  if (this === source) return;
  this.ops = source.ops.map(op => op.slice() as PathOp);
  this.curX = source.curX; this.curY = source.curY;
  this.startX = source.startX; this.startY = source.startY;
  this.fillRule = source.fillRule;
  this.dirty = true;
}
rt.register({
  name: "android/graphics/Path", ctor: JPath,
  methods: {
    "<init>()V": function () {},
    "<init>(Landroid/graphics/Path;)V": function (this: JPath, o: JPath) { if (o) copyPath.call(this, o); },
    "set(Landroid/graphics/Path;)V": copyPath,
    "reset()V": function (this: JPath) { this.ops.length = 0; this.dirty = true; },
    "rewind()V": function (this: JPath) { this.ops.length = 0; this.dirty = true; },
    "moveTo(FF)V": function (this: JPath, x: number, y: number) { this.add(["m", x, y]); this.curX = this.startX = x; this.curY = this.startY = y; },
    "rMoveTo(FF)V": function (this: JPath, x: number, y: number) { this.add(["m", this.curX + x, this.curY + y]); this.curX = this.startX = this.curX + x; this.curY = this.startY = this.curY + y; },
    "lineTo(FF)V": function (this: JPath, x: number, y: number) { this.add(["l", x, y]); this.curX = x; this.curY = y; },
    "rLineTo(FF)V": function (this: JPath, x: number, y: number) { this.add(["l", this.curX + x, this.curY + y]); this.curX += x; this.curY += y; },
    "quadTo(FFFF)V": function (this: JPath, a: number, b: number, c: number, d: number) { this.add(["q", a, b, c, d]); this.curX = c; this.curY = d; },
    "conicTo(FFFFF)V": function (this: JPath, a: number, b: number, c: number, d: number, w: number) { this.conicTo(a, b, c, d, w); },
    "rConicTo(FFFFF)V": function (this: JPath, a: number, b: number, c: number, d: number, w: number) { this.conicTo(a, b, c, d, w, true); },
    "rQuadTo(FFFF)V": function (this: JPath, a: number, b: number, c: number, d: number) {
      this.add(["q", this.curX + a, this.curY + b, this.curX + c, this.curY + d]);
      this.curX += c; this.curY += d;
    },
    "cubicTo(FFFFFF)V": function (this: JPath, a: number, b: number, c: number, d: number, e: number, f: number) {
      this.add(["c", a, b, c, d, e, f]); this.curX = e; this.curY = f;
    },
    "rCubicTo(FFFFFF)V": function (this: JPath, a: number, b: number, c: number, d: number, e: number, f: number) {
      const { curX: x, curY: y } = this;
      this.add(["c", x + a, y + b, x + c, y + d, x + e, y + f]);
      this.curX = x + e; this.curY = y + f;
    },
    "close()V": function (this: JPath) { this.add(["z"]); this.curX = this.startX; this.curY = this.startY; },
    "op(Landroid/graphics/Path;Landroid/graphics/Path$Op;)Z": function (this: JPath, o: JPath, mode: { ord: number } | null) {
      return pathOp(this, this, o, mode?.ord ?? 0);
    },
    "op(Landroid/graphics/Path;Landroid/graphics/Path;Landroid/graphics/Path$Op;)Z": function (this: JPath, a: JPath, b: JPath, mode: { ord: number } | null) {
      return pathOp(this, a, b, mode?.ord ?? 0);
    },
    "getFillType()Landroid/graphics/Path$FillType;": function (this: JPath) {
      return pathFillTypes[this.fillRule === "evenodd" ? 1 : 0];
    },

    "addRect(FFFFLandroid/graphics/Path$Direction;)V": function (this: JPath, l: number, t: number, r: number, b: number, d: { ord: number } | null) {
      this.add(["rect", l, t, r, b, d?.ord ?? 0]);
    },
    "addRect(Landroid/graphics/RectF;Landroid/graphics/Path$Direction;)V": function (this: JPath, r: JRectF, d: { ord: number } | null) {
      this.add(["rect", r.left, r.top, r.right, r.bottom, d?.ord ?? 0]);
    },
    "addRoundRect(Landroid/graphics/RectF;FFLandroid/graphics/Path$Direction;)V": function (this: JPath, r: JRectF, rx: number, ry: number) {
      this.add(["rrect", r.left, r.top, r.right, r.bottom, rx, ry, rx, ry, rx, ry, rx, ry]);
    },
    "addRoundRect(FFFFFFLandroid/graphics/Path$Direction;)V": function (this: JPath, l: number, t: number, r: number, b: number, rx: number, ry: number) {
      this.add(["rrect", l, t, r, b, rx, ry, rx, ry, rx, ry, rx, ry]);
    },
    // float[8] = one (x,y) radius per corner, clockwise from top-left. Collapsing it to a single
    // radius turns every asymmetric shape (a segmented button's end cap, a bottom sheet) into a
    // uniform one.
    "addRoundRect(Landroid/graphics/RectF;[FLandroid/graphics/Path$Direction;)V": function (this: JPath, r: JRectF, radii: Float32Array) {
      this.add(["rrect", r.left, r.top, r.right, r.bottom, ...Array.from({ length: 8 }, (_, i) => radii[i] ?? 0)]);
    },
    "addRoundRect(FFFF[FLandroid/graphics/Path$Direction;)V": function (this: JPath, l: number, t: number, r: number, b: number, radii: Float32Array) {
      this.add(["rrect", l, t, r, b, ...Array.from({ length: 8 }, (_, i) => radii[i] ?? 0)]);
    },
    "addOval(Landroid/graphics/RectF;Landroid/graphics/Path$Direction;)V": function (this: JPath, r: JRectF, d: { ord: number } | null) {
      this.add(["oval", r.left, r.top, r.right, r.bottom, d?.ord ?? 0]);
    },
    "addCircle(FFFLandroid/graphics/Path$Direction;)V": function (this: JPath, x: number, y: number, r: number, d: { ord: number } | null) {
      this.add(["circle", x, y, r, d?.ord ?? 0]);
    },
    "addPath(Landroid/graphics/Path;)V": function (this: JPath, o: JPath) { this.ops.push(...o.ops); this.dirty = true; },
    "addPath(Landroid/graphics/Path;FF)V": function (this: JPath, o: JPath, dx: number, dy: number) {
      const t = new JPath(); t.ops = o.ops.map((op) => op.slice() as typeof op);
      pathTransform(t, [1, 0, 0, 1, dx, dy]);
      this.ops.push(...t.ops); this.dirty = true;
    },
    "arcTo(Landroid/graphics/RectF;FF)V": function (this: JPath, r: JRectF, start: number, sweep: number) {
      this.add(["arc", r.left, r.top, r.right, r.bottom, start, sweep, 0]);
    },
    "arcTo(Landroid/graphics/RectF;FFZ)V": function (this: JPath, r: JRectF, start: number, sweep: number, force: number) {
      this.add(["arc", r.left, r.top, r.right, r.bottom, start, sweep, force]);
    },
    "arcTo(FFFFFFZ)V": function (this: JPath, l: number, t: number, r: number, b: number, start: number, sweep: number, force: number) {
      this.add(["arc", l, t, r, b, start, sweep, force]);
    },
    "setFillType(Landroid/graphics/Path$FillType;)V": function (this: JPath, ft: { ord: number }) {
      this.fillRule = ft?.ord === 1 || ft?.ord === 3 ? "evenodd" : "nonzero";
    },
    "isEmpty()Z": function (this: JPath) { return this.ops.length ? 0 : 1; },
    // These three walk coordinates only: an op's trailing scalars are radii and angles, and
    // moving or bounding a path must not touch them.
    "computeBounds(Landroid/graphics/RectF;Z)V": function (this: JPath, r: JRectF) { pathBounds(this, r); },
    "offset(FF)V": function (this: JPath, dx: number, dy: number) { pathOffset(this, dx, dy); },
    "transform(Landroid/graphics/Matrix;)V": function (this: JPath, mt: JMatrix) {
      pathTransform(this, mt.m);
      // A rotation or skew cannot be folded into an arc's axis-aligned rect and its angles, so
      // expand the compound ops into the curves Skia would already be holding. Material's
      // ShapeAppearancePathProvider rotates the path around every corner, and without this each
      // corner arc came out as a straight chord.
    },
  },
});

// These three walk coordinates only: an op's trailing scalars are radii and angles, and moving
// or bounding a path must not touch them. Exported because AOSP's own Path bytecode reaches
// the same three through nComputeBounds/nOffset/nTransform (src/android/delegates.ts).
export function pathBounds(p: JPath, r: { left: number; top: number; right: number; bottom: number }) {
  let l = Infinity, t = Infinity, rr = -Infinity, b = -Infinity;
  for (const op of p.ops) {
    for (let i = 1, n = opPairs[op[0]] ?? 0; n--; i += 2) {
      l = Math.min(l, op[i] as number); rr = Math.max(rr, op[i] as number);
      t = Math.min(t, op[i + 1] as number); b = Math.max(b, op[i + 1] as number);
    }
  }
  if (l === Infinity) { r.left = r.top = r.right = r.bottom = 0; }
  else { r.left = l; r.top = t; r.right = rr; r.bottom = b; }
}
export function pathOffset(p: JPath, dx: number, dy: number) {
  for (const op of p.ops) {
    for (let i = 1, n = opPairs[op[0]] ?? 0; n--; i += 2) {
      (op[i] as number) += dx; (op[i + 1] as number) += dy;
    }
  }
  p.dirty = true;
}
/** @param m an affine [a, b, c, d, tx, ty] */
export function pathTransform(p: JPath, m: ArrayLike<number>) {
  // A rotation or skew cannot be folded into an arc's axis-aligned rect and its angles, so
  // expand the compound ops into the curves Skia would already be holding. Material's
  // ShapeAppearancePathProvider rotates the path around every corner, and without this each
  // corner arc came out as a straight chord.
  if (m[1] !== 0 || m[2] !== 0) p.ops = verbsToOps(pathVerbs(p.ops));
  const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
  for (const op of p.ops) {
    for (let i = 1, n = opPairs[op[0]] ?? 0; n--; i += 2) {
      const x = op[i] as number, y = op[i + 1] as number;
      (op[i] as number) = m[0] * x + m[2] * y + m[4];
      (op[i + 1] as number) = m[1] * x + m[3] * y + m[5];
    }
    const rad = opRadii[op[0]];
    if (rad) for (let i = rad[0]; i < rad[1] && i < op.length; i++) (op[i] as number) *= (i - rad[0]) % 2 ? sy : sx;
  }
  p.dirty = true;
}
mkEnumSet("android/graphics/Path$Direction", ["CW", "CCW"]);

// ── androidx.graphics.path (Compose/Material3 below API 34): its JNI walks Skia's verb and
// point arrays. Ours walks the op list, expanding the compound ops into the verbs Skia would
// have stored — arcs as cubics rather than conics, so the conic-evaluation mode and tolerance
// have nothing to convert and Conic never appears.
const MOVE = 0, LINE = 1, QUAD = 2, CUBIC = 4, CLOSE = 5, DONE = 6;
/** [verb, ...floats]: Move its point; Line/Quad/Cubic the current point then 1/2/3 points; Close none */
type Verb = number[];
function pathVerbs(ops: PathOp[]): Verb[] {
  const out: Verb[] = [];
  let cx = 0, cy = 0, sx = 0, sy = 0, open = false;
  const move = (x: number, y: number) => { out.push([MOVE, x, y]); cx = sx = x; cy = sy = y; open = true; };
  // Skia injects a moveTo at the current point before a segment that has no contour
  const start = () => { if (!open) move(cx, cy); };
  const line = (x: number, y: number) => { start(); out.push([LINE, cx, cy, x, y]); cx = x; cy = y; };
  const cubic = (a: number, b: number, c: number, d: number, e: number, f: number) => {
    start(); out.push([CUBIC, cx, cy, a, b, c, d, e, f]); cx = e; cy = f;
  };
  const close = () => { if (open) { out.push([CLOSE]); open = false; } cx = sx; cy = sy; };
  const arc = (ax: number, ay: number, rx: number, ry: number, a0: number, a1: number) => {
    const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2) - 1e-6));
    const d = (a1 - a0) / n, k = 4 / 3 * Math.tan(d / 4);
    for (let i = 0; i < n; i++) {
      const t0 = a0 + d * i, t1 = t0 + d;
      const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
      cubic(ax + rx * (c0 - k * s0), ay + ry * (s0 + k * c0), ax + rx * (c1 + k * s1), ay + ry * (s1 - k * c1), ax + rx * c1, ay + ry * s1);
    }
  };
  const P = Math.PI;
  for (const op of ops) {
    const [k, a, b, c, d, e, f] = op as [string, ...number[]];
    switch (k) {
      case "m": move(a, b); break;
      case "l": line(a, b); break;
      case "q": start(); out.push([QUAD, cx, cy, a, b, c, d]); cx = c; cy = d; break;
      case "c": cubic(a, b, c, d, e, f); break;
      case "z": close(); break;
      case "rect":
        if (op[5]) { move(a, b); line(a, d); line(c, d); line(c, b); }
        else { move(a, b); line(c, b); line(c, d); line(a, d); }
        close(); break;
      case "rrect": {
        const q = rrRadii(op);
        move(a + q[0], b);
        line(c - q[2], b); arc(c - q[2], b + q[3], q[2], q[3], -P / 2, 0);
        line(c, d - q[5]); arc(c - q[4], d - q[5], q[4], q[5], 0, P / 2);
        line(a + q[6], d); arc(a + q[6], d - q[7], q[6], q[7], P / 2, P);
        line(a, b + q[1]); arc(a + q[0], b + q[1], q[0], q[1], P, P * 1.5);
        close();
        break;
      }
      case "oval": move(c, (b + d) / 2); arc((a + c) / 2, (b + d) / 2, (c - a) / 2, (d - b) / 2, 0, P * 2); close(); break;
      case "circle": move(a + c, b); arc(a, b, c, c, 0, P * 2); close(); break;
      case "arc": {
        const mx = (a + c) / 2, my = (b + d) / 2, rx = (c - a) / 2, ry = (d - b) / 2, a0 = e * P / 180;
        const px = mx + rx * Math.cos(a0), py = my + ry * Math.sin(a0);
        if (!open || op[7]) move(px, py); else line(px, py);
        arc(mx, my, rx, ry, a0, a0 + f * P / 180);
        break;
      }
    }
  }
  return out;
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

const pathIters = new Map<bigint, { segs: Verb[]; i: number }>();
let nextPathIter = 1n;
const pjni = (sig: string, fn: (...a: never[]) => unknown) => rt.registerJni("androidx/graphics/path/PathIteratorPreApi34Impl", sig, fn);
const iterSize = (h: bigint) => pathIters.get(h)?.segs.length ?? 0;
pjni("createInternalPathIterator(Landroid/graphics/Path;IF)J", (p: JPath) => {
  pathIters.set(nextPathIter, { segs: pathVerbs(p.ops), i: 0 });
  return nextPathIter++;
});
pjni("destroyInternalPathIterator(J)V", (h: bigint) => { pathIters.delete(h); });
pjni("internalPathIteratorHasNext(J)Z", (h: bigint) => { const it = pathIters.get(h); return it && it.i < it.segs.length ? 1 : 0; });
pjni("internalPathIteratorPeek(J)I", (h: bigint) => { const it = pathIters.get(h); return it?.segs[it.i]?.[0] ?? DONE; });
pjni("internalPathIteratorNext(J[FI)I", (h: bigint, pts: Float32Array, off: number) => {
  const it = pathIters.get(h), s = it?.segs[it.i];
  if (!it || !s) return DONE;
  it.i++;
  for (let i = 1; i < s.length; i++) pts[off + i - 1] = s[i];
  return s[0];
});
pjni("internalPathIteratorSize(J)I", iterSize);
pjni("internalPathIteratorRawSize(J)I", iterSize);
rt.claimNativeLib("androidx.graphics.path");
