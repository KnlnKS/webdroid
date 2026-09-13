import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall, curThread, mainThread, setCurThread, JThread } from "../src/jvm/natives/jlang";
import { JView, dispatchAttached } from "../src/android/view";
import { onMain } from "../src/android/mainloop";

rt.linkNatives();
test("attachment callbacks retain their dispatch thread across suspension", async () => {
  const view = rt.make("android/view/View");
  if (!(view instanceof JView)) throw new Error("Invalid view delegate");
  const thread = new JThread();
  const observed: JThread[] = [];
  Object.assign(view, {
    [mangleMethod("onAttachedToWindow", "()V")]: async () => {
      observed.push(curThread);
      await Promise.resolve();
    },
  });
  await vcall(view, "addOnAttachStateChangeListener", "(Landroid/view/View$OnAttachStateChangeListener;)V", {
    [mangleMethod("onViewAttachedToWindow", "(Landroid/view/View;)V")]: () => { observed.push(curThread); },
  });
  setCurThread(thread);
  const attached = dispatchAttached(view);
  setCurThread(mainThread);
  try {
    await attached;
    expect(observed).toEqual([thread, thread]);
    expect(curThread).toBe(mainThread);
  } finally { setCurThread(mainThread); }
});
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
