// The draws into a bitmap that take Skia's own raster rules (hairline.ts) rather than the 2D
// context's: aliased fills, hairlines, aliased stroke-and-fills and inverse fills, in device pixels.

import { MAX_SAMPLED_PIXELS, devicePoint, hairlineLine, hairlineRect, sampledCoverage, sampledFill } from "./hairline.ts";
import type { NativePath } from "./path.ts";
import type { Ctx2D } from "./recording.ts";
import { type NativePaint, applyStroke } from "./paint.ts";
import type { NativeCanvas } from "./canvas.ts";

// Each hook takes the op its draw's plan (DrawPlan.raster) composites with: a solid colour without
// a mask filter, a shadow or a path effect other than a dash, by a mode that blends within what it covers.

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
const composite = (canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, image: OffscreenCanvas): void =>
  inDevice(canvas, paint, op, (ctx) => ctx.drawImage(image, 0, 0));

function sampled(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, left: number, top: number, right: number, bottom: number,
  contains: (x: number, y: number) => boolean): boolean {
  const pixels = sampledFill(canvas.ctx, left, top, right, bottom, contains);
  if (!pixels) return false;
  deviceFill(canvas, paint, op, pixels);
  return true;
}

function shapeMask(canvas: NativeCanvas, paint: NativePaint,
  fill: (ctx: Ctx2D) => void, stroke: (ctx: Ctx2D) => void): OffscreenCanvas {
  const image = new OffscreenCanvas(canvas.w, canvas.h);
  const ctx = image.getContext("2d")!;
  ctx.setTransform(canvas.ctx.getTransform());
  ctx.fillStyle = ctx.strokeStyle = "white";
  applyStroke(ctx, paint.strokeWidth, paint.antiAlias, paint.strokeCapN, paint.strokeJoinN, paint.strokeMiter);
  ctx.setLineDash(paint.dash ?? []);
  if (paint.style !== 1) fill(ctx);
  if (paint.style === 1 || paint.style === 2 && paint.strokeWidth !== 0) stroke(ctx);
  if (!paint.antiAlias) {
    const pixels = ctx.getImageData(0, 0, canvas.w, canvas.h);
    for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = pixels.data[i]! >= 128 ? 255 : 0;
    ctx.resetTransform(); ctx.putImageData(pixels, 0, 0);
  }
  return image;
}

function deviceHairline(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, path: Path2D): void {
  const devicePath = new Path2D();
  devicePath.addPath(path, canvas.ctx.getTransform());
  inDevice(canvas, paint, op, (ctx) => ctx.stroke(devicePath), true);
}

export function tryBitmapShape(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation,
  fill: (ctx: Ctx2D) => void, stroke: (ctx: Ctx2D) => void): boolean {
  if (paint.style !== 2 || paint.strokeWidth <= 0 || paint.antiAlias || paint.dash ||
    canvas.w * canvas.h > MAX_SAMPLED_PIXELS) return false;
  const image = shapeMask(canvas, paint, fill, stroke);
  const layer = image.getContext("2d")!;
  layer.globalCompositeOperation = "source-in";
  layer.fillStyle = paint.fillStyle(layer) as string;
  layer.fillRect(0, 0, canvas.w, canvas.h);
  composite(canvas, paint, op, image);
  return true;
}

export function tryBitmapRect(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, left: number, top: number,
  right: number, bottom: number): boolean {
  if (paint.style === 1 && paint.strokeWidth === 0) {
    const m = canvas.ctx.getTransform();
    if (m.a * m.d === m.b * m.c) return true;
  }
  if (paint.antiAlias && paint.style === 1 && paint.strokeWidth === 0 && !paint.dash) {
    const path = new Path2D();
    path.rect(left, top, right - left, bottom - top);
    deviceHairline(canvas, paint, op, path);
    return true;
  }
  if (paint.antiAlias || paint.style === 1 && paint.strokeWidth !== 0 ||
    paint.style === 2 && paint.strokeWidth !== 0) return false;
  if (paint.style === 0 || paint.style === 2 && paint.strokeWidth === 0) {
    const m = canvas.ctx.getTransform();
    const aligned = m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 &&
      Number.isInteger(left + m.e) && Number.isInteger(top + m.f) &&
      Number.isInteger(right + m.e) && Number.isInteger(bottom + m.f);
    if (!aligned && sampled(canvas, paint, op, left, top, right, bottom,
      (x, y) => x > left && x < right && y >= top && y < bottom)) return true;
  }
  if (paint.style === 1 && paint.strokeWidth === 0 && !paint.dash) {
    const pixels = hairlineRect(canvas.ctx, left, top, right, bottom, paint.strokeCapN);
    if (pixels) { deviceFill(canvas, paint, op, pixels); return true; }
  }
  return false;
}

