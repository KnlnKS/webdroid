import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { classCtors } from "../src/jvm/natives/jreflect";

rt.linkNatives();
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
