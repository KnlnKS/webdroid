import { expect, test, afterAll, beforeAll, spyOn, describe } from "bun:test";
import "../src/natives";
import { JCanvas, JPaint, locateDrawnText, fillFontMetrics, mkTypeface, setFamilyMetrics, matrixColor } from "../src/android/graphics";
import { JObj, rt } from "../src/jvm/runtime";
import { mangleMethod, mangleStaticField } from "../src/jvm/abi";
import { newObj, vcall, vcallOn, curThread, JThread } from "../src/jvm/natives/jlang";
import { JTextView } from "../src/android/textview";
import { JView, JViewGroup, measureView, makeSpec, MS_AT_MOST } from "../src/android/view";
import { ST, JDrawable, inflateDrawableNode } from "../src/android/drawable";
import { Resources, JTypedArray } from "../src/android/res";
import { mkJResources } from "../src/android/resnative";
import { TV, type XmlNode } from "../src/android/axml";
import { JImageView } from "../src/android/imageview";
import { parsePackageArchive } from "../src/android/packagearchive";

describe("canvas-text", () => {
  rt.linkNatives();

  const canvas = () => JCanvas.wrap({
    fillText() {}, fillRect() {},
    getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 }; },
  } as unknown as OffscreenCanvasRenderingContext2D, 100, 100);
  const semanticOwner = () => ({ drawnText: null as string[] | null, drawnTextPoints: null as Float32Array | null, drawnTextCount: 0 });

  test("Canvas records custom-drawn text for semantic lookup", async () => {
    const cv = canvas(), paint = new JPaint();
    const owner = semanticOwner();
    cv.semanticOwner = owner;

    await vcall(cv, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "first", 0, 0, paint);
    await vcall(cv, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "second", 0, 20, paint);

    expect(owner.drawnText).toEqual(["first", "second"]);
    expect(owner.drawnTextPoints![0]).toBe(10 + paint.textSize);
    expect(owner.drawnTextPoints![1]).toBeCloseTo(20 - paint.textSize * 0.3);
    expect(owner.drawnTextPoints![2]).toBe(10 + paint.textSize);
    expect(owner.drawnTextPoints![3]).toBeCloseTo(40 - paint.textSize * 0.3);
  });

  test("Canvas maps layered semantic text through its parent transform", async () => {
    const cv = canvas(), paint = new JPaint();
    const owner = semanticOwner();
    cv.semanticBase = [1, 0, 0, 1, 100, 200];
    cv.semanticOwner = owner;

    await vcall(cv, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "layered", 0, 0, paint);

    expect(owner.drawnTextPoints![0]).toBe(110 + paint.textSize);
    expect(owner.drawnTextPoints![1]).toBeCloseTo(220 - paint.textSize * 0.3);
  });

  test("Canvas resolves virtual CharSequence text before drawing", async () => {
    class Sequence extends JObj {
      [mangleMethod("toString", "()Ljava/lang/String;")]() { return "Big Buck Bunny"; }
    }
    const cv = canvas(), paint = new JPaint();
    const owner = semanticOwner();
    cv.semanticOwner = owner;

    await vcall(cv, "drawText", "(Ljava/lang/CharSequence;IIFFLandroid/graphics/Paint;)V", new Sequence(), 4, 8, 0, 0, paint);

    expect(owner.drawnText).toEqual(["Buck"]);
  });

  test.each([
    ["uses the matching run point", ["leading", "later target", "tail"], "target"],
    ["preserves contiguous phrases", ["Big", "Buck", "Bunny"], "Buck Bunny"],
  ])("drawn text lookup %s", (_name, drawnText, query) => {
    const owner = { drawnText, drawnTextPoints: new Float32Array([10, 11, 20, 21, 30, 31]), drawnTextCount: 3 };
    expect(locateDrawnText(owner, query, 100, 100)).toEqual({ x: 20, y: 21 });
  });
});

describe("child-drawable-state", () => {
  rt.linkNatives();
  test("a group can aggregate child drawable states and receive subsequent changes", async () => {
    const parent = rt.make("android/view/ViewGroup") as JViewGroup;
    const child = rt.make("android/view/View") as JView;
    parent.children.push(child); child.parent = parent;
    expect(await vcall(parent, "addStatesFromChildren", "()Z")).toBe(0);
    await vcall(parent, "setAddStatesFromChildren", "(Z)V", 1);
    child.pressed = true;
    await vcall(child, "refreshDrawableState", "()V");
    expect(Array.from(await vcall(parent, "getDrawableState", "()[I"))).toContain(ST.pressed);
    await vcall(parent, "setAddStatesFromChildren", "(Z)V", 0);
    expect(Array.from(await vcall(parent, "getDrawableState", "()[I"))).not.toContain(ST.pressed);
  });
});

