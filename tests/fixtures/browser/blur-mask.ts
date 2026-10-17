import "../../../src/natives.ts";
import { newObj, vcall, scall, linkInit, iof } from "../../../src/jvm/natives/jentry.ts";
import { tintedBmp } from "../../../src/android/graphics.ts";
import { newPaint } from "../../../src/android/paint.ts";
import { canvasOver } from "../../../src/android/canvas.ts";
import { NativeBitmap, bitmapOf } from "../../../src/android/bitmap.ts";
import { bootWithFonts } from "./boot.ts";

async function probe() {
  await bootWithFonts();
  const results = [];
  const blur = (style: string) => scall("android/graphics/BlurMaskFilter$Blur", "valueOf", "(Ljava/lang/String;)Landroid/graphics/BlurMaskFilter$Blur;", style);
  for (const style of ["NORMAL", "SOLID", "OUTER", "INNER"]) {
    const value = await blur(style);
    const filter = await newObj("android/graphics/BlurMaskFilter", "(FLandroid/graphics/BlurMaskFilter$Blur;)V", 5, value);
    const paint = await newPaint();
    await vcall(paint, "setColor", "(I)V", 0x80ff0000 | 0);
    await vcall(paint, "setMaskFilter", "(Landroid/graphics/MaskFilter;)Landroid/graphics/MaskFilter;", filter);
    const ctx = new OffscreenCanvas(80, 80).getContext("2d")!;
    const canvas = await canvasOver(ctx, 80, 80);
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
  const argb = (await linkInit("android/graphics/Bitmap$Config")).static("ARGB_8888");
  const source = await scall("android/graphics/Bitmap", "createBitmap", "(IILandroid/graphics/Bitmap$Config;)Landroid/graphics/Bitmap;", 20, 20, argb);
  await vcall(source, "setDensity", "(I)V", 480);
  bitmapOf(source).ctx.fillStyle = "#ff000080"; bitmapOf(source).ctx.fillRect(5, 5, 10, 10);
  const paint = await newPaint();
  await vcall(paint, "setColor", "(I)V", 0x4000ff00);
  const extracted = [];
  for (const radius of [0, 1, 2, 3, 5, 10]) for (const style of ["NORMAL", "SOLID", "OUTER", "INNER"]) {
    const value = await blur(style);
    const filter = radius ? await newObj("android/graphics/BlurMaskFilter", "(FLandroid/graphics/BlurMaskFilter$Blur;)V", radius, value) : null;
    await vcall(paint, "setMaskFilter", "(Landroid/graphics/MaskFilter;)Landroid/graphics/MaskFilter;", filter);
    const offsets = new Int32Array([99, 99]);
    const alpha = await vcall(source, "extractAlpha", "(Landroid/graphics/Paint;[I)Landroid/graphics/Bitmap;", paint, offsets);
    if (!iof(alpha, "android/graphics/Bitmap")) throw new Error("Invalid alpha bitmap");
    const native = bitmapOf(alpha);
    const pixel = await vcall(alpha, "getPixel", "(II)I", 10 - offsets[0], 10 - offsets[1]);
    extracted.push({ radius, style, width: native.w, height: native.h, offsets: Array.from(offsets), alpha: pixel >>> 24, rgb: pixel & 0xffffff,
      config: native.config, density: await vcall(alpha, "getDensity", "()I"), rowBytes: await vcall(alpha, "getRowBytes", "()I"), distinct: alpha !== source });
  }
  const alpha = await vcall(source, "extractAlpha", "()Landroid/graphics/Bitmap;");
  const ctx = new OffscreenCanvas(40, 40).getContext("2d")!;
  await vcall(paint, "setMaskFilter", "(Landroid/graphics/MaskFilter;)Landroid/graphics/MaskFilter;", null);
  await vcall(paint, "setColor", "(I)V", 0x8000ff00 | 0);
  await vcall(paint, "setStyle", "(Landroid/graphics/Paint$Style;)V", (await linkInit("android/graphics/Paint$Style")).static("FILL_AND_STROKE"));
  await vcall(await canvasOver(ctx, 40, 40), "drawBitmap", "(Landroid/graphics/Bitmap;FFLandroid/graphics/Paint;)V", alpha, 4, 6, paint);
  const shaded = Array.from(ctx.getImageData(14, 16, 1, 1).data);
  const buffer = await scall("java/nio/ByteBuffer", "allocate", "(I)Ljava/nio/ByteBuffer;", 400);
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
  await vcall(await canvasOver(ctx, 40, 40), "drawPaint", "(Landroid/graphics/Paint;)V", paint);
  const plane = { inside: Array.from(ctx.getImageData(20, 20, 1, 1).data), outside: Array.from(ctx.getImageData(0, 0, 1, 1).data), restored: ctx.getTransform().toString() === before };
  const bitmap = new NativeBitmap(1, 1);
  bitmap.ctx.fillStyle = "#80402080"; bitmap.ctx.fillRect(0, 0, 1, 1);
  const pixel = (mode: string, color: number) => Array.from((tintedBmp(bitmap, color, null, mode) as OffscreenCanvas).getContext("2d")!.getImageData(0, 0, 1, 1).data);
  const tints = { identity: tintedBmp(bitmap, 0, null, "PLUS") === bitmap.image,
    clear: pixel("SRC_IN", 0), add: pixel("PLUS", 0x40102040), multiply: pixel("MODULATE", 0x8080ff00), before: pixel("SRC_IN", 0x80ff0000) };
  bitmap.ctx.fillStyle = "#fff"; bitmap.ctx.fillRect(0, 0, 1, 1);
  const changed = pixel("SRC_IN", 0x80ff0000);
  return { results, extracted, shaded, position, copiedAlpha, originalAlpha, plane, tints, changed, effects: await effects() };
}
/** path effects, the other mask filters, a shadow layer, text scale and measurement under the text flags */
async function effects() {
  const surface = async () => { const ctx = new OffscreenCanvas(60, 60).getContext("2d")!; return { ctx, canvas: await canvasOver(ctx, 60, 60), alpha: (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[3] }; };
  const set = (paint: unknown, name: string, desc: string, value: unknown) => vcall(paint, name, desc, value);
  const rect = (canvas: unknown, paint: unknown) => vcall(canvas, "drawRect", "(FFFFLandroid/graphics/Paint;)V", 10, 10, 50, 50, paint);
  const corner = await newPaint(), c = await surface();
  await set(corner, "setPathEffect", "(Landroid/graphics/PathEffect;)Landroid/graphics/PathEffect;", await newObj("android/graphics/CornerPathEffect", "(F)V", 12));
  await rect(c.canvas, corner);
  const shadow = await newPaint(), s = await surface();
  await vcall(shadow, "setShadowLayer", "(FFFI)V", 2, 6, 6, 0xff0000ff | 0);
  await vcall(s.canvas, "drawRect", "(FFFFLandroid/graphics/Paint;)V", 10, 10, 30, 30, shadow);
  const emboss = await newPaint(), e = await surface();
  await set(emboss, "setColor", "(I)V", 0xff808080 | 0);
  await set(emboss, "setMaskFilter", "(Landroid/graphics/MaskFilter;)Landroid/graphics/MaskFilter;", await newObj("android/graphics/EmbossMaskFilter", "([FFFF)V", Float32Array.of(-1, -1, 1), 0.4, 8, 4));
  await rect(e.canvas, emboss);
  const shade = (x: number, y: number) => e.ctx.getImageData(x, y, 1, 1).data[0];
  const table = await newPaint(), t = await surface();
  await set(table, "setAlpha", "(I)V", 255);
  await set(table, "setMaskFilter", "(Landroid/graphics/MaskFilter;)Landroid/graphics/MaskFilter;", await scall("android/graphics/TableMaskFilter", "CreateClipTable", "(II)Landroid/graphics/TableMaskFilter;", 0, 0));
  await vcall(t.canvas, "drawCircle", "(FFFLandroid/graphics/Paint;)V", 30, 30, 20.5, table);
  let partial = 0;
  for (const v of t.ctx.getImageData(0, 0, 60, 60).data.filter((_, i) => i % 4 === 3)) if (v && v < 255) partial++;
  const text = await newPaint(), ink = async (scale: number) => {
    const w = await surface();
    await set(text, "setTextSize", "(F)V", 20);
    await set(text, "setTextScaleX", "(F)V", scale);
    await vcall(w.canvas, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "IIII", 2, 40, text);
    let right = 0;
    for (let x = 0; x < 60; x++) for (let y = 20; y < 45; y++) if (w.alpha(x, y)) right = Math.max(right, x);
    return right;
  };
  const measure = async (flags: number) => {
    const p = await newObj("android/graphics/Paint", "(I)V", flags);
    await set(p, "setTextSize", "(F)V", 13.3);
    return vcall(p, "measureText", "(Ljava/lang/String;)F", "Hello World iiilll WWW");
  };
  return { cornerCut: c.alpha(10, 10), cornerCenter: c.alpha(30, 30), shadow: s.alpha(34, 34), noShadow: s.alpha(8, 8),
    emboss: [shade(14, 14), shade(46, 46), shade(30, 30)], tablePartial: partial,
    scaled: [await ink(1), await ink(2)], measured: [await measure(1), await measure(0x81), await measure(0x41)] };
}
export default probe;
