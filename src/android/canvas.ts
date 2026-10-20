// hwui's SkiaCanvas over an HTML Canvas 2D context: the native half of android.graphics.Canvas,
// whose Java runs from AOSP bytecode — the device's matrix, clips, saves and layers, and how a
// paint is applied to a draw. The draws themselves are canvas-draw.ts. A Java canvas holds a
// handle to a NativeCanvas in mNativeCanvasWrapper, and TS reaches it through canvasOf.

import { isRecording, nestedRecording, recordOrRun, replay, replayFor, transformOf, type Ctx2D, type DisplayList, Recorder } from "./recording.ts";
import { tryBitmapShape, tryPartialSourceIn } from "./bitmap-raster.ts";
import { rt, type JObj, peerField, setDeclared } from "../jvm/runtime.ts";
import { after, newObj, scall } from "../jvm/natives/jentry.ts";
import { handle, deref, release, ownedHandle, FINALIZER } from "./handles.ts";
import { NativePath, inversePath, pathAt } from "./path.ts";
import { type NativeBitmap, bitmapAt } from "./bitmap.ts";
import { BlurMask } from "./maskfilter.ts";
import { strokeRec } from "./patheffect.ts";
import { NativePaint, copyPaint, beginPaintShadow } from "./paint.ts";
import { setEdges, emptyBox, type Box, type NativeColorFilter, NativeBitmapShader, PLANE, canvasLocalBounds, shaderIdentity, recolor } from "./graphics.ts";
import { type Affine, setAffine, applyMatrix, matrixAt, deviceScale, deviceBounds, localBounds } from "./matrix.ts";

/** the Java canvases TS hands framework and app code: a Canvas or RecordingCanvas peer */
export type JavaCanvas = JObj;
type LayerStyle = { alpha: number; blend: GlobalCompositeOperation | null; filter: NativeColorFilter | null };
/** an open layer: the save count its restore closes, the context drawn into before it, and the close */
type Layer = { count: number; parent: Ctx2D; close: () => void; behind?: Behind };
/** what a save-behind set aside: the target's pixels under its bounds, in device space */
type Behind = { image: OffscreenCanvas | null; x: number; y: number };

/** setLineDash copies its argument, so every undashed stroke can pass the same empty list */
const NO_DASH: number[] = [];
/** SkCanvas::SaveFlags: Matrix and Clip */
const MATRIX_CLIP = 3;
/** the context's transform as SkMatrix holds it, in floats */
const skMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** SkiaCanvas: a 2D context and the state Canvas2D does not expose — the save count, the device
 *  clip bounds, open layers */
export class NativeCanvas {
  ctx!: Ctx2D;
  w = 0; h = 0;
  bmp: NativeBitmap | null = null;
  /** a RenderNode's RecordingCanvas: what it records into, its node taking each finished list */
  recorder: Recorder | null = null;
  saveCount = 1;
  layers: Layer[] | null = null;
  /** the device clip's bounds, which SkCanvas::getDeviceClipBounds reports */
  cl = 0; ct = 0; cr = 0; cb = 0;
  /** the device outline of a clip narrowed by a rotated or skewed rect (x, y pairs); cl..cb bound it */
  poly: number[] | null = null;
  /** per open save: its clip bounds, outline and SkCanvas save flags */
  private clips: number[] = [];
  private polys: (number[] | null)[] = [];
  private flags: number[] = [];
  /** clips made while a save that does not restore the clip is open, re-applied by its restore */
  private persistent: { count: number; m: DOMMatrix; apply: (ctx: Ctx2D) => void }[] | null = null;
  /** PaintFlagsDrawFilter: the paint flags every draw clears and sets */
  filter: { clear: number; set: number } | null = null;
  private filtered: NativePaint | null = null;

  static over(ctx: Ctx2D, w = ctx.canvas.width, h = ctx.canvas.height, bmp: NativeBitmap | null = null): NativeCanvas {
    const nc = new NativeCanvas();
    nc.setTarget(ctx, w, h, bmp);
    return nc;
  }
  /** SkiaCanvas::setBitmap: a fresh device, its matrix identity and its clip the whole target */
  setTarget(ctx: Ctx2D, w: number, h: number, bmp: NativeBitmap | null) {
    this.ctx = ctx; this.w = w; this.h = h; this.bmp = bmp;
    this.saveCount = 1; this.layers = null; this.persistent = null;
    this.clips.length = this.polys.length = this.flags.length = 0;
    this.cl = this.ct = 0; this.cr = w; this.cb = h; this.poly = null;
  }
  /** a Canvas.drawXxx paint through the canvas's draw filter */
  paint(h: bigint): NativePaint {
    const p = deref<NativePaint>(h), f = this.filter;
    if (!f) return p;
    const out = this.filtered ??= new NativePaint();
    copyPaint(p, out);
    out.flags = (p.flags & ~f.clear) | f.set;
    return out;
  }