describe("color-hsv", () => {
  rt.linkNatives();
  const color = rt.link("android/graphics/Color").ctor as any;

  test("HSVToColor applies its explicit alpha", () => {
    const hsv = Float32Array.from([120, 1, 1]);
    expect(color[mangleMethod("HSVToColor", "(I[F)I")](0x40, hsv) >>> 0).toBe(0x4000ff00);
    expect(color[mangleMethod("HSVToColor", "([F)I")](hsv) >>> 0).toBe(0xff00ff00);
  });

  test("parseColor uses Android's named and hex formats", () => {
    const parse = color[mangleMethod("parseColor", "(Ljava/lang/String;)I")];
    expect(parse("darkgrey") >>> 0).toBe(0xff444444);
    expect(parse("#80abcdef") >>> 0).toBe(0x80abcdef);
    expect(() => parse("transparent")).toThrow();
    expect(() => parse("#fff")).toThrow();
  });
});

describe("custom-drawable-inflate", () => {
  class XmlDrawable extends JDrawable {
    tag = "";
    value = -1;
    child = "";
    sameParserAndAttrs = false;
  }

  rt.register({
    name: "test/XmlDrawable",
    ctor: XmlDrawable,
    sup: "android/graphics/drawable/Drawable",
    methods: {
      "<init>()V": () => {},
      "inflate(Landroid/content/res/Resources;Lorg/xmlpull/v1/XmlPullParser;Landroid/util/AttributeSet;Landroid/content/res/Resources$Theme;)V":
        async function (this: XmlDrawable, _res: unknown, parser: unknown, attrs: unknown) {
          this.sameParserAndAttrs = parser === attrs;
          this.tag = await vcall(parser, "getName", "()Ljava/lang/String;");
          this.value = await vcall(attrs, "getAttributeIntValue", "(Ljava/lang/String;Ljava/lang/String;I)I", "", "amount", -1);
          await vcall(parser, "next", "()I");
          this.child = await vcall(parser, "getName", "()Ljava/lang/String;");
        },
    },
  });
  rt.linkNatives();

  test("fully qualified drawable tags construct and inflate the app class", async () => {
    const res = new Resources(null, {});
    mkJResources(res, false);
    const node: XmlNode = {
      name: "test.XmlDrawable",
      attrs: [{ ns: "", name: "amount", resId: 0, type: TV.INT_DEC, data: 17, str: null }],
      children: [{ name: "child", attrs: [], children: [] }],
    };
    const drawable = await inflateDrawableNode(res, node, null);
    expect(drawable).toBeInstanceOf(XmlDrawable);
    if (!(drawable instanceof XmlDrawable)) return;
    expect(drawable.tag).toBe("test.XmlDrawable");
    expect(drawable.value).toBe(17);
    expect(drawable.child).toBe("child");
    expect(drawable.sameParserAndAttrs).toBe(true);
  });
});

