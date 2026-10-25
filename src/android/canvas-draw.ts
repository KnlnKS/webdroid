// BaseCanvas's draws (and BaseRecordingCanvas's, which record the same way into a display list):
// each SkCanvas::drawXxx as its geometry, drawn through the paint by NativeCanvas.drawShape or,
// for text and images, inside the same beginPaint bracket.

import { recordOrRun, type Ctx2D } from "./recording.ts";
import { tryBitmapLine, tryBitmapOval, tryBitmapPath, tryBitmapRect, tryBitmapRoundRect } from "./bitmap-raster.ts";
import { drawSkiaText, inversePath, SKIA_TEXT_FACE, SKIA_EMOJI_FACE } from "./skia.ts";
import { rt } from "../jvm/runtime.ts";
import { after } from "../jvm/natives/jentry.ts";
import { charsToString } from "../jvm/abi.ts";
import { deref } from "./handles.ts";
import { NativePath, pathAt } from "./path.ts";
import { PathMeasure } from "./pathmeasure.ts";
import type { NativeRegion } from "./region.ts";
import { NativeBitmap, bitmapAt, ALPHA_8, ARGB_8888, PREMUL, OPAQUE, setPixels, colorLongAt } from "./bitmap.ts";
import { drawGlyphs, cssFont, shapeTextRun, hyphenEdited, graphemes, clusterwise, shapeStyle } from "./shaping.ts";
import { withFonts } from "./fonts.ts";
import { advances, paintAdvance } from "./minikin.ts";
import { NativePaint, copyPaint, defaultPaint, underlinePosition, underlineThickness, strikeThruPosition, strikeThruThickness } from "./paint.ts";
import { CLEAR, DST, SRC_OVER, compositeOf, cssColor } from "./graphics.ts";
import { tintedBmp } from "./colorfilter.ts";
import { NativeBitmapShader } from "./shader.ts";
import { type NinePatchChunk, drawNinePatch } from "./ninepatch.ts";
import { applyMatrix, canvasLocalBounds, matrixAt } from "./matrix.ts";
import { type NativeCanvas, type DrawPlan, MASK, IMAGE, drawingCanvas, beginPaint, endPaint, saveLayer, unsupported } from "./canvas.ts";

