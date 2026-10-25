// VectorDrawable's native half, as hwui's VectorDrawable.cpp: a Tree over Groups, FullPaths and
// ClipPaths whose properties AOSP's Java reads and writes, drawn as Tree::draw draws on a software
// canvas: into a cached bitmap at the canvas-scaled bounds size, repainted only when a property
// changed, then drawn into the bounds through the colour filter at the root alpha.

import { rt } from "../jvm/runtime.ts";
import { deref, ownedHandle, weakHandle } from "./handles.ts";
import { edges } from "./graphics.ts";
import type { NativeColorFilter } from "./colorfilter.ts";
import type { NativeShader } from "./shader.ts";
import { NativeCanvas, drawingCanvas } from "./canvas.ts";
import { drawBitmap, drawPath } from "./canvas-draw.ts";
import { NativeBitmap } from "./bitmap.ts";
import { CAPS, JOINS, NativePaint } from "./paint.ts";
import { NativePath } from "./path.ts";
import { PathMeasure } from "./pathmeasure.ts";
import { PathData, parsePathData, throwParseFailure, verbsToPath } from "./pathparser.ts";

/** hwui's applyAlpha: the colour's alpha byte scaled, truncated as SkColorSetA takes it */
const applyAlpha = (color: number, alpha: number) => ((((color >>> 24) * alpha) & 255) << 24 | (color & 0xffffff)) | 0;

abstract class Node {
  name = "";
  tree: Tree | null = null;
  changed(): void { if (this.tree) this.tree.dirty = true; }
  abstract draw(nc: NativeCanvas): void;
  adopt(tree: Tree): void { this.tree = tree; }
}

// Groups: rotate, pivotX, pivotY, scaleX, scaleY, translateX, translateY (GroupProperties::Property)
const ROTATE = 0, PIVOT_X = 1, PIVOT_Y = 2, SCALE_X = 3, SCALE_Y = 4, TRANSLATE_X = 5, TRANSLATE_Y = 6;
export class Group extends Node {
  readonly props = Float32Array.of(0, 0, 0, 1, 1, 0, 0);
  readonly children: Node[] = [];
  set(id: number, v: number): void {
    if (id < 0 || id > TRANSLATE_Y) throw new Error(`Invalid property index: ${id}`);
    if (this.props[id] !== Math.fround(v)) { this.props[id] = v; this.changed(); }
  }
  override adopt(tree: Tree): void { this.tree = tree; for (const c of this.children) c.adopt(tree); }
  /** Group::draw: the local matrix (pivot, scale, rotation, translation), children in order, and
   *  whatever a clip-path clipped undone after */
  draw(nc: NativeCanvas): void {
    const p = this.props, ctx = nc.ctx;
    ctx.save();
    ctx.translate(p[TRANSLATE_X] + p[PIVOT_X], p[TRANSLATE_Y] + p[PIVOT_Y]);
    if (p[ROTATE]) ctx.rotate(p[ROTATE] * Math.PI / 180);
    ctx.scale(p[SCALE_X], p[SCALE_Y]);
    ctx.translate(-p[PIVOT_X], -p[PIVOT_Y]);
    for (const c of this.children) c.draw(nc);
    ctx.restore();
  }
}

export abstract class VPath extends Node {
  data = new PathData();
  protected readonly path = new NativePath();
  protected pathDirty = true;
  setData(d: PathData): void { this.data.copy(d); this.pathDirty = true; this.changed(); }
  /** Path::getUpdatedPath: the SkPath the verbs resolve to */
  protected built(): NativePath {
    if (this.pathDirty) { verbsToPath(this.path, this.data); this.pathDirty = false; }
    return this.path;
  }
}
class ClipPath extends VPath {
  draw(nc: NativeCanvas): void { nc.ctx.clip(this.built().path()); }
}

// FullPathProperties::PrimitiveFields in field order; the ints stored as their bits' value
const STROKE_WIDTH = 0, STROKE_COLOR = 1, STROKE_ALPHA = 2, FILL_COLOR = 3, FILL_ALPHA = 4, TRIM_START = 5, TRIM_END = 6,
  TRIM_OFFSET = 7, CAP = 8, JOIN = 9, MITER = 10, FILL_TYPE = 11, FULL_PATH_FIELDS = 12;
