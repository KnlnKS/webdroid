import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { JView, measureView, makeSpec, MS_AT_MOST } from "../src/android/view";

rt.linkNatives();
test("ViewSwitcher builds two views, resets them and rejects a third", async () => {
  const switcher = rt.make("android/widget/ViewSwitcher");
  const views: JView[] = [];
  await vcall(switcher, "setFactory", "(Landroid/widget/ViewSwitcher$ViewFactory;)V", {
    [mangleMethod("makeView", "()Landroid/view/View;")]: async () => {
      await Promise.resolve();
      const view = rt.make("android/view/View");
      if (!(view instanceof JView)) throw new Error("Invalid view delegate");
      views.push(view);
      return view;
    },
  });
  expect(views).toHaveLength(2);
  expect(views.map(v => [v.lp?.width, v.lp?.height])).toEqual([[-1, -2], [-1, -2]]);
  expect(await vcall(switcher, "getNextView", "()Landroid/view/View;")).toBe(views[1]);
  await vcall(switcher, "reset", "()V");
  expect(views.map(v => v.visibility)).toEqual([8, 8]);
  await vcall(switcher, "showNext", "()V");
  expect(views.map(v => v.visibility)).toEqual([8, 0]);
  await expect(vcallAsync(switcher, "addView", "(Landroid/view/View;)V", rt.make("android/view/View"))).rejects.toMatchObject({ msg: "Can't add more than 2 views to a ViewSwitcher" });
});
test("ViewAnimator switches, wraps and preserves the displayed child when inserting", async () => {
  const animator = rt.make("android/widget/ViewAnimator");
  const children = Array.from({ length: 3 }, () => rt.make("android/view/View"));
  for (const child of children) await vcall(animator, "addView", "(Landroid/view/View;)V", child);
  expect(children.map(v => v.visibility)).toEqual([0, 8, 8]);
  await vcall(animator, "showPrevious", "()V");
  expect(await vcall(animator, "getCurrentView", "()Landroid/view/View;")).toBe(children[2]);
  await vcall(animator, "showNext", "()V");
  const inserted = rt.make("android/view/View");
  await vcall(animator, "addView", "(Landroid/view/View;I)V", inserted, 0);
  expect(await vcall(animator, "getCurrentView", "()Landroid/view/View;")).toBe(children[0]);
  expect(inserted.visibility).toBe(8);
  await vcall(animator, "removeView", "(Landroid/view/View;)V", children[0]);
  expect(await vcall(animator, "getCurrentView", "()Landroid/view/View;")).toBe(children[1]);
  await vcall(animator, "removeAllViews", "()V");
  expect(await vcall(animator, "getCurrentView", "()Landroid/view/View;")).toBeNull();
  expect(await vcall(animator, "getDisplayedChild", "()I")).toBe(0);
});
test("ViewAnimator measures hidden children by default", async () => {
  const animator = rt.make("android/widget/ViewAnimator");
  if (!(animator instanceof JView)) throw new Error("Invalid view delegate");
  for (const size of [20, 80]) {
    const child = rt.make("android/view/View");
    const lp = await newObj("android/widget/FrameLayout$LayoutParams", "(II)V", size, size);
    await vcall(animator, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", child, lp);
  }
  await measureView(animator, makeSpec(100, MS_AT_MOST), makeSpec(100, MS_AT_MOST));
  expect([animator.measuredW, animator.measuredH]).toEqual([80, 80]);
  await vcall(animator, "setMeasureAllChildren", "(Z)V", 0);
  await vcall(animator, "requestLayout", "()V");
  await measureView(animator, makeSpec(100, MS_AT_MOST), makeSpec(100, MS_AT_MOST));
  expect([animator.measuredW, animator.measuredH]).toEqual([20, 20]);
});