  prep(p: NativePaint, stroke: boolean) {
    const ctx = this.ctx, shader = p.shader, replayed = shader?.atReplay ? shader : null;
    if (replayed) recordOrRun(ctx, c => { c[stroke ? "strokeStyle" : "fillStyle"] = replayed.pattern(c)!; });
    if (stroke) {
      if (!replayed) ctx.strokeStyle = p.fillStyle(ctx);
      ctx.lineWidth = Math.max(p.strokeWidth, 1);
      ctx.lineCap = p.strokeCapN;
      ctx.lineJoin = p.strokeJoinN;
      // Skia dashes a stroke only, not a stroke-and-fill
      if (p.dash && p.style === 1) { ctx.setLineDash(p.dash); ctx.lineDashOffset = p.dashPhase; } else ctx.setLineDash(NO_DASH);
    } else {
      if (!replayed) ctx.fillStyle = p.fillStyle(ctx);
    }
    if (p.blendName === "CLEAR") ctx[stroke ? "strokeStyle" : "fillStyle"] = "#000";
    return !!replayed || typeof CanvasPattern !== "undefined" && ctx[stroke ? "strokeStyle" : "fillStyle"] instanceof CanvasPattern;
  }
  private blurLayer: { source: NativeCanvas; target: OffscreenCanvasRenderingContext2D; paint: NativePaint } | null = null;
  drawMask(p: NativePaint, fill: (ctx: Ctx2D) => void, stroke?: (ctx: Ctx2D) => void) {
    const ctx = this.ctx, w = ctx.canvas.width, h = ctx.canvas.height, m = ctx.getTransform();
    const scale = deviceScale(m);
    if (!w || !h || !scale) return;
    let layer = this.blurLayer;
    if (!layer || layer.source.w !== w || layer.source.h !== h) {
      const source = new OffscreenCanvas(w, h).getContext("2d")!;
      layer = this.blurLayer = { source: NativeCanvas.over(source, w, h), target: new OffscreenCanvas(w, h).getContext("2d")!, paint: new NativePaint() };
    }
    const source = layer.source.ctx, target = layer.target;
    source.resetTransform(); source.clearRect(0, 0, w, h); source.setTransform(m);
    copyPaint(p, layer.paint);
    layer.paint.maskFilter = null; layer.paint.blend = null; layer.paint.shadowRadius = 0;
    layer.paint.color = -1; layer.paint.shader = null; layer.paint.colorFilter = null;
    if (stroke) layer.source.drawShape(layer.paint, fill, stroke);
    else fill(source);
    target.clearRect(0, 0, w, h);
    const mf = p.maskFilter;
    if (mf) mf.apply(target, source.canvas, 0, 0, scale, p.filteredColor());
    else target.drawImage(source.canvas, 0, 0);
    target.globalCompositeOperation = "source-in";
    try {
      if (mf?.colored) { /* the filter coloured the shape itself */ }
      else if (p.shader) {
        source.resetTransform(); source.clearRect(0, 0, w, h); source.setTransform(m);
        copyPaint(p, layer.paint);
        layer.paint.maskFilter = null; layer.paint.blend = null; layer.paint.shadowRadius = 0; layer.paint.style = 0;
        // `scale` is non-zero, so the transform inverts and the bounds exist
        const [left, top, right, bottom] = canvasLocalBounds(source)!;
        layer.source.drawShape(layer.paint, c => c.fillRect(left, top, right - left, bottom - top), () => {});
        target.drawImage(source.canvas, 0, 0);
      } else {
        target.fillStyle = p.fillStyle(target);
        target.fillRect(0, 0, w, h);
      }
    } finally { target.globalCompositeOperation = "source-over"; }
    ctx.save();
    const shadow = beginPaintShadow(ctx, p);
    try {
      if (p.blend) ctx.globalCompositeOperation = p.blend;
      ctx.resetTransform(); ctx.drawImage(target.canvas, 0, 0);
    } finally { if (shadow) ctx.restore(); ctx.restore(); }
  }
  /** a shape drawn with the paint; `geom` gives it as a path, for a path effect to change */
  drawShape(p: NativePaint, fill: (ctx: Ctx2D) => void, stroke: (ctx: Ctx2D) => void, geom?: () => NativePath) {
    if (p.pathEffect && !p.dash && geom) return this.drawEffected(p, geom());
    if (tryPartialSourceIn(this, p, fill, stroke)) return;
    if (tryBitmapShape(this, p, fill, stroke)) return;
    const mf = p.maskFilter, blur = mf instanceof BlurMask && mf.style === 0 ? mf : null;
    if (mf && !blur) return this.drawMask(p, fill, stroke);
    if (p.transparentSourceIn() && !p.maskFilter && !p.shadowRadius) {
      const ctx = this.ctx;
      ctx.save();
      try {
        ctx.globalCompositeOperation = "destination-out";
        if (p.style !== 1) { this.prep(p, false); ctx.fillStyle = "#000"; fill(ctx); }
        if (p.style !== 0 && (p.style !== 2 || p.strokeWidth !== 0)) {
          this.prep(p, true); ctx.strokeStyle = "#000"; stroke(ctx);
        }
      } finally { ctx.restore(); }
      return;
    }
    // A blended paint owns the composite op only for its own ops — restore it straight after,
    // so a CLEAR fill can never leak into the next drawImage/drawText and erase it.
    const shaded = beginShaderAlpha(this.ctx, p), shadow = beginPaintShadow(this.ctx, p);
    const blend = p.compositeOp();
    const prev = blend ? this.ctx.globalCompositeOperation : null;
    const filter = blur ? this.ctx.filter : null;
    if (blur) this.ctx.filter = `blur(${blur.sigma * deviceScale(transformOf(this.ctx))}px)`;
    try {
      if (blend) this.ctx.globalCompositeOperation = blend;
      if (p.style === 0 || p.style === 2) {
        const shader = p.shader, lm = shader?.local;
        if (shader instanceof NativeBitmapShader) fill(this.shaderClipCtx(lm ?? shaderIdentity, shader));
        else {
          const pattern = this.prep(p, false);
          // a gradient with a local matrix: Canvas2D gradients have no transform of their own, so
          // clip to the shape and fill the plane under the matrix instead
          fill(lm && !pattern ? this.shaderClipCtx(lm) : this.ctx);
        }
      }
      if (p.style === 1 || (p.style === 2 && p.strokeWidth !== 0)) { this.prep(p, true); stroke(this.ctx); }
    } finally {
      if (prev) this.ctx.globalCompositeOperation = prev;
      if (filter !== null) this.ctx.filter = filter;
      if (shadow) this.ctx.restore();
      if (shaded) endAlpha(this.ctx);
    }
  }
  private effected: NativePaint | null = null;
  /** SkCanvas::drawPath through a path effect other than a lone dash: the geometry it makes, filled
   *  when the effect makes a fill (PathDashPathEffect), else drawn as the paint draws */
  private drawEffected(p: NativePaint, src: NativePath) {
    const rec = strokeRec(p), dst = new NativePath(), q = this.effected ??= new NativePaint();
    const path = p.pathEffect!.filter(dst, src, rec) ? dst : src;
    copyPaint(p, q); q.setPathEffect(null);
    if (rec.fill) q.style = 0;
    this.drawShape(q, (c) => c.fill(path.path(), path.fillRule), (c) => c.stroke(path.path()));
  }
  /** SkCanvas::drawPaint: the paint over the whole clip */
  drawPaint(paint: NativePaint) {
    const bounds = canvasLocalBounds(this.ctx);
    if (!bounds) return;
    const [l, t, r, b] = bounds;
    copyPaint(paint, paintScratch); paintScratch.style = 0; paintScratch.maskFilter = null;
    this.drawShape(paintScratch, c => c.fillRect(l, t, r - l, b - t), () => {});
  }
  private shaderCtx: Ctx2D | null = null;
  private shaderBaseCtx: Ctx2D | null = null;
  private shaderCtxLm: number[] | null = null;
  private bitmapShader: NativeBitmapShader | undefined;
  shaderClipCtx(lm: Affine, bitmap?: NativeBitmapShader): Ctx2D {
    const ctx = this.ctx;
    const under = (clip: (c: typeof ctx) => void) => {
      ctx.save();
      clip(ctx);
      ctx.transform(lm[0], lm[1], lm[2], lm[3], lm[4], lm[5]);
      if (bitmap) bitmap.draw(ctx);
      else ctx.fillRect(-PLANE, -PLANE, 2 * PLANE, 2 * PLANE);
      ctx.restore();
    };
    if (!this.shaderCtx || this.shaderBaseCtx !== ctx || this.shaderCtxLm !== lm || this.bitmapShader !== bitmap) {
      this.shaderBaseCtx = ctx;
      this.shaderCtxLm = lm;
      this.bitmapShader = bitmap;
      const over: Record<string, unknown> = {
        fill: (a?: Path2D | CanvasFillRule, b?: CanvasFillRule) => under((c) => { if (a instanceof Path2D) c.clip(a, b); else c.clip(a); }),
        fillRect: (x: number, y: number, w: number, h: number) => under((c) => { c.beginPath(); c.rect(x, y, w, h); c.clip(); }),
      };
      // every other member goes to the real context with the real receiver (a 2D context's
      // methods throw on any other `this`)
      this.shaderCtx = new Proxy(ctx, {
        get: (t, k) => {
          if (k in over) return over[k as string];
          const v = Reflect.get(t, k, t);
          return typeof v === "function" ? v.bind(t) : v;
        },
        set: (t, k, v) => Reflect.set(t, k, v, t),
      });
    }
    return this.shaderCtx!;
  }

