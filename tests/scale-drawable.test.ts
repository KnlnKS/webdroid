import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("ScaleDrawable applies its level to child bounds", async () => {
  const child = await newObj("android/graphics/drawable/ColorDrawable", "(I)V", 0xff112233);
  const scale = await newObj(
    "android/graphics/drawable/ScaleDrawable",
    "(Landroid/graphics/drawable/Drawable;IFF)V",
    child,
    3 | 48,
    1,
    1,
  );
  await vcall(scale, "setBounds", "(IIII)V", 0, 0, 100, 80);
  await vcall(scale, "setLevel", "(I)Z", 5000);
  const bounds = await vcall(child, "getBounds", "()Landroid/graphics/Rect;") as {
    left: number; top: number; right: number; bottom: number;
  };
  expect([bounds.left, bounds.top, bounds.right, bounds.bottom]).toEqual([0, 0, 50, 40]);
});
