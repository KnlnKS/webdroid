import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JTextPaint } from "../src/android/text";
import { mkCsl } from "../src/android/drawable";
import { typefaceFor } from "../src/android/graphics";

test("text appearances combine font style and apply state colors after virtual measurement", async () => {
  rt.linkNatives();
  const color = mkCsl(0xff123456), link = mkCsl(0xffabcdef);
  const span = await newObj("android/text/style/TextAppearanceSpan", "(Ljava/lang/String;IILandroid/content/res/ColorStateList;Landroid/content/res/ColorStateList;)V", null, 1, 28, color, link);
  const paint = new JTextPaint(); paint.tf = typefaceFor("serif", 2);
  await vcall(span, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
  expect(paint.tf.style()).toBe(3);
  expect(paint.textSize).toBe(28);
  expect(paint.color).not.toBe(color.defColor);
  let calls = 0;
  Object.assign(span, { [mangleMethod("updateMeasureState", "(Landroid/text/TextPaint;)V")]: async (p: JTextPaint) => {
    await Promise.resolve(); calls++; p.textSize = 36;
  } });
  await vcall(span, "updateDrawState", "(Landroid/text/TextPaint;)V", paint);
  expect(calls).toBe(1);
  expect(paint.textSize).toBe(36);
  expect(paint.color).toBe(color.defColor);
  expect(paint.linkColor).toBe(link.defColor);
  expect(await vcall(span, "getTextColor", "()Landroid/content/res/ColorStateList;")).toBe(color);
  expect(rt.iof(span, "android/text/style/MetricAffectingSpan")).toBe(1);
});


test("SuperscriptSpan shifts the existing baseline using virtual ascent without resizing text", async () => {
  rt.linkNatives();
  const span = await newObj("android/text/style/SuperscriptSpan", "()V");
  const paint = new JTextPaint(); paint.baselineShift = 3; paint.textSize = 24;
  Object.assign(paint, { [mangleMethod("ascent", "()F")]: async () => { await Promise.resolve(); return -15; } });
  await vcall(span, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
  expect(paint.baselineShift).toBe(-4);
  await vcall(span, "updateDrawState", "(Landroid/text/TextPaint;)V", paint);
  expect(paint.baselineShift).toBe(-11);
  expect(paint.textSize).toBe(24);
  expect(await vcall(span, "getSpanTypeId", "()I")).toBe(14);
  expect(rt.iof(span, "android/text/style/MetricAffectingSpan")).toBe(1);
});