export function drawPath(nc: NativeCanvas, path: NativePath, p: NativePaint): void | Promise<void> {
  const plan = nc.planDraw(p);
  if (plan.raster && tryBitmapPath(nc, p, plan.raster, path)) return;
  if (!path.inverseFill) {
    nc.drawShape(p, (c, clip) => clip ? c.clip(path.path(), path.fillRule) : c.fill(path.path(), path.fillRule), (c) => c.stroke(path.path()), () => path, plan);
    return;
  }
  const bounds = canvasLocalBounds(nc.ctx);
  if (!bounds) return;
  return after(inversePath(path, bounds[0], bounds[1], bounds[2], bounds[3]), ([inverse, rule]) => {
    nc.drawShape(p, (c, clip) => clip ? c.clip(inverse, rule) : c.fill(inverse, rule), (c) => c.stroke(path.path()));
  });
}
function drawRect(nc: NativeCanvas, l: number, t: number, r: number, b: number, p: NativePaint) {
  const left = Math.min(l, r), top = Math.min(t, b), width = Math.abs(r - l), height = Math.abs(b - t);
  if ((!width || !height) && p.style !== 1) return;
  const plan = nc.planDraw(p);
  if (plan.raster && tryBitmapRect(nc, p, plan.raster, left, top, left + width, top + height)) return;
  nc.drawShape(p, (c, clip) => { if (!clip) c.fillRect(left, top, width, height); else { c.beginPath(); c.rect(left, top, width, height); c.clip(); } },
    (c) => c.strokeRect(left, top, width, height),
    () => shapePath((g) => g.addRect(left, top, left + width, top + height, 0)), plan);
}
/** a shape as SkCanvas makes it a path, for a path effect */
function shapePath(build: (p: NativePath) => void): NativePath {
  const p = new NativePath();
  build(p);
  return p;
}
/** SkCanvas::drawColor: the whole clip filled with `color` under the SkBlendMode numbered `mode` */
function drawColor(nc: NativeCanvas, color: number, mode: number) {
  if (mode === DST) return;
  const fill = cssColor(color), op = mode === SRC_OVER ? null : compositeOf(mode);
  recordOrRun(nc.ctx, (ctx) => {
    ctx.save();
    ctx.resetTransform();
    if (mode === CLEAR) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    else {
      if (op) ctx.globalCompositeOperation = op;
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    }
    ctx.restore();
  });
}
/** ellipse arc in the box; a full sweep without the centre is drawOval */
function drawArc(nc: NativeCanvas, l: number, t: number, r: number, b: number, start: number, sweep: number, useCenter: number, p: NativePaint) {
  if (!(r > l && b > t) && Math.abs(sweep) < 360) return;
  const left = Math.min(l, r), top = Math.min(t, b), right = Math.max(l, r), bottom = Math.max(t, b);
  const plan = nc.planDraw(p);
  if (plan.raster && tryBitmapOval(nc, p, plan.raster, left, top, right, bottom, sweep)) return;
  const path = new Path2D();
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  if (useCenter) path.moveTo(cx, cy);
  path.ellipse(cx, cy, (right - left) / 2, (bottom - top) / 2, 0, start * Math.PI / 180, (start + sweep) * Math.PI / 180, sweep < 0);
  if (useCenter) path.closePath();
  // SkPathPriv::CreateDrawArcPath: a whole oval, or the arc, through the centre when it is used
  nc.drawShape(p, (c, clip) => clip ? c.clip(path) : c.fill(path), (c) => c.stroke(path), () => shapePath((g) => {
    if (!useCenter && Math.abs(sweep) >= 360) return g.addOval(left, top, right, bottom, sweep < 0 ? 1 : 0);
    if (useCenter) g.moveTo(cx, cy);
    g.arcTo(left, top, right, bottom, start, sweep, !useCenter);
    if (useCenter) g.close();
  }), plan);
}
function drawOval(nc: NativeCanvas, l: number, t: number, r: number, b: number, p: NativePaint) {
  if (l === r || t === b) return;
  drawArc(nc, Math.min(l, r), Math.min(t, b), Math.max(l, r), Math.max(t, b), 0, 360, 0, p);
}
export function drawCircle(nc: NativeCanvas, x: number, y: number, r: number, p: NativePaint) {
  if (r > 0) drawOval(nc, x - r, y - r, x + r, y + r, p);
}
const radii = (rx: number, ry: number) => ({ x: Math.max(rx, 0), y: Math.max(ry, 0) });
const cornerRadii = (r: Float32Array) => [radii(r[0], r[1]), radii(r[2], r[3]), radii(r[4], r[5]), radii(r[6], r[7])];
export function drawRoundRect(nc: NativeCanvas, l: number, t: number, r: number, b: number, rx: number, ry: number, p: NativePaint) {
  const left = Math.min(l, r), top = Math.min(t, b), width = Math.abs(r - l), height = Math.abs(b - t);
  if ((!width || !height) && p.style !== 1) return;
  const plan = nc.planDraw(p);
  if (plan.raster && tryBitmapRoundRect(nc, p, plan.raster, left, top, left + width, top + height, rx, ry)) return;
  const path = new Path2D();
  path.roundRect(left, top, width, height, radii(rx, ry));
  nc.drawShape(p, (c, clip) => clip ? c.clip(path) : c.fill(path), (c) => c.stroke(path), () => shapePath((g) => g.addRoundRect(left, top, left + width, top + height, [rx, ry, rx, ry, rx, ry, rx, ry], 0)), plan);
}
/** the ring between two round rects, each with one radius pair or one per corner (as a 2D
 *  context's roundRect takes them) */
