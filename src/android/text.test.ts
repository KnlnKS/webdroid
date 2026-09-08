import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";

test("absolute size spans share density-aware measurement and drawing", async () => {
  const paint = await newObj("android/text/TextPaint");
  const span = await newObj("android/text/style/AbsoluteSizeSpan", "(IZ)V", 14, 1);
  paint.density = 2;
  await vcall(span, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
  expect(await vcall(paint, "getTextSize", "()F")).toBe(28);
  paint.density = 3;
  await vcall(span, "updateDrawState", "(Landroid/text/TextPaint;)V", paint);
  expect(await vcall(paint, "getTextSize", "()F")).toBe(42);
  const pixels = await newObj("android/text/style/AbsoluteSizeSpan", "(I)V", 17);
  await vcall(pixels, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
  expect(await vcall(paint, "getTextSize", "()F")).toBe(17);
});