const INT_FIELD = [false, true, false, true, false, false, false, false, true, true, false, true];
export class FullPath extends VPath {
  readonly props: number[] = [0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 4, 0];
  fillGradient: NativeShader | null = null;
  strokeGradient: NativeShader | null = null;
  private readonly trimmed = new NativePath();
  private trimDirty = true;
  set(id: number, v: number): void {
    const value = INT_FIELD[id] ? v | 0 : Math.fround(v);
    if (this.props[id] === value) return;
    this.props[id] = value;
    if (id >= TRIM_START && id <= TRIM_OFFSET) this.trimDirty = true;
    this.changed();
  }
  /** FullPathProperties::setPropertyValue and setColorPropertyValue: only what animates */
  animate(id: number, v: number, color: boolean): void {
    if (color ? id !== STROKE_COLOR && id !== FILL_COLOR : id === STROKE_COLOR || id === FILL_COLOR || id > TRIM_OFFSET)
      throw new Error(`Invalid property id: ${id} for animation`);
    this.set(id, v);
  }
  override setData(d: PathData): void { super.setData(d); this.trimDirty = true; }
  /** FullPath::getUpdatedPath: the path trimmed to [start, end) shifted by offset, as applyTrim
   *  measures it (SkPathMeasure without forceClosed: the first contour) */
  private updated(): NativePath {
    const p = this.props, dirty = this.pathDirty, path = this.built();
    const start = p[TRIM_START], end = p[TRIM_END];
    let out = path;
    if (start !== 0 || end !== 1) {
      if (this.trimDirty || dirty) {
        const t = this.trimmed;
        t.reset();
        if (start !== end) {
          const m = new PathMeasure();
          m.setPath(path, false);
          const len = m.length();
          const s = len * (Math.fround(start + p[TRIM_OFFSET]) % 1), e = len * (Math.fround(end + p[TRIM_OFFSET]) % 1);
          if (s > e) {
            m.getSegment(s, len, t, true);
            if (e > 0) m.getSegment(0, e, t, true);
          } else m.getSegment(s, e, t, true);
        }
        this.trimDirty = false;
      }
      out = this.trimmed;
    }
    if (this.fillGradient || p[FILL_COLOR]) out.setFillType(p[FILL_TYPE]);
    return out;
  }
  /** FullPath::draw: the fill, then the stroke, each an anti-aliased paint (a gradient's black at the
   *  path's alpha through its shader, a colour at its own alpha) */
  draw(nc: NativeCanvas): void {
    const p = this.props, path = this.updated(), paint = pathPaint;
    if (this.fillGradient || p[FILL_COLOR]) {
      paint.style = 0;
      paint.shader = this.fillGradient;
      paint.color = applyAlpha(this.fillGradient ? -16777216 : p[FILL_COLOR], p[FILL_ALPHA]);
      drawPath(nc, path, paint);
    }
    if (this.strokeGradient || p[STROKE_COLOR]) {
      paint.style = 1;
      paint.shader = this.strokeGradient;
      paint.color = applyAlpha(this.strokeGradient ? -16777216 : p[STROKE_COLOR], p[STROKE_ALPHA]);
      paint.strokeWidth = p[STROKE_WIDTH]; paint.strokeMiter = p[MITER];
      paint.strokeCapN = CAPS[p[CAP]] ?? "butt"; paint.strokeJoinN = JOINS[p[JOIN]] ?? "miter";
      drawPath(nc, path, paint);
    }
  }
}
const pathPaint = new NativePaint();