function drawDoubleRoundRect(nc: NativeCanvas, ol: number, ot: number, or: number, ob: number, outer: DOMPointInit | DOMPointInit[],
  il: number, it: number, ir: number, ib: number, inner: DOMPointInit | DOMPointInit[], p: NativePaint) {
  const ring = new Path2D();
  ring.roundRect(ol, ot, or - ol, ob - ot, outer);
  ring.roundRect(il, it, ir - il, ib - it, inner);
  nc.drawShape(p, (x, clip) => clip ? x.clip(ring, "evenodd") : x.fill(ring, "evenodd"), (x) => x.stroke(ring));
}
/** android_graphics_Canvas: an offset/count pair outside the array draws nothing and throws */
function checkPts(pts: Float32Array, off: number, n: number) {
  if (!pts) rt.npe();
  if ((off | n) < 0 || off + n > pts.length) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", null);
}
/** SkDraw::drawPoints' lines through a path effect: each a path, always stroked */
function effectedLines(nc: NativeCanvas, pts: ArrayLike<number>, off: number, n: number, p: NativePaint) {
  const q = nc.restyle(p, 1);
  for (let i = off, end = off + (n & ~3); i < end; i += 4) {
    const g = new NativePath();
    g.moveTo(pts[i], pts[i + 1]); g.lineTo(pts[i + 2], pts[i + 3]);
    drawPath(nc, g, q);
  }
}
const NOOP = () => {};
/** SkDraw::drawPoints: lines stroked (style 1) and points filled (0), whatever the paint's style */
function drawAs(nc: NativeCanvas, p: NativePaint, style: number, draw: (c: Ctx2D, clip?: boolean) => void, plan?: DrawPlan) {
  nc.drawShape(nc.restyle(p, style), style ? NOOP : draw, style ? draw : NOOP, undefined, plan);
}
function drawLine(nc: NativeCanvas, x0: number, y0: number, x1: number, y1: number, p: NativePaint) {
  if (p.pathEffect && !p.dash) return effectedLines(nc, [x0, y0, x1, y1], 0, 4, p);
  const plan = nc.planDraw(p);
  if (plan.raster && tryBitmapLine(nc, p, plan.raster, x0, y0, x1, y1)) return;
  drawAs(nc, p, 1, (c) => { c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); }, plan);
}
function drawLines(nc: NativeCanvas, pts: Float32Array, off: number, n: number, p: NativePaint) {
  checkPts(pts, off, n);
  if (p.pathEffect && !p.dash) return effectedLines(nc, pts, off, n, p);
  drawAs(nc, p, 1, (c) => {
    c.beginPath();
    for (let i = off, end = off + (n & ~3); i < end; i += 4) {
      c.moveTo(pts[i], pts[i + 1]);
      c.lineTo(pts[i + 2], pts[i + 3]);
    }
    c.stroke();
  });
}
/** Skia draws a point as the stroke's cap: a disc for a round cap, otherwise a square; a
 *  hairline point is one pixel */
