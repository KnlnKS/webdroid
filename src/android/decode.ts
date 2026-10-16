// The native halves of BitmapFactory, BitmapRegionDecoder and ImageDecoder (hwui's
// BitmapFactory.cpp, BitmapRegionDecoder.cpp and ImageDecoder.cpp) over the browser's decoders.
//
// What SkCodec learns from a header (format, size, alpha, frames, EXIF orientation and a
// nine-patch's npTc/npLb/npOl chunks) is read here, so a bounds-only decode reads no pixels. The
// pixels come from createImageBitmap (libheif for HEIF), sampled and scaled as the browser decodes
// them, and become a NativeBitmap without an intermediate raster.

import { awaited, rt, declaredField, driven, type Gen } from "../jvm/runtime";
import { handle, ownedHandle, deref, release } from "./handles";
import { vcall, scall, newObj, after, iof } from "../jvm/natives/jentry";
import { type JBuffer, readBufferBytes, elementShift } from "../jvm/natives/jnio";
import { fdInt, readStreamFully } from "../jvm/natives/jio";
import { u8, concat, unshared } from "../jvm/abi";
import { javaFdBytes, javaSeekFd } from "../native/fs";
import { assetBytes } from "./assetmanager";
import { NativeBitmap, bitmapAt, namedSpace, bytesPerPixel, javaBitmap, reinitJava, ALPHA_8, RGB_565, ARGB_8888, RGBA_F16, HARDWARE, OPAQUE, PREMUL, UNPREMUL, type RGBA } from "./bitmap";
import { decodeHeif } from "./heif";
import { edges, setEdges } from "./graphics";
import { bitmapCanvas } from "./canvas";

// ── headers
export interface ImageHeader {
  mime: string; width: number; height: number;
  /** how SkAndroidCodec samples the format: SkSampledCodec's floor, libjpeg's native scales, or SkScalingCodec's rounding */
  sampling: "floor" | "jpeg" | "round";
  opaque: boolean;
  /** one channel: what an ALPHA_8 request decodes */
  gray: boolean;
  frames: number;
  /** EXIF orientation (1-8), and where its value is (and in which byte order), to decode ignoring it */
  orientation: number; orientationAt: number; orientationLE: boolean;
  /** the input ends where the format says it does */
  complete: boolean;
  /** Res_png_9patch as BitmapFactory hands it out: deserialized, in device order */
  patch: Int8Array | null;
  /** npLb's optical insets; npOl's outline insets, radius and alpha */
  layout: number[] | null; outline: number[] | null;
}
/** the input ends before the header does (SkCodec's kIncompleteInput) */
export const INCOMPLETE = "incomplete";
type Header = ImageHeader | typeof INCOMPLETE | null;
const header = (mime: string, width: number, height: number, sampling: ImageHeader["sampling"], opaque: boolean): ImageHeader =>
  ({ mime, width, height, sampling, opaque, gray: false, frames: 1, orientation: 1, orientationAt: 0, orientationLE: false, complete: true, patch: null, layout: null, outline: null });
