import "../../../src/natives";
import { rt } from "../../../src/jvm/runtime";
import { mangleMethod } from "../../../src/jvm/abi";
import { newObj, vcall } from "../../../src/jvm/natives/jlang";
import { JCanvas, JPaint, copyPaint } from "../../../src/android/graphics";
import { JTextView } from "../../../src/android/textview";

async function probe() {
  rt.linkNatives();
  const paint = rt.make("android/graphics/Paint");
  if (!(paint instanceof JPaint)) throw new Error("Invalid Paint");
  paint.textSize = 12;
  const results = [];
  for (const alignment of [0, 1, 2]) {
    const drawable = await newObj("android/graphics/drawable/ColorDrawable", "(I)V", 0xff00ff00);
    await vcall(drawable, "setBounds", "(IIII)V", 2, 3, 14, 17);
    const span = await newObj("android/text/style/ImageSpan", "(Landroid/graphics/drawable/Drawable;I)V", drawable, alignment);
    let loads = 0, draws = 0;
    Object.assign(span, { [mangleMethod("getDrawable", "()Landroid/graphics/drawable/Drawable;")]: async () => { loads++; await Promise.resolve(); return drawable; } });
    Object.assign(drawable, { [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]: async (canvas: JCanvas) => {
      await Promise.resolve(); draws++; canvas.ctx.fillStyle = "#00ff00"; canvas.ctx.fillRect(2, 3, 12, 14);
    } });
    const fm = { top: 0, bottom: 0, ascent: 0, descent: 0 };
    const width = await vcall(span, "getSize", "(Landroid/graphics/Paint;Ljava/lang/CharSequence;IILandroid/graphics/Paint$FontMetricsInt;)I", paint, "x", 0, 1, fm);
    const ctx = new OffscreenCanvas(60, 70).getContext("2d")!;
    await vcall(span, "draw", "(Landroid/graphics/Canvas;Ljava/lang/CharSequence;IIFIIILandroid/graphics/Paint;)V", JCanvas.wrap(ctx, 60, 70), "x", 0, 1, 5, 10, 40, 50, paint);
    const pixels = ctx.getImageData(0, 0, 60, 70).data;
    const y = alignment === 0 ? 36 : alignment === 1 ? 36 - (await vcall(paint, "getFontMetricsInt", "()Landroid/graphics/Paint$FontMetricsInt;")).descent : 26;
    results.push({ width, fm, loads, draws, aligned: pixels[(y * 60 + 7) * 4 + 1] === 255 && pixels[((y - 1) * 60 + 7) * 4 + 3] === 0,
      restored: ctx.getTransform().isIdentity, hierarchy: rt.iof(span, "android/text/style/DynamicDrawableSpan") });
  }
  const text = rt.make("android/widget/TextView");
  if (!(text instanceof JTextView)) throw new Error("Invalid TextView");
  await vcall(text, "setShadowLayer", "(FFFI)V", 1, 10, 2, 0xffff0000);
  const getters = await Promise.all(["Radius", "Dx", "Dy", "Color"].map(n => vcall(text, "getShadow" + n, "()" + (n === "Color" ? "I" : "F"))));
  copyPaint(text.paintT, paint); paint.textSize = 30;
  const ctx = new OffscreenCanvas(120, 50).getContext("2d")!;
  const canvas = JCanvas.wrap(ctx, 120, 50);
  await vcall(canvas, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "I", 5, 35, paint);
  const pixels = ctx.getImageData(0, 0, 120, 50).data;
  const red = pixels.some((v, i) => i % 4 === 0 && v > 100 && pixels[i + 1] === 0 && pixels[i + 3] > 20);
  return { results, getters, red, shadowRestored: ctx.shadowColor === "rgba(0, 0, 0, 0)" };
}
export default probe;
