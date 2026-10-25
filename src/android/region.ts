// The native half of android.graphics.Region and RegionIterator, following SkRegion: an integer
// area held as y-sorted bands of x-sorted, disjoint spans, in the canonical form SkRegion keeps
// (touching spans merged, vertically adjacent bands with the same spans merged, no empty band),
// so iteration, equality, toString and the boundary path all see the rectangles a device does.

import { rt, peerField } from "../jvm/runtime.ts";
import { after, vcall } from "../jvm/natives/jentry.ts";
import { deref, ownedHandle, release } from "./handles.ts";
import { type NativePath, pathAt } from "./path.ts";
import { type Band, sameSpans, scan } from "./scan.ts";
import { edges, emptyBox, setEdges, type Box } from "./graphics.ts";

/** SkRegion::Op, which Region.Op's nativeInt carries: difference, intersect, union, xor,
 *  reverse difference, replace */
const INTERSECT = 1, UNION = 2, REPLACE = 5;
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
    if (!box || !path.ops.length || !path.finite()) return path.inverseFill ? this.set(clip) : this.setEmpty();
    const filled = new NativeRegion();
    filled.bands = scan(path, box);
    return this.op(filled, clip, INTERSECT);
  }
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

const mNativeRegion = peerField<bigint>("android/graphics/Region", "mNativeRegion");
/** the area behind a Java Region */
const nativeRegionOf = (r: object): NativeRegion => deref<NativeRegion>(mNativeRegion(r));

// ── android.graphics.Region and RegionIterator ─────────────────────────────────────────
// Both free their native state from finalize(), which never runs here.
const region = (h: bigint) => deref<NativeRegion>(h);
const scratch = new NativeRegion();
rt.registerJnis("android/graphics/Region", {
  "nativeConstructor()J": () => ownedHandle(new NativeRegion()),
  "nativeDestructor(J)V": release,
  "nativeSetRegion(JJ)V": (h: bigint, src: bigint) => { region(h).set(region(src)); },
  "nativeSetRect(JIIII)Z": (h: bigint, l: number, t: number, r: number, b: number) => +region(h).setRect(l, t, r, b),
  "nativeSetPath(JJJ)Z": (h: bigint, p: bigint, clip: bigint) => +region(h).setPath(pathAt(p), region(clip)),
  "nativeGetBounds(JLandroid/graphics/Rect;)Z": (h: bigint, r: object) => {
    const b = region(h).bounds();
    setEdges(r, b ?? emptyBox);
    return +!!b;
  },
  "nativeGetBoundaryPath(JJ)Z": (h: bigint, p: bigint) => +region(h).boundaryPath(pathAt(p)),
  "nativeOp(JIIIII)Z": (h: bigint, l: number, t: number, r: number, b: number, op: number) => {
    scratch.setRect(l, t, r, b);
    return +region(h).op(region(h), scratch, op);
  },
  "nativeOp(JLandroid/graphics/Rect;JI)Z": (h: bigint, rect: object, other: bigint, op: number) => {
    const r = edges(rect);
    scratch.setRect(r.left, r.top, r.right, r.bottom);
    return +region(h).op(scratch, region(other), op);
  },
  "nativeOp(JJJI)Z": (h: bigint, a: bigint, b: bigint, op: number) => +region(h).op(region(a), region(b), op),
  // the rects as one int vector, which is Parcel's int-array form
  "nativeWriteToParcel(JLandroid/os/Parcel;)Z": (h: bigint, parcel: object | null) =>
    parcel ? after(vcall(parcel, "writeIntArray", "([I)V", Int32Array.from(region(h).rects())), () => 1) : 0,
  "nativeCreateFromParcel(Landroid/os/Parcel;)J": (parcel: object | null) => parcel ? after(vcall(parcel, "createIntArray", "()[I"), (rects: Int32Array | null) => {
    if (rects && rects.length % 4) return 0n;
    const r = new NativeRegion();
    if (rects) r.setRects(rects);
    return ownedHandle(r);
  }) : 0n,
  "nativeEquals(JJ)Z": (a: bigint, b: bigint) => +region(a).equals(region(b)),
  "nativeToString(J)Ljava/lang/String;": (h: bigint) => region(h).toString(),
  "isEmpty()Z": function (this: object) { return +nativeRegionOf(this).isEmpty(); },
  "isRect()Z": function (this: object) { return +nativeRegionOf(this).isRect(); },
  "isComplex()Z": function (this: object) { return +nativeRegionOf(this).isComplex(); },
  "contains(II)Z": function (this: object, x: number, y: number) { return +nativeRegionOf(this).contains(x, y); },
  "quickContains(IIII)Z": function (this: object, l: number, t: number, r: number, b: number) { return +nativeRegionOf(this).quickContains(l, t, r, b); },
  "quickReject(IIII)Z": function (this: object, l: number, t: number, r: number, b: number) { return +nativeRegionOf(this).quickReject(l, t, r, b); },
  "quickReject(Landroid/graphics/Region;)Z": function (this: object, o: object) {
    const b = nativeRegionOf(o).bounds();
    return +(!b || nativeRegionOf(this).quickReject(b.left, b.top, b.right, b.bottom));
  },
  "translate(IILandroid/graphics/Region;)V": function (this: object, dx: number, dy: number, dst: object | null) {
    const r = nativeRegionOf(this);
    r.translate(dx, dy, dst ? nativeRegionOf(dst) : r);
  },
  // hwui's scale_rgn: each rect's edges scaled and rounded half away from zero, then unioned
  "scale(FLandroid/graphics/Region;)V": function (this: object, s: number, dst: object | null) {
    const r = nativeRegionOf(this), round = (v: number) => Math.sign(v) * Math.round(Math.abs(v));
    (dst ? nativeRegionOf(dst) : r).setRects(r.rects().map((v) => round(Math.fround(v * s))));
  },
});
// the iterator walks its own copy of the region, as hwui's RgnIterPair does
rt.registerJnis("android/graphics/RegionIterator", {
  "nativeConstructor(J)J": (h: bigint) => ownedHandle({ rects: region(h).rects(), at: 0 }),
  "nativeDestructor(J)V": release,
  "nativeNext(JLandroid/graphics/Rect;)Z": (h: bigint, r: object) => {
    const it = deref<{ rects: number[]; at: number }>(h), { rects } = it;
    if (it.at >= rects.length) return 0;
    setEdges(r, { left: rects[it.at], top: rects[it.at + 1], right: rects[it.at + 2], bottom: rects[it.at + 3] });
    it.at += 4;
    return 1;
  },
});