export function tryBitmapOval(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, left: number, top: number,
  right: number, bottom: number, sweep: number): boolean {
  if (Math.abs(sweep) < 360) return false;
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const rx = (right - left) / 2, ry = (bottom - top) / 2;
  const contains = (x: number, y: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  if (!paint.antiAlias && (paint.style === 0 || paint.style === 2 && paint.strokeWidth === 0) &&
    right > left && bottom > top && sampled(canvas, paint, op, left, top, right, bottom, contains)) return true;
  if (!(paint.antiAlias && paint.style === 0 && bottom > top && bottom - top <= 1)) return false;
  const coverage = sampledCoverage(canvas.ctx, left, top, right, bottom, contains);
  if (!coverage) return false;
  inDevice(canvas, paint, op, (ctx) => {
    ctx.fillStyle = paint.fillStyle(ctx);
    for (let count = 1; count <= 16; count++) {
      ctx.globalAlpha = count / 16;
      ctx.fill(coverage[count]!);
    }
  });
  return true;
}

export function tryBitmapRoundRect(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, left: number, top: number,
  right: number, bottom: number, rx: number, ry: number): boolean {
  if (!(right > left && bottom > top) || paint.antiAlias ||
    !(paint.style === 0 || paint.style === 2 && paint.strokeWidth === 0)) return false;
  const width = right - left, height = bottom - top;
  const scale = Math.min(1, width / (2 * Math.max(0, rx)), height / (2 * Math.max(0, ry)));
  const cx = Math.max(0, rx) * scale, cy = Math.max(0, ry) * scale;
  return sampled(canvas, paint, op, left, top, right, bottom, (x, y) => {
    if (x < left || x >= right || y < top || y >= bottom) return false;
    if (!cx || !cy) return true;
    const dx = x < left + cx ? (x - left - cx) / cx : x > right - cx ? (x - right + cx) / cx : 0;
    const dy = y < top + cy ? (y - top - cy) / cy : y > bottom - cy ? (y - bottom + cy) / cy : 0;
    return dx * dx + dy * dy <= 1;
  });
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

export function tryBitmapPath(canvas: NativeCanvas, paint: NativePaint, op: GlobalCompositeOperation, path: NativePath): boolean {
  const strokeInverse = path.inverseFill && paint.style === 1 && paint.strokeWidth > 0 && !paint.dash;
  const fillsOnly = paint.style === 0 || paint.style === 2 && paint.strokeWidth === 0;
  let fillInverse = path.inverseFill && path.fillRule === "nonzero" && fillsOnly;
  if (path.inverseFill && path.fillRule === "evenodd" && fillsOnly) {
    const m = canvas.ctx.getTransform();
    fillInverse = m.a * m.d === m.b * m.c;
  }
  const hairline = paint.style === 1 && paint.strokeWidth === 0 && paint.antiAlias && !paint.dash;
  if (!(strokeInverse || fillInverse || hairline)) return false;
  if ((strokeInverse || fillInverse) && canvas.w * canvas.h <= MAX_SAMPLED_PIXELS) {
    const ctx = canvas.ctx, m = ctx.getTransform();
    if (strokeInverse) {
      const bounds = path.bounds();
      const corners = [[bounds.left, bounds.top], [bounds.right, bounds.top],
        [bounds.right, bounds.bottom], [bounds.left, bounds.bottom]].map(([x, y]) => devicePoint(m, x, y));
      const pad = paint.strokeWidth * Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d)) + 2;
      if (Math.max(...corners.map(point => point[0])) + pad < 0 ||
        Math.min(...corners.map(point => point[0])) - pad > canvas.w ||
        Math.max(...corners.map(point => point[1])) + pad < 0 ||
        Math.min(...corners.map(point => point[1])) - pad > canvas.h) return true;
    }
    const layer = new OffscreenCanvas(canvas.w, canvas.h).getContext("2d")!;
    layer.fillStyle = paint.fillStyle(layer) as string;
    layer.fillRect(0, 0, canvas.w, canvas.h);
    layer.globalCompositeOperation = "destination-out";
    layer.setTransform(m);
    if (strokeInverse) {
      layer.strokeStyle = "white";
      applyStroke(layer, paint.strokeWidth, paint.antiAlias, paint.strokeCapN, paint.strokeJoinN, paint.strokeMiter);
      layer.stroke(path.path());
    } else {
      layer.fillStyle = "white";
      layer.fill(path.path(), path.fillRule);
    }
    composite(canvas, paint, op, layer.canvas);
    return true;
  }
  if (!hairline) return false;
  deviceHairline(canvas, paint, op, path.path());
  return true;
}
