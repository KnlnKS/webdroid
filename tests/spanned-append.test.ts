import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

class RangeSequence extends JObj {}
rt.register({ name: "test/RangeSequence", ctor: RangeSequence, ifaces: ["java/lang/CharSequence"], methods: {
  "<init>()V": () => {},
  "length()I": () => 6,
  "charAt(I)C": (index: number) => "abcabc".charCodeAt(index),
  "toString()Ljava/lang/String;": () => { throw new Error("range append must not stringify the whole sequence"); },
} });
rt.linkNatives();

test("StringBuilder appends a CharSequence range through charAt", async () => {
  const builder = await newObj("java/lang/StringBuilder", "()V");
  const sequence = await newObj("test/RangeSequence", "()V");
  await vcall(builder, "append", "(Ljava/lang/CharSequence;II)Ljava/lang/StringBuilder;", sequence, 1, 5);
  expect(await vcall(builder, "toString", "()Ljava/lang/String;")).toBe("bcab");
});

test("appending styled text retains span identity and offsets without coloring the following text", async () => {
  const word = await newObj("android/text/SpannableString", "(Ljava/lang/CharSequence;)V", "Games");
  const color = await newObj("android/text/style/ForegroundColorSpan", "(I)V", -1);
  await vcall(word, "setSpan", "(Ljava/lang/Object;III)V", color, 0, 5, 33);
  const line = await newObj("android/text/SpannableStringBuilder", "(Ljava/lang/CharSequence;)V", "Play ");
  await vcall(line, "append", "(Ljava/lang/CharSequence;)Landroid/text/SpannableStringBuilder;", word);
  await vcall(line, "append", "(Ljava/lang/CharSequence;)Landroid/text/SpannableStringBuilder;", " together");
  expect(await vcall(line, "toString", "()Ljava/lang/String;")).toBe("Play Games together");
  expect(await vcall(line, "getSpans", "(IILjava/lang/Class;)[Ljava/lang/Object;", 0, 19, rt.classFor("android/text/style/ForegroundColorSpan"))).toEqual(Object.assign([color], {$t:"Landroid/text/style/ForegroundColorSpan;"}));
  expect(await vcall(line, "getSpanStart", "(Ljava/lang/Object;)I", color)).toBe(5);
  expect(await vcall(line, "getSpanEnd", "(Ljava/lang/Object;)I", color)).toBe(10);
  expect(await vcall(word, "getSpanStart", "(Ljava/lang/Object;)I", color)).toBe(0);
});
