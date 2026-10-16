// android.util.PathParser's native half: hwui's PathParser (SVG path data as verbs, their point
// counts and float points) and VectorDrawableUtils (morphing, and resolving the verbs into an
// SkPath as PathResolver does).

import { rt } from "../jvm/runtime.ts";
import { deref, ownedHandle, release } from "./handles.ts";
import type { NativePath } from "./path.ts";
import { snap } from "./matrix.ts";

export class PathData {
  verbs: string[] = [];
  sizes: number[] = [];
  points: number[] = [];
  copy(o: PathData): void { this.verbs = o.verbs.slice(); this.sizes = o.sizes.slice(); this.points = o.points.slice(); }
}

const isSpace = (c: string) => c === " " || (c >= "\t" && c <= "\r");
/** PathParser::validateVerbAndPoints: how many floats each repetition of a verb takes */
const ARITY: Record<string, number> = { z: 0, m: 2, l: 2, t: 2, h: 1, v: 1, c: 6, s: 4, q: 4, a: 7 };
function verbError(verb: string, points: number): string {
  const n = ARITY[verb.toLowerCase()];
  if (n === undefined) return verb + " is not a valid verb. ";
  if (n === 0 ? points === 0 : points % n === 0) return "";
  return `${verb} needs to be followed by ${n ? `a multiple of ${n} floats` : "no argument"}. However, ${points} float(s) are found. `;
}
/** the next command letter at or after `i` (e/E belong to numbers) */
function nextStart(s: string, len: number, i: number): number {
  for (; i < len; i++) {
    const c = s[i];
    if (((c >= "A" && c <= "Z") || (c >= "a" && c <= "z")) && c !== "e" && c !== "E") return i;
  }
  return i;
}
const FLOAT = /^[ \t\n\v\f\r]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
/** PathParser.cpp's getFloats: numbers split at ' ', ',', a '-' not after an exponent, or a second
 *  '.', each read by strtof from where it starts to the end of the command; the failure, or "" */
function getFloats(out: number[], s: string, start: number, end: number): string {
  if (s[start] === "z" || s[start] === "Z") return "";
  let pos = start + 1;
  while (pos < end) {
    let i = pos, negOrDot = false, secondDot = false, exponential = false;
    for (; i < end; i++) {
      const prevExponential = exponential, c = s[i];
      exponential = false;
      if (c === " " || c === ",") break;
      if (c === "-") { if (i !== pos && !prevExponential) { negOrDot = true; break; } }
      else if (c === ".") { if (secondDot) { negOrDot = true; break; } secondDot = true; }
      else if (c === "e" || c === "E") exponential = true;
    }
    if (pos < i) {
      const text = s.slice(pos, end), m = FLOAT.exec(text);
      if (!m) return "No float number found:  " + text;
      const v = Math.fround(Number(m[0]));
      if (!Number.isFinite(v)) return "Float out of range:  " + text;
      out.push(v);
    }
    pos = negOrDot ? i : i + 1;
  }
  return "";
}
/** PathParser::getPathDataFromAsciiString: the failure message, or "" */
export function parsePathData(data: PathData, s: string | null, len: number): string {
  if (s === null) return "Path string cannot be NULL.";
  let start = 0;
  while (start < len && isSpace(s[start])) start++;
  if (start === len) return "Path string cannot be empty.";
  const failed = (error: string) => `${error}Failure occurred at position ${start} of path: ${s}`;
  let end = start + 1;
  while (end < len) {
    end = nextStart(s, len, end);
    const points: number[] = [];
    const error = getFloats(points, s, start, end) + verbError(s[start], points.length);
    if (error) return failed(error);
    data.verbs.push(s[start]); data.sizes.push(points.length);
    for (const p of points) data.points.push(p);
    start = end;
    end++;
  }
  if (end - start === 1 && start < len) {
    const error = verbError(s[start], 0);
    if (error) return failed(error);
    data.verbs.push(s[start]); data.sizes.push(0);
  }
  return "";
}

const canMorph = (a: PathData, b: PathData): boolean =>
  a.verbs.length === b.verbs.length && a.verbs.every((v, i) => v === b.verbs[i] && a.sizes[i] === b.sizes[i]);
/** VectorDrawableUtils::interpolatePaths: `from`'s verbs over points `fraction` of the way to `to` */
export function interpolatePaths(out: PathData, from: PathData, to: PathData, fraction: number): void {
  out.verbs = from.verbs; out.sizes = from.sizes;
  const n = from.points.length, p = out.points.length === n && out.points !== from.points ? out.points : (out.points = new Array(n));
  for (let i = 0; i < n; i++) p[i] = Math.fround(from.points[i] * (1 - fraction) + to.points[i] * fraction);
}