const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/** NinePatchPeeker's npTc: a serialized Res_png_9patch, deserialized (offsets filled in) and in device order */
function devicePatch(data: Uint8Array): Int8Array | null {
  const nx = data[1], ny = data[2], nc = data[3], size = 32 + (nx + ny + nc) * 4;
  if (data.length < 32 || data.length !== size) return null;
  const out = new Int8Array(size), v = new DataView(out.buffer), src = new DataView(data.buffer, data.byteOffset, size);
  out[0] = 1; out[1] = nx; out[2] = ny; out[3] = nc;
  for (let at = 12; at < size; at += 4) v.setInt32(at, src.getInt32(at), true);
  v.setInt32(4, 32, true); v.setInt32(8, 32 + nx * 4, true); v.setInt32(28, 32 + (nx + ny) * 4, true);
  return out;
}
function png(b: Uint8Array, v: DataView): Header {
  if (b.length < 33) return INCOMPLETE;
  const colorType = b[25], h = header("image/png", v.getUint32(16), v.getUint32(20), "floor", colorType === 0 || colorType === 2 || colorType === 3);
  h.gray = colorType === 0; h.complete = false;
  let data = false;
  for (let pos = 8; pos + 8 <= b.length;) {
    const len = v.getUint32(pos), type = tag(b, pos + 4), at = pos + 8;
    if (type === "IDAT") data = true;
    if (at + len > b.length) break;
    const body = b.subarray(at, at + len), le = new DataView(body.buffer, body.byteOffset, len);
    if (type === "IEND") { h.complete = true; break; }
    else if (type === "tRNS") h.opaque = h.gray = false;
    else if (type === "npTc") h.patch = devicePatch(body) ?? h.patch;
    // aapt2 writes these two in the device's (little-endian) order
    else if (type === "npLb" && len === 16) h.layout = [0, 4, 8, 12].map((k) => le.getInt32(k, true));
    else if (type === "npOl" && len === 24) h.outline = [...[0, 4, 8, 12].map((k) => le.getInt32(k, true)), le.getFloat32(16, true), le.getInt32(20, true) & 0xff];
    pos = at + len + 4;
  }
  return data || h.complete ? h : INCOMPLETE;
}
function jpeg(b: Uint8Array, v: DataView): Header {
  let h: ImageHeader | null = null, orientation = 1, orientationAt = 0, orientationLE = false;
  for (let pos = 2; ;) {
    while (pos < b.length && b[pos] !== 0xff) pos++;
    while (pos < b.length && b[pos] === 0xff) pos++;
    if (pos + 3 > b.length) return INCOMPLETE;
    const marker = b[pos], at = pos + 1;
    if (marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) { pos = at; continue; }
    const len = v.getUint16(at);
    if (marker === 0xda) break;
    if (at + len > b.length) return INCOMPLETE;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      h = header("image/jpeg", v.getUint16(at + 5), v.getUint16(at + 3), "jpeg", true);
      h.gray = b[at + 7] === 1;
    } else if (marker === 0xe1 && tag(b, at + 2) === "Exif") {
      const t = at + 8, little = b[t] === 0x49, u16 = (o: number) => v.getUint16(t + o, little), ifd = v.getUint32(t + 4, little);
      for (let i = 0, n = t + ifd + 2 <= at + len ? u16(ifd) : 0; i < n && t + ifd + 14 + i * 12 <= at + len; i++) {
        const entry = ifd + 2 + i * 12;
        if (u16(entry) === 0x112) { orientation = u16(entry + 8); orientationAt = t + entry + 8; orientationLE = little; }
      }
    }
    pos = at + len;
  }
  if (!h) return null;
  if (orientation >= 1 && orientation <= 8) Object.assign(h, { orientation, orientationAt, orientationLE });
  h.complete = b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;
  return h;
}
function gif(b: Uint8Array, v: DataView): Header {
  if (b.length < 13) return INCOMPLETE;
  const h = header("image/gif", v.getUint16(6, true), v.getUint16(8, true), "round", true);
  const table = (flags: number) => flags & 0x80 ? 3 << ((flags & 7) + 1) : 0;
  const blocks = (pos: number) => { while (pos < b.length && b[pos]) pos += b[pos] + 1; return pos + 1; };
  let frames = 0;
  h.complete = false;
  for (let pos = 13 + table(b[10]); pos < b.length;) {
    const c = b[pos];
    if (c === 0x3b) { h.complete = true; break; }
    if (c === 0x21) {
      if (b[pos + 1] === 0xf9 && b[pos + 3] & 1) h.opaque = false;
      pos = blocks(pos + 2);
    } else if (c === 0x2c) { frames++; pos = blocks(pos + 11 + table(b[pos + 9])); }
    else break;
  }
  h.frames = Math.max(1, frames);
  return h;
}
function webp(b: Uint8Array, v: DataView): Header {
  if (b.length < 30) return INCOMPLETE;
  const kind = tag(b, 12);
  let h: ImageHeader;
  if (kind === "VP8 ") h = header("image/webp", v.getUint16(26, true) & 0x3fff, v.getUint16(28, true) & 0x3fff, "round", true);
  else if (kind === "VP8L") {
    const bits = v.getUint32(21, true);
    h = header("image/webp", (bits & 0x3fff) + 1, (bits >>> 14 & 0x3fff) + 1, "round", !(bits >>> 28 & 1));
  } else if (kind === "VP8X") {
    const flags = b[20];
    h = header("image/webp", 1 + (v.getUint32(24, true) & 0xffffff), 1 + (v.getUint32(27, true) & 0xffffff), "round", !(flags & 0x10));
    if (flags & 2) {
      let frames = 0;
      for (let pos = 12; pos + 8 <= b.length; pos += 8 + ((v.getUint32(pos + 4, true) + 1) & ~1)) if (tag(b, pos) === "ANMF") frames++;
      h.frames = Math.max(1, frames);
    }
  } else return null;
  h.complete = 8 + v.getUint32(4, true) <= b.length;
  return h;
}
function bmp(b: Uint8Array, v: DataView): Header {
  if (b.length < 30) return INCOMPLETE;
  const h = header("image/bmp", Math.abs(v.getInt32(18, true)), Math.abs(v.getInt32(22, true)), "floor", v.getUint16(28, true) !== 32);
  h.complete = v.getUint32(2, true) <= b.length;
  return h;
}
function ico(b: Uint8Array, v: DataView): Header {
  const n = v.getUint16(4, true);
  if (b.length < 6 + n * 16) return INCOMPLETE;
  let w = 0, ht = 0;
  for (let i = 0; i < n; i++) {
    const iw = b[6 + i * 16] || 256, ih = b[7 + i * 16] || 256;
    if (iw * ih > w * ht) { w = iw; ht = ih; }
  }
  return n ? header("image/x-ico", w, ht, "floor", false) : null;
}
/** ISO BMFF: HEIF (image/heif) or AVIF by the ftyp brands, the largest `ispe` as the primary image's size */
function bmff(b: Uint8Array, v: DataView): Header {
  const size = v.getUint32(0);
  if (b.length < Math.max(16, size)) return INCOMPLETE;
  const brands: string[] = [];
  for (let at = 8; at + 4 <= size; at += at === 8 ? 8 : 4) brands.push(tag(b, at));
  const avif = brands.some((x) => x === "avif" || x === "avis");
  if (!avif && !brands.some((x) => ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(x))) return null;
  let w = 0, ht = 0, alpha = false;
  for (let at = size; at + 16 <= b.length; at++) {
    if (b[at] === 0x69 && tag(b, at) === "ispe" && v.getUint32(at + 8) * v.getUint32(at + 12) > w * ht) { w = v.getUint32(at + 8); ht = v.getUint32(at + 12); }
    else if (b[at] === 0x61 && tag(b, at) === "auxC") alpha = true;
  }
  return w ? header(avif ? "image/avif" : "image/heif", w, ht, "round", !alpha) : INCOMPLETE;
}
/** SkCodec::MakeFromStream's sniffing: null for a format none of the codecs claims */
export function readHeader(b: Uint8Array): Header {
  // an empty input, or the start of a signature, is SkCodec's kIncompleteInput
  if (b.length < 4) return !b.length || [[0x89, 0x50, 0x4e], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46], [0x52, 0x49, 0x46], [0x42, 0x4d], [0, 0, 1]]
    .some((sig) => b.every((v, i) => i >= sig.length || v === sig[i])) ? INCOMPLETE : null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b[0] === 0x89 && tag(b, 1).startsWith("PNG")) return png(b, v);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return jpeg(b, v);
  if (tag(b, 0) === "GIF8") return gif(b, v);
  if (tag(b, 0) === "RIFF") return b.length < 12 ? INCOMPLETE : tag(b, 8) === "WEBP" ? webp(b, v) : null;
  if (b[0] === 0x42 && b[1] === 0x4d) return bmp(b, v);
  if (!b[0] && !b[1] && b[2] === 1 && !b[3]) return b.length < 6 ? INCOMPLETE : ico(b, v);
  if (b.length >= 8 && tag(b, 4) === "ftyp") return bmff(b, v);
  return null;
}

