import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleStaticField } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
const fit = (name: string) => (rt.link("android/graphics/Matrix$ScaleToFit").ctor as any)[mangleStaticField(name)];
const rect = (l: number, t: number, r: number, b: number) => newObj("android/graphics/RectF", "(FFFF)V", l, t, r, b);

test("Matrix.setRectToRect maps the source onto the destination per ScaleToFit", async () => {
  const m = await newObj("android/graphics/Matrix", "()V");
  const src = await rect(0, 0, 100, 50), dst = await rect(10, 10, 210, 210);
  expect(await vcall(m, "setRectToRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;Landroid/graphics/Matrix$ScaleToFit;)Z", src, dst, fit("FILL"))).toBe(1);
  expect(m.m).toEqual([2, 0, 0, 4, 10, 10]);
  await vcall(m, "setRectToRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;Landroid/graphics/Matrix$ScaleToFit;)Z", src, dst, fit("CENTER"));
  expect(m.m).toEqual([2, 0, 0, 2, 10, 60]);
  await vcall(m, "setRectToRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;Landroid/graphics/Matrix$ScaleToFit;)Z", src, dst, fit("END"));
  expect(m.m).toEqual([2, 0, 0, 2, 10, 110]);
  expect(await vcall(m, "setRectToRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;Landroid/graphics/Matrix$ScaleToFit;)Z", await rect(0, 0, 0, 5), dst, fit("START"))).toBe(0);
  expect(m.m).toEqual([1, 0, 0, 1, 0, 0]);
});

test("Paint.setARGB packs the channels", async () => {
  const p = await newObj("android/graphics/Paint", "()V");
  await vcall(p, "setARGB", "(IIII)V", 0x80, 0x11, 0x22, 0x33);
  expect(await vcall(p, "getColor", "()I")).toBe(0x80112233 | 0);
});
