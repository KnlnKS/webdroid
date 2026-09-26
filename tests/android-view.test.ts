import { expect, test, spyOn, describe } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { vcall, newObj, vcallOn, curThread, JThread, JFloat, box, vcallAsync, mainThread, setCurThread } from "../src/jvm/natives/jlang";
import { JPaint, type JPoint, JMatrix, JCanvas, JRect, canvasMethods, JOutline } from "../src/android/graphics";
import { mangleMethod, jarray, mangleStaticField } from "../src/jvm/abi";
import { onMain } from "../src/android/mainloop";
import { JEditText, editorAction } from "../src/android/textview";
import { JView, JViewGroup, makeSpec, MS_EXACTLY, measureView, layoutView, MS_AT_MOST, resolveSize, JLinearLP, JMarginLP, obtainEvent, drawView, MS_UNSPEC, uiState, attachView, detachView, addUnattachedView, dispatchAttached, dispatchDetached, layoutRoot, replayLayoutRequests, requestLayout, JLayoutParams, setViewTargetSdk } from "../src/android/view";
import { JDrawable, ST } from "../src/android/drawable";
import { JLinearLayout, JFrameLayout } from "../src/android/layouts";
import { JMotionEvent } from "../src/android/motionevent";
import { classCtors } from "../src/jvm/natives/jreflect";
import { glSurfaces } from "../src/native/egl-current";
import { recordingContext, replay, type DisplayList } from "../src/android/recording";
import { Resources, JTheme } from "../src/android/res";
import { device } from "../src/shell/config";
import { JImageView } from "../src/android/imageview";
import { JWindowInsets } from "../src/android/windowinsets";
import { JActivity } from "../src/android/app";
import { JWebView } from "../src/android/webkit";

describe("accessibility-listeners", () => {
  rt.linkNatives();
  test("accessibility listeners deduplicate registrations and report removal per manager", async () => {
    const first = rt.make("android/view/accessibility/AccessibilityManager");
    const second = rt.make("android/view/accessibility/AccessibilityManager");
    const listener = new JObj();
    for (const kind of ["AccessibilityState", "TouchExplorationState", "AccessibilityServicesState"]) {
      const arg = `(Landroid/view/accessibility/AccessibilityManager$${kind}ChangeListener;)`;
      const add = `add${kind}ChangeListener`, remove = `remove${kind}ChangeListener`;
      await vcall(first, add, arg + (kind === "AccessibilityServicesState" ? "V" : "Z"), listener);
      await vcall(first, add, arg + (kind === "AccessibilityServicesState" ? "V" : "Z"), listener);
      expect(await vcall(second, remove, arg + "Z", listener)).toBe(0);
      expect(await vcall(first, remove, arg + "Z", listener)).toBe(1);
      expect(await vcall(first, remove, arg + "Z", listener)).toBe(0);
    }
  });
});

describe("accessibility-service-info", () => {
  rt.linkNatives();

  test("AccessibilityServiceInfo starts with Android's disabled defaults", async () => {
    const info = await newObj("android/accessibilityservice/AccessibilityServiceInfo", "()V");
    expect(await vcall(info, "getCapabilities", "()I")).toBe(0);
    expect(await vcall(info, "getId", "()Ljava/lang/String;")).toBeNull();
    expect(info).toMatchObject({ eventTypes: 0, feedbackType: 0, flags: 0, notificationTimeout: 0n, packageNames: null });
  });
});

describe("android-surface-state", () => {
  rt.linkNatives();
  const scall = (cls: string, name: string, desc: string, ...args: unknown[]) =>
    (rt.link(cls).ctor as unknown as Record<string, (...values: unknown[]) => unknown>)[mangleMethod(name, desc)](...args);

  test("Paint reset restores a fresh paint state", async () => {
    const paint = new JPaint();
    paint.color = 1; paint.style = 2; paint.strokeWidth = 3; paint.textSize = 4;
    paint.dash = [1, 2]; paint.fakeBold = true; paint.strikeThru = true;
    paint.shadowRadius = 5; paint.shadowColor = 6;
    await vcall(paint, "reset", "()V");

    const fresh = new JPaint();
    expect({ ...paint, tf: undefined }).toEqual({ ...fresh, tf: undefined });
    expect(paint.tf).toBe(fresh.tf);
  });

  test("Paint retains text scale and skew state", async () => {
    const paint = new JPaint();
    await vcall(paint, "setTextScaleX", "(F)V", 1.25);
    await vcall(paint, "setTextSkewX", "(F)V", -0.2);
    expect(await vcall(paint, "getTextScaleX", "()F")).toBe(1.25);
    expect(await vcall(paint, "getTextSkewX", "()F")).toBeCloseTo(-0.2);

    const copy = await newObj("android/graphics/Paint", "(Landroid/graphics/Paint;)V", paint);
    expect(await vcall(copy, "getTextSkewX", "()F")).toBeCloseTo(-0.2);
    await vcall(copy, "reset", "()V");
    expect(await vcall(copy, "getTextScaleX", "()F")).toBe(1);
    expect(await vcall(copy, "getTextSkewX", "()F")).toBe(0);
  });

  test("Paint returns its stroke cap and join", async () => {
    const paint = new JPaint();
    await vcall(paint, "setStrokeCap", "(Landroid/graphics/Paint$Cap;)V", { ord: 1 });
    await vcall(paint, "setStrokeJoin", "(Landroid/graphics/Paint$Join;)V", { ord: 2 });
    expect((await vcall(paint, "getStrokeCap", "()Landroid/graphics/Paint$Cap;") as { ename: string }).ename).toBe("ROUND");
    expect((await vcall(paint, "getStrokeJoin", "()Landroid/graphics/Paint$Join;") as { ename: string }).ename).toBe("BEVEL");
  });

  test("Paint retains font feature settings across copy and clears them on reset", async () => {
    const paint = new JPaint();
    expect(await vcall(paint, "getFontFeatureSettings", "()Ljava/lang/String;")).toBeNull();
    await vcall(paint, "setFontFeatureSettings", "(Ljava/lang/String;)V", "kern=0");
    expect(await vcall(paint, "getFontFeatureSettings", "()Ljava/lang/String;")).toBe("kern=0");

    const copy = await newObj("android/graphics/Paint", "(Landroid/graphics/Paint;)V", paint);
    expect(await vcall(copy, "getFontFeatureSettings", "()Ljava/lang/String;")).toBe("kern=0");
    await vcall(copy, "reset", "()V");
    expect(await vcall(copy, "getFontFeatureSettings", "()Ljava/lang/String;")).toBeNull();
  });

  test("Paint retains font variation settings across copy and clears them on reset", async () => {
    const paint = new JPaint();
    expect(await vcall(paint, "getFontVariationSettings", "()Ljava/lang/String;")).toBeNull();
    expect(await vcall(paint, "setFontVariationSettings", "(Ljava/lang/String;)Z", "'wdth' 125")).toBe(1);
    expect(await vcall(paint, "getFontVariationSettings", "()Ljava/lang/String;")).toBe("'wdth' 125");

    const copy = await newObj("android/graphics/Paint", "(Landroid/graphics/Paint;)V", paint);
    expect(await vcall(copy, "getFontVariationSettings", "()Ljava/lang/String;")).toBe("'wdth' 125");
    await vcall(copy, "reset", "()V");
    expect(await vcall(copy, "getFontVariationSettings", "()Ljava/lang/String;")).toBeNull();
    expect(await vcall(paint, "setFontVariationSettings", "(Ljava/lang/String;)Z", "")).toBe(1);
    expect(await vcall(paint, "getFontVariationSettings", "()Ljava/lang/String;")).toBeNull();
  });

  test("TextView retains and exposes its shadow layer", async () => {
    const view = await newObj("android/widget/TextView");
    await vcall(view, "setShadowLayer", "(FFFI)V", 4.5, 2, -3, 0x7f123456);
    expect(await vcall(view, "getShadowRadius", "()F")).toBe(4.5);
    expect(await vcall(view, "getShadowDx", "()F")).toBe(2);
    expect(await vcall(view, "getShadowDy", "()F")).toBe(-3);
    expect(await vcall(view, "getShadowColor", "()I")).toBe(0x7f123456);
  });

  test("uname reports the emulated Linux ABI", async () => {
    const uts = scall("android/system/Os", "uname", "()Landroid/system/StructUtsname;");
    if (typeof uts !== "object" || uts === null || !("sysname" in uts) || !("release" in uts) || !("machine" in uts))
      throw new Error("uname returned an invalid StructUtsname");
    expect(uts.sysname).toBe("Linux");
    expect(String(uts.release)).toContain("webdroid");
    expect(["aarch64", "armv7l"]).toContain(String(uts.machine));
  });
});