  // ── save and restore (SkiaCanvas, with its partial saves) ──
  /** SkiaCanvas::save: the count before the save; a save without the clip flag keeps the clips
   *  made under it, one without the matrix flag keeps the matrix (SkiaCanvas::recordPartialSave) */
  save(flags = MATRIX_CLIP): number {
    this.ctx.save();
    this.clips.push(this.cl, this.ct, this.cr, this.cb);
    this.polys.push(this.poly);
    flags &= MATRIX_CLIP;
    this.flags.push(flags);
    if (!(flags & 2)) this.persistent ??= [];
    return this.saveCount++;
  }
  restore(): void {
    const layer = this.layers?.at(-1);
    if (layer?.count === this.saveCount - 1) {
      this.layers!.pop();
      this.ctx = layer.parent;
      layer.close();
      this.bmp?.wrote();
    }
    const flags = this.flags.pop()!, count = this.saveCount - 1;
    const m = flags & 1 ? null : this.ctx.getTransform();
    this.ctx.restore();
    if (m) this.ctx.setTransform(m);
    this.saveCount = count;
    if (flags & 2) {
      this.cb = this.clips.pop()!; this.cr = this.clips.pop()!; this.ct = this.clips.pop()!; this.cl = this.clips.pop()!;
      this.poly = this.polys.pop()!;
      if (this.persistent) this.persistent = this.persistent.filter((c) => c.count < count);
    } else {
      // the clip stays as it is, and so must the Canvas2D clip: every clip made since, again, now
      // belonging to the save around this one
      this.clips.length -= 4; this.polys.pop();
      const current = this.ctx.getTransform();
      for (const c of this.persistent!) if (c.count >= count) { this.ctx.setTransform(c.m); c.apply(this.ctx); c.count = count - 1; }
      this.ctx.setTransform(current);
    }
    if (this.persistent && this.flags.every((f) => f & 2)) this.persistent = null;
  }
  /** SkCanvas::restoreToCount: counts below 1 restore everything */
  restoreToCount(count: number): void {
    while (this.saveCount > Math.max(count, 1)) this.restore();
  }

