import { expect, test, describe, beforeAll } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { vcall, newObj, vcallOn, curThread, JThread, mainThread, setCurThread } from "../src/jvm/natives/jlang";
import { canvasOver, canvasOf, type JavaCanvas } from "../src/android/canvas";
import { mangleMethod, mangleStaticField } from "../src/jvm/abi";
import { onMain } from "../src/android/mainloop";
import { JView, JViewGroup, makeSpec, MS_EXACTLY, measureView, layoutView, MS_AT_MOST, resolveSize, drawView, attachView, detachView, addUnattachedView, dispatchAttached, dispatchDetached, layoutRoot, replayLayoutRequests, requestLayout, JLayoutParams, setViewTargetSdk } from "../src/android/view";
import { drawableBounds } from "../src/android/drawable";
import { recordingContext, replay, type DisplayList } from "../src/android/recording";
import { Resources, JTheme } from "../src/android/res";
import { JImageView } from "../src/android/imageview";
import { JWindowInsets } from "../src/android/windowinsets";
import type { WebViewChromium } from "../src/android/webkit";
import { scall, loadLibcore, loadFrameworkJar, preloadTextPaint } from "./java";

// framework drawables construct Paints, which take the device's languages
beforeAll(preloadTextPaint);

describe("android-surface-state", () => {
  rt.linkNatives();

  test("uname reports the emulated Linux ABI", async () => {
    await loadLibcore();
    const uts = await scall("android/system/Os", "uname", "()Landroid/system/StructUtsname;");
    if (typeof uts !== "object" || uts === null || !("sysname" in uts) || !("release" in uts) || !("machine" in uts))
      throw new Error("uname returned an invalid StructUtsname");
    expect(uts.sysname).toBe("Linux");
    expect(String(uts.release)).toContain("webdroid");
    expect(["aarch64", "armv7l"]).toContain(String(uts.machine));
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
  test("a frame measures its children through an overriding measureChildWithMargins", async () => {
    const scroll = rt.make("android/widget/FrameLayout") as JViewGroup, child = rt.make("android/view/View") as JView;
    Object.assign(child, { [onMeasure](w: number, h: number) { child.measuredW = resolveSize(50, w); child.measuredH = resolveSize(900, h); } });
    // NestedScrollView's override: the child's height is unbounded
    Object.assign(scroll, { [mangleMethod("measureChildWithMargins", "(Landroid/view/View;IIII)V")](c: JView, ws: number) {
      return measureView(c, ws, makeSpec(0, 0));
    } });
    await add(scroll, child, "FrameLayout", -1, -2);
    await measureView(scroll, makeSpec(200, MS_EXACTLY), makeSpec(300, MS_EXACTLY));
    expect([child.measuredW, child.measuredH]).toEqual([200, 900]);
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

describe("surface-display-list", () => {
  beforeAll(loadFrameworkJar);
  test("a recorded SurfaceView picks up its first frame after recording", async () => {
    const view = await newObj("android/view/SurfaceView", "(Landroid/content/Context;)V", null);
    view.right = 320;
    view.bottom = 180;
    const ops: DisplayList = [];
    const images: unknown[] = [];
    const target = new Proxy({
      drawImage: (image: unknown) => images.push(image),
      getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    }, { get: (object, key) => key in object ? object[key as keyof typeof object] : () => {} }) as unknown as CanvasRenderingContext2D;

    await drawView(view, canvasOver(recordingContext(target, ops), 320, 180));
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
  beforeAll(loadFrameworkJar);
  const identity = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

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
      getTransform: identity,
    } as unknown as OffscreenCanvasRenderingContext2D;
    const canvas = canvasOver(context, 100, 100);
    class CustomView extends JView {
      observedSaveCount = 0;
      [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")](target: JavaCanvas) {
        this.observedSaveCount = canvasOf(target).saveCount;
      }
    }
    const view = new CustomView();
    view.right = view.bottom = 100;

    await drawView(view, canvas);

    expect(view.observedSaveCount).toBe(2);
    expect(canvasOf(canvas).saveCount).toBe(1);
    expect(depth).toBe(0);
  });

  test("view Z changes child paint order relative to elevation", async () => {
    const order: string[] = [];
    const context = { save() {}, restore() {}, translate() {}, beginPath() {}, rect() {}, clip() {}, getTransform: identity } as unknown as OffscreenCanvasRenderingContext2D;
    const canvas = canvasOver(context, 100, 100);
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

  test("canvas root state rejects unmatched restores", async () => {
    let restores = 0;
    const context = {
      restore() { restores++; },
    } as unknown as OffscreenCanvasRenderingContext2D;
    const canvas = canvasOver(context, 100, 100);
    const thrown = async (f: () => unknown) => { try { await f(); } catch (e) { return rt.jx(e).msg; } return null; };

    expect(await thrown(() => vcall(canvas, "restore", "()V"))).toBe("Underflow in restore - more restores than saves");
    expect(await thrown(() => vcall(canvas, "restoreToCount", "(I)V", 0))).toBe("Underflow in restoreToCount - more restores than saves");
    expect(canvasOf(canvas).saveCount).toBe(1);
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
      getTransform: identity,
    } as unknown as OffscreenCanvasRenderingContext2D;
    const canvas = canvasOver(context, 100, 100);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let completed = false;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const suspended = await newObj("android/graphics/drawable/ColorDrawable", "()V");
    Object.assign(suspended, {
      [mangleMethod("getIntrinsicWidth", "()I")]: () => 20,
      [mangleMethod("getIntrinsicHeight", "()I")]: () => 20,
      [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]: async () => {
        started();
        await gate;
        completed = true;
      },
    });
    const view = new JImageView();
    await view.setDrawable(suspended);
    view.scaleType = scaleType;
    view.right = view.bottom = 100;

    const drawing = drawView(view, canvas);
    await entered;
    expect(completed).toBeFalse();
    expect(depth).toBe(pendingDepth);

    release();
    await drawing;
    expect(completed).toBeTrue();
    expect(canvasOf(canvas).saveCount).toBe(1);
    expect(depth).toBe(0);
  });
});

describe("view-foreground", () => {
  rt.linkNatives();
  test("foreground drawing awaits bounds, retains its thread and resolves gravity", async () => {
    const view = rt.make("android/view/View"), drawable = await newObj("android/graphics/drawable/ColorDrawable", "()V");
    if (!(view instanceof JView)) throw new Error("Invalid delegates");
    const callback = () => vcall(drawable, "getCallback", "()Landroid/graphics/drawable/Drawable$Callback;");
    view.right = 80; view.bottom = 60;
    const seen: JThread[] = [], events: string[] = [];
    Object.assign(drawable, {
      [mangleMethod("getIntrinsicWidth", "()I")]: async () => { seen.push(curThread); await Promise.resolve(); return 20; },
      [mangleMethod("getIntrinsicHeight", "()I")]: () => { seen.push(curThread); return 10; },
      [mangleMethod("onBoundsChange", "(Landroid/graphics/Rect;)V")]: async () => { seen.push(curThread); await Promise.resolve(); events.push("bounds"); },
      [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]: () => { seen.push(curThread); events.push("draw"); },
    });
    await vcall(view, "setForeground", "(Landroid/graphics/drawable/Drawable;)V", drawable);
    expect(await callback()).toBe(view);
    const thread = new JThread();
    await vcallOn(thread, view, "onDrawForeground", "(Landroid/graphics/Canvas;)V", null);
    expect(drawableBounds(drawable)).toMatchObject({ left: 0, top: 0, right: 80, bottom: 60 });
    expect(events).toEqual(["bounds", "draw"]);
    await vcall(view, "setForegroundGravity", "(I)V", 17);
    await vcallOn(thread, view, "onDrawForeground", "(Landroid/graphics/Canvas;)V", null);
    expect(drawableBounds(drawable)).toMatchObject({ left: 30, top: 25, right: 50, bottom: 35 });
    events.length = 0;
    await vcallOn(thread, view, "onDrawForeground", "(Landroid/graphics/Canvas;)V", null);
    expect(events).toEqual(["draw"]);
    expect(seen.every(t => t === thread)).toBe(true);
    await vcall(view, "setForeground", "(Landroid/graphics/drawable/Drawable;)V", null);
    expect(await callback()).toBeNull();
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
    const view = rt.make("android/view/View"), outline = await newObj("android/graphics/Outline", "()V");
    if (!(view instanceof JView)) throw new Error("Invalid view delegate");
    view.right = 40; view.bottom = 30;
    view.padL = 2; view.padT = 3; view.padR = 4; view.padB = 5;
    const cls = rt.link("android/view/ViewOutlineProvider").ctor;
    const provider = await vcall(view, "getOutlineProvider", "()Landroid/view/ViewOutlineProvider;");
    expect(provider).toBe(cls[mangleStaticField("BACKGROUND")]);
    const fill = (p: unknown) => vcall(p, "getOutline", "(Landroid/view/View;Landroid/graphics/Outline;)V", view, outline);
    const rect = await newObj("android/graphics/Rect", "()V") as { left: number; top: number; right: number; bottom: number };
    const shape = async () => {
      await vcall(outline, "getRect", "(Landroid/graphics/Rect;)Z", rect);
      return [rect.left, rect.top, rect.right, rect.bottom, await vcall(outline, "getRadius", "()F")];
    };
    await fill(provider);
    expect([...await shape(), await vcall(outline, "getAlpha", "()F")]).toEqual([0, 0, 40, 30, 0, 0]);
    const background = await newObj("android/graphics/drawable/ColorDrawable", "()V");
    Object.assign(background, {
      [mangleMethod("getOutline", "(Landroid/graphics/Outline;)V")]: async (o: object) => {
        await Promise.resolve();
        await vcall(o, "setRoundRect", "(IIIIF)V", 1, 2, 39, 28, 7);
      },
    });
    await vcall(view, "setBackground", "(Landroid/graphics/drawable/Drawable;)V", background);
    await fill(provider);
    expect(await shape()).toEqual([1, 2, 39, 28, 7]);
    const inset = await newObj("android/graphics/drawable/InsetDrawable", "(Landroid/graphics/drawable/Drawable;I)V", background, 3);
    await vcall(view, "setBackground", "(Landroid/graphics/drawable/Drawable;)V", inset);
    await fill(provider);
    expect(await shape()).toEqual([1, 2, 39, 28, 7]);
    await fill(cls[mangleStaticField("BOUNDS")]);
    expect(await shape()).toEqual([0, 0, 40, 30, 0]);
    await fill(cls[mangleStaticField("PADDED_BOUNDS")]);
    expect(await shape()).toEqual([2, 3, 36, 25, 0]);
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

describe("webview-keys", () => {
  class KeyClient extends JObj { events: unknown[] = []; }
  rt.register({ name: "test/WebKeyClient", ctor: KeyClient, sup: "android/webkit/WebViewClient", methods: {
    "shouldOverrideKeyEvent(Landroid/webkit/WebView;Landroid/view/KeyEvent;)Z": function (this: KeyClient, _view: unknown, event: unknown) {
      this.events.push(event); return 1;
    },
  } });
  class Access extends JObj { events: unknown[] = []; }
  rt.register({ name: "test/WebAccess", ctor: Access, methods: {
    "super_dispatchKeyEvent(Landroid/view/KeyEvent;)Z": function (this: Access, event: unknown) { this.events.push(event); return 1; },
  } });
  rt.linkNatives();

  test("WebView keys the client claims, and keys the page cannot take, go through View's dispatch", async () => {
    const view = rt.make("webdroid/WebViewProvider") as WebViewChromium, client = new KeyClient(), access = new Access();
    view.view = new JObj(); view.access = access;
    const back = await newObj("android/view/KeyEvent", "(II)V", 0, 4);
    const escape = await newObj("android/view/KeyEvent", "(II)V", 1, 111);
    expect(await vcall(view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", back)).toBe(1);
    expect(access.events).toEqual([back]);
    await vcall(view, "setWebViewClient", "(Landroid/webkit/WebViewClient;)V", client);
    expect(await vcall(view, "dispatchKeyEvent", "(Landroid/view/KeyEvent;)Z", escape)).toBe(1);
    expect(client.events).toEqual([escape]);
    expect(access.events).toEqual([back, escape]);
  });
});
