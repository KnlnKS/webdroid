import { expect, test, afterAll, beforeAll, describe } from "bun:test";
import "../src/natives";
import { matrixColor } from "../src/android/graphics";
import { NativePaint, newPaint, paintOf, setPaintTypeface } from "../src/android/paint";
import { typefaceOf } from "../src/android/fonts";
import { declaredField } from "../src/jvm/runtime";
import { canvasOver, canvasOf, locateDrawnText } from "../src/android/canvas";
import { NativePath, nativePathOf, pathIsConvex } from "../src/android/path";
import { rt } from "../src/jvm/runtime";
import { mangleMethod, mangleStaticField } from "../src/jvm/abi";
import { newObj, linkInit, vcall, vcallOn, curThread, JThread, enumName } from "../src/jvm/natives/jlang";
import { JTextView } from "../src/android/textview";
import { JView, JViewGroup, measureView, makeSpec, MS_AT_MOST } from "../src/android/view";
import { ST } from "../src/android/drawable";
import { JImageView } from "../src/android/imageview";
import { parsePackageArchive } from "../src/android/packagearchive";
import { recordingContext, replay, replayWithSemantics } from "../src/android/recording";
import { appResources, loadSystemFonts, loadFrameworkJar, scall } from "./java";

beforeAll(loadSystemFonts);

