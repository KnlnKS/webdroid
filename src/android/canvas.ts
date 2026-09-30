// hwui's SkiaCanvas over an HTML Canvas 2D context: the native half of android.graphics.Canvas,
// BaseCanvas and BaseRecordingCanvas, whose Java runs from AOSP bytecode. A Java canvas holds a
// handle to a NativeCanvas in mNativeCanvasWrapper, and TS reaches it through canvasOf.

import { isRecording, nestedRecording, recordOrRun, replay, replayCanvas, replayWithSemantics, type Ctx2D, type DisplayList } from "./recording";
import { tryBitmapLine, tryBitmapOval, tryBitmapPath, tryBitmapRect, tryBitmapRoundRect, tryBitmapShape, tryPartialSourceIn } from "./bitmap-raster";
import { drawSkiaText, SKIA_TEXT_FACE } from "./skia-text";
import { rt, type JObj, declaredField } from "../jvm/runtime";
import { charsToString } from "../jvm/abi";
import { handle, deref, release, ownedHandle, FINALIZER } from "./handles";
import { linkInit } from "../jvm/natives/jlang";
import { type NativePath, PathMeasure, inversePath, nativePathOf } from "./path";
import { type NativeRegion } from "./region";
import { NativeBitmap, ALPHA_8, ARGB_8888, PREMUL, OPAQUE, setPixels } from "./bitmap";
import { drawGlyphs } from "./shaping";
import {
  JPaint, type JRect, type Affine, type NativeColorFilter, NativeBitmapShader, type NinePatchChunk, type Mat,
  cssColor, copyPaint, defaultPaint, beginPaintShadow, blurMask, canvasLocalBounds, shaderIdentity, measureText, tintedBmp, recolor,
  setAffine, applyMatrix, drawNinePatch, argbOfColorLong, BLEND_MODES, COMPOSITE,
} from "./graphics";

/** the Java canvases TS hands framework and app code: a Canvas or RecordingCanvas peer */
export type JavaCanvas = JObj;
type DrawnTextOwner = { drawnText: string[] | null; drawnTextPoints: Float32Array | null; drawnTextCount: number };
type LayerStyle = { alpha: number; blend: GlobalCompositeOperation | null; filter: NativeColorFilter | null };
type RectLike = { left: number; top: number; right: number; bottom: number };
/** an open layer: the save count its restore closes, the context drawn into before it, and the close */
type Layer = { count: number; parent: Ctx2D; close: () => void };

/** setLineDash copies its argument, so every undashed stroke can pass the same empty list */
const NO_DASH: number[] = [];
/** SkCanvas::SaveFlags: Matrix and Clip */
const MATRIX_CLIP = 3;

/** SkiaCanvas: a 2D context and the state Canvas2D does not expose — the save count, the device
 *  clip bounds, open layers — plus the drawn-text record the harness locates text by */
export class NativeCanvas {
  ctx!: Ctx2D;
  w = 0; h = 0;
  bmp: NativeBitmap | null = null;
  /** a RecordingCanvas's: what Java's isHardwareAccelerated answers */
  accelerated = false;
  /** a RenderNode's RecordingCanvas: its recording context and the list it appends to */
  recording: { ctx: Ctx2D; ops: DisplayList } | null = null;
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
  private filtered: JPaint | null = null;
  /** the Java canvas TS made over this one, for a hardware canvas drawing a software layer */
  private twin: JavaCanvas | null = null;
  semanticOwner: DrawnTextOwner | null = null;
  semanticBase: DOMMatrix | null = null;

