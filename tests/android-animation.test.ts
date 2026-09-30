import { expect, test, describe } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { vcall, newObj, vcallOn, curThread, JThread, vcallAsync } from "../src/jvm/natives/jlang";
import { boxDesc, boxFloat, unbox } from "../src/jvm/natives/jbox";
import { type JPoint } from "../src/android/graphics";
import { mangleMethod, jarray } from "../src/jvm/abi";
import { onMain } from "../src/android/mainloop";
import { JView, makeSpec, measureView, MS_AT_MOST, uiState } from "../src/android/view";
import { scall } from "./java";

describe("animator-start", () => {
  rt.linkNatives();

  test("a started object animator reports its first key before the first frame", async () => {
    const anim = await newObj("android/animation/ValueAnimator", "()V");
    await vcall(anim, "setObjectValues", "([Ljava/lang/Object;)V", jarray([boxFloat(30), boxFloat(90)], "Ljava/lang/Float;"));
    await vcall(anim, "setEvaluator", "(Landroid/animation/TypeEvaluator;)V", await newObj("android/animation/FloatEvaluator", "()V"));
    await vcall(anim, "setDuration", "(J)Landroid/animation/ValueAnimator;", 1000n);
    await vcall(anim, "start", "()V");
    const value = await vcall(anim, "getAnimatedValue", "()Ljava/lang/Object;");
    expect(boxDesc(value)).toBe("F");
    expect(await vcall(value, "floatValue", "()F")).toBe(30);
    await vcall(anim, "cancel", "()V");
  });

  test("a started float animator reports its start value before the first frame", async () => {
    const anim = scall("android/animation/ValueAnimator", "ofFloat", "([F)Landroid/animation/ValueAnimator;", new Float32Array([0.25, 1]));
    await vcall(anim, "start", "()V");
    expect(await vcall(await vcall(anim, "getAnimatedValue", "()Ljava/lang/Object;"), "floatValue", "()F")).toBe(0.25);
    await vcall(anim, "cancel", "()V");
  });

  class Alpha extends JObj {
    value = 0.25;
    [mangleMethod("get", "(Ljava/lang/Object;)Ljava/lang/Object;")]() { return boxFloat(this.value); }
    [mangleMethod("set", "(Ljava/lang/Object;Ljava/lang/Object;)V")](_t: unknown, v: unknown) { this.value = unbox(v) as number; }
  }

  class LegacyListener extends JObj { ended = 0; }
  rt.register({
    name: "test/LegacyAnimatorListener", ctor: LegacyListener, ifaces: ["android/animation/Animator$AnimatorListener"],
    methods: { "onAnimationEnd(Landroid/animation/Animator;)V": function (this: LegacyListener) { this.ended++; } },
  });
  class DirectionalListener extends JObj { reverse: number[] = []; }
  rt.register({
    name: "test/DirectionalAnimatorListener", ctor: DirectionalListener, ifaces: ["android/animation/Animator$AnimatorListener"],
    methods: {
      "onAnimationEnd(Landroid/animation/Animator;Z)V": function (this: DirectionalListener, _animator: unknown, reverse: number) {
        this.reverse.push(reverse);
      },
    },
  });

  test("a one-value ObjectAnimator on a Property starts from the Property's current value", async () => {
    const prop = new Alpha(), target = new JObj();
    const anim = scall("android/animation/ObjectAnimator", "ofFloat", "(Ljava/lang/Object;Landroid/util/Property;[F)Landroid/animation/ObjectAnimator;", target, prop, new Float32Array([1]));
    await vcall(anim, "start", "()V");
    expect(anim.from).toBe(0.25);
    expect(await vcall(await vcall(anim, "getAnimatedValue", "()Ljava/lang/Object;"), "floatValue", "()F")).toBe(0.25);
    await vcall(anim, "cancel", "()V");
  });

  test("Animator clone uses the covariant framework descriptor", async () => {
    const anim = await newObj("android/animation/ValueAnimator", "()V");
    await vcall(anim, "setDuration", "(J)Landroid/animation/Animator;", 750n);
    const copy = await vcall(anim, "clone", "()Landroid/animation/Animator;");
    expect(copy).not.toBe(anim);
    expect(await vcall(copy, "getDuration", "()J")).toBe(750n);
  });

  test("AnimatorSet clone owns its child animations", async () => {
    const set = await newObj("android/animation/AnimatorSet");
    const child = await newObj("android/animation/ValueAnimator");
    await vcall(set, "playTogether", "([Landroid/animation/Animator;)V", [child]);
    const copy = await vcall(set, "clone", "()Landroid/animation/AnimatorSet;");
    expect(copy).not.toBe(set);
    expect(copy.anims[0]).not.toBe(child);
    await vcall(copy.anims[0], "setDuration", "(J)Landroid/animation/ValueAnimator;", 700n);
    expect(await vcall(child, "getDuration", "()J")).toBe(300n);
  });

  test("the directional end callback defaults to the legacy listener", async () => {
    const listener = rt.make("test/LegacyAnimatorListener") as LegacyListener;
    const defaultEnd = (rt.link("android/animation/Animator$AnimatorListener").ctor.prototype as Record<string, (...args: unknown[]) => unknown>)[
      mangleMethod("onAnimationEnd", "(Landroid/animation/Animator;Z)V")
    ];
    await defaultEnd.call(listener, null, 1);
    expect(listener.ended).toBe(1);
  });

  test("AnimatorSet dispatches the directional end callback", async () => {
    const listener = rt.make("test/DirectionalAnimatorListener") as DirectionalListener;
    const animator = await newObj("android/animation/AnimatorSet");
    await vcall(animator, "addListener", "(Landroid/animation/Animator$AnimatorListener;)V", listener);
    await vcall(animator, "start", "()V");
    await new Promise((resolve) => setTimeout(resolve, 0)); await onMain(() => {});
    expect(listener.reverse).toEqual([0]);
  });

  class PointXConverter extends JObj {
    points: JPoint[] = [];
    [mangleMethod("convert", "(Ljava/lang/Object;)Ljava/lang/Object;")](point: JPoint) {
      this.points.push(point);
      return boxFloat(point.x);
    }
  }

  test("ObjectAnimator converts reusable PointF values along every path contour", async () => {
    const path = await newObj("android/graphics/Path", "()V");
    await vcall(path, "moveTo", "(FF)V", 0, 0);
    await vcall(path, "lineTo", "(FF)V", 10, 0);
    await vcall(path, "moveTo", "(FF)V", 20, 0);
    await vcall(path, "lineTo", "(FF)V", 30, 0);
    const converter = new PointXConverter();
    const anim = scall("android/animation/ObjectAnimator", "ofObject",
      "(Ljava/lang/Object;Landroid/util/Property;Landroid/animation/TypeConverter;Landroid/graphics/Path;)Landroid/animation/ObjectAnimator;",
      new JObj(), new Alpha(), converter, path);

    const evaluator = anim.evaluator;
    const atQuarter = await vcall(evaluator, "evaluate", "(FLjava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", 0.25, null, null);
    const atThreeQuarters = await vcall(evaluator, "evaluate", "(FLjava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", 0.75, null, null);
    const pastEnd = await vcall(evaluator, "evaluate", "(FLjava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", 1.25, null, null);
    expect(await vcall(atQuarter, "floatValue", "()F")).toBe(5);
    expect(await vcall(atThreeQuarters, "floatValue", "()F")).toBe(25);
    expect(await vcall(pastEnd, "floatValue", "()F")).toBe(35);
    expect(converter.points[0]).toBe(converter.points[2]);

    await vcall(anim, "start", "()V");
    expect(await vcall(await vcall(anim, "getAnimatedValue", "()Ljava/lang/Object;"), "floatValue", "()F")).toBe(0);
    await vcall(anim, "cancel", "()V");
  });
  class TimeListener extends JObj { times: [bigint, bigint][] = []; }
  rt.register({ name: "test/TimeListener", ctor: TimeListener, ifaces: ["android/animation/TimeAnimator$TimeListener"], methods: {
    "onTimeUpdate(Landroid/animation/TimeAnimator;JJ)V": function (this: TimeListener, _anim: unknown, total: bigint, delta: bigint) { this.times.push([total, delta]); },
  } });
  test("TimeAnimator starts at zero and keeps ticking beyond the inherited duration", async () => {
    const listener = await newObj("test/TimeListener"), animator = await newObj("android/animation/TimeAnimator");
    await vcall(animator, "setTimeListener", "(Landroid/animation/TimeAnimator$TimeListener;)V", listener);
    await vcall(animator, "setDuration", "(J)Landroid/animation/ValueAnimator;", 0n);
    const frame = async () => { for (const hook of [...uiState.animHooks]) if (!hook()) uiState.animHooks.delete(hook); await onMain(() => {}); };
    try {
      await vcall(animator, "start", "()V");
      await frame();
      expect(listener.times).toEqual([[0n, 0n]]);
      await Bun.sleep(5); await frame();
      expect(listener.times[1][0]).toBeGreaterThan(0n);
      expect(listener.times[1][1]).toBe(listener.times[1][0]);
      expect(await vcall(animator, "isRunning", "()Z")).toBe(1);
    } finally { await vcall(animator, "cancel", "()V"); await frame(); }
  });

  test("View.ALPHA reads and writes through the view's virtual accessors", async () => {
    class CustomAlpha extends JObj { value = 0.4; }
    rt.register({ name: "test/CustomAlpha", ctor: CustomAlpha, sup: "android/view/View", methods: {
      "getAlpha()F": function (this: CustomAlpha) { return this.value; },
      "setAlpha(F)V": function (this: CustomAlpha, value: number) { this.value = value; },
    } });
    await rt.initClass(rt.link("android/view/View"));
    const prop = rt.link("android/view/View").ctor.s$ALPHA, target = rt.make("test/CustomAlpha");
    expect(await vcall(prop, "getName", "()Ljava/lang/String;")).toBe("alpha");
    await vcall(prop, "set", "(Ljava/lang/Object;Ljava/lang/Object;)V", target, boxFloat(0.25));
    const anim = scall("android/animation/ObjectAnimator", "ofFloat", "(Ljava/lang/Object;Landroid/util/Property;[F)Landroid/animation/ObjectAnimator;", target, prop, new Float32Array([1]));
    await vcall(anim, "start", "()V");
    expect(anim.from).toBe(0.25);
    await vcall(anim, "cancel", "()V");
  });

  test("AnimatorSet notifies start listeners before starting its children", async () => {
    const set = await newObj("android/animation/AnimatorSet");
    const child = await newObj("android/animation/ValueAnimator");
    const thread = new JThread(), events: string[] = [];
    Object.assign(child, { [mangleMethod("start", "()V")]: () => { expect(curThread).toBe(thread); events.push("child"); } });
    for (const name of ["first", "second"]) await vcall(set, "addListener", "(Landroid/animation/Animator$AnimatorListener;)V", {
      [mangleMethod("onAnimationStart", "(Landroid/animation/Animator;)V")]: async (anim: unknown) => {
        expect(anim).toBe(set);
        expect(curThread).toBe(thread);
        events.push(name);
        await Promise.resolve();
      },
      [mangleMethod("onAnimationEnd", "(Landroid/animation/Animator;)V")]: () => {},
    });
    await vcall(set, "playTogether", "([Landroid/animation/Animator;)V", [child]);
    await vcallOn(thread, set, "start", "()V");
    expect(events).toEqual(["first", "second", "child"]);
  });

  test("AnimatorSet completion waits for the main job and serializes end listeners", async () => {
    const set = await newObj("android/animation/AnimatorSet"), events: string[] = [];
    let release!: () => void, finish!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const ended = new Promise<void>(resolve => { finish = resolve; });
    for (const name of ["first", "second"]) await vcall(set, "addListener", "(Landroid/animation/Animator$AnimatorListener;)V", {
      [mangleMethod("onAnimationStart", "(Landroid/animation/Animator;)V")]: () => {},
      [mangleMethod("onAnimationEnd", "(Landroid/animation/Animator;Z)V")]: async () => {
        events.push(name + " begin");
        await Bun.sleep(5);
        events.push(name + " end");
        if (name === "second") finish();
      },
    });
    const job = onMain(async () => { await vcall(set, "start", "()V"); await blocked; events.push("job end"); });
    try { await Bun.sleep(15); expect(events).toEqual([]); }
    finally { release(); }
    await job; await ended;
    expect(events).toEqual(["job end", "first begin", "first end", "second begin", "second end"]);
  });
});

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
