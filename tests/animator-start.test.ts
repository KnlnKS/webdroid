import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { mangleMethod, jarray } from "../src/jvm/abi";
import { newObj, vcall, JFloat, box } from "../src/jvm/natives/jlang";

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