  // ── clip bounds (the device clip is SkRasterClip's; Canvas2D's clip itself cannot be read) ──
  get clipEmpty() { return !(this.cr > this.cl && this.cb > this.ct); }
  private setClipEmpty() { this.cl = this.ct = this.cr = this.cb = 0; this.poly = null; }
  /** a clip made under a save that keeps it: remembered, so that save's restore makes it again */
  private persist(apply: (ctx: Ctx2D) => void) {
    if (this.persistent) this.persistent.push({ count: this.saveCount - 1, m: this.ctx.getTransform(), apply });
  }
  /** intersect with (l, t, r, b) under the matrix, clipped by the context too; false once empty */
  clipRect(l: number, t: number, r: number, b: number): boolean {
    const ctx = this.ctx, m = transformOf(ctx);
    if (l > r) { const x = l; l = r; r = x; }
    if (t > b) { const y = t; t = b; b = y; }
    if (r === l || b === t || !(m.a * m.d - m.b * m.c)) {
      this.setClipEmpty();
      clipNothing(ctx);
      this.persist(clipNothing);
      return false;
    }
    ctx.beginPath();
    ctx.rect(l, t, r - l, b - t);
    ctx.clip();
    if (this.persistent) this.persist((c) => { c.beginPath(); c.rect(l, t, r - l, b - t); c.clip(); });
    if (this.clipEmpty) return false;
    if (m.b === 0 && m.c === 0 && !this.poly) {
      // an axis-aligned rect: a hard edge, rounded to pixels as SkRect::round does
      const d = deviceBounds(m, l, t, r, b);
      this.narrow(Math.round(d[0]), Math.round(d[1]), Math.round(d[2]), Math.round(d[3]));
      return !this.clipEmpty;
    }
    const pts = [l, t, r, t, r, b, l, b];
    for (let i = 0; i < 8; i += 2) { const x = pts[i], y = pts[i + 1]; pts[i] = m.a * x + m.c * y + m.e; pts[i + 1] = m.b * x + m.d * y + m.f; }
    this.poly = intersectClip(this.poly ?? [this.cl, this.ct, this.cr, this.ct, this.cr, this.cb, this.cl, this.cb], pts);
    this.boundPoly();
    return !this.clipEmpty;
  }
  /** intersect the bounds with a device rect */
  private narrow(l: number, t: number, r: number, b: number) {
    this.cl = Math.max(this.cl, l); this.ct = Math.max(this.ct, t);
    this.cr = Math.min(this.cr, r); this.cb = Math.min(this.cb, b);
    if (this.clipEmpty) this.setClipEmpty();
  }
  /** the pixels whose centres the device outline covers, as a hard-edged clip's are */
  private boundPoly() {
    const poly = this.poly!;
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < poly.length; i += 2) { minY = Math.min(minY, poly[i]); maxY = Math.max(maxY, poly[i]); }
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (let y = Math.max(this.ct, Math.floor(minY)), end = Math.min(this.cb, Math.ceil(maxY)); y < end; y++) {
      const at = y + 0.5;
      let minX = Infinity, maxX = -Infinity;
      for (let i = 0; i < poly.length; i += 2) {
        const ax = poly[i], ay = poly[i + 1], j = (i + 2) % poly.length, bx = poly[j], by = poly[j + 1];
        if ((ay <= at && at < by) || (by <= at && at < ay)) {
          const x = ax + (at - ay) * (bx - ax) / (by - ay);
          minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        }
      }
      if (minX === maxX || !Number.isFinite(minX)) continue;
      const x0 = Math.max(this.cl, Math.floor(minX - 0.5) + 1), x1 = Math.min(this.cr, Math.ceil(maxX - 0.5));
      if (x0 >= x1) continue;
      left = Math.min(left, x0); right = Math.max(right, x1);
      top = Math.min(top, y); bottom = Math.max(bottom, y + 1);
    }
    if (right > left && bottom > top) { this.cl = left; this.ct = top; this.cr = right; this.cb = bottom; }
    else this.setClipEmpty();
  }
  /** take (l, t, r, b) out of the clip: SkRegion's difference, whose bounds shrink only when the
   *  rect cuts the whole of an axis-aligned clip's side */
  clipOutRect(l: number, t: number, r: number, b: number): boolean {
    if (l > r) { const x = l; l = r; r = x; }
    if (t > b) { const y = t; t = b; b = y; }
    if (!(r > l && b > t)) return !this.clipEmpty;
    const excluded = new Path2D();
    excluded.rect(l, t, r - l, b - t);
    const apply = (ctx: Ctx2D) => {
      const matrix = ctx.getTransform(), inverse = new Path2D();
      inverse.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
      inverse.addPath(excluded, matrix);
      ctx.resetTransform();
      try { ctx.clip(inverse, "evenodd"); }
      finally { ctx.setTransform(matrix); }
    };
    // RenderNode replay supplies the parent transform and the actual destination bounds.
    recordOrRun(this.ctx, apply);
    this.persist(apply);
    const m = transformOf(this.ctx);
    if (this.clipEmpty || !(m.a * m.d - m.b * m.c)) return !this.clipEmpty;
    const d = deviceBounds(m, l, t, r, b), x0 = Math.round(d[0]), y0 = Math.round(d[1]), x1 = Math.round(d[2]), y1 = Math.round(d[3]);
    const exact = m.b === 0 && m.c === 0;
    if (x0 <= this.cl && x1 >= this.cr && y0 <= this.ct && y1 >= this.cb && (exact || !this.poly)) this.setClipEmpty();
    else if (exact && !this.poly) {
      if (x0 <= this.cl && x1 >= this.cr) {
        // a horizontal band: what is left is above and below it
        if (y0 <= this.ct) this.ct = Math.max(this.ct, y1);
        else if (y1 >= this.cb) this.cb = Math.min(this.cb, y0);
      } else if (y0 <= this.ct && y1 >= this.cb) {
        if (x0 <= this.cl) this.cl = Math.max(this.cl, x1);
        else if (x1 >= this.cr) this.cr = Math.min(this.cr, x0);
      }
    }
    return !this.clipEmpty;
  }
  /** SkCanvas::clipPath: intersect (anti-aliased, so the bounds round out) or take the path out */
  clipPath(path: NativePath, out: boolean): boolean | Promise<boolean> {
    if (path.inverseFill === out) {
      this.clipTo(path.path(), path.fillRule);
      if (!out) { const b = path.bounds(); this.narrowOut(b.left, b.top, b.right, b.bottom); }
      return !this.clipEmpty;
    }
    const bounds = canvasLocalBounds(this.ctx);
    if (!bounds) return !this.clipEmpty;
    return after(inversePath(path, bounds[0], bounds[1], bounds[2], bounds[3]), ([inverse, rule]) => { this.clipTo(inverse, rule); return !this.clipEmpty; });
  }
  private clipTo(shape: Path2D, rule: CanvasFillRule) {
    const apply = (c: Ctx2D) => c.clip(shape, rule);
    apply(this.ctx);
    this.persist(apply);
  }
  /** intersect the bounds with an anti-aliased clip's local bounds, rounded out */
  private narrowOut(l: number, t: number, r: number, b: number) {
    if (this.clipEmpty) return;
    const m = transformOf(this.ctx);
    if (!(m.a * m.d - m.b * m.c)) { this.setClipEmpty(); return; }
    const d = deviceBounds(m, l, t, r, b);
    this.narrow(Math.floor(d[0]), Math.floor(d[1]), Math.ceil(d[2]), Math.ceil(d[3]));
  }
  /** SkCanvas::quickReject: whether the rect under the matrix misses the device clip's bounds,
   *  outset a pixel for anti-aliasing */
  quickReject(l: number, t: number, r: number, b: number): boolean {
    if (this.clipEmpty) return true;
    const d = deviceBounds(transformOf(this.ctx), l, t, r, b);
    if (!(Number.isFinite(d[0]) && Number.isFinite(d[1]) && Number.isFinite(d[2]) && Number.isFinite(d[3]))) return true;
    return !(Math.max(d[0], this.cl - 1) < Math.min(d[2], this.cr + 1) && Math.max(d[1], this.ct - 1) < Math.min(d[3], this.cb + 1));
  }
  /** SkiaCanvas::getClipBounds: the device clip's bounds in local coordinates, under SkMatrix's float inverse, rounded */
  clipBounds(): Box | null {
    if (this.clipEmpty) return null;
    const m = transformOf(this.ctx), f = Math.fround;
    skMatrix.a = f(m.a); skMatrix.b = f(m.b); skMatrix.c = f(m.c); skMatrix.d = f(m.d); skMatrix.e = f(m.e); skMatrix.f = f(m.f);
    const d = localBounds(skMatrix, this.cr - this.cl, this.cb - this.ct, this.cl, this.ct);
    return d && { left: Math.round(d[0]), top: Math.round(d[1]), right: Math.round(d[2]), bottom: Math.round(d[3]) };
  }
  /** a layer confines what is drawn in it to its device bounds, rounded out */
  clipToLayer(bounds: Box | null) {
    if (!bounds) return;
    const d = deviceBounds(transformOf(this.ctx), bounds.left, bounds.top, bounds.right, bounds.bottom);
    this.narrow(Math.floor(d[0]), Math.floor(d[1]), Math.ceil(d[2]), Math.ceil(d[3]));
  }
}
const paintScratch = new NativePaint();
/** clip everything away: the context's clip only narrows, so it is intersected with a pixel off the target */
function clipNothing(ctx: Ctx2D) {
  const m = ctx.getTransform();
  ctx.resetTransform();
  ctx.beginPath();
  ctx.rect(ctx.canvas.width + 1, ctx.canvas.height + 1, 1, 1);
  ctx.clip();
  ctx.setTransform(m);
}
/** Sutherland-Hodgman: the convex `subject` outline clipped by the convex `shape` (flat x, y pairs) */
function intersectClip(subject: number[], shape: number[]): number[] {
  let area = 0;
  for (let i = 0; i < shape.length; i += 2) { const j = (i + 2) % shape.length; area += shape[i] * shape[j + 1] - shape[j] * shape[i + 1]; }
  const orientation = Math.sign(area);
  if (!orientation) return [];
  let out = subject;
  for (let i = 0; i < shape.length && out.length; i += 2) {
    const j = (i + 2) % shape.length, ax = shape[i], ay = shape[i + 1], bx = shape[j], by = shape[j + 1];
    const side = (x: number, y: number) => orientation * ((bx - ax) * (y - ay) - (by - ay) * (x - ax));
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k += 2) {
      const p = (k + input.length - 2) % input.length, px = input[p], py = input[p + 1], cx = input[k], cy = input[k + 1];
      const before = side(px, py), after = side(cx, cy);
      if ((before < 0) !== (after < 0)) {
        const u = before / (before - after);
        out.push(px + u * (cx - px), py + u * (cy - py));
      }
      if (after >= 0) out.push(cx, cy);
    }
  }
  return out;
}
// ── the Java side: one bridge, and the peers TS makes ──
const CANVAS = "android/graphics/Canvas", wrapper = peerField<bigint>(CANVAS, "mNativeCanvasWrapper");
/** the native state behind a Java canvas, which TS takes to draw through */
export const canvasOf = (c: object): NativeCanvas => drawingCanvas(wrapper(c));
const peers = new FinalizationRegistry<bigint>(release);
/** A Java Canvas drawing straight into `ctx`: AOSP's Canvas over a native canvas, or when `accelerated` a RecordingCanvas of its size (what a hardware window hands
 *  its views) whose native canvas is that one */
