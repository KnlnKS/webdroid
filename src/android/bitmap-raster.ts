import { devicePoint, hairlineLine, hairlineRect, sampledCoverage, sampledFill } from "./hairline";
import { pathBounds, type JPath } from "./path";
import { isRecording, type Ctx2D } from "./recording";
import type { JCanvas, JPaint } from "./graphics";

function eligible(canvas: JCanvas, paint: JPaint): boolean {
  return !!canvas.bmp && !paint.shader && !paint.shaderObj && !paint.maskFilter &&
    !paint.shadowRadius && !isRecording(canvas.ctx);
}

function deviceFill(canvas: JCanvas, paint: JPaint, pixels: Path2D): void {
  const ctx = canvas.ctx;
  ctx.save();
  try {
    ctx.resetTransform();
    ctx.fillStyle = paint.fillStyle(ctx);
    const blend = paint.compositeOp();
    if (blend) ctx.globalCompositeOperation = blend;
    ctx.fill(pixels);
  } finally { ctx.restore(); }
}

function composite(canvas: JCanvas, paint: JPaint, image: OffscreenCanvas): void {
  const ctx = canvas.ctx;
  ctx.save();
  try {
    ctx.resetTransform();
    const blend = paint.compositeOp();
    if (blend) ctx.globalCompositeOperation = blend;
    ctx.drawImage(image, 0, 0);
  } finally { ctx.restore(); }
}

function sampled(canvas: JCanvas, paint: JPaint, left: number, top: number, right: number, bottom: number,
  contains: (x: number, y: number) => boolean): boolean {
  const pixels = sampledFill(canvas.ctx, left, top, right, bottom, contains);
  if (!pixels) return false;
  deviceFill(canvas, paint, pixels);
  return true;
}

export function tryBitmapShape(canvas: JCanvas, paint: JPaint,
  fill: (ctx: Ctx2D) => void, stroke: (ctx: Ctx2D) => void): boolean {
  if (paint.style !== 2 || paint.strokeWidth <= 0 || paint.antiAlias || paint.dash ||
    canvas.w * canvas.h > 250_000 || !eligible(canvas, paint)) return false;
  const layer = new OffscreenCanvas(canvas.w, canvas.h).getContext("2d")!;
  layer.setTransform(canvas.ctx.getTransform());
  layer.fillStyle = layer.strokeStyle = "white";
  layer.lineWidth = paint.strokeWidth;
  layer.lineCap = paint.strokeCapN;
  layer.lineJoin = paint.strokeJoinN;
  fill(layer); stroke(layer);
  const mask = layer.getImageData(0, 0, canvas.w, canvas.h);
  for (let i = 3; i < mask.data.length; i += 4) mask.data[i] = mask.data[i]! >= 128 ? 255 : 0;
  layer.resetTransform(); layer.putImageData(mask, 0, 0);
  layer.globalCompositeOperation = "source-in";
  layer.fillStyle = paint.fillStyle(layer) as string;
  layer.fillRect(0, 0, canvas.w, canvas.h);
  composite(canvas, paint, layer.canvas);
  return true;
}

export function tryBitmapRect(canvas: JCanvas, paint: JPaint, left: number, top: number,
  right: number, bottom: number): boolean {
  if (paint.antiAlias || paint.style === 1 && paint.strokeWidth !== 0 ||
    paint.style === 2 && paint.strokeWidth !== 0 || !eligible(canvas, paint)) return false;
  if (!paint.antiAlias && (paint.style === 0 || paint.style === 2 && paint.strokeWidth === 0)) {
    const m = canvas.ctx.getTransform();
    const aligned = m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 &&
      Number.isInteger(left + m.e) && Number.isInteger(top + m.f) &&
      Number.isInteger(right + m.e) && Number.isInteger(bottom + m.f);
    if (!aligned && sampled(canvas, paint, left, top, right, bottom,
      (x, y) => x >= left && x < right && y >= top && y < bottom)) return true;
  }
  if (paint.style === 1 && paint.strokeWidth === 0 && !paint.antiAlias && !paint.dash) {
    const pixels = hairlineRect(canvas.ctx, left, top, right, bottom, paint.strokeCapN);
    if (pixels) { deviceFill(canvas, paint, pixels); return true; }
  }
  return false;
}

