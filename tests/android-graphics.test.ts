import { expect, test, afterAll, beforeAll, describe } from "vite-plus/test";
import { readFileSync } from "node:fs";
import "../src/natives.ts";
import { edges } from "../src/android/graphics.ts";
import { matrixColor } from "../src/android/colorfilter.ts";
import { NativePaint, newPaint, paintOf } from "../src/android/paint.ts";
import { typefaceOf } from "../src/android/fonts.ts";
import { declaredField } from "../src/jvm/runtime.ts";
import { NativePath, nativePathOf, pathIsConvex } from "../src/android/path.ts";
import { canvasOver, canvasOf } from "../src/android/canvas.ts";
import { currentContext } from "../src/native/gl-context.ts";
import { NativeRenderNode } from "../src/android/rendernode.ts";
import { about, deviceBounds, localBounds, mapPoint, mul, rotateM, scaleM, translateM } from "../src/android/matrix.ts";
import { Transform } from "../src/android/recording.ts";
import { newObj, linkInit, vcall, iof, staticField, curThread } from "../src/jvm/natives/jentry.ts";
import { parsePackageArchive } from "../src/android/packagearchive.ts";
import { appResources, loadSystemFonts, scall, thrown } from "./java.ts";
import { startMainLooper } from "../src/android/mainloop.ts";

beforeAll(loadSystemFonts);

describe("egl14-query-context", () => {

  const originalOffscreenCanvas = Object.getOwnPropertyDescriptor(globalThis, "OffscreenCanvas");
  beforeAll(async () => {
    await startMainLooper();
    if (originalOffscreenCanvas) return;
    Object.defineProperty(globalThis, "OffscreenCanvas", {
      configurable: true,
      value: class {
        readonly width: number; readonly height: number;
        constructor(width: number, height: number) { this.width = width; this.height = height; }
      },
    });
  });
  afterAll(() => {
    if (!originalOffscreenCanvas) Reflect.deleteProperty(globalThis, "OffscreenCanvas");
  });

  test("EGL14 queries the created context's client version", async () => {
    const egl = await linkInit("android/opengl/EGL14");
    const display = await scall("android/opengl/EGL14", "eglGetDisplay", "(I)Landroid/opengl/EGLDisplay;", 0);
    await scall("android/opengl/EGL14", "eglInitialize", "(Landroid/opengl/EGLDisplay;[II[II)Z", display, new Int32Array(1), 0, new Int32Array(1), 0);
    const configs: unknown[] = [null];
    const count = new Int32Array(1);
    expect(await scall("android/opengl/EGL14", "eglChooseConfig", "(Landroid/opengl/EGLDisplay;[II[Landroid/opengl/EGLConfig;II[II)Z",
      display, new Int32Array([0x3038]), 0, configs, 0, 1, count, 0)).toBe(1);
    const noContext = egl.static("EGL_NO_CONTEXT");
    const context = await scall("android/opengl/EGL14", "eglCreateContext", "(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLConfig;Landroid/opengl/EGLContext;[II)Landroid/opengl/EGLContext;",
      display, configs[0], noContext, new Int32Array([0x3098, 3, 0x3038]), 0);
    const result = new Int32Array(2);
    expect(await scall("android/opengl/EGL14", "eglQueryContext", "(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLContext;I[II)Z",
      display, context, 0x3098, result, 1)).toBe(1);
    expect(result[1]).toBe(3);
    expect(await scall("android/opengl/EGL14", "eglQueryContext", "(Landroid/opengl/EGLDisplay;Landroid/opengl/EGLContext;I[II)Z",
      display, context, -1, result, 0)).toBe(0);
    expect(await scall("android/opengl/EGL14", "eglGetError", "()I")).toBe(0x3004);
  });
});

