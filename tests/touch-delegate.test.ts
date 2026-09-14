import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JView } from "../src/android/view";
import { JRect } from "../src/android/graphics";
import { JMotionEvent } from "../src/android/motionevent";
import { device } from "../src/shell/config";
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
