import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JPaint, matrixColor } from "../src/android/graphics";

rt.linkNatives();

test("LightingColorFilter exposes its RGB multiply and add transform", async () => {
  const filter = await newObj("android/graphics/LightingColorFilter", "(II)V", 0xff804020, 0x00102030);
  const paint = await newObj("android/graphics/Paint") as JPaint;
  await vcall(paint, "setColorFilter", "(Landroid/graphics/ColorFilter;)Landroid/graphics/ColorFilter;", filter);
  expect(paint.filterMatrix?.[0]).toBeCloseTo(128 / 255);
  expect(paint.filterMatrix?.[6]).toBeCloseTo(64 / 255);
  expect(paint.filterMatrix?.[12]).toBeCloseTo(32 / 255);
  expect(paint.filterMatrix?.[4]).toBe(16);
  expect(paint.filterMatrix?.[9]).toBe(32);
  expect(paint.filterMatrix?.[14]).toBe(48);
});

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
