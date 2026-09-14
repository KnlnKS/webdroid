import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JSpanned, csText } from "../src/android/text";

rt.linkNatives();
const concat = (...parts: unknown[]) => vcall(rt.link("android/text/TextUtils").ctor, "concat", "([Ljava/lang/CharSequence;)Ljava/lang/CharSequence;", parts);
test("concat retains image spans and offsets through nested concatenations", async () => {
  const drawable = rt.make("android/graphics/drawable/ColorDrawable");
  const span = await newObj("android/text/style/ImageSpan", "(Landroid/graphics/drawable/Drawable;)V", drawable);
  const text = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "image");
  await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", span, 0, 5, 0x21);
  const first = await concat("4.8 ", text);
  const result = await concat(first, " (100)");
  expect(rt.iof(result, "android/text/SpannedString")).toBe(1);
  expect(rt.iof(result, "android/text/Spannable")).toBe(0);
  expect(await csText(result)).toBe("4.8 image (100)");
  expect(await vcall(result, "getSpanStart", "(Ljava/lang/Object;)I", span)).toBe(4);
  expect(await vcall(result, "getSpanEnd", "(Ljava/lang/Object;)I", span)).toBe(9);
  expect(await vcall(result, "getSpanFlags", "(Ljava/lang/Object;)I", span)).toBe(0x21);
  await vcall(text, "removeSpan", "(Ljava/lang/Object;)V", span);
  expect(await vcall(result, "getSpanStart", "(Ljava/lang/Object;)I", span)).toBe(4);
});
test("concat preserves one-piece identity, null text and span ownership", async () => {
  expect(await concat()).toBe("");
  expect(await concat(null)).toBeNull();
  expect(await concat("a", null, "b")).toBe("anullb");
  const text = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "ab");
  const span = rt.make("java/lang/Object"), noCopy = rt.make("android/text/NoCopySpan");
  await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", span, 0, 1, 0x21);
  await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", noCopy, 0, 2, 0x12);
  expect(await concat(text)).toBe(text);
  const result = await concat(text, text);
  if (!(result instanceof JSpanned)) throw new Error("Missing spans");
  expect(result.spans).toEqual([{ span, start: 0, end: 1, flags: 0x21 }]);
});
test("concat honors inclusive endpoints while appending later pieces", async () => {
  const text = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "ab");
  const span = rt.make("java/lang/Object");
  await vcall(text, "setSpan", "(Ljava/lang/Object;III)V", span, 0, 2, 0x12);
  const result = await concat("prefix", text, "tail");
  expect(await vcall(result, "getSpanStart", "(Ljava/lang/Object;)I", span)).toBe(6);
  expect(await vcall(result, "getSpanEnd", "(Ljava/lang/Object;)I", span)).toBe(12);
});