describe("animator-start", () => {
  rt.linkNatives();
  const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);

  test("a started object animator reports its first key before the first frame", async () => {
    const anim = await newObj("android/animation/ValueAnimator", "()V");
    await vcall(anim, "setObjectValues", "([Ljava/lang/Object;)V", jarray([box(JFloat, 30), box(JFloat, 90)], "Ljava/lang/Float;"));
    await vcall(anim, "setEvaluator", "(Landroid/animation/TypeEvaluator;)V", await newObj("android/animation/FloatEvaluator", "()V"));
    await vcall(anim, "setDuration", "(J)Landroid/animation/ValueAnimator;", 1000n);
    await vcall(anim, "start", "()V");
    const value = await vcall(anim, "getAnimatedValue", "()Ljava/lang/Object;");
    expect(value).toBeInstanceOf(JFloat);
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
    [mangleMethod("get", "(Ljava/lang/Object;)Ljava/lang/Object;")]() { return box(JFloat, this.value); }
    [mangleMethod("set", "(Ljava/lang/Object;Ljava/lang/Object;)V")](_t: unknown, v: JFloat) { this.value = v.v as number; }
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
      return box(JFloat, point.x);
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
    const { uiState } = await import("../src/android/view");
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
    await vcall(prop, "set", "(Ljava/lang/Object;Ljava/lang/Object;)V", target, box(JFloat, 0.25));
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

describe("array-adapter", () => {
  test("ArrayAdapter keeps a supplied List live", async () => {
    const list = await newObj("java/util/ArrayList", "()V");
    const adapter = await newObj("android/widget/ArrayAdapter", "(Landroid/content/Context;ILjava/util/List;)V", null, 0, list);
    await vcall(list, "add", "(Ljava/lang/Object;)Z", "first");
    expect(await vcall(adapter, "getCount", "()I")).toBe(1);
    expect(await vcall(adapter, "getItem", "(I)Ljava/lang/Object;", 0)).toBe("first");
    await vcall(adapter, "add", "(Ljava/lang/Object;)V", "second");
    expect(await vcall(list, "size", "()I")).toBe(2);
    await vcall(adapter, "clear", "()V");
    expect(await vcall(list, "size", "()I")).toBe(0);
  });
});

describe("editor-action", () => {
  rt.linkNatives();
  class KeyListener extends JObj { keys: [number, number][] = []; [mangleMethod("onKey", "(Landroid/view/View;ILandroid/view/KeyEvent;)Z")](_v: unknown, code: number, ev: any) { this.keys.push([ev.action, code]); return 1; } }
  class ActionListener extends JObj { actions: number[] = []; consume = 1; [mangleMethod("onEditorAction", "(Landroid/widget/TextView;ILandroid/view/KeyEvent;)Z")](_v: unknown, action: number) { this.actions.push(action); return this.consume; } }

  test("an editor action nobody listens for arrives as an ENTER key press", async () => {
    const field = new JEditText(); field.enabled = true;
    const keys = new KeyListener(); field.keyL = keys;
    expect(await editorAction(field, 3)).toBe(true);
    expect(keys.keys).toEqual([[0, 66], [1, 66]]);
  });

  test("a consuming editor-action listener takes the action and no key is sent", async () => {
    const field = new JEditText(); field.enabled = true;
    const keys = new KeyListener(), actions = new ActionListener();
    field.keyL = keys; field.editorActionL = actions;
    expect(await editorAction(field, 3)).toBe(true);
    expect(actions.actions).toEqual([3]);
    expect(keys.keys).toEqual([]);
    actions.consume = 0;
    await editorAction(field, 2);
    expect(keys.keys).toEqual([[0, 66], [1, 66]]);
    await editorAction(field, 6);
    expect(keys.keys.length).toBe(2);
  });
});

describe("focus-change", () => {
  rt.linkNatives();

  class FocusListener extends JObj {
    events: [JView, number][] = [];
    async [mangleMethod("onFocusChange", "(Landroid/view/View;Z)V")](view: JView, focused: number) {
      await Promise.resolve();
      this.events.push([view, focused]);
    }
  }

  class FocusRedirect extends JView {
    constructor(readonly child: JView) { super(); }
    [mangleMethod("requestFocus", "(ILandroid/graphics/Rect;)Z")](direction: number, rect: unknown) {
      expect(direction).toBe(130);
      expect(rect).toBeNull();
      return vcall(this.child, "requestFocus", "()Z");
    }
  }

  test("focus transfer notifies the old and new views in order", async () => {
    const root = new JViewGroup();
    const first = new JView(), second = new JView();
    first.parent = root; second.parent = root;
    first.focusable = second.focusable = true;
    root.children.push(first, second);
    const listener = new FocusListener();
    first.focusL = second.focusL = listener;

    expect(await vcall(first, "requestFocus", "()Z")).toBe(1);
    expect(await vcall(first, "requestFocus", "()Z")).toBe(1);
    expect(await vcall(second, "requestFocus", "()Z")).toBe(1);
    await vcall(second, "clearFocus", "()V");

    expect(listener.events).toEqual([[first, 1], [first, 0], [second, 1], [second, 0]]);
    expect(first.focused).toBe(false);
    expect(second.focused).toBe(false);
  });

  test("a non-focusable view rejects focus without notifying", async () => {
    const view = new JView(), listener = new FocusListener();
    view.focusL = listener;
    expect(await vcall(view, "requestFocus", "()Z")).toBe(0);
    expect(listener.events).toEqual([]);
  });

  test("no-argument requestFocus honors a view's directional override", async () => {
    const child = new JView(); child.focusable = true;
    const redirect = new FocusRedirect(child);
    child.parent = redirect;
    const listener = new FocusListener(); child.focusL = listener;

    expect(await vcall(redirect, "requestFocus", "()Z")).toBe(1);
    expect(listener.events).toEqual([[child, 1]]);
    expect(redirect.focused).toBe(false);
  });
});

describe("gridlayout", () => {
  rt.linkNatives();
  const scall = (cls: string, name: string, desc: string, ...args: unknown[]) =>
    (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);

  test("GridLayout places explicit specs into distinct cells", async () => {
    const grid = new (rt.link("android/widget/GridLayout").ctor as new () => JViewGroup)();
    await vcall(grid, "setColumnCount", "(I)V", 2);
    const first = new JView(), second = new JView();
    const row = scall("android/widget/GridLayout", "spec", "(I)Landroid/widget/GridLayout$Spec;", 0);
    const col0 = scall("android/widget/GridLayout", "spec", "(I)Landroid/widget/GridLayout$Spec;", 0);
    const col1 = scall("android/widget/GridLayout", "spec", "(I)Landroid/widget/GridLayout$Spec;", 1);
    const firstLp = await newObj("android/widget/GridLayout$LayoutParams", "(Landroid/widget/GridLayout$Spec;Landroid/widget/GridLayout$Spec;)V", row, col0);
    const secondLp = await newObj("android/widget/GridLayout$LayoutParams", "(Landroid/widget/GridLayout$Spec;Landroid/widget/GridLayout$Spec;)V", row, col1);
    firstLp.width = 40; firstLp.height = 30; secondLp.width = 60; secondLp.height = 20;
    first.lp = firstLp; second.lp = secondLp;
    for (const child of [first, second]) { child.parent = grid; grid.children.push(child); }
    await vcall(grid, "onMeasure", "(II)V", makeSpec(100, MS_EXACTLY), makeSpec(30, MS_EXACTLY));
    await vcall(grid, "onLayout", "(ZIIII)V", 1, 0, 0, 100, 30);
    expect([first.left, first.top, first.right, first.bottom]).toEqual([0, 0, 40, 30]);
    expect([second.left, second.top, second.right, second.bottom]).toEqual([40, 0, 100, 20]);
  });

  test("GridLayout fill alignment sizes a child to its spanned cell", async () => {
    const grid = new (rt.link("android/widget/GridLayout").ctor as new () => JViewGroup)();
    await vcall(grid, "setColumnCount", "(I)V", 2);
    const ctor = rt.link("android/widget/GridLayout").ctor as { [key: string]: unknown };
    const makeGridSpec = ctor[mangleMethod("spec", "(IILandroid/widget/GridLayout$Alignment;F)Landroid/widget/GridLayout$Spec;")];
    const alignment = ctor[mangleStaticField("FILL")];
    const spec = await (makeGridSpec as (start: number, size: number, alignment: unknown, weight: number) => unknown)(0, 2, alignment, 1);
    const row = scall("android/widget/GridLayout", "spec", "(I)Landroid/widget/GridLayout$Spec;", 0);
    const child = new JView();
    const lp = await newObj("android/widget/GridLayout$LayoutParams", "(Landroid/widget/GridLayout$Spec;Landroid/widget/GridLayout$Spec;)V", row, spec);
    lp.width = 20; lp.height = 10; child.lp = lp; child.parent = grid; grid.children.push(child);
    await vcall(grid, "onMeasure", "(II)V", makeSpec(80, MS_EXACTLY), makeSpec(10, MS_EXACTLY));
    await vcall(grid, "onLayout", "(ZIIII)V", 1, 0, 0, 80, 10);
    expect(child.measuredW).toBe(80);
  });
});

describe("layout-measure-passes", () => {
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
      [onMeasure](w: number, h: number) { view.measuredW = resolveSize(width, w); view.measuredH = resolveSize(20, h); },
    });
    await add(frame, a, "FrameLayout", -1, 20);
    await add(frame, b, "FrameLayout", -1, 20);
    await measureView(frame, makeSpec(200, MS_AT_MOST), makeSpec(200, MS_AT_MOST));
    expect([frame.measuredW, a.measuredW, b.measuredW]).toEqual([80, 80, 80]);
  });

  test("container measurement preserves nested child size-state flags through the measure cache", async () => {
    for (const owner of ["FrameLayout", "LinearLayout", "GridLayout", "RelativeLayout"]) {
      const frame = rt.make("android/widget/FrameLayout");
      const child = rt.make("android/view/View");
      const middle = rt.make(`android/widget/${owner}`);
      await add(frame, middle, "FrameLayout", -2, -2);
      await add(middle, child, owner, -2, -2);
      Object.assign(child, { [onMeasure](w: number, h: number) {
        this.setMeasuredDimension(w & 0xffffff | 0x01000000, h & 0xffffff | 0x01000000);
      } });
      for (const size of [200, 100, 200]) {
        await measureView(frame, makeSpec(size, MS_AT_MOST), makeSpec(size, MS_AT_MOST));
        expect(await vcall(frame, "getMeasuredWidth", "()I")).toBe(size);
        expect(await vcall(frame, "getMeasuredWidthAndState", "()I")).toBe(size | 0x01000000);
        expect(await vcall(frame, "getMeasuredHeightAndState", "()I")).toBe(size | 0x01000000);
        expect(await vcall(frame, "getMeasuredState", "()I")).toBe(0x01000100);
      }
    }
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

  test("an unspecified negative spacer dimension preserves weighted child space", async () => {
    const column = rt.make("android/widget/LinearLayout");
    const content = rt.make("android/view/View"), spacer = rt.make("android/view/View");
    await vcall(column, "setOrientation", "(I)V", 1);
    const lp = await newObj("android/widget/LinearLayout$LayoutParams", "(IIF)V", -1, 0, 1);
    await vcall(column, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", content, lp);
    await add(column, spacer, "LinearLayout", -1, -147);
    await measureView(column, makeSpec(200, MS_EXACTLY), makeSpec(300, MS_EXACTLY));
    expect([content.measuredH, spacer.measuredH]).toEqual([300, 0]);
  });

  test("unchanged padding preserves measurement caches while changed padding remeasures", async () => {
    const view = rt.make("android/widget/FrameLayout");
    if (!(view instanceof JView)) throw new Error("Invalid view");
    let calls = 0;
    const base = rt.link("android/widget/FrameLayout").ctor.prototype[onMeasure];
    Object.assign(view, { [onMeasure](w: number, h: number) { calls++; return base.call(this, w, h); } });
    const spec = makeSpec(100, MS_EXACTLY);
    await vcall(view, "setPadding", "(IIII)V", 1, 2, 3, 4);
    await measureView(view, spec, spec);
    await layoutView(view, 0, 0, 100, 100);
    const measured = calls;
    for (let i = 0; i < 10; i++) {
      await vcall(view, "setPadding", "(IIII)V", 1, 2, 3, 4);
      await measureView(view, spec, spec);
    }
    expect(calls).toBe(measured);
    await vcall(view, "setPadding", "(IIII)V", 1, 2, 3, 5);
    await measureView(view, spec, spec);
    expect(calls).toBe(measured + 1);
  });
});

describe("linear-dividers", () => {
  class Divider extends JDrawable {
    drawn: number[][] = [];
    size() { return 2; }
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
});

describe("linear-layout-baseline", () => {
  rt.linkNatives();

  test("LinearLayout retains a valid baseline child index", async () => {
    const layout = new JLinearLayout();
    layout.children.push(new JView(), new JView());
    expect(await vcall(layout, "getBaselineAlignedChildIndex", "()I")).toBe(-1);
    await vcall(layout, "setBaselineAlignedChildIndex", "(I)V", 1);
    expect(await vcall(layout, "getBaselineAlignedChildIndex", "()I")).toBe(1);
  });

  test("LinearLayout rejects baseline indexes outside its current children", async () => {
    const layout = new JLinearLayout();
    layout.children.push(new JView());
    for (const index of [-1, 1]) {
      await expect(vcallAsync(layout, "setBaselineAlignedChildIndex", "(I)V", index)).rejects.toMatchObject({
        constructor: rt.link("java/lang/IllegalArgumentException").ctor,
      });
    }
    expect(await vcall(layout, "getBaselineAlignedChildIndex", "()I")).toBe(-1);
  });
});

describe("platform-construction", () => {
  rt.linkNatives();
  test("TextureView copies content transforms and resets them without changing its bounds", async () => {
    const view = rt.make("android/view/TextureView");
    const matrix = new JMatrix();
    matrix.m = [2, 0, 0, 3, 10, 20];
    await vcall(view, "setTransform", "(Landroid/graphics/Matrix;)V", matrix);
    matrix.m[4] = 100;
    const copy: JMatrix = await vcall(view, "getTransform", "(Landroid/graphics/Matrix;)Landroid/graphics/Matrix;", null);
    expect(copy.m).toEqual([2, 0, 0, 3, 10, 20]);
    copy.m[0] = 9;
    expect(await vcall(view, "getTransform", "(Landroid/graphics/Matrix;)Landroid/graphics/Matrix;", matrix)).toBe(matrix);
    expect(matrix.m[0]).toBe(2);
    expect(await vcall(view, "getWidth", "()I")).toBe(0);
    await vcall(view, "setTransform", "(Landroid/graphics/Matrix;)V", null);
    expect((await vcall(view, "getTransform", "(Landroid/graphics/Matrix;)Landroid/graphics/Matrix;", matrix)).m).toEqual([1, 0, 0, 1, 0, 0]);
  });
  test("FrameLayout declares its view constructors for reflection", () => {
    expect(classCtors(rt.link("android/widget/FrameLayout")).map(c => c.desc)).toEqual([
      "(Landroid/content/Context;)V", "(Landroid/content/Context;Landroid/util/AttributeSet;)V",
      "(Landroid/content/Context;Landroid/util/AttributeSet;I)V", "(Landroid/content/Context;Landroid/util/AttributeSet;II)V",
    ]);
  });
  test("RelativeLayout rules stay live across reads, updates and removal", async () => {
    const lp = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", 100, 100);
    const rules: Int32Array = await vcall(lp, "getRules", "()[I");
    expect(rules.length).toBe(22);
    await vcall(lp, "addRule", "(II)V", 3, 123);
    expect(rules[3]).toBe(123);
    rules[10] = -1;
    expect(await vcall(lp, "getRule", "(I)I", 10)).toBe(-1);
    await vcall(lp, "removeRule", "(I)V", 3);
    expect(rules[3]).toBe(0);
  });

  test("CompoundButton subclasses implement Checkable and preserve tint state", async () => {
    const button = rt.make("android/widget/RadioButton");
    expect(rt.iof(button, "android/widget/Checkable")).toBe(1);
    await vcall(button, "setChecked", "(Z)V", 1);
    expect(await vcall(button, "isChecked", "()Z")).toBe(1);
    const colors = await vcall(rt.link("android/content/res/ColorStateList").ctor, "valueOf", "(I)Landroid/content/res/ColorStateList;", 0xff123456 | 0);
    await vcall(button, "setButtonTintList", "(Landroid/content/res/ColorStateList;)V", colors);
    expect(await vcall(button, "getButtonTintList", "()Landroid/content/res/ColorStateList;")).toBe(colors);
    const indicator = rt.make("android/graphics/drawable/StateListDrawable");
    await vcall(button, "setButtonDrawable", "(Landroid/graphics/drawable/Drawable;)V", indicator);
    expect([...await vcall(indicator, "getState", "()[I")]).toContain(ST.checked);
    await vcall(button, "setChecked", "(Z)V", 0);
    expect([...await vcall(indicator, "getState", "()[I")]).not.toContain(ST.checked);
  });

  test("EGL10 returns configurations with their declared Java type", async () => {
    const egl = rt.make("javax/microedition/khronos/egl/EGL10"), configs = [null], count = new Int32Array(1);
    const display = await vcall(egl, "eglGetDisplay", "(Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLDisplay;", null);
    expect(await vcall(egl, "eglGetDisplay", "(Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLDisplay;", null)).toBe(display);
    expect(rt.iof(display, "javax/microedition/khronos/egl/EGLDisplay")).toBe(1);
    expect(await vcall(egl, "eglChooseConfig", "(Ljavax/microedition/khronos/egl/EGLDisplay;[I[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z", display, new Int32Array([0x3038]), configs, 1, count)).toBe(1);
    expect(count[0]).toBe(1);
    expect(rt.iof(configs[0], "javax/microedition/khronos/egl/EGLConfig")).toBe(1);
  });

  test("EGL11 rejects the no-display handle", async () => {
    const egl = rt.make("javax/microedition/khronos/egl/EGL11");
    const noDisplay = rt.link("javax/microedition/khronos/egl/EGL10").ctor[mangleStaticField("EGL_NO_DISPLAY")];
    const configs = [null], count = new Int32Array([-1]);
    expect(await vcall(egl, "eglChooseConfig", "(Ljavax/microedition/khronos/egl/EGLDisplay;[I[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z", noDisplay, new Int32Array([0x3038]), configs, 1, count)).toBe(0);
    expect([configs[0], count[0]]).toEqual([null, -1]);
    expect(await vcall(egl, "eglGetError", "()I")).toBe(0x3008);
    expect(await vcall(egl, "eglSwapInterval", "(Ljavax/microedition/khronos/egl/EGLDisplay;I)Z", noDisplay, 0)).toBe(0);
    expect(await vcall(egl, "eglGetError", "()I")).toBe(0x3008);
  });

  test("EGL10 reports its no-context handle until a context is bound", async () => {
    const egl = rt.make("javax/microedition/khronos/egl/EGL10");
    const none = rt.link("javax/microedition/khronos/egl/EGL10").ctor[mangleStaticField("EGL_NO_CONTEXT")];
    const display = await vcall(egl, "eglGetDisplay", "(Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLDisplay;", null);
    expect(none).not.toBeNull();
    expect(rt.iof(none, "javax/microedition/khronos/egl/EGLContext")).toBe(1);
    expect(await vcall(egl, "eglGetCurrentContext", "()Ljavax/microedition/khronos/egl/EGLContext;")).toBe(none);
    expect(glSurfaces.current).toBeNull();
    expect(await vcall(egl, "eglMakeCurrent", "(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLContext;)Z", display, null, null, none)).toBe(1);
    expect(glSurfaces.current).toBeNull();
  });
});

describe("relativelayout-span", () => {
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

  test("a match-parent child right of an anchor ends at the parent edge", async () => {
    const layout = new (rt.link("android/widget/RelativeLayout").ctor as new () => JViewGroup)();
    const photo = new JView(); photo.idNum = 42;
    photo.lp = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", 96, 80);
    const text = new JView();
    text.lp = await newObj("android/widget/RelativeLayout$LayoutParams", "(II)V", MATCH_PARENT, 80);
    await vcall(text.lp, "addRule", "(II)V", RIGHT_OF, photo.idNum);
    for (const child of [photo, text]) { child.parent = layout; layout.children.push(child); }
    await vcall(layout, "onMeasure", "(II)V", makeSpec(360, MS_EXACTLY), makeSpec(80, MS_EXACTLY));
    await vcall(layout, "onLayout", "(ZIIII)V", 1, 0, 0, 360, 80);
    expect([text.left, text.right, text.measuredW]).toEqual([96, 360, 264]);
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
});

describe("scale-gesture", () => {
  class Listener extends JObj {
    begins = 0; ends = 0; accept = true;
    scales: { factor: number; delta: bigint; x: number; y: number }[] = [];
  }
  rt.register({ name: "test/ScaleContext", ctor: class extends JObj {}, sup: "android/content/Context", methods: {
    "getApplicationInfo()Landroid/content/pm/ApplicationInfo;": () => rt.make("android/content/pm/ApplicationInfo"),
  } });
  rt.register({ name: "test/ScaleListener", ctor: Listener, sup: "android/view/ScaleGestureDetector$SimpleOnScaleGestureListener", methods: {
    "onScaleBegin(Landroid/view/ScaleGestureDetector;)Z": function (this: Listener) { this.begins++; return 1; },
    "onScaleEnd(Landroid/view/ScaleGestureDetector;)V": function (this: Listener) { this.ends++; },
    "onScale(Landroid/view/ScaleGestureDetector;)Z": async function (this: Listener, detector: JObj) {
      this.scales.push({ factor: await vcall(detector, "getScaleFactor", "()F"), delta: await vcall(detector, "getTimeDelta", "()J"),
        x: await vcall(detector, "getFocusX", "()F"), y: await vcall(detector, "getFocusY", "()F") });
      return +this.accept;
    },
  } });
  rt.linkNatives();
  const touch = (detector: JObj, action: number, time: number, y = 100) =>
    vcall(detector, "onTouchEvent", "(Landroid/view/MotionEvent;)Z", obtainEvent(0n, BigInt(time), action, 100, y));
  async function create() {
    const listener = rt.make("test/ScaleListener") as Listener;
    const detector = await newObj("android/view/ScaleGestureDetector", "(Landroid/content/Context;Landroid/view/ScaleGestureDetector$OnScaleGestureListener;)V", rt.make("test/ScaleContext"), listener);
    await vcall(detector, "setQuickScaleEnabled", "(Z)V", 1);
    return { listener, detector };
  }

  test("scale detector keeps an ordinary single-pointer drag out of scaling", async () => {
    const { listener, detector } = await create();
    await touch(detector, 0, 0);
    await touch(detector, 2, 20, 300);
    await touch(detector, 1, 40, 300);
    expect(listener.begins).toBe(0);
    expect(listener.scales).toEqual([]);
    expect(await vcall(detector, "isInProgress", "()Z")).toBe(0);
  });

  test("double-tap scaling anchors focus and retains the last accepted span", async () => {
    const { listener, detector } = await create();
    await touch(detector, 0, 0);
    await touch(detector, 1, 20);
    await touch(detector, 0, 100);
    await touch(detector, 2, 150, 200);
    expect(listener.begins).toBe(1);
    expect(listener.scales[0]).toEqual({ factor: 1, delta: 0n, x: 100, y: 100 });
    listener.accept = false;
    await touch(detector, 2, 200, 300);
    expect(listener.scales[1]).toEqual({ factor: 1.5, delta: 50n, x: 100, y: 100 });
    listener.accept = true;
    await touch(detector, 2, 220, 250);
    expect(listener.scales[2]).toEqual({ factor: 1.25, delta: 70n, x: 100, y: 100 });
    await touch(detector, 1, 240, 250);
    expect(listener.ends).toBe(1);
    expect(await vcall(detector, "isInProgress", "()Z")).toBe(0);
  });
});

describe("scroller-completion", () => {
  rt.linkNatives();
  test("a delayed first scroll tick exposes the final offset once before reporting completion", async () => {
    let now = 1000;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      for (const cls of ["Scroller", "OverScroller"]) {
        const scroller = rt.make("android/widget/" + cls);
        await vcall(scroller, "startScroll", "(IIIII)V", 10, 20, 30, 40, 150);
        now += 300;
        expect(await vcall(scroller, "computeScrollOffset", "()Z")).toBe(1);
        expect(await vcall(scroller, "getCurrY", "()I")).toBe(60);
        expect(await vcall(scroller, "isFinished", "()Z")).toBe(1);
        expect(await vcall(scroller, "computeScrollOffset", "()Z")).toBe(0);
        await vcall(scroller, "startScroll", "(IIII)V", 10, 20, 0, 0);
        expect(await vcall(scroller, "isFinished", "()Z")).toBe(0);
      }
    } finally { clock.mockRestore(); }
  });

  test("OverScroller overfling passes the bound and springs back", async () => {
    let now = 1000;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      const scroller = rt.make("android/widget/OverScroller");
      await vcall(scroller, "fling", "(IIIIIIIIII)V", 0, 90, 0, 1000, 0, 0, 0, 100, 0, 20);
      const duration = await vcall(scroller, "getDuration", "()I") as number;
      now += Math.round(duration * 0.7);
      expect(await vcall(scroller, "computeScrollOffset", "()Z")).toBe(1);
      expect(await vcall(scroller, "getCurrY", "()I")).toBe(120);
      now += duration;
      expect(await vcall(scroller, "computeScrollOffset", "()Z")).toBe(1);
      expect(await vcall(scroller, "getCurrY", "()I")).toBe(100);
      expect(await vcall(scroller, "isFinished", "()Z")).toBe(1);
    } finally { clock.mockRestore(); }
  });
});

describe("space", () => {
  rt.linkNatives();
  test("Space constructors initialize an invisible spacer whose wrap size respects its minimum", async () => {
    for (const desc of ["(Landroid/content/Context;)V", "(Landroid/content/Context;Landroid/util/AttributeSet;)V"]) {
      const space = await newObj("android/widget/Space", desc, null, null) as JView;
      expect(space.visibility).toBe(4);
      space.minW = 10; space.minH = 20;
      await vcall(space, "onMeasure", "(II)V", makeSpec(100, MS_AT_MOST), makeSpec(80, MS_EXACTLY));
      expect([space.measuredW, space.measuredH]).toEqual([10, 80]);
    }
  });
});

describe("surface-display-list", () => {
  test("a recorded SurfaceView picks up its first frame after recording", async () => {
    const view = await newObj("android/view/SurfaceView", "(Landroid/content/Context;)V", null);
    view.right = 320;
    view.bottom = 180;
    const ops: DisplayList = [];
    const images: unknown[] = [];
    const target = new Proxy({
      drawImage: (image: unknown) => images.push(image),
    }, { get: (object, key) => key in object ? object[key as keyof typeof object] : () => {} }) as unknown as CanvasRenderingContext2D;

    await drawView(view, JCanvas.wrap(recordingContext(target, ops), 320, 180));
    expect(images).toHaveLength(0);

    const firstFrame = {} as VideoFrame;
    view.surfaceLayer = firstFrame;
    replay(target, ops);
    expect(images).toEqual([firstFrame]);
  });

  test("a SurfaceView subclass gets a surface when its onLayout skips the base method", async () => {
    const view = await newObj("android/view/SurfaceView", "(Landroid/content/Context;)V", null);
    view.attached = true;
    view[mangleMethod("onLayout", "(ZIIII)V")] = () => {};
    await layoutView(view, 0, 0, 320, 180);

    rt.link("android/view/SurfaceHolder");
    const holder = await vcall(view, "getHolder", "()Landroid/view/SurfaceHolder;");
    const surface = await vcall(holder, "getSurface", "()Landroid/view/Surface;");
    expect(surface.surf?.view).toBe(view);
    expect(surface.surf?.width).toBe(320);
    expect(surface.surf?.height).toBe(180);
  });
});

describe("tabhost", () => {
  const changes: string[] = [];
  class Factory extends JObj { made: unknown[] = []; }
  rt.register({ name: "test/TabFactory", ctor: Factory, ifaces: ["android/widget/TabHost$TabContentFactory"], methods: {
    "createTabContent(Ljava/lang/String;)Landroid/view/View;": async function (this: Factory, tag: string) {
      const v = await newObj("android/view/View", "(Landroid/content/Context;)V", ctx());
      await vcall(v, "setTag", "(Ljava/lang/Object;)V", tag);
      this.made.push(v);
      return v;
    } } });
  rt.register({ name: "test/TabListener", ctor: class extends JObj {}, ifaces: ["android/widget/TabHost$OnTabChangeListener"], methods: {
    "onTabChanged(Ljava/lang/String;)V": (tag: string) => { changes.push(tag); } } });
  rt.linkNatives();

  let context: unknown;
  function ctx(): unknown {
    if (context) return context;
    const c = rt.make("android/content/ContextWrapper") as JObj & { $host: unknown };
    const res = new Resources(null, {}), theme = new JTheme(); theme.res = res;
    c.$host = { res, theme, pkg: "test" };
    return context = c;
  }

  test("TabHost finds its widget and content by the android ids, swaps content and reports tab changes", async () => {
    const host = await newObj("android/widget/TabHost", "(Landroid/content/Context;)V", ctx());
    const column = await newObj("android/widget/LinearLayout", "(Landroid/content/Context;)V", ctx());
    const tabs = await newObj("android/widget/TabWidget", "(Landroid/content/Context;)V", ctx());
    const content = await newObj("android/widget/FrameLayout", "(Landroid/content/Context;)V", ctx());
    await vcall(tabs, "setId", "(I)V", 0x01020013);
    await vcall(content, "setId", "(I)V", 0x01020011);
    await vcall(column, "addView", "(Landroid/view/View;)V", tabs);
    await vcall(column, "addView", "(Landroid/view/View;)V", content);
    await vcall(host, "addView", "(Landroid/view/View;)V", column);
    await vcall(host, "setup", "()V");
    await vcall(host, "setOnTabChangedListener", "(Landroid/widget/TabHost$OnTabChangeListener;)V", rt.make("test/TabListener"));
    const factory = rt.make("test/TabFactory") as Factory;
    for (const tag of ["a", "b"]) {
      const spec = await vcall(host, "newTabSpec", "(Ljava/lang/String;)Landroid/widget/TabHost$TabSpec;", tag);
      await vcall(spec, "setIndicator", "(Landroid/view/View;)Landroid/widget/TabHost$TabSpec;", await newObj("android/view/View", "(Landroid/content/Context;)V", ctx()));
      await vcall(spec, "setContent", "(Landroid/widget/TabHost$TabContentFactory;)Landroid/widget/TabHost$TabSpec;", factory);
      await vcall(host, "addTab", "(Landroid/widget/TabHost$TabSpec;)V", spec);
    }
    expect(await vcall(host, "getCurrentTab", "()I")).toBe(0);
    expect(await vcall(host, "getCurrentTabTag", "()Ljava/lang/String;")).toBe("a");
    expect(changes).toEqual(["a"]);
    expect(await vcall(tabs, "getTabCount", "()I")).toBe(2);
    expect(factory.made.length).toBe(1);
    await vcall(host, "setCurrentTabByTag", "(Ljava/lang/String;)V", "b");
    expect(changes).toEqual(["a", "b"]);
    expect(factory.made.length).toBe(2);
    expect(await vcall(factory.made[0], "getVisibility", "()I")).toBe(8);
    expect(await vcall(factory.made[1], "getVisibility", "()I")).toBe(0);
    expect(await vcall(content, "getChildCount", "()I")).toBe(2);
    expect((await vcall(tabs, "getChildTabViewAt", "(I)Landroid/view/View;", 1)).selected).toBe(true);
    await vcall(await vcall(tabs, "getChildTabViewAt", "(I)Landroid/view/View;", 0), "performClick", "()Z");
    expect(await vcall(host, "getCurrentTab", "()I")).toBe(0);
    expect(changes).toEqual(["a", "b", "a"]);
    const bad = await newObj("android/widget/TabHost", "(Landroid/content/Context;)V", ctx());
    await expect(vcallAsync(bad, "setup", "()V")).rejects.toMatchObject({ constructor: rt.link("java/lang/RuntimeException").ctor });
  });
});

describe("table-columns", () => {
  rt.linkNatives();
  test("table column shrinking and stretching keep rows aligned and can be disabled", async () => {
    const table = rt.make("android/widget/TableLayout") as JView;
    const rows: JView[][] = [];
    for (const widths of [[120, 80], [100, 60]]) {
      const row = rt.make("android/widget/TableRow");
      const cells: JView[] = [];
      for (const width of widths) {
        const cell = rt.make("android/view/View") as JView;
        await vcall(cell, "setMinimumWidth", "(I)V", width);
        const lp = await newObj("android/widget/TableRow$LayoutParams", "(II)V", -2, 20);
        await vcall(row, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", cell, lp);
        cells.push(cell);
      }
      const lp = await newObj("android/widget/TableLayout$LayoutParams", "(II)V", -1, -2);
      await vcall(table, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", row, lp);
      rows.push(cells);
    }
    const widths = () => rows.map(row => row.map(cell => cell.measuredW));
    const measure = async (width: number) => {
      await vcall(table, "requestLayout", "()V");
      await measureView(table, makeSpec(width, MS_EXACTLY), makeSpec(0, MS_UNSPEC));
    };
    await vcall(table, "setColumnShrinkable", "(IZ)V", 0, 1);
    await measure(160);
    expect(widths()).toEqual([[80, 80], [80, 80]]);
    await vcall(table, "setColumnShrinkable", "(IZ)V", 0, 0);
    await measure(160);
    expect(widths()).toEqual([[120, 80], [120, 80]]);
    await vcall(table, "setColumnStretchable", "(IZ)V", 1, 1);
    await measure(240);
    expect(widths()).toEqual([[120, 120], [120, 120]]);
    await vcall(table, "setColumnStretchable", "(IZ)V", 1, 0);
    await measure(240);
    expect(widths()).toEqual([[120, 80], [120, 80]]);
  });
});

describe("touch-delegate", () => {
  class Target extends JView { events: number[][] = []; }
  rt.register({ name: "test/TouchTarget", ctor: Target, sup: "android/view/View", methods: {
    "dispatchTouchEvent(Landroid/view/MotionEvent;)Z": function (this: Target, e: JMotionEvent) { this.events.push([e.action, e.x, e.y]); return 1; },
  } });
  rt.linkNatives();
  test("a non-clickable host forwards a captured gesture and cancels outside the slop bounds", async () => {
    const target = rt.make("test/TouchTarget") as Target; target.right = 40; target.bottom = 20;
    const host = rt.make("android/view/View");
    const bounds = Object.assign(new JRect(), { left: 10, top: 10, right: 100, bottom: 100 });
    const delegate = await newObj("android/view/TouchDelegate", "(Landroid/graphics/Rect;Landroid/view/View;)V", bounds, target);
    await vcall(host, "setTouchDelegate", "(Landroid/view/TouchDelegate;)V", delegate);
    expect(await vcall(host, "getTouchDelegate", "()Landroid/view/TouchDelegate;")).toBe(delegate);
    const event = async (action: number, x: number, y: number) => vcall(host, "onTouchEvent", "(Landroid/view/MotionEvent;)Z", Object.assign(new JMotionEvent(), { action, x, y }));
    expect(await event(0, 0, 0)).toBe(0);
    expect(await event(0, 15, 15)).toBe(1);
    await event(2, 1000, 1000); await event(3, 1000, 1000);
    expect(await event(2, 15, 15)).toBe(0);
    expect(target.events).toEqual([[0, 20, 10], [2, -2 * device.touchSlop, -2 * device.touchSlop], [3, 20, 10]]);
  });
});

describe("transient-placeholder", () => {
  rt.linkNatives();

  let context: unknown;
  function ctx(): unknown {
    if (context) return context;
    const wrapper = rt.make("android/content/ContextWrapper") as JObj & { $host: unknown };
    const resources = new Resources(null, {});
    const theme = new JTheme();
    theme.res = resources;
    wrapper.$host = { res: resources, theme, pkg: "test" };
    return context = wrapper;
  }

  test("addView lets a transient-state query replace a lazy placeholder", async () => {
    let queried = false;
    const addedAfterQuery: boolean[] = [];
    rt.register({
      name: "test/Parent",
      ctor: class extends (rt.link("android/widget/FrameLayout").ctor as typeof JObj) {},
      sup: "android/widget/FrameLayout",
      methods: {
        "onViewAdded(Landroid/view/View;)V": function () {
          addedAfterQuery.push(queried);
        },
      },
    });
    rt.register({
      name: "test/Placeholder",
      ctor: class extends (rt.link("android/view/View").ctor as typeof JObj) {},
      sup: "android/view/View",
      methods: {
        "hasTransientState()Z": async function (this: JView & { real?: unknown }) {
          queried = true;
          const parent = this.parent as JView | null;
          if (parent && !this.real) {
            this.real = true;
            const real = await newObj("android/widget/FrameLayout", "(Landroid/content/Context;)V", ctx());
            await vcall(real, "setId", "(I)V", 0x7f0a0001);
            const index = await vcall(parent, "indexOfChild", "(Landroid/view/View;)I", this);
            await vcall(parent, "removeViewInLayout", "(Landroid/view/View;)V", this);
            await vcall(parent, "addView", "(Landroid/view/View;I)V", real, index);
            this.real = real;
          }
          return 0;
        },
      },
    });
    const parent = await newObj("test/Parent", "(Landroid/content/Context;)V", ctx());
    const placeholder = await newObj("test/Placeholder", "(Landroid/content/Context;)V", ctx());
    await vcall(placeholder, "setId", "(I)V", 0x7f0a0001);
    await vcall(parent, "addView", "(Landroid/view/View;)V", placeholder);
    const found = await vcall(parent, "findViewById", "(I)Landroid/view/View;", 0x7f0a0001);
    expect(rt.iof(found, "android/widget/FrameLayout")).toBeTruthy();
    expect(await vcall(parent, "getChildCount", "()I")).toBe(1);
    expect(addedAfterQuery.length).toBeGreaterThan(0);
    expect(addedAfterQuery.every(Boolean)).toBe(true);
  });

  test("a view group's transient-state count follows child removal", async () => {
    const parent = await newObj("android/widget/FrameLayout", "(Landroid/content/Context;)V", ctx());
    const child = await newObj("android/view/View", "(Landroid/content/Context;)V", ctx());
    await vcall(child, "setHasTransientState", "(Z)V", 1);
    await vcall(parent, "addView", "(Landroid/view/View;)V", child);
    expect(await vcall(parent, "hasTransientState", "()Z")).toBe(1);
    await vcall(parent, "removeView", "(Landroid/view/View;)V", child);
    expect(await vcall(parent, "hasTransientState", "()Z")).toBe(0);
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

describe("view-attachment-order", () => {
  rt.linkNatives();
  test("View.post waits for attachment and removeCallbacks cancels unattached work", async () => {
    const view = rt.make("android/view/View") as JView;
    const calls: string[] = [];
    const run = { [mangleMethod("run", "()V")]: () => calls.push("posted") };
    const canceled = { [mangleMethod("run", "()V")]: () => calls.push("canceled") };
    await vcall(view, "post", "(Ljava/lang/Runnable;)Z", run);
    await vcall(view, "post", "(Ljava/lang/Runnable;)Z", canceled);
    await vcall(view, "removeCallbacks", "(Ljava/lang/Runnable;)Z", canceled);
    await onMain(() => expect(calls).toEqual([]));
    await dispatchAttached(view);
    await onMain(() => expect(calls).toEqual(["posted"]));
  });
  test("detachment retains attachment and thread identity through child and listener callbacks", async () => {
    const parent = await newObj("android/widget/FrameLayout", "(Landroid/content/Context;)V", null);
    const child = await newObj("android/view/View", "(Landroid/content/Context;)V", null);
    if (!(parent instanceof JView) || !(child instanceof JView)) throw new Error("Invalid view delegates");
    await vcall(parent, "addView", "(Landroid/view/View;)V", child);
    await dispatchAttached(parent);
    const thread = new JThread();
    const events: string[] = [];
    for (const [name, view] of [["child", child], ["parent", parent]] as const) {
      Object.assign(view, {
        [mangleMethod("onDetachedFromWindow", "()V")]: async () => {
          expect(curThread).toBe(thread);
          expect(view.attached).toBe(true);
          expect(parent.attached).toBe(true);
          events.push(name);
          await Promise.resolve();
        },
      });
      await vcall(view, "addOnAttachStateChangeListener", "(Landroid/view/View$OnAttachStateChangeListener;)V", {
        [mangleMethod("onViewDetachedFromWindow", "(Landroid/view/View;)V")]: () => {
          expect(curThread).toBe(thread);
          expect(view.attached).toBe(true);
          events.push(`${name} listener`);
        },
      });
    }
    await dispatchDetached(parent, thread);
    expect(events).toEqual(["child", "child listener", "parent", "parent listener"]);
    expect(parent.attached).toBe(false);
    expect(child.attached).toBe(false);
    expect(curThread).toBe(mainThread);
  });
  test("attachment callbacks retain their dispatch thread across suspension", async () => {
    const view = rt.make("android/view/View");
    if (!(view instanceof JView)) throw new Error("Invalid view delegate");
    const thread = new JThread();
    const observed: JThread[] = [];
    Object.assign(view, {
      [mangleMethod("onAttachedToWindow", "()V")]: async () => {
        observed.push(curThread);
        await Promise.resolve();
      },
    });
    await vcall(view, "addOnAttachStateChangeListener", "(Landroid/view/View$OnAttachStateChangeListener;)V", {
      [mangleMethod("onViewAttachedToWindow", "(Landroid/view/View;)V")]: () => { observed.push(curThread); },
    });
    setCurThread(thread);
    const attached = dispatchAttached(view);
    setCurThread(mainThread);
    try {
      await attached;
      expect(observed).toEqual([thread, thread]);
      expect(curThread).toBe(mainThread);
    } finally { setCurThread(mainThread); }
  });
  for (const inLayout of [false, true]) test(`${inLayout ? "addViewInLayout" : "addView"} awaits attachment before returning`, async () => {
    const parent = rt.make("android/widget/FrameLayout");
    const child = rt.make("android/view/View");
    if (!(parent instanceof JView) || !(child instanceof JView)) throw new Error("Invalid view delegates");
    const events: string[] = [];
    Object.assign(child, {
      [mangleMethod("onAttachedToWindow", "()V")]: async () => {
        await Promise.resolve();
        expect(child.parent).toBe(parent);
        events.push("attached");
      },
    });
    Object.assign(parent, {
      [mangleMethod("onViewAdded", "(Landroid/view/View;)V")]: async () => {
        await Promise.resolve();
        events.push("added");
      },
    });
    await vcall(parent, "setOnHierarchyChangeListener", "(Landroid/view/ViewGroup$OnHierarchyChangeListener;)V", {
      [mangleMethod("onChildViewAdded", "(Landroid/view/View;Landroid/view/View;)V")]: async () => {
        await Promise.resolve();
        events.push("listener");
      },
    });
    await onMain(async () => {
      await dispatchAttached(parent);
      const lp = await newObj("android/widget/FrameLayout$LayoutParams", "(II)V", 100, 100);
      if (inLayout) await vcall(parent, "addViewInLayout", "(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)Z", child, -1, lp);
      else await vcall(parent, "addView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V", child, lp);
      expect(child.attached).toBe(true);
      expect(events).toEqual(["attached", "added", "listener"]);
    });
    await onMain(() => expect(events).toEqual(["attached", "added", "listener"]));
  });

  for (const [method, desc, args] of [
    ["removeView", "(Landroid/view/View;)V", "child"],
    ["removeViewInLayout", "(Landroid/view/View;)V", "child"],
    ["removeViewAt", "(I)V", "index"],
    ["removeViews", "(II)V", "range"],
    ["removeViewsInLayout", "(II)V", "range"],
    ["removeAllViews", "()V", "all"],
    ["removeAllViewsInLayout", "()V", "all"],
  ] as const) test(`${method} completes detachment before the child is re-added`, async () => {
    const parent = rt.make("android/widget/FrameLayout"), child = rt.make("android/view/View");
    if (!(parent instanceof JView) || !(child instanceof JView)) throw new Error("Invalid view delegates");
    const events: string[] = [];
    Object.assign(child, {
      [mangleMethod("onDetachedFromWindow", "()V")]: async () => {
        expect(child.parent).toBe(parent);
        expect(child.attached).toBe(true);
        await Promise.resolve();
        events.push("detached");
      },
    });
    Object.assign(parent, {
      [mangleMethod("onViewRemoved", "(Landroid/view/View;)V")]: async () => {
        expect(child.parent).toBe(args === "range" || args === "all" ? parent : null);
        expect(child.attached).toBe(false);
        await Promise.resolve();
        events.push("removed");
      },
    });
    await vcall(parent, "setOnHierarchyChangeListener", "(Landroid/view/ViewGroup$OnHierarchyChangeListener;)V", {
      [mangleMethod("onChildViewAdded", "(Landroid/view/View;Landroid/view/View;)V")]: () => {},
      [mangleMethod("onChildViewRemoved", "(Landroid/view/View;Landroid/view/View;)V")]: async () => {
        await Promise.resolve();
        events.push("listener");
      },
    });
    await onMain(async () => {
      await dispatchAttached(parent);
      await vcall(parent, "addView", "(Landroid/view/View;)V", child);
      await vcall(parent, method, desc, ...(args === "child" ? [child] : args === "index" ? [0] : args === "range" ? [0, 1] : []));
      expect(events).toEqual(["detached", "removed", "listener"]);
      await vcall(parent, "addView", "(Landroid/view/View;)V", child);
    });
    await onMain(() => expect(child.attached).toBe(true));
  });

  test("removeDetachedView finishes window removal after temporary parent detachment", async () => {
    const parent = rt.make("android/widget/FrameLayout"), child = rt.make("android/view/View");
    if (!(parent instanceof JView) || !(child instanceof JView)) throw new Error("Invalid view delegates");
    await onMain(async () => {
      await dispatchAttached(parent);
      await vcall(parent, "addView", "(Landroid/view/View;)V", child);
      await vcall(parent, "detachViewFromParent", "(Landroid/view/View;)V", child);
      expect(child.attached).toBe(true);
      expect(child.parent).toBe(null);
      await vcall(parent, "removeDetachedView", "(Landroid/view/View;Z)V", child, 0);
      expect(child.attached).toBe(false);
      await vcall(parent, "addView", "(Landroid/view/View;)V", child);
    });
    await onMain(() => expect(child.attached).toBe(true));
  });


  test("native mutations finish the same lifecycle before Java reattachment", async () => {
    const parent = rt.make("android/widget/FrameLayout"), child = rt.make("android/view/View");
    const other = rt.make("android/widget/FrameLayout");
    if (!(parent instanceof JViewGroup) || !(other instanceof JViewGroup) || !(child instanceof JView)) throw new Error("Invalid view delegates");
    addUnattachedView(parent, child);
    const events: string[] = [];
    Object.assign(child, {
      [mangleMethod("onDetachedFromWindow", "()V")]: async () => { await Promise.resolve(); events.push("detach"); },
      [mangleMethod("onAttachedToWindow", "()V")]: async () => { await Promise.resolve(); events.push("attach"); },
    });
    await onMain(async () => {
      await dispatchAttached(parent); await dispatchAttached(other); events.length = 0;
      await detachView(parent, child);
      await vcall(parent, "addView", "(Landroid/view/View;)V", child);
      expect(events).toEqual(["detach", "attach"]);
      await attachView(other, child);
      expect(parent.children).toEqual([]);
      expect(other.children).toEqual([child]);
      expect(events).toEqual(["detach", "attach", "detach", "attach"]);
    });
    await onMain(() => { expect(child.attached).toBe(true); expect(child.parent).toBe(other); });
  });
});

describe("view-draw-state", () => {
  rt.linkNatives();

  test("view traversal exposes the child draw save to Android canvas code", async () => {
    let depth = 0;
    const context = {
      save() { depth++; },
      restore() { depth--; },
      translate() {},
      transform() {},
      beginPath() {},
      rect() {},
      clip() {},
    } as unknown as OffscreenCanvasRenderingContext2D;
    const canvas = JCanvas.wrap(context, 100, 100);
    class CustomView extends JView {
      observedSaveCount = 0;
      [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")](target: JCanvas) {
        this.observedSaveCount = target.saveCount;
      }
    }
    const view = new CustomView();
    view.right = view.bottom = 100;

    await drawView(view, canvas);

    expect(view.observedSaveCount).toBe(2);
    expect(canvas.saveCount).toBe(1);
    expect(depth).toBe(0);
  });

  test("view Z changes child paint order relative to elevation", async () => {
    const order: string[] = [];
    const context = { save() {}, restore() {}, translate() {}, beginPath() {}, rect() {}, clip() {} } as unknown as OffscreenCanvasRenderingContext2D;
    const canvas = JCanvas.wrap(context, 100, 100);
    class Child extends JView {
      constructor(readonly label: string) { super(); this.right = this.bottom = 100; }
      [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]() { order.push(this.label); }
    }
    const parent = new JViewGroup(); parent.right = parent.bottom = 100;
    const raised = new Child("raised"), lowered = new Child("lowered");
    parent.children.push(raised, lowered);
    await vcall(raised, "setElevation", "(F)V", 3);
    await vcall(lowered, "setElevation", "(F)V", 2);
    await vcall(lowered, "setZ", "(F)V", 1);
    expect(await vcall(lowered, "getTranslationZ", "()F")).toBe(-1);
    await vcall(parent, "dispatchDraw", "(Landroid/graphics/Canvas;)V", canvas);
    expect(order).toEqual(["lowered", "raised"]);
  });

  test("canvas root state rejects unmatched restores", () => {
    let restores = 0;
    const context = {
      restore() { restores++; },
    } as unknown as OffscreenCanvasRenderingContext2D;
    const canvas = JCanvas.wrap(context, 100, 100);
    const restore = canvasMethods!["restore()V"] as (this: JCanvas) => void;
    const restoreToCount = canvasMethods!["restoreToCount(I)V"] as (this: JCanvas, count: number) => void;

    expect(() => restore.call(canvas)).toThrow();
    expect(() => restoreToCount.call(canvas, 0)).toThrow();
    expect(canvas.saveCount).toBe(1);
    expect(restores).toBe(0);
  });

  test.each([
    ["fit-center", 3, 2],
    ["center-crop", 6, 2],
  ] as const)("image view retains its %s draw state until a suspending drawable completes", async (_name, scaleType, pendingDepth) => {
    rt.link("android/widget/ImageView");
    let depth = 0;
    const context = {
      save() { depth++; },
      restore() { depth--; },
      translate() {},
      transform() {},
      beginPath() {},
      rect() {},
      clip() {},
    } as unknown as OffscreenCanvasRenderingContext2D;
    const canvas = JCanvas.wrap(context, 100, 100);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let completed = false;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    class SuspendedDrawable extends JDrawable {
      [mangleMethod("getIntrinsicWidth", "()I")]() { return 20; }
      [mangleMethod("getIntrinsicHeight", "()I")]() { return 20; }
      async [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]() {
        started();
        await gate;
        completed = true;
      }
    }
    const view = new JImageView();
    await view.setDrawable(new SuspendedDrawable());
    view.scaleType = scaleType;
    view.right = view.bottom = 100;

    const drawing = drawView(view, canvas);
    await entered;
    expect(completed).toBeFalse();
    expect(depth).toBe(pendingDepth);

    release();
    await drawing;
    expect(completed).toBeTrue();
    expect(canvas.saveCount).toBe(1);
    expect(depth).toBe(0);
  });
});

describe("view-foreground", () => {
  rt.linkNatives();
  test("foreground drawing awaits bounds, retains its thread and resolves gravity", async () => {
    const view = rt.make("android/view/View"), drawable = rt.make("android/graphics/drawable/Drawable");
    if (!(view instanceof JView) || !(drawable instanceof JDrawable)) throw new Error("Invalid delegates");
    view.right = 80; view.bottom = 60;
    const seen: JThread[] = [], events: string[] = [];
    Object.assign(drawable, {
      [mangleMethod("getIntrinsicWidth", "()I")]: async () => { seen.push(curThread); await Promise.resolve(); return 20; },
      [mangleMethod("getIntrinsicHeight", "()I")]: () => { seen.push(curThread); return 10; },
      [mangleMethod("onBoundsChange", "(Landroid/graphics/Rect;)V")]: async () => { seen.push(curThread); await Promise.resolve(); events.push("bounds"); },
      [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]: () => { seen.push(curThread); events.push("draw"); },
    });
    await vcall(view, "setForeground", "(Landroid/graphics/drawable/Drawable;)V", drawable);
    expect(drawable.callback).toBe(view);
    const thread = new JThread();
    await vcallOn(thread, view, "onDrawForeground", "(Landroid/graphics/Canvas;)V", null);
    expect(drawable.bounds).toMatchObject({ left: 0, top: 0, right: 80, bottom: 60 });
    expect(events).toEqual(["bounds", "draw"]);
    await vcall(view, "setForegroundGravity", "(I)V", 17);
    await vcallOn(thread, view, "onDrawForeground", "(Landroid/graphics/Canvas;)V", null);
    expect(drawable.bounds).toMatchObject({ left: 30, top: 25, right: 50, bottom: 35 });
    events.length = 0;
    await vcallOn(thread, view, "onDrawForeground", "(Landroid/graphics/Canvas;)V", null);
    expect(events).toEqual(["draw"]);
    expect(seen.every(t => t === thread)).toBe(true);
    await vcall(view, "setForeground", "(Landroid/graphics/drawable/Drawable;)V", null);
    expect(drawable.callback).toBeNull();
  });
});

describe("view-layout-listeners", () => {
  rt.linkNatives();
  test("a required layout notifies listeners even when its bounds stay unchanged", async () => {
    const view = rt.make("android/view/View") as JView;
    const events: number[][] = [];
    const listener = {
      [mangleMethod("onLayoutChange", "(Landroid/view/View;IIIIIIII)V")]: async (_view: JView, ...bounds: number[]) => {
        await Promise.resolve();
        events.push(bounds);
      },
    };
    await vcall(view, "addOnLayoutChangeListener", "(Landroid/view/View$OnLayoutChangeListener;)V", listener);
    const exact = 0x40000000 | 100;
    await measureView(view, exact, exact);
    await layoutView(view, 0, 0, 100, 100);
    events.length = 0;
    await vcall(view, "requestLayout", "()V");
    await measureView(view, exact, exact);
    await layoutView(view, 0, 0, 100, 100);
    expect(events).toEqual([[0, 0, 100, 100, 0, 0, 100, 100]]);
    await layoutView(view, 0, 0, 100, 100);
    expect(events).toHaveLength(1);
  });
});

describe("view-measure-cache", () => {
  rt.linkNatives();

  class CountingView extends JView {
    measures = 0;

    [mangleMethod("onMeasure", "(II)V")](widthSpec: number, heightSpec: number) {
      this.measures++;
      this.measuredW = widthSpec & 0x3fffffff;
      this.measuredH = heightSpec & 0x3fffffff;
    }

    [mangleMethod("onLayout", "(ZIIII)V")]() {}
  }

  class CountingGroup extends JViewGroup {
    measures = 0;

    [mangleMethod("onMeasure", "(II)V")](widthSpec: number, heightSpec: number) {
      this.measures++;
      this.measuredW = widthSpec & 0x3fffffff;
      this.measuredH = heightSpec & 0x3fffffff;
    }
  }

  test("a fresh measure cache entry is reused while layout remains requested", async () => {
    const view = new CountingView();
    const widthSpec = makeSpec(320, MS_EXACTLY);
    const heightSpec = makeSpec(180, MS_EXACTLY);

    await measureView(view, widthSpec, heightSpec);
    await measureView(view, widthSpec, heightSpec);
    expect(view.measures).toBe(1);

    await layoutView(view, 0, 0, 320, 180);
    expect(view.measures).toBe(2);

    requestLayout(view);
    await measureView(view, widthSpec, heightSpec);
    expect(view.measures).toBe(3);
  });

  test("an in-layout hierarchy mutation invalidates the parent's measure cache", async () => {
    const view = new CountingGroup();
    const widthSpec = makeSpec(320, MS_EXACTLY);
    const heightSpec = makeSpec(180, MS_EXACTLY);

    await measureView(view, widthSpec, heightSpec);
    await attachView(view, new JView(), -1, false);
    await measureView(view, widthSpec, heightSpec);

    expect(view.measures).toBe(2);
  });

  test("a child request crosses a flagged parent and invalidates the root measure", async () => {
    class RequestingParent extends JViewGroup {
      requests = 0;
      [mangleMethod("requestLayout", "()V")]() { this.requests++; requestLayout(this); }
    }
    const root = new CountingGroup(), parent = new RequestingParent(), child = new JView();
    parent.parent = root;
    child.parent = parent;
    const spec = makeSpec(100, MS_EXACTLY);
    await measureView(root, spec, spec);
    root.layoutRequested = false;
    parent.layoutRequested = true;
    requestLayout(child);
    await measureView(root, spec, spec);
    expect(root.measures).toBe(2);
    expect(parent.requests).toBe(0);
  });

  test("a request cleared by layout is not replayed into another measure", async () => {
    class RequestingView extends CountingView {
      [mangleMethod("onLayout", "(ZIIII)V")]() { requestLayout(this); }
    }
    const view = new RequestingView();
    view.attached = true;
    const spec = makeSpec(100, MS_EXACTLY);
    await measureView(view, spec, spec);
    await layoutRoot(view, 0, 0, 100, 100);
    replayLayoutRequests();
    await measureView(view, spec, spec);
    expect(view.measures).toBe(1);
  });
});

describe("view-outline", () => {
  rt.linkNatives();
  test("view outline providers use background geometry, bounds and padded bounds", async () => {
    const view = rt.make("android/view/View"), outline = new JOutline();
    if (!(view instanceof JView)) throw new Error("Invalid view delegate");
    view.right = 40; view.bottom = 30;
    view.padL = 2; view.padT = 3; view.padR = 4; view.padB = 5;
    const cls = rt.link("android/view/ViewOutlineProvider").ctor;
    const provider = await vcall(view, "getOutlineProvider", "()Landroid/view/ViewOutlineProvider;");
    expect(provider).toBe(cls[mangleStaticField("BACKGROUND")]);
    const fill = (p: unknown) => vcall(p, "getOutline", "(Landroid/view/View;Landroid/graphics/Outline;)V", view, outline);
    await fill(provider);
    expect([outline.l, outline.t, outline.r, outline.b, outline.alpha]).toEqual([0, 0, 40, 30, 0]);
    const background = rt.make("android/graphics/drawable/Drawable");
    Object.assign(background, {
      [mangleMethod("getOutline", "(Landroid/graphics/Outline;)V")]: async (o: JOutline) => {
        await Promise.resolve();
        o.setRR(1, 2, 39, 28, 7);
      },
    });
    await vcall(view, "setBackground", "(Landroid/graphics/drawable/Drawable;)V", background);
    await fill(provider);
    expect([outline.l, outline.t, outline.r, outline.b, outline.rad]).toEqual([1, 2, 39, 28, 7]);
    const inset = await newObj("android/graphics/drawable/InsetDrawable", "(Landroid/graphics/drawable/Drawable;I)V", background, 3);
    await vcall(view, "setBackground", "(Landroid/graphics/drawable/Drawable;)V", inset);
    await fill(provider);
    expect([outline.l, outline.t, outline.r, outline.b, outline.rad]).toEqual([1, 2, 39, 28, 7]);
    await fill(cls[mangleStaticField("BOUNDS")]);
    expect([outline.l, outline.t, outline.r, outline.b]).toEqual([0, 0, 40, 30]);
    await fill(cls[mangleStaticField("PADDED_BOUNDS")]);
    expect([outline.l, outline.t, outline.r, outline.b]).toEqual([2, 3, 36, 25]);
    await vcall(view, "setOutlineProvider", "(Landroid/view/ViewOutlineProvider;)V", null);
    expect(await vcall(view, "getOutlineProvider", "()Landroid/view/ViewOutlineProvider;")).toBeNull();
    await vcall(view, "setClipToOutline", "(Z)V", 1);
    expect(await vcall(view, "getClipToOutline", "()Z")).toBe(1);
  });
});

describe("viewgroup-hierarchy", () => {
  class Group extends JViewGroup { events: string[] = []; }
  class Listener extends JObj {}
  rt.register({ name: "test/HierarchyGroup", ctor: Group, sup: "android/view/ViewGroup", methods: {
    "onViewAdded(Landroid/view/View;)V": async function (this: Group, child: JView) {
      expect(child.parent).toBe(this);
      await Promise.resolve();
      this.events.push(`added:${child.idNum}`);
    },
    "onViewRemoved(Landroid/view/View;)V": async function (this: Group, child: JView) {
      expect(this.children).not.toContain(child);
      await Promise.resolve();
      this.events.push(`removed:${child.idNum}`);
    },
  } });
  rt.register({ name: "test/HierarchyListener", ctor: Listener, ifaces: ["android/view/ViewGroup$OnHierarchyChangeListener"], methods: {
    "onChildViewAdded(Landroid/view/View;Landroid/view/View;)V": (parent: Group, child: JView) => { parent.events.push(`listener-added:${child.idNum}`); },
    "onChildViewRemoved(Landroid/view/View;Landroid/view/View;)V": (parent: Group, child: JView) => { parent.events.push(`listener-removed:${child.idNum}`); },
  } });
  rt.linkNatives();

  test("view mutations await overrides before hierarchy listeners, including in-layout additions and range removal", async () => {
    const parent = new Group(); parent.hierarchyChangeL = new Listener();
    const first = new JView(), second = new JView(); first.idNum = 1; second.idNum = 2;
    await vcall(parent, "addView", "(Landroid/view/View;)V", first);
    await vcall(parent, "addViewInLayout", "(Landroid/view/View;ILandroid/view/ViewGroup$LayoutParams;)Z", second, -1, new JLayoutParams());
    await vcall(parent, "removeAllViews", "()V");
    expect(parent.events).toEqual(["added:1", "listener-added:1", "added:2", "listener-added:2", "removed:2", "listener-removed:2", "removed:1", "listener-removed:1"]);
    expect(parent.children).toEqual([]);
  });

  test("native view mutations complete with default callbacks", async () => {
    const parent = new JViewGroup(), child = new JView();
    await attachView(parent, child);
    expect(child.parent).toBe(parent);
    await detachView(parent, child);
    expect(child.parent).toBeNull();
  });

  test("target R dispatches insets independently to siblings, including gone views", async () => {
    const parent = new JViewGroup(), first = new JView(), second = new JView();
    first.fitsSys = second.fitsSys = true;
    second.visibility = 8;
    await attachView(parent, first);
    await attachView(parent, second);
    const insets = new JWindowInsets();
    insets.ins[0] = { left: 0, top: 72, right: 0, bottom: 0 };
    try {
      setViewTargetSdk(29);
      await vcall(parent, "dispatchApplyWindowInsets", "(Landroid/view/WindowInsets;)Landroid/view/WindowInsets;", insets);
      expect([first.padT, second.padT]).toEqual([72, 0]);
      setViewTargetSdk(30);
      const result = await vcall(parent, "dispatchApplyWindowInsets", "(Landroid/view/WindowInsets;)Landroid/view/WindowInsets;", insets);
      expect([first.padT, second.padT]).toEqual([72, 72]);
      expect(result).toBe(insets);
      parent.fitsSys = parent.attached = true;
      await vcall(parent, "makeOptionalFitsSystemWindows", "()V");
      first.padT = second.padT = 0;
      await vcall(parent, "dispatchApplyWindowInsets", "(Landroid/view/WindowInsets;)Landroid/view/WindowInsets;", insets);
      expect([parent.padT, first.padT, second.padT]).toEqual([0, 72, 72]);
    } finally { setViewTargetSdk(35); }
  });
});

describe("viewgroup-touch", () => {
  rt.linkNatives();
  const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);
  const event = (action: number, x: number, y: number) => scall("android/view/MotionEvent", "obtain", "(JJIFFI)Landroid/view/MotionEvent;", 0n, 0n, action, x, y, 0);
  const tap = async (v: JView, x: number, y: number) => {
    await vcall(v, "dispatchTouchEvent", "(Landroid/view/MotionEvent;)Z", event(0, x, y));
    await vcall(v, "dispatchTouchEvent", "(Landroid/view/MotionEvent;)Z", event(1, x, y));
  };
  class TouchListener extends JObj { seen = 0; [mangleMethod("onTouch", "(Landroid/view/View;Landroid/view/MotionEvent;)Z")]() { this.seen++; return 1; } }
  class ClickListener extends JObj { clicks = 0; [mangleMethod("onClick", "(Landroid/view/View;)V")]() { this.clicks++; } }

  test("Activity delivers unhandled window touches to its virtual onTouchEvent", async () => {
    const seen: number[] = [];
    class Activity extends JActivity {
      [mangleMethod("onUserInteraction", "()V")]() { seen.push(-1); }
      [mangleMethod("onTouchEvent", "(Landroid/view/MotionEvent;)Z")](event: JMotionEvent) { seen.push(event.action); return 1; }
    }
    const activity = new Activity(), decor = new JFrameLayout();
    activity.window.decor = decor; decor.right = 200; decor.bottom = 200;
    for (const action of [0, 2, 1]) expect(await vcall(activity, "dispatchTouchEvent", "(Landroid/view/MotionEvent;)Z", event(action, 50, 50))).toBe(1);
    expect(seen).toEqual([-1, 0, 2, 1]);
    seen.length = 0;
    const child = new JView(); child.right = 100; child.bottom = 100; child.clickable = true;
    child.parent = decor; decor.children.push(child);
    await vcall(activity, "dispatchTouchEvent", "(Landroid/view/MotionEvent;)Z", event(0, 50, 50));
    expect(seen).toEqual([-1]);
  });

  test("ViewGroup dispatches hierarchy callbacks after updating the parent link", async () => {
    const events: string[] = [];
    class Group extends JViewGroup {
      [mangleMethod("onViewAdded", "(Landroid/view/View;)V")](child: JView) {
        expect(child.parent).toBe(this);
        events.push("added");
      }
      [mangleMethod("onViewRemoved", "(Landroid/view/View;)V")](child: JView) {
        expect(child.parent).toBeNull();
        events.push("removed");
      }
    }
    class Listener extends JObj {
      [mangleMethod("onChildViewAdded", "(Landroid/view/View;Landroid/view/View;)V")]() { events.push("listener-added"); }
      [mangleMethod("onChildViewRemoved", "(Landroid/view/View;Landroid/view/View;)V")]() { events.push("listener-removed"); }
    }
    const group = new Group(), child = new JView();
    group.hierarchyChangeL = new Listener();

    await attachView(group, child, -1, false);
    await detachView(group, child, false);

    expect(events).toEqual(["added", "listener-added", "removed", "listener-removed"]);
  });

  test("a ViewGroup's OnTouchListener sees only touches no child took", async () => {
    const group = new JViewGroup(); group.right = 200; group.bottom = 200;
    const child = new JView(); child.right = 100; child.bottom = 100; child.clickable = true;
    child.parent = group; group.children.push(child);
    const swallow = new TouchListener(), click = new ClickListener();
    group.touchL = swallow; child.clickL = click;
    await tap(group, 50, 50);
    expect(click.clicks).toBe(1);
    expect(swallow.seen).toBe(0);
    await tap(group, 150, 150);
    expect(click.clicks).toBe(1);
    expect(swallow.seen).toBe(2);
  });
});

describe("webfragment", () => {
  class FragmentClient extends JObj {
    events: unknown[][] = [];
    visited: (() => void | Promise<void>) | null = null;
  }
  rt.register({
    name: "test/FragmentClient", ctor: FragmentClient, sup: "android/webkit/WebViewClient",
    methods: {
      "doUpdateVisitedHistory(Landroid/webkit/WebView;Ljava/lang/String;Z)V": async function (this: FragmentClient, view: JWebView, url: string, reload: number) {
        this.events.push(["visited", url, reload, view.url]); await this.visited?.();
      },
      "onPageFinished(Landroid/webkit/WebView;Ljava/lang/String;)V": function (this: FragmentClient, _view: JWebView, url: string) { this.events.push(["finished", url]); },
      "onPageStarted(Landroid/webkit/WebView;Ljava/lang/String;Landroid/graphics/Bitmap;)V": function (this: FragmentClient, _view: JWebView, url: string) { this.events.push(["started", url]); },
      "onPageCommitVisible(Landroid/webkit/WebView;Ljava/lang/String;)V": function (this: FragmentClient) { this.events.push(["commit"]); },
    },
  });
  rt.linkNatives();

  test("fragment navigation updates the URL and finishes without starting or committing a document", async () => {
    const view = new JWebView(), client = new FragmentClient();
    view.client = client; view.loaded = true; view.progress = 100;
    const url = "https://example.org/page#section";
    view.fragmentNavigated(url);
    await onMain(() => {});
    expect(client.events).toEqual([["visited", url, 0, url], ["finished", url]]);
    expect([view.loaded, view.progress]).toEqual([true, 100]);
  });

  test("a suspended visited-history callback can cancel the old fragment completion", async () => {
    const view = new JWebView(), client = new FragmentClient();
    view.client = client;
    client.visited = async () => { await Promise.resolve(); view.gen++; };
    const url = "https://example.org/page#section";
    view.fragmentNavigated(url);
    await onMain(() => {});
    expect(client.events).toEqual([["visited", url, 0, url]]);
  });

  test("a queued page-start callback retains its URL when a fragment commits", async () => {
    const view = new JWebView(), client = new FragmentClient();
    view.client = client;
    const url = "https://example.org/page";
    await onMain(() => { view.loadUrl(url); view.fragmentNavigated(url + "#section"); });
    await onMain(() => {});
    expect(client.events).toEqual([["started", url], ["visited", url + "#section", 0, url + "#section"], ["finished", url + "#section"]]);
  });

  test("a WebView history copy is an independent snapshot", async () => {
    const view = new JWebView();
    view.go({ url: "https://example.org/one" });
    view.go({ url: "https://example.org/two" });
    const history = await vcall(view, "copyBackForwardList", "()Landroid/webkit/WebBackForwardList;");
    await vcall(view, "clearHistory", "()V");
    expect(await vcall(history, "getSize", "()I")).toBe(2);
  });
});

describe("webview-keys", () => {
  class KeyClient extends JObj { events: unknown[] = []; }
  rt.register({ name: "test/WebKeyClient", ctor: KeyClient, sup: "android/webkit/WebViewClient", methods: {
    "shouldOverrideKeyEvent(Landroid/webkit/WebView;Landroid/view/KeyEvent;)Z": function (this: KeyClient, _view: unknown, event: unknown) {
      this.events.push(event); return 1;
    },
  } });
  rt.register({ name: "test/WebKeyListener", ctor: class extends JObj {}, ifaces: ["android/view/View$OnKeyListener"], methods: {
    "onKey(Landroid/view/View;ILandroid/view/KeyEvent;)Z": () => 1,
  } });
  rt.linkNatives();

  test("WebView key dispatch preserves listener interception and client overrides for both actions", async () => {
    const view = new JWebView(), client = new KeyClient();
    const down = await newObj("android/view/KeyEvent", "(II)V", 0, 111);
    const up = await newObj("android/view/KeyEvent", "(II)V", 1, 111);
    expect(await vcall(view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", down)).toBe(0);
    await vcall(view, "setWebViewClient", "(Landroid/webkit/WebViewClient;)V", client);
    expect(await vcall(view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", down)).toBe(1);
    expect(await vcall(view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", up)).toBe(1);
    expect(client.events).toEqual([down, up]);
    await vcall(view, "setOnKeyListener", "(Landroid/view/View$OnKeyListener;)V", rt.make("test/WebKeyListener"));
    expect(await vcall(view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", down)).toBe(1);
    expect(client.events).toEqual([down, up]);
  });
});
