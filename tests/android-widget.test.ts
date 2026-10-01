import { expect, test, spyOn, describe, beforeAll } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { vcall, newObj, vcallAsync } from "../src/jvm/natives/jlang";
import { mangleMethod, mangleStaticField } from "../src/jvm/abi";
import { onMain } from "../src/android/mainloop";
import { JEditText } from "../src/android/textview";
import { editorAction } from "../src/android/textview-input";
import { JView, JViewGroup, makeSpec, MS_EXACTLY, measureView, layoutView, MS_AT_MOST, JLinearLP, JMarginLP, MS_UNSPEC } from "../src/android/view";
import { obtainMotion } from "../src/android/motionevent";
import { keyActionOf } from "../src/android/keyevent";
import { ST, drawableBounds } from "../src/android/drawable";
import { JLinearLayout } from "../src/android/layouts";
import { classCtors } from "../src/jvm/natives/jreflect";
import { glSurfaces } from "../src/native/egl-current";
import { Resources, JTheme } from "../src/android/res";
import type { WebViewChromium } from "../src/android/webkit";
import { scall, preloadTextPaint, loadFrameworkJar } from "./java";

// framework.jar and a running main looper, as a booted page has them
beforeAll(loadFrameworkJar);

beforeAll(preloadTextPaint);

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

describe("expandable-list", () => {
  rt.linkNatives();
  const m = (n: string, d: string, f: (...a: any[]) => unknown) => ({ [mangleMethod(n, d)]: f });
  test("ExpandableListView flattens expanded groups and toggles a group on click", async () => {
    const children = [["a", "b"], []];
    const adapter = Object.assign(rt.make("android/widget/BaseExpandableListAdapter"),
      m("getGroupCount", "()I", () => children.length),
      m("getChildrenCount", "(I)I", (g: number) => children[g].length),
      m("getGroup", "(I)Ljava/lang/Object;", (g: number) => "group" + g),
      m("getChild", "(II)Ljava/lang/Object;", (g: number, c: number) => children[g][c]),
      m("getGroupId", "(I)J", (g: number) => BigInt(g)),
      m("getChildId", "(II)J", (_g: number, c: number) => BigInt(c)),
      m("getGroupView", "(IZLandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;", () => new JView()),
      m("getChildView", "(IIZLandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;", () => new JView()),
      m("isChildSelectable", "(II)Z", () => 1));
    const list = rt.make("android/widget/ExpandableListView");
    const E = "android/widget/ExpandableListView";
    await vcall(list, "setAdapter", "(Landroid/widget/ExpandableListAdapter;)V", adapter);
    expect(await vcall(list, "getCount", "()I")).toBe(2);
    expect(await vcall(list, "expandGroup", "(I)Z", 0)).toBe(1);
    expect(await vcall(list, "getCount", "()I")).toBe(4);
    expect(await vcall(list, "getItemAtPosition", "(I)Ljava/lang/Object;", 2)).toBe("b");
    const packed = await vcall(list, "getExpandableListPosition", "(I)J", 2);
    expect(packed).toBe(scall(E, "getPackedPositionForChild", "(II)J", 0, 1));
    expect([scall(E, "getPackedPositionType", "(J)I", packed), scall(E, "getPackedPositionGroup", "(J)I", packed), scall(E, "getPackedPositionChild", "(J)I", packed)]).toEqual([1, 0, 1]);
    expect(await vcall(list, "getFlatListPosition", "(J)I", packed)).toBe(2);
    await vcall(list, "performItemClick", "(Landroid/view/View;IJ)Z", null, 0, 0n);
    expect([await vcall(list, "isGroupExpanded", "(I)Z", 0), await vcall(list, "getCount", "()I")]).toEqual([0, 2]);
  });
});

