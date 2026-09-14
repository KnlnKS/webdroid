import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JPaint, matrixColor } from "../src/android/graphics";

test("lighting filters retain alpha and update an attached paint's RGB transform", async () => {
  rt.linkNatives();
  const filter = await newObj("android/graphics/LightingColorFilter", "(II)V", 0x0080ff00, 0xff104020);
  const paint = rt.make("android/graphics/Paint");
  if (!(paint instanceof JPaint)) throw new Error("Invalid Paint");
  await vcall(paint, "setColorFilter", "(Landroid/graphics/ColorFilter;)Landroid/graphics/ColorFilter;", filter);
  expect(await vcall(filter, "getColorMultiply", "()I")).toBe(0x0080ff00);
  expect(await vcall(filter, "getColorAdd", "()I")).toBe(0xff104020);
  expect(matrixColor(paint.filterMatrix!, 0x8080ff80) >>> 0).toBe(0x8050ff20);
  await vcall(filter, "setColorMultiply", "(I)V", 0xffffffff);
  await vcall(filter, "setColorAdd", "(I)V", 0);
  expect(matrixColor(paint.filterMatrix!, 0x8080ff80) >>> 0).toBe(0x8080ff80);
});
