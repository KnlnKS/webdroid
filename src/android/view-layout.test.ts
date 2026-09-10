import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";
import { dispatchAttached, JView, JViewGroup, requestLayout, uiState } from "./view";
import { mangleMethod } from "../jvm/abi";
import { onMain } from "./mainloop";

test("requestLayout propagates a locally forced view to its clean ancestors", async () => {
  const root = new JView(), parent = new JView();
  const child = await newObj("android/view/View", null) as JView;
  parent.parent = root; child.parent = parent;
  root.layoutRequested = parent.layoutRequested = child.layoutRequested = false;
  root.oldWSpec = parent.oldWSpec = child.oldWSpec = 100;
  await vcall(child, "forceLayout", "()V");
  expect(parent.layoutRequested).toBe(false);
  requestLayout(child);
  expect([child, parent, root].map(v => v.layoutRequested)).toEqual([true, true, true]);
  expect([child, parent, root].map(v => v.oldWSpec)).toEqual([-1, -1, -1]);
});

test("requestLayout stops propagation at an already requested parent", () => {
  const root = new JView(), parent = new JView(), child = new JView();
  parent.parent = root; child.parent = parent;
  root.layoutRequested = false;
  parent.layoutRequested = true;
  requestLayout(child);
  expect(child.layoutRequested).toBe(true);
  expect(root.layoutRequested).toBe(false);
});


test("queued subtree attachment invalidates its hosted drawing after callbacks complete", async () => {
  const host = new JViewGroup(), root = new JViewGroup(), child = new JView();
  root.parent = host; child.parent = root; root.children.push(child);
  const events: string[] = [];
  Object.assign(child, { [mangleMethod("onAttachedToWindow", "()V")]: async () => {
    events.push("attach");
    await Promise.resolve();
    events.push("content");
  } });
  Object.assign(host, { [mangleMethod("onDescendantInvalidated", "(Landroid/view/View;Landroid/view/View;)V")]: (v: JView, target: JView) => {
    expect(v).toBe(root); expect(target).toBe(root);
    expect(child.attached).toBe(true);
    events.push("invalidate");
  } });
  uiState.needsDraw = false;
  await onMain(() => dispatchAttached(root));
  expect(events).toEqual(["attach", "content", "invalidate"]);
  expect(uiState.needsDraw).toBe(true);
  await onMain(() => dispatchAttached(root));
  expect(events).toEqual(["attach", "content", "invalidate"]);
});
