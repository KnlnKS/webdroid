import { JObj, rt, noops } from "../jvm/runtime";
import { newObj, vcall, after } from "../jvm/natives/jlang";
import { readStreamFully } from "../jvm/natives/jio";
import { resident, type JBuffer } from "../jvm/natives/jnio";
import { decodeBytes } from "./graphics";
import { u8 } from "../jvm/abi";

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
async function decode(source: JImageSource, listener: unknown) {
  const decoder = rt.make("android/graphics/ImageDecoder") as JImageDecoder;
  try {
    const bitmap = await decodeBytes(await source.read(), null, async (width, height) => {
      decoder.width = width; decoder.height = height;
      const info = rt.make("android/graphics/ImageDecoder$ImageInfo") as JImageInfo;
      info.size = await newObj("android/util/Size", "(II)V", width, height);
      if (listener) await vcall(listener, "onHeaderDecoded",
        "(Landroid/graphics/ImageDecoder;Landroid/graphics/ImageDecoder$ImageInfo;Landroid/graphics/ImageDecoder$Source;)V", decoder, info, source);
      return [decoder.width, decoder.height];
    });
    if (!bitmap) throw rt.mkThrowable("java/io/IOException", "Unable to decode image");
    rt.link("android/graphics/Bitmap");
    bitmap.premultiplied = !decoder.unpremultiplied;
    bitmap.immutable = true;
    return bitmap;
  } catch (error) {
    if (error instanceof DOMException) throw rt.mkThrowable("java/io/IOException", error.message);
    throw error;
  }
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
    const view = buffer.dv, bytes = u8(view, buffer.pos, buffer.lim - buffer.pos);
    const source = rt.make("android/graphics/ImageDecoder$Source") as JImageSource;
    source.read = async () => bytes;
    return source;
  }),
  "static decodeBitmap(Landroid/graphics/ImageDecoder$Source;Landroid/graphics/ImageDecoder$OnHeaderDecodedListener;)Landroid/graphics/Bitmap;": decode,
  "setTargetSize(II)V": function (this: JImageDecoder, width: number, height: number) {
    if (width <= 0 || height <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Target size must be positive");
    this.width = width; this.height = height;
  },
  "setUnpremultipliedRequired(Z)V": function (this: JImageDecoder, required: number) { this.unpremultiplied = !!required; },
  ...noops("setAllocator(I)V", "setMemorySizePolicy(I)V", "setTargetColorSpace(Landroid/graphics/ColorSpace;)V",
    "setOnPartialImageListener(Landroid/graphics/ImageDecoder$OnPartialImageListener;)V"),
} });
