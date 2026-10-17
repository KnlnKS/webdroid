import "../../../src/natives.ts";
import { vcall, scall } from "../../../src/jvm/natives/jentry.ts";
import { bootPlatform, listener } from "./boot.ts";
import { canvasOver } from "../../../src/android/canvas.ts";

const SRC = "Landroid/graphics/ImageDecoder$Source;";
const image = async (name: string) => { const b = new Uint8Array(await (await fetch(`/tests/fixtures/images/${name}`)).arrayBuffer()); return new Int8Array(b.buffer); };
const pixels = async (b: unknown) => {
  const out: number[] = [], w = await vcall(b, "getWidth", "()I"), h = await vcall(b, "getHeight", "()I");
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.push(await vcall(b, "getPixel", "(II)I", x, y) >>> 0);
  return out;
};

/** Decoded pixels, ImageDecoder's post-processing and an animated GIF's frames, which need the browser's decoders */
async function probe() {
  await bootPlatform();
  const decode = async (name: string) => { const b = await image(name); return scall("android/graphics/BitmapFactory", "decodeByteArray", "([BII)Landroid/graphics/Bitmap;", b, 0, b.length); };
  const png = await pixels(await decode("alpha.png")), jpeg = await pixels(await decode("opaque.jpg")), rotated = await pixels(await decode("rotated.jpg"));
  const truncated = await decode("truncated.png");
  const software = (d: unknown) => vcall(d, "setAllocator", "(I)V", 1);
  const decoded = async (bytes: Int8Array, header: (d: unknown) => unknown) => scall("android/graphics/ImageDecoder", "decodeBitmap",
    `(${SRC}Landroid/graphics/ImageDecoder$OnHeaderDecodedListener;)Landroid/graphics/Bitmap;`,
    await scall("android/graphics/ImageDecoder", "createSource", `([B)${SRC}`, bytes),
    listener("android/graphics/ImageDecoder$OnHeaderDecodedListener", "onHeaderDecoded", `(Landroid/graphics/ImageDecoder;Landroid/graphics/ImageDecoder$ImageInfo;${SRC})V`, header));
  const upright = await decoded(await image("rotated.jpg"), software);
  const processed = await decoded(await image("opaque.jpg"), async (d) => {
    await software(d);
    await vcall(d, "setPostProcessor", "(Landroid/graphics/PostProcessor;)V",
      listener("android/graphics/PostProcessor", "onPostProcess", "(Landroid/graphics/Canvas;)I", async (c: unknown) => { await vcall(c, "drawColor", "(I)V", 0xff0000ff | 0); return -1; }));
  });
  let invalid = "";
  try { await decoded(await image("opaque.jpg"), (d) => vcall(d, "setPostProcessor", "(Landroid/graphics/PostProcessor;)V", listener("android/graphics/PostProcessor", "onPostProcess", "(Landroid/graphics/Canvas;)I", () => -2))); }
  catch (e) { invalid = await vcall(e, "toString", "()Ljava/lang/String;"); }
  const gif = await scall("android/graphics/ImageDecoder", "decodeDrawable", `(${SRC})Landroid/graphics/drawable/Drawable;`,
    await scall("android/graphics/ImageDecoder", "createSource", `([B)${SRC}`, await image("anim.gif")));
  const ctx = new OffscreenCanvas(3, 2).getContext("2d", { willReadFrequently: true })!, canvas = await canvasOver(ctx, 3, 2);
  await vcall(gif, "setBounds", "(IIII)V", 0, 0, 3, 2);
  const frame = async () => { ctx.clearRect(0, 0, 3, 2); await vcall(gif, "draw", "(Landroid/graphics/Canvas;)V", canvas); return Array.from(ctx.getImageData(1, 1, 1, 1).data); };
  for (let i = 0; i < 100 && !(await frame())[3]; i++) await new Promise((r) => setTimeout(r, 10));
  const still = await frame();
  await vcall(gif, "start", "()V");
  const first = await frame();
  await new Promise((r) => setTimeout(r, 150));
  const second = await frame();
  return {
    png, jpeg, rotated, truncated: [await vcall(truncated, "getWidth", "()I"), await vcall(truncated, "getHeight", "()I")],
    upright: [await vcall(upright, "getWidth", "()I"), await vcall(upright, "getHeight", "()I")],
    processed: [await vcall(processed, "getPixel", "(II)I", 0, 0) >>> 0, await vcall(processed, "hasAlpha", "()Z")], invalid,
    gif: { still, first, second, running: await vcall(gif, "isRunning", "()Z") },
  };
}
export default probe;
