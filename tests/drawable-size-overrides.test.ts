import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall, vcallOn, vcallMaybe, curThread, JThread } from "../src/jvm/natives/jlang";
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
test("ImageView retains filters across replacement and invokes drawable overrides after mutation", async () => {
  const view = rt.make("android/widget/ImageView"), thread = new JThread();
  const events: [string, unknown, JThread][] = [];
  const make = () => {
    const d = rt.make("android/graphics/drawable/Drawable");
    Object.assign(d, {
      [mangleMethod("mutate", "()Landroid/graphics/drawable/Drawable;")]: async () => {
        events.push(["mutate", d, curThread]); await Promise.resolve(); return d;
      },
      [mangleMethod("setColorFilter", "(Landroid/graphics/ColorFilter;)V")]: (f: unknown) => { events.push(["filter", f, curThread]); },
    });
    return d;
  };
  await vcallOn(thread, view, "setColorFilter", "(I)V", -65536);
  const filter = await vcall(view, "getColorFilter", "()Landroid/graphics/ColorFilter;");
  expect(filter.tint).toBe(-65536);
  expect(events).toEqual([]);
  for (const d of [make(), make()]) {
    await vcallOn(thread, view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", d);
    expect(events.splice(0)).toEqual([["mutate", d, thread], ["filter", filter, thread]]);
  }
  const d = await vcall(view, "getDrawable", "()Landroid/graphics/drawable/Drawable;");
  await vcallOn(thread, view, "clearColorFilter", "()V");
  expect(events.splice(0)).toEqual([["mutate", d, thread], ["filter", null, thread]]);
  expect(await vcall(view, "getColorFilter", "()Landroid/graphics/ColorFilter;")).toBeNull();
  const next = make();
  await vcallOn(thread, view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", next);
  expect(events).toEqual([["mutate", next, thread], ["filter", null, thread]]);
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

test("layer gravity uses virtual intrinsic size on non-fill axes", async () => {
  const { d, threads } = drawable(), thread = new JThread();
  const layer = await newObj("android/graphics/drawable/LayerDrawable", "([Landroid/graphics/drawable/Drawable;)V", [d]);
  await vcall(layer, "setLayerGravity", "(II)V", 0, 0x17);
  await vcallOn(thread, layer, "setBounds", "(IIII)V", 0, 0, 100, 60);
  const bounds = await vcall(d, "getBounds", "()Landroid/graphics/Rect;");
  expect([bounds.left, bounds.top, bounds.right, bounds.bottom]).toEqual([0, 6, 100, 54]);
  expect(threads).toEqual([thread]);
});


test("nested drawable containers share virtual size and draw dispatch", async () => {
  const { d } = drawable();
  const layer = await newObj("android/graphics/drawable/LayerDrawable", "([Landroid/graphics/drawable/Drawable;)V", [d]);
  for (const name of ["RotateDrawable", "ScaleDrawable", "DrawableWrapper"]) {
    const wrapper = await newObj("android/graphics/drawable/" + name, null);
    await vcall(wrapper, "setDrawable", "(Landroid/graphics/drawable/Drawable;)V", layer);
    expect(await vcall(wrapper, "getIntrinsicWidth", "()I")).toBe(84);
    expect(await vcall(wrapper, "getIntrinsicHeight", "()I")).toBe(48);
  }
  let draws = 0;
  Object.assign(d, { [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]: () => { draws++; } });
  expect(vcallMaybe(layer, "draw", "(Landroid/graphics/Canvas;)V", null)).toBeUndefined();
  expect(draws).toBe(1);
  await vcall(layer, "setLayerSize", "(III)V", 0, 100, 60);
  expect(vcallMaybe(layer, "getIntrinsicWidth", "()I")).toBe(100);
});


test("InsetDrawable replaces its child through the wrapper and retains pixel or fractional insets", async () => {
  for (const [type, inset, expected] of [["I", 3, 90], ["F", 0.25, 168]] as const) {
    const first = drawable().d, next = drawable().d;
    const wrapped = await newObj("android/graphics/drawable/InsetDrawable", `(Landroid/graphics/drawable/Drawable;${type})V`, first, inset);
    expect(rt.iof(wrapped, "android/graphics/drawable/DrawableWrapper")).toBe(1);
    await vcall(wrapped, "setDrawable", "(Landroid/graphics/drawable/Drawable;)V", next);
    expect(first.callback).toBeNull(); expect(next.callback).toBe(wrapped);
    expect(await vcall(wrapped, "getDrawable", "()Landroid/graphics/drawable/Drawable;")).toBe(next);
    expect(await vcall(wrapped, "getIntrinsicWidth", "()I")).toBe(expected);
    await vcall(wrapped, "setBounds", "(IIII)V", 0, 0, 100, 80);
    const b = next.bounds, x = type === "I" ? 3 : 25, y = type === "I" ? 3 : 20;
    expect([b.left, b.top, b.right, b.bottom]).toEqual([x, y, 100 - x, 80 - y]);
    const padding = await newObj("android/graphics/Rect");
    expect(await vcall(wrapped, "getPadding", "(Landroid/graphics/Rect;)Z", padding)).toBe(1);
    expect([padding.left, padding.top, padding.right, padding.bottom]).toEqual([x, y, x, y]);
  }
});