/** Tree::MAX_CACHED_BITMAP_SIZE */
const MAX_CACHE = 2048;
export class Tree {
  readonly root: Group;
  vpW = 0; vpH = 0;
  alpha = 1;
  dirty = true;
  private cache: NativeBitmap | null = null;
  /** the canvas the tree paints its cache through, and the paint the cache is drawn with */
  private canvas: NativeCanvas | null = null;
  private readonly paint = new NativePaint();
  constructor(root: Group) { this.root = root; root.adopt(this); }
  /** Tree::draw: the canvas's scale sizes the cache (no skew or rotation), which is drawn at the
   *  bounds, mirrored for RTL, through the colour filter at the root alpha; answers the cache's
   *  pixel count */
  draw(cv: NativeCanvas, filter: NativeColorFilter | null, l: number, t: number, r: number, b: number, mirror: boolean, canReuse: boolean): number {
    const ctx = cv.ctx, m = ctx.getTransform(), w = r - l, h = b - t;
    const plain = m.b === 0 && m.c === 0;
    const sw = Math.min(MAX_CACHE, Math.trunc(w * (plain ? Math.abs(m.a) : 1)));
    const sh = Math.min(MAX_CACHE, Math.trunc(h * (plain ? Math.abs(m.d) : 1)));
    if (sw <= 0 || sh <= 0) return 0;
    if (!canReuse) this.dirty = true;
    let cache = this.cache;
    if (!cache || cache.w !== sw || cache.h !== sh) { this.cache = cache = new NativeBitmap(sw, sh); this.dirty = true; }
    if (this.dirty) {
      const nc = this.canvas ??= new NativeCanvas(), c = cache.ctx;
      nc.setTarget(c, sw, sh, null);
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, sw, sh);
      c.scale(sw / this.vpW, sh / this.vpH);
      this.root.draw(nc);
      this.dirty = false;
    }
    const paint = this.paint;
    paint.setAlpha(Math.trunc(this.alpha * 255));
    paint.colorFilter = filter;
    ctx.save();
    try {
      ctx.translate(l, t);
      if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
      drawBitmap(cv, cache, paint, 0, 0, w, h);
    } finally { ctx.restore(); }
    return sw * sh;
  }
}

// A node lives while a tree holds it: its handle is weak, and one not yet in a tree is kept here.
const unattached = new Set<Node>();
function created(n: Node): bigint { unattached.add(n); return weakHandle(n); }
export const node = <T extends Node>(h: bigint): T => deref<T>(h);
const group = (h: bigint) => node<Group>(h), full = (h: bigint) => node<FullPath>(h), tree = (h: bigint) => deref<Tree>(h);
function copyNode<T extends VPath>(n: T, from: T): bigint {
  n.name = from.name; n.data.copy(from.data);
  return created(n);
}
/** a tree's native state goes with its last strong reference (VirtualRefBasePtr) */
function newTree(t: Tree): bigint { unattached.delete(t.root); return ownedHandle(t); }

