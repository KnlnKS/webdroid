import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";
import { dispatchAttached, JView, JViewGroup, layoutView, measureView, requestLayout, uiState } from "./view";
import { mangleMethod, mangleStaticField } from "../jvm/abi";
import { onMain } from "./mainloop";
import { rt } from "../jvm/runtime";

test("inherited View state arrays construct selected and default tab colors", async () => {
  const ctor = rt.link("android/widget/HorizontalScrollView").ctor;
  const selected = ctor[mangleStaticField("SELECTED_STATE_SET")];
  const empty = ctor[mangleStaticField("EMPTY_STATE_SET")];
  expect(selected).toEqual(Int32Array.of(0x10100a1));
  expect(empty).toEqual(new Int32Array(0));
  const colors = await newObj("android/content/res/ColorStateList", "([[I[I)V",
    [selected, empty], Int32Array.of(0xff0000ff, 0xff000000));
  expect(await vcall(colors, "getColorForState", "([II)I", selected, 0)).toBe(-16776961);
  expect(await vcall(colors, "getColorForState", "([II)I", empty, 0)).toBe(-16777216);
});

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

test("attachment remeasures descendants previously measured without a window token", async () => {
  const root = new JViewGroup(), child = new JView();
  root.children.push(child); child.parent = root;
  const measurements: boolean[] = [];
  Object.assign(root, {
    [mangleMethod("onMeasure", "(II)V")]: async (w: number, h: number) => measureView(child, w, h),
    [mangleMethod("onLayout", "(ZIIII)V")]: async () => layoutView(child, 0, 0, 100, 100),
  });
  Object.assign(child, {
    [mangleMethod("onMeasure", "(II)V")]: () => { measurements.push(child.attached); },
    [mangleMethod("onLayout", "(ZIIII)V")]: () => {},
  });
  await onMain(async () => {
    await measureView(root, 100, 100);
    await layoutView(root, 0, 0, 100, 100);
    await dispatchAttached(root);
    await measureView(root, 100, 100);
    await layoutView(root, 0, 0, 100, 100);
    await measureView(root, 100, 100);
  });
  expect(measurements).toEqual([false, true]);
});
