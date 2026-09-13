import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { mangleMethod, jarray } from "../src/jvm/abi";
import { newObj, vcall, vcallOn, curThread, JThread, JFloat, box } from "../src/jvm/natives/jlang";

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

class TimeListener extends JObj { times: [bigint, bigint][] = []; }
rt.register({ name: "test/TimeListener", ctor: TimeListener, ifaces: ["android/animation/TimeAnimator$TimeListener"], methods: {
  "onTimeUpdate(Landroid/animation/TimeAnimator;JJ)V": function (this: TimeListener, _anim: unknown, total: bigint, delta: bigint) { this.times.push([total, delta]); },
} });
test("TimeAnimator starts at zero and keeps ticking beyond the inherited duration", async () => {
  const { uiState } = await import("../src/android/view");
  const { onMain } = await import("../src/android/mainloop");
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
  const { onMain } = await import("../src/android/mainloop");
  const set = await newObj("android/animation/AnimatorSet"), events: string[] = [];
  let release!: () => void, finish!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const ended = new Promise<void>(resolve => { finish = resolve; });
  for (const name of ["first", "second"]) await vcall(set, "addListener", "(Landroid/animation/Animator$AnimatorListener;)V", {
    [mangleMethod("onAnimationStart", "(Landroid/animation/Animator;)V")]: () => {},
    [mangleMethod("onAnimationEnd", "(Landroid/animation/Animator;)V")]: async () => {
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