function pointPath(ctx: Ctx2D, x: number, y: number, p: NativePaint) {
  const w = p.strokeWidth || 1, r = w / 2;
  if (p.strokeCapN === "round" && p.strokeWidth) { ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 2 * Math.PI); } else ctx.rect(x - r, y - r, w, w);
}
function drawPoints(nc: NativeCanvas, pts: Float32Array, off: number, n: number, p: NativePaint) {
  checkPts(pts, off, n);
  drawAs(nc, p, 0, (c, clip) => {
    c.beginPath();
    for (let i = off, end = off + (n & ~1); i < end; i += 2) pointPath(c, pts[i], pts[i + 1], p);
    if (clip) c.clip(); else c.fill();
  });
}
function drawRegion(nc: NativeCanvas, region: NativeRegion, p: NativePaint) {
  const path = new Path2D();
  region.forEachRect((l, t, r, b) => path.rect(l, t, r - l, b - t));
  nc.drawShape(p, (c, clip) => clip ? c.clip(path) : c.fill(path), (c) => c.stroke(path));
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

/** an image drawn through the paint as SkCanvas::drawImageRect does, into the destination rect from
 *  the source rect (the whole bitmap when there is none): its alpha, colour filter, blend mode and
 *  shadow; an ALPHA_8 bitmap is coverage, drawn in the paint's colour */
export function drawBitmap(nc: NativeCanvas, b: NativeBitmap, paint: NativePaint | null, dx: number, dy: number, dw: number, dh: number,
  sx?: number, sy?: number, sw?: number, sh?: number) {
  const p = paint ?? defaultPaint, alpha8 = b.config === ALPHA_8, plan = nc.planDraw(p, alpha8 ? MASK : IMAGE);
  if (plan.mode === DST) return;
  const op = plan.op, unbounded = plan.unbounded;
  if (plan.viaMask) return maskBitmap(nc, b, p, op, dx, dy, dw, dh, sx, sy, sw, sh);
  const ctx = nc.ctx, clear = plan.mode === CLEAR;
  // CLEAR ignores the source: what the image covers is its destination rect
  if (clear && !alpha8) return ctx.clearRect(dx, dy, dw, dh);
  const source = alpha8 ? tintedBmp(b, clear ? -16777216 : p.filteredColor()) : p.colorFilter?.image(b) ?? b.image;
  const undo = beginPaint(ctx, p, op, !alpha8, null);
  try {
    if (!unbounded) image(ctx, source, dx, dy, dw, dh, sx, sy, sw, sh);
    else {
      // the image covers its destination rect, which bounds the blend
      ctx.save();
      try { ctx.beginPath(); ctx.rect(dx, dy, dw, dh); ctx.clip(); image(ctx, source, dx, dy, dw, dh, sx, sy, sw, sh); }
      finally { ctx.restore(); }
    }
  } finally { endPaint(ctx, undo); }
}
function maskBitmap(nc: NativeCanvas, b: NativeBitmap, p: NativePaint, op: GlobalCompositeOperation | null, dx: number, dy: number, dw: number, dh: number,
  sx?: number, sy?: number, sw?: number, sh?: number) {
  nc.drawMask(p, op, (m) => image(m.ctx, b.image, dx, dy, dw, dh, sx, sy, sw, sh));
}
const image = (ctx: Ctx2D, source: CanvasImageSource, dx: number, dy: number, dw: number, dh: number, sx?: number, sy?: number, sw?: number, sh?: number) =>
  sw === undefined ? ctx.drawImage(source, dx, dy, dw, dh) : ctx.drawImage(source, sx!, sy!, sw, sh!, dx, dy, dw, dh);
/** android_graphics_Canvas drawBitmap: a bitmap of another density than the canvas's is drawn in
 *  its own pixels under the scale between them */
function drawBitmapAt(nc: NativeCanvas, b: NativeBitmap, x: number, y: number, paint: NativePaint | null, canvasDensity: number, bitmapDensity: number) {
  if (canvasDensity === bitmapDensity || !canvasDensity || !bitmapDensity) {
    drawBitmap(nc, b, paint, x, y, b.w, b.h);
    return;
  }
  const s = Math.fround(canvasDensity / bitmapDensity);
  nc.ctx.save();
  try {
    nc.ctx.translate(x, y);
    nc.ctx.scale(s, s);
    drawBitmap(nc, b, paint, 0, 0, b.w, b.h);
  } finally { nc.ctx.restore(); }
}
/** Canvas.drawPatch as android_graphics_Canvas draws it, the lattice through the paint as
 *  drawBitmap's image is (NinePatchDrawable's tint is its paint's colour filter): a patch of another
 *  density is drawn in its own pixels under a scale. Under an unbounded mode each piece would clear
 *  the others, so the lattice is drawn into a layer that blends once. */
function drawPatch(nc: NativeCanvas, bmp: NativeBitmap, chunk: NinePatchChunk, l: number, t: number, r: number, b: number, paint: NativePaint | null, dstDensity: number, srcDensity: number) {
  const p = paint ?? defaultPaint, plan = nc.planDraw(p, IMAGE);
  if (plan.mode === DST) return;
  if (plan.unbounded) {
    const count = saveLayer(nc, { left: l, top: t, right: r, bottom: b }, p);
    try { ninePatch(nc.ctx, bmp.image, bmp, chunk, l, t, r, b, dstDensity, srcDensity); } finally { nc.restoreToCount(count); }
    return;
  }
  const ctx = nc.ctx, undo = beginPaint(ctx, p, plan.op, true, null);
  try { ninePatch(ctx, p.colorFilter?.image(bmp) ?? bmp.image, bmp, chunk, l, t, r, b, dstDensity, srcDensity); }
  finally { endPaint(ctx, undo); }
}
function ninePatch(ctx: Ctx2D, image: CanvasImageSource, bmp: NativeBitmap, chunk: NinePatchChunk, l: number, t: number, r: number, b: number, dstDensity: number, srcDensity: number) {
  if (dstDensity === srcDensity || !dstDensity || !srcDensity) return drawNinePatch(ctx, image, bmp.w, bmp.h, chunk, l, t, r - l, b - t);
  const s = dstDensity / srcDensity;
  ctx.save();
  try {
    ctx.translate(l, t);
    ctx.scale(s, s);
    drawNinePatch(ctx, image, bmp.w, bmp.h, chunk, 0, 0, (r - l) / s, (b - t) / s);
  } finally { ctx.restore(); }
}
/** a plain run into a bitmap in the faces CanvasKit has, drawn as Skia draws minikin's glyphs (with
 *  the paint's hyphen edits) */
function tryDrawBitmapText(nc: NativeCanvas, s: string, x: number, y: number, p: NativePaint): boolean {
  if (!(nc.bmp && (p.style === 0 || p.style === 2 && p.strokeWidth === 0 ||
    p.style === 1 && p.strokeWidth === 0 && p.strokeCapN === "butt" && p.strokeJoinN === "miter" && !p.dash) &&
    p.antiAlias && p.textAlignN === 0 && !p.letterSpacingEm && p.textScaleX === 1 && !p.textSkewX &&
    !p.underline && !p.strikeThru && !p.shader && !p.maskFilter && !p.pathEffect && !p.shadowRadius &&
    !p.colorFilter && p.blend === SRC_OVER && skiaFace(p))) return false;
  const l = shapeTextRun(s, 0, s.length, 0, s.length, false, p);
  if (l instanceof Promise) return false;
  const path = l.fonts[0]?.font.path;
  if (path !== SKIA_TEXT_FACE && path !== SKIA_EMOJI_FACE || !l.fonts.every((f) => f.font.path === path)) return false;
  const positions = new Float32Array(l.ids.length * 2);
  for (let i = 0; i < l.ids.length; i++) { positions[i * 2] = l.x[i]; positions[i * 2 + 1] = l.y[i]; }
  return drawSkiaText(nc.ctx, path === SKIA_EMOJI_FACE, Uint16Array.from(l.ids), positions, x, y, p.textSize, p.color,
    p.style === 1 ? "hairline" : "fill", p.subpixelText || p.linearText);
}
/** whether the paint draws in the face CanvasKit has: the system Roboto's default instance */
function skiaFace(p: NativePaint): boolean {
  const f = p.primary(), fvar = f.font.fvarAxes;
  return f.font.path === SKIA_TEXT_FACE && !f.fakery && f.weight === 400 && f.italic !== 1 && f.font.axes.every((a) => fvar.find((x) => x.tag === a.tag)?.def === a.value);
}
/** Canvas::drawText with the paint's hyphen edits; its fonts are loaded first (throwing
 *  FontPending), before the canvas is touched */
function drawText(nc: NativeCanvas, text: string, x: number, y: number, p: NativePaint) {
  const s = p.startHyphenEdit || p.endHyphenEdit ? hyphenEdited(text, p) : text, font = cssFont(s, p);
  if (tryDrawBitmapText(nc, text, x, y, p)) return;
  const plan = nc.planDraw(p);
  if (plan.mode === DST) return;
  if (plan.viaMask) return maskText(nc, text, s, font, x, y, p, plan.op);
  const undo = beginPaint(nc.ctx, p, plan.op, p.shader !== null, plan.blur);
  try { textRun(nc, text, s, font, x, y, p); } finally { endPaint(nc.ctx, undo); }
}
function maskText(nc: NativeCanvas, text: string, s: string, font: string, x: number, y: number, p: NativePaint, op: GlobalCompositeOperation | null) {
  nc.drawMask(p, op, (m, q) => textRun(m, text, s, font, x, y, q));
}
/** the run `s` (`text` hyphen-edited) as the paint draws it, filled, stroked or both, and its
 *  decorations */
function textRun(nc: NativeCanvas, text: string, s: string, font: string, x: number, y: number, p: NativePaint) {
  const ctx = nc.ctx;
  // SkFont's scale and skew: the glyphs under [scaleX skewX; 0 1] at the origin of the run
  const warped = p.textScaleX !== 1 || p.textSkewX !== 0;
  ctx.font = font;
  ctx.textRendering = "geometricPrecision";
  if ("lang" in ctx) ctx.lang = p.language;
  if (warped) { ctx.save(); ctx.transform(p.textScaleX, 0, p.textSkewX, 1, x - p.textScaleX * x - p.textSkewX * y, 0); }
  nc.prep(p, false);
  // Android draws a run's glyphs at minikin's hinted advances and Chrome at its own unhinted ones,
  // ending a long row pixels short: a run that can is drawn a cluster at a time where minikin places it
  const start = !warped && s === text && clusterwise(s) ? placeClusters(s, x, p) : null;
  ctx.textAlign = start !== null || p.textAlignN === 0 ? "left" : p.textAlignN === 1 ? "center" : "right";
  ctx.textBaseline = "alphabetic";
  const spaced = start === null && p.letterSpacingEm && "letterSpacing" in ctx;
  if (spaced) ctx.letterSpacing = `${p.letterSpacingEm * p.textSize}px`;
  const draw = (op: typeof ctx.fillText) => start === null ? op.call(ctx, s, x, y) : eachCluster(s, start, (piece, at) => op.call(ctx, piece, at, y));
  if (p.style !== 1) draw(ctx.fillText);
  if (p.style === 1 || p.style === 2 && p.strokeWidth !== 0) {
    nc.prep(p, true);
    draw(ctx.strokeText);
  }
  if (spaced) ctx.letterSpacing = "0px";
  if (warped) ctx.restore();
  // Canvas::drawTextDecorations: rects at least a pixel thick across the run's advance
  if (p.underline || p.strikeThru) {
    const w = paintAdvance(p, text);
    const sx = p.textAlignN === 1 ? x - w / 2 : p.textAlignN === 2 ? x - w : x;
    nc.prep(p, false);
    if (p.underline) ctx.fillRect(sx, y + underlinePosition(p), w, Math.max(1, underlineThickness(p)));
    if (p.strikeThru) ctx.fillRect(sx, y + strikeThruPosition(p), w, Math.max(1, strikeThruThickness(p)));
  }
}
let clusterAdvances = new Float32Array(64);
/** places `s`'s clusters at minikin's advances, letter and word spacing included (a cluster's advance is its first char's, its other chars'
 *  none), and answers the x its first starts at under the paint's alignment at `x` */
function placeClusters(s: string, x: number, p: NativePaint): number {
  if (clusterAdvances.length < s.length) clusterAdvances = new Float32Array(s.length * 2);
  const total = advances(shapeStyle(p), s, 0, s.length, clusterAdvances);
  return p.textAlignN === 1 ? x - total / 2 : p.textAlignN === 2 ? x - total : x;
}
/** each cluster placeClusters placed of `s`, from `at`; spaces draw nothing */
function eachCluster(s: string, at: number, draw: (piece: string, x: number) => void) {
  const w = clusterAdvances;
  for (let i = 0; i < s.length;) {
    let j = i + 1;
    while (j < s.length && w[j] === 0) j++;
    if (j > i + 1 || s.charCodeAt(i) !== 0x20) draw(s.slice(i, j), at);
    at += w[i];
    i = j;
  }
}
const onPath = new PathMeasure(), posTan = new Float32Array(4);
/** Canvas::drawTextOnPath (SkiaCanvas::drawLayoutOnPath): each cluster placed at the middle of its
 *  advance along the path's first contour and turned to its tangent, the alignment an offset of
 *  the whole run against the contour's length */
function drawTextOnPath(nc: NativeCanvas, s: string, path: NativePath, hOffset: number, vOffset: number, p: NativePaint) {
  cssFont(s, p);
  onPath.setPath(path, false);
  const align = p.textAlignN;
  let q = p;
  if (align) {
    hOffset += (align === 1 ? -0.5 : -1) * (paintAdvance(p, s) - onPath.length());
    copyPaint(p, q = new NativePaint());
    q.textAlignN = 0;
  }
  let x = 0;
  for (const { segment } of graphemes.segment(s)) {
    const w = paintAdvance(q, segment), half = w / 2, at = hOffset + x + half;
    let px = at, py = vOffset, tx = 1, ty = 0;
    if (onPath.getPosTan(at, posTan, posTan.subarray(2))) { px = posTan[0]; py = posTan[1]; tx = posTan[2]; ty = posTan[3]; }
    nc.ctx.save();
    try {
      nc.ctx.transform(tx, ty, -ty, tx, px - ty * vOffset - half * tx, py + tx * vOffset - half * ty);
      drawText(nc, segment, 0, 0, q);
    } finally { nc.ctx.restore(); }
    x += w;
  }
}
/** the text a run names, without a copy for the whole string */
const run = (s: string, start: number, end: number) => (start === 0 && end === s.length ? s : s.slice(start, end));
// The text natives draw again once a font they reached has loaded; their char arrays are read first.
const textAt = (h: bigint, text: string, x: number, y: number, p: bigint) =>
  withFonts(() => { const nc = drawingCanvas(h); drawText(nc, text, x, y, nc.paint(p)); });
const textOnPathAt = (h: bigint, text: string, path: bigint, ho: number, vo: number, p: bigint) =>
  withFonts(() => { const nc = drawingCanvas(h); drawTextOnPath(nc, text, pathAt(path), ho, vo, nc.paint(p)); });

// ── natives ──
const optPaint = (nc: NativeCanvas, h: bigint) => (h ? nc.paint(h) : null);
const DRAWS: Record<string, unknown> = {
  "nDrawColor(JII)V": (h: bigint, c: number, mode: number) => drawColor(drawingCanvas(h), c, mode),
  "nDrawColor(JJJI)V": (h: bigint, cs: bigint, c: bigint, mode: number) => drawColor(drawingCanvas(h), colorLongAt(c, cs), mode),
  "nDrawPaint(JJ)V": (h: bigint, p: bigint) => { const nc = drawingCanvas(h); nc.drawPaint(nc.paint(p)); },
  "nDrawRect(JFFFFJ)V": (h: bigint, l: number, t: number, r: number, b: number, p: bigint) => { const nc = drawingCanvas(h); drawRect(nc, l, t, r, b, nc.paint(p)); },
  "nDrawRoundRect(JFFFFFFJ)V": (h: bigint, l: number, t: number, r: number, b: number, rx: number, ry: number, p: bigint) => {
    const nc = drawingCanvas(h); drawRoundRect(nc, l, t, r, b, rx, ry, nc.paint(p));
  },
  "nDrawDoubleRoundRect(JFFFFFFFFFFFFJ)V": (h: bigint, ol: number, ot: number, or: number, ob: number, orx: number, ory: number,
    il: number, it: number, ir: number, ib: number, irx: number, iry: number, p: bigint) => {
    const nc = drawingCanvas(h); drawDoubleRoundRect(nc, ol, ot, or, ob, radii(orx, ory), il, it, ir, ib, radii(irx, iry), nc.paint(p));
  },
  "nDrawDoubleRoundRect(JFFFF[FFFFF[FJ)V": (h: bigint, ol: number, ot: number, or: number, ob: number, orad: Float32Array,
    il: number, it: number, ir: number, ib: number, irad: Float32Array, p: bigint) => {
    const nc = drawingCanvas(h); drawDoubleRoundRect(nc, ol, ot, or, ob, cornerRadii(orad), il, it, ir, ib, cornerRadii(irad), nc.paint(p));
  },
  "nDrawCircle(JFFFJ)V": (h: bigint, x: number, y: number, r: number, p: bigint) => { const nc = drawingCanvas(h); drawCircle(nc, x, y, r, nc.paint(p)); },
  "nDrawOval(JFFFFJ)V": (h: bigint, l: number, t: number, r: number, b: number, p: bigint) => { const nc = drawingCanvas(h); drawOval(nc, l, t, r, b, nc.paint(p)); },
  "nDrawArc(JFFFFFFZJ)V": (h: bigint, l: number, t: number, r: number, b: number, start: number, sweep: number, center: number, p: bigint) => {
    const nc = drawingCanvas(h); drawArc(nc, l, t, r, b, start, sweep, center, nc.paint(p));
  },
  "nDrawLine(JFFFFJ)V": (h: bigint, x0: number, y0: number, x1: number, y1: number, p: bigint) => { const nc = drawingCanvas(h); drawLine(nc, x0, y0, x1, y1, nc.paint(p)); },
  "nDrawLines(J[FIIJ)V": (h: bigint, pts: Float32Array, off: number, n: number, p: bigint) => { const nc = drawingCanvas(h); drawLines(nc, pts, off, n, nc.paint(p)); },
  "nDrawPoint(JFFJ)V": (h: bigint, x: number, y: number, p: bigint) => {
    const nc = drawingCanvas(h), paint = nc.paint(p);
    drawAs(nc, paint, 0, (c, clip) => { c.beginPath(); pointPath(c, x, y, paint); if (clip) c.clip(); else c.fill(); });
  },
  "nDrawPoints(J[FIIJ)V": (h: bigint, pts: Float32Array, off: number, n: number, p: bigint) => { const nc = drawingCanvas(h); drawPoints(nc, pts, off, n, nc.paint(p)); },
  "nDrawPath(JJJ)V": (h: bigint, path: bigint, p: bigint) => { const nc = drawingCanvas(h); return drawPath(nc, pathAt(path), nc.paint(p)); },
  "nDrawRegion(JJJ)V": (h: bigint, r: bigint, p: bigint) => { const nc = drawingCanvas(h); drawRegion(nc, deref<NativeRegion>(r), nc.paint(p)); },
  "nDrawText(JLjava/lang/String;IIFFIJ)V": (h: bigint, s: string, start: number, end: number, x: number, y: number, _bidi: number, p: bigint) =>
    textAt(h, run(s, start, end), x, y, p),
  "nDrawText(J[CIIFFIJ)V": (h: bigint, c: Uint16Array, i: number, n: number, x: number, y: number, _bidi: number, p: bigint) =>
    textAt(h, charsToString(c, i, n), x, y, p),
  // a run is shaped in its context and drawn from start to end; one direction and one font here
  "nDrawTextRun(JLjava/lang/String;IIIIFFZJ)V": (h: bigint, s: string, start: number, end: number, _cs: number, _ce: number, x: number, y: number, _rtl: number, p: bigint) =>
    textAt(h, run(s, start, end), x, y, p),
  "nDrawTextRun(J[CIIIIFFZJJ)V": (h: bigint, c: Uint16Array, i: number, n: number, _cs: number, _cc: number, x: number, y: number, _rtl: number, p: bigint) =>
    textAt(h, charsToString(c, i, n), x, y, p),
  "nDrawTextOnPath(JLjava/lang/String;JFFIJ)V": (h: bigint, s: string, path: bigint, ho: number, vo: number, _bidi: number, p: bigint) =>
    textOnPathAt(h, s, path, ho, vo, p),
  "nDrawTextOnPath(J[CIIJFFIJ)V": (h: bigint, c: Uint16Array, i: number, n: number, path: bigint, ho: number, vo: number, _bidi: number, p: bigint) =>
    textOnPathAt(h, charsToString(c, i, n), path, ho, vo, p),
  "nDrawBitmap(JJFFJIII)V": (h: bigint, b: bigint, x: number, y: number, p: bigint, canvasDensity: number, _screen: number, bitmapDensity: number) => {
    const nc = drawingCanvas(h); drawBitmapAt(nc, bitmapAt(b), x, y, optPaint(nc, p), canvasDensity, bitmapDensity);
  },
  "nDrawBitmap(JJFFFFFFFFJII)V": (h: bigint, b: bigint, sl: number, st: number, sr: number, sb: number, dl: number, dt: number, dr: number, db: number, p: bigint) => {
    const nc = drawingCanvas(h);
    drawBitmap(nc, bitmapAt(b), optPaint(nc, p), dl, dt, dr - dl, db - dt, sl, st, sr - sl, sb - st);
  },
  "nDrawBitmapMatrix(JJJJ)V": (h: bigint, b: bigint, m: bigint, p: bigint) => {
    const nc = drawingCanvas(h), bmp = bitmapAt(b);
    nc.ctx.save();
    try {
      applyMatrix(nc.ctx, matrixAt(m));
      drawBitmap(nc, bmp, optPaint(nc, p), 0, 0, bmp.w, bmp.h);
    } finally { nc.ctx.restore(); }
  },
  // colours rather than a Bitmap: put the pixels in one and draw that
  "nDrawBitmap(J[IIIFFIIZJ)V": (h: bigint, colors: Int32Array, offset: number, stride: number, x: number, y: number, w: number, ih: number, alpha: number, p: bigint) => {
    const nc = drawingCanvas(h), b = new NativeBitmap(w, ih, ARGB_8888, alpha ? PREMUL : OPAQUE);
    setPixels(b, colors, offset, stride, 0, 0, w, ih);
    drawBitmap(nc, b, optPaint(nc, p), x, y, w, ih);
  },
  "nDrawNinePatch(JJJFFFFJII)V": (h: bigint, b: bigint, chunk: bigint, l: number, t: number, r: number, bo: number, p: bigint, dstDensity: number, srcDensity: number) => {
    const nc = drawingCanvas(h); drawPatch(nc, bitmapAt(b), deref<NinePatchChunk>(chunk), l, t, r, bo, optPaint(nc, p), dstDensity, srcDensity);
  },
  "nPunchHole(JFFFFFFF)V": (h: bigint, l: number, t: number, r: number, b: number, rx: number, ry: number, alpha: number) => punchHole(drawingCanvas(h), l, t, r, b, rx, ry, alpha),
  // glyph runs from a font's outlines, which HarfBuzz reads (shaping.ts)
  "nDrawGlyphs(J[I[FIIIJJ)V": (h: bigint, ids: Int32Array, positions: Float32Array, idOffset: number, posOffset: number, count: number, font: bigint, p: bigint) => {
    const nc = drawingCanvas(h), paint = nc.paint(p);
    return drawGlyphs((fill, stroke) => {
      // a run's fill cannot clip to its outlines, so a shader that fills under a clip draws through their coverage
      const plan = nc.planDraw(paint), shader = paint.shader;
      plan.viaMask ||= shader instanceof NativeBitmapShader || !!shader?.local;
      nc.drawShape(paint, fill, stroke, undefined, plan);
    }, ids, idOffset, positions, posOffset, count, font, paint);
  },
  // meshes, vertices with per-vertex colours and bitmap meshes need triangle rasterization a 2D
  // context does not have
  "nDrawMesh(JJIJ)V": unsupported("Canvas.drawMesh"),
  "nDrawVertices(JII[FI[FI[II[SIIJ)V": unsupported("Canvas.drawVertices"),
  "nDrawBitmapMesh(JJII[FI[IIJ)V": unsupported("Canvas.drawBitmapMesh"),
};
rt.registerJnis("android/graphics/BaseCanvas", DRAWS);
rt.registerJnis("android/graphics/BaseRecordingCanvas", DRAWS);
