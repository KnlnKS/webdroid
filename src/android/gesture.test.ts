import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { curThread, mainThread, newObj, vcall } from "../jvm/natives/jlang";
import { obtainEvent } from "./view";
import { inMainJob, onMain } from "./mainloop";
import { type JMotionEvent } from "./motionevent";

class Listener extends (rt.link("android/view/GestureDetector$SimpleOnGestureListener").ctor) { calls: { name: string; action: number; x: number; main: boolean }[] = []; }
const methods = Object.fromEntries(["onDown", "onSingleTapUp", "onSingleTapConfirmed", "onDoubleTap", "onDoubleTapEvent"].map((name) => [name + "(Landroid/view/MotionEvent;)Z", function (this: Listener, event: JMotionEvent) {
  this.calls.push({ name, action: event.action, x: event.x, main: inMainJob() && curThread === mainThread }); return 1;
}]));
rt.register({ name: "webdroid/GestureTestListener", ctor: Listener, sup: "android/view/GestureDetector$SimpleOnGestureListener", methods });
async function detector() {
  const listener: Listener = await newObj("webdroid/GestureTestListener");
  const detector = await newObj("android/view/GestureDetector", "(Landroid/view/GestureDetector$OnGestureListener;)V", listener);
  await vcall(detector, "setIsLongpressEnabled", "(Z)V", 0);
  return { detector, listener };
}
const touch = (detector: unknown, action: number, time: number, x = 10) => vcall(detector, "onTouchEvent", "(Landroid/view/MotionEvent;)Z", obtainEvent(1000n, BigInt(time), action, x, 10));
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 330)); await onMain(() => {}); };

test("gesture constructor recognizes the double-tap interface and confirms copied single taps on main", async () => {
  const { detector: d, listener } = await detector();
  const event = obtainEvent(1000n, 1000n, 0, 10, 10);
  expect(await vcall(d, "onTouchEvent", "(Landroid/view/MotionEvent;)Z", event)).toBe(1);
  event.x = 900;
  await touch(d, 1, 1020);
  expect(listener.calls.map((c) => c.name)).toEqual(["onDown", "onSingleTapUp"]);
  await settle();
  expect(listener.calls.at(-1)).toEqual({ name: "onSingleTapConfirmed", action: 0, x: 10, main: true });
  expect(listener.calls.every((c) => c.main)).toBe(true);
});

test("double taps suppress confirmation and dispatch the second event stream", async () => {
  const { detector: d, listener } = await detector();
  await touch(d, 0, 1000); await touch(d, 1, 1020);
  await touch(d, 0, 1100); await touch(d, 2, 1110); await touch(d, 1, 1120);
  await settle();
  expect(listener.calls.map((c) => c.name)).toEqual(["onDown", "onSingleTapUp", "onDoubleTap", "onDoubleTapEvent", "onDown", "onDoubleTapEvent", "onDoubleTapEvent"]);
  expect(listener.calls.filter((c) => c.name === "onDoubleTapEvent").map((c) => c.action)).toEqual([0, 2, 1]);
  expect(listener.calls.every((c) => c.main)).toBe(true);
});

test("cancellation, scrolling, and listener removal suppress pending confirmation", async () => {
  const { detector: d, listener } = await detector();
  await touch(d, 0, 1000); await touch(d, 3, 1020);
  await touch(d, 0, 1100); await touch(d, 2, 1120, 500); await touch(d, 1, 1140, 500);
  await touch(d, 0, 2000); await touch(d, 1, 2020);
  await vcall(d, "setOnDoubleTapListener", "(Landroid/view/GestureDetector$OnDoubleTapListener;)V", null);
  await settle();
  expect(listener.calls.some((c) => c.name === "onSingleTapConfirmed")).toBe(false);
  const replacement: Listener = await newObj("webdroid/GestureTestListener");
  await vcall(d, "setOnDoubleTapListener", "(Landroid/view/GestureDetector$OnDoubleTapListener;)V", replacement);
  await touch(d, 0, 3000); await touch(d, 1, 3020); await settle();
  expect(replacement.calls.map((c) => c.name)).toEqual(["onSingleTapConfirmed"]);
});


test("double tap recognition enforces minimum time and distance, and held taps confirm on release", async () => {
  for (const [time, x] of [[1040, 10], [1100, 5000]]) {
    const { detector: d, listener } = await detector();
    await touch(d, 0, 1000); await touch(d, 1, 1020);
    await touch(d, 0, time, x); await touch(d, 1, time + 20, x); await settle();
    expect(listener.calls.some((c) => c.name === "onDoubleTap")).toBe(false);
    expect(listener.calls.filter((c) => c.name === "onSingleTapConfirmed").length).toBe(2);
  }
  const { detector: d, listener } = await detector();
  await touch(d, 0, 1000); await settle();
  expect(listener.calls.map((c) => c.name)).toEqual(["onDown"]);
  await touch(d, 1, 1400);
  expect(listener.calls.at(-1)).toEqual({ name: "onSingleTapConfirmed", action: 1, x: 10, main: true });
});
