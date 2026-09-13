import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall, vcallOn, curThread, JThread } from "../src/jvm/natives/jlang";
import { JView, JViewGroup, measureView, makeSpec, MS_AT_MOST } from "../src/android/view";

rt.linkNatives();
function drawable() {
  const d = rt.make("android/graphics/drawable/Drawable"), threads: JThread[] = [];
  Object.assign(d, {
    [mangleMethod("getIntrinsicWidth", "()I")]: async () => { threads.push(curThread); await Promise.resolve(); return 84; },
    [mangleMethod("getIntrinsicHeight", "()I")]: () => { threads.push(curThread); return 48; },
  });
  return { d, threads };
}
test("layer and minimum sizes dispatch drawable overrides, including explicit layer sizes", async () => {
  const { d } = drawable();
  const layer = await newObj("android/graphics/drawable/LayerDrawable", "([Landroid/graphics/drawable/Drawable;)V", [d]);
  await vcall(layer, "setLayerInset", "(IIIII)V", 0, 2, 3, 4, 5);
  expect(await vcall(layer, "getIntrinsicWidth", "()I")).toBe(90);
  expect(await vcall(layer, "getMinimumWidth", "()I")).toBe(90);
  expect(await vcall(layer, "getIntrinsicHeight", "()I")).toBe(56);
  await vcall(layer, "setLayerSize", "(III)V", 0, 100, 60);
  expect(await vcall(layer, "getIntrinsicWidth", "()I")).toBe(106);
  expect(await vcall(layer, "getMinimumHeight", "()I")).toBe(68);
});
test("ImageView measures virtual drawable dimensions and caches them for drawing", async () => {
  const { d, threads } = drawable(), view = rt.make("android/widget/ImageView");
  if (!(view instanceof JView)) throw new Error("Invalid view delegate");
  await vcall(view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", d);
  await measureView(view, makeSpec(200, MS_AT_MOST), makeSpec(200, MS_AT_MOST));
  expect([view.measuredW, view.measuredH]).toEqual([84, 48]);
  expect(threads[0]).toBe(threads[1]);
});

test("ImageView content and appearance updates invalidate ancestor recordings", async () => {
  const holder = rt.make("android/view/ViewGroup"), parent = rt.make("android/widget/FrameLayout");
  const view = rt.make("android/widget/ImageView"), targets: JView[] = [];
  if (!(holder instanceof JViewGroup) || !(parent instanceof JViewGroup) || !(view instanceof JView)) throw new Error("Invalid view delegates");
  parent.parent = holder; view.parent = parent;
  Object.assign(holder, {
    [mangleMethod("onDescendantInvalidated", "(Landroid/view/View;Landroid/view/View;)V")]: (_child: JView, target: JView) => { targets.push(target); },
  });
  const d = rt.make("android/graphics/drawable/ColorDrawable");
  for (const [name, desc, args] of [
    ["setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", [d]],
    ["setColorFilter", "(I)V", [0xff00ff00]],
    ["clearColorFilter", "()V", []],
    ["setImageBitmap", "(Landroid/graphics/Bitmap;)V", [null]],
    ["setImageResource", "(I)V", [0]],
  ] satisfies [string, string, unknown[]][]) {
    targets.length = 0;
    await vcall(view, name, desc, ...args);
    expect(targets).toEqual([view]);
  }
});
test("suggested view minimums respect virtual background dimensions", async () => {
  const { d } = drawable(), view = rt.make("android/widget/TextView");
  if (!(view instanceof JView)) throw new Error("Invalid view delegate");
  await vcall(view, "setBackground", "(Landroid/graphics/drawable/Drawable;)V", d);
  expect(await vcall(view, "getSuggestedMinimumWidth", "()I")).toBe(84);
  expect(await vcall(view, "getSuggestedMinimumHeight", "()I")).toBe(48);
});

test("layer bounds and drawing await each child on the dispatch thread", async () => {
  const events: string[] = [], thread = new JThread();
  const children = [0, 1].map(i => {
    const d = rt.make("android/graphics/drawable/Drawable");
    Object.assign(d, {
      [mangleMethod("onBoundsChange", "(Landroid/graphics/Rect;)V")]: async () => {
        expect(curThread).toBe(thread);
        await Promise.resolve();
        events.push(`bounds ${i}`);
      },
      [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]: async () => {
        expect(curThread).toBe(thread);
        await Promise.resolve();
        events.push(`draw ${i}`);
      },
    });
    return d;
  });
  const layer = await newObj("android/graphics/drawable/LayerDrawable", "([Landroid/graphics/drawable/Drawable;)V", children);
  await vcallOn(thread, layer, "setBounds", "(IIII)V", 0, 0, 100, 100);
  expect(events).toEqual(["bounds 0", "bounds 1"]);
  await vcallOn(thread, layer, "draw", "(Landroid/graphics/Canvas;)V", null);
  expect(events).toEqual(["bounds 0", "bounds 1", "draw 0", "draw 1"]);
});