describe("egl10", () => {
  // framework.jar's EGLImpl, which EGLContext.getEGL() answers, over a display it has initialized
  const eglImpl = async () => {
    const egl = await newObj("com/google/android/gles_jni/EGLImpl", "()V");
    const display = await vcall(egl, "eglGetDisplay", "(Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLDisplay;", null);
    expect(await vcall(egl, "eglInitialize", "(Ljavax/microedition/khronos/egl/EGLDisplay;[I)Z", display, new Int32Array(2))).toBe(1);
    return { egl, display };
  };
  test("EGL10 returns configurations with their declared Java type", async () => {
    const { egl, display } = await eglImpl(), configs = [null], count = new Int32Array(1);
    expect(await vcall(egl, "eglGetDisplay", "(Ljava/lang/Object;)Ljavax/microedition/khronos/egl/EGLDisplay;", null)).toBe(display);
    expect(iof(display, "javax/microedition/khronos/egl/EGLDisplay")).toBe(true);
    expect(await vcall(egl, "eglChooseConfig", "(Ljavax/microedition/khronos/egl/EGLDisplay;[I[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z", display, new Int32Array([0x3038]), configs, 1, count)).toBe(1);
    expect(count[0]).toBe(1);
    expect(iof(configs[0], "javax/microedition/khronos/egl/EGLConfig")).toBe(true);
  });

  test("EGL10 rejects the no-display handle", async () => {
    const { egl } = await eglImpl();
    const noDisplay = await staticField("javax/microedition/khronos/egl/EGL10", "EGL_NO_DISPLAY");
    const configs = [null], count = new Int32Array([-1]);
    expect(await vcall(egl, "eglChooseConfig", "(Ljavax/microedition/khronos/egl/EGLDisplay;[I[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z", noDisplay, new Int32Array([0x3038]), configs, 1, count)).toBe(0);
    expect([configs[0], count[0]]).toEqual([null, 0]);
    expect(await vcall(egl, "eglGetError", "()I")).toBe(0x3008);
  });

  test("EGL10 reports its no-context handle until a context is bound", async () => {
    const { egl, display } = await eglImpl();
    const none = await staticField("javax/microedition/khronos/egl/EGL10", "EGL_NO_CONTEXT"), noSurface = await staticField("javax/microedition/khronos/egl/EGL10", "EGL_NO_SURFACE");
    expect(none).not.toBeNull();
    expect(iof(none, "javax/microedition/khronos/egl/EGLContext")).toBe(true);
    expect(await vcall(egl, "eglGetCurrentContext", "()Ljavax/microedition/khronos/egl/EGLContext;")).toBe(none);
    expect(currentContext(curThread)).toBeNull();
    expect(await vcall(egl, "eglMakeCurrent", "(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLContext;)Z", display, noSurface, noSurface, none)).toBe(1);
    expect(currentContext(curThread)).toBeNull();
  });
});

describe("canvas-state", () => {
  beforeAll(startMainLooper);

  test("canvas root state rejects unmatched restores", async () => {
    let restores = 0;
    const context = {
      restore() { restores++; },
    } as unknown as OffscreenCanvasRenderingContext2D;
    const canvas = await canvasOver(context, 100, 100);

    expect(await thrown(() => vcall(canvas, "restore", "()V"))).toBe("java/lang/IllegalStateException: Underflow in restore - more restores than saves");
    expect(await thrown(() => vcall(canvas, "restoreToCount", "(I)V", 0))).toBe("java/lang/IllegalArgumentException: Underflow in restoreToCount - more restores than saves");
    expect(canvasOf(canvas).saveCount).toBe(1);
    expect(restores).toBe(0);
  });
});

