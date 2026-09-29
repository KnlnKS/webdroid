import "../../../src/natives";
import { rt } from "../../../src/jvm/runtime";
import { newObj, vcall, linkInit } from "../../../src/jvm/natives/jlang";
import { JBitmap, JCanvas, JPaint, tintedBmp } from "../../../src/android/graphics";

async function probe() {
  rt.linkNatives();
  const results = [];
  const enums = (await linkInit("android/graphics/BlurMaskFilter$Blur")).ctor;
  for (const style of ["NORMAL", "SOLID", "OUTER", "INNER"]) {
    const value = await vcall(enums, "valueOf", "(Ljava/lang/String;)Landroid/graphics/BlurMaskFilter$Blur;", style);
    const filter = await newObj("android/graphics/BlurMaskFilter", "(FLandroid/graphics/BlurMaskFilter$Blur;)V", 5, value);
    const paint = rt.make("android/graphics/Paint");
    if (!(paint instanceof JPaint)) throw new Error("Invalid Paint");
    paint.color = 0x80ff0000;
    await vcall(paint, "setMaskFilter", "(Landroid/graphics/MaskFilter;)Landroid/graphics/MaskFilter;", filter);
    const ctx = new OffscreenCanvas(80, 80).getContext("2d")!;
    const canvas = JCanvas.wrap(ctx, 80, 80);
    ctx.translate(8, 4);
    ctx.scale(2, 2);
    ctx.beginPath(); ctx.rect(10, 0, 30, 40); ctx.clip();
    const draw = () => vcall(canvas, "drawRect", "(FFFFLandroid/graphics/Paint;)V", 10, 10, 26, 26, paint);
    await draw();
    const first = ctx.getImageData(0, 0, 80, 80).data;
    const alpha = (x: number, y: number) => first[(y * 80 + x) * 4 + 3];
    const m = ctx.getTransform();
    ctx.save(); ctx.resetTransform(); ctx.clearRect(0, 0, 80, 80); ctx.restore();
    await draw();
    const second = ctx.getImageData(0, 0, 80, 80).data;
    let maximum = 0;
    for (let i = 3; i < first.length; i += 4) maximum = Math.max(maximum, first[i]);
    results.push({ style, inside: alpha(44, 40), outside: alpha(64, 40), clipped: alpha(26, 40), maximum,
      restored: m.a === 2 && m.d === 2 && m.e === 8 && m.f === 4 && ctx.filter === "none" && ctx.globalCompositeOperation === "source-over",
      repeated: first.every((v, i) => v === second[i]) });
  }
  const source = JBitmap.create(20, 20);
  source.density = 480;
  source.ctx.fillStyle = "#ff000080"; source.ctx.fillRect(5, 5, 10, 10);
  const paint = new JPaint(); paint.color = 0x4000ff00;
  const extracted = [];
  for (const radius of [0, 1, 2, 3, 5, 10]) for (const style of ["NORMAL", "SOLID", "OUTER", "INNER"]) {
    const value = await vcall(enums, "valueOf", "(Ljava/lang/String;)Landroid/graphics/BlurMaskFilter$Blur;", style);
    const filter = radius ? await newObj("android/graphics/BlurMaskFilter", "(FLandroid/graphics/BlurMaskFilter$Blur;)V", radius, value) : null;
    await vcall(paint, "setMaskFilter", "(Landroid/graphics/MaskFilter;)Landroid/graphics/MaskFilter;", filter);
    const offsets = new Int32Array([99, 99]);
    const alpha = await vcall(source, "extractAlpha", "(Landroid/graphics/Paint;[I)Landroid/graphics/Bitmap;", paint, offsets);
    if (!(alpha instanceof JBitmap)) throw new Error("Invalid alpha bitmap");
    const pixel = await vcall(alpha, "getPixel", "(II)I", 10 - offsets[0], 10 - offsets[1]);
    extracted.push({ radius, style, width: alpha.w, height: alpha.h, offsets: Array.from(offsets), alpha: pixel >>> 24, rgb: pixel & 0xffffff,
      config: alpha.config, density: alpha.density, rowBytes: await vcall(alpha, "getRowBytes", "()I"), distinct: alpha !== source });
  }
  const alpha = await vcall(source, "extractAlpha", "()Landroid/graphics/Bitmap;");
  const ctx = new OffscreenCanvas(40, 40).getContext("2d")!;
  paint.maskFilter = null; paint.color = 0x8000ff00; paint.style = 2;
  await vcall(JCanvas.wrap(ctx, 40, 40), "drawBitmap", "(Landroid/graphics/Bitmap;FFLandroid/graphics/Paint;)V", alpha, 4, 6, paint);
  const shaded = Array.from(ctx.getImageData(14, 16, 1, 1).data);
  const buffer = await vcall((await linkInit("java/nio/ByteBuffer")).ctor, "allocate", "(I)Ljava/nio/ByteBuffer;", 400);
  await vcall(alpha, "copyPixelsToBuffer", "(Ljava/nio/Buffer;)V", buffer);
  const position = await vcall(buffer, "position", "()I");
  await vcall(buffer, "rewind", "()Ljava/nio/Buffer;");
  await vcall(buffer, "put", "(IB)Ljava/nio/ByteBuffer;", 0, 127);
  await vcall(alpha, "copyPixelsFromBuffer", "(Ljava/nio/Buffer;)V", buffer);
  const copiedAlpha = (await vcall(alpha, "getPixel", "(II)I", 0, 0)) >>> 24;
  const originalAlpha = (await vcall(source, "getPixel", "(II)I", 0, 0)) >>> 24;
  ctx.clearRect(0, 0, 40, 40); ctx.translate(20, 20); ctx.rotate(Math.PI / 4);
  ctx.beginPath(); ctx.rect(-8, -8, 16, 16); ctx.clip();
  const before = ctx.getTransform().toString();
  await vcall(JCanvas.wrap(ctx, 40, 40), "drawPaint", "(Landroid/graphics/Paint;)V", paint);
  const plane = { inside: Array.from(ctx.getImageData(20, 20, 1, 1).data), outside: Array.from(ctx.getImageData(0, 0, 1, 1).data), restored: ctx.getTransform().toString() === before };
  const bitmap = JBitmap.create(1, 1);
  bitmap.ctx.fillStyle = "#80402080"; bitmap.ctx.fillRect(0, 0, 1, 1);
  const pixel = (mode: string, color: number) => Array.from(tintedBmp(bitmap, color, null, mode).getContext("2d")!.getImageData(0, 0, 1, 1).data);
  const tints = { identity: tintedBmp(bitmap, 0, null, "PLUS") === bitmap.canvas,
    clear: pixel("SRC_IN", 0), add: pixel("PLUS", 0x40102040), multiply: pixel("MODULATE", 0x8080ff00), before: pixel("SRC_IN", 0x80ff0000) };
  bitmap.ctx.fillStyle = "#fff"; bitmap.ctx.fillRect(0, 0, 1, 1);
  const changed = pixel("SRC_IN", 0x80ff0000);
  return { results, extracted, shaded, position, copiedAlpha, originalAlpha, plane, tints, changed };
}
export default probe;
