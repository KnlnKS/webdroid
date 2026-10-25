// SkPathEffect behind android.graphics.PathEffect and its subclasses, whose Java runs from AOSP
// bytecode: filterPath over NativePath geometry, and the SkStrokeRec a paint gives it.

import { rt } from "../jvm/runtime.ts";
import { handle, deref, release } from "./handles.ts";
import { NativePath, VerbIterator, RAW_SIZE, MOVE, LINE, QUAD, CUBIC, CLOSE, DONE } from "./path.ts";
import { PathMeasure } from "./pathmeasure.ts";
import type { NativePaint } from "./paint.ts";

/** SkStrokeRec's part the effects read and change: fill, or a stroke of `width` (0 a hairline) */
interface StrokeRec { fill: boolean; width: number; strokeAndFill: boolean }
export abstract class NativePathEffect {
  /** the effect of `src` appended to `dst`; false when it leaves the path as it is */
  abstract filter(dst: NativePath, src: NativePath, rec: StrokeRec): boolean;
}
/** SkPath::Iter over the verbs: a close reports the line back to the contour's start first */
function* iterate(p: NativePath): Generator<number[]> {
  let mx = 0, my = 0, x = 0, y = 0;
  const it = new VerbIterator(p), pts = new Float64Array(8);
  for (let verb; (verb = it.next(pts)) !== DONE;) {
    const v = [verb, ...pts.subarray(0, RAW_SIZE[verb])];
    if (v[0] === MOVE) { mx = x = v[1]; my = y = v[2]; } else if (v[0] === CLOSE) {
      if (x !== mx || y !== my) yield [LINE, x, y, mx, my];
      x = mx; y = my;
    } else { x = v[v.length - 2]; y = v[v.length - 1]; }
    yield v;
  }
}
/** whether the contour starting at verb `i` is closed */
const closedFrom = (verbs: number[][], i: number) => {
  for (let k = i + 1; k < verbs.length && verbs[k][0] !== MOVE; k++) if (verbs[k][0] === CLOSE) return true;
  return false;
};
/** SkDashPathEffect: intervals, and the phase as an offset into them */
export class DashEffect extends NativePathEffect {
  readonly intervals: number[]; readonly phase: number;
  readonly length: number;
  readonly firstLength: number;
  readonly firstIndex: number;
  constructor(intervals: number[], phase: number) {
    super();
    this.intervals = intervals; this.phase = phase;
    const len = this.length = intervals.reduce((a, b) => a + b, 0);
    // CalcDashParameters: a negative phase flips, and phase lands in [0, len)
    if (phase < 0) { phase = -phase; if (phase > len) phase %= len; phase = len - phase; if (phase === len) phase = 0; }
    else if (phase >= len) phase %= len;
    this.phase = phase;
    let index = 0, first = intervals[0];
    for (let i = 0; i < intervals.length; i++) {
      const gap = intervals[i];
      if (phase > gap || (phase === gap && gap)) phase -= gap;
      else { index = i; first = gap - phase; break; }
    }
    this.firstLength = first; this.firstIndex = index;
  }
  // SkDashPath::InternalFilter, without its line special case (a butt-capped single line becomes rects)
  filter(dst: NativePath, src: NativePath, rec: StrokeRec): boolean {
    if (rec.fill || rec.strokeAndFill) return false;
    const meas = new PathMeasure(), iv = this.intervals, count = iv.length;
    meas.setPath(src, false);
    do {
      const length = meas.length();
      let skipFirst = meas.isClosed(), added = false, index = this.firstIndex, distance = 0, dlen = this.firstLength;
      if (length * (count >> 1) / this.length > 1000000) { dst.reset(); return false; }
      while (distance < length) {
        added = false;
        if (!(index & 1) && !skipFirst) { added = true; meas.getSegment(distance, distance + dlen, dst, true); }
        distance += dlen;
        skipFirst = false;
        if (++index === count) index = 0;
        dlen = iv[index];
      }
      // a closed contour that starts inside a dash ends it there
      if (meas.isClosed() && !(this.firstIndex & 1) && this.firstLength >= 0) meas.getSegment(0, this.firstLength, dst, !added);
    } while (meas.nextContour());
    return true;
  }
}
/** SkCornerPathEffect: each corner between lines rounded by a quadratic through it */
class CornerEffect extends NativePathEffect {
  readonly radius: number;
  constructor(radius: number) { super(); this.radius = radius; }
  filter(dst: NativePath, src: NativePath): boolean {
    const r = this.radius, verbs = [...iterate(src)];
    let prevVerb = -1, prevIsValid = true, mx = 0, my = 0, lx = 0, ly = 0, fx = 0, fy = 0, sx = 0, sy = 0;
    for (let i = 0; i < verbs.length; i++) {
      const v = verbs[i], verb = v[0];
      switch (verb) {
        case MOVE:
          if (prevVerb === LINE) dst.lineTo(lx, ly);
          if (closedFrom(verbs, i)) { mx = v[1]; my = v[2]; prevIsValid = false; } else { dst.moveTo(v[1], v[2]); prevIsValid = true; }
          break;
        case LINE: {
          // ComputeStep: toward the next point by the radius, or half way when the line is short
          const [, x0, y0, x1, y1] = v, dist = Math.hypot(x1 - x0, y1 - y0), whole = dist > r * 2, k = whole ? r / dist : 0.5;
          sx = (x1 - x0) * k; sy = (y1 - y0) * k;
          if (!prevIsValid) { dst.moveTo(mx + sx, my + sy); prevIsValid = true; } else dst.quadTo(x0, y0, x0 + sx, y0 + sy);
          if (whole) dst.lineTo(x1 - sx, y1 - sy);
          lx = x1; ly = y1;
          break;
        }
        case QUAD: case CUBIC:
          if (!prevIsValid) { dst.moveTo(v[1], v[2]); prevIsValid = true; }
          if (verb === QUAD) dst.quadTo(v[3], v[4], v[5], v[6]); else dst.cubicTo(v[3], v[4], v[5], v[6], v[7], v[8]);
          lx = v[v.length - 2]; ly = v[v.length - 1]; fx = fy = 0;
          break;
        case CLOSE:
          if (fx || fy) dst.quadTo(lx, ly, lx + fx, ly + fy);
          dst.close();
          prevIsValid = false;
          break;
      }
      if (prevVerb === MOVE) { fx = sx; fy = sy; }
      prevVerb = verb;
    }
    if (prevIsValid) dst.lineTo(lx, ly);
    return true;
  }
}
/** SkDiscretePathEffect: points every segment length along each contour, pushed off it along the
 *  normal by an LCG's deviation (seeded from the path's length, as Skia seeds it; DiscretePathEffect
 *  gives no seed assist) */
