import { expect, test } from "bun:test";
import { JPath, pathOffset, pathTransform } from "./path";

test("weighted conics follow a circular arc at different scales", () => {
  for (const radius of [1, 100, 10000]) {
    const p = new JPath();
    p.add(["m", radius, 0]);
    p.conicTo(radius, radius, 0, radius, Math.SQRT1_2);
    let x = radius, y = 0;
    for (const [verb, a, b, c, d] of p.ops.slice(1)) {
      expect(verb).toBe("q");
      for (let i = 0; i <= 20; i++) {
        const t = i / 20, u = 1 - t;
        const px = u * u * x + 2 * u * t * a + t * t * c;
        const py = u * u * y + 2 * u * t * b + t * t * d;
        expect(Math.abs(Math.hypot(px, py) - radius)).toBeLessThan(0.25);
      }
      x = c; y = d;
    }
    expect([x, y]).toEqual([0, radius]);
    expect(p.ops.length).toBeLessThanOrEqual(33);
  }
});

test("conic weights preserve quadratic and degenerate geometry", () => {
  for (const weight of [1, 0, -1, Infinity, NaN]) {
    const p = new JPath();
    p.conicTo(10, 20, 30, 40, weight);
    expect(p.ops).toEqual(weight === 1 ? [["m", 0, 0], ["q", 10, 20, 30, 40]]
      : weight <= 0 ? [["m", 0, 0], ["l", 30, 40]]
        : [["m", 0, 0], ["l", 10, 20], ["l", 30, 40]]);
    expect([p.curX, p.curY]).toEqual([30, 40]);
  }
});

test("relative conics use the stored path after transforms, close and reset", () => {
  const p = new JPath();
  p.add(["m", 10, 20]);
  pathOffset(p, 2, 3);
  pathTransform(p, [2, 0, 0, 2, 0, 0]);
  p.conicTo(1, 2, 3, 4, 1, true);
  expect(p.ops.at(-1)).toEqual(["q", 25, 48, 27, 50]);
  p.add(["z"]);
  p.conicTo(1, 2, 3, 4, 1, true);
  expect(p.ops.slice(-2)).toEqual([["m", 24, 46], ["q", 25, 48, 27, 50]]);
  p.ops.length = 0;
  p.conicTo(1, 2, 3, 4, 1, true);
  expect(p.ops).toEqual([["m", 0, 0], ["q", 1, 2, 3, 4]]);
});
