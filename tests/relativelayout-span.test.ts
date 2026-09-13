import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JView, JViewGroup, makeSpec, MS_EXACTLY } from "../src/android/view";

rt.linkNatives();
const RIGHT_OF = 1, ALIGN_PARENT_RIGHT = 11, ALIGN_PARENT_TOP = 10, ALIGN_PARENT_BOTTOM = 12, MATCH_PARENT = -1;

test("a RelativeLayout child fixed on both edges is measured to the span between them", async () => {
  const layout = new (rt.link("android/widget/RelativeLayout").ctor as new () => JViewGroup)();
  const photo = new JView(); photo.idNum = 0x7f0a0055;
  photo.lp = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", 96, 96);
  const pill = new JView();
  pill.lp = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", 1, MATCH_PARENT);
  await vcall(pill.lp, "setMargins", "(IIII)V", 24, 24, 24, 24);
  await vcall(pill.lp, "addRule", "(II)V", RIGHT_OF, photo.idNum);
  await vcall(pill.lp, "addRule", "(I)V", ALIGN_PARENT_RIGHT);
  const band = new JView();
  band.lp = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", 10, 1);
  await vcall(band.lp, "addRule", "(I)V", ALIGN_PARENT_TOP);
  await vcall(band.lp, "addRule", "(I)V", ALIGN_PARENT_BOTTOM);
  for (const c of [photo, pill, band]) { c.parent = layout; layout.children.push(c); }
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
});
