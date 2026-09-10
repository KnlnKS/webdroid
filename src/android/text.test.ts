import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";
import { rt } from "../jvm/runtime";
import { mangleMethod } from "../jvm/abi";

test("SpannedString snapshots spans without exposing mutable Spannable methods", async () => {
  const source = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "caption");
  const marker = await newObj("android/text/style/StyleSpan", "(I)V", 1);
  await vcall(source, "setSpan", "(Ljava/lang/Object;III)V", marker, 1, 5, 33);
  const copy = await newObj("android/text/SpannedString", "(Ljava/lang/CharSequence;)V", source);
  await vcall(source, "setSpan", "(Ljava/lang/Object;III)V", marker, 0, 7, 17);
  expect(await vcall(copy, "getSpanStart", "(Ljava/lang/Object;)I", marker)).toBe(1);
  expect(await vcall(copy, "getSpanEnd", "(Ljava/lang/Object;)I", marker)).toBe(5);
  expect(rt.iof(copy, "android/text/Spannable")).toBe(0);
  expect(copy[mangleMethod("setSpan", "(Ljava/lang/Object;III)V")]).toBeUndefined();
  const slice = await vcall(copy, "subSequence", "(II)Ljava/lang/CharSequence;", 2, 6);
  expect(await vcall(slice, "toString", "()Ljava/lang/String;")).toBe("ptio");
  expect(await vcall(slice, "getSpanStart", "(Ljava/lang/Object;)I", marker)).toBe(0);
  const valueOf = rt.link("android/text/SpannedString").ctor[mangleMethod("valueOf", "(Ljava/lang/CharSequence;)Landroid/text/SpannedString;")];
  expect(valueOf(copy)).toBe(copy);
});

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