class DiscreteEffect extends NativePathEffect {
  readonly segLength: number; readonly deviation: number;
  constructor(segLength: number, deviation: number) { super(); this.segLength = segLength; this.deviation = deviation; }
  filter(dst: NativePath, src: NativePath, rec: StrokeRec): boolean {
    const meas = new PathMeasure(), pos = new Float32Array(2), tan = new Float32Array(2);
    meas.setPath(src, rec.fill);
    const s0 = Math.round(meas.length()) >>> 0;
    let seed = (s0 ^ ((s0 << 16) | (s0 >>> 16))) >>> 0;
    // LCGRandom::nextSScalar1: a signed 16.16 fraction in [-1, 1)
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return ((seed | 0) >> 15) / 65536; };
    const point = (d: number, first: boolean) => {
      if (!meas.getPosTan(d, pos, tan)) return;
      // Perterb: along the tangent turned counter-clockwise, scaled to the deviation
      const scale = random() * this.deviation, len = Math.hypot(tan[0], tan[1]);
      const x = pos[0] + (len ? tan[1] / len * scale : 0), y = pos[1] - (len ? tan[0] / len * scale : 0);
      if (first) dst.moveTo(Math.fround(x), Math.fround(y)); else dst.lineTo(Math.fround(x), Math.fround(y));
    };
    do {
      const length = meas.length();
      if (this.segLength * (2 + +rec.fill) > length) meas.getSegment(0, length, dst, true);
      else {
        let n = Math.min(Math.round(length / this.segLength), 100000), distance = 0;
        const delta = length / n;
        if (meas.isClosed()) { n--; distance += delta / 2; }
        point(distance, true);
        while (--n >= 0) { distance += delta; point(distance, false); }
        if (meas.isClosed()) dst.close();
      }
    } while (meas.nextContour());
    return true;
  }
}
/** SkPath1DPathEffect: a stamp placed every `advance` along each contour, translated, rotated to
 *  the tangent, or bent along the contour; the result is filled */
