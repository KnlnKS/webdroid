import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleStaticField } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JTextPaint } from "../src/android/text";

rt.linkNatives();

function heuristic(name: string): unknown {
  return Object.getOwnPropertyDescriptor(
    rt.link("android/text/TextDirectionHeuristics").ctor,
    mangleStaticField(name),
  )?.value;
}

test("TextPaint exposes and copies custom underline state", async () => {
  const source = await newObj("android/text/TextPaint");
  const target = await newObj("android/text/TextPaint");
  expect(source).toBeInstanceOf(JTextPaint);
  expect(target).toBeInstanceOf(JTextPaint);
  if (!(source instanceof JTextPaint) || !(target instanceof JTextPaint)) return;
  expect(source.underlineColor).toBe(0);
  expect(source.underlineThickness).toBe(0);
  const color = 0xff123456 | 0;
  source.underlineColor = color;
  source.underlineThickness = 2.5;
  await vcall(target, "set", "(Landroid/text/TextPaint;)V", source);
  expect(target.underlineColor).toBe(color);
  expect(target.underlineThickness).toBe(2.5);
});

test("text direction heuristics inspect the requested range", async () => {
  const firstLtr = heuristic("FIRSTSTRONG_LTR");
  const firstRtl = heuristic("FIRSTSTRONG_RTL");
  const anyRtl = heuristic("ANYRTL_LTR");
  expect(await vcall(firstLtr, "isRtl", "(Ljava/lang/CharSequence;II)Z", "  אב", 0, 4)).toBe(1);
  expect(await vcall(firstLtr, "isRtl", "(Ljava/lang/CharSequence;II)Z", "abc אב", 0, 6)).toBe(0);
  expect(await vcall(firstRtl, "isRtl", "(Ljava/lang/CharSequence;II)Z", "123", 0, 3)).toBe(1);
  expect(await vcall(anyRtl, "isRtl", "(Ljava/lang/CharSequence;II)Z", "abc אב", 0, 6)).toBe(1);
  expect(await vcall(anyRtl, "isRtl", "(Ljava/lang/CharSequence;II)Z", "abc אב", 0, 3)).toBe(0);
  await expect(vcall(firstLtr, "isRtl", "(Ljava/lang/CharSequence;II)Z", "abc", 2, 2)).rejects.toBeDefined();
});
