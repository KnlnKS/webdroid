// Skia's raster rules in a bitmap's device pixels, which a 2D context's own rasterization does not
// follow: hairlines stepped as SkScan_Hairline steps them, and non-anti-aliased fills sampled at
// pixel centres. bitmap-raster.ts decides which draws take them.

import type { Ctx2D } from "./recording.ts";

type Point = [number, number];
/** the most device pixels a draw rasterizes in script, or reads back to blend (sampled fills,
 *  inverse fills and coverage masks, CanvasKit text) */
export const MAX_SAMPLED_PIXELS = 250_000;

export function devicePoint(matrix: DOMMatrix, x: number, y: number): Point {
  const f = Math.fround;
  return [f(f(f(matrix.a * x) + f(matrix.c * y)) + matrix.e),
    f(f(f(matrix.b * x) + f(matrix.d * y)) + matrix.f)];
}

function clipLine(start: Point, end: Point, width: number, height: number): [Point, Point] | null {
  const points: [Point, Point] = [[...start], [...end]];
  for (const [axis, limit] of [[1, height], [0, width]]) {
    const low = start[axis] < end[axis] ? 0 : 1, high = 1 - low;
    if (points[high][axis] < 0 || points[low][axis] > limit) return null;
    const span = end[axis] - start[axis];
    if (points[low][axis] < 0) {
      const t = -start[axis] / span;
      points[low] = [Math.fround(start[0] + t * (end[0] - start[0])), Math.fround(start[1] + t * (end[1] - start[1]))];
      points[low][axis] = 0;
    }
    if (points[high][axis] > limit) {
      const t = (limit - start[axis]) / span;
      points[high] = [Math.fround(start[0] + t * (end[0] - start[0])), Math.fround(start[1] + t * (end[1] - start[1]))];
      points[high][axis] = limit;
    }
  }
  return points;
}