describe("canvas-text", () => {
  rt.linkNatives();
  beforeAll(loadFrameworkJar);

  const canvas = () => canvasOver({
    fillText() {}, fillRect() {},
    getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 }; },
  } as unknown as OffscreenCanvasRenderingContext2D, 100, 100);
  const semanticOwner = () => ({ drawnText: null as string[] | null, drawnTextPoints: null as Float32Array | null, drawnTextCount: 0 });

  test("Canvas records custom-drawn text for semantic lookup", async () => {
    const cv = canvas(), paint = newPaint(), { textSize } = paintOf(paint);
    const owner = semanticOwner();
    canvasOf(cv).semanticOwner = owner;

    await vcall(cv, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "first", 0, 0, paint);
    await vcall(cv, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "second", 0, 20, paint);

    expect(owner.drawnText).toEqual(["first", "second"]);
    expect(owner.drawnTextPoints![0]).toBe(10 + textSize);
    expect(owner.drawnTextPoints![1]).toBeCloseTo(20 - textSize * 0.3);
    expect(owner.drawnTextPoints![2]).toBe(10 + textSize);
    expect(owner.drawnTextPoints![3]).toBeCloseTo(40 - textSize * 0.3);
  });

  test("Canvas maps layered semantic text through its parent transform", async () => {
    const cv = canvas(), paint = newPaint(), { textSize } = paintOf(paint);
    const owner = semanticOwner();
    canvasOf(cv).semanticBase = { a: 1, b: 0, c: 0, d: 1, e: 100, f: 200 } as DOMMatrix;
    canvasOf(cv).semanticOwner = owner;

    await vcall(cv, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "layered", 0, 0, paint);

    expect(owner.drawnTextPoints![0]).toBe(110 + textSize);
    expect(owner.drawnTextPoints![1]).toBeCloseTo(220 - textSize * 0.3);
  });

  test("text recorded inside a saveLayer keeps the replaying canvas's semantic owner", async () => {
    // a raster whose context accepts every call, so the layer opens and composites
    const stub = (canvas: object) => new Proxy({ canvas, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) } as Record<string | symbol, unknown>,
      { get: (t, k) => k in t ? t[k] : () => {} }) as unknown as OffscreenCanvasRenderingContext2D;
    const g = globalThis as { OffscreenCanvas?: unknown };
    const saved = g.OffscreenCanvas;
    g.OffscreenCanvas = class { width = 100; height = 100; getContext() { return stub(this); } };
    try {
      const ops: unknown[] = [];
      const cv = canvasOver(recordingContext(stub({ width: 1, height: 1 }), ops), 100, 100, true), paint = newPaint();
      await vcall(cv, "saveLayer", "(FFFFLandroid/graphics/Paint;)I", 0, 0, 50, 50, null);
      await vcall(cv, "drawText", "(Ljava/lang/String;FFLandroid/graphics/Paint;)V", "inside", 0, 0, paint);
      await vcall(cv, "restore", "()V");
      const target = stub({ width: 100, height: 100 }), outer = canvasOf(canvasOver(target, 100, 100)), owner = semanticOwner();
      outer.semanticOwner = owner;
      replayWithSemantics(outer, () => replay(target, ops));
      expect(owner.drawnText).toEqual(["inside"]);
    } finally { g.OffscreenCanvas = saved; }
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

describe("drawable-size-overrides", () => {
  rt.linkNatives();
  async function drawable() {
    const d = await newObj("android/graphics/drawable/ColorDrawable", "()V"), threads: JThread[] = [];
    Object.assign(d, {
      [mangleMethod("getIntrinsicWidth", "()I")]: async () => { threads.push(curThread); await Promise.resolve(); return 84; },
      [mangleMethod("getIntrinsicHeight", "()I")]: () => { threads.push(curThread); return 48; },
    });
    return { d, threads };
  }
  test("ImageView measures virtual drawable dimensions and caches them for drawing", async () => {
    const { d, threads } = await drawable(), view = rt.make("android/widget/ImageView");
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
    const d = await newObj("android/graphics/drawable/ColorDrawable", "()V");
    for (const [name, desc, args] of [
      ["setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", [d]],
      ["setColorFilter", "(I)V", [0xff00ff00]],
      ["clearColorFilter", "()V", []],
      ["setImageBitmap", "(Landroid/graphics/Bitmap;)V", [null]],
      ["setImageResource", "(I)V", [0]],
    ] satisfies [string, string, unknown[]][]) {
      targets.length = 0;
      await vcall(view, name, desc, ...args);
      expect([...new Set(targets)]).toEqual([view]);
    }
  });
  test("ImageView retains filters across replacement and invokes drawable overrides after mutation", async () => {
    const view = rt.make("android/widget/ImageView"), thread = new JThread();
    const events: [string, unknown, JThread][] = [];
    const make = async () => {
      const d = await newObj("android/graphics/drawable/ColorDrawable", "()V");
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
    expect(await vcall(filter, "getColor", "()I")).toBe(-65536);
    expect(enumName(await vcall(filter, "getMode", "()Landroid/graphics/PorterDuff$Mode;"))).toBe("SRC_ATOP");
    expect(events).toEqual([]);
    for (const d of [await make(), await make()]) {
      await vcallOn(thread, view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", d);
      expect(events.splice(0)).toEqual([["mutate", d, thread], ["filter", filter, thread]]);
    }
    const d = await vcall(view, "getDrawable", "()Landroid/graphics/drawable/Drawable;");
    await vcallOn(thread, view, "clearColorFilter", "()V");
    expect(events.splice(0)).toEqual([["mutate", d, thread], ["filter", null, thread]]);
    expect(await vcall(view, "getColorFilter", "()Landroid/graphics/ColorFilter;")).toBeNull();
    const next = await make();
    await vcallOn(thread, view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", next);
    expect(events).toEqual([["mutate", next, thread], ["filter", null, thread]]);
  });
  test("suggested view minimums respect virtual background dimensions", async () => {
    const { d } = await drawable(), view = rt.make("android/widget/TextView");
    if (!(view instanceof JView)) throw new Error("Invalid view delegate");
    await vcall(view, "setBackground", "(Landroid/graphics/drawable/Drawable;)V", d);
    expect(await vcall(view, "getSuggestedMinimumWidth", "()I")).toBe(84);
    expect(await vcall(view, "getSuggestedMinimumHeight", "()I")).toBe(48);
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
  const TF = "android/graphics/Typeface";
  /** a Java FontMetrics' (or FontMetricsInt's) top, ascent, descent, bottom and leading */
  const metrics = (fm: object, cls = "FontMetrics") =>
    ["top", "ascent", "descent", "bottom", "leading"].map((k) => (fm as Record<string, number>)[declaredField(`android/graphics/Paint$${cls}`, k)]);

  test("loaded font metrics preserve fractional ascenders and round padded bounds outward", async () => {
    // Roboto Bold's own tables, as an app's font: hhea 2146/-555, head yMax/yMin 2163/-555 over 2048 units
    const bytes = new Uint8Array(await Bun.file("vendor/fonts/Roboto-Bold.ttf").arrayBuffer()), BB = "Ljava/nio/ByteBuffer;";
    const buffer = await scall("java/nio/ByteBuffer", "allocateDirect", `(I)${BB}`, bytes.length);
    await vcall(buffer, "put", `([B)${BB}`, new Int8Array(bytes.buffer));
    const font = await vcall(await newObj("android/graphics/fonts/Font$Builder", `(${BB})V`, buffer), "build", "()Landroid/graphics/fonts/Font;");
    const family = await vcall(await newObj("android/graphics/fonts/FontFamily$Builder", "(Landroid/graphics/fonts/Font;)V", font), "build", "()Landroid/graphics/fonts/FontFamily;");
    const view = new JTextView();
    await setPaintTypeface(view.paintT, await vcall(await newObj(`${TF}$CustomFallbackBuilder`, "(Landroid/graphics/fonts/FontFamily;)V", family), "build", `()L${TF};`));
    view.tp.textSize = 68;
    expect(await vcall(view.paintT, "ascent", "()F")).toBeCloseTo(-71.25391, 4);
    expect(metrics(await vcall(view.paintT, "getFontMetricsInt", "()Landroid/graphics/Paint$FontMetricsInt;"), "FontMetricsInt")).toEqual([-72, -71, 18, 19, 0]);
    expect(view.textHeight(1)).toBe(91);
    expect(view.textHeight(3)).toBe(269);
    view.includePad = false;
    expect(view.textHeight(3)).toBe(267);
  });

  test("Paint draws the face minikin selects, faking bold two grades short", async () => {
    const paint = new NativePaint(); paint.textSize = 18;
    const weighted = async (weight: number) => typefaceOf(await scall(TF, "create", `(L${TF};IZ)L${TF};`, null, weight, 0));
    // 600 ties Medium and Bold; the earlier face in fonts.xml wins
    for (const weight of [500, 600]) {
      paint.tf = await weighted(weight);
      expect(paint.font()).toBe("500 18px Roboto, Noto Emoji, Noto Emoji Flags, sans-serif");
    }
    paint.tf = await weighted(900);
    expect(paint.font()).toBe("700 18px Roboto, Noto Emoji, Noto Emoji Flags, sans-serif");
    expect(paint.faked()).toBe(true);
    paint.tf = null;
    paint.setFlag(0x20, true);
    expect(paint.font()).toBe("700 18px Roboto, Noto Emoji, Noto Emoji Flags, sans-serif");
    expect(paint.faked()).toBe(false);
  });

  test("system Paint metrics retain Android fractions before integer rounding", async () => {
    const paint = newPaint();
    await vcall(paint, "setTextSize", "(F)V", 48);
    const fm = await newObj("android/graphics/Paint$FontMetrics", "()V"), fi = await newObj("android/graphics/Paint$FontMetricsInt", "()V");
    expect(await vcall(paint, "getFontMetrics", "(Landroid/graphics/Paint$FontMetrics;)F", fm)).toBe(56.25);
    expect(metrics(fm)).toEqual([-50.6953125, -44.53125, 11.71875, 13.0078125, 0]);
    expect(await vcall(paint, "getFontSpacing", "()F")).toBe(56.25);
    expect(await vcall(paint, "getFontMetricsInt", "(Landroid/graphics/Paint$FontMetricsInt;)I", fi)).toBe(57);
    expect(metrics(fi, "FontMetricsInt")).toEqual([-51, -45, 12, 14, 0]);
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
    const drawable = async () => {
      const d = await newObj("android/graphics/drawable/ColorDrawable", "()V"), alphas: number[] = [];
      Object.assign(d, {
        [mangleMethod("setAlpha", "(I)V")]: (a: number) => { alphas.push(a); },
        [mangleMethod("mutate", "()Landroid/graphics/drawable/Drawable;")]: () => d,
      });
      return { d, alphas };
    };
    const first = await drawable();
    await vcall(view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", first.d);
    await vcall(view, "setImageAlpha", "(I)V", 64);
    expect(first.alphas).toEqual([64]);
    expect(await vcall(view, "getImageAlpha", "()I")).toBe(64);
    expect(view.alphaV).toBe(1);

    const replacement = await drawable();
    await vcall(view, "setImageDrawable", "(Landroid/graphics/drawable/Drawable;)V", replacement.d);
    expect(replacement.alphas).toEqual([64]);
    await vcall(view, "setAlpha", "(I)V", 255);
    expect(replacement.alphas).toEqual([64, 255]);
  });
});

describe("lighting-color-filter", () => {
  rt.linkNatives();

  test("lighting filters retain alpha and update an attached paint's RGB transform", async () => {
    const filter = await newObj("android/graphics/LightingColorFilter", "(II)V", 0x0080ff00, 0xff104020);
    const paint = newPaint();
    await vcall(paint, "setColorFilter", "(Landroid/graphics/ColorFilter;)Landroid/graphics/ColorFilter;", filter);
    expect(await vcall(filter, "getColorMultiply", "()I")).toBe(0x0080ff00);
    expect(await vcall(filter, "getColorAdd", "()I")).toBe(0xff104020);
    expect(matrixColor(paintOf(paint).colorFilter!.matrix!, 0x8080ff80) >>> 0).toBe(0x8050ff20);
    await vcall(filter, "setColorMultiply", "(I)V", 0xffffffff);
    await vcall(filter, "setColorAdd", "(I)V", 0);
    expect(matrixColor(paintOf(paint).colorFilter!.matrix!, 0x8080ff80) >>> 0).toBe(0x8080ff80);
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
  const values = async (m: unknown) => { const v = new Float32Array(9); await vcall(m, "getValues", "([F)V", v); return [...v]; };
  const fit = async (name: string) => ((await linkInit("android/graphics/Matrix$ScaleToFit")).ctor as any)[mangleStaticField(name)];
  const rect = (l: number, t: number, r: number, b: number) => newObj("android/graphics/RectF", "(FFFF)V", l, t, r, b);

  test("Matrix.setRectToRect maps the source onto the destination per ScaleToFit", async () => {
    const m = await newObj("android/graphics/Matrix", "()V");
    const src = await rect(0, 0, 100, 50), dst = await rect(10, 10, 210, 210);
    expect(await vcall(m, "setRectToRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;Landroid/graphics/Matrix$ScaleToFit;)Z", src, dst, await fit("FILL"))).toBe(1);
    expect(await values(m)).toEqual([2, 0, 10, 0, 4, 10, 0, 0, 1]);
    await vcall(m, "setRectToRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;Landroid/graphics/Matrix$ScaleToFit;)Z", src, dst, await fit("CENTER"));
    expect(await values(m)).toEqual([2, 0, 10, 0, 2, 60, 0, 0, 1]);
    await vcall(m, "setRectToRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;Landroid/graphics/Matrix$ScaleToFit;)Z", src, dst, await fit("END"));
    expect(await values(m)).toEqual([2, 0, 10, 0, 2, 110, 0, 0, 1]);
    expect(await vcall(m, "setRectToRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;Landroid/graphics/Matrix$ScaleToFit;)Z", await rect(0, 0, 0, 5), dst, await fit("START"))).toBe(0);
    expect(await values(m)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  test("Paint.setARGB packs the channels", async () => {
    const p = await newObj("android/graphics/Paint", "()V");
    await vcall(p, "setARGB", "(IIII)V", 0x80, 0x11, 0x22, 0x33);
    expect(await vcall(p, "getColor", "()I")).toBe(0x80112233 | 0);
  });
});

describe("path-copy", () => {
  rt.linkNatives();
  const fillType = async (name: string) => ((await linkInit("android/graphics/Path$FillType")).ctor as any)[mangleStaticField(name)];

  test("path copies retain contours and fill rules without sharing mutable geometry", async () => {
    const source = await newObj("android/graphics/Path", "()V");
    await vcall(source, "moveTo", "(FF)V", 10, 20);
    await vcall(source, "lineTo", "(FF)V", 30, 40);
    await vcall(source, "setFillType", "(Landroid/graphics/Path$FillType;)V", await fillType("INVERSE_EVEN_ODD"));
    expect(await vcall(source, "getFillType", "()Landroid/graphics/Path$FillType;")).toBe(await fillType("INVERSE_EVEN_ODD"));
    const copy = await newObj("android/graphics/Path", "(Landroid/graphics/Path;)V", source);
    const target = await newObj("android/graphics/Path", "()V");
    await vcall(target, "set", "(Landroid/graphics/Path;)V", copy);
    await vcall(target, "set", "(Landroid/graphics/Path;)V", target);
    await vcall(target, "rLineTo", "(FF)V", 5, 6);
    const t = nativePathOf(target);
    expect(t.ops.at(-1)).toEqual(["l", 35, 46]);
    await vcall(target, "close", "()V");
    expect([t.pen.x, t.pen.y, t.fillRule, t.inverseFill]).toEqual([10, 20, "evenodd", true]);
    await vcall(copy, "offset", "(FF)V", 100, 200);
    expect(nativePathOf(source).ops).toEqual([["m", 10, 20], ["l", 30, 40]]);
    expect(t.ops.slice(0, 2)).toEqual(nativePathOf(source).ops);
  });

  test("appending a transformed path preserves independent geometry and its current contour", async () => {
    const source = await newObj("android/graphics/Path", "()V");
    await vcall(source, "moveTo", "(FF)V", 1, 2);
    await vcall(source, "lineTo", "(FF)V", 3, 4);
    const target = await newObj("android/graphics/Path", "()V");
    const matrix = await newObj("android/graphics/Matrix", "()V");
    await vcall(matrix, "setValues", "([F)V", Float32Array.of(0, -1, 10, 1, 0, 20, 0, 0, 1));
    await vcall(target, "addPath", "(Landroid/graphics/Path;Landroid/graphics/Matrix;)V", source, matrix);
    await vcall(target, "rLineTo", "(FF)V", 5, 6);
    const t = nativePathOf(target);
    expect(t.ops).toEqual([["m", 8, 21], ["l", 6, 23], ["l", 11, 29]]);
    await vcall(target, "close", "()V");
    expect([t.pen.x, t.pen.y]).toEqual([8, 21]);
    await vcall(target, "addPath", "(Landroid/graphics/Path;)V", target);
    expect(t.ops.length).toBe(8);
    await vcall(target, "offset", "(FF)V", 1, 1);
    expect(t.ops[0]).toEqual(["m", 9, 22]);
    expect(nativePathOf(source).ops).toEqual([["m", 1, 2], ["l", 3, 4]]);
  });

  test("Path convexity follows control points, closure and contour boundaries", async () => {
    const path = new NativePath();
    expect(pathIsConvex(path)).toBe(true);
    path.ops = [["m", 0, 0], ["l", 10, 0]];
    expect(pathIsConvex(path)).toBe(true);
    path.ops.push(["l", 10, 10], ["l", 0, 10]);
    expect(pathIsConvex(path)).toBe(true);
    path.ops.push(["l", 5, 5]);
    expect(pathIsConvex(path)).toBe(false);
    path.ops = [["m", 0, 0], ["q", 10, 0, 10, 10], ["l", 0, 10], ["z"]];
    expect(pathIsConvex(path)).toBe(true);
    path.ops[1] = ["q", -10, 20, 10, 10];
    expect(pathIsConvex(path)).toBe(false);
    path.ops = [["rrect", 0, 0, 300, 200, 28, 28, 28, 28, 0, 0, 0, 0, 0]];
    expect(pathIsConvex(path)).toBe(true);
    path.transform(Float64Array.of(0, -1, 300, 1, 0, 0, 0, 0, 1));
    expect(pathIsConvex(path)).toBe(true);
    path.ops.push(["m", 900, 900]);
    expect(pathIsConvex(path)).toBe(true);
    path.ops.push(["l", 901, 900]);
    expect(pathIsConvex(path)).toBe(false);
    path.ops = [["m", 0, 3], ["l", 2, -3], ["l", -3, 1], ["l", 3, 1], ["l", -2, -3], ["z"]];
    expect(pathIsConvex(path)).toBe(false);
    path.ops = [["m", Infinity, 0]];
    expect(pathIsConvex(path)).toBe(false);
  });
});

describe("typed-array-font", () => {
  rt.linkNatives();

  test("Resources resolve referenced font resources", async () => {
    const bytes = new Uint8Array(await Bun.file("apks/Resy.apk").arrayBuffer());
    const archive = await parsePackageArchive(bytes);
    const id = archive.res.idFor("font", "fontawesome", archive.pkg);
    expect(id).not.toBe(0);
    const jres = await appResources(archive.res, "typed-array-font");
    expect(rt.iof(await vcall(jres, "getFont", "(I)Landroid/graphics/Typeface;", id), "android/graphics/Typeface")).toBe(1);
  });
});
