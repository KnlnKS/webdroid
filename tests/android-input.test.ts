import { expect, test, describe, beforeAll } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { vcall, newObj } from "../src/jvm/natives/jlang";
import { JRect } from "../src/android/graphics";
import { mangleMethod } from "../src/jvm/abi";
import { JView, JViewGroup, attachView, detachView } from "../src/android/view";
import { JFrameLayout } from "../src/android/layouts";
import { obtainMotion, actionOf, eventX, eventY } from "../src/android/motionevent";
import { device } from "../src/shell/config";
import { JActivity } from "../src/android/app";
import { scall, loadFrameworkJar, loadLibcore } from "./java";

beforeAll(async () => { await loadLibcore(); await loadFrameworkJar(); });

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

describe("touch-delegate", () => {
  class Target extends JView { events: number[][] = []; }
  rt.register({ name: "test/TouchTarget", ctor: Target, sup: "android/view/View", methods: {
    "dispatchTouchEvent(Landroid/view/MotionEvent;)Z": function (this: Target, e: JObj) { this.events.push([actionOf(e), eventX(e), eventY(e)]); return 1; },
  } });
  rt.linkNatives();
  test("a non-clickable host forwards a captured gesture and cancels outside the slop bounds", async () => {
    const target = rt.make("test/TouchTarget") as Target; target.right = 40; target.bottom = 20;
    const host = rt.make("android/view/View");
    const bounds = Object.assign(new JRect(), { left: 10, top: 10, right: 100, bottom: 100 });
    const delegate = await newObj("android/view/TouchDelegate", "(Landroid/graphics/Rect;Landroid/view/View;)V", bounds, target);
    await vcall(host, "setTouchDelegate", "(Landroid/view/TouchDelegate;)V", delegate);
    expect(await vcall(host, "getTouchDelegate", "()Landroid/view/TouchDelegate;")).toBe(delegate);
    const event = async (action: number, x: number, y: number) => vcall(host, "onTouchEvent", "(Landroid/view/MotionEvent;)Z", await obtainMotion(0, 0, action, x, y));
    expect(await event(0, 0, 0)).toBe(0);
    expect(await event(0, 15, 15)).toBe(1);
    await event(2, 1000, 1000); await event(3, 1000, 1000);
    expect(await event(2, 15, 15)).toBe(0);
    expect(target.events).toEqual([[0, 20, 10], [2, -2 * device.touchSlop, -2 * device.touchSlop], [3, 20, 10]]);
  });
});

describe("viewgroup-touch", () => {
  rt.linkNatives();
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
      [mangleMethod("onTouchEvent", "(Landroid/view/MotionEvent;)Z")](event: JObj) { seen.push(actionOf(event)); return 1; }
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