// Android's Skia hairline scan uses 26.6 endpoints and 16.16 pixel stepping.
function rasterLine(start: Point, end: Point, width: number, height: number, pixels: Path2D): number {
  let x0 = Math.trunc(Math.fround(start[0] * 64)), y0 = Math.trunc(Math.fround(start[1] * 64));
  let x1 = Math.trunc(Math.fround(end[0] * 64)), y1 = Math.trunc(Math.fround(end[1] * 64));
  const dx = x1 - x0, dy = y1 - y0;
  let count = 0;
  if (Math.abs(dx) > Math.abs(dy)) {
    if (x0 > x1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
    const slope = Math.trunc(dy * 65536 / dx), endX = (x1 + 32) >> 6;
    let yFixed = (y0 << 10) + ((slope * ((32 - x0) & 63)) >> 6);
    for (let x = (x0 + 32) >> 6; x < endX; x++, yFixed += slope) {
      const y = yFixed >> 16;
      if (x >= 0 && x < width && y >= 0 && y < height) { pixels.rect(x, y, 1, 1); count++; }
    }
  } else if (dy) {
    if (y0 > y1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
    const slope = Math.trunc(dx * 65536 / dy), endY = (y1 + 32) >> 6;
    let xFixed = (x0 << 10) + ((slope * ((32 - y0) & 63)) >> 6);
    for (let y = (y0 + 32) >> 6; y < endY; y++, xFixed += slope) {
      const x = xFixed >> 16;
      if (x >= 0 && x < width && y >= 0 && y < height) { pixels.rect(x, y, 1, 1); count++; }
    }
  }
  return count;
}

export function hairlineRect(ctx: Ctx2D, left: number, top: number, right: number, bottom: number,
  cap: CanvasLineCap): Path2D | null {
  const width = ctx.canvas.width, height = ctx.canvas.height;
  if (!(right > left && bottom > top && width > 0 && height > 0)) return null;
  const matrix = ctx.getTransform(), f = Math.fround;
  const points: Point[] = [[left, top], [right, top], [right, bottom], [left, bottom]]
    .map(([x, y]) => devicePoint(matrix, x, y));
  if (!points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return null;
  const outset = cap === "square" ? 0.5 : cap === "round" ? Math.PI / 8 : 0;
  // The cap-adjusted first point is also the endpoint of the closing edge.
  const first: Point = [...points[0]];
  if (outset) {
    const dx = points[1][0] - first[0], dy = points[1][1] - first[1], length = Math.hypot(dx, dy);
    if (!length) return null;
    first[0] = f(first[0] - dx / length * outset);
    first[1] = f(first[1] - dy / length * outset);
  }
  const pixels = new Path2D();
  let count = 0;
  for (let index = 0; index < 4; index++) {
    const start: Point = [...(index === 0 ? first : points[index])];
    const end: Point = [...(index === 3 ? first : points[index + 1])];
    if (outset && index === 3) {
      const dx = end[0] - start[0], dy = end[1] - start[1], length = Math.hypot(dx, dy);
      if (!length) return null;
      end[0] = f(end[0] + dx / length * outset);
      end[1] = f(end[1] + dy / length * outset);
    }
    const clipped = clipLine(start, end, width, height);
    if (clipped) count += rasterLine(clipped[0], clipped[1], width, height, pixels);
  }
  return count ? pixels : null;
}

export function hairlineLine(ctx: Ctx2D, x0: number, y0: number, x1: number, y1: number,
  cap: CanvasLineCap): Path2D | null {
  const width = ctx.canvas.width, height = ctx.canvas.height;
  if (!(width > 0 && height > 0)) return null;
  const matrix = ctx.getTransform();
  const start = devicePoint(matrix, x0, y0), end = devicePoint(matrix, x1, y1);
  if (![...start, ...end].every(Number.isFinite)) return null;
  const outset = cap === "square" ? 0.5 : cap === "round" ? Math.PI / 8 : 0;
  if (outset) {
    const dx = end[0] - start[0], dy = end[1] - start[1], length = Math.hypot(dx, dy);
    if (!length) return null;
    start[0] -= dx / length * outset; start[1] -= dy / length * outset;
    end[0] += dx / length * outset; end[1] += dy / length * outset;
  }
  const clipped = clipLine(start, end, width, height);
  if (!clipped) return null;
  const pixels = new Path2D();
  return rasterLine(clipped[0], clipped[1], width, height, pixels) ? pixels : null;
}

function samplingRegion(ctx: Ctx2D, left: number, top: number, right: number, bottom: number) {
  const m = ctx.getTransform(), det = m.a * m.d - m.b * m.c;
  if (!det || !Number.isFinite(det)) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of [devicePoint(m, left, top), devicePoint(m, right, top),
    devicePoint(m, right, bottom), devicePoint(m, left, bottom)]) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const x0 = Math.max(0, Math.floor(minX)), y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(ctx.canvas.width, Math.ceil(maxX));
  const y1 = Math.min(ctx.canvas.height, Math.ceil(maxY));
  if ((x1 - x0) * (y1 - y0) > MAX_SAMPLED_PIXELS) return null;
  return { m, det, x0, y0, x1, y1 };
}

export function sampledFill(ctx: Ctx2D, left: number, top: number, right: number, bottom: number,
  contains: (x: number, y: number) => boolean): Path2D | null {
  const region = samplingRegion(ctx, left, top, right, bottom);
  if (!region) return null;
  const { m, det, x0, y0, x1, y1 } = region;
  const pixels = new Path2D();
  for (let y = y0; y < y1; y++) {
    const dy = y + 0.5 - m.f;
    let localX = (m.d * (x0 + 0.5 - m.e) - m.c * dy) / det;
    let localY = (m.a * dy - m.b * (x0 + 0.5 - m.e)) / det;
    let start = -1;
    for (let x = x0; x <= x1; x++) {
      const inside = x < x1 && contains(localX, localY);
      if (inside && start < 0) start = x;
      else if (!inside && start >= 0) { pixels.rect(start, y, x - start, 1); start = -1; }
      localX += m.d / det; localY -= m.b / det;
    }
  }
  return pixels;
}

export function sampledCoverage(ctx: Ctx2D, left: number, top: number, right: number, bottom: number,
  contains: (x: number, y: number) => boolean): Path2D[] | null {
  const region = samplingRegion(ctx, left, top, right, bottom);
  if (!region) return null;
  const { m, det, x0, y0, x1, y1 } = region;
  const paths = Array.from({ length: 17 }, () => new Path2D());
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    let count = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const dx = x + (sx + 0.5) / 4 - m.e, dy = y + (sy + 0.5) / 4 - m.f;
      if (contains((m.d * dx - m.c * dy) / det, (m.a * dy - m.b * dx) / det)) count++;
    }
    if (count) paths[count]!.rect(x, y, 1, 1);
  }
  return paths;
}
