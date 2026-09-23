type Point = [number, number];
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

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

export function hairlineRect(ctx: Context, left: number, top: number, right: number, bottom: number,
  cap: CanvasLineCap): Path2D | null {
  const width = ctx.canvas.width, height = ctx.canvas.height;
  if (!(right > left && bottom > top && width > 0 && height > 0)) return null;
  const matrix = ctx.getTransform(), f = Math.fround;
  const points: Point[] = [[left, top], [right, top], [right, bottom], [left, bottom]]
    .map(([x, y]) => [f(f(f(matrix.a * x) + f(matrix.c * y)) + matrix.e),
      f(f(f(matrix.b * x) + f(matrix.d * y)) + matrix.f)]);
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
