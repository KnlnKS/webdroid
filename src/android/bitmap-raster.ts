// The draws into a bitmap that take Skia's raster rules (scan.ts) rather than the 2D context's:
// fills without anti-aliasing scan-converted, hairlines stepped, the thinnest anti-aliased ovals
// supersampled, and inverse fills and aliased strokes through their coverage (NativeCanvas.drawMask).
// Each takes the op its draw's plan (DrawPlan.raster) composites with: a solid colour without a mask
// filter, a shadow or a path effect other than a dash, by a mode that blends within what it covers.

import { type Band, devicePoint, hairlineLine, hairlineRect, scan } from "./scan.ts";
import { MAX_SAMPLED_PIXELS } from "./skia.ts";
import { NativePath } from "./path.ts";
import type { Ctx2D } from "./recording.ts";
import type { NativePaint } from "./paint.ts";
import type { NativeCanvas } from "./canvas.ts";
import type { Box } from "./graphics.ts";

/** `draw` in device pixels by `op` (after the paint's stroke setup when `stroke`), the context
 *  restored afterwards; the plan has ruled out a shader, so fill styles need no transform */
function inDevice(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, draw: (ctx: Ctx2D) => void, stroke = false): void {
  const ctx = canvas.ctx;
  ctx.save();
  try {
    if (stroke) canvas.prep(paint, true);
    ctx.resetTransform();
    ctx.globalCompositeOperation = op;
    draw(ctx);
  } finally { ctx.restore(); }
}
const deviceFill = (canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, pixels: Path2D): void =>
  inDevice(canvas, paint, op, (ctx) => { ctx.fillStyle = paint.fillStyle(ctx); ctx.fill(pixels); });

function deviceHairline(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, path: Path2D): void {
  const devicePath = new Path2D();
  devicePath.addPath(path, canvas.ctx.getTransform());
  inDevice(canvas, paint, op, (ctx) => ctx.stroke(devicePath), true);
}

/** a fill: a stroke-and-fill without width fills only */
const fills = (paint: NativePaint) => paint.style === 0 || paint.style === 2 && paint.strokeWidth === 0;
const shape = (build: (p: NativePath) => void) => { const p = new NativePath(); build(p); return p; };
const target: Box = { left: 0, top: 0, right: 0, bottom: 0 };
const spans = (bands: readonly Band[]): Path2D => {
  const pixels = new Path2D();
  for (const { top, bottom, xs } of bands) for (let i = 0; i < xs.length; i += 2) pixels.rect(xs[i], top, xs[i + 1] - xs[i], bottom - top);
  return pixels;
};
/** SkScan::FillPath of `path` under the canvas's matrix, without anti-aliasing; SkCanvas draws no
 *  path that is not finite */
function scanFill(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, path: NativePath): true {
  if (!path.finite()) return true;
  target.right = canvas.w; target.bottom = canvas.h;
  const bands = scan(path, target, canvas.ctx.getTransform());
  if (bands.length) deviceFill(canvas, paint, op, spans(bands));
  return true;
}

/** a stroke-and-fill without anti-aliasing into a bitmap small enough to read back: drawn through
 *  its coverage, thresholded (NativeCanvas.drawMask) */
export const aliasedStroke = (canvas: NativeCanvas, paint: NativePaint): boolean =>
  paint.style === 2 && paint.strokeWidth > 0 && !paint.antiAlias && !paint.dash && canvas.w * canvas.h <= MAX_SAMPLED_PIXELS;

/** SkScalarRoundToInt */
const round = (v: number) => Math.floor(Math.fround(v + 0.5));
export function tryBitmapRect(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, left: number, top: number,
  right: number, bottom: number): boolean {
  const m = canvas.ctx.getTransform();
  if (paint.style === 1 && paint.strokeWidth === 0) {
    if (m.a * m.d === m.b * m.c) return true;
    if (paint.dash) return false;
    if (paint.antiAlias) {
      const path = new Path2D();
      path.rect(left, top, right - left, bottom - top);
      deviceHairline(canvas, paint, op, path);
      return true;
    }
    const pixels = hairlineRect(canvas.ctx, left, top, right, bottom, paint.strokeCapN);
    if (pixels) deviceFill(canvas, paint, op, pixels);
    return !!pixels;
  }
  if (paint.antiAlias || !fills(paint)) return false;
  // SkDraw::drawRect: under a matrix that keeps rects rects, SkScan::FillRect of the rounded device
  // rect; under any other, the rect's path
  if (!(m.b === 0 && m.c === 0 || m.a === 0 && m.d === 0)) return scanFill(canvas, paint, op, shape((p) => p.addRect(left, top, right, bottom, 0)));
  const [x0, y0] = devicePoint(m, left, top), [x1, y1] = devicePoint(m, right, bottom);
  const l = round(Math.min(x0, x1)), t = round(Math.min(y0, y1)), r = round(Math.max(x0, x1)), b = round(Math.max(y0, y1));
  if (l < r && t < b) inDevice(canvas, paint, op, (ctx) => { ctx.fillStyle = paint.fillStyle(ctx); ctx.fillRect(l, t, r - l, b - t); });
  return true;
}

