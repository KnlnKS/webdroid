import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JDrawable } from "../src/android/drawable";
import { JView, JLinearLP, makeSpec, measureView, layoutView, MS_AT_MOST, MS_EXACTLY } from "../src/android/view";
import { JLinearLayout } from "../src/android/layouts";

class Divider extends JDrawable {
  drawn: number[][] = [];
  intrinsicW() { return 2; }
  intrinsicH() { return 2; }
  paint() { const b = this.bounds; this.drawn.push([b.left, b.top, b.right, b.bottom]); }
}
rt.register({ name: "test/LinearDivider", ctor: Divider, sup: "android/graphics/drawable/Drawable" });
rt.linkNatives();
test("linear dividers reserve space around visible children and draw within padding", async () => {
  const parent = rt.make("android/widget/LinearLayout") as JLinearLayout;
  parent.orientation = 1; parent.padT = 3; parent.padB = 4;
  const divider = rt.make("test/LinearDivider") as Divider;
  await vcall(parent, "setDividerDrawable", "(Landroid/graphics/drawable/Drawable;)V", divider);
  await vcall(parent, "setShowDividers", "(I)V", 7);
  await vcall(parent, "setDividerPadding", "(I)V", 1);
  const children: JView[] = [];
  for (const h of [50, 10, 20]) {
    const c = rt.make("android/view/View") as JView;
    const lp = await newObj("android/widget/LinearLayout$LayoutParams", "(II)V", 20, h);
    await vcall(parent, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", c, lp);
    children.push(c);
  }
  children[0].visibility = 8;
  await measureView(parent, makeSpec(20, MS_EXACTLY), makeSpec(100, MS_AT_MOST));
  await layoutView(parent, 0, 0, 20, parent.measuredH);
  expect(parent.measuredH).toBe(43);
  expect(children.slice(1).map(c => [c.top, c.bottom])).toEqual([[5, 15], [17, 37]]);
  await vcall(parent, "onDraw", "(Landroid/graphics/Canvas;)V", null);
  expect(divider.drawn).toEqual([[1, 3, 19, 5], [1, 15, 19, 17], [1, 37, 19, 39]]);
  expect(await vcall(parent, "getShowDividers", "()I")).toBe(7);
  expect(await vcall(parent, "getDividerDrawable", "()Landroid/graphics/drawable/Drawable;")).toBe(divider);
  const weighted = children[1].lp as JLinearLP;
  weighted.height = 0; weighted.weight = 1;
  await measureView(parent, makeSpec(20, MS_EXACTLY), makeSpec(63, MS_EXACTLY));
  expect(children[1].measuredH).toBe(30);
  await vcall(parent, "setShowDividers", "(I)V", 0);
  await measureView(parent, makeSpec(20, MS_EXACTLY), makeSpec(63, MS_EXACTLY));
  expect(children[1].measuredH).toBe(36);
});