/** SkAndroidCodec::getSampledDimensions */
function sampledSize(h: ImageHeader, sample: number, w = h.width, ht = h.height): [number, number] {
  if (sample <= 1) return [w, ht];
  if (h.sampling === "round") {
    const scale = Math.fround(1 / sample), dim = (d: number) => Math.max(1, Math.floor(Math.fround(Math.fround(d * scale) + 0.5)));
    return [dim(w), dim(ht)];
  }
  if (h.sampling === "jpeg") {
    // libjpeg scales by 1/2, 1/4 and 1/8 itself, rounding up; SkSampledCodec samples what is left
    const native = [8, 4, 2].find((n) => sample % n === 0);
    if (native) { w = Math.ceil(w / native); ht = Math.ceil(ht / native); sample /= native; }
    if (sample === 1) return [w, ht];
  }
  return [sample > w ? 1 : Math.floor(w / sample), sample > ht ? 1 : Math.floor(ht / sample)];
}
/** SkAndroidCodec::computeOutputColorType for BitmapFactory's inPreferredConfig */
function outputConfig(h: ImageHeader, preferred: number): number {
  if (preferred === RGB_565) return h.opaque ? RGB_565 : ARGB_8888;
  if (preferred === ALPHA_8) return h.gray ? ALPHA_8 : ARGB_8888;
  return preferred === RGBA_F16 ? RGBA_F16 : ARGB_8888;
}

/** The pixels of `region` (image coordinates, the whole image when null) at w x h, or null when
 *  the browser cannot decode them. `orient` applies EXIF orientation, as ImageDecoder does and
 *  BitmapFactory does not. `ownSpace` decodes in the image's color space, as AImageDecoder does,
 *  where BitmapFactory and ImageDecoder convert to sRGB (a PNG's gAMA included). `unpremul` asks
 *  for a whole image's unpremultiplied pixels as encoded, which a canvas, holding them premultiplied,
 *  cannot keep for translucent pixels. */
