import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JView, dispatchAttached } from "../src/android/view";
import { onMain } from "../src/android/mainloop";

rt.linkNatives();
for (const inLayout of [false, true]) test(`${inLayout ? "addViewInLayout" : "addView"} awaits attachment before returning`, async () => {
  const parent = rt.make("android/widget/FrameLayout");
  const child = rt.make("android/view/View");
  if (!(parent instanceof JView) || !(child instanceof JView)) throw new Error("Invalid view delegates");
  const events: string[] = [];
  Object.assign(child, {
    [mangleMethod("onAttachedToWindow", "()V")]: async () => {
      await Promise.resolve();
      expect(child.parent).toBe(parent);
      events.push("attached");
    },
  });
  Object.assign(parent, {
    [mangleMethod("onViewAdded", "(Landroid/view/View;)V")]: async () => {
      await Promise.resolve();
      events.push("added");
    },
  });
  await vcall(parent, "setOnHierarchyChangeListener", "(Landroid/view/ViewGroup$OnHierarchyChangeListener;)V", {
    [mangleMethod("onChildViewAdded", "(Landroid/view/View;Landroid/view/View;)V")]: async () => {
      await Promise.resolve();
      events.push("listener");
    },
  });
  await onMain(async () => {
    await dispatchAttached(parent);
    const lp = await newObj("android/widget/FrameLayout$LayoutParams", "(II)V", 100, 100);
    if (inLayout) await vcall(parent, "addViewInLayout", "(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)Z", child, -1, lp);
    else await vcall(parent, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", child, lp);
    expect(child.attached).toBe(true);
    expect(events).toEqual(["attached", "added", "listener"]);
  });
  await onMain(() => expect(events).toEqual(["attached", "added", "listener"]));
});