export async function canvasOver(ctx: Ctx2D, w: number, h: number, accelerated = false): Promise<JavaCanvas> {
  const ptr = handle(NativeCanvas.over(ctx, w, h));
  if (!accelerated) return newObj("android/graphics/Canvas", "(J)V", ptr);
  const c: JavaCanvas = await scall("android/graphics/RecordingCanvas", "obtain", "(Landroid/graphics/RenderNode;II)Landroid/graphics/RecordingCanvas;",
    await newObj("android/graphics/RenderNode", "(Ljava/lang/String;)V", null), w, h);
  release(wrapper(c));
  setDeclared(c, CANVAS, { mNativeCanvasWrapper: ptr });
  peers.register(c, ptr);
  return c;
}
export function clipRoundRect(ctx: Ctx2D, l: number, t: number, r: number, b: number, radius: number) {
  ctx.beginPath();
  if (radius > 0) ctx.roundRect(l, t, r - l, b - t, radius);
  else ctx.rect(l, t, r - l, b - t);
  ctx.clip();
}

// ── layers ──
type LayerRaster = { ctx: OffscreenCanvasRenderingContext2D; pool: OffscreenCanvas[]; x: number; y: number; w: number; h: number };
/** what a layer's paint (and an extra 0-255 `alpha`) does to its pixels when it is restored */
function layerStyle(paint: NativePaint | null, alpha = 255): LayerStyle {
  return {
    alpha: paint ? (paint.color >>> 24) * alpha / 255 : alpha,
    blend: paint?.compositeOp() ?? null, filter: paint?.colorFilter ?? null,
  };
}
// Free rasters, grown to the largest target they served: a layer opened every frame (Lottie
// masks and mattes) must not allocate every frame. A layer lives where its target does — CPU for
// a bitmap's canvas, GPU otherwise — or every restore is a GPU readback. A raster whose layer is
// abandoned (Canvas.setBitmap) is simply never returned.
const layerPools: [OffscreenCanvas[], OffscreenCanvas[]] = [[], []];
/** a cleared raster over the device bounds of `bounds` (the whole target when null), in the
 *  target's device space so every clip and fast path inside keeps its coordinates */
