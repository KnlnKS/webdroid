import { JObj, rt, noops, driven, type Gen } from "../jvm/runtime";
import { newObj, vcall, vcallOn, curThread, after } from "../jvm/natives/jlang";
import { readStreamFully } from "../jvm/natives/jio";
import { resident, remainingBytes, type JBuffer } from "../jvm/natives/jnio";
import { readHeader, decodePixels, INCOMPLETE } from "./decode";
import { NativeBitmap, javaBitmap, ARGB_8888, OPAQUE, PREMUL, UNPREMUL } from "./bitmap";
import { drawableFromBitmap } from "./drawable";
import { device } from "../shell/config";

class JImageSource extends JObj { read!: () => Promise<Uint8Array>; }
class JImageInfo extends JObj { size: unknown = null; }
class JImageDecoder extends JObj { width = 0; height = 0; unpremultiplied = false; }
function streamSource(open: () => Promise<unknown>): JImageSource {
  const source = rt.make("android/graphics/ImageDecoder$Source") as JImageSource;
  source.read = async () => {
    const stream = await open();
    try { return await readStreamFully(stream); }
    finally { await vcall(stream, "close", "()V"); }
  };
  return source;
}
/** a source's bytes: our own sources read themselves; a resource's asset stream is AOSP's
 *  AssetInputStreamSource, which ResourcesImpl builds over the asset it opened */
async function sourceBytes(source: JImageSource): Promise<Uint8Array> {
  if (typeof source.read === "function") return source.read();
  const stream = (source as unknown as Record<string, unknown>)[rt.fieldProp("android/graphics/ImageDecoder$AssetInputStreamSource", "mAssetInputStream") ?? ""];
  if (!stream) throw rt.mkThrowable("java/io/IOException", "Unsupported image source");
  try { return await readStreamFully(stream); }
  finally { await vcall(stream, "close", "()V"); }
}
async function decode(source: JImageSource, listener: unknown, density = -1) {
  // the listener runs on the decoding thread, whichever thread the awaits below resume on
  const thread = curThread;
  const decoder = rt.make("android/graphics/ImageDecoder") as JImageDecoder;
  const bytes = await sourceBytes(source), h = readHeader(bytes);
  if (!h || h === INCOMPLETE) throw rt.mkThrowable("java/io/IOException", "Unable to decode image");
  decoder.width = h.width; decoder.height = h.height;
  const info = rt.make("android/graphics/ImageDecoder$ImageInfo") as JImageInfo;
  info.size = await newObj("android/util/Size", "(II)V", h.width, h.height);
  if (listener) await vcallOn(thread, listener, "onHeaderDecoded",
    "(Landroid/graphics/ImageDecoder;Landroid/graphics/ImageDecoder$ImageInfo;Landroid/graphics/ImageDecoder$Source;)V", decoder, info, source);
  const img = await decodePixels(bytes, h, decoder.width, decoder.height, null, true);
  if (!img) throw rt.mkThrowable("java/io/IOException", "Unable to decode image");
  const b = new NativeBitmap(decoder.width, decoder.height, ARGB_8888, h.opaque ? OPAQUE : decoder.unpremultiplied ? UNPREMUL : PREMUL);
  b.setImage(img);
  b.immutable = true;
  return javaBitmap(b, density, h.patch);
}
rt.register({ name: "android/graphics/ImageDecoder$Source", ctor: JImageSource });
rt.register({ name: "android/graphics/ImageDecoder$ImageInfo", ctor: JImageInfo, methods: {
  "getSize()Landroid/util/Size;": function (this: JImageInfo) { return this.size; },
} });
for (const name of ["OnHeaderDecodedListener", "OnPartialImageListener"])
  rt.register({ name: "android/graphics/ImageDecoder$" + name, ctor: class extends JObj {} });
rt.register({ name: "android/graphics/ImageDecoder", ctor: JImageDecoder, methods: {
  "static createSource(Ljava/io/File;)Landroid/graphics/ImageDecoder$Source;": (file: unknown) =>
    streamSource(() => newObj("java/io/FileInputStream", "(Ljava/io/File;)V", file)),
  "static createSource(Landroid/content/res/Resources;I)Landroid/graphics/ImageDecoder$Source;": (res: unknown, id: number) =>
    streamSource(() => vcall(res, "openRawResource", "(I)Ljava/io/InputStream;", id)),
  "static createSource(Landroid/content/res/AssetManager;Ljava/lang/String;)Landroid/graphics/ImageDecoder$Source;": (assets: unknown, path: string) =>
    streamSource(() => vcall(assets, "open", "(Ljava/lang/String;)Ljava/io/InputStream;", path)),
  "static createSource(Ljava/util/concurrent/Callable;)Landroid/graphics/ImageDecoder$Source;": (callable: unknown) =>
    streamSource(async () => vcall(await vcall(callable, "call", "()Ljava/lang/Object;"), "createInputStream", "()Ljava/io/FileInputStream;")),
  "static createSource(Ljava/nio/ByteBuffer;)Landroid/graphics/ImageDecoder$Source;": (buffer: JBuffer) => after(resident(buffer), () => {
    const bytes = remainingBytes(buffer).slice();
    const source = rt.make("android/graphics/ImageDecoder$Source") as JImageSource;
    source.read = async () => bytes;
    return source;
  }),
  "static decodeBitmap(Landroid/graphics/ImageDecoder$Source;Landroid/graphics/ImageDecoder$OnHeaderDecodedListener;)Landroid/graphics/Bitmap;": decode,
  // a bitmap at its source's density, as a nine-patch when it carries a chunk
  "static decodeDrawable(Landroid/graphics/ImageDecoder$Source;Landroid/graphics/ImageDecoder$OnHeaderDecodedListener;)Landroid/graphics/drawable/Drawable;":
    driven(function* (source: JImageSource, listener: unknown): Gen {
      if (!listener) throw rt.mkThrowable("java/lang/IllegalArgumentException", "listener cannot be null! Use decodeDrawable(Source) to not have a listener");
      const density: number = yield vcall(source, "getDensity", "()I");
      return drawableFromBitmap(yield decode(source, listener, density || -1), device.densityDpi);
    }),
  "setTargetSize(II)V": function (this: JImageDecoder, width: number, height: number) {
    if (width <= 0 || height <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Target size must be positive");
    this.width = width; this.height = height;
  },
  "setUnpremultipliedRequired(Z)V": function (this: JImageDecoder, required: number) { this.unpremultiplied = !!required; },
  ...noops("setAllocator(I)V", "setMemorySizePolicy(I)V", "setTargetColorSpace(Landroid/graphics/ColorSpace;)V",
    "setOnPartialImageListener(Landroid/graphics/ImageDecoder$OnPartialImageListener;)V"),
} });