export async function decodePixels(bytes: Uint8Array, h: ImageHeader, w: number, ht: number, region: [number, number, number, number] | null, orient: boolean,
  { ownSpace = false, unpremul = false } = {}): Promise<ImageBitmap | RGBA | null> {
  const colorSpaceConversion = ownSpace ? "none" : "default";
  if (unpremul && !region && !h.opaque && w === h.width && ht === h.height) { const px = await decodeStraight(bytes, h, colorSpaceConversion); if (px) return px; }
  if (typeof createImageBitmap === "undefined") return null;
  let heif: ImageBitmap | null = null;
  try {
    if (!orient && h.orientation !== 1) { bytes = bytes.slice(); new DataView(bytes.buffer).setUint16(h.orientationAt, 1, h.orientationLE); }
    const source = h.mime === "image/heif" ? heif = await decodeHeif(bytes) : new Blob([unshared(bytes)], { type: h.mime });
    const [sx, sy, sw, sh] = region ?? [0, 0, 0, 0];
    const resize: ImageBitmapOptions = region ? (sw !== w || sh !== ht ? { resizeWidth: w, resizeHeight: ht } : {})
      : w !== h.width || ht !== h.height ? { resizeWidth: w, resizeHeight: ht } : {};
    const options = { ...resize, colorSpaceConversion } as const;
    return await (region ? createImageBitmap(source, sx, sy, sw, sh, options) : createImageBitmap(source, options));
  } catch (e) {
    if (h.complete) console.warn("[decode]", h.mime, e);
    return null;
  } finally { heif?.close(); }
}
/** a whole image's unpremultiplied RGBA from WebCodecs, whose frames are not premultiplied, or null where it cannot give them */
async function decodeStraight(bytes: Uint8Array, h: ImageHeader, colorSpaceConversion: ColorSpaceConversion): Promise<RGBA | null> {
  if (typeof ImageDecoder === "undefined" || h.orientation !== 1) return null;
  const decoder = new ImageDecoder({ data: unshared(bytes), type: h.mime, colorSpaceConversion });
  try {
    const { image } = await decoder.decode();
    try {
      const format = image.format, rect = image.visibleRect;
      if (!format || !/^(RGB|BGR)[AX]$/.test(format) || rect?.width !== h.width || rect.height !== h.height) return null;
      const px = new Uint8ClampedArray(h.width * h.height * 4);
      await image.copyTo(px);
      if (format !== "RGBA") for (let i = 0; i < px.length; i += 4) {
        if (format[0] === "B") { const b = px[i]; px[i] = px[i + 2]; px[i + 2] = b; }
        if (format[3] === "X") px[i + 3] = 255;
      }
      return px;
    } finally { image.close(); }
  } catch { return null; } finally { decoder.close(); }
}
/** a decoded gray image as ALPHA_8 coverage */
export function grayToAlpha(b: NativeBitmap) {
  const px = b.pixels();
  for (let i = 0; i < px.length; i += 4) { px[i + 3] = px[i]; px[i] = px[i + 1] = px[i + 2] = 0; }
  b.commit(0, 0, b.w, b.h);
}

// ── nine-patch geometry under density scaling (NinePatchPeeker::scale)
/** `v` scaled and rounded in float, as BitmapFactory scales sizes and NinePatchPeeker the chunk */
const scaled = (v: number, scale: number) => Math.trunc(Math.fround(Math.fround(v * scale) + 0.5));
const nearlyOne = (s: number) => Math.abs(s - 1) <= 1 / 4096;
function scaleDivs(v: DataView, at: number, n: number, scale: number, max: number) {
  const get = (i: number) => v.getInt32(at + i * 4, true), set = (i: number, d: number) => v.setInt32(at + i * 4, d, true);
  for (let i = 0; i < n; i++) {
    let d = scaled(get(i), scale);
    if (i > 0 && d === get(i - 1)) d++;
    set(i, d);
  }
  if (n && get(n - 1) > max) {
    for (let i = n - 1, highest = max; i >= 0; i--) {
      set(i, highest);
      if (i > 0 && get(i) <= get(i - 1)) highest = get(i) - 1;
      else break;
    }
  }
}
function scalePatch(chunk: Int8Array, sx: number, sy: number, w: number, h: number) {
  const v = new DataView(chunk.buffer), scale = (at: number, s: number) => v.setInt32(at, scaled(v.getInt32(at, true), s), true);
  if (!nearlyOne(sx)) { scale(12, sx); scale(16, sx); scaleDivs(v, 32, chunk[1], sx, w - 1); }
  if (!nearlyOne(sy)) { scale(20, sy); scale(24, sy); scaleDivs(v, 32 + chunk[1] * 4, chunk[2], sy, h - 1); }
}
/** NinePatchPeeker::getPadding: the chunk's padding, -1s for an image without one */
function setPadding(pad: object, chunk: Int8Array | null) {
  const v = chunk && new DataView(chunk.buffer, chunk.byteOffset);
  setEdges(pad, v ? { left: v.getInt32(12, true), top: v.getInt32(20, true), right: v.getInt32(16, true), bottom: v.getInt32(24, true) }
    : { left: -1, top: -1, right: -1, bottom: -1 });
}
/** NinePatchPeeker::createNinePatchInsets */
const insetsOf = (h: ImageHeader, scale: number) => !h.layout && !h.outline ? null
  : newObj("android/graphics/NinePatch$InsetStruct", "(IIIIIIIIFIF)V", ...(h.layout ?? [0, 0, 0, 0]), ...(h.outline ?? [0, 0, 0, 0, 0, 0]), scale);

