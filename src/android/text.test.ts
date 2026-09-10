import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";
import { rt } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";

test("capitalization distinguishes paragraphs, words, sentences and abbreviations", async () => {
  const caps = rt.link("android/text/TextUtils").ctor[mangleMethod("getCapsMode", "(Ljava/lang/CharSequence;II)I")];
  for (const [text, requested, expected] of [
    ["", 0x4000, 0x2000], ["hello ", 0x2000, 0x2000],
    ["hello ", 0x4000, 0], ["Hello. ", 0x4000, 0x4000],
    ["U.S. ", 0x4000, 0], ["Yes!) \"(", 0x5000, 0x5000],
    ["paragraph\n  (", 0x4000, 0x2000], ["word", 0x7000, 0x1000],
  ] as const) {
    const cs = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", text);
    expect(await caps(cs, text.length, requested)).toBe(expected);
  }
  expect(await caps("text", -1, 0x7000)).toBe(0);
});

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