describe("font-metrics", () => {
  const TF = "android/graphics/Typeface";
  /** a Java FontMetrics' (or FontMetricsInt's) top, ascent, descent, bottom and leading */
  const metrics = (fm: object, cls = "FontMetrics") =>
    ["top", "ascent", "descent", "bottom", "leading"].map((k) => (fm as Record<string, number>)[declaredField(`android/graphics/Paint$${cls}`, k)]);

  test("loaded font metrics preserve fractional ascenders and round integer metrics outward", async () => {
    // Noto Serif Bold's own tables, as an app's font: hhea 1900/-500, head yMax/yMin 2181/-571 over 2048 units
    const bytes = new Uint8Array(readFileSync("vendor/aosp/system/fonts/NotoSerif-Bold.ttf")), BB = "Ljava/nio/ByteBuffer;";
    const buffer = await scall("java/nio/ByteBuffer", "allocateDirect", `(I)${BB}`, bytes.length);
    await vcall(buffer, "put", `([B)${BB}`, new Int8Array(bytes.buffer));
    const font = await vcall(await newObj("android/graphics/fonts/Font$Builder", `(${BB})V`, buffer), "build", "()Landroid/graphics/fonts/Font;");
    const family = await vcall(await newObj("android/graphics/fonts/FontFamily$Builder", "(Landroid/graphics/fonts/Font;)V", font), "build", "()Landroid/graphics/fonts/FontFamily;");
    const paint = await newPaint("android/text/TextPaint");
    await vcall(paint, "setTypeface", `(L${TF};)L${TF};`, await vcall(await newObj(`${TF}$CustomFallbackBuilder`, "(Landroid/graphics/fonts/FontFamily;)V", family), "build", `()L${TF};`));
    (await paintOf(paint)).textSize = 68;
    expect(await vcall(paint, "ascent", "()F")).toBeCloseTo(-63.08594, 4);
    expect(metrics(await vcall(paint, "getFontMetricsInt", "()Landroid/graphics/Paint$FontMetricsInt;"), "FontMetricsInt")).toEqual([-73, -63, 17, 19, 0]);
  });

  test("Paint draws the face minikin selects, faking bold two grades short", async () => {
    const paint = new NativePaint();
    const weighted = async (family: string, weight: number) => typefaceOf(await scall(TF, "create", `(L${TF};IZ)L${TF};`,
      await scall(TF, "create", `(Ljava/lang/String;I)L${TF};`, family, 0), weight, 0));
    const primary = () => { const f = paint.primary(); return [f.font.path.slice(14), f.fakery, f.weight]; };
    // serif's static faces: the nearer grade, then bold faked from 700 at 900
    for (const [weight, want] of [[500, ["NotoSerif-Regular.ttf", 0, -1]], [600, ["NotoSerif-Bold.ttf", 0, -1]], [900, ["NotoSerif-Bold.ttf", 1, -1]]] as const) {
      paint.tf = await weighted("serif", weight);
      expect(primary()).toEqual([...want]);
    }
    // the variable Roboto takes the weight on its wght axis
    paint.tf = await weighted("sans-serif", 900);
    expect(primary()).toEqual(["Roboto-Regular.ttf", 0, 900]);
  });

  test("system Paint metrics retain Android fractions before integer rounding", async () => {
    const paint = await newPaint();
    await vcall(paint, "setTextSize", "(F)V", 48);
    const fm = await newObj("android/graphics/Paint$FontMetrics", "()V"), fi = await newObj("android/graphics/Paint$FontMetricsInt", "()V");
    expect(await vcall(paint, "getFontMetrics", "(Landroid/graphics/Paint$FontMetrics;)F", fm)).toBe(56.25);
    expect(metrics(fm)).toEqual([-50.6953125, -44.53125, 11.71875, 13.0078125, 0]);
    expect(await vcall(paint, "getFontSpacing", "()F")).toBe(56.25);
    expect(await vcall(paint, "getFontMetricsInt", "(Landroid/graphics/Paint$FontMetricsInt;)I", fi)).toBe(57);
    expect(metrics(fi, "FontMetricsInt")).toEqual([-51, -45, 12, 14, 0]);
  });
});