// ── BitmapFactory.Options, as BitmapFactory and BitmapRegionDecoder read and answer it
const OPTIONS = "android/graphics/BitmapFactory$Options";
const OPTION_FIELDS = ["inJustDecodeBounds", "inSampleSize", "inPreferredConfig", "inMutable", "inPremultiplied", "inScaled", "inDensity",
  "inTargetDensity", "inScreenDensity", "inBitmap", "outWidth", "outHeight", "outMimeType", "outConfig", "outColorSpace"] as const;
let O: Record<(typeof OPTION_FIELDS)[number], string> | null = null;
const opt = () => O ??= Object.fromEntries(OPTION_FIELDS.map((n) => [n, declaredField(OPTIONS, n)])) as NonNullable<typeof O>;
type Options = Record<string, unknown>;
interface Request { sample: number; preferred: number; mutable: boolean; premultiplied: boolean; justBounds: boolean; scale: number }
const DEFAULT_REQUEST: Request = { sample: 1, preferred: ARGB_8888, mutable: false, premultiplied: true, justBounds: false, scale: 1 };
function request(options: Options | null): Request {
  if (!options) return DEFAULT_REQUEST;
  const o = opt(), density = options[o.inDensity] as number, target = options[o.inTargetDensity] as number;
  return {
    sample: Math.max(1, options[o.inSampleSize] as number), preferred: nativeConfig(options[o.inPreferredConfig] as object | null) || ARGB_8888,
    mutable: !!options[o.inMutable], premultiplied: !!options[o.inPremultiplied], justBounds: !!options[o.inJustDecodeBounds],
    scale: options[o.inScaled] && density && target && density !== options[o.inScreenDensity] ? Math.fround(target / density) : 1,
  };
}
function clearOuts(options: Options | null) {
  const o = opt();
  if (options) { options[o.outWidth] = options[o.outHeight] = -1; options[o.outMimeType] = options[o.outConfig] = options[o.outColorSpace] = null; }
}
/** the decoded size, MIME type, config (HARDWARE when that was asked for) and color space */
const setOuts = driven(function* setOuts(options: Options, w: number, h: number, mime: string, config: number): Gen<void> {
  const o = opt();
  options[o.outWidth] = w; options[o.outHeight] = h; options[o.outMimeType] = mime;
  options[o.outConfig] = yield javaConfig(config);
  options[o.outColorSpace] = config === ALPHA_8 ? null : yield namedSpace(0);
});
let configInt = "";
/** GraphicsJNI::getNativeBitmapColorType: a Bitmap.Config's legacy number, 0 for none */
const nativeConfig = (config: object | null): number =>
  config ? (config as Record<string, number>)[configInt ||= declaredField("android/graphics/Bitmap$Config", "nativeInt")] : 0;
const javaConfig = (config: number) => scall("android/graphics/Bitmap$Config", "nativeToConfig", "(I)Landroid/graphics/Bitmap$Config;", config);

/** The decoded pixels as a bitmap: the reused one reconfigured to hold them, or a new one (HARDWARE
 *  for a hardware 8888 decode). Pixels the browser could not decode leave it empty. */
function placePixels(img: ImageBitmap | RGBA | null, w: number, h: number, config: number, alphaType: number, hardware: boolean, reuse: NativeBitmap | null = null): NativeBitmap {
  const b = reuse ?? new NativeBitmap(w, h, hardware && config === ARGB_8888 ? HARDWARE : config, alphaType);
  if (reuse) reuse.reconfigure(w, h, config, alphaType);
  if (img) b.setImage(img);
  if (config === ALPHA_8) grayToAlpha(b);
  return b;
}
/** the Java Bitmap a decode answers: the reused inBitmap, reinitialized, or a new one around `b` */
const javaResult = (b: NativeBitmap, reused: object | null, premultiplied: boolean, chunk: Int8Array | null = null, insets: unknown = null) =>
  reused ? after(reinitJava(reused, b, premultiplied), () => reused) : javaBitmap(b, -1, chunk, insets, premultiplied);

// ── BitmapFactory
/** BitmapFactory.cpp's doDecode */
const doDecode = driven(function* doDecode(bytes: Uint8Array, padding: object | null, options: Options | null, inBitmap: bigint): Gen {
  clearOuts(options);
  const h = readHeader(bytes);
  if (!h || h === INCOMPLETE) return null;
  const { sample, preferred, mutable, premultiplied, justBounds, scale } = request(options);
  const hardware = preferred === HARDWARE, config = outputConfig(h, preferred);
  const [w, ht] = sampledSize(h, sample);
  if (options) {
    yield setOuts(options, w, ht, h.mime, hardware ? HARDWARE : config);
    if (justBounds) return null;
  }
  const sw = scale === 1 ? w : scaled(w, scale), sh = scale === 1 ? ht : scaled(ht, scale);
  let reuse = inBitmap ? bitmapAt(inBitmap) : null;
  if (reuse?.immutable) reuse = null;
  if (reuse && sw * sh * bytesPerPixel(config) > reuse.allocation) return null;
  const img = yield* awaited(decodePixels(bytes, h, sw, sh, null, false, { unpremul: !premultiplied }));
  // an incomplete input decodes as far as it goes (here: not at all), a corrupt one fails
  if (!img && h.complete) return null;
  const b = placePixels(img, sw, sh, config, h.opaque ? OPAQUE : premultiplied ? PREMUL : UNPREMUL, hardware, reuse);
  b.immutable = !mutable || hardware;
  const chunk = h.patch && h.patch.slice();
  if (chunk && scale !== 1) scalePatch(chunk, sw / w, sh / ht, sw, sh);
  if (padding) setPadding(padding, chunk);
  const insets = yield* awaited(insetsOf(h, scale));
  return javaResult(b, reuse && options![opt().inBitmap] as object, premultiplied, chunk, insets);
});
/** The header's worth of a stream, for a bounds-only decode: as a device's front-buffered stream,
 *  it leaves the rest unread for the caller to reset over. */
