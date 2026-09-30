import { expect, test, describe } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall, newObj, vcallAsync } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";
import { onMain } from "../src/android/mainloop";
import { JView, makeSpec, measureView, MS_AT_MOST, uiState } from "../src/android/view";

describe("view-animation-dispatch", () => {
  rt.linkNatives();

  test("view animation frames dispatch through getTransformation overrides", async () => {
    const animation = await newObj("android/view/animation/AlphaAnimation", "(FF)V", 0, 1);
    await vcall(animation, "setDuration", "(J)V", 0n);
    const twoArgs = mangleMethod("getTransformation", "(JLandroid/view/animation/Transformation;)Z");
    const threeArgs = mangleMethod("getTransformation", "(JLandroid/view/animation/Transformation;F)Z");
    const prototype = rt.link("android/view/animation/Animation").ctor.prototype;
    let twoArgCalls = 0, threeArgCalls = 0;
    animation[twoArgs] = async function (now: bigint, transformation: unknown) {
      twoArgCalls++;
      return await prototype[twoArgs].call(this, now, transformation);
    };
    animation[threeArgs] = async function (now: bigint, transformation: unknown, scale: number) {
      threeArgCalls++;
      return await prototype[threeArgs].call(this, now, transformation, scale);
    };

    const view = await newObj("android/view/View", "(Landroid/content/Context;)V", null);
    const existing = new Set(uiState.animHooks);
    await vcall(view, "startAnimation", "(Landroid/view/animation/Animation;)V", animation);
    const hook = [...uiState.animHooks].find((candidate) => !existing.has(candidate));
    expect(hook).toBeDefined();
    hook!();
    await onMain(() => {});

    expect(threeArgCalls).toBe(1);
    expect(twoArgCalls).toBe(1);
    expect(await vcall(view, "getAnimation", "()Landroid/view/animation/Animation;")).toBeNull();
    uiState.animHooks.delete(hook!);
  });
});

describe("view-animator", () => {
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
});
