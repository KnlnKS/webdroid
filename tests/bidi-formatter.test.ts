import { expect, test } from "bun:test";
import "../src/natives";
import { mangleStaticField } from "../src/jvm/abi";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("bidi wrapping isolates opposite-direction text and retains embedded spans", async () => {
  const ltr = await vcall(rt.link("android/text/BidiFormatter").ctor, "getInstance", "(Z)Landroid/text/BidiFormatter;", 0);
  const rtl = await vcall(rt.link("android/text/BidiFormatter").ctor, "getInstance", "(Z)Landroid/text/BidiFormatter;", 1);
  const wrap = (formatter: unknown, text: string) => vcall(formatter, "unicodeWrap", "(Ljava/lang/String;)Ljava/lang/String;", text);
  expect(await wrap(ltr, "Golden Gate Bridge")).toBe("Golden Gate Bridge");
  expect(await wrap(ltr, "שלום")).toBe("\u200e\u202bשלום\u202c\u200e");
  expect(await wrap(rtl, "Bridge")).toBe("\u200f\u202aBridge\u202c\u200f");
  expect(await wrap(ltr, "Bridge שלום")).toBe("Bridge שלום\u200e");
  expect(await wrap(ltr, "\u202b123\u202c")).toBe("\u200e\u202b123\u202c\u200e");
  const source = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "שלום");
  const span = new JObj();
  await vcall(source, "setSpan", "(Ljava/lang/Object;III)V", span, 1, 3, 33);
  const wrapped = await vcall(ltr, "unicodeWrap", "(Ljava/lang/CharSequence;)Ljava/lang/CharSequence;", source);
  expect(await vcall(wrapped, "getSpanStart", "(Ljava/lang/Object;)I", span)).toBe(3);
  expect(await vcall(source, "getSpanStart", "(Ljava/lang/Object;)I", span)).toBe(1);
});

test("first-strong heuristics ignore isolate contents and respect the requested range", async () => {
  const heuristics = rt.link("android/text/TextDirectionHeuristics").ctor;
  const ltr = heuristics[mangleStaticField("FIRSTSTRONG_LTR")];
  const check = (text: string, start = 0, count = text.length) => vcall(ltr, "isRtl", "(Ljava/lang/CharSequence;II)Z", text, start, count);
  expect(await check("\u2067שלום\u2069Bridge")).toBe(0);
  expect(await check("\u2066Bridge\u2069שלום")).toBe(1);
  expect(await check("aשלום", 1, 4)).toBe(1);
});
