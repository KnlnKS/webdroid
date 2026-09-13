import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("style spans preserve existing italics for drawing and measurement", async () => {
  const typeface = rt.link("android/graphics/Typeface").ctor;
  const italic = await vcall(typeface, "create", "(Ljava/lang/String;I)Landroid/graphics/Typeface;", "serif", 2);
  const span = await newObj("android/text/style/StyleSpan", "(I)V", 1);
  for (const method of ["updateDrawState", "updateMeasureState"]) {
    const paint = await newObj("android/text/TextPaint", "()V");
    await vcall(paint, "setTypeface", "(Landroid/graphics/Typeface;)Landroid/graphics/Typeface;", italic);
    await vcall(span, method, "(Landroid/text/TextPaint;)V", paint);
    const face = await vcall(paint, "getTypeface", "()Landroid/graphics/Typeface;");
    expect(await vcall(face, "getStyle", "()I")).toBe(3);
    expect(await vcall(face, "getWeight", "()I")).toBe(700);
  }
  expect(await vcall(italic, "getStyle", "()I")).toBe(2);
});

test("style span weight adjustment clamps to Android's supported range", async () => {
  for (const [adjustment, weight] of [[900, 1000], [-900, 1]]) {
    const paint = await newObj("android/text/TextPaint", "()V");
    const span = await newObj("android/text/style/StyleSpan", "(II)V", 1, adjustment);
    await vcall(span, "updateDrawState", "(Landroid/text/TextPaint;)V", paint);
    const face = await vcall(paint, "getTypeface", "()Landroid/graphics/Typeface;");
    expect(await vcall(face, "getWeight", "()I")).toBe(weight);
  }
});

test("relative size spans multiply the current size for drawing and measurement", async () => {
  const span = await newObj("android/text/style/RelativeSizeSpan", "(F)V", 1.5);
  expect(await vcall(span, "getSizeChange", "()F")).toBe(1.5);
  for (const method of ["updateDrawState", "updateMeasureState"]) {
    const paint = await newObj("android/text/TextPaint", "()V");
    await vcall(paint, "setTextSize", "(F)V", 20);
    await vcall(span, method, "(Landroid/text/TextPaint;)V", paint);
    expect(await vcall(paint, "getTextSize", "()F")).toBe(30);
  }
});
