import { expect, test } from "bun:test";
import "../src/natives";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";
import { JObj, rt } from "../src/jvm/runtime";
import { JView, JViewGroup } from "../src/android/view";

rt.linkNatives();

class FocusListener extends JObj {
  events: [JView, number][] = [];
  async [mangleMethod("onFocusChange", "(Landroid/view/View;Z)V")](view: JView, focused: number) {
    await Promise.resolve();
    this.events.push([view, focused]);
  }
}

class FocusRedirect extends JView {
  constructor(readonly child: JView) { super(); }
  [mangleMethod("requestFocus", "(ILandroid/graphics/Rect;)Z")](direction: number, rect: unknown) {
    expect(direction).toBe(130);
    expect(rect).toBeNull();
    return vcall(this.child, "requestFocus", "()Z");
  }
}

test("focus transfer notifies the old and new views in order", async () => {
  const root = new JViewGroup();
  const first = new JView(), second = new JView();
  first.parent = root; second.parent = root;
  first.focusable = second.focusable = true;
  root.children.push(first, second);
  const listener = new FocusListener();
  first.focusL = second.focusL = listener;

  expect(await vcall(first, "requestFocus", "()Z")).toBe(1);
  expect(await vcall(first, "requestFocus", "()Z")).toBe(1);
  expect(await vcall(second, "requestFocus", "()Z")).toBe(1);
  await vcall(second, "clearFocus", "()V");

  expect(listener.events).toEqual([[first, 1], [first, 0], [second, 1], [second, 0]]);
  expect(first.focused).toBe(false);
  expect(second.focused).toBe(false);
});

test("a non-focusable view rejects focus without notifying", async () => {
  const view = new JView(), listener = new FocusListener();
  view.focusL = listener;
  expect(await vcall(view, "requestFocus", "()Z")).toBe(0);
  expect(listener.events).toEqual([]);
});

test("no-argument requestFocus honors a view's directional override", async () => {
  const child = new JView(); child.focusable = true;
  const redirect = new FocusRedirect(child);
  child.parent = redirect;
  const listener = new FocusListener(); child.focusL = listener;

  expect(await vcall(redirect, "requestFocus", "()Z")).toBe(1);
  expect(listener.events).toEqual([[child, 1]]);
  expect(redirect.focused).toBe(false);
});
