import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall, curThread, mainThread, setCurThread, JThread } from "../src/jvm/natives/jlang";
import { JView, JViewGroup, attachView, detachView, addUnattachedView, dispatchAttached, dispatchDetached } from "../src/android/view";
import { onMain } from "../src/android/mainloop";

rt.linkNatives();
test("detachment retains attachment and thread identity through child and listener callbacks", async () => {
  const parent = await newObj("android/widget/FrameLayout", "(Landroid/content/Context;)V", null);
  const child = await newObj("android/view/View", "(Landroid/content/Context;)V", null);
  if (!(parent instanceof JView) || !(child instanceof JView)) throw new Error("Invalid view delegates");
  await vcall(parent, "addView", "(Landroid/view/View;)V", child);
  await dispatchAttached(parent);
  const thread = new JThread();
  const events: string[] = [];
  for (const [name, view] of [["child", child], ["parent", parent]] as const) {
    Object.assign(view, {
      [mangleMethod("onDetachedFromWindow", "()V")]: async () => {
        expect(curThread).toBe(thread);
        expect(view.attached).toBe(true);
        expect(parent.attached).toBe(true);
        events.push(name);
        await Promise.resolve();
      },
    });
    await vcall(view, "addOnAttachStateChangeListener", "(Landroid/view/View$OnAttachStateChangeListener;)V", {
      [mangleMethod("onViewDetachedFromWindow", "(Landroid/view/View;)V")]: () => {
        expect(curThread).toBe(thread);
        expect(view.attached).toBe(true);
        events.push(`${name} listener`);
      },
    });
  }
  await dispatchDetached(parent, thread);
  expect(events).toEqual(["child", "child listener", "parent", "parent listener"]);
  expect(parent.attached).toBe(false);
  expect(child.attached).toBe(false);
  expect(curThread).toBe(mainThread);
});
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

for (const [method, desc, args] of [
  ["removeView", "(Landroid/view/View;)V", "child"],
  ["removeViewInLayout", "(Landroid/view/View;)V", "child"],
  ["removeViewAt", "(I)V", "index"],
  ["removeViews", "(II)V", "range"],
  ["removeViewsInLayout", "(II)V", "range"],
  ["removeAllViews", "()V", "all"],
  ["removeAllViewsInLayout", "()V", "all"],
] as const) test(`${method} completes detachment before the child is re-added`, async () => {
  const parent = rt.make("android/widget/FrameLayout"), child = rt.make("android/view/View");
  if (!(parent instanceof JView) || !(child instanceof JView)) throw new Error("Invalid view delegates");
  const events: string[] = [];
  Object.assign(child, {
    [mangleMethod("onDetachedFromWindow", "()V")]: async () => {
      expect(child.parent).toBe(parent);
      expect(child.attached).toBe(true);
      await Promise.resolve();
      events.push("detached");
    },
  });
  Object.assign(parent, {
    [mangleMethod("onViewRemoved", "(Landroid/view/View;)V")]: async () => {
      expect(child.parent).toBe(args === "range" || args === "all" ? parent : null);
      expect(child.attached).toBe(false);
      await Promise.resolve();
      events.push("removed");
    },
  });
  await vcall(parent, "setOnHierarchyChangeListener", "(Landroid/view/ViewGroup$OnHierarchyChangeListener;)V", {
    [mangleMethod("onChildViewAdded", "(Landroid/view/View;Landroid/view/View;)V")]: () => {},
    [mangleMethod("onChildViewRemoved", "(Landroid/view/View;Landroid/view/View;)V")]: async () => {
      await Promise.resolve();
      events.push("listener");
    },
  });
  await onMain(async () => {
    await dispatchAttached(parent);
    await vcall(parent, "addView", "(Landroid/view/View;)V", child);
    await vcall(parent, method, desc, ...(args === "child" ? [child] : args === "index" ? [0] : args === "range" ? [0, 1] : []));
    expect(events).toEqual(["detached", "removed", "listener"]);
    await vcall(parent, "addView", "(Landroid/view/View;)V", child);
  });
  await onMain(() => expect(child.attached).toBe(true));
});

test("removeDetachedView finishes window removal after temporary parent detachment", async () => {
  const parent = rt.make("android/widget/FrameLayout"), child = rt.make("android/view/View");
  if (!(parent instanceof JView) || !(child instanceof JView)) throw new Error("Invalid view delegates");
  await onMain(async () => {
    await dispatchAttached(parent);
    await vcall(parent, "addView", "(Landroid/view/View;)V", child);
    await vcall(parent, "detachViewFromParent", "(Landroid/view/View;)V", child);
    expect(child.attached).toBe(true);
    expect(child.parent).toBe(null);
    await vcall(parent, "removeDetachedView", "(Landroid/view/View;Z)V", child, 0);
    expect(child.attached).toBe(false);
    await vcall(parent, "addView", "(Landroid/view/View;)V", child);
  });
  await onMain(() => expect(child.attached).toBe(true));
});


test("native mutations finish the same lifecycle before Java reattachment", async () => {
  const parent = rt.make("android/widget/FrameLayout"), child = rt.make("android/view/View");
  const other = rt.make("android/widget/FrameLayout");
  if (!(parent instanceof JViewGroup) || !(other instanceof JViewGroup) || !(child instanceof JView)) throw new Error("Invalid view delegates");
  addUnattachedView(parent, child);
  const events: string[] = [];
  Object.assign(child, {
    [mangleMethod("onDetachedFromWindow", "()V")]: async () => { await Promise.resolve(); events.push("detach"); },
    [mangleMethod("onAttachedToWindow", "()V")]: async () => { await Promise.resolve(); events.push("attach"); },
  });
  await onMain(async () => {
    await dispatchAttached(parent); await dispatchAttached(other); events.length = 0;
    await detachView(parent, child);
    await vcall(parent, "addView", "(Landroid/view/View;)V", child);
    expect(events).toEqual(["detach", "attach"]);
    await attachView(other, child);
    expect(parent.children).toEqual([]);
    expect(other.children).toEqual([child]);
    expect(events).toEqual(["detach", "attach", "detach", "attach"]);
  });
  await onMain(() => { expect(child.attached).toBe(true); expect(child.parent).toBe(other); });
});
