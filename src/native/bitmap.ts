import { NativeBitmap, bitmapOf, bytesPerPixel, HARDWARE, ALPHA_8, RGB_565, ARGB_4444, ARGB_8888, RGBA_F16, RGBA_1010102, memoryOf, setMemory } from "../android/bitmap";
import { readHeader, decodePixels, grayToAlpha, oriented, alphaType, INCOMPLETE, type ImageHeader } from "../android/decode";
import type { Cpu } from "./cpu";
import { deref } from "./jni";
import { hostLib, stp, type ArgReader } from "./host";
import { mem } from "./mem";
import { iof } from "../jvm/natives/jentry";

// libjnigraphics' AndroidBitmap_*: the pixels as the bitmap's memory holds them, locked into guest memory
const locks = new Map<NativeBitmap, { pointer: number; count: number }>();
/** AndroidBitmapInfo.flags: ANDROID_BITMAP_FLAGS_ALPHA_PREMUL 0, _OPAQUE 1, _UNPREMUL 2 */
const alphaOf = (b: NativeBitmap) => !b.hasAlpha ? 1 : b.premultiplied ? 0 : 2;
/** AndroidBitmapFormat for a legacy config */
const FORMATS: Record<number, number> = { [ALPHA_8]: 8, [RGB_565]: 4, [ARGB_4444]: 7, [RGBA_F16]: 9, [RGBA_1010102]: 10 };
function bitmap(cpu: Cpu, a: ArgReader): NativeBitmap | null {
  const env = a.p(), o = deref(a.p(), cpu);
  return env && env === cpu.env && iof(o, "android/graphics/Bitmap") ? bitmapOf(o as object) : null;
}

// libjnigraphics' AImageDecoder (imagedecoder.cpp): the whole image, oriented as its EXIF says and in its own color space, decoded by decode.ts. The header info is the decoder.
interface Decoder { bytes: Uint8Array; header: ImageHeader; config: number; unpremul: boolean }
const decoders = new Map<number, Decoder>();
let lastDecoder = 0;
const D = (a: ArgReader) => decoders.get(a.i());
const SUCCESS = 0, INCOMPLETE_INPUT = -1, ERROR = -2, INVALID_CONVERSION = -3, BAD_PARAMETER = -5, UNSUPPORTED_FORMAT = -9;
const CONFIGS: Record<number, number> = { 1: ARGB_8888, ...Object.fromEntries(Object.entries(FORMATS).map(([config, format]) => [format, +config])) };
/** ImageDecoder::setOutColorType: the config for an AndroidBitmapFormat, 565 only for an opaque image and A_8 only for a gray one */
const outConfig = (h: ImageHeader, format: number): number | undefined => {
  const config = CONFIGS[format];
  return config === ARGB_4444 || config === RGB_565 && !h.opaque || config === ALPHA_8 && !h.gray ? undefined : config;
};
async function decodeImage(d: Decoder, pixels: number, stride: number): Promise<number> {
  const { bytes, header, config } = d, [w, h] = oriented(header);
  const img = await decodePixels(bytes, header, header.width, header.height, null, true, { ownSpace: true, unpremul: d.unpremul }), b = new NativeBitmap(w, h, config, alphaType(header, !d.unpremul), stride);
  if (img) b.setImage(img);
  if (config === ALPHA_8) grayToAlpha(b);
  memoryOf(b, mem.bytes(pixels, stride * (h - 1) + w * bytesPerPixel(config)));
  b.recycle();
  return !header.complete ? INCOMPLETE_INPUT : img ? SUCCESS : ERROR;
}

export function bitmapInit(): void {
  hostLib("libjnigraphics.so", {
    AndroidBitmap_getInfo: (cpu, a) => {
      const b = bitmap(cpu, a), out = a.p();
      if (!b) return -1;
      if (b.recycled) return -2;
      if (out) {
        mem.st32(out, b.w); mem.st32(out + 4, b.h); mem.st32(out + 8, b.rowBytes);
        mem.st32(out + 12, FORMATS[b.config] ?? 1); mem.st32(out + 16, alphaOf(b) | (b.config === HARDWARE ? 0x80000000 : 0));
      }
      return 0;
    },
    AndroidBitmap_lockPixels: (cpu, a) => {
      const b = bitmap(cpu, a), out = a.p();
      if (!b) return -1;
      if (b.recycled || b.config === HARDWARE) return -2;
      let lock = locks.get(b);
      if (!lock) {
        const size = b.rowBytes * b.h, pointer = mem.malloc(size);
        if (!pointer) return -3;
        lock = { pointer, count: 0 };
        memoryOf(b, mem.bytes(pointer, size));
        locks.set(b, lock);
      }
      lock.count++;
      if (out) stp(out, lock.pointer);
      return 0;
    },
    AndroidBitmap_unlockPixels: (cpu, a) => {
      const b = bitmap(cpu, a);
      if (!b) return -1;
      const lock = locks.get(b);
      if (!lock) return -1;
      try {
        if (b.recycled) return -2;
        setMemory(b, mem.bytes(lock.pointer, b.rowBytes * b.h));
        return 0;
      } finally {
        if (--lock.count === 0) { locks.delete(b); mem.free(lock.pointer); }
      }
    },
    AImageDecoder_createFromBuffer: (_c, a) => {
      const buffer = a.p(), length = a.p(), out = a.p();
      if (!buffer || !length || !out) return BAD_PARAMETER;
      stp(out, 0);
      const bytes = mem.bytes(buffer, length).slice(), header = readHeader(bytes);
      if (!header) return UNSUPPORTED_FORMAT;
      if (header === INCOMPLETE) return INCOMPLETE_INPUT;
      decoders.set(++lastDecoder, { bytes, header, config: ARGB_8888, unpremul: false });
      stp(out, lastDecoder);
      return SUCCESS;
    },
    AImageDecoder_getHeaderInfo: (_c, a) => a.p(),
    AImageDecoderHeaderInfo_getWidth: (_c, a) => { const d = D(a); return d ? oriented(d.header)[0] : 0; },
    AImageDecoderHeaderInfo_getHeight: (_c, a) => { const d = D(a); return d ? oriented(d.header)[1] : 0; },
    AImageDecoder_setAndroidBitmapFormat: (_c, a) => {
      const d = D(a), format = a.i();
      if (!d || format < 0 || format > 10) return BAD_PARAMETER;
      const config = outConfig(d.header, format);
      if (config === undefined) return INVALID_CONVERSION;
      d.config = config;
      return SUCCESS;
    },
    // only a scaled decode cannot leave the pixels unpremultiplied, and this one is never scaled
    AImageDecoder_setUnpremultipliedRequired: (_c, a) => { const d = D(a); if (!d) return BAD_PARAMETER; d.unpremul = (a.i() & 0xff) !== 0; return SUCCESS; },
    AImageDecoder_getMinimumStride: (_c, a) => { const d = D(a); return d ? oriented(d.header)[0] * bytesPerPixel(d.config) : 0; },
    AImageDecoder_decodeImage: (_c, a) => {
      const d = D(a), pixels = a.p(), stride = a.p(), size = a.p();
      if (!d || !pixels || !stride) return BAD_PARAMETER;
      const [w, h] = oriented(d.header), bpp = bytesPerPixel(d.config);
      if (stride < w * bpp || stride % bpp || size < stride * (h - 1) + w * bpp) return BAD_PARAMETER;
      return decodeImage(d, pixels, stride);
    },
    AImageDecoder_delete: (_c, a) => { decoders.delete(a.i()); },
  }, { closed: true });
}
