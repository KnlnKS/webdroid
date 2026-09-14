import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { obtainEvent } from "../src/android/view";

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
