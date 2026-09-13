import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { mangleMethod, jarray } from "../src/jvm/abi";
import { newObj, vcall, JFloat, box } from "../src/jvm/natives/jlang";
import type { JPoint } from "../src/android/graphics";

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
  await Bun.sleep(10);
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
