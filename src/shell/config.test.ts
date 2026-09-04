import { describe, expect, test } from "bun:test";
import { orientScreen, orientationForRequest } from "./config";

describe("display orientation", () => {
  test("maps only fixed ActivityInfo requests", () => {
    expect([0, 6, 8, 11].map(orientationForRequest)).toEqual([2, 2, 2, 2]);
    expect([1, 7, 9, 12].map(orientationForRequest)).toEqual([1, 1, 1, 1]);
    expect([-1, 2, 3, 4, 5, 10, 13, 14].map(orientationForRequest)).toEqual(Array(8).fill(null));
  });

  test("swaps only the axes needed for the request", () => {
    const portrait = { width: 1080, height: 2424, densityDpi: 480 };
    const landscape = orientScreen(portrait, 2);
    expect(landscape).toEqual({ width: 2424, height: 1080, densityDpi: 480 });
    expect(orientScreen(landscape, 2)).toBe(landscape);
    expect(orientScreen(landscape, 1)).toEqual(portrait);
  });
});
