import { expect, test } from "bun:test";
import "../natives";
import { vcall, newObj } from "../jvm/natives/jlang";
import { onMain } from "./mainloop";
import { JView, uiState } from "./view";
import { ST, type JDrawable } from "./drawable";
import { JCanvas } from "./graphics";

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