/** VectorDrawableUtils::verbsToPath: PathResolver's reading of each command into `path` */
export function verbsToPath(path: NativePath, data: PathData): void {
  path.reset();
  const pts = data.points, pen = path.pen;
  let cx = 0, cy = 0, ctrlX = 0, ctrlY = 0, segX = 0, segY = 0, prev = "m", k = 0;
  for (let vi = 0; vi < data.verbs.length; vi++) {
    const cmd = data.verbs[vi], start = k, end = k + data.sizes[vi], incr = ARITY[cmd.toLowerCase()] || 2;
    k = end;
    if (cmd === "z" || cmd === "Z") {
      path.close();
      cx = ctrlX = segX; cy = ctrlY = segY;
      path.moveTo(cx, cy);
    }
    for (let i = start; i + incr <= end; i += incr) {
      const p0 = pts[i], p1 = pts[i + 1], p2 = pts[i + 2], p3 = pts[i + 3], p4 = pts[i + 4], p5 = pts[i + 5];
      // Skia's relative verbs start from the path's last point
      const lx = pen.x, ly = pen.y;
      let rx: number, ry: number;
      switch (cmd) {
        case "m":
          cx += p0; cy += p1;
          if (i > start) path.lineTo(lx + p0, ly + p1);
          else { path.moveTo(lx + p0, ly + p1); segX = cx; segY = cy; }
          break;
        case "M":
          cx = p0; cy = p1;
          if (i > start) path.lineTo(p0, p1);
          else { path.moveTo(p0, p1); segX = cx; segY = cy; }
          break;
        case "l": path.lineTo(lx + p0, ly + p1); cx += p0; cy += p1; break;
        case "L": path.lineTo(p0, p1); cx = p0; cy = p1; break;
        case "h": path.lineTo(lx + p0, ly); cx += p0; break;
        case "H": path.lineTo(p0, cy); cx = p0; break;
        case "v": path.lineTo(lx, ly + p0); cy += p0; break;
        case "V": path.lineTo(cx, p0); cy = p0; break;
        case "c":
          path.cubicTo(lx + p0, ly + p1, lx + p2, ly + p3, lx + p4, ly + p5);
          ctrlX = cx + p2; ctrlY = cy + p3; cx += p4; cy += p5;
          break;
        case "C":
          path.cubicTo(p0, p1, p2, p3, p4, p5);
          cx = p4; cy = p5; ctrlX = p2; ctrlY = p3;
          break;
        case "s":
          rx = ry = 0;
          if ("cCsS".includes(prev)) { rx = cx - ctrlX; ry = cy - ctrlY; }
          path.cubicTo(lx + rx, ly + ry, lx + p0, ly + p1, lx + p2, ly + p3);
          ctrlX = cx + p0; ctrlY = cy + p1; cx += p2; cy += p3;
          break;
        case "S":
          rx = cx; ry = cy;
          if ("cCsS".includes(prev)) { rx = 2 * cx - ctrlX; ry = 2 * cy - ctrlY; }
          path.cubicTo(rx, ry, p0, p1, p2, p3);
          ctrlX = p0; ctrlY = p1; cx = p2; cy = p3;
          break;
        case "q":
          path.quadTo(lx + p0, ly + p1, lx + p2, ly + p3);
          ctrlX = cx + p0; ctrlY = cy + p1; cx += p2; cy += p3;
          break;
        case "Q":
          path.quadTo(p0, p1, p2, p3);
          ctrlX = p0; ctrlY = p1; cx = p2; cy = p3;
          break;
        case "t":
          rx = ry = 0;
          if ("qQtT".includes(prev)) { rx = cx - ctrlX; ry = cy - ctrlY; }
          path.quadTo(lx + rx, ly + ry, lx + p0, ly + p1);
          ctrlX = cx + rx; ctrlY = cy + ry; cx += p0; cy += p1;
          break;
        case "T":
          rx = cx; ry = cy;
          if ("qQtT".includes(prev)) { rx = 2 * cx - ctrlX; ry = 2 * cy - ctrlY; }
          path.quadTo(rx, ry, p0, p1);
          ctrlX = rx; ctrlY = ry; cx = p0; cy = p1;
          break;
        case "a":
          arcTo(path, p0, p1, p2, p3 !== 0, p4 !== 0, p5 + cx, pts[i + 6] + cy);
          cx += p5; cy += pts[i + 6]; ctrlX = cx; ctrlY = cy;
          break;
        case "A":
          arcTo(path, p0, p1, p2, p3 !== 0, p4 !== 0, p5, pts[i + 6]);
          cx = p5; cy = pts[i + 6]; ctrlX = cx; ctrlY = cy;
          break;
      }
      prev = cmd;
    }
    prev = cmd;
  }
}
const f32 = Math.fround;
/** SkPath::arcTo's SVG form (which PathResolver resolves 'a' with): the arc from the last point to
 *  (x, y) as conics of at most a third of a turn, radii scaled up to reach it, the end point exact */