export function tryBitmapOval(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, left: number, top: number,
  right: number, bottom: number, sweep: number): boolean {
  if (Math.abs(sweep) < 360) return false;
  const oval = () => shape((p) => p.addOval(left, top, right, bottom, 0));
  if (!paint.antiAlias && fills(paint)) return scanFill(canvas, paint, op, oval());
  // an oval at most a pixel tall, whose coverage the 2D context's anti-aliasing misses: SkScan_AntiPath's
  // 4x4 supersamples, each pixel's supersample rows adding 16 per covered sample, or for a whole row
  // of the pixel 64 (63 on its last)
  if (!(paint.antiAlias && paint.style === 0 && bottom > top && bottom - top <= 1)) return false;
  const w = canvas.w;
  target.right = w * 4; target.bottom = canvas.h * 4;
  const alpha = new Map<number, number>();
  for (const { top: y0, bottom: y1, xs } of scan(oval(), target, canvas.ctx.getTransform(), 2)) for (let y = y0; y < y1; y++) {
    const row = (y >> 2) * w, whole = (y & 3) === 3 ? 63 : 64;
    for (let i = 0; i < xs.length; i += 2) for (let x = xs[i]; x < xs[i + 1];) {
      const px = x >> 2, end = Math.min(xs[i + 1], px * 4 + 4), n = end - x;
      alpha.set(row + px, (alpha.get(row + px) ?? 0) + (n === 4 ? whole : n * 16));
      x = end;
    }
  }
  const levels = new Map<number, Path2D>();
  for (const [i, a] of alpha) {
    let pixels = levels.get(a);
    if (!pixels) levels.set(a, pixels = new Path2D());
    pixels.rect(i % w, Math.floor(i / w), 1, 1);
  }
  inDevice(canvas, paint, op, (ctx) => {
    ctx.fillStyle = paint.fillStyle(ctx);
    for (const [a, pixels] of levels) { ctx.globalAlpha = a / 255; ctx.fill(pixels); }
  });
  return true;
}

export function tryBitmapRoundRect(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, left: number, top: number,
  right: number, bottom: number, rx: number, ry: number): boolean {
  if (paint.antiAlias || !fills(paint)) return false;
  return scanFill(canvas, paint, op, shape((p) => p.addRoundRect(left, top, right, bottom, [rx, ry, rx, ry, rx, ry, rx, ry], 0)));
}

export function tryBitmapLine(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation,
  x0: number, y0: number, x1: number, y1: number): boolean {
  if (paint.dash) return false;
  const ctx = canvas.ctx;
  if (paint.strokeWidth !== 0) {
    if (paint.strokeWidth !== 1 || paint.antiAlias) return false;
    const m = ctx.getTransform();
    if (m.a * m.a + m.b * m.b !== 1 || m.c * m.c + m.d * m.d !== 1 ||
      m.a * m.c + m.b * m.d !== 0) return false;
  }
  if (!paint.antiAlias) {
    const pixels = hairlineLine(ctx, x0, y0, x1, y1, paint.strokeCapN);
    if (!pixels) {
      if (paint.strokeWidth !== 1) return false;
      const m = ctx.getTransform(), start = devicePoint(m, x0, y0), end = devicePoint(m, x1, y1);
      return Math.max(start[0], end[0]) <= 0 || Math.min(start[0], end[0]) >= canvas.w ||
        Math.max(start[1], end[1]) <= 0 || Math.min(start[1], end[1]) >= canvas.h;
    }
    deviceFill(canvas, paint, op, pixels);
    return true;
  }
  const m = ctx.getTransform(), start = devicePoint(m, x0, y0), end = devicePoint(m, x1, y1);
  if (m.a * m.d === m.b * m.c || !start.every(Number.isFinite) || !end.every(Number.isFinite)) return false;
  inDevice(canvas, paint, op, (ctx) => { ctx.beginPath(); ctx.moveTo(...start); ctx.lineTo(...end); ctx.stroke(); }, true);
  return true;
}

/** an inverse path's coverage: the whole target less the path's fill, or its stroke in `stroke` */
function inverseCoverage(nc: NativeCanvas, path: NativePath, stroke: NativePaint | null) {
  const c = nc.ctx;
  c.save(); c.resetTransform(); c.fillStyle = "white"; c.fillRect(0, 0, nc.w, nc.h); c.restore();
  c.globalCompositeOperation = "destination-out";
  if (stroke) { nc.prep(stroke, true); c.stroke(path.path()); }
  else { c.fillStyle = "white"; c.fill(path.path(), path.fillRule); }
  c.globalCompositeOperation = "source-over";
}
export function tryBitmapPath(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, path: NativePath): boolean {
  if (fills(paint)) {
    if (!paint.antiAlias) return scanFill(canvas, paint, op, path);
    if (!path.inverseFill) return false;
    canvas.drawMask(paint, op, (nc) => inverseCoverage(nc, path, null));
    return true;
  }
  if (paint.style === 1 && paint.strokeWidth === 0) {
    if (!paint.antiAlias || paint.dash) return false;
    deviceHairline(canvas, paint, op, path.path());
    return true;
  }
  // SkStroke keeps the path's inverseness: everything outside the stroke, wherever the stroke is
  if (!path.inverseFill || paint.style !== 1 || paint.dash || !paint.antiAlias && canvas.w * canvas.h > MAX_SAMPLED_PIXELS) return false;
  canvas.drawMask(paint, op, (nc, white) => inverseCoverage(nc, path, white), !paint.antiAlias);
  return true;
}
