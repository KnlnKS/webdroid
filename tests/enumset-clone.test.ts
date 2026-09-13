import { expect, test } from "bun:test";
import "../src/natives";
import { mangleMethod } from "../src/jvm/abi";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("EnumSet covariant clone has independent membership", async () => {
  const paint = await newObj("android/graphics/Paint");
  const style = await vcall(paint, "getStyle", "()Landroid/graphics/Paint$Style;");
  const ctor = rt.link("java/util/EnumSet").ctor as any;
  const source = await ctor[mangleMethod("of", "(Ljava/lang/Enum;)Ljava/util/EnumSet;")](style);
  const copy = await vcall(source, "clone", "()Ljava/util/EnumSet;");
  await vcall(copy, "clear", "()V");
  expect(await vcall(source, "contains", "(Ljava/lang/Object;)Z", style)).toBe(1);
  expect(await vcall(copy, "isEmpty", "()Z")).toBe(1);
});

test("EnumSet fixed-arity factories retain every member", async () => {
  const style = await vcall(await newObj("android/graphics/Paint"), "getStyle", "()Landroid/graphics/Paint$Style;");
  const ctor = rt.link("java/util/EnumSet").ctor as any;
  const set = await ctor[mangleMethod("of", "(Ljava/lang/Enum;Ljava/lang/Enum;Ljava/lang/Enum;Ljava/lang/Enum;)Ljava/util/EnumSet;")](style, style, style, style);
  expect(await vcall(set, "size", "()I")).toBe(1);
  expect(await vcall(set, "contains", "(Ljava/lang/Object;)Z", style)).toBe(1);
});
