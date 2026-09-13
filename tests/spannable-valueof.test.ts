import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("SpannableString.valueOf keeps string identity and copies mutable builders with spans", async () => {
  const builder = await newObj("android/text/SpannableStringBuilder", "(Ljava/lang/CharSequence;)V", "abc");
  const span = new JObj();
  await vcall(builder, "setSpan", "(Ljava/lang/Object;III)V", span, 0, 2, 33);
  const value = await vcall(rt.link("android/text/SpannableString").ctor, "valueOf", "(Ljava/lang/CharSequence;)Landroid/text/SpannableString;", builder);
  expect(value).not.toBe(builder);
  expect(await vcall(rt.link("android/text/SpannableString").ctor, "valueOf", "(Ljava/lang/CharSequence;)Landroid/text/SpannableString;", value)).toBe(value);
  await vcall(builder, "clear", "()V");
  expect(await vcall(value, "toString", "()Ljava/lang/String;")).toBe("abc");
  expect(await vcall(value, "getSpanEnd", "(Ljava/lang/Object;)I", span)).toBe(2);
});