function openLayer(target: Ctx2D, bounds: Box | null, cpu: boolean): LayerRaster {
  const W = target.canvas.width, H = target.canvas.height, m = target.getTransform();
  let x0 = 0, y0 = 0, x1 = W, y1 = H;
  if (bounds) {
    const d = deviceBounds(m, bounds.left, bounds.top, bounds.right, bounds.bottom);
    x0 = Math.max(0, Math.floor(d[0])); y0 = Math.max(0, Math.floor(d[1]));
    x1 = Math.min(W, Math.ceil(d[2])); y1 = Math.min(H, Math.ceil(d[3]));
  }
  const pool = layerPools[+cpu], raster = pool.pop() ?? new OffscreenCanvas(W, H);
  if (raster.width < W) raster.width = W;
  if (raster.height < H) raster.height = H;
  const ctx = raster.getContext("2d", { willReadFrequently: cpu })!;
  ctx.save();
  ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
  ctx.setTransform(m);
  return { ctx, pool, x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
/** SkCanvas::restore of a layer: its pixels through the save-time paint, confined to its bounds
 *  (Canvas2D's destination-in and friends would otherwise clear the whole target) */
function closeLayer(target: Ctx2D, { ctx, pool, x, y, w, h }: LayerRaster, style: LayerStyle) {
  ctx.restore();
  pool.push(ctx.canvas); // nothing below opens a layer, so the raster is not reused before it is read
  if (w <= 0 || h <= 0) return;
  const filter = style.filter;
  if (filter) recolor(ctx, w, h, filter.color, filter.matrix, filter.mode, x, y);
  target.save();
  try {
    target.resetTransform();
    target.beginPath(); target.rect(x, y, w, h); target.clip();
    target.globalAlpha *= style.alpha / 255;
    if (style.blend) target.globalCompositeOperation = style.blend;
    target.drawImage(ctx.canvas, x, y, w, h, x, y, w, h);
  } finally { target.restore(); }
}
/** `ops` replayed through a layer over `bounds` of the real `target`, in the target's device space */
export function drawInLayer(target: Ctx2D, bounds: Box | null, style: LayerStyle, ops: DisplayList) {
  const layer = openLayer(target, bounds, false);
  try { replay(layer.ctx, ops); } finally { closeLayer(target, layer, style); }
}
/** Canvas.saveLayer: draws until the matching restore land in an offscreen raster, composited
 *  then with what the paint said when the layer was opened */
export function saveLayer(nc: NativeCanvas, bounds: Box | null, paint: NativePaint | null, alpha = 255): number {
  const style = layerStyle(paint, alpha);
  const count = nc.save(), parent = nc.ctx;
  let close: () => void;
  if (isRecording(parent)) {
    // a display list opens the layer where it is replayed, against that target's transform
    const ops: DisplayList = [];
    nc.ctx = nestedRecording(parent, ops);
    close = () => recordOrRun(parent, (target) => drawInLayer(target, bounds, style, ops));
  } else {
    const layer = openLayer(parent, bounds, !!nc.bmp);
    nc.ctx = layer.ctx;
    close = () => closeLayer(parent, layer, style);
  }
  (nc.layers ??= []).push({ count, parent, close });
  nc.clipToLayer(bounds);
  return count;
}
/** SkAndroidFrameworkUtils::SaveBehind: the target's pixels under the bounds are set aside and
 *  cleared, and the restore draws them back behind what was drawn since (DST_OVER) */
function saveBehind(nc: NativeCanvas, l: number, t: number, r: number, b: number): number {
  const count = nc.save(), parent = nc.ctx, behind: Behind = { image: null, x: 0, y: 0 };
  recordOrRun(parent, (ctx) => {
    const d = deviceBounds(ctx.getTransform(), l, t, r, b);
    const x0 = Math.max(0, Math.floor(d[0])), y0 = Math.max(0, Math.floor(d[1]));
    const x1 = Math.min(ctx.canvas.width, Math.ceil(d[2])), y1 = Math.min(ctx.canvas.height, Math.ceil(d[3]));
    behind.image = null;
    if (x1 <= x0 || y1 <= y0) return;
    const image = behind.image = new OffscreenCanvas(x1 - x0, y1 - y0);
    image.getContext("2d")!.drawImage(ctx.canvas, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
    behind.x = x0; behind.y = y0;
    ctx.save(); ctx.resetTransform(); ctx.clearRect(x0, y0, x1 - x0, y1 - y0); ctx.restore();
  });
  const close = () => recordOrRun(parent, (ctx) => {
    const image = behind.image;
    if (!image) return;
    ctx.save();
    ctx.resetTransform();
    ctx.globalCompositeOperation = "destination-over";
    ctx.drawImage(image, behind.x, behind.y);
    ctx.restore();
  });
  (nc.layers ??= []).push({ count, parent, close, behind });
  return count;
}
/** SkCanvasPriv::DrawBehind: the paint over the area a save-behind cleared, then its restore */
function restoreBehind(nc: NativeCanvas, count: number, paint: NativePaint) {
  while (nc.saveCount > count + 1) nc.restore();
  if (nc.saveCount !== count + 1) return;
  const behind = nc.layers?.at(-1)?.behind;
  if (behind) {
    recordOrRun(nc.ctx, (ctx) => {
      const image = behind.image;
      if (!image) return;
      ctx.save();
      ctx.resetTransform();
      ctx.beginPath(); ctx.rect(behind.x, behind.y, image.width, image.height); ctx.clip();
      NativeCanvas.over(ctx).drawPaint(paint);
      ctx.restore();
    });
  }
  nc.restore();
}

// ── paint alpha a Canvas2D style cannot carry ──
/** Skia modulates a shader by the paint's alpha; a Canvas2D gradient or pattern carries none, so
 *  the draw runs under a scaled globalAlpha, applied at replay so it composes with layer alpha.
 *  True when it saved, so endAlpha must follow. */
export function beginShaderAlpha(ctx: Ctx2D, p: NativePaint): boolean {
  return p.shader ? beginAlpha(ctx, p.color >>> 24) : false;
}
export function beginAlpha(ctx: Ctx2D, alpha: number): boolean {
  if (alpha >= 255) return false;
  recordOrRun(ctx, (c) => { c.save(); c.globalAlpha *= alpha / 255; });
  return true;
}
const restoreOp = (c: Ctx2D) => c.restore();
export function endAlpha(ctx: Ctx2D) { recordOrRun(ctx, restoreOp); }

export function unsupported(what: string) { return () => { throw rt.mkThrowable("java/lang/UnsupportedOperationException", what); }; }

// ── natives ──
export const canvasAt = (h: bigint) => deref<NativeCanvas>(h);
/** the canvas a native draws through: a bitmap it draws into is written (NativeBitmap.wrote) */
export function drawingCanvas(h: bigint): NativeCanvas {
  const nc = deref<NativeCanvas>(h);
  nc.bmp?.wrote();
  return nc;
}
/** SkClipOp and Region.Op's nativeInt; hwui ignores the ops that would widen the clip (it emulates
 *  REPLACE only for apps before P, which cannot be done by narrowing) */
const DIFFERENCE = 0, INTERSECT = 1;
rt.registerJnis("android/graphics/Canvas", {
  "nInitRaster(J)J": (b: bigint) => handle(bitmapCanvas(b ? bitmapAt(b) : null)),
  "nGetNativeFinalizer()J": () => FINALIZER,
  "nSetBitmap(JJ)V": (h: bigint, b: bigint) => { const bmp = b ? bitmapAt(b) : null; if (bmp) canvasAt(h).setTarget(bmp.context(), bmp.w, bmp.h, bmp); else canvasAt(h).setTarget(emptyCtx(), 0, 0, null); },
  "nIsOpaque(J)Z": (h: bigint) => { const b = canvasAt(h).bmp; return +(!!b && (!b.hasAlpha || b.config === 3)); },
  "nGetWidth(J)I": (h: bigint) => canvasAt(h).w,
  "nGetHeight(J)I": (h: bigint) => canvasAt(h).h,

  "nSave(JI)I": (h: bigint, flags: number) => canvasAt(h).save(flags),
  "nRestore(J)Z": (h: bigint) => { const nc = canvasAt(h); if (nc.saveCount <= 1) return 0; nc.restore(); return 1; },
  "nRestoreToCount(JI)V": (h: bigint, count: number) => canvasAt(h).restoreToCount(count),
  "nGetSaveCount(J)I": (h: bigint) => canvasAt(h).saveCount,
  "nSaveLayer(JFFFFJ)I": (h: bigint, l: number, t: number, r: number, b: number, p: bigint) => {
    const nc = canvasAt(h);
    return saveLayer(nc, { left: l, top: t, right: r, bottom: b }, p ? nc.paint(p) : null);
  },
  "nSaveLayerAlpha(JFFFFI)I": (h: bigint, l: number, t: number, r: number, b: number, alpha: number) =>
    saveLayer(canvasAt(h), { left: l, top: t, right: r, bottom: b }, null, alpha & 255),
  "nSaveUnclippedLayer(JIIII)I": (h: bigint, l: number, t: number, r: number, b: number) => saveBehind(drawingCanvas(h), l, t, r, b),
  "nRestoreUnclippedLayer(JIJ)V": (h: bigint, count: number, p: bigint) => { const nc = drawingCanvas(h); restoreBehind(nc, count, nc.paint(p)); },

  "nTranslate(JFF)V": (h: bigint, x: number, y: number) => {
    const ctx = canvasAt(h).ctx, m = transformOf(ctx);
    // a singular matrix stays singular: Canvas2D would drop a translate under one
    if (m.a * m.d === m.b * m.c) ctx.setTransform(m.a, m.b, m.c, m.d, m.e + m.a * x + m.c * y, m.f + m.b * x + m.d * y);
    else ctx.translate(x, y);
  },
  "nScale(JFF)V": (h: bigint, x: number, y: number) => canvasAt(h).ctx.scale(x, y),
  "nRotate(JF)V": (h: bigint, d: number) => canvasAt(h).ctx.rotate(Math.fround(d * Math.PI / 180)),
  "nSkew(JFF)V": (h: bigint, sx: number, sy: number) => canvasAt(h).ctx.transform(1, sy, sx, 1, 0, 0),
  "nConcat(JJ)V": (h: bigint, m: bigint) => applyMatrix(canvasAt(h).ctx, matrixAt(m)),
  // a Matrix44 (row-major 4x4): its 2D part, as SkM44::asM33 takes it
  "nConcat(J[F)V": (h: bigint, v: Float32Array) => canvasAt(h).ctx.transform(v[0], v[4], v[1], v[5], v[3], v[7]),
  "nSetMatrix(JJ)V": (h: bigint, m: bigint) => { if (m) applyMatrix(canvasAt(h).ctx, matrixAt(m), true); else canvasAt(h).ctx.setTransform(1, 0, 0, 1, 0, 0); },
  "nGetMatrix(JJ)V": (h: bigint, into: bigint) => {
    const t = transformOf(canvasAt(h).ctx);
    setAffine(matrixAt(into), t.a, t.b, t.c, t.d, t.e, t.f);
  },

  "nClipRect(JFFFFI)Z": (h: bigint, l: number, t: number, r: number, b: number, op: number) => {
    const nc = canvasAt(h);
    return +(op === INTERSECT ? nc.clipRect(l, t, r, b) : op === DIFFERENCE ? nc.clipOutRect(l, t, r, b) : !nc.clipEmpty);
  },
  "nClipPath(JJI)Z": (h: bigint, p: bigint, op: number) => {
    const nc = canvasAt(h);
    return op === INTERSECT || op === DIFFERENCE ? after(nc.clipPath(pathAt(p), op === DIFFERENCE), Number) : +!nc.clipEmpty;
  },
  // a clip by a shader's coverage needs per-pixel clipping, which a 2D context's clip is not
  "nClipShader(JJI)V": unsupported("Canvas.clipShader"),
  "nGetClipBounds(JLandroid/graphics/Rect;)Z": (h: bigint, r: object) => {
    const b = canvasAt(h).clipBounds();
    setEdges(r, b ?? emptyBox);
    return +!!b;
  },
  "nQuickReject(JFFFF)Z": (h: bigint, l: number, t: number, r: number, b: number) => +canvasAt(h).quickReject(l, t, r, b),
  "nQuickReject(JJ)Z": (h: bigint, p: bigint) => {
    const path = pathAt(p);
    if (!path.ops.length) return 1;
    const b = path.bounds();
    return +canvasAt(h).quickReject(b.left, b.top, b.right, b.bottom);
  },
  // high-contrast text is an accessibility setting this device leaves off
  "nIsHighContrastText(J)Z": () => 0,
  "nSetDrawFilter(JJ)V": (h: bigint, f: bigint) => { canvasAt(h).filter = f ? deref<{ clear: number; set: number }>(f) : null; },
  "nSetCompatibilityVersion(I)V": () => {},
  // nothing is cached natively, so there is nothing to free
  "nFreeCaches()V": () => {}, "nFreeTextLayoutCaches()V": () => {},
});
// PaintFlagsDrawFilter's native filter: the flags it clears and sets on every paint
rt.registerJnis("android/graphics/PaintFlagsDrawFilter", {
  "nativeConstructor(II)J": (clear: number, set: number) => ownedHandle({ clear, set }),
});
rt.registerJnis("android/graphics/DrawFilter", { "nativeDestructor(J)V": release });

/** Canvas() with no bitmap: SkiaCanvas over an empty bitmap, which clips everything; its matrix
 *  is still its own */
const emptyCtx = () => new OffscreenCanvas(1, 1).getContext("2d")!;
/** SkiaCanvas over a bitmap's raster, or over none */
export const bitmapCanvas = (b: NativeBitmap | null): NativeCanvas => b ? NativeCanvas.over(b.context(), b.w, b.h, b) : NativeCanvas.over(emptyCtx(), 0, 0);

// ── android.graphics.Picture: a recorded display list ──────────────────────────────────
// The recording canvas records as a RenderNode's does, and drawing the picture replays it into
// the target canvas inside a save/restore, as SkRecordDraw does. SkPicture's serialized form
// (createFromStream, writeToStream) is not implemented.
class NativePicture {
  w = 0; h = 0;
  ops: DisplayList | null = null;
  /** while recording: what the PictureCanvas (which owns its handle) records into */
  recorder: Recorder | null = null;
  /** SkPictureRecorder::finishRecordingAsPicture: the list is the picture's, and the canvas records no more of it */
  endRecording() {
    if (!this.recorder) return;
    this.ops = this.recorder.take();
    this.recorder = null;
  }
}
const picture = (h: bigint) => deref<NativePicture>(h);
rt.registerJnis("android/graphics/Picture", {
  // a copy of a picture still recording holds what was recorded so far
  "nativeConstructor(J)J": (src: bigint) => {
    const p = new NativePicture();
    if (src) { const s = picture(src); p.w = s.w; p.h = s.h; p.ops = s.recorder ? s.recorder.ops.slice() : s.ops; }
    return ownedHandle(p);
  },
  "nativeDestructor(J)V": (h: bigint) => { picture(h).endRecording(); release(h); },
  "nativeBeginRecording(JII)J": (h: bigint, w: number, ht: number) => {
    const p = picture(h);
    p.endRecording();
    p.w = w; p.h = ht; p.ops = null;
    p.recorder = new Recorder();
    return handle(NativeCanvas.over(p.recorder.ctx, w, ht));
  },
  "nativeEndRecording(J)V": (h: bigint) => picture(h).endRecording(),
  "nativeGetWidth(J)I": (h: bigint) => picture(h).w,
  "nativeGetHeight(J)I": (h: bigint) => picture(h).h,
  "nativeDraw(JJ)V": (c: bigint, h: bigint) => {
    const p = picture(h), cv = drawingCanvas(c);
    p.endRecording();
    const ops = p.ops;
    if (!ops) return;
    // into a recording canvas the replay is deferred to where that recording is drawn
    replayFor(cv, () => recordOrRun(cv.ctx, (ctx) => {
      ctx.save();
      try { replay(ctx, ops); } finally { ctx.restore(); }
    }));
  },
});
