import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { classCtors } from "../src/jvm/natives/jreflect";
import { mangleStaticField } from "../src/jvm/abi";
import { glSurfaces } from "../src/android/glview";
import { JMatrix } from "../src/android/graphics";

rt.linkNatives();
test("TextureView copies content transforms and resets them without changing its bounds", async () => {
  const view = rt.make("android/view/TextureView");
  const matrix = new JMatrix();
  matrix.m = [2, 0, 0, 3, 10, 20];
  await vcall(view, "setTransform", "(Landroid/graphics/Matrix;)V", matrix);
  matrix.m[4] = 100;
  const copy: JMatrix = await vcall(view, "getTransform", "(Landroid/graphics/Matrix;)Landroid/graphics/Matrix;", null);
  expect(copy.m).toEqual([2, 0, 0, 3, 10, 20]);
  copy.m[0] = 9;
  expect(await vcall(view, "getTransform", "(Landroid/graphics/Matrix;)Landroid/graphics/Matrix;", matrix)).toBe(matrix);
  expect(matrix.m[0]).toBe(2);
  expect(await vcall(view, "getWidth", "()I")).toBe(0);
  await vcall(view, "setTransform", "(Landroid/graphics/Matrix;)V", null);
  expect((await vcall(view, "getTransform", "(Landroid/graphics/Matrix;)Landroid/graphics/Matrix;", matrix)).m).toEqual([1, 0, 0, 1, 0, 0]);
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
  const colors = await vcall(rt.link("android/content/res/ColorStateList").ctor, "valueOf", "(I)Landroid/content/res/ColorStateList;", 0xff123456 | 0);
  await vcall(button, "setButtonTintList", "(Landroid/content/res/ColorStateList;)V", colors);
  expect(await vcall(button, "getButtonTintList", "()Landroid/content/res/ColorStateList;")).toBe(colors);
});

test("EGL10 returns configurations with their declared Java type", async () => {
  const egl = rt.make("javax/microedition/khronos/egl/EGL10"), configs = [null], count = new Int32Array(1);
  expect(await vcall(egl, "eglChooseConfig", "(Ljavax/microedition/khronos/egl/EGLDisplay;[I[Ljavax/microedition/khronos/egl/EGLConfig;I[I)Z", null, new Int32Array([0x3038]), configs, 1, count)).toBe(1);
  expect(count[0]).toBe(1);
  expect(rt.iof(configs[0], "javax/microedition/khronos/egl/EGLConfig")).toBe(1);
});

test("EGL10 reports its no-context handle until a context is bound", async () => {
  const egl = rt.make("javax/microedition/khronos/egl/EGL10");
  const none = rt.link("javax/microedition/khronos/egl/EGL10").ctor[mangleStaticField("EGL_NO_CONTEXT")];
  expect(none).not.toBeNull();
  expect(rt.iof(none, "javax/microedition/khronos/egl/EGLContext")).toBe(1);
  expect(await vcall(egl, "eglGetCurrentContext", "()Ljavax/microedition/khronos/egl/EGLContext;")).toBe(none);
  expect(glSurfaces.current).toBeNull();
  expect(await vcall(egl, "eglMakeCurrent", "(Ljavax/microedition/khronos/egl/EGLDisplay;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLSurface;Ljavax/microedition/khronos/egl/EGLContext;)Z", null, null, null, none)).toBe(1);
  expect(glSurfaces.current).toBeNull();
});