describe("lighting-color-filter", () => {

  test("lighting filters retain alpha and update an attached paint's RGB transform", async () => {
    const filter = await newObj("android/graphics/LightingColorFilter", "(II)V", 0x0080ff00, 0xff104020);
    const paint = await newPaint();
    await vcall(paint, "setColorFilter", "(Landroid/graphics/ColorFilter;)Landroid/graphics/ColorFilter;", filter);
    expect(await vcall(filter, "getColorMultiply", "()I")).toBe(0x0080ff00);
    expect(await vcall(filter, "getColorAdd", "()I")).toBe(0xff104020 | 0);
    expect(matrixColor((await paintOf(paint)).colorFilter!.matrix!, 0x8080ff80) >>> 0).toBe(0x8050ff20);
    await vcall(filter, "setColorMultiply", "(I)V", 0xffffffff);
    await vcall(filter, "setColorAdd", "(I)V", 0);
    expect(matrixColor((await paintOf(paint)).colorFilter!.matrix!, 0x8080ff80) >>> 0).toBe(0x8080ff80);
  });
});

describe("matrix", () => {
  test("RenderNode composes rotation and scale about its implicit or explicit pivot", () => {
    const node = new NativeRenderNode(null);
    node.setSide("right", 100); node.setSide("bottom", 80);
    node.setTransform("rotation", 90); node.setTransform("tx", 7);
    node.setTransform("scaleX", 2); node.setTransform("scaleY", 3);
    node.updateMatrix();
    expect(mapPoint(node.transform!, 50, 40)).toEqual([57, 40]);
    expect(mapPoint(node.transform!, 0, 0)).toEqual([177, -60]);
    node.setPivot("pivotX", 10); node.setPivot("pivotY", 20);
    node.updateMatrix();
    expect(mapPoint(node.transform!, 10, 20)).toEqual([17, 20]);
    node.setTransform("rotationX", 30); node.updateMatrix();
    node.setTransform("rotationX", 0); node.setTransform("rotation", 0);
    node.setTransform("scaleX", 1); node.setTransform("scaleY", 1);
    node.updateMatrix();
    expect(mapPoint(node.transform!, 0, 0)).toEqual([7, 0]);
    const retained = node.transform;
    for (const [tx, ty, rotation, sx, sy, px, py] of [
      [0, -0, -0, -0, 1, 0, -0], [7.5, -13, 37, -2, 0.25, 11, -17],
      [1, 2, 0.01, 2, 3, 4, 5], [1, 2, 0.02, 2, 3, 4, 5],
      [3e38, -3e38, 180, 3e38, -3e38, 3e38, -3e38],
      [NaN, 0, 0, 1, 1, 0, 0], [0, Infinity, 0, 1, 1, 0, 0],
      [0, 0, Infinity, 1, 1, 0, 0], [0, 0, 0, -Infinity, 1, 0, 0],
      [0, 0, 0, 1, 1, Infinity, 0], [0, 0, 0, 1, 1, 0, 0],
    ]) {
      node.setTransform("tx", tx); node.setTransform("ty", ty); node.setTransform("rotation", rotation);
      node.setTransform("scaleX", sx); node.setTransform("scaleY", sy);
      node.setPivot("pivotX", px); node.setPivot("pivotY", py); node.updateMatrix();
      const expected = mul(mul(translateM(tx, ty), about(rotateM(rotation), px, py)), about(scaleM(sx, sy), px, py));
      expect(node.transform).toBe(retained);
      for (let i = 0; i < 9; i++) expect(Object.is(node.transform![i], expected[i])).toBe(true);
    }
  });


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
    expect(edges(destination)).toEqual({ left: 6, top: 9, right: 8, bottom: 11 });
    expect(edges(source)).toEqual({ left: 1, top: 2, right: 3, bottom: 4 });
    await vcall(matrix, "setRotate", "(F)V", 45);
    expect(await vcall(matrix, "mapRect", "(Landroid/graphics/RectF;Landroid/graphics/RectF;)Z", destination, source)).toBe(0);
  });
});