class Path1DEffect extends NativePathEffect {
  readonly stamp: NativePath; readonly advance: number; readonly style: number;
  readonly offset: number;
  constructor(stamp: NativePath, advance: number, phase: number, style: number) {
    super();
    this.stamp = stamp; this.advance = advance; this.style = style;
    // phase inverted into an offset along the path, as PostScript reads it
    if (phase < 0) { phase = -phase; if (phase > advance) phase %= advance; }
    else { if (phase > advance) phase %= advance; phase = advance - phase; }
    this.offset = phase >= advance ? 0 : phase;
  }
  filter(dst: NativePath, src: NativePath, rec: StrokeRec): boolean {
    rec.fill = true; rec.strokeAndFill = false;
    const meas = new PathMeasure(), pos = new Float32Array(2), m = new Float64Array(9);
    meas.setPath(src, false);
    do {
      const length = meas.length();
      for (let d = this.offset, governor = 100000; d < length && --governor >= 0; d += this.advance) {
        if (this.style === 0) { if (meas.getPosTan(d, pos, null)) dst.append(this.stamp, undefined, pos[0], pos[1]); }
        else if (this.style === 1) { if (meas.getMatrix(d, m, 3)) dst.append(this.stamp, m); }
        else this.morph(dst, meas, d);
      }
    } while (meas.nextContour());
    return true;
  }
  /** morphpath: every point of the stamp moved along the contour by its x, and off it by its y */
  private morph(dst: NativePath, meas: PathMeasure, dist: number) {
    const pos = new Float32Array(2), tan = new Float32Array(2), out: number[] = [];
    const map = (pts: number[]) => {
      out.length = 0;
      for (let i = 0; i < pts.length; i += 2) {
        const sx = pts[i], sy = pts[i + 1];
        if (!meas.getPosTan(dist + sx, pos, tan)) return false;
        out.push(pos[0] - tan[1] * sy, pos[1] + tan[0] * sy);
      }
      return true;
    };
    for (const v of iterate(this.stamp)) {
      switch (v[0]) {
        case MOVE: if (map([v[1], v[2]])) dst.moveTo(out[0], out[1]); break;
        case LINE: if (map([(v[1] + v[3]) / 2, (v[2] + v[4]) / 2, v[3], v[4]])) dst.quadTo(out[0], out[1], out[2], out[3]); break;
        case QUAD: if (map(v.slice(3))) dst.quadTo(out[0], out[1], out[2], out[3]); break;
        case CUBIC: if (map(v.slice(3))) dst.cubicTo(out[0], out[1], out[2], out[3], out[4], out[5]); break;
        case CLOSE: dst.close(); break;
      }
    }
  }
}
/** SkComposePathEffect: the outer effect over what the inner one made */
class ComposeEffect extends NativePathEffect {
  readonly outer: NativePathEffect; readonly inner: NativePathEffect;
  constructor(outer: NativePathEffect, inner: NativePathEffect) { super(); this.outer = outer; this.inner = inner; }
  filter(dst: NativePath, src: NativePath, rec: StrokeRec): boolean {
    const tmp = new NativePath();
    return this.outer.filter(dst, this.inner.filter(tmp, src, rec) ? tmp : src, rec);
  }
}
/** SkSumPathEffect: both effects' paths, one after the other */
class SumEffect extends NativePathEffect {
  readonly first: NativePathEffect; readonly second: NativePathEffect;
  constructor(first: NativePathEffect, second: NativePathEffect) { super(); this.first = first; this.second = second; }
  filter(dst: NativePath, src: NativePath, rec: StrokeRec): boolean {
    return (+this.first.filter(dst, src, rec) | +this.second.filter(dst, src, rec)) !== 0;
  }
}
export const effectAt = (h: bigint) => (h ? deref<NativePathEffect>(h) : null);
const finite = (...v: number[]) => v.every(Number.isFinite);
rt.registerJnis("android/graphics/PathEffect", { "nativeDestructor(J)V": release });
rt.registerJnis("android/graphics/DashPathEffect", {
  // SkDashPathEffect::Make over an even count; an invalid pattern is no effect
  "nativeCreate([FF)J": (iv: Float32Array, phase: number) => {
    const intervals = Array.from(iv.subarray(0, iv.length & ~1)), len = intervals.reduce((a, b) => a + b, 0);
    return intervals.length < 2 || intervals.some((v) => v < 0) || !(len > 0) || !finite(len, phase) ? 0n : handle(new DashEffect(intervals, phase));
  },
});
rt.registerJnis("android/graphics/CornerPathEffect", {
  "nativeCreate(F)J": (radius: number) => (radius > 0 && finite(radius) ? handle(new CornerEffect(radius)) : 0n),
});
rt.registerJnis("android/graphics/DiscretePathEffect", {
  "nativeCreate(FF)J": (seg: number, dev: number) => (finite(seg, dev) && seg > 1 / 4096 ? handle(new DiscreteEffect(seg, dev)) : 0n),
});
rt.registerJnis("android/graphics/PathDashPathEffect", {
  "nativeCreate(JFFI)J": (path: bigint, advance: number, phase: number, style: number) => {
    const stamp = deref<NativePath>(path);
    if (!(advance > 0) || !finite(advance, phase) || !stamp.ops.length) return 0n;
    const copy = new NativePath();
    copy.set(stamp);
    return handle(new Path1DEffect(copy, advance, phase, style));
  },
});
rt.registerJnis("android/graphics/ComposePathEffect", {
  "nativeCreate(JJ)J": (outer: bigint, inner: bigint) => {
    const o = effectAt(outer), i = effectAt(inner);
    return o && i ? handle(new ComposeEffect(o, i)) : o ? outer : inner;
  },
});
rt.registerJnis("android/graphics/SumPathEffect", {
  "nativeCreate(JJ)J": (first: bigint, second: bigint) => {
    const a = effectAt(first), b = effectAt(second);
    return a && b ? handle(new SumEffect(a, b)) : a ? first : second;
  },
});
/** SkStrokeRec(paint): FILL_AND_STROKE of width 0 is a fill */
export const strokeRec = (p: NativePaint): StrokeRec => ({
  fill: p.style === 0 || p.style === 2 && p.strokeWidth === 0, width: p.strokeWidth, strokeAndFill: p.style === 2 && p.strokeWidth !== 0,
});