describe("editor-action", () => {
  rt.linkNatives();
  class KeyListener extends JObj { keys: [number, number][] = []; [mangleMethod("onKey", "(Landroid/view/View;ILandroid/view/KeyEvent;)Z")](_v: unknown, code: number, ev: JObj) { this.keys.push([keyActionOf(ev), code]); return 1; } }
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

describe("gridlayout", () => {
  rt.linkNatives();

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

describe("linear-dividers", () => {
  rt.linkNatives();
  test("linear dividers reserve space around visible children and draw within padding", async () => {
    const parent = rt.make("android/widget/LinearLayout") as JLinearLayout;
    parent.orientation = 1; parent.padT = 3; parent.padB = 4;
    const divider = await newObj("android/graphics/drawable/ColorDrawable", "()V"), drawn: number[][] = [];
    Object.assign(divider, {
      [mangleMethod("getIntrinsicWidth", "()I")]: () => 2,
      [mangleMethod("getIntrinsicHeight", "()I")]: () => 2,
      [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]: () => { const b = drawableBounds(divider); drawn.push([b.left, b.top, b.right, b.bottom]); },
    });
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
    expect(drawn).toEqual([[1, 3, 19, 5], [1, 15, 19, 17], [1, 37, 19, 39]]);
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

  test("LinearLayout retains a valid baseline child index and rejects indexes outside its children", async () => {
    const layout = new JLinearLayout();
    layout.children.push(new JView(), new JView());
    for (const index of [-1, 2]) {
      await expect(vcallAsync(layout, "setBaselineAlignedChildIndex", "(I)V", index)).rejects.toMatchObject({
        constructor: rt.link("java/lang/IllegalArgumentException").ctor,
      });
    }
    expect(await vcall(layout, "getBaselineAlignedChildIndex", "()I")).toBe(-1);
    await vcall(layout, "setBaselineAlignedChildIndex", "(I)V", 1);
    expect(await vcall(layout, "getBaselineAlignedChildIndex", "()I")).toBe(1);
  });
});

describe("platform-construction", () => {
  rt.linkNatives();
  test("TextureView copies content transforms and resets them without changing its bounds", async () => {
    const view = rt.make("android/view/TextureView");
    const values = async (m: unknown) => { const v = new Float32Array(9); await vcall(m, "getValues", "([F)V", v); return [...v]; };
    const matrix = await newObj("android/graphics/Matrix", "()V");
    await vcall(matrix, "setValues", "([F)V", Float32Array.of(2, 0, 10, 0, 3, 20, 0, 0, 1));
    await vcall(view, "setTransform", "(Landroid/graphics/Matrix;)V", matrix);
    await vcall(matrix, "setTranslate", "(FF)V", 100, 0);
    const copy = await vcall(view, "getTransform", "(Landroid/graphics/Matrix;)Landroid/graphics/Matrix;", null);
    expect(await values(copy)).toEqual([2, 0, 10, 0, 3, 20, 0, 0, 1]);
    await vcall(copy, "setScale", "(FF)V", 9, 9);
    expect(await vcall(view, "getTransform", "(Landroid/graphics/Matrix;)Landroid/graphics/Matrix;", matrix)).toBe(matrix);
    expect(await values(matrix)).toEqual([2, 0, 10, 0, 3, 20, 0, 0, 1]);
    expect(await vcall(view, "getWidth", "()I")).toBe(0);
    await vcall(view, "setTransform", "(Landroid/graphics/Matrix;)V", null);
    expect(await values(await vcall(view, "getTransform", "(Landroid/graphics/Matrix;)Landroid/graphics/Matrix;", matrix))).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
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
    const colors = await scall("android/content/res/ColorStateList", "valueOf", "(I)Landroid/content/res/ColorStateList;", 0xff123456 | 0);
    await vcall(button, "setButtonTintList", "(Landroid/content/res/ColorStateList;)V", colors);
    expect(await vcall(button, "getButtonTintList", "()Landroid/content/res/ColorStateList;")).toBe(colors);
    const indicator = await newObj("android/graphics/drawable/StateListDrawable", "()V");
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
  const touch = async (detector: JObj, action: number, time: number, y = 100) =>
    vcall(detector, "onTouchEvent", "(Landroid/view/MotionEvent;)Z", await obtainMotion(0, time, action, 100, y));
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

describe("webfragment", () => {
  class FragmentClient extends JObj {
    events: unknown[][] = [];
    visited: (() => void | Promise<void>) | null = null;
    provider: WebViewChromium | null = null;
  }
  /** a WebView's provider, its view a stand-in: these exercise the provider's navigation alone */
  const webView = (client: FragmentClient | null = null) => {
    const p = rt.make("webdroid/WebViewProvider") as WebViewChromium;
    p.view = new JObj(); p.settings = rt.make("webdroid/WebSettings");
    if (client) { p.client = client; client.provider = p; }
    return p;
  };
  rt.register({
    name: "test/FragmentClient", ctor: FragmentClient, sup: "android/webkit/WebViewClient",
    methods: {
      "doUpdateVisitedHistory(Landroid/webkit/WebView;Ljava/lang/String;Z)V": async function (this: FragmentClient, _view: unknown, url: string, reload: number) {
        this.events.push(["visited", url, reload, this.provider!.url]); await this.visited?.();
      },
      "onPageFinished(Landroid/webkit/WebView;Ljava/lang/String;)V": function (this: FragmentClient, _view: unknown, url: string) { this.events.push(["finished", url]); },
      "onPageStarted(Landroid/webkit/WebView;Ljava/lang/String;Landroid/graphics/Bitmap;)V": function (this: FragmentClient, _view: unknown, url: string) { this.events.push(["started", url]); },
      "onPageCommitVisible(Landroid/webkit/WebView;Ljava/lang/String;)V": function (this: FragmentClient) { this.events.push(["commit"]); },
    },
  });
  rt.linkNatives();

  test("fragment navigation updates the URL and finishes without starting or committing a document", async () => {
    const client = new FragmentClient(), view = webView(client);
    view.loaded = true; view.progress = 100;
    const url = "https://example.org/page#section";
    view.fragmentNavigated(url);
    await onMain(() => {});
    expect(client.events).toEqual([["visited", url, 0, url], ["finished", url]]);
    expect([view.loaded, view.progress]).toEqual([true, 100]);
  });

  test("a suspended visited-history callback can cancel the old fragment completion", async () => {
    const client = new FragmentClient(), view = webView(client);
    client.visited = async () => { await Promise.resolve(); view.gen++; };
    const url = "https://example.org/page#section";
    view.fragmentNavigated(url);
    await onMain(() => {});
    expect(client.events).toEqual([["visited", url, 0, url]]);
  });

  test("a queued page-start callback retains its URL when a fragment commits", async () => {
    const client = new FragmentClient(), view = webView(client);
    const url = "https://example.org/page";
    await onMain(() => { view.loadUrl(url); view.fragmentNavigated(url + "#section"); });
    await onMain(() => {});
    expect(client.events).toEqual([["started", url], ["visited", url + "#section", 0, url + "#section"], ["finished", url + "#section"]]);
  });

  test("a WebView history copy is an independent snapshot", async () => {
    const view = webView();
    view.go({ url: "https://example.org/one" });
    view.go({ url: "https://example.org/two" });
    const history = await vcall(view, "copyBackForwardList", "()Landroid/webkit/WebBackForwardList;");
    await vcall(view, "clearHistory", "()V");
    expect(await vcall(history, "getSize", "()I")).toBe(2);
  });
});
