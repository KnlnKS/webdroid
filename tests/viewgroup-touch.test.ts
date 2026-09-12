import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";
import { JView, JViewGroup } from "../src/android/view";

rt.linkNatives();
const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);
const event = (action: number, x: number, y: number) => scall("android/view/MotionEvent", "obtain", "(JJIFFI)Landroid/view/MotionEvent;", 0n, 0n, action, x, y, 0);
const tap = async (v: JView, x: number, y: number) => {
  await vcall(v, "dispatchTouchEvent", "(Landroid/view/MotionEvent;)Z", event(0, x, y));
  await vcall(v, "dispatchTouchEvent", "(Landroid/view/MotionEvent;)Z", event(1, x, y));
};
class TouchListener extends JObj { seen = 0; [mangleMethod("onTouch", "(Landroid/view/View;Landroid/view/MotionEvent;)Z")]() { this.seen++; return 1; } }
class ClickListener extends JObj { clicks = 0; [mangleMethod("onClick", "(Landroid/view/View;)V")]() { this.clicks++; } }

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
