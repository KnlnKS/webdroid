import "../../../src/natives.ts";
import { newObj, vcall, iof } from "../../../src/jvm/natives/jentry.ts";
import { newPaint, setFontMetrics } from "../../../src/android/paint.ts";
import { declaredField } from "../../../src/jvm/runtime.ts";
import { canvasOver } from "../../../src/android/canvas.ts";
import { bootWithFonts } from "./boot.ts";

async function probe() {
  await bootWithFonts();
  const paint = await newPaint();
  await vcall(paint, "setTextSize", "(F)V", 12);
  /** a FontMetricsInt's top, bottom, ascent and descent */
  const metric = (fm: object, k: string) => (fm as Record<string, number>)[declaredField("android/graphics/Paint$FontMetricsInt", k)];
  const results = [];
  for (const alignment of [0, 1, 2]) {
    const drawable = await newObj("android/graphics/drawable/ColorDrawable", "(I)V", 0xff00ff00);
    await vcall(drawable, "setBounds", "(IIII)V", 2, 3, 14, 17);
    const span = await newObj("android/text/style/ImageSpan", "(Landroid/graphics/drawable/Drawable;I)V", drawable, alignment);
    const metrics = await newObj("android/graphics/Paint$FontMetricsInt", "()V");
    setFontMetrics(metrics, true, 0, 0, 0, 0, 0);
    const width = await vcall(span, "getSize", "(Landroid/graphics/Paint;Ljava/lang/CharSequence;IILandroid/graphics/Paint$FontMetricsInt;)I", paint, "x", 0, 1, metrics);
    const fm = { top: metric(metrics, "top"), bottom: metric(metrics, "bottom"), ascent: metric(metrics, "ascent"), descent: metric(metrics, "descent") };
    const ctx = new OffscreenCanvas(60, 70).getContext("2d")!;
    await vcall(span, "draw", "(Landroid/graphics/Canvas;Ljava/lang/CharSequence;IIFIIILandroid/graphics/Paint;)V", await canvasOver(ctx, 60, 70), "x", 0, 1, 5, 10, 40, 50, paint);
    const pixels = ctx.getImageData(0, 0, 60, 70).data;
    const y = alignment === 0 ? 36 : alignment === 1 ? 36 - metric(await vcall(paint, "getFontMetricsInt", "()Landroid/graphics/Paint$FontMetricsInt;"), "descent") : 26;
    results.push({ width, fm, aligned: pixels[(y * 60 + 7) * 4 + 1] === 255 && pixels[((y - 1) * 60 + 7) * 4 + 3] === 0,
      restored: ctx.getTransform().isIdentity, hierarchy: iof(span, "android/text/style/DynamicDrawableSpan") });
  }
  await vcall(paint, "setShadowLayer", "(FFFI)V", 1, 10, 2, 0xffff0000);
  const getters = await Promise.all(["Radius", "Dx", "Dy", "Color"].map(n => vcall(paint, "getShadowLayer" + n, "()" + (n === "Color" ? "I" : "F"))));
  await vcall(paint, "setTextSize", "(F)V", 30);
  const ctx = new OffscreenCanvas(120, 50).getContext("2d")!;
  const canvas = await canvasOver(ctx, 120, 50);
  await vcall(canvas, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "I", 5, 35, paint);
  const pixels = ctx.getImageData(0, 0, 120, 50).data;
  const red = pixels.some((v, i) => i % 4 === 0 && v > 100 && pixels[i + 1] === 0 && pixels[i + 3] > 20);
  return { results, getters, red, shadowRestored: ctx.shadowColor === "rgba(0, 0, 0, 0)" };
}
export default probe;