function arcTo(p: NativePath, rx: number, ry: number, angle: number, large: boolean, sweep: boolean, x: number, y: number): void {
  const x0 = p.pen.x, y0 = p.pen.y;
  if (!rx || !ry || (x0 === x && y0 === y)) { p.lineTo(x, y); return; }
  rx = Math.abs(rx); ry = Math.abs(ry);
  const rad = angle * Math.PI / 180, sin = snap(Math.sin(rad)), cos = snap(Math.cos(rad));
  // the half chord in the ellipse's frame
  const mx = (x0 - x) / 2, my = (y0 - y) / 2;
  const tx = cos * mx + sin * my, ty = -sin * mx + cos * my;
  const scale = f32(tx * tx / (rx * rx) + ty * ty / (ry * ry));
  if (scale > 1) { const s = Math.sqrt(scale); rx = f32(rx * s); ry = f32(ry * s); }
  // both ends on the unit circle's frame
  const ux0 = (cos * x0 + sin * y0) / rx, uy0 = (-sin * x0 + cos * y0) / ry;
  const ux1 = (cos * x + sin * y) / rx, uy1 = (-sin * x + cos * y) / ry;
  let dx = ux1 - ux0, dy = uy1 - uy0;
  let factor = Math.sqrt(Math.max(1 / (dx * dx + dy * dy) - 0.25, 0));
  // SVG's sweep flag 1 is Skia's clockwise
  if (!sweep !== large) factor = -factor;
  dx *= factor; dy *= factor;
  const cx = (ux0 + ux1) / 2 - dy, cy = (uy0 + uy1) / 2 + dx;
  const theta1 = Math.atan2(uy0 - cy, ux0 - cx);
  let arc = Math.atan2(uy1 - cy, ux1 - cx) - theta1;
  if (arc < 0 && sweep) arc += Math.PI * 2;
  else if (arc > 0 && !sweep) arc -= Math.PI * 2;
  if (Math.abs(arc) < Math.PI / 1e6) { p.lineTo(x, y); return; }
  const segments = Math.ceil(Math.abs(arc / (2 * Math.PI / 3))), width = arc / segments, t = Math.tan(0.5 * width);
  if (!Number.isFinite(t)) return;
  const w = Math.sqrt(0.5 + Math.cos(width) * 0.5);
  const integral = (v: number) => v === Math.floor(v);
  const integers = Math.abs(Math.PI / 2 - Math.abs(width)) <= 1 / 4096 && integral(rx) && integral(ry) && integral(x) && integral(y);
  // unit circle -> the ellipse: scale by the radii, then rotate by the angle
  const map = (ux: number, uy: number): [number, number] => {
    const ex = ux * rx, ey = uy * ry, px = cos * ex - sin * ey, py = sin * ex + cos * ey;
    return integers ? [Math.round(px), Math.round(py)] : [px, py];
  };
  let start = theta1;
  for (let i = 0; i < segments; i++) {
    const end = start + width, s = snap(Math.sin(end)), c = snap(Math.cos(end));
    const [ex, ey] = map(c + cx, s + cy), [qx, qy] = map(c + cx + t * s, s + cy - t * c);
    p.conicTo(f32(qx), f32(qy), f32(ex), f32(ey), f32(w));
    start = end;
  }
  p.setLastPoint(x, y);
}

const data = (h: bigint) => deref<PathData>(h);
/** the IllegalArgumentException the PathParser and VectorDrawable JNI throw for a failed parse */
export function throwParseFailure(error: string): void {
  if (error) throw rt.mkThrowable("java/lang/IllegalArgumentException", error);
}
function parsed(s: string, len: number): PathData {
  const d = new PathData();
  throwParseFailure(parsePathData(d, s, len));
  return d;
}
rt.registerJnis("android/util/PathParser", {
  "nParseStringForPath(JLjava/lang/String;I)V": (path: bigint, s: string, len: number) => verbsToPath(deref<NativePath>(path), parsed(s, len)),
  "nCreatePathDataFromString(Ljava/lang/String;I)J": (s: string, len: number) => ownedHandle(parsed(s, len)),
  "nCreateEmptyPathData()J": () => ownedHandle(new PathData()),
  "nCreatePathData(J)J": (h: bigint) => { const d = new PathData(); d.copy(data(h)); return ownedHandle(d); },
  "nCreatePathFromPathData(JJ)V": (path: bigint, h: bigint) => verbsToPath(deref<NativePath>(path), data(h)),
  "nFinalize(J)V": (h: bigint) => release(h),
  "nCanMorph(JJ)Z": (a: bigint, b: bigint) => +canMorph(data(a), data(b)),
  "nInterpolatePathData(JJJF)Z": (out: bigint, from: bigint, to: bigint, fraction: number) => {
    if (!canMorph(data(from), data(to))) return 0;
    interpolatePaths(data(out), data(from), data(to), fraction);
    return 1;
  },
  "nSetPathData(JJ)V": (out: bigint, from: bigint) => data(out).copy(data(from)),
});
