import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("character categories preserve Java category numbers and supplementary characters", async () => {
  const cls = rt.link("java/lang/Character").ctor;
  for (const [cp, category] of [[65, 1], [97, 2], [0x301, 6], [48, 9], [32, 12], [10, 15], [0xd800, 19], [45, 20], [95, 23], [0x1f600, 28], [0x378, 0], [-1, 0], [0x110000, 0]]) {
    expect(await vcall(cls, "getType", "(I)I", cp)).toBe(category);
    expect(await vcall(cls, "isDefined", "(I)Z", cp)).toBe(+(category !== 0));
  }
  expect(await vcall(cls, "getType", "(C)I", 0xd800)).toBe(19);
});
test("code point offsets count pairs once and retain unpaired surrogates", async () => {
  const text = "a\ud83d\ude00\ud800b\udc00";
  const offset = (value: unknown, index: number, count: number) => vcall(rt.link("java/lang/Character").ctor, "offsetByCodePoints", "(Ljava/lang/CharSequence;II)I", value, index, count);
  for (const value of [text, await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", text)]) {
    expect(await offset(value, 0, 2)).toBe(3);
    expect(await offset(value, 6, -4)).toBe(1);
    expect(await offset(value, 2, 1)).toBe(3);
    for (const [index, count] of [[-1, 0], [7, 0], [0, 6], [6, -6]]) {
      let error: unknown;
      try { await offset(value, index, count); } catch (e) { error = e; }
      expect(rt.iof(error, "java/lang/IndexOutOfBoundsException")).toBe(1);
    }
  }
  expect(await vcall(text, "offsetByCodePoints", "(II)I", 0, 2)).toBe(3);
});
