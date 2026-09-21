import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JView, JViewGroup, JMarginLP, makeSpec, MS_EXACTLY, MS_AT_MOST } from "../src/android/view";

rt.linkNatives();
const RIGHT_OF = 1, ALIGN_PARENT_RIGHT = 11, ALIGN_PARENT_TOP = 10, ALIGN_PARENT_BOTTOM = 12, MATCH_PARENT = -1;

test("a RelativeLayout child fixed on both edges is measured to the span between them", async () => {
  const layout = new (rt.link("android/widget/RelativeLayout").ctor as new () => JViewGroup)();
  const photo = new JView(); photo.idNum = 0x7f0a0055;
  photo.lp = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", 96, 96);
  const hidden = new JView(); hidden.idNum = 0x7f0a0056; hidden.visibility = 8;
  hidden.lp = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", 300, 96);
  await vcall(hidden.lp, "addRule", "(II)V", 17, photo.idNum);
  const pill = new JView();
  pill.lp = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", MATCH_PARENT, MATCH_PARENT);
  await vcall(pill.lp, "setMargins", "(IIII)V", 24, 24, 24, 24);
  await vcall(pill.lp, "addRule", "(II)V", 17, hidden.idNum);
  await vcall(pill.lp, "addRule", "(I)V", ALIGN_PARENT_RIGHT);
  const band = new JView();
  band.lp = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", 10, 1);
  await vcall(band.lp, "addRule", "(I)V", ALIGN_PARENT_TOP);
  await vcall(band.lp, "addRule", "(I)V", ALIGN_PARENT_BOTTOM);
  for (const c of [photo, hidden, pill, band]) { c.parent = layout; layout.children.push(c); }
  await vcall(layout, "onMeasure", "(II)V", makeSpec(1080, MS_EXACTLY), makeSpec(168, MS_EXACTLY));
  await vcall(layout, "onLayout", "(ZIIII)V", 1, 0, 0, 1080, 168);
  expect([pill.left, pill.right]).toEqual([120, 1056]);
  expect(pill.measuredW).toBe(936);
  expect([band.top, band.bottom, band.measuredW]).toEqual([0, 168, 10]);
});

test("RelativeLayout rules expose their verb-indexed anchors", async () => {
  const params = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", 1, 1);
  await vcall(params, "addRule", "(II)V", RIGHT_OF, 42);
  await vcall(params, "addRule", "(I)V", ALIGN_PARENT_RIGHT);
  const rules = await vcall(params, "getRules", "()[I") as Int32Array;
  expect(rules.length).toBe(22);
  expect(rules[RIGHT_OF]).toBe(42);
  expect(rules[ALIGN_PARENT_RIGHT]).toBe(-1);
  await vcall(params, "setMargins", "(IIII)V", 2, 3, 5, 7);
  const copy = await newObj("android/widget/RelativeLayout$LayoutParams", "(Landroid/widget/RelativeLayout$LayoutParams;)V", params);
  expect(copy).toBeInstanceOf(JMarginLP);
  if (!(copy instanceof JMarginLP)) throw new Error("Invalid layout parameters");
  expect([copy.marginL, copy.marginT, copy.marginR, copy.marginB]).toEqual([2, 3, 5, 7]);
  await vcall(params, "removeRule", "(I)V", RIGHT_OF);
  expect(await vcall(copy, "getRule", "(I)I", RIGHT_OF)).toBe(42);
  await vcall(copy, "addRule", "(II)V", 16, 99);
  expect((await vcall(copy, "getRules", "(I)[I", 0))[0]).toBe(99);
  expect((await vcall(copy, "getRules", "(I)[I", 1))[1]).toBe(99);
  await vcall(copy, "removeRule", "(I)V", 16);
  expect((await vcall(copy, "getRules", "(I)[I", 0))[1]).toBe(42);
});

test("RelativeLayout fills a match-parent overlay before centering its controls under AT_MOST", async () => {
  const layout = rt.make("android/widget/RelativeLayout");
  if (!(layout instanceof JViewGroup)) throw new Error("Invalid layout");
  const button = rt.make("android/view/View"), overlay = rt.make("android/widget/FrameLayout");
  if (!(button instanceof JView) || !(overlay instanceof JView)) throw new Error("Invalid children");
  button.lp = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", 60, 60);
  await vcall(button.lp, "addRule", "(I)V", 13);
  overlay.lp = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", -1, -1);
  for (const c of [button, overlay]) { c.parent = layout; layout.children.push(c); }
  await vcall(layout, "onMeasure", "(II)V", makeSpec(360, MS_EXACTLY), makeSpec(700, MS_AT_MOST));
  await vcall(layout, "onLayout", "(ZIIII)V", 1, 0, 0, 360, 700);
  expect([layout.measuredW, layout.measuredH, overlay.measuredW, overlay.measuredH]).toEqual([360, 700, 360, 700]);
  expect([button.left, button.top, button.right, button.bottom]).toEqual([150, 320, 210, 380]);
});

test("RelativeLayout centers wrapping content inside its measured bounds", async () => {
  const layout = rt.make("android/widget/RelativeLayout");
  if (!(layout instanceof JViewGroup)) throw new Error("Invalid layout");
  const child = new JView();
  child.lp = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", 60, 40);
  await vcall(child.lp, "addRule", "(I)V", 13);
  child.parent = layout; layout.children.push(child);
  layout.minW = 100; layout.minH = 80;
  await vcall(layout, "onMeasure", "(II)V", makeSpec(1080, MS_AT_MOST), makeSpec(2160, MS_AT_MOST));
  await vcall(layout, "onLayout", "(ZIIII)V", 1, 0, 0, layout.measuredW, layout.measuredH);
  expect([layout.measuredW, layout.measuredH]).toEqual([100, 80]);
  expect([child.left, child.top, child.right, child.bottom]).toEqual([20, 20, 80, 60]);
});