describe("matrix-fit", () => {
  const values = async (m: unknown) => { const v = new Float32Array(9); await vcall(m, "getValues", "([F)V", v); return [...v]; };
  const fit = async (name: string) => (await linkInit("android/graphics/Matrix$ScaleToFit")).static(name);
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

  test("a Display P3 ColorLong draws converted to sRGB", async () => {
    const p3 = await scall("android/graphics/ColorSpace", "get", "(I)Landroid/graphics/ColorSpace;", 7);
    const color = await scall("android/graphics/Color", "pack", "(FFFFLandroid/graphics/ColorSpace;)J", 0.5, 0.25, 0.75, 1, p3);
    const p = await newObj("android/graphics/Paint", "()V");
    await vcall(p, "setColor", "(J)V", color);
    // P3 (0.5, 0.25, 0.75) through linear light and the gamut matrix: sRGB (137, 59, 198)
    expect((await paintOf(p)).color >>> 0).toBe(0xff893bc6);
  });
});

describe("path-copy", () => {
  const fillType = async (name: string) => (await linkInit("android/graphics/Path$FillType")).static(name);

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
    path.moveTo(0, 0); path.lineTo(10, 0);
    expect(pathIsConvex(path)).toBe(true);
    path.lineTo(10, 10); path.lineTo(0, 10);
    expect(pathIsConvex(path)).toBe(true);
    path.lineTo(5, 5);
    expect(pathIsConvex(path)).toBe(false);
    const quad = (cx: number, cy: number) => { path.reset(); path.moveTo(0, 0); path.quadTo(cx, cy, 10, 10); path.lineTo(0, 10); path.close(); };
    quad(10, 0);
    expect(pathIsConvex(path)).toBe(true);
    quad(-10, 20);
    expect(pathIsConvex(path)).toBe(false);
    path.reset(); path.addRoundRect(0, 0, 300, 200, [28, 28, 28, 28, 0, 0, 0, 0], 0);
    expect(pathIsConvex(path)).toBe(true);
    path.transform(Float64Array.of(0, -1, 300, 1, 0, 0, 0, 0, 1));
    expect(pathIsConvex(path)).toBe(true);
    path.moveTo(900, 900);
    expect(pathIsConvex(path)).toBe(true);
    path.lineTo(901, 900);
    expect(pathIsConvex(path)).toBe(false);
    path.reset(); path.moveTo(0, 3);
    for (const [x, y] of [[2, -3], [-3, 1], [3, 1], [-2, -3]]) path.lineTo(x, y);
    path.close();
    expect(pathIsConvex(path)).toBe(false);
    path.reset(); path.moveTo(Infinity, 0);
    expect(pathIsConvex(path)).toBe(false);
  });
});

describe("recorded-transform", () => {
  test("a recording's matrix follows Canvas2D: float arguments, a save stack, and no-ops under a singular matrix", () => {
    const t = new Transform();
    t.save();
    t.translate(0.1, 2);
    t.scale(2, 3);
    expect([t.a, t.d, t.e, t.f]).toEqual([2, 3, Math.fround(0.1), 2]);
    t.restore();
    expect([t.a, t.e]).toEqual([1, 0]);
    t.setTransform(0, 0, 0, 0, 5, 5);
    t.translate(1, 1);
    expect([t.e, t.f]).toEqual([5, 5]);
  });
  test("bounds map a rect, and the target into local coordinates", () => {
    const m = { a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 };
    expect(Array.from(deviceBounds(m, 1, 1, 3, 4))).toEqual([12, 22, 16, 28]);
    expect(Array.from(localBounds(m, 100, 100)!)).toEqual([-5, -10, 45, 40]);
    expect(localBounds({ ...m, a: 0, d: 0 }, 100, 100)).toBeNull();
  });
});

describe("typed-array-font", () => {

  test("Resources resolve referenced font resources", async () => {
    const bytes = new Uint8Array(readFileSync("apks/Resy.apk"));
    const archive = await parsePackageArchive(bytes);
    const id = archive.apk.table!.findId("font", "fontawesome");
    expect(id).not.toBe(0);
    const jres = await appResources(archive, "typed-array-font");
    expect(iof(await vcall(jres, "getFont", "(I)Landroid/graphics/Typeface;", id), "android/graphics/Typeface")).toBe(true);
  });
});