const streamHeader = driven(function* streamHeader(stream: unknown, storage: Int8Array): Gen<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (let bytes = new Uint8Array(0); ;) {
    const n: number = yield vcall(stream, "read", "([BII)I", storage, 0, storage.length);
    if (n <= 0) return bytes;
    chunks.push(u8(storage).slice(0, n));
    bytes = concat(chunks);
    if (readHeader(bytes) !== INCOMPLETE) return bytes;
  }
});
const fdBytes = async (fd: object | null) => await javaFdBytes(fdInt(fd as never)) ?? new Uint8Array(0);
rt.registerJnis("android/graphics/BitmapFactory", {
  "nativeDecodeStream(Ljava/io/InputStream;[BLandroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;JJ)Landroid/graphics/Bitmap;":
    driven(function* (stream: unknown, storage: Int8Array, padding: object | null, options: Options | null, inBitmap: bigint): Gen {
      return doDecode(yield* awaited(request(options).justBounds ? streamHeader(stream, storage) : readStreamFully(stream)), padding, options, inBitmap);
    }),
  // decodes from the descriptor's position and leaves it there, as AutoFDSeek restores it
  "nativeDecodeFileDescriptor(Ljava/io/FileDescriptor;Landroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;JJ)Landroid/graphics/Bitmap;":
    driven(function* (fd: object | null, padding: object | null, options: Options | null, inBitmap: bigint): Gen {
      return doDecode(yield* awaited(fdBytes(fd)), padding, options, inBitmap);
    }),
  "nativeDecodeAsset(JLandroid/graphics/Rect;Landroid/graphics/BitmapFactory$Options;JJ)Landroid/graphics/Bitmap;":
    driven(function* (asset: bigint, padding: object | null, options: Options | null, inBitmap: bigint): Gen {
      return doDecode(yield* awaited(assetBytes(asset)), padding, options, inBitmap);
    }),
  "nativeDecodeByteArray([BIILandroid/graphics/BitmapFactory$Options;JJ)Landroid/graphics/Bitmap;":
    (bytes: Int8Array, off: number, len: number, options: Options | null, inBitmap: bigint) => doDecode(u8(bytes, off, len), null, options, inBitmap),
  "nativeIsSeekable(Ljava/io/FileDescriptor;)Z": (fd: object | null) => +(javaSeekFd(fdInt(fd as never), 0, 1) >= 0),
});

/** the encoded image and its header behind a BitmapRegionDecoder's or an ImageDecoder's mNativePtr */
export interface EncodedImage { bytes: Uint8Array; header: ImageHeader }
const encodedAt = (h: bigint) => deref<EncodedImage>(h);

