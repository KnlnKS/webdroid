import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JDrawable } from "../src/android/drawable";
rt.linkNatives();

test("ScaleDrawable resizes its child by level and gravity and awaits virtual drawing", async () => {
  const child = rt.make("android/graphics/drawable/Drawable");
  if (!(child instanceof JDrawable)) throw new Error("Invalid drawable");
  const events: string[] = [];
  Object.assign(child, {
    [mangleMethod("onBoundsChange", "(Landroid/graphics/Rect;)V")]: async () => { await Promise.resolve(); events.push("bounds"); },
    [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]: async () => { await Promise.resolve(); events.push("draw"); },
  });
  const scaled = await newObj("android/graphics/drawable/ScaleDrawable", "(Landroid/graphics/drawable/Drawable;IFF)V", child, 85, 1, 0.5);
  await vcall(scaled, "setBounds", "(IIII)V", 10, 20, 110, 100);
  await vcall(scaled, "draw", "(Landroid/graphics/Canvas;)V", null);
  expect(events).not.toContain("draw");
  await vcall(scaled, "setLevel", "(I)Z", 5000);
  expect(child.bounds).toMatchObject({ left: 60, top: 40, right: 110, bottom: 100 });
  expect(child.level).toBe(5000);
  expect(events.at(-1)).toBe("bounds");
  await vcall(scaled, "draw", "(Landroid/graphics/Canvas;)V", null);
  expect(events.at(-1)).toBe("draw");
  await vcall(scaled, "setLevel", "(I)Z", 10000);
  expect(child.bounds).toMatchObject({ left: 10, top: 20, right: 110, bottom: 100 });
});
