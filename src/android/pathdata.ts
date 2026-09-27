// SVG path data as android.util.PathParser reads it: one node per command letter with its
// numbers, which VectorDrawable morphs node for node and trims by arc length.

export interface PathNode { cmd: string; args: number[] }

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
export function parsePathData(data: string): PathNode[] {
  const nodes: PathNode[] = [];
  for (const [, cmd, rest] of data.matchAll(/([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g)) {
    nodes.push({ cmd, args: Array.from(rest.matchAll(NUMBER), (m) => Number(m[0])) });
  }
  return nodes;
}
export const pathDataString = (nodes: PathNode[]) => nodes.map((n) => n.cmd + n.args.join(" ")).join("");

/** PathParser.canMorph: the same commands with the same number of values */
export function canMorph(a: PathNode[], b: PathNode[]): boolean {
  return a.length === b.length && a.every((n, i) => n.cmd === b[i].cmd && n.args.length === b[i].args.length);
}
export function morph(a: PathNode[], b: PathNode[], f: number): PathNode[] {
  return a.map((n, i) => ({ cmd: n.cmd, args: n.args.map((v, j) => v + (b[i].args[j] - v) * f) }));
}

const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
const CURVE_STEPS = 12, ARC_STEPS = 16;
/** Each contour's points ([x0, y0, x1, y1, ...]) with curves and arcs flattened. */
export function flatten(nodes: PathNode[]): number[][] {
  const out: number[][] = [];
  let cur = null as number[] | null;
  let x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, prev = "";
  const to = (px: number, py: number) => {
    if (!cur) out.push(cur = [x, y]);
    cur.push(px, py); x = px; y = py;
  };
  const bezier = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    const x0 = x, y0 = y;
    for (let i = 1; i <= CURVE_STEPS; i++) {
      const t = i / CURVE_STEPS, u = 1 - t;
      to(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey);
    }
  };
  for (const { cmd, args } of nodes) {
    const lower = cmd.toLowerCase(), rel = cmd !== cmd.toUpperCase(), n = ARITY[lower];
    if (lower === "z") {
      if (cur) to(sx, sy);
      cur = null; x = sx; y = sy; prev = "z";
      continue;
    }
    for (let i = 0; i + n <= args.length; i += n) {
      const a = args.slice(i, i + n), ox = rel ? x : 0, oy = rel ? y : 0;
      switch (lower) {
        case "m":
          if (i === 0) { x = sx = a[0] + ox; y = sy = a[1] + oy; cur = null; } else to(a[0] + ox, a[1] + oy);
          break;
        case "l": to(a[0] + ox, a[1] + oy); break;
        case "h": to(a[0] + ox, y); break;
        case "v": to(x, a[0] + oy); break;
        case "c": bezier(a[0] + ox, a[1] + oy, cx = a[2] + ox, cy = a[3] + oy, a[4] + ox, a[5] + oy); break;
        case "s": {
          const reflect = prev === "c" || prev === "s";
          bezier(reflect ? 2 * x - cx : x, reflect ? 2 * y - cy : y, cx = a[0] + ox, cy = a[1] + oy, a[2] + ox, a[3] + oy);
          break;
        }
        case "q": case "t": {
          const reflect = lower === "t" && (prev === "q" || prev === "t");
          const qx = lower === "q" ? a[0] + ox : reflect ? 2 * x - cx : x, qy = lower === "q" ? a[1] + oy : reflect ? 2 * y - cy : y;
          const ex = a[n - 2] + ox, ey = a[n - 1] + oy;
          bezier(x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), ex + 2 / 3 * (qx - ex), ey + 2 / 3 * (qy - ey), ex, ey);
          cx = qx; cy = qy;
          break;
        }
        default: arc(a[0], a[1], a[2], a[3] !== 0, a[4] !== 0, a[5] + ox, a[6] + oy);
      }
      prev = lower === "m" && i ? "l" : lower;
    }
  }
  return out;

  /** SVG's endpoint arc through its centre parameterization (implementation notes, F.6.5) */
  function arc(rx: number, ry: number, degrees: number, large: boolean, sweep: boolean, ex: number, ey: number) {
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (!rx || !ry || (x === ex && y === ey)) { to(ex, ey); return; }
    const phi = degrees * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (x - ex) / 2, dy = (y - ey) / 2, x1 = cos * dx + sin * dy, y1 = -sin * dx + cos * dy;
    const scale = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
    if (scale > 1) { rx *= Math.sqrt(scale); ry *= Math.sqrt(scale); }
    const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
    const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
    const ccx = k * rx * y1 / ry, ccy = -k * ry * x1 / rx;
    const mx = cos * ccx - sin * ccy + (x + ex) / 2, my = sin * ccx + cos * ccy + (y + ey) / 2;
    const angle = (ux: number, uy: number) => Math.atan2(uy, ux);
    const start = angle((x1 - ccx) / rx, (y1 - ccy) / ry);
    let delta = angle((-x1 - ccx) / rx, (-y1 - ccy) / ry) - start;
    if (sweep && delta < 0) delta += 2 * Math.PI; else if (!sweep && delta > 0) delta -= 2 * Math.PI;
    for (let i = 1; i <= ARC_STEPS; i++) {
      const t = start + delta * i / ARC_STEPS, px = rx * Math.cos(t), py = ry * Math.sin(t);
      to(cos * px - sin * py + mx, sin * px + cos * py + my);
    }
  }
}

/** The part of the first contour between two fractions of its length, as SkPathMeasure.getSegment
 *  cuts it (hwui trims only the contour a path measure starts on). */
export function trimmed(nodes: PathNode[], start: number, end: number, offset: number): Path2D {
  const out = new Path2D(), pts = flatten(nodes)[0];
  if (!pts) return out;
  const lengths = [0];
  for (let i = 2; i < pts.length; i += 2) lengths.push(lengths[lengths.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
  const total = lengths[lengths.length - 1], wrap = (v: number) => ((v % 1) + 1) % 1;
  const a = wrap(start + offset), b = wrap(end + offset);
  const segment = (from: number, to: number) => {
    if (to <= from) return;
    let i = 0;
    while (i < lengths.length - 2 && lengths[i + 1] < from) i++;
    const at = (d: number, j: number): [number, number] => {
      const span = lengths[j + 1] - lengths[j], f = span > 0 ? (d - lengths[j]) / span : 0;
      return [pts[2 * j] + (pts[2 * j + 2] - pts[2 * j]) * f, pts[2 * j + 1] + (pts[2 * j + 3] - pts[2 * j + 1]) * f];
    };
    out.moveTo(...at(from, i));
    for (; i < lengths.length - 1 && lengths[i + 1] < to; i++) out.lineTo(pts[2 * i + 2], pts[2 * i + 3]);
    out.lineTo(...at(to, Math.min(i, lengths.length - 2)));
  };
  if (a > b) { segment(a * total, total); segment(0, b * total); } else segment(a * total, b * total);
  return out;
}