// ── BitmapRegionDecoder: the encoded bytes, decoded a region at a time
const REGION_FORMATS = ["image/jpeg", "image/png", "image/webp", "image/heif", "image/avif"];
function regionDecoder(bytes: Uint8Array) {
  const h = readHeader(bytes);
  if (!h || h === INCOMPLETE || !REGION_FORMATS.includes(h.mime)) throw rt.mkThrowable("java/io/IOException", "Image format not supported");
  return newObj("android/graphics/BitmapRegionDecoder", "(J)V", ownedHandle({ bytes, header: h } satisfies EncodedImage));
}
rt.registerJnis("android/graphics/BitmapRegionDecoder", {
  "nativeNewInstance([BII)Landroid/graphics/BitmapRegionDecoder;": (bytes: Int8Array, off: number, len: number) => regionDecoder(u8(bytes, off, len).slice()),
  "nativeNewInstance(Ljava/io/FileDescriptor;)Landroid/graphics/BitmapRegionDecoder;":
    driven(function* (fd: object | null): Gen { return regionDecoder(yield* awaited(fdBytes(fd))); }),
  "nativeNewInstance(Ljava/io/InputStream;[B)Landroid/graphics/BitmapRegionDecoder;":
    driven(function* (stream: unknown): Gen { return regionDecoder(yield* awaited(readStreamFully(stream))); }),
  "nativeNewInstance(J)Landroid/graphics/BitmapRegionDecoder;": driven(function* (asset: bigint): Gen { return regionDecoder(yield* awaited(assetBytes(asset))); }),
  "nativeGetWidth(J)I": (h: bigint) => encodedAt(h).header.width,
  "nativeGetHeight(J)I": (h: bigint) => encodedAt(h).header.height,
  "nativeClean(J)V": release,
  // SkBitmapRegionDecoder::decodeRegion: the output is the requested rectangle, sampled; the
  // part outside the image stays transparent
  "nativeDecodeRegion(JIIIILandroid/graphics/BitmapFactory$Options;JJ)Landroid/graphics/Bitmap;":
    driven(function* (h: bigint, x: number, y: number, w: number, ht: number, options: Options | null, inBitmap: bigint): Gen {
      const { bytes, header } = encodedAt(h), { sample, preferred, premultiplied } = request(options);
      clearOuts(options);
      const left = Math.max(0, x), top = Math.max(0, y), right = Math.min(header.width, x + w), bottom = Math.min(header.height, y + ht);
      if (right <= left || bottom <= top) return null;
      const reuse = inBitmap ? bitmapAt(inBitmap) : null, hardware = preferred === HARDWARE;
      const config = reuse ? reuse.config : outputConfig(header, preferred);
      const [iw, ih] = sampledSize(header, sample, right - left, bottom - top);
      const bw = iw + Math.trunc((left - x) / sample) + Math.trunc((x + w - right) / sample);
      const bh = ih + Math.trunc((top - y) / sample) + Math.trunc((y + ht - bottom) / sample);
      if (reuse && bw * bh * bytesPerPixel(config) > reuse.allocation) return null;
      // a crop reaching outside the image is transparent there, as the zero-initialized output is
      const img = yield* awaited(decodePixels(bytes, header, bw, bh, [x, y, w, ht], false));
      if (!img && header.complete) return null;
      const b = placePixels(img, bw, bh, config, header.opaque ? OPAQUE : premultiplied ? PREMUL : UNPREMUL, hardware, reuse);
      if (!reuse) b.immutable = true;
      if (options) yield setOuts(options, bw, bh, header.mime, hardware ? HARDWARE : config);
      return javaResult(b, reuse && options![opt().inBitmap] as object, premultiplied);
    }),
});

// ── ImageDecoder: the encoded image behind mNativePtr, decoded by nDecodeBitmap
const DECODER = "android/graphics/ImageDecoder";
/** ImageDecoder.DecodeException's errors */
const SOURCE_EXCEPTION = 1, SOURCE_INCOMPLETE = 2, SOURCE_MALFORMED_DATA = 3;
/** ImageDecoder.cpp's throw_exception: a DecodeException for the source */
const decodeException = (error: number, message: string, cause: unknown, source: unknown) =>
  newObj(`${DECODER}$DecodeException`, "(ILjava/lang/String;Ljava/lang/Throwable;Landroid/graphics/ImageDecoder$Source;)V", error, message, cause, source);