  static over(ctx: Ctx2D, w: number, h: number, bmp: NativeBitmap | null = null): NativeCanvas {
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
  paint(h: bigint): JPaint {
    const p = deref<JPaint>(h), f = this.filter;
    if (!f) return p;
    const out = this.filtered ??= new JPaint();
    copyPaint(p, out);
    out.flags = (p.flags & ~f.clear) | f.set;
    return out;
  }

  semanticTransform(): DOMMatrix {
    const m = this.ctx.getTransform();
    return this.semanticBase ? this.semanticBase.multiply(m) : m;
  }
  recordText(text: string, x: number, y: number, size: number, align: number) {
    recordOrRun(this.ctx, ctx => {
      const canvas = replayCanvas(ctx) ?? this;
      const owner = canvas.semanticOwner;
      if (!owner) return;
      (owner.drawnText ??= []).push(text);
      const i = owner.drawnTextCount++;
      if (!owner.drawnTextPoints || owner.drawnTextPoints.length < (i + 1) * 2) {
        const next = new Float32Array(Math.max(8, (i + 1) * 4));
        if (owner.drawnTextPoints) next.set(owner.drawnTextPoints);
        owner.drawnTextPoints = next;
      }
      const cx = x + (align === 0 ? size : align === 2 ? -size : 0), cy = y - size * 0.3;
      const m = ctx.getTransform();
      let sx = m.a * cx + m.c * cy + m.e, sy = m.b * cx + m.d * cy + m.f;
      if (canvas.semanticBase) {
        const b = canvas.semanticBase;
        const px = sx;
        sx = b.a * px + b.c * sy + b.e;
        sy = b.b * px + b.d * sy + b.f;
      }
      owner.drawnTextPoints[i * 2] = sx;
      owner.drawnTextPoints[i * 2 + 1] = sy;
    });
  }

  prep(p: JPaint, stroke: boolean) {
    const ctx = this.ctx;
    const pattern = p.drawShader()?.deferredPattern();
    if (pattern) recordOrRun(ctx, c => { c[stroke ? "strokeStyle" : "fillStyle"] = pattern(c); });
    if (stroke) {
      if (!pattern) ctx.strokeStyle = p.fillStyle(ctx) as string;
      ctx.lineWidth = Math.max(p.strokeWidth, 1);
      ctx.lineCap = p.strokeCapN;
      ctx.lineJoin = p.strokeJoinN;
      ctx.setLineDash(p.dash ?? NO_DASH);
    } else {
      if (!pattern) ctx.fillStyle = p.fillStyle(ctx) as string;
    }
    if (p.blendName === "CLEAR") ctx[stroke ? "strokeStyle" : "fillStyle"] = "#000";
    return !!pattern || typeof CanvasPattern !== "undefined" && ctx[stroke ? "strokeStyle" : "fillStyle"] instanceof CanvasPattern;
  }
  private blurLayer: { source: NativeCanvas; target: OffscreenCanvasRenderingContext2D; paint: JPaint } | null = null;
  drawMask(p: JPaint, fill: (ctx: Ctx2D) => void, stroke?: (ctx: Ctx2D) => void) {
    const ctx = this.ctx, w = ctx.canvas.width, h = ctx.canvas.height, m = ctx.getTransform();
    const scale = Math.sqrt(Math.abs(m.a * m.d - m.b * m.c));
    if (!w || !h || !scale) return;
    let layer = this.blurLayer;
    if (!layer || layer.source.w !== w || layer.source.h !== h) {
      const source = new OffscreenCanvas(w, h).getContext("2d")!;
      layer = this.blurLayer = { source: NativeCanvas.over(source, w, h), target: new OffscreenCanvas(w, h).getContext("2d")!, paint: new JPaint() };
    }
    const source = layer.source.ctx, target = layer.target;
    source.resetTransform(); source.clearRect(0, 0, w, h); source.setTransform(m);
    copyPaint(p, layer.paint);
    layer.paint.maskFilter = null; layer.paint.blend = null; layer.paint.shadowRadius = 0;
    layer.paint.color = -1; layer.paint.renderAlpha = null; layer.paint.shaderObj = layer.paint.shader = null; layer.paint.colorFilter = null;
    if (stroke) layer.source.drawShape(layer.paint, fill, stroke);
    else fill(source);
    target.clearRect(0, 0, w, h);
    blurMask(target, source.canvas, p.maskFilter, 0, 0, scale);
    target.globalCompositeOperation = "source-in";
    try {
      if (p.shader) {
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
  drawShape(p: JPaint, fill: (ctx: Ctx2D) => void, stroke: (ctx: Ctx2D) => void) {
    if (tryPartialSourceIn(this, p, fill, stroke)) return;
    if (tryBitmapShape(this, p, fill, stroke)) return;
    if (p.maskFilter?.style) return this.drawMask(p, fill, stroke);
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
    const filter = p.maskFilter ? this.ctx.filter : null;
    if (p.maskFilter) {
      const m = this.ctx.getTransform();
      this.ctx.filter = `blur(${p.maskFilter.sigma * Math.sqrt(Math.abs(m.a * m.d - m.b * m.c))}px)`;
    }
    try {
      if (blend) this.ctx.globalCompositeOperation = blend;
      if (p.style === 0 || p.style === 2) {
        const shader = p.drawShader(), lm = shader?.local;
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
      else ctx.fillRect(-1e5, -1e5, 2e5, 2e5);
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
          const v = (t as unknown as Record<PropertyKey, unknown>)[k];
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        },
        set: (t, k, v) => { (t as unknown as Record<PropertyKey, unknown>)[k] = v; return true; },
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
    const ctx = this.ctx, m = ctx.getTransform();
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
    const m = this.ctx.getTransform();
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
  clipPath(path: NativePath, out: boolean): boolean {
    const ctx = this.ctx;
    const apply = (c: Ctx2D) => {
      if (path.inverseFill !== out) {
        const bounds = canvasLocalBounds(c);
        if (!bounds) return;
        const [inverse, rule] = inversePath(path, ...bounds);
        c.clip(inverse, rule);
      } else c.clip(path.path(), path.fillRule);
    };
    apply(ctx);
    this.persist(apply);
    if (!out && !path.inverseFill && !this.clipEmpty) {
      const m = ctx.getTransform();
      path.bounds(pathBox);
      if (!(m.a * m.d - m.b * m.c)) this.setClipEmpty();
      else {
        const d = deviceBounds(m, pathBox.left, pathBox.top, pathBox.right, pathBox.bottom);
        this.narrow(Math.floor(d[0]), Math.floor(d[1]), Math.ceil(d[2]), Math.ceil(d[3]));
      }
    }
    return !this.clipEmpty;
  }
  /** SkCanvas::quickReject: whether the rect under the matrix misses the device clip's bounds,
   *  outset a pixel for anti-aliasing */
  quickReject(l: number, t: number, r: number, b: number): boolean {
    if (this.clipEmpty) return true;
    const d = deviceBounds(this.ctx.getTransform(), l, t, r, b);
    if (!(Number.isFinite(d[0]) && Number.isFinite(d[1]) && Number.isFinite(d[2]) && Number.isFinite(d[3]))) return true;
    return !(Math.max(d[0], this.cl - 1) < Math.min(d[2], this.cr + 1) && Math.max(d[1], this.ct - 1) < Math.min(d[3], this.cb + 1));
  }
  /** SkiaCanvas::getClipBounds: the device clip's bounds in local coordinates, rounded */
  clipBounds(out: RectLike): boolean {
    const matrix = this.ctx.getTransform();
    const a = Math.fround(matrix.a), b = Math.fround(matrix.b), c = Math.fround(matrix.c), d = Math.fround(matrix.d);
    const e = Math.fround(matrix.e), f = Math.fround(matrix.f);
    const det = a * d - b * c;
    if (!det || !Number.isFinite(det) || this.clipEmpty) {
      out.left = out.top = out.right = out.bottom = 0;
      return false;
    }
    const dx = this.cl - e, dy = this.ct - f;
    const ox = (d * dx - c * dy) / det, oy = (a * dy - b * dx) / det;
    const wx = d * (this.cr - this.cl) / det, wy = -b * (this.cr - this.cl) / det;
    const hx = -c * (this.cb - this.ct) / det, hy = a * (this.cb - this.ct) / det;
    out.left = Math.round(ox + Math.min(0, wx) + Math.min(0, hx));
    out.top = Math.round(oy + Math.min(0, wy) + Math.min(0, hy));
    out.right = Math.round(ox + Math.max(0, wx) + Math.max(0, hx));
    out.bottom = Math.round(oy + Math.max(0, wy) + Math.max(0, hy));
    return true;
  }
  /** a layer confines what is drawn in it to its device bounds, rounded out */
  clipToLayer(bounds: RectLike | null) {
    if (!bounds) return;
    const d = deviceBounds(this.ctx.getTransform(), bounds.left, bounds.top, bounds.right, bounds.bottom);
    this.narrow(Math.floor(d[0]), Math.floor(d[1]), Math.ceil(d[2]), Math.ceil(d[3]));
  }

  /** the Java Canvas over this one's target that a software layer draws through under a hardware
   *  window: made once, and given this canvas's state each time */
  softwareTwin(): JavaCanvas {
    const peer = this.twin ??= canvasPeer(new NativeCanvas());
    const twin = canvasOf(peer);
    twin.setTarget(this.ctx, this.w, this.h, null);
    twin.cl = this.cl; twin.ct = this.ct; twin.cr = this.cr; twin.cb = this.cb; twin.poly = this.poly;
    twin.semanticBase = this.semanticBase;
    return peer;
  }
}
const pathBox: RectLike = { left: 0, top: 0, right: 0, bottom: 0 };
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
const devBox = new Float64Array(4);
/** the device-space bounding box [x0, y0, x1, y1] of (l, t, r, b) under `m`, in a shared buffer */
function deviceBounds(m: DOMMatrix, l: number, t: number, r: number, b: number): Float64Array {
  const x = m.a * l + m.c * t + m.e, y = m.b * l + m.d * t + m.f;
  const wx = m.a * (r - l), wy = m.b * (r - l), hx = m.c * (b - t), hy = m.d * (b - t);
  devBox[0] = x + Math.min(0, wx) + Math.min(0, hx); devBox[1] = y + Math.min(0, wy) + Math.min(0, hy);
  devBox[2] = x + Math.max(0, wx) + Math.max(0, hx); devBox[3] = y + Math.max(0, wy) + Math.max(0, hy);
  return devBox;
}

// ── the Java side: one bridge, and the peers TS makes ──
let wrapperField = "", widthField = "", heightField = "";
const wrapper = () => wrapperField ||= declaredField("android/graphics/Canvas", "mNativeCanvasWrapper");
/** the native state behind a Java canvas */
export const canvasOf = (c: object): NativeCanvas => deref<NativeCanvas>((c as Record<string, bigint>)[wrapper()]);
const peers = new FinalizationRegistry<bigint>(release);
/** A Java Canvas over `nc` — a RecordingCanvas when it is accelerated, which is what a hardware
 *  window hands its views — made without running a constructor, so it never suspends. The
 *  handle is released with the peer. */
export function canvasPeer(nc: NativeCanvas): JavaCanvas {
  const c = rt.make(nc.accelerated ? "android/graphics/RecordingCanvas" : "android/graphics/Canvas") as JavaCanvas & Record<string, unknown>;
  const h = handle(nc);
  c[wrapper()] = h;
  if (nc.accelerated) {
    c[widthField ||= declaredField("android/graphics/RecordingCanvas", "mWidth")] = nc.w;
    c[heightField ||= declaredField("android/graphics/RecordingCanvas", "mHeight")] = nc.h;
  }
  peers.register(c, h);
  return c;
}
/** a Java Canvas drawing straight into `ctx`, a RecordingCanvas when `accelerated` */
export function canvasOver(ctx: Ctx2D, w: number, h: number, accelerated = false): JavaCanvas {
  const nc = NativeCanvas.over(ctx, w, h);
  nc.accelerated = accelerated;
  return canvasPeer(nc);
}
const windows = new Map<Ctx2D, JavaCanvas>();
/** the RecordingCanvas a hardware-accelerated window draws its views through, one per target and
 *  reset for each frame */
export function windowCanvas(ctx: Ctx2D, w: number, h: number): JavaCanvas {
  let peer = windows.get(ctx);
  if (!peer) {
    const nc = new NativeCanvas();
    nc.accelerated = true;
    windows.set(ctx, peer = canvasPeer(nc));
  }
  const nc = canvasOf(peer);
  nc.setTarget(ctx, w, h, null);
  nc.semanticOwner = nc.semanticBase = null;
  const p = peer as Record<string, unknown>;
  p[widthField] = w; p[heightField] = h;
  return peer;
}
/** View's constructor tells Canvas the target SDK: what restore underflow, setBitmap and clip ops
 *  may do depends on it */
export async function setCanvasTargetSdk(target: number): Promise<void> {
  const info = await linkInit("android/graphics/Canvas"), statics = info.ctor as unknown as Record<string, unknown>;
  statics[info.staticFieldTable.get("sCompatibilityRestore:Z")!] = +(target < 23);
  statics[info.staticFieldTable.get("sCompatibilitySetBitmap:Z")!] = +(target < 26);
  statics[info.staticFieldTable.get("sCompatibilityVersion:I")!] = target;
}

let outlineFields: { mode: string; rect: string; radius: string; path: string } | null = null;
/** intersect ctx's clip with a Java Outline's shape (what View.setClipToOutline asks); an empty
 *  outline does not clip */
export function clipToOutline(ctx: Ctx2D, outline: object): void {
  const f = outlineFields ??= {
    mode: declaredField("android/graphics/Outline", "mMode"), rect: declaredField("android/graphics/Outline", "mRect"),
    radius: declaredField("android/graphics/Outline", "mRadius"), path: declaredField("android/graphics/Outline", "mPath"),
  };
  const o = outline as Record<string, unknown>, mode = o[f.mode];
  if (!mode) return;
  // MODE_PATH, else MODE_ROUND_RECT
  if (mode === 2) { const p = nativePathOf(o[f.path] as object); ctx.clip(p.path(), p.fillRule); return; }
  const r = o[f.rect] as JRect;
  clipRoundRect(ctx, r.left, r.top, r.right, r.bottom, o[f.radius] as number);
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
export function layerStyle(paint: JPaint | null, alpha = 255): LayerStyle {
  return {
    alpha: paint ? (paint.renderAlpha ?? paint.color >>> 24) * alpha / 255 : alpha,
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
function openLayer(target: Ctx2D, bounds: RectLike | null, cpu: boolean): LayerRaster {
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
/** `ops` replayed through a layer over `bounds` of the real `target`; recorded text keeps the
 *  semantic owner the target replays for, the layer sharing its device space */
export function drawInLayer(target: Ctx2D, bounds: RectLike | null, style: LayerStyle, ops: DisplayList) {
  const layer = openLayer(target, bounds, false), outer = replayCanvas(target);
  try {
    if (outer) replayWithSemantics(outer, () => replay(layer.ctx, ops), layer.ctx);
    else replay(layer.ctx, ops);
  } finally { closeLayer(target, layer, style); }
}
/** Canvas.saveLayer: draws until the matching restore land in an offscreen raster, composited
 *  then with what the paint said when the layer was opened */
export function saveLayer(nc: NativeCanvas, bounds: RectLike | null, paint: JPaint | null, alpha = 255): number {
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
  const count = nc.save(), parent = nc.ctx, behind: { image: OffscreenCanvas | null; x: number; y: number } = { image: null, x: 0, y: 0 };
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
  (nc.layers ??= []).push({ count, parent, close, behind } as Layer);
  return count;
}
/** SkCanvasPriv::DrawBehind: the paint over the area a save-behind cleared, then its restore */
function restoreBehind(nc: NativeCanvas, count: number, paint: JPaint) {
  while (nc.saveCount > count + 1) nc.restore();
  if (nc.saveCount !== count + 1) return;
  const behind = (nc.layers?.at(-1) as { behind?: { image: OffscreenCanvas | null; x: number; y: number } } | undefined)?.behind;
  if (behind) {
    recordOrRun(nc.ctx, (ctx) => {
      const image = behind.image;
      if (!image) return;
      ctx.save();
      ctx.resetTransform();
      ctx.beginPath(); ctx.rect(behind.x, behind.y, image.width, image.height); ctx.clip();
      drawPaint(NativeCanvas.over(ctx, ctx.canvas.width, ctx.canvas.height), paint);
      ctx.restore();
    });
  }
  nc.restore();
}

// ── draws ──
/** Skia modulates a shader by the paint's alpha; a Canvas2D gradient or pattern carries none, so
 *  the draw runs under a scaled globalAlpha, applied at replay so it composes with layer alpha.
 *  True when it saved, so endAlpha must follow. */
function beginShaderAlpha(ctx: Ctx2D, p: JPaint): boolean {
  return p.shader ? beginAlpha(ctx, p.renderAlpha ?? p.color >>> 24) : false;
}
function beginAlpha(ctx: Ctx2D, alpha: number): boolean {
  if (alpha >= 255) return false;
  recordOrRun(ctx, (c) => { c.save(); c.globalAlpha *= alpha / 255; });
  return true;
}
const restoreOp = (c: Ctx2D) => c.restore();
function endAlpha(ctx: Ctx2D) { recordOrRun(ctx, restoreOp); }

export function drawPath(nc: NativeCanvas, path: NativePath, p: JPaint) {
  if (tryBitmapPath(nc, p, path)) return;
  if (!path.inverseFill) {
    nc.drawShape(p, (c) => c.fill(path.path(), path.fillRule), (c) => c.stroke(path.path()));
    return;
  }
  const bounds = canvasLocalBounds(nc.ctx);
  if (!bounds) return;
  const [inverse, rule] = inversePath(path, ...bounds);
  nc.drawShape(p, (c) => c.fill(inverse, rule), (c) => c.stroke(path.path()));
}
export function drawRect(nc: NativeCanvas, l: number, t: number, r: number, b: number, p: JPaint) {
  const left = Math.min(l, r), top = Math.min(t, b), width = Math.abs(r - l), height = Math.abs(b - t);
  if ((!width || !height) && p.style !== 1) return;
  if (tryBitmapRect(nc, p, left, top, left + width, top + height)) return;
  if (p.blend === "source-in" && p.style === 0) {
    const shape = new Path2D();
    shape.rect(left, top, width, height);
    nc.ctx.save();
    try {
      nc.ctx.clip(shape);
      nc.drawShape(p, (c) => c.fill(shape), (c) => c.stroke(shape));
    } finally { nc.ctx.restore(); }
    return;
  }
  nc.drawShape(p, (c) => c.fillRect(left, top, width, height), (c) => c.strokeRect(left, top, width, height));
}
/** SkCanvas::drawColor: the whole clip filled with `color` under the SkBlendMode numbered `mode` */
function drawColor(nc: NativeCanvas, color: number, mode: number) {
  if (mode === 2) return; // DST
  const fill = cssColor(color), op = mode === 3 ? null : COMPOSITE[BLEND_MODES[mode]] ?? null;
  recordOrRun(nc.ctx, (ctx) => {
    ctx.save();
    ctx.resetTransform();
    if (mode === 0) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    else {
      if (op) ctx.globalCompositeOperation = op;
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    ctx.restore();
  });
}
/** ellipse arc in the box; a full sweep without the centre is drawOval */
function drawArc(nc: NativeCanvas, l: number, t: number, r: number, b: number, start: number, sweep: number, useCenter: number, p: JPaint) {
  if (!(r > l && b > t) && Math.abs(sweep) < 360) return;
  const left = Math.min(l, r), top = Math.min(t, b), right = Math.max(l, r), bottom = Math.max(t, b);
  if (tryBitmapOval(nc, p, left, top, right, bottom, sweep)) return;
  const path = new Path2D();
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  if (useCenter) path.moveTo(cx, cy);
  path.ellipse(cx, cy, (right - left) / 2, (bottom - top) / 2, 0, start * Math.PI / 180, (start + sweep) * Math.PI / 180, sweep < 0);
  if (useCenter) path.closePath();
  nc.drawShape(p, (c) => c.fill(path), (c) => c.stroke(path));
}
export function drawOval(nc: NativeCanvas, l: number, t: number, r: number, b: number, p: JPaint) {
  if (l === r || t === b) return;
  drawArc(nc, Math.min(l, r), Math.min(t, b), Math.max(l, r), Math.max(t, b), 0, 360, 0, p);
}
export function drawCircle(nc: NativeCanvas, x: number, y: number, r: number, p: JPaint) {
  if (r > 0) drawOval(nc, x - r, y - r, x + r, y + r, p);
}
export function drawRoundRect(nc: NativeCanvas, l: number, t: number, r: number, b: number, rx: number, ry: number, p: JPaint) {
  const left = Math.min(l, r), top = Math.min(t, b), width = Math.abs(r - l), height = Math.abs(b - t);
  if ((!width || !height) && p.style !== 1) return;
  if (tryBitmapRoundRect(nc, p, left, top, left + width, top + height, rx, ry)) return;
  const path = new Path2D();
  path.roundRect(left, top, width, height, { x: Math.max(rx, 0), y: Math.max(ry, 0) });
  nc.drawShape(p, (c) => c.fill(path), (c) => c.stroke(path));
}
function drawDoubleRoundRect(nc: NativeCanvas, ol: number, ot: number, or: number, ob: number, orx: number, ory: number,
  il: number, it: number, ir: number, ib: number, irx: number, iry: number, p: JPaint) {
  const ring = new Path2D();
  ring.roundRect(ol, ot, or - ol, ob - ot, { x: Math.max(orx, 0), y: Math.max(ory, 0) });
  ring.roundRect(il, it, ir - il, ib - it, { x: Math.max(irx, 0), y: Math.max(iry, 0) });
  nc.drawShape(p, (x) => x.fill(ring, "evenodd"), (x) => x.stroke(ring));
}
/** android_graphics_Canvas: an offset/count pair outside the array draws nothing and throws */
function checkPts(pts: Float32Array, off: number, n: number) {
  if (!pts) throw rt.mkThrowable("java/lang/NullPointerException", null);
  if ((off | n) < 0 || off + n > pts.length) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", null);
}
function drawLine(nc: NativeCanvas, x0: number, y0: number, x1: number, y1: number, p: JPaint) {
  if (tryBitmapLine(nc, p, x0, y0, x1, y1)) return;
  nc.prep(p, true);
  nc.ctx.beginPath();
  nc.ctx.moveTo(x0, y0);
  nc.ctx.lineTo(x1, y1);
  nc.ctx.stroke();
}
function drawLines(nc: NativeCanvas, pts: Float32Array, off: number, n: number, p: JPaint) {
  checkPts(pts, off, n);
  nc.prep(p, true);
  nc.ctx.beginPath();
  for (let i = off, end = off + (n & ~3); i < end; i += 4) {
    nc.ctx.moveTo(pts[i], pts[i + 1]);
    nc.ctx.lineTo(pts[i + 2], pts[i + 3]);
  }
  nc.ctx.stroke();
}
/** Skia draws a point as the stroke's cap: a disc for a round cap, otherwise a square; a
 *  hairline point is one pixel */
function pointPath(ctx: Ctx2D, x: number, y: number, p: JPaint) {
  const w = p.strokeWidth || 1, r = w / 2;
  if (p.strokeCapN === "round" && p.strokeWidth) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 2 * Math.PI); } else ctx.rect(x - r, y - r, w, w);
}
function drawPoints(nc: NativeCanvas, pts: Float32Array, off: number, n: number, p: JPaint) {
  checkPts(pts, off, n);
  nc.prep(p, false);
  nc.ctx.beginPath();
  for (let i = off, end = off + (n & ~1); i < end; i += 2) pointPath(nc.ctx, pts[i], pts[i + 1], p);
  nc.ctx.fill();
}
const paintScratch = new JPaint();
function drawPaint(nc: NativeCanvas, paint: JPaint) {
  const bounds = canvasLocalBounds(nc.ctx);
  if (!bounds) return;
  const [l, t, r, b] = bounds;
  copyPaint(paint, paintScratch); paintScratch.style = 0; paintScratch.maskFilter = null;
  nc.drawShape(paintScratch, c => c.fillRect(l, t, r - l, b - t), () => {});
}
function drawRegion(nc: NativeCanvas, region: NativeRegion, p: JPaint) {
  const path = new Path2D();
  region.forEachRect((l, t, r, b) => path.rect(l, t, r - l, b - t));
  nc.drawShape(p, (c) => c.fill(path), (c) => c.stroke(path));
}
/** SkiaCanvas::punchHole: the round rect cleared to `alpha` of transparency (DST_OUT with black) */
function punchHole(nc: NativeCanvas, l: number, t: number, r: number, b: number, rx: number, ry: number, alpha: number) {
  recordOrRun(nc.ctx, (ctx) => {
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#000";
    ctx.beginPath();
    ctx.roundRect(l, t, r - l, b - t, { x: rx, y: ry });
    ctx.fill();
    ctx.restore();
  });
}

/** the bitmap a draw names by handle */
const bitmapAt = (h: bigint) => deref<NativeBitmap>(h);
/** an image drawn through the paint as SkCanvas::drawImage does: its alpha, blend mode and colour
 *  filter; an ALPHA_8 bitmap is coverage, drawn in the paint's colour */
function drawBitmap(nc: NativeCanvas, b: NativeBitmap, paint: JPaint | null, draw: (ctx: Ctx2D, image: CanvasImageSource) => void) {
  if (b.config === ALPHA_8) {
    const p = paint ?? defaultPaint;
    if (p.maskFilter || p.shader) nc.drawMask(p, (ctx) => draw(ctx, b.image));
    else draw(nc.ctx, tintedBmp(b, p.filteredColor()));
    return;
  }
  const f = paint?.colorFilter, image = f ? tintedBmp(b, f.color, f.matrix, f.mode) : b.image;
  const faded = !!paint && beginAlpha(nc.ctx, paint.renderAlpha ?? paint.color >>> 24), blend = paint?.compositeOp();
  const prev = blend ? nc.ctx.globalCompositeOperation : null;
  try {
    if (blend) nc.ctx.globalCompositeOperation = blend;
    draw(nc.ctx, image);
  } finally {
    if (prev) nc.ctx.globalCompositeOperation = prev;
    if (faded) endAlpha(nc.ctx);
  }
}
/** android_graphics_Canvas drawBitmap: a bitmap of another density than the canvas's is drawn in
 *  its own pixels under the scale between them */
function drawBitmapAt(nc: NativeCanvas, b: NativeBitmap, x: number, y: number, paint: JPaint | null, canvasDensity: number, bitmapDensity: number) {
  if (canvasDensity === bitmapDensity || !canvasDensity || !bitmapDensity) {
    drawBitmap(nc, b, paint, (ctx, image) => ctx.drawImage(image, x, y));
    return;
  }
  const s = Math.fround(canvasDensity / bitmapDensity);
  nc.ctx.save();
  try {
    nc.ctx.translate(x, y);
    nc.ctx.scale(s, s);
    drawBitmap(nc, b, paint, (ctx, image) => ctx.drawImage(image, 0, 0));
  } finally { nc.ctx.restore(); }
}
/** Canvas.drawPatch as android_graphics_Canvas draws it: a patch of another density is drawn in its
 *  own pixels under a scale; the paint contributes its alpha */
export function drawPatch(nc: NativeCanvas, bmp: NativeBitmap, chunk: NinePatchChunk, l: number, t: number, r: number, b: number, paint: JPaint | null, dstDensity: number, srcDensity: number) {
  const ctx = nc.ctx;
  ctx.save();
  if (paint) ctx.globalAlpha *= (paint.renderAlpha ?? paint.color >>> 24) / 255;
  if (dstDensity === srcDensity || !dstDensity || !srcDensity) drawNinePatch(ctx, bmp.image, bmp.w, bmp.h, chunk, l, t, r - l, b - t);
  else {
    const s = dstDensity / srcDensity;
    ctx.translate(l, t);
    ctx.scale(s, s);
    drawNinePatch(ctx, bmp.image, bmp.w, bmp.h, chunk, 0, 0, (r - l) / s, (b - t) / s);
  }
  ctx.restore();
}
export function tryDrawBitmapText(nc: NativeCanvas, s: string, x: number, y: number, p: JPaint): boolean {
  return !!(nc.bmp && (p.style === 0 || p.style === 2 && p.strokeWidth === 0 ||
    p.style === 1 && p.strokeWidth === 0 && p.strokeCapN === "butt" && p.strokeJoinN === "miter" && !p.dash) &&
    p.antiAlias && p.textAlignN === 0 && !p.letterSpacingEm &&
    !p.underline && !p.strikeThru && !p.shader && !p.maskFilter && !p.shadowRadius &&
    !p.colorFilter && !p.blend && !isRecording(nc.ctx) &&
    p.face()?.path === SKIA_TEXT_FACE && !p.faked() &&
    drawSkiaText(nc.ctx, s, x, y, p.textSize,
      p.renderAlpha === null ? p.color : (p.renderAlpha << 24) | (p.color & 0xffffff),
      p.style === 1 ? "hairline" : "fill", p.subpixelText || p.linearText));
}
export function drawText(nc: NativeCanvas, s: string, x: number, y: number, p: JPaint) {
  nc.recordText(s, x, y, p.textSize, p.textAlignN);
  if (tryDrawBitmapText(nc, s, x, y, p)) return;
  const ctx = nc.ctx, shaded = beginShaderAlpha(ctx, p), shadow = beginPaintShadow(ctx, p);
  try {
    ctx.font = p.font();
    ctx.textRendering = "geometricPrecision";
    if ("lang" in ctx) ctx.lang = p.language;
    nc.prep(p, false);
    ctx.textAlign = p.textAlignN === 1 ? "center" : p.textAlignN === 2 ? "right" : "left";
    ctx.textBaseline = "alphabetic";
    if (p.letterSpacingEm && "letterSpacing" in ctx) ctx.letterSpacing = `${p.letterSpacingEm * p.textSize}px`;
    if (p.style !== 1) ctx.fillText(s, x, y);
    if (p.style === 1 || p.style === 2 && p.strokeWidth !== 0) {
      nc.prep(p, true);
      ctx.strokeText(s, x, y);
    }
    if (p.letterSpacingEm && "letterSpacing" in ctx) ctx.letterSpacing = "0px";
    if (p.underline || p.strikeThru) {
      const w = measureText(p, s);
      const sx = p.textAlignN === 1 ? x - w / 2 : p.textAlignN === 2 ? x - w : x;
      if (p.underline) ctx.fillRect(sx, y + p.textSize * 0.08, w, Math.max(1, p.textSize / 16));
      if (p.strikeThru) ctx.fillRect(sx, y - p.textSize * 0.3, w, Math.max(1, p.textSize / 14));
    }
  } finally { if (shadow) ctx.restore(); if (shaded) endAlpha(ctx); }
}
const onPath = new PathMeasure(), posTan = new Float32Array(4), graphemes = typeof Intl !== "undefined" ? new Intl.Segmenter() : null;
/** Canvas::drawTextOnPath (SkiaCanvas::drawLayoutOnPath): each cluster placed at the middle of its
 *  advance along the path's first contour and turned to its tangent, the alignment an offset of
 *  the whole run against the contour's length */
function drawTextOnPath(nc: NativeCanvas, s: string, path: NativePath, hOffset: number, vOffset: number, p: JPaint) {
  onPath.setPath(path, false);
  const advance = measureText(p, s), align = p.textAlignN;
  if (align) hOffset += (align === 1 ? -0.5 : -1) * (advance - onPath.length());
  const left = p.textAlignN;
  p.textAlignN = 0;
  try {
    let x = 0;
    for (const { segment } of graphemes ? graphemes.segment(s) : Array.from(s, (segment) => ({ segment }))) {
      const w = measureText(p, segment), half = w / 2, at = hOffset + x + half;
      let px = at, py = vOffset, tx = 1, ty = 0;
      if (onPath.getPosTan(at, posTan, posTan.subarray(2))) { px = posTan[0]; py = posTan[1]; tx = posTan[2]; ty = posTan[3]; }
      nc.ctx.save();
      try {
        nc.ctx.transform(tx, ty, -ty, tx, px - ty * vOffset - half * tx, py + tx * vOffset - half * ty);
        drawText(nc, segment, 0, 0, p);
      } finally { nc.ctx.restore(); }
      x += w;
    }
  } finally { p.textAlignN = left; }
}
/** the text a run names, without a copy for the whole string */
const run = (s: string, start: number, end: number) => (start === 0 && end === s.length ? s : s.slice(start, end));
const unsupported = (what: string) => () => { throw rt.mkThrowable("java/lang/UnsupportedOperationException", what); };

// ── natives ──
const nat = (h: bigint) => deref<NativeCanvas>(h);
const optPaint = (nc: NativeCanvas, h: bigint) => (h ? nc.paint(h) : null);
const matrixAt = (h: bigint) => deref<Mat>(h);
const pathAt = (h: bigint) => deref<NativePath>(h);
/** SkClipOp and Region.Op's nativeInt: 0 difference, 1 intersect; hwui ignores the ops that would
 *  widen the clip (it emulates REPLACE only for apps before P, which cannot be done by narrowing) */
const clipOp = (nc: NativeCanvas, op: number, intersect: () => boolean, difference: () => boolean) =>
  +(op === 1 ? intersect() : op === 0 ? difference() : !nc.clipEmpty);
rt.registerJnis("android/graphics/Canvas", {
  "nInitRaster(J)J": (b: bigint) => handle(bitmapCanvas(b ? bitmapAt(b) : null)),
  "nGetNativeFinalizer()J": () => FINALIZER,
  "nSetBitmap(JJ)V": (h: bigint, b: bigint) => { const bmp = b ? bitmapAt(b) : null; if (bmp) nat(h).setTarget(bmp.ctx, bmp.w, bmp.h, bmp); else nat(h).setTarget(emptyCtx(), 0, 0, null); },
  "nIsOpaque(J)Z": (h: bigint) => { const b = nat(h).bmp; return +(!!b && (!b.hasAlpha || b.config === 3)); },
  "nGetWidth(J)I": (h: bigint) => nat(h).w,
  "nGetHeight(J)I": (h: bigint) => nat(h).h,

  "nSave(JI)I": (h: bigint, flags: number) => nat(h).save(flags),
  "nRestore(J)Z": (h: bigint) => { const nc = nat(h); if (nc.saveCount <= 1) return 0; nc.restore(); return 1; },
  "nRestoreToCount(JI)V": (h: bigint, count: number) => nat(h).restoreToCount(count),
  "nGetSaveCount(J)I": (h: bigint) => nat(h).saveCount,
  "nSaveLayer(JFFFFJ)I": (h: bigint, l: number, t: number, r: number, b: number, p: bigint) => {
    const nc = nat(h);
    return saveLayer(nc, { left: l, top: t, right: r, bottom: b }, optPaint(nc, p));
  },
  "nSaveLayerAlpha(JFFFFI)I": (h: bigint, l: number, t: number, r: number, b: number, alpha: number) =>
    saveLayer(nat(h), { left: l, top: t, right: r, bottom: b }, null, alpha & 255),
  "nSaveUnclippedLayer(JIIII)I": (h: bigint, l: number, t: number, r: number, b: number) => saveBehind(nat(h), l, t, r, b),
  "nRestoreUnclippedLayer(JIJ)V": (h: bigint, count: number, p: bigint) => { const nc = nat(h); restoreBehind(nc, count, nc.paint(p)); },

  "nTranslate(JFF)V": (h: bigint, x: number, y: number) => {
    const ctx = nat(h).ctx, m = ctx.getTransform();
    // a singular matrix stays singular: Canvas2D would drop a translate under one
    if (m.a * m.d === m.b * m.c) ctx.setTransform(m.a, m.b, m.c, m.d, m.e + m.a * x + m.c * y, m.f + m.b * x + m.d * y);
    else ctx.translate(x, y);
  },
  "nScale(JFF)V": (h: bigint, x: number, y: number) => nat(h).ctx.scale(x, y),
  "nRotate(JF)V": (h: bigint, d: number) => nat(h).ctx.rotate(Math.fround(d * Math.PI / 180)),
  "nSkew(JFF)V": (h: bigint, sx: number, sy: number) => nat(h).ctx.transform(1, sy, sx, 1, 0, 0),
  "nConcat(JJ)V": (h: bigint, m: bigint) => applyMatrix(nat(h).ctx, matrixAt(m)),
  // a Matrix44 (row-major 4x4): its 2D part, as SkM44::asM33 takes it
  "nConcat(J[F)V": (h: bigint, v: Float32Array) => nat(h).ctx.transform(v[0], v[4], v[1], v[5], v[3], v[7]),
  "nSetMatrix(JJ)V": (h: bigint, m: bigint) => { if (m) applyMatrix(nat(h).ctx, matrixAt(m), true); else nat(h).ctx.setTransform(1, 0, 0, 1, 0, 0); },
  "nGetMatrix(JJ)V": (h: bigint, into: bigint) => {
    const t = nat(h).ctx.getTransform();
    setAffine(matrixAt(into), t.a, t.b, t.c, t.d, t.e, t.f);
  },

  "nClipRect(JFFFFI)Z": (h: bigint, l: number, t: number, r: number, b: number, op: number) => {
    const nc = nat(h);
    return clipOp(nc, op, () => nc.clipRect(l, t, r, b), () => nc.clipOutRect(l, t, r, b));
  },
  "nClipPath(JJI)Z": (h: bigint, p: bigint, op: number) => {
    const nc = nat(h), path = pathAt(p);
    return clipOp(nc, op, () => nc.clipPath(path, false), () => nc.clipPath(path, true));
  },
  // a clip by a shader's coverage needs per-pixel clipping, which a 2D context's clip is not
  "nClipShader(JJI)V": unsupported("Canvas.clipShader"),
  "nGetClipBounds(JLandroid/graphics/Rect;)Z": (h: bigint, r: JRect) => +nat(h).clipBounds(r),
  "nQuickReject(JFFFF)Z": (h: bigint, l: number, t: number, r: number, b: number) => +nat(h).quickReject(l, t, r, b),
  "nQuickReject(JJ)Z": (h: bigint, p: bigint) => {
    const path = pathAt(p);
    if (!path.ops.length) return 1;
    path.bounds(pathBox);
    return +nat(h).quickReject(pathBox.left, pathBox.top, pathBox.right, pathBox.bottom);
  },
  // high-contrast text is an accessibility setting this device leaves off
  "nIsHighContrastText(J)Z": () => 0,
  "nSetDrawFilter(JJ)V": (h: bigint, f: bigint) => { nat(h).filter = f ? deref<{ clear: number; set: number }>(f) : null; },
  "nSetCompatibilityVersion(I)V": () => {},
  // nothing is cached natively, so there is nothing to free
  "nFreeCaches()V": () => {}, "nFreeTextLayoutCaches()V": () => {},
});
// PaintFlagsDrawFilter's native filter: the flags it clears and sets on every paint
rt.registerJnis("android/graphics/PaintFlagsDrawFilter", {
  "nativeConstructor(II)J": (clear: number, set: number) => ownedHandle({ clear, set }),
});
rt.registerJnis("android/graphics/DrawFilter", { "nativeDestructor(J)V": release });

/** BaseCanvas's draws, and BaseRecordingCanvas's, which record the same way into a display list */
const DRAWS: Record<string, unknown> = {
  "nDrawColor(JII)V": (h: bigint, c: number, mode: number) => drawColor(nat(h), c, mode),
  "nDrawColor(JJJI)V": (h: bigint, _cs: bigint, c: bigint, mode: number) => drawColor(nat(h), argbOfColorLong(c), mode),
  "nDrawPaint(JJ)V": (h: bigint, p: bigint) => { const nc = nat(h); drawPaint(nc, nc.paint(p)); },
  "nDrawRect(JFFFFJ)V": (h: bigint, l: number, t: number, r: number, b: number, p: bigint) => { const nc = nat(h); drawRect(nc, l, t, r, b, nc.paint(p)); },
  "nDrawRoundRect(JFFFFFFJ)V": (h: bigint, l: number, t: number, r: number, b: number, rx: number, ry: number, p: bigint) => {
    const nc = nat(h); drawRoundRect(nc, l, t, r, b, rx, ry, nc.paint(p));
  },
  "nDrawDoubleRoundRect(JFFFFFFFFFFFFJ)V": (h: bigint, ol: number, ot: number, or: number, ob: number, orx: number, ory: number,
    il: number, it: number, ir: number, ib: number, irx: number, iry: number, p: bigint) => {
    const nc = nat(h); drawDoubleRoundRect(nc, ol, ot, or, ob, orx, ory, il, it, ir, ib, irx, iry, nc.paint(p));
  },
  // per-corner radii; a 2D context's round rect takes one radius pair per corner as well
  "nDrawDoubleRoundRect(JFFFF[FFFFF[FJ)V": (h: bigint, ol: number, ot: number, or: number, ob: number, orad: Float32Array,
    il: number, it: number, ir: number, ib: number, irad: Float32Array, p: bigint) => {
    const nc = nat(h), ring = new Path2D(), corners = (r: Float32Array) => [0, 2, 4, 6].map((i) => ({ x: Math.max(r[i], 0), y: Math.max(r[i + 1], 0) }));
    ring.roundRect(ol, ot, or - ol, ob - ot, corners(orad));
    ring.roundRect(il, it, ir - il, ib - it, corners(irad));
    nc.drawShape(nc.paint(p), (x) => x.fill(ring, "evenodd"), (x) => x.stroke(ring));
  },
  "nDrawCircle(JFFFJ)V": (h: bigint, x: number, y: number, r: number, p: bigint) => { const nc = nat(h); drawCircle(nc, x, y, r, nc.paint(p)); },
  "nDrawOval(JFFFFJ)V": (h: bigint, l: number, t: number, r: number, b: number, p: bigint) => { const nc = nat(h); drawOval(nc, l, t, r, b, nc.paint(p)); },
  "nDrawArc(JFFFFFFZJ)V": (h: bigint, l: number, t: number, r: number, b: number, start: number, sweep: number, center: number, p: bigint) => {
    const nc = nat(h); drawArc(nc, l, t, r, b, start, sweep, center, nc.paint(p));
  },
  "nDrawLine(JFFFFJ)V": (h: bigint, x0: number, y0: number, x1: number, y1: number, p: bigint) => { const nc = nat(h); drawLine(nc, x0, y0, x1, y1, nc.paint(p)); },
  "nDrawLines(J[FIIJ)V": (h: bigint, pts: Float32Array, off: number, n: number, p: bigint) => { const nc = nat(h); drawLines(nc, pts, off, n, nc.paint(p)); },
  "nDrawPoint(JFFJ)V": (h: bigint, x: number, y: number, p: bigint) => {
    const nc = nat(h), paint = nc.paint(p);
    nc.prep(paint, false);
    nc.ctx.beginPath();
    pointPath(nc.ctx, x, y, paint);
    nc.ctx.fill();
  },
  "nDrawPoints(J[FIIJ)V": (h: bigint, pts: Float32Array, off: number, n: number, p: bigint) => { const nc = nat(h); drawPoints(nc, pts, off, n, nc.paint(p)); },
  "nDrawPath(JJJ)V": (h: bigint, path: bigint, p: bigint) => { const nc = nat(h); drawPath(nc, pathAt(path), nc.paint(p)); },
  "nDrawRegion(JJJ)V": (h: bigint, r: bigint, p: bigint) => { const nc = nat(h); drawRegion(nc, deref<NativeRegion>(r), nc.paint(p)); },
  "nDrawText(JLjava/lang/String;IIFFIJ)V": (h: bigint, s: string, start: number, end: number, x: number, y: number, _bidi: number, p: bigint) => {
    const nc = nat(h); drawText(nc, run(s, start, end), x, y, nc.paint(p));
  },
  "nDrawText(J[CIIFFIJ)V": (h: bigint, c: Uint16Array, i: number, n: number, x: number, y: number, _bidi: number, p: bigint) => {
    const nc = nat(h); drawText(nc, charsToString(c, i, n), x, y, nc.paint(p));
  },
  // a run is shaped in its context and drawn from start to end; one direction and one font here
  "nDrawTextRun(JLjava/lang/String;IIIIFFZJ)V": (h: bigint, s: string, start: number, end: number, _cs: number, _ce: number, x: number, y: number, _rtl: number, p: bigint) => {
    const nc = nat(h); drawText(nc, run(s, start, end), x, y, nc.paint(p));
  },
  "nDrawTextRun(J[CIIIIFFZJJ)V": (h: bigint, c: Uint16Array, i: number, n: number, _cs: number, _cc: number, x: number, y: number, _rtl: number, p: bigint) => {
    const nc = nat(h); drawText(nc, charsToString(c, i, n), x, y, nc.paint(p));
  },
  "nDrawTextOnPath(JLjava/lang/String;JFFIJ)V": (h: bigint, s: string, path: bigint, ho: number, vo: number, _bidi: number, p: bigint) => {
    const nc = nat(h); drawTextOnPath(nc, s, pathAt(path), ho, vo, nc.paint(p));
  },
  "nDrawTextOnPath(J[CIIJFFIJ)V": (h: bigint, c: Uint16Array, i: number, n: number, path: bigint, ho: number, vo: number, _bidi: number, p: bigint) => {
    const nc = nat(h); drawTextOnPath(nc, charsToString(c, i, n), pathAt(path), ho, vo, nc.paint(p));
  },
  "nDrawBitmap(JJFFJIII)V": (h: bigint, b: bigint, x: number, y: number, p: bigint, canvasDensity: number, _screen: number, bitmapDensity: number) => {
    const nc = nat(h); drawBitmapAt(nc, bitmapAt(b), x, y, optPaint(nc, p), canvasDensity, bitmapDensity);
  },
  "nDrawBitmap(JJFFFFFFFFJII)V": (h: bigint, b: bigint, sl: number, st: number, sr: number, sb: number, dl: number, dt: number, dr: number, db: number, p: bigint) => {
    const nc = nat(h);
    drawBitmap(nc, bitmapAt(b), optPaint(nc, p), (ctx, image) => ctx.drawImage(image, sl, st, sr - sl, sb - st, dl, dt, dr - dl, db - dt));
  },
  "nDrawBitmapMatrix(JJJJ)V": (h: bigint, b: bigint, m: bigint, p: bigint) => {
    const nc = nat(h);
    nc.ctx.save();
    try {
      applyMatrix(nc.ctx, matrixAt(m));
      drawBitmap(nc, bitmapAt(b), optPaint(nc, p), (ctx, image) => ctx.drawImage(image, 0, 0));
    } finally { nc.ctx.restore(); }
  },
  // colours rather than a Bitmap: put the pixels in one and draw that
  "nDrawBitmap(J[IIIFFIIZJ)V": (h: bigint, colors: Int32Array, offset: number, stride: number, x: number, y: number, w: number, ih: number, alpha: number, p: bigint) => {
    const nc = nat(h), b = new NativeBitmap(w, ih, ARGB_8888, alpha ? PREMUL : OPAQUE);
    setPixels(b, colors, offset, stride, 0, 0, w, ih);
    drawBitmap(nc, b, optPaint(nc, p), (ctx, image) => ctx.drawImage(image, x, y));
  },
  "nDrawNinePatch(JJJFFFFJII)V": (h: bigint, b: bigint, chunk: bigint, l: number, t: number, r: number, bo: number, p: bigint, dstDensity: number, srcDensity: number) => {
    const nc = nat(h); drawPatch(nc, bitmapAt(b), deref<NinePatchChunk>(chunk), l, t, r, bo, optPaint(nc, p), dstDensity, srcDensity);
  },
  "nPunchHole(JFFFFFFF)V": (h: bigint, l: number, t: number, r: number, b: number, rx: number, ry: number, alpha: number) => punchHole(nat(h), l, t, r, b, rx, ry, alpha),
  // meshes, vertices with per-vertex colours and bitmap meshes need triangle rasterization a 2D
  // context does not have
  // glyph runs from a font's outlines, which HarfBuzz reads (shaping.ts)
  "nDrawGlyphs(J[I[FIIIJJ)V": (h: bigint, ids: Int32Array, positions: Float32Array, idOffset: number, posOffset: number, count: number, font: bigint, p: bigint) => {
    const nc = nat(h), paint = nc.paint(p);
    return drawGlyphs((fill, stroke) => nc.drawShape(paint, fill, stroke), ids, idOffset, positions, posOffset, count, font, paint);
  },
  "nDrawMesh(JJIJ)V": unsupported("Canvas.drawMesh"),
  "nDrawVertices(JII[FI[FI[II[SIIJ)V": unsupported("Canvas.drawVertices"),
  "nDrawBitmapMesh(JJII[FI[IIJ)V": unsupported("Canvas.drawBitmapMesh"),
};
rt.registerJnis("android/graphics/BaseCanvas", DRAWS);
rt.registerJnis("android/graphics/BaseRecordingCanvas", DRAWS);

/** Canvas() with no bitmap: SkiaCanvas over an empty bitmap, which clips everything; its matrix
 *  is still its own */
const emptyCtx = () => new OffscreenCanvas(1, 1).getContext("2d")!;
/** SkiaCanvas over a bitmap's raster, or over none */
export const bitmapCanvas = (b: NativeBitmap | null): NativeCanvas => b ? NativeCanvas.over(b.ctx, b.w, b.h, b) : NativeCanvas.over(emptyCtx(), 0, 0);

// ── drawn text: where each run landed, which the harness looks text up by ──
export function locateDrawnText(owner: DrawnTextOwner, text: string, width: number, height: number): { x: number; y: number } | null {
  const runs = owner.drawnText;
  const points = owner.drawnTextPoints;
  const count = Math.min(owner.drawnTextCount, runs?.length ?? 0);
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const want = normalize(text);
  if (!runs || !points || !count || !want) return null;

  let best = 0, bestIndex = -1;
  const score = (candidate: string) => candidate === want ? 3 : candidate.startsWith(want) ? 2 : candidate.includes(want) ? 1 : 0;
  const consider = (candidate: string, index: number) => {
    const s = score(candidate);
    const x = points[index * 2], y = points[index * 2 + 1];
    if (s > best && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x < width && y >= 0 && y < height) {
      best = s;
      bestIndex = index;
    }
  };

  for (let i = 0; i < count; i++) consider(normalize(runs[i]), i);
  for (let i = 0; i < count; i++) {
    let phrase = normalize(runs[i]);
    for (let j = i + 1; j < count; j++) {
      phrase += " " + normalize(runs[j]);
      consider(phrase, i);
    }
  }
  return bestIndex < 0 ? null : { x: points[bestIndex * 2], y: points[bestIndex * 2 + 1] };
}
