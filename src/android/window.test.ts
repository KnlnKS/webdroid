import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { JLayoutParams, JView } from "./view";
import { overlays } from "./popup";
import { onMain } from "./mainloop";

test("WindowManager attaches, moves and detaches a window view", async () => {
  const events: string[] = [];
  rt.register({ name: "test/WindowView", sup: "android/view/View", ctor: class extends JView {}, methods: {
    "onAttachedToWindow()V": () => { events.push("attached"); },
    "onDetachedFromWindow()V": () => { events.push("detached"); },
  } });
  const view = new (rt.link("test/WindowView").ctor)();
  const manager = new (rt.link("android/view/WindowManagerImpl").ctor)();
  const params = await newObj("android/view/WindowManager$LayoutParams", "()V");
  expect(params).toBeInstanceOf(JLayoutParams);
  params.x = 20; params.y = 30;
  await vcall(params, "setTitle", "(Ljava/lang/CharSequence;)V", "Popup");
  expect(await vcall(params, "getTitle", "()Ljava/lang/CharSequence;")).toBe("Popup");
  await onMain(async () => {
    await vcall(manager, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", view, params);
    try {
      expect(events).toEqual(["attached"]);
      expect(view.attached).toBe(true);
      expect(overlays.find((o) => o.view === view)).toMatchObject({ x: 20, y: 30 });
      params.x = 50; params.y = 60;
      await vcall(manager, "updateViewLayout", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", view, params);
      expect(overlays.find((o) => o.view === view)).toMatchObject({ x: 50, y: 60 });
    } finally {
      await vcall(manager, "removeViewImmediate", "(Landroid/view/View;)V", view);
    }
  });
  expect(events).toEqual(["attached", "detached"]);
  expect(view.attached).toBe(false);
  expect(overlays.some((o) => o.view === view)).toBe(false);
});
