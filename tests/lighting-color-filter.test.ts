import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JPaint } from "../src/android/graphics";

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
