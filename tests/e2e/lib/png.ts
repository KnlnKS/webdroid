// PNG load/save plus the crop and mask operations the diff applies to both sides equally.
import { readFile, writeFile } from "node:fs/promises";
import { PNG } from "pngjs";
import type { Rect } from "../types.ts";

export type Img = { width: number; height: number; data: Buffer };

export async function loadPng(path: string): Promise<Img> {
  const png = PNG.sync.read(await readFile(path));
  return { width: png.width, height: png.height, data: png.data };
}

export async function savePng(path: string, img: Img): Promise<void> {
  // one row filter: choosing among the five per row took half of a flow's scoring, for a quarter less size
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  await writeFile(path, PNG.sync.write(png, { filterType: 2 }));
}

export function newImg(width: number, height: number, fill = 0x00): Img {
  const data = Buffer.alloc(width * height * 4, fill);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  return { width, height, data };
}

export function crop(img: Img, box: { top: number; bottom: number; left: number; right: number }): Img {
  const x0 = box.left, y0 = box.top;
  const w = img.width - box.left - box.right;
  const h = img.height - box.top - box.bottom;
  if (w <= 0 || h <= 0) throw new Error(`crop ${JSON.stringify(box)} empties a ${img.width}x${img.height} image`);
  const out = newImg(w, h);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    img.data.copy(out.data, y * w * 4, src, src + w * 4);
  }
  return out;
}

/**
 * Paint masked regions a flat colour in BOTH images so they compare equal, and return the
 * pixel count that was neutralised (excluded from the denominator so masking can't be used
 * to quietly inflate the score).
 */
export function applyMasks(img: Img, rects: Rect[], fullW: number, fullH: number,
                           box: { top: number; left: number }): number {
  let masked = 0;
  for (const r of rects) {
    const x0 = Math.max(0, Math.round(r.x * fullW) - box.left);
    const y0 = Math.max(0, Math.round(r.y * fullH) - box.top);
    const x1 = Math.min(img.width, Math.round((r.x + r.w) * fullW) - box.left);
    const y1 = Math.min(img.height, Math.round((r.y + r.h) * fullH) - box.top);
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * img.width + x) * 4;
        img.data[i] = 0; img.data[i + 1] = 0; img.data[i + 2] = 0; img.data[i + 3] = 255;
        masked++;
      }
    }
  }
  return masked;
}

/** Side-by-side contact sheet: images laid out left to right with a gap. */
export function hconcat(imgs: Img[], gap = 8): Img {
  const h = Math.max(...imgs.map((i) => i.height));
  const w = imgs.reduce((a, i) => a + i.width, 0) + gap * (imgs.length - 1);
  const out = newImg(w, h, 0x1a);
  let x = 0;
  for (const img of imgs) {
    for (let y = 0; y < img.height; y++) {
      const src = y * img.width * 4;
      img.data.copy(out.data, (y * w + x) * 4, src, src + img.width * 4);
    }
    x += img.width + gap;
  }
  return out;
}
