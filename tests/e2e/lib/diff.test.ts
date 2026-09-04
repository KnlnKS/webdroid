import { describe, expect, test } from "bun:test";
import { diffImages } from "./diff";
import { newImg, type Img } from "./png";

const W = 40, H = 40;
const NO_CROP = { top: 0, bottom: 0, left: 0, right: 0 };

function img(r: number, g: number, b: number): Img {
  const im = newImg(W, H);
  for (let i = 0; i < im.data.length; i += 4) { im.data[i] = r; im.data[i + 1] = g; im.data[i + 2] = b; }
  return im;
}
function rect(im: Img, x: number, y: number, w: number, h: number, r: number, g: number, b: number): Img {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * W + xx) * 4;
      im.data[i] = r; im.data[i + 1] = g; im.data[i + 2] = b;
    }
  }
  return im;
}
const white = () => img(255, 255, 255);
const diff = (g: Img, a: Img, masks: { x: number; y: number; w: number; h: number }[] = []) =>
  diffImages(g, a, NO_CROP, masks);

describe("diffImages", () => {
  test("identical images score zero on every metric", () => {
    const d = diff(rect(white(), 8, 8, 10, 10, 0, 0, 0), rect(white(), 8, 8, 10, 10, 0, 0, 0));
    expect(d.strictPct).toBe(0);
    expect(d.tolerantPct).toBe(0);
    expect(d.contentDiffPct).toBe(0);
    expect(d.goldenInk).toBe(100);
    expect(d.actualInk).toBe(100);
  });

  test("a blank render scores ~100% content, not the ~3% a whole-frame metric gives it", () => {
    const d = diff(rect(white(), 8, 8, 10, 10, 0, 0, 0), white());
    expect(d.actualInk).toBe(0);
    expect(d.goldenInk).toBe(100);
    expect(d.contentDiffPct).toBe(100);
    expect(d.strictPct).toBeLessThan(10);
  });

  test("drawing where the golden is blank is penalised the same way", () => {
    const d = diff(white(), rect(white(), 8, 8, 10, 10, 0, 0, 0));
    expect(d.goldenInk).toBe(0);
    expect(d.actualInk).toBe(100);
    expect(d.contentDiffPct).toBe(100);
  });

  test("disagreeing backgrounds count the whole frame as content", () => {
    const d = diff(white(), img(0, 0, 200));
    expect(d.bgMismatch).toBe(true);
    expect(d.contentDiffPct).toBe(100);
  });

  test("a background within tolerance is not a mismatch", () => {
    const d = diff(white(), img(250, 250, 250));
    expect(d.bgMismatch).toBe(false);
  });

  test("content in the same place with the same colour scores 0 even on a shifted background", () => {
    const g = rect(img(240, 240, 240), 8, 8, 10, 10, 0, 0, 0);
    const a = rect(img(255, 255, 255), 8, 8, 10, 10, 0, 0, 0);
    const d = diff(g, a);
    expect(d.bgMismatch).toBe(false);
    expect(d.contentDiffPct).toBeLessThan(50);
  });

  test("masking removes pixels from the denominator, so it cannot buy a better score", () => {
    const g = rect(white(), 8, 8, 10, 10, 0, 0, 0);
    const plain = diff(g, white());
    const masked = diff(g, white(), [{ x: 8 / W, y: 8 / H, w: 10 / W, h: 10 / H }]);
    expect(plain.maskedPixels).toBe(0);
    expect(masked.maskedPixels).toBe(100);
    expect(masked.comparedPixels).toBe(plain.comparedPixels - 100);
    expect(masked.contentDiffPct).toBe(0);
  });

  test("a size mismatch is refused rather than rescaled into the metric", () => {
    const small = newImg(10, 10);
    expect(() => diffImages(white(), small, NO_CROP, [])).toThrow(/no rescaling is permitted/);
  });
});
