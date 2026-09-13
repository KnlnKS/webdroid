import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod, mangleStaticField } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JView } from "../src/android/view";
import { JOutline } from "../src/android/graphics";

rt.linkNatives();
test("view outline providers use background geometry, bounds and padded bounds", async () => {
  const view = rt.make("android/view/View"), outline = new JOutline();
  if (!(view instanceof JView)) throw new Error("Invalid view delegate");
  view.right = 40; view.bottom = 30;
  view.padL = 2; view.padT = 3; view.padR = 4; view.padB = 5;
  const cls = rt.link("android/view/ViewOutlineProvider").ctor;
  const provider = await vcall(view, "getOutlineProvider", "()Landroid/view/ViewOutlineProvider;");
  expect(provider).toBe(cls[mangleStaticField("BACKGROUND")]);
  const fill = (p: unknown) => vcall(p, "getOutline", "(Landroid/view/View;Landroid/graphics/Outline;)V", view, outline);
  await fill(provider);
  expect([outline.l, outline.t, outline.r, outline.b, outline.alpha]).toEqual([0, 0, 40, 30, 0]);
  const background = rt.make("android/graphics/drawable/Drawable");
  Object.assign(background, {
    [mangleMethod("getOutline", "(Landroid/graphics/Outline;)V")]: async (o: JOutline) => {
      await Promise.resolve();
      o.setRR(1, 2, 39, 28, 7);
    },
  });
  await vcall(view, "setBackground", "(Landroid/graphics/drawable/Drawable;)V", background);
  await fill(provider);
  expect([outline.l, outline.t, outline.r, outline.b, outline.rad]).toEqual([1, 2, 39, 28, 7]);
  const inset = await newObj("android/graphics/drawable/InsetDrawable", "(Landroid/graphics/drawable/Drawable;I)V", background, 3);
  await vcall(view, "setBackground", "(Landroid/graphics/drawable/Drawable;)V", inset);
  await fill(provider);
  expect([outline.l, outline.t, outline.r, outline.b, outline.rad]).toEqual([1, 2, 39, 28, 7]);
  await fill(cls[mangleStaticField("BOUNDS")]);
  expect([outline.l, outline.t, outline.r, outline.b]).toEqual([0, 0, 40, 30]);
  await fill(cls[mangleStaticField("PADDED_BOUNDS")]);
  expect([outline.l, outline.t, outline.r, outline.b]).toEqual([2, 3, 36, 25]);
  await vcall(view, "setOutlineProvider", "(Landroid/view/ViewOutlineProvider;)V", null);
  expect(await vcall(view, "getOutlineProvider", "()Landroid/view/ViewOutlineProvider;")).toBeNull();
  await vcall(view, "setClipToOutline", "(Z)V", 1);
  expect(await vcall(view, "getClipToOutline", "()Z")).toBe(1);
});
