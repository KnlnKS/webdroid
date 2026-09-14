import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { curThread, JThread, vcall, vcallOn } from "../src/jvm/natives/jlang";
import { JView } from "../src/android/view";
import { JDrawable } from "../src/android/drawable";

rt.linkNatives();
test("foreground drawing awaits bounds, retains its thread and resolves gravity", async () => {
  const view = rt.make("android/view/View"), drawable = rt.make("android/graphics/drawable/Drawable");
  if (!(view instanceof JView) || !(drawable instanceof JDrawable)) throw new Error("Invalid delegates");
  view.right = 80; view.bottom = 60;
  const seen: JThread[] = [], events: string[] = [];
  Object.assign(drawable, {
    [mangleMethod("getIntrinsicWidth", "()I")]: async () => { seen.push(curThread); await Promise.resolve(); return 20; },
    [mangleMethod("getIntrinsicHeight", "()I")]: () => { seen.push(curThread); return 10; },
    [mangleMethod("onBoundsChange", "(Landroid/graphics/Rect;)V")]: async () => { seen.push(curThread); await Promise.resolve(); events.push("bounds"); },
    [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]: () => { seen.push(curThread); events.push("draw"); },
  });
  await vcall(view, "setForeground", "(Landroid/graphics/drawable/Drawable;)V", drawable);
  expect(drawable.callback).toBe(view);
  const thread = new JThread();
  await vcallOn(thread, view, "onDrawForeground", "(Landroid/graphics/Canvas;)V", null);
  expect(drawable.bounds).toMatchObject({ left: 0, top: 0, right: 80, bottom: 60 });
  expect(events).toEqual(["bounds", "draw"]);
  await vcall(view, "setForegroundGravity", "(I)V", 17);
  await vcallOn(thread, view, "onDrawForeground", "(Landroid/graphics/Canvas;)V", null);
  expect(drawable.bounds).toMatchObject({ left: 30, top: 25, right: 50, bottom: 35 });
  events.length = 0;
  await vcallOn(thread, view, "onDrawForeground", "(Landroid/graphics/Canvas;)V", null);
  expect(events).toEqual(["draw"]);
  expect(seen.every(t => t === thread)).toBe(true);
  await vcall(view, "setForeground", "(Landroid/graphics/drawable/Drawable;)V", null);
  expect(drawable.callback).toBeNull();
});