describe("drawable-size-overrides", () => {
  rt.linkNatives();
  function drawable() {
    const d = rt.make("android/graphics/drawable/Drawable"), threads: JThread[] = [];
    Object.assign(d, {
      [mangleMethod("getIntrinsicWidth", "()I")]: async () => { threads.push(curThread); await Promise.resolve(); return 84; },
      [mangleMethod("getIntrinsicHeight", "()I")]: () => { threads.push(curThread); return 48; },
    });
    return { d, threads };
  }
  test("layer and minimum sizes dispatch drawable overrides, including explicit layer sizes", async () => {
    const { d } = drawable();
    const layer = await newObj("android/graphics/drawable/LayerDrawable", "([Landroid/graphics/drawable/Drawable;)V", [d]);
    await vcall(layer, "setLayerInset", "(IIIII)V", 0, 2, 3, 4, 5);
    expect(await vcall(layer, "getIntrinsicWidth", "()I")).toBe(90);
    expect(await vcall(layer, "getMinimumWidth", "()I")).toBe(90);
    expect(await vcall(layer, "getIntrinsicHeight", "()I")).toBe(56);
    await vcall(layer, "setLayerSize", "(III)V", 0, 100, 60);
    expect(await vcall(layer, "getIntrinsicWidth", "()I")).toBe(106);
    expect(await vcall(layer, "getMinimumHeight", "()I")).toBe(68);
  });
  test("ImageView measures virtual drawable dimensions and caches them for drawing", async () => {
    const { d, threads } = drawable(), view = rt.make("android/widget/ImageView");
    if (!(view instanceof JView)) throw new Error("Invalid view delegate");
    await vcall(view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", d);
    await measureView(view, makeSpec(200, MS_AT_MOST), makeSpec(200, MS_AT_MOST));
    expect([view.measuredW, view.measuredH]).toEqual([84, 48]);
    expect(threads[0]).toBe(threads[1]);
  });

  test("ImageView content and appearance updates invalidate ancestor recordings", async () => {
    const holder = rt.make("android/view/ViewGroup"), parent = rt.make("android/widget/FrameLayout");
    const view = rt.make("android/widget/ImageView"), targets: JView[] = [];
    if (!(holder instanceof JViewGroup) || !(parent instanceof JViewGroup) || !(view instanceof JView)) throw new Error("Invalid view delegates");
    parent.parent = holder; view.parent = parent;
    Object.assign(holder, {
      [mangleMethod("onDescendantInvalidated", "(Landroid/view/View;Landroid/view/View;)V")]: (_child: JView, target: JView) => { targets.push(target); },
    });
    const d = rt.make("android/graphics/drawable/ColorDrawable");
    for (const [name, desc, args] of [
      ["setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", [d]],
      ["setColorFilter", "(I)V", [0xff00ff00]],
      ["clearColorFilter", "()V", []],
      ["setImageBitmap", "(Landroid/graphics/Bitmap;)V", [null]],
      ["setImageResource", "(I)V", [0]],
    ] satisfies [string, string, unknown[]][]) {
      targets.length = 0;
      await vcall(view, name, desc, ...args);
      expect(targets).toEqual([view]);
    }
  });
  test("ImageView retains filters across replacement and invokes drawable overrides after mutation", async () => {
    const view = rt.make("android/widget/ImageView"), thread = new JThread();
    const events: [string, unknown, JThread][] = [];
    const make = () => {
      const d = rt.make("android/graphics/drawable/Drawable");
      Object.assign(d, {
        [mangleMethod("mutate", "()Landroid/graphics/drawable/Drawable;")]: async () => {
          events.push(["mutate", d, curThread]); await Promise.resolve(); return d;
        },
        [mangleMethod("setColorFilter", "(Landroid/graphics/ColorFilter;)V")]: (f: unknown) => { events.push(["filter", f, curThread]); },
      });
      return d;
    };
    await vcallOn(thread, view, "setColorFilter", "(I)V", -65536);
    const filter = await vcall(view, "getColorFilter", "()Landroid/graphics/ColorFilter;");
    expect(filter.tint).toBe(-65536);
    expect(events).toEqual([]);
    for (const d of [make(), make()]) {
      await vcallOn(thread, view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", d);
      expect(events.splice(0)).toEqual([["mutate", d, thread], ["filter", filter, thread]]);
    }
    const d = await vcall(view, "getDrawable", "()Landroid/graphics/drawable/Drawable;");
    await vcallOn(thread, view, "clearColorFilter", "()V");
    expect(events.splice(0)).toEqual([["mutate", d, thread], ["filter", null, thread]]);
    expect(await vcall(view, "getColorFilter", "()Landroid/graphics/ColorFilter;")).toBeNull();
    const next = make();
    await vcallOn(thread, view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", next);
    expect(events).toEqual([["mutate", next, thread], ["filter", null, thread]]);
  });
  test("suggested view minimums respect virtual background dimensions", async () => {
    const { d } = drawable(), view = rt.make("android/widget/TextView");
    if (!(view instanceof JView)) throw new Error("Invalid view delegate");
    await vcall(view, "setBackground", "(Landroid/graphics/drawable/Drawable;)V", d);
    expect(await vcall(view, "getSuggestedMinimumWidth", "()I")).toBe(84);
    expect(await vcall(view, "getSuggestedMinimumHeight", "()I")).toBe(48);
  });

  test("layer bounds and drawing await each child on the dispatch thread", async () => {
    const events: string[] = [], thread = new JThread();
    const children = [0, 1].map(i => {
      const d = rt.make("android/graphics/drawable/Drawable");
      Object.assign(d, {
        [mangleMethod("onBoundsChange", "(Landroid/graphics/Rect;)V")]: async () => {
          expect(curThread).toBe(thread);
          await Promise.resolve();
          events.push(`bounds ${i}`);
        },
        [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]: async () => {
          expect(curThread).toBe(thread);
          await Promise.resolve();
          events.push(`draw ${i}`);
        },
      });
      return d;
    });
    const layer = await newObj("android/graphics/drawable/LayerDrawable", "([Landroid/graphics/drawable/Drawable;)V", children);
    await vcallOn(thread, layer, "setBounds", "(IIII)V", 0, 0, 100, 100);
    expect(events).toEqual(["bounds 0", "bounds 1"]);
    await vcallOn(thread, layer, "draw", "(Landroid/graphics/Canvas;)V", null);
    expect(events).toEqual(["bounds 0", "bounds 1", "draw 0", "draw 1"]);
  });

  test("layer gravity uses virtual intrinsic size on non-fill axes", async () => {
    const { d, threads } = drawable(), thread = new JThread();
    const layer = await newObj("android/graphics/drawable/LayerDrawable", "([Landroid/graphics/drawable/Drawable;)V", [d]);
    await vcall(layer, "setLayerGravity", "(II)V", 0, 0x17);
    await vcallOn(thread, layer, "setBounds", "(IIII)V", 0, 0, 100, 60);
    const bounds = await vcall(d, "getBounds", "()Landroid/graphics/Rect;");
    expect([bounds.left, bounds.top, bounds.right, bounds.bottom]).toEqual([0, 6, 100, 54]);
    expect(threads).toEqual([thread]);
  });


  test("nested drawable containers share virtual size and draw dispatch", async () => {
    const { d } = drawable();
    const layer = await newObj("android/graphics/drawable/LayerDrawable", "([Landroid/graphics/drawable/Drawable;)V", [d]);
    for (const name of ["RotateDrawable", "ScaleDrawable", "DrawableWrapper"]) {
      const wrapper = await newObj("android/graphics/drawable/" + name, null);
      await vcall(wrapper, "setDrawable", "(Landroid/graphics/drawable/Drawable;)V", layer);
      expect(await vcall(wrapper, "getIntrinsicWidth", "()I")).toBe(84);
      expect(await vcall(wrapper, "getIntrinsicHeight", "()I")).toBe(48);
    }
    let draws = 0;
    Object.assign(d, { [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]: () => { draws++; } });
    expect(vcall(layer, "draw", "(Landroid/graphics/Canvas;)V", null)).toBeUndefined();
    expect(draws).toBe(1);
    await vcall(layer, "setLayerSize", "(III)V", 0, 100, 60);
    expect(vcall(layer, "getIntrinsicWidth", "()I")).toBe(100);
  });


  test("InsetDrawable replaces its child through the wrapper and retains pixel or fractional insets", async () => {
    for (const [type, inset, expected] of [["I", 3, 90], ["F", 0.25, 168]] as const) {
      const first = drawable().d, next = drawable().d;
      const wrapped = await newObj("android/graphics/drawable/InsetDrawable", `(Landroid/graphics/drawable/Drawable;${type})V`, first, inset);
      expect(rt.iof(wrapped, "android/graphics/drawable/DrawableWrapper")).toBe(1);
      await vcall(wrapped, "setDrawable", "(Landroid/graphics/drawable/Drawable;)V", next);
      expect(first.callback).toBeNull(); expect(next.callback).toBe(wrapped);
      expect(await vcall(wrapped, "getDrawable", "()Landroid/graphics/drawable/Drawable;")).toBe(next);
      expect(await vcall(wrapped, "getIntrinsicWidth", "()I")).toBe(expected);
      await vcall(wrapped, "setBounds", "(IIII)V", 0, 0, 100, 80);
      const b = next.bounds, x = type === "I" ? 3 : 25, y = type === "I" ? 3 : 20;
      expect([b.left, b.top, b.right, b.bottom]).toEqual([x, y, 100 - x, 80 - y]);
      const padding = await newObj("android/graphics/Rect");
      expect(await vcall(wrapped, "getPadding", "(Landroid/graphics/Rect;)Z", padding)).toBe(1);
      expect([padding.left, padding.top, padding.right, padding.bottom]).toEqual([x, y, x, y]);
    }
  });
});

describe("egl14-query-context", () => {
  rt.linkNatives();

  const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
  beforeAll(() => {
    if (originalOffscreenCanvas) return;
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      configurable: true,
      value: class {
        constructor(readonly width: number, readonly height: number) {}
      },
    });
  });
  afterAll(() => {
    if (!originalOffscreenCanvas) Reflect.deleteProperty(globalThis, "OffscreenCanvas");
  });

  test("EGL14 queries the created context's client version", async () => {
    const egl = rt.link("android/opengl/EGL14").ctor;
    const display = await vcall(egl, "eglGetDisplay", "(I)Landroid/opengl/EGLDisplay;", 0);
    const configs: unknown[] = [null];
    const count = new Int32Array(1);
    expect(await vcall(egl, "eglChooseConfig", "(Landroid/opengl/EGLDisplay;[II[Landroid/opengl/EGLConfig;II[II)Z",
      display, new Int32Array([0x3038]), 0, configs, 0, 1, count, 0)).toBe(1);
    const noContext = Object.getOwnPropertyDescriptor(egl, mangleStaticField("EGL_NO_CONTEXT"))?.value;
    const context = await vcall(egl, "eglCreateContext", "(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLConfig;Landroid/opengl/EGLContext;[II)Landroid/opengl/EGLContext;",
      display, configs[0], noContext, new Int32Array([0x3098, 3, 0x3038]), 0);
    const result = new Int32Array(2);
    expect(await vcall(egl, "eglQueryContext", "(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLContext;I[II)Z",
      display, context, 0x3098, result, 1)).toBe(1);
    expect(result[1]).toBe(3);
    expect(await vcall(egl, "eglQueryContext", "(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLContext;I[II)Z",
      display, context, -1, result, 0)).toBe(0);
    expect(await vcall(egl, "eglGetError", "()I")).toBe(0x3004);
  });
});

describe("font-metrics", () => {
  rt.linkNatives();

  test("loaded font metrics preserve fractional ascenders and round padded bounds outward", () => {
    setFamilyMetrics("metrics-probe", { ascent: 966 / 975, descent: 204 / 975, top: 1129 / 975, bottom: 251 / 975 });
    const view = new JTextView();
    view.paintT.tf = mkTypeface("metrics-probe", true, false);
    view.paintT.textSize = 68;
    const metrics = { top: 0, ascent: 0, descent: 0, bottom: 0, leading: 0 };
    fillFontMetrics(view.paintT, metrics, false);
    expect(metrics.ascent).toBeCloseTo(-67.37231, 4);
    fillFontMetrics(view.paintT, metrics, true);
    expect(metrics).toEqual({ top: -79, ascent: -67, descent: 14, bottom: 18, leading: 0 });
    expect(view.textHeight(1)).toBe(97);
    expect(view.textHeight(3)).toBe(259);
    view.includePad = false;
    expect(view.textHeight(3)).toBe(243);
  });

  test("Paint selects the nearest system face without promoting every bold style to 700", () => {
    const paint = new JPaint(); paint.textSize = 18;
    for (const weight of [500, 600]) {
      paint.tf = mkTypeface("Roboto, sans-serif", weight >= 600, false, weight);
      expect(paint.font()).toBe("500 18px Roboto Medium, Noto Emoji, Noto Emoji Flags, sans-serif");
    }
    paint.tf = mkTypeface("custom-family", true, false, 900);
    expect(paint.font()).toBe("900 18px custom-family, Noto Emoji, Noto Emoji Flags, sans-serif");
    paint.tf = mkTypeface("Roboto, sans-serif", false, false, 400);
    paint.fakeBold = true;
    expect(paint.font()).toBe("700 18px Roboto, Noto Emoji, Noto Emoji Flags, sans-serif");
  });

  test("system Paint metrics retain Android fractions before integer rounding", async () => {
    const paint = new JPaint(); paint.textSize = 48;
    const metrics = { top: 0, ascent: 0, descent: 0, bottom: 0, leading: 0 };
    expect(fillFontMetrics(paint, metrics, false)).toBe(56.25);
    expect(metrics).toEqual({ top: -50.6953125, ascent: -44.53125, descent: 11.71875, bottom: 13.0078125, leading: 0 });
    expect(await vcall(paint, "getFontSpacing", "()F")).toBe(56.25);
    expect(fillFontMetrics(paint, metrics, true)).toBe(57);
    expect(metrics).toEqual({ top: -51, ascent: -45, descent: 12, bottom: 14, leading: 0 });
  });
});

describe("gl-matrix", () => {
  rt.linkNatives();
  const matrix = rt.link("android/opengl/Matrix").ctor;
  test("invertM handles a perspective transform, overlapping arrays and singular input", async () => {
    const source = Float32Array.of(2, 1, 0, 1, 0, 3, 1, 0, 1, 0, 4, 1, 5, 6, 7, 1);
    const inverse = new Float32Array(20); inverse.set(source, 2);
    expect(await vcall(matrix, "invertM", "([FI[FI)Z", inverse, 0, inverse, 2)).toBe(1);
    const product = new Float32Array(16);
    await vcall(matrix, "multiplyMM", "([FI[FI[FI)V", product, 0, source, 0, inverse, 0);
    for (let i = 0; i < 16; i++) expect(product[i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 5);
    const before = inverse.slice();
    expect(await vcall(matrix, "invertM", "([FI[FI)Z", inverse, 0, new Float32Array(16), 0)).toBe(0);
    expect(inverse).toEqual(before);
  });

  test("perspectiveM maps the frustum to clip space and preserves the output range", async () => {
    const projection = new Float32Array(20).fill(42);
    await vcall(matrix, "perspectiveM", "([FIFFFF)V", projection, 2, 90, 2, 1, 11);
    expect([...projection.slice(0, 2), ...projection.slice(18)]).toEqual([42, 42, 42, 42]);
    const clip = new Float32Array(4);
    for (const [point, expected] of [
      [[2, 1, -1, 1], [1, 1, -1]],
      [[22, 11, -11, 1], [1, 1, 1]],
      [[0, 0, -2, 1], [0, 0, 0.1]],
    ]) {
      await vcall(matrix, "multiplyMV", "([FI[FI[FI)V", clip, 0, projection, 2, Float32Array.from(point), 0);
      for (let i = 0; i < 3; i++) expect(clip[i] / clip[3]).toBeCloseTo(expected[i], 6);
    }
  });
  test("setLookAtM moves the eye to the origin and aligns its viewing direction", async () => {
    const view = new Float32Array(18).fill(42), result = new Float32Array(4);
    await vcall(matrix, "setLookAtM", "([FIFFFFFFFFF)V", view, 1, 3, 4, 5, 4, 4, 5, 0, 2, 0);
    expect([view[0], view[17]]).toEqual([42, 42]);
    for (const [point, expected] of [
      [[3, 4, 5, 1], [0, 0, 0, 1]],
      [[4, 4, 5, 1], [0, 0, -1, 1]],
      [[3, 5, 5, 1], [0, 1, 0, 1]],
    ]) {
      await vcall(matrix, "multiplyMV", "([FI[FI[FI)V", result, 0, view, 1, Float32Array.from(point), 0);
      for (let i = 0; i < 4; i++) expect(result[i]).toBeCloseTo(expected[i], 6);
    }
  });
});

describe("imageview-alpha", () => {
  rt.linkNatives();

  test("ImageView image alpha applies to the drawable and survives replacement", async () => {
    const view = new JImageView();
    const first = new JDrawable();
    await vcall(view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", first);
    await vcall(view, "setImageAlpha", "(I)V", 64);
    expect(first.alpha).toBe(64);
    expect(await vcall(view, "getImageAlpha", "()I")).toBe(64);
    expect(view.alphaV).toBe(1);

    const replacement = new JDrawable();
    await vcall(view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", replacement);
    expect(replacement.alpha).toBe(64);
    await vcall(view, "setAlpha", "(I)V", 255);
    expect(replacement.alpha).toBe(255);
  });
});

describe("lighting-color-filter", () => {
  rt.linkNatives();

  test("lighting filters retain alpha and update an attached paint's RGB transform", async () => {
    const filter = await newObj("android/graphics/LightingColorFilter", "(II)V", 0x0080ff00, 0xff104020);
    const paint = rt.make("android/graphics/Paint");
    if (!(paint instanceof JPaint)) throw new Error("Invalid Paint");
    await vcall(paint, "setColorFilter", "(Landroid/graphics/ColorFilter;)Landroid/graphics/ColorFilter;", filter);
    expect(await vcall(filter, "getColorMultiply", "()I")).toBe(0x0080ff00);
    expect(await vcall(filter, "getColorAdd", "()I")).toBe(0xff104020);
    expect(matrixColor(paint.filterMatrix!, 0x8080ff80) >>> 0).toBe(0x8050ff20);
    await vcall(filter, "setColorMultiply", "(I)V", 0xffffffff);
    await vcall(filter, "setColorAdd", "(I)V", 0);
    expect(matrixColor(paint.filterMatrix!, 0x8080ff80) >>> 0).toBe(0x8080ff80);
  });
});

describe("matrix", () => {
  rt.linkNatives();

  test("Matrix.set copies independently and null restores identity", async () => {
    const source = await newObj("android/graphics/Matrix", "()V");
    const target = await newObj("android/graphics/Matrix", "()V");
    await vcall(source, "setTranslate", "(FF)V", 3, 4);
    await vcall(target, "set", "(Landroid/graphics/Matrix;)V", source);
    await vcall(source, "reset", "()V");
    const points = new Float32Array([1, 2]);
    await vcall(target, "mapPoints", "([F)V", points);
    expect([...points]).toEqual([4, 6]);
    await vcall(target, "set", "(Landroid/graphics/Matrix;)V", null);
    expect(await vcall(target, "isIdentity", "()Z")).toBe(1);
    await vcall(target, "mapPoints", "([F)V", points);
    expect([...points]).toEqual([4, 6]);
  });

  test("Matrix skew maps points around the requested pivot", async () => {
    const matrix = await newObj("android/graphics/Matrix", "()V");
    await vcall(matrix, "setSkew", "(FFFF)V", 2, 3, 10, 20);
    const points = new Float32Array([4, 5, 10, 20]);
    await vcall(matrix, "mapPoints", "([F)V", points);
    expect([...points]).toEqual([-26, -13, 10, 20]);
  });

  test("Matrix.mapRect writes a separate destination and reports non-rectangular transforms", async () => {
    const matrix = await newObj("android/graphics/Matrix", "()V");
    const source = await newObj("android/graphics/RectF", "(FFFF)V", 1, 2, 3, 4);
    const destination = await newObj("android/graphics/RectF", "(FFFF)V", 0, 0, 0, 0);
    await vcall(matrix, "setTranslate", "(FF)V", 5, 7);
    expect(await vcall(matrix, "mapRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;)Z", destination, source)).toBe(1);
    expect([destination.left, destination.top, destination.right, destination.bottom]).toEqual([6, 9, 8, 11]);
    expect([source.left, source.top, source.right, source.bottom]).toEqual([1, 2, 3, 4]);
    await vcall(matrix, "setRotate", "(F)V", 45);
    expect(await vcall(matrix, "mapRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;)Z", destination, source)).toBe(0);
  });
});

describe("matrix-fit", () => {
  rt.linkNatives();
  const fit = (name: string) => (rt.link("android/graphics/Matrix$ScaleToFit").ctor as any)[mangleStaticField(name)];
  const rect = (l: number, t: number, r: number, b: number) => newObj("android/graphics/RectF", "(FFFF)V", l, t, r, b);

  test("Matrix.setRectToRect maps the source onto the destination per ScaleToFit", async () => {
    const m = await newObj("android/graphics/Matrix", "()V");
    const src = await rect(0, 0, 100, 50), dst = await rect(10, 10, 210, 210);
    expect(await vcall(m, "setRectToRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;Landroid/graphics/Matrix$ScaleToFit;)Z", src, dst, fit("FILL"))).toBe(1);
    expect(m.m).toEqual([2, 0, 0, 4, 10, 10]);
    await vcall(m, "setRectToRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;Landroid/graphics/Matrix$ScaleToFit;)Z", src, dst, fit("CENTER"));
    expect(m.m).toEqual([2, 0, 0, 2, 10, 60]);
    await vcall(m, "setRectToRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;Landroid/graphics/Matrix$ScaleToFit;)Z", src, dst, fit("END"));
    expect(m.m).toEqual([2, 0, 0, 2, 10, 110]);
    expect(await vcall(m, "setRectToRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;Landroid/graphics/Matrix$ScaleToFit;)Z", await rect(0, 0, 0, 5), dst, fit("START"))).toBe(0);
    expect(m.m).toEqual([1, 0, 0, 1, 0, 0]);
  });

  test("Paint.setARGB packs the channels", async () => {
    const p = await newObj("android/graphics/Paint", "()V");
    await vcall(p, "setARGB", "(IIII)V", 0x80, 0x11, 0x22, 0x33);
    expect(await vcall(p, "getColor", "()I")).toBe(0x80112233 | 0);
  });
});

describe("scale-drawable", () => {
  rt.linkNatives();

  test("ScaleDrawable resizes its child by level and gravity and awaits virtual drawing", async () => {
    const child = rt.make("android/graphics/drawable/Drawable");
    if (!(child instanceof JDrawable)) throw new Error("Invalid drawable");
    const events: string[] = [];
    Object.assign(child, {
      [mangleMethod("onBoundsChange", "(Landroid/graphics/Rect;)V")]: async () => { await Promise.resolve(); events.push("bounds"); },
      [mangleMethod("draw", "(Landroid/graphics/Canvas;)V")]: async () => { await Promise.resolve(); events.push("draw"); },
    });
    const scaled = await newObj("android/graphics/drawable/ScaleDrawable", "(Landroid/graphics/drawable/Drawable;IFF)V", child, 85, 1, 0.5);
    await vcall(scaled, "setBounds", "(IIII)V", 10, 20, 110, 100);
    await vcall(scaled, "draw", "(Landroid/graphics/Canvas;)V", null);
    expect(events).not.toContain("draw");
    await vcall(scaled, "setLevel", "(I)Z", 5000);
    expect(child.bounds).toMatchObject({ left: 60, top: 40, right: 110, bottom: 100 });
    expect(child.level).toBe(5000);
    expect(events.at(-1)).toBe("bounds");
    await vcall(scaled, "draw", "(Landroid/graphics/Canvas;)V", null);
    expect(events.at(-1)).toBe("draw");
    await vcall(scaled, "setLevel", "(I)Z", 10000);
    expect(child.bounds).toMatchObject({ left: 10, top: 20, right: 110, bottom: 100 });
  });
});

describe("transition-drawable", () => {
  class Child extends JDrawable {
    drawn: number[] = [];
    async paint() { await Promise.resolve(); this.drawn.push(this.alpha); }
  }
  rt.register({ name: "test/TransitionChild", ctor: Child, sup: "android/graphics/drawable/Drawable", methods: {
    "draw(Landroid/graphics/Canvas;)V": function (this: Child) { return this.paint(); },
  } });
  rt.linkNatives();
  test("transitions crossfade, reverse from the current alpha and restore child alpha", async () => {
    let now = 1000;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      const a = rt.make("test/TransitionChild") as Child, b = rt.make("test/TransitionChild") as Child;
      const d = await newObj("android/graphics/drawable/TransitionDrawable", "([Landroid/graphics/drawable/Drawable;)V", [a, b]);
      const draw = () => vcall(d, "draw", "(Landroid/graphics/Canvas;)V", null);
      await vcall(d, "setCrossFadeEnabled", "(Z)V", 1);
      await vcall(d, "startTransition", "(I)V", 100);
      await draw(); now += 50; await draw();
      expect(a.drawn).toEqual([255, 128]); expect(b.drawn).toEqual([127]);
      expect([a.alpha, b.alpha]).toEqual([255, 255]);
      await vcall(d, "reverseTransition", "(I)V", 999);
      await draw(); now += 50; await draw();
      expect(a.drawn.at(-1)).toBe(255);
      expect(b.drawn).toEqual([127, 127]);
      await vcall(d, "startTransition", "(I)V", 100);
      await draw(); now += 100; await draw();
      expect(b.drawn.at(-1)).toBe(255);
      const count = b.drawn.length;
      await vcall(d, "resetTransition", "()V"); await draw();
      expect(b.drawn.length).toBe(count);
      expect(a.drawn.at(-1)).toBe(255);
    } finally { clock.mockRestore(); }
  });
});

describe("typed-array-font", () => {
  rt.linkNatives();

  test("TypedArray resolves referenced font resources", async () => {
    const bytes = new Uint8Array(await Bun.file("apks/Resy.apk").arrayBuffer());
    const archive = await parsePackageArchive(bytes);
    const id = archive.res.idFor("font", "fontawesome", archive.pkg);
    expect(id).not.toBe(0);
    const typed = new JTypedArray();
    typed.res = archive.res;
    typed.vals = [{ t: TV.REFERENCE, d: id }];
    expect(await vcall(typed, "getFont", "(I)Landroid/graphics/Typeface;", 0)).not.toBeNull();
    typed.vals = [null];
    expect(await vcall(typed, "getFont", "(I)Landroid/graphics/Typeface;", 0)).toBeNull();
  });
});
