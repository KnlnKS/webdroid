import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JView, makeSpec, measureView, MS_AT_MOST, MS_EXACTLY, resolveSizeAndState } from "../src/android/view";

rt.linkNatives();
const onMeasure = mangleMethod("onMeasure", "(II)V");
async function add(parent: JView, child: JView, owner: string, width = -1, height = -1) {
  const lp = await newObj(`android/widget/${owner}$LayoutParams`, "(II)V", width, height);
  await vcall(parent, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", child, lp);
}
test("nested frames and linear layouts avoid unnecessary match-parent measure passes", async () => {
  const root = rt.make("android/widget/FrameLayout") as JView;
  let parent = root;
  for (let i = 0; i < 8; i++) {
    const owner = i % 2 ? "LinearLayout" : "FrameLayout";
    const child = rt.make(`android/widget/${owner}`) as JView;
    await add(parent, child, i % 2 ? "FrameLayout" : "LinearLayout");
    parent = child;
  }
  const leaf = rt.make("android/view/View") as JView;
  await add(parent, leaf, "LinearLayout");
  let calls = 0;
  const base = rt.link("android/view/View").ctor.prototype[onMeasure];
  Object.assign(leaf, { [onMeasure](w: number, h: number) { calls++; return base.call(this, w, h); } });
  await measureView(root, makeSpec(200, MS_EXACTLY), makeSpec(300, MS_EXACTLY));
  expect(calls).toBe(1);
  expect([leaf.measuredW, leaf.measuredH]).toEqual([200, 300]);
});
test("a wrapping frame aligns multiple match-parent children to its final size", async () => {
  const frame = rt.make("android/widget/FrameLayout") as JView;
  const a = rt.make("android/view/View") as JView, b = rt.make("android/view/View") as JView;
  for (const [view, width] of [[a, 40], [b, 80]] as const) Object.assign(view, {
    [onMeasure](w: number, h: number) { view.measuredW = resolveSizeAndState(width, w); view.measuredH = resolveSizeAndState(20, h); },
  });
  await add(frame, a, "FrameLayout", -1, 20);
  await add(frame, b, "FrameLayout", -1, 20);
  await measureView(frame, makeSpec(200, MS_AT_MOST), makeSpec(200, MS_AT_MOST));
  expect([frame.measuredW, a.measuredW, b.measuredW]).toEqual([80, 80, 80]);
});

test("wrapping linear layouts size match-parent dividers from their siblings", async () => {
  for (const vertical of [false, true]) {
    const row = rt.make("android/widget/LinearLayout") as JView;
    await vcall(row, "setOrientation", "(I)V", +vertical);
    const child = rt.make("android/view/View") as JView;
    const divider = rt.make("android/view/View") as JView;
    await add(row, child, "LinearLayout", vertical ? 48 : 40, vertical ? 40 : 48);
    await add(row, divider, "LinearLayout", vertical ? -1 : 1, vertical ? 1 : -1);
    await measureView(row, makeSpec(300, MS_AT_MOST), makeSpec(300, MS_AT_MOST));
    expect([row.measuredW, row.measuredH]).toEqual(vertical ? [48, 41] : [41, 48]);
    expect([divider.measuredW, divider.measuredH]).toEqual(vertical ? [48, 1] : [1, 48]);
  }
});

test("an all-match-parent linear layout retains the available cross dimension", async () => {
  const row = rt.make("android/widget/LinearLayout") as JView;
  const child = rt.make("android/view/View") as JView;
  await add(row, child, "LinearLayout", 40, -1);
  await measureView(row, makeSpec(300, MS_AT_MOST), makeSpec(200, MS_AT_MOST));
  expect([row.measuredW, row.measuredH, child.measuredH]).toEqual([40, 200, 200]);
});
