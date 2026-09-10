import { expect, test } from "bun:test";
import "../natives";
import { vcall, newObj } from "../jvm/natives/jlang";
import { onMain } from "./mainloop";
import { JView, uiState } from "./view";
import { ST, type JDrawable } from "./drawable";
import { JCanvas } from "./graphics";
import { rt } from "../jvm/runtime";

test("vector constant state creates independent drawable instances with the same appearance", async () => {
  const vector = await newObj("android/graphics/drawable/VectorDrawable", null) as JDrawable;
  await vcall(vector, "setTint", "(I)V", 0xff445566);
  await vcall(vector, "setAlpha", "(I)V", 192);
  vector.callback = {};
  vector.bounds.right = 150;
  const state = await vcall(vector, "getConstantState", "()Landroid/graphics/drawable/Drawable$ConstantState;");
  const first = await vcall(state, "newDrawable", "()Landroid/graphics/drawable/Drawable;") as JDrawable;
  const second = await vcall(state, "newDrawable", "(Landroid/content/res/Resources;Landroid/content/res/Resources$Theme;)Landroid/graphics/drawable/Drawable;", null, null) as JDrawable;
  expect(rt.iof(first, "android/graphics/drawable/VectorDrawable")).toBe(1);
  expect(first).not.toBe(vector);
  expect(first.tint).toBe(vector.tint);
  expect(first.alpha).toBe(192);
  expect(first.intrinsicW()).toBe(vector.intrinsicW());
  expect(first.callback).toBeNull();
  expect(first.bounds.right).toBe(0);
  await vcall(first, "mutate", "()Landroid/graphics/drawable/Drawable;");
  await vcall(first, "setTint", "(I)V", 0xff112233);
  await vcall(first, "setBounds", "(IIII)V", 0, 0, 80, 90);
  expect(second.tint).toBe(vector.tint);
  expect(second.bounds.right).toBe(0);
});

test("a view owns its background's callback; an animating ripple invalidates from the next frame", async () => {
  const view = await newObj("android/view/View", null) as JView;
  const ripple = await newObj("android/graphics/drawable/RippleDrawable",
    "(Landroid/content/res/ColorStateList;Landroid/graphics/drawable/Drawable;Landroid/graphics/drawable/Drawable;)V", null, null, null) as JDrawable & { ripple(cv: JCanvas): void };
  await vcall(ripple, "setBounds", "(IIII)V", 0, 0, 100, 100);
  await vcall(view, "setBackground", "(Landroid/graphics/drawable/Drawable;)V", ripple);
  expect(ripple.callback).toBe(view);
  await vcall(ripple, "setState", "([I)Z", Int32Array.from([ST.pressed, ST.enabled]));
  await onMain(() => {});
  uiState.needsDraw = false;
  const ctx = new Proxy({ globalAlpha: 1 } as Record<PropertyKey, unknown>, { get: (t, p) => p in t ? t[p] : () => {} });
  ripple.ripple(JCanvas.wrap(ctx as unknown as OffscreenCanvasRenderingContext2D, 100, 100));
  expect(uiState.needsDraw).toBe(false);
  await onMain(() => {});
  expect(uiState.needsDraw).toBe(true);
  await vcall(view, "setBackground", "(Landroid/graphics/drawable/Drawable;)V", null);
  expect(ripple.callback).toBeNull();
});
