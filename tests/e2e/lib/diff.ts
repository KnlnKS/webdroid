// Crop → mask → two percentages. Both sides go through the identical pipeline.
import pixelmatch from "pixelmatch";
import { crop, applyMasks, newImg, type Img } from "./png.ts";
import type { Rect } from "../types.ts";

/** Most common colour in an image, quantised to 4 bits/channel — the page background. */
function modalColor(img: Img): [number, number, number] {
  const hist = new Map<number, number>();
  for (let i = 0; i < img.data.length; i += 4) {
    const k = ((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4);
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  let best = 0, bestN = -1;
  for (const [k, n] of hist) if (n > bestN) { bestN = n; best = k; }
  return [((best >> 8) & 15) * 17, ((best >> 4) & 15) * 17, (best & 15) * 17];
}

/** Pixels that differ from the image's own background — i.e. where it drew something. */
function inkMask(img: Img, bgColor: [number, number, number], tol = 24): Uint8Array {
  const [br, bg, bb] = bgColor;
  const mask = new Uint8Array(img.width * img.height);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    if (Math.abs(img.data[i] - br) > tol || Math.abs(img.data[i + 1] - bg) > tol ||
        Math.abs(img.data[i + 2] - bb) > tol) mask[p] = 1;
  }
  return mask;
}

type DiffResult = {
  /** Fraction of compared pixels where any RGB channel differs at all, 0..100. */
  strictPct: number;
  /** pixelmatch with threshold 0.1 — forgives antialiasing and sub-1% colour drift, 0..100. */
  tolerantPct: number;
  /** Tolerant mismatch over the union of both images' content (non-background) pixels: the
   *  target metric, since whole-frame percentages flatter a renderer that draws nothing. */
  contentDiffPct: number;
  /** Content pixels in the golden, and in the actual — a blank render shows up as ~0 here. */
  goldenInk: number;
  actualInk: number;
  /** The two images' background colours disagree, so the whole frame counted as content. */
  bgMismatch: boolean;
  comparedPixels: number;
  maskedPixels: number;
  /** Red-on-dim overlay of the tolerant mismatch set. */
  diffImg: Img;
  goldenCrop: Img;
  actualCrop: Img;
};

export function diffImages(
  golden: Img,
  actual: Img,
  box: { top: number; bottom: number; left: number; right: number },
  maskRects: Rect[] = [],
): DiffResult {
  if (golden.width !== actual.width || golden.height !== actual.height) {
    throw new Error(
      `size mismatch: golden ${golden.width}x${golden.height} vs actual ${actual.width}x${actual.height}. ` +
      `Both must be the raw ${golden.width}x${golden.height} framebuffer the goldens were ` +
      `recorded at — no rescaling is permitted into the metric.`,
    );
  }
  const g = crop(golden, box);
  const a = crop(actual, box);

  let masked = 0;
  if (maskRects.length) {
    masked = applyMasks(g, maskRects, golden.width, golden.height, box);
    applyMasks(a, maskRects, golden.width, golden.height, box);
  }

  const total = g.width * g.height;
  const compared = total - masked;

  let strict = 0;
  for (let i = 0; i < g.data.length; i += 4) {
    if (g.data[i] !== a.data[i] || g.data[i + 1] !== a.data[i + 1] || g.data[i + 2] !== a.data[i + 2]) strict++;
  }
  // Masked pixels were painted identically, so they never count as strict mismatches;
  // removing them from the denominator only is correct.
  const diffImg = newImg(g.width, g.height);
  const tolerant = pixelmatch(g.data, a.data, diffImg.data, g.width, g.height, {
    threshold: 0.1,
    includeAA: true,
    diffColor: [255, 0, 0],
    alpha: 0.25,
  });

  // A second pass with diffMask leaves ONLY differing pixels non-transparent. The overlay
  // above also paints matching pixels (faded), so it cannot be read as a boolean mask.
  const maskImg = { width: g.width, height: g.height, data: Buffer.alloc(g.width * g.height * 4) };
  pixelmatch(g.data, a.data, maskImg.data, g.width, g.height,
    { threshold: 0.1, includeAA: true, diffMask: true });

  const bgG = modalColor(g), bgA = modalColor(a);
  const inkG = inkMask(g, bgG), inkA = inkMask(a, bgA);
  // If the two backgrounds themselves disagree, "content" is the whole frame: a renderer that
  // paints a white page where the real one is blue has got everything wrong, and scoring only
  // the ink would let it off (a white logo on blue "matches" a white background).
  const bgMismatch = Math.max(Math.abs(bgG[0] - bgA[0]), Math.abs(bgG[1] - bgA[1]),
                              Math.abs(bgG[2] - bgA[2])) > 24;
  let goldenInk = 0, actualInk = 0, unionInk = 0, unionDiff = 0;
  for (let p = 0; p < inkG.length; p++) {
    if (inkG[p]) goldenInk++;
    if (inkA[p]) actualInk++;
    if (bgMismatch || inkG[p] || inkA[p]) {
      unionInk++;
      if (maskImg.data[p * 4 + 3] !== 0) unionDiff++;
    }
  }

  return {
    strictPct: compared > 0 ? (strict / compared) * 100 : 0,
    tolerantPct: compared > 0 ? (tolerant / compared) * 100 : 0,
    contentDiffPct: unionInk > 0 ? (unionDiff / unionInk) * 100 : 0,
    goldenInk, actualInk, bgMismatch,
    comparedPixels: compared,
    maskedPixels: masked,
    diffImg,
    goldenCrop: g,
    actualCrop: a,
  };
}
