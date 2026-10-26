// The HAL pixel formats (graphics.h) a CPU writes and reads as RGBA: AHardwareBuffer locks, ANativeWindow posts
// and Bitmap's 565 storage. RGB565 widens by replicating its high bits, as Skia's SkPacked16ToR32 and its lowp
// raster pipeline do, and narrows to the nearest value.

export const expand5 = (v: number): number => v << 3 | v >> 2;
export const expand6 = (v: number): number => v << 2 | v >> 4;
export const pack565 = (r: number, g: number, b: number): number => Math.round(r * 31 / 255) << 11 | Math.round(g * 63 / 255) << 5 | Math.round(b * 31 / 255);

/** n pixels of a format between its guest bytes and RGBA bytes */
export interface Codec { unpack(src: Uint8Array, rgba: Uint8Array | Uint8ClampedArray, n: number): void; pack(rgba: Uint8Array, n: number): Uint8Array }
/** pixels of `bpp` bytes, the first `channels` of them R, G, B and A in order and the rest an opaque X */
function bytewise(bpp: number, channels: number): Codec {
  return {
    unpack(src, rgba, n) { for (let i = 0; i < n; i++) { for (let c = 0; c < channels; c++) rgba[i * 4 + c] = src[i * bpp + c]; rgba[i * 4 + 3] = 255; } },
    pack(rgba, n) {
      const out = new Uint8Array(n * bpp);
      for (let i = 0; i < n; i++) { for (let c = 0; c < bpp; c++) out[i * bpp + c] = c < channels ? rgba[i * 4 + c] : 255; }
      return out;
    },
  };
}
const RGBX: Codec = {
  ...bytewise(4, 3),
  unpack(src, rgba, n) { rgba.set(src.subarray(0, n * 4)); for (let i = 3; i < n * 4; i += 4) rgba[i] = 255; },
};
const RGB565: Codec = {
  unpack(src, rgba, n) {
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      const v = src[i * 2] | src[i * 2 + 1] << 8;
      rgba[o] = expand5(v >> 11); rgba[o + 1] = expand6(v >> 5 & 63); rgba[o + 2] = expand5(v & 31); rgba[o + 3] = 255;
    }
  },
  pack(rgba, n) {
    const out = new Uint8Array(n * 2);
    for (let i = 0, o = 0; i < n; i++, o += 4) { const v = pack565(rgba[o], rgba[o + 1], rgba[o + 2]); out[i * 2] = v; out[i * 2 + 1] = v >> 8; }
    return out;
  },
};
/** by HAL format: RGBA_8888, RGBX_8888, RGB_888, RGB_565, R_8 */
export const CODECS = new Map<number, Codec>([
  [1, { unpack: (src, rgba, n) => rgba.set(src.subarray(0, n * 4)), pack: (rgba) => rgba }],
  [2, RGBX], [3, bytewise(3, 3)], [4, RGB565], [0x38, bytewise(1, 1)],
]);