export function tryBitmapOval(canvas: JCanvas, paint: JPaint, left: number, top: number,
  right: number, bottom: number, sweep: number): boolean {
  if (Math.abs(sweep) < 360 || !eligible(canvas, paint)) return false;
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  const rx = (right - left) / 2, ry = (bottom - top) / 2;
  const contains = (x: number, y: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  if (!paint.antiAlias && (paint.style === 0 || paint.style === 2 && paint.strokeWidth === 0) &&
    right > left && bottom > top && sampled(canvas, paint, left, top, right, bottom, contains)) return true;
  if (!(paint.antiAlias && paint.style === 0 && bottom > top && bottom - top <= 1)) return false;
  const coverage = sampledCoverage(canvas.ctx, left, top, right, bottom, contains);
  if (!coverage) return false;
  const ctx = canvas.ctx;
  ctx.save();
  try {
    ctx.resetTransform(); ctx.fillStyle = paint.fillStyle(ctx);
    const blend = paint.compositeOp();
    if (blend) ctx.globalCompositeOperation = blend;
    for (let count = 1; count <= 16; count++) {
      ctx.globalAlpha = count / 16;
      ctx.fill(coverage[count]!);
    }
  } finally { ctx.restore(); }
  return true;
}

export function tryBitmapRoundRect(canvas: JCanvas, paint: JPaint, left: number, top: number,
  right: number, bottom: number, rx: number, ry: number): boolean {
  if (!(right > left && bottom > top) || paint.antiAlias ||
    !(paint.style === 0 || paint.style === 2 && paint.strokeWidth === 0) || !eligible(canvas, paint)) return false;
  const width = right - left, height = bottom - top;
  const scale = Math.min(1, width / (2 * Math.max(0, rx)), height / (2 * Math.max(0, ry)));
  const cx = Math.max(0, rx) * scale, cy = Math.max(0, ry) * scale;
  return sampled(canvas, paint, left, top, right, bottom, (x, y) => {
    if (x < left || x >= right || y < top || y >= bottom) return false;
    if (!cx || !cy) return true;
    const dx = x < left + cx ? (x - left - cx) / cx : x > right - cx ? (x - right + cx) / cx : 0;
    const dy = y < top + cy ? (y - top - cy) / cy : y > bottom - cy ? (y - bottom + cy) / cy : 0;
    return dx * dx + dy * dy <= 1;
  });
}

export function tryBitmapLine(canvas: JCanvas, paint: JPaint,
  x0: number, y0: number, x1: number, y1: number): boolean {
  if (paint.strokeWidth !== 0 || paint.dash || !eligible(canvas, paint)) return false;
  const ctx = canvas.ctx;
  if (!paint.antiAlias) {
    const pixels = hairlineLine(ctx, x0, y0, x1, y1, paint.strokeCapN);
    if (!pixels) return false;
    deviceFill(canvas, paint, pixels);
    return true;
  }
  const m = ctx.getTransform(), start = devicePoint(m, x0, y0), end = devicePoint(m, x1, y1);
  if (m.a * m.d === m.b * m.c || !start.every(Number.isFinite) || !end.every(Number.isFinite)) return false;
  ctx.save();
  try {
    canvas.prep(paint, true);
    const blend = paint.compositeOp();
    if (blend) ctx.globalCompositeOperation = blend;
    ctx.resetTransform();
    ctx.beginPath(); ctx.moveTo(...start); ctx.lineTo(...end); ctx.stroke();
  } finally { ctx.restore(); }
  return true;
}

export function tryBitmapPath(canvas: JCanvas, paint: JPaint, path: JPath): boolean {
  const strokeInverse = path.inverseFill && paint.style === 1 && paint.strokeWidth > 0 && !paint.dash;
  let fillInverse = path.inverseFill && path.fillRule === "nonzero" && paint.style === 0;
  if (path.inverseFill && path.fillRule === "evenodd" && paint.style === 0) {
    const m = canvas.ctx.getTransform();
    fillInverse = m.a * m.d === m.b * m.c;
  }
  const hairline = paint.style === 1 && paint.strokeWidth === 0 && paint.antiAlias && !paint.dash;
  if (!(strokeInverse || fillInverse || hairline) || !eligible(canvas, paint)) return false;
  if ((strokeInverse || fillInverse) && canvas.w * canvas.h <= 250_000) {
    const ctx = canvas.ctx, m = ctx.getTransform();
    if (strokeInverse) {
      const bounds = { left: 0, top: 0, right: 0, bottom: 0 };
      pathBounds(path, bounds);
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
      layer.lineWidth = paint.strokeWidth;
      layer.lineCap = paint.strokeCapN;
      layer.lineJoin = paint.strokeJoinN;
      layer.stroke(path.path());
    } else {
      layer.fillStyle = "white";
      layer.fill(path.path(), path.fillRule);
    }
    composite(canvas, paint, layer.canvas);
    return true;
  }
  if (!hairline) return false;
  const ctx = canvas.ctx, devicePath = new Path2D();
  devicePath.addPath(path.path(), ctx.getTransform());
  ctx.save();
  try {
    canvas.prep(paint, true);
    const blend = paint.compositeOp();
    if (blend) ctx.globalCompositeOperation = blend;
    ctx.resetTransform(); ctx.stroke(devicePath);
  } finally { ctx.restore(); }
  return true;
}