const pathProperty = (id: number) => ({
  [`nGet${PATH_PROPERTY_NAMES[id]}(J)${INT_FIELD[id] ? "I" : "F"}`]: (h: bigint) => full(h).props[id],
  [`nSet${PATH_PROPERTY_NAMES[id]}(J${INT_FIELD[id] ? "I" : "F"})V`]: (h: bigint, v: number) => full(h).set(id, v),
});
const PATH_PROPERTY_NAMES = ["StrokeWidth", "StrokeColor", "StrokeAlpha", "FillColor", "FillAlpha", "TrimPathStart", "TrimPathEnd", "TrimPathOffset"];
const groupProperty = (id: number, name: string) => ({
  [`nGet${name}(J)F`]: (h: bigint) => group(h).props[id],
  [`nSet${name}(JF)V`]: (h: bigint, v: number) => group(h).set(id, v),
});
rt.registerJnis("android/graphics/drawable/VectorDrawable", {
  "nCreateTree(J)J": (root: bigint) => newTree(new Tree(group(root))),
  "nCreateTreeFromCopy(JJ)J": (from: bigint, root: bigint) => {
    const src = tree(from), t = new Tree(group(root));
    t.vpW = src.vpW; t.vpH = src.vpH; t.alpha = src.alpha;
    return newTree(t);
  },
  "nSetRendererViewportSize(JFF)V": (h: bigint, w: number, hgt: number) => {
    const t = tree(h);
    if (t.vpW !== w || t.vpH !== hgt) { t.vpW = w; t.vpH = hgt; t.dirty = true; }
  },
  "nSetRootAlpha(JF)Z": (h: bigint, a: number) => { const t = tree(h); if (t.alpha === a) return 0; t.alpha = a; return 1; },
  "nGetRootAlpha(J)F": (h: bigint) => tree(h).alpha,
  // a Canvas2D path is always drawn anti-aliased
  "nSetAntiAlias(JZ)V": () => {},
  // the cache is what the software canvas draws from whatever this says
  "nSetAllowCaching(JZ)V": () => {},
  "nDraw(JJJLandroid/graphics/Rect;ZZ)I": (h: bigint, canvas: bigint, filter: bigint, rect: object, mirror: number, reuse: number) => {
    const r = edges(rect);
    return tree(h).draw(drawingCanvas(canvas), filter ? deref<NativeColorFilter>(filter) : null, r.left, r.top, r.right, r.bottom, !!mirror, !!reuse);
  },

  "nCreateFullPath()J": () => created(new FullPath()),
  "nCreateFullPath(J)J": (h: bigint) => {
    const from = full(h), n = new FullPath();
    n.props.splice(0, FULL_PATH_FIELDS, ...from.props);
    n.fillGradient = from.fillGradient; n.strokeGradient = from.strokeGradient;
    return copyNode(n, from);
  },
  "nCreateClipPath()J": () => created(new ClipPath()),
  "nCreateClipPath(J)J": (h: bigint) => copyNode(new ClipPath(), node<ClipPath>(h)),
  "nCreateGroup()J": () => created(new Group()),
  "nCreateGroup(J)J": (h: bigint) => { const from = group(h), g = new Group(); g.name = from.name; g.props.set(from.props); return created(g); },
  "nSetName(JLjava/lang/String;)V": (h: bigint, name: string) => { node(h).name = name; },
  "nAddChild(JJ)V": (g: bigint, c: bigint) => {
    const parent = group(g), child = node(c);
    parent.children.push(child);
    unattached.delete(child);
    if (parent.tree) { child.adopt(parent.tree); parent.changed(); }
  },
  "nSetPathString(JLjava/lang/String;I)V": (h: bigint, s: string, len: number) => {
    // setPathString stores what parsed before the exception it raises reaches Java
    const d = new PathData(), error = parsePathData(d, s, len);
    node<VPath>(h).setData(d);
    throwParseFailure(error);
  },
  "nSetPathData(JJ)V": (h: bigint, d: bigint) => node<VPath>(h).setData(deref<PathData>(d)),
  "nGetFullPathProperties(J[BI)Z": (h: bigint, out: Int8Array, len: number) => {
    if (len !== FULL_PATH_FIELDS * 4) throw new Error(`Properties needs exactly ${FULL_PATH_FIELDS * 4} bytes, a byte array of size ${len} is provided`);
    const view = new DataView(out.buffer, out.byteOffset, len), p = full(h).props;
    for (let i = 0; i < FULL_PATH_FIELDS; i++) {
      if (INT_FIELD[i]) view.setInt32(i * 4, p[i], true); else view.setFloat32(i * 4, p[i], true);
    }
    return 1;
  },
  "nUpdateFullPathProperties(JFIFIFFFFFIII)V": (h: bigint, ...values: number[]) => {
    // the arguments' order: miter limit comes before cap and join, unlike the fields
    const n = full(h), [sw, sc, sa, fc, fa, ts, te, to, miter, cap, join, fillType] = values;
    const order = [sw, sc, sa, fc, fa, ts, te, to, cap, join, miter, fillType];
    for (let i = 0; i < FULL_PATH_FIELDS; i++) n.set(i, order[i]);
  },
  "nUpdateFullPathFillGradient(JJ)V": (h: bigint, s: bigint) => { const n = full(h); n.fillGradient = s ? deref<NativeShader>(s) : null; n.changed(); },
  "nUpdateFullPathStrokeGradient(JJ)V": (h: bigint, s: bigint) => { const n = full(h); n.strokeGradient = s ? deref<NativeShader>(s) : null; n.changed(); },
  ...Object.assign({}, ...PATH_PROPERTY_NAMES.map((_, id) => pathProperty(id))),
  "nGetGroupProperties(J[FI)Z": (h: bigint, out: Float32Array, len: number) => {
    if (len !== 7) throw new Error(`Properties needs exactly 7 bytes, a float array of size ${len} is provided`);
    out.set(group(h).props);
    return 1;
  },
  "nUpdateGroupProperties(JFFFFFFF)V": (h: bigint, ...values: number[]) => { const g = group(h); values.forEach((v, i) => g.set(i, v)); },
  ...groupProperty(ROTATE, "Rotation"), ...groupProperty(PIVOT_X, "PivotX"), ...groupProperty(PIVOT_Y, "PivotY"),
  ...groupProperty(SCALE_X, "ScaleX"), ...groupProperty(SCALE_Y, "ScaleY"),
  ...groupProperty(TRANSLATE_X, "TranslateX"), ...groupProperty(TRANSLATE_Y, "TranslateY"),
});
