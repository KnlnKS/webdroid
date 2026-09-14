import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JTextPaint } from "../src/android/text";

rt.linkNatives();
test("style wrappers remain distinct while forwarding draw and measure state", async () => {
  const wrap = (style: unknown) => vcall(rt.link("android/text/style/CharacterStyle").ctor, "wrap", "(Landroid/text/style/CharacterStyle;)Landroid/text/style/CharacterStyle;", style);
  const style = await newObj("android/text/style/AbsoluteSizeSpan", "(I)V", 23);
  const first = await wrap(style), second = await wrap(first);
  expect(second).not.toBe(first);
  expect(rt.iof(second, "android/text/style/MetricAffectingSpan")).toBe(1);
  expect(await vcall(second, "getUnderlying", "()Landroid/text/style/CharacterStyle;")).toBe(style);
  expect(await vcall(second, "getUnderlying", "()Landroid/text/style/MetricAffectingSpan;")).toBe(style);
  const paint = rt.make("android/text/TextPaint") as JTextPaint;
  await vcall(second, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
  expect(paint.textSize).toBe(23);
  const color = await newObj("android/text/style/ForegroundColorSpan", "(I)V", -65536);
  const colorWrapper = await wrap(color);
  expect(rt.iof(colorWrapper, "android/text/style/MetricAffectingSpan")).toBe(0);
  await vcall(colorWrapper, "updateDrawState", "(Landroid/text/TextPaint;)V", paint);
  expect(paint.color).toBe(-65536);
});