/** ImageDecoder.cpp's native_create: the decoder, sized as EXIF orientation leaves the image */
const createDecoder = driven(function* createDecoder(read: () => Uint8Array | Promise<Uint8Array>, source: unknown): Gen {
  let bytes: Uint8Array;
  try { bytes = yield* awaited(read()); }
  catch (e) {
    if (!iof(e, "java/lang/Throwable")) throw e;
    throw yield decodeException(SOURCE_EXCEPTION, "", e, source);
  }
  const h = readHeader(bytes);
  if (h === INCOMPLETE) throw yield decodeException(SOURCE_INCOMPLETE, "", null, source);
  if (!h) throw yield decodeException(SOURCE_MALFORMED_DATA, "Failed to create image decoder with message 'unimplemented'", null, source);
  const [w, ht] = oriented(h);
  return newObj(DECODER, "(JIIZZ)V", ownedHandle({ bytes, header: h } satisfies EncodedImage), w, ht, +(h.frames > 1), +!!h.patch);
});
/** width and height as SkAndroidCodec reports them once EXIF orientation is applied */
export const oriented = (h: ImageHeader, w = h.width, ht = h.height): [number, number] => h.orientation >= 5 ? [ht, w] : [w, ht];
/** ImageDecoder's allocators */
const ALLOCATOR_DEFAULT = 0, ALLOCATOR_HARDWARE = 3;
/** PixelFormat's answers a PostProcessor gives */
const UNKNOWN = 0, TRANSLUCENT = -3, OPAQUE_FORMAT = -1;
rt.registerJnis(DECODER, {
  "nCreate(JZLandroid/graphics/ImageDecoder$Source;)Landroid/graphics/ImageDecoder;": (asset: bigint, _animation: number, source: unknown) =>
    createDecoder(() => assetBytes(asset), source),
  "nCreate(Ljava/nio/ByteBuffer;IIZLandroid/graphics/ImageDecoder$Source;)Landroid/graphics/ImageDecoder;":
    (buffer: JBuffer, position: number, limit: number, _animation: number, source: unknown) =>
      createDecoder(() => after(readBufferBytes(buffer,position << elementShift(buffer),(limit - position) << elementShift(buffer)), bytes => bytes.slice()), source),
  "nCreate([BIIZLandroid/graphics/ImageDecoder$Source;)Landroid/graphics/ImageDecoder;": (bytes: Int8Array, off: number, len: number, _animation: number, source: unknown) =>
    createDecoder(() => u8(bytes, off, len).slice(), source),
  "nCreate(Ljava/io/InputStream;[BZLandroid/graphics/ImageDecoder$Source;)Landroid/graphics/ImageDecoder;": (stream: unknown, _storage: Int8Array, _animation: number, source: unknown) =>
    createDecoder(() => readStreamFully(stream), source),
  // from the descriptor's position, `length` bytes of it (-1: to the end)
  "nCreate(Ljava/io/FileDescriptor;JZLandroid/graphics/ImageDecoder$Source;)Landroid/graphics/ImageDecoder;": (fd: object | null, length: bigint, _animation: number, source: unknown) =>
    createDecoder(async () => { const b = await fdBytes(fd); return length < 0n ? b : b.subarray(0, Number(length)); }, source),
  "nGetSampledSize(JI)Landroid/util/Size;": (h: bigint, sample: number) => {
    const { header } = encodedAt(h);
    return newObj("android/util/Size", "(II)V", ...oriented(header, ...sampledSize(header, sample)));
  },
  "nGetPadding(JLandroid/graphics/Rect;)V": (h: bigint, pad: object) => setPadding(pad, encodedAt(h).header.patch),
  "nGetMimeType(J)Ljava/lang/String;": (h: bigint) => encodedAt(h).header.mime,
  "nGetColorSpace(J)Landroid/graphics/ColorSpace;": () => namedSpace(0),
  "nClose(J)V": release,
  // ImageDecoder.cpp's nDecodeBitmap: the whole image scaled to the desired size, then cropped
  "nDecodeBitmap(JLandroid/graphics/ImageDecoder;ZIILandroid/graphics/Rect;ZIZZZJZ)Landroid/graphics/Bitmap;":
    driven(function* (h: bigint, jdecoder: object, postProcess: number, w: number, ht: number, cropRect: object | null, mutable: number, allocator: number,
      unpremul: number, conserveMemory: number, alphaMask: number, _cs: bigint, extended: number): Gen {
      const { bytes, header } = encodedAt(h), crop = cropRect && edges(cropRect);
      let config = ARGB_8888;
      if (alphaMask && header.gray) config = ALPHA_8;
      // 565 saves nothing once uploaded as a hardware bitmap, and a post-process may add alpha
      else if (conserveMemory) { if (header.opaque && !postProcess && allocator !== ALLOCATOR_HARDWARE && (allocator !== ALLOCATOR_DEFAULT || mutable)) config = RGB_565; }
      else if (extended) config = RGBA_F16;
      const hardware = !mutable && (allocator === ALLOCATOR_DEFAULT || allocator === ALLOCATOR_HARDWARE) && config !== ALPHA_8;
      const [nw, nh] = oriented(header);
      if (unpremul && !header.opaque && (w !== nw || ht !== nh)) {
        const s = Math.max(1, Math.floor(nw / w)), [sw, sh] = oriented(header, ...sampledSize(header, s));
        if (sw !== w || sh !== ht) throw rt.mkThrowable("java/lang/IllegalStateException", "Cannot scale unpremultiplied pixels!");
      }
      let img = yield* awaited(decodePixels(bytes, header, ...oriented(header, w, ht), null, true, { unpremul: !!unpremul && !crop }));
      const [bw, bh] = crop ? [crop.right - crop.left, crop.bottom - crop.top] : [w, ht];
      if (img && !ArrayBuffer.isView(img) && crop) { const whole = img; img = yield* awaited(createImageBitmap(whole, crop.left, crop.top, bw, bh)); whole.close(); }
      // SkCodec::kIncompleteInput or kErrorInInput: the listener may take what was decoded
      const partial = !header.complete ? SOURCE_INCOMPLETE : !img ? SOURCE_MALFORMED_DATA : 0;
      if (partial) yield vcall(jdecoder, "onPartialImage", "(ILjava/lang/Throwable;)V", partial, null);
      const b = placePixels(img, bw, bh, config, header.opaque ? OPAQUE : unpremul ? UNPREMUL : PREMUL, hardware);
      if (postProcess) {
        const format: number = yield vcall(jdecoder, "postProcessAndRelease", "(Landroid/graphics/Canvas;)I",
          yield newObj("android/graphics/Canvas", "(J)V", handle(bitmapCanvas(b))));
        if (format === TRANSLUCENT) b.alphaType = PREMUL;
        else if (format === OPAQUE_FORMAT) b.alphaType = OPAQUE;
        else if (format !== UNKNOWN) throw rt.mkThrowable("java/lang/IllegalArgumentException", `invalid return from postProcess: ${format}`);
      }
      b.immutable = !mutable;
      return javaBitmap(b, -1, postProcess ? null : header.patch, postProcess ? null : yield* awaited(insetsOf(header, 1)), !unpremul);
    }),
});
