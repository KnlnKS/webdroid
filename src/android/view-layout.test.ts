import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";
import { JView, requestLayout } from "./view";

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
