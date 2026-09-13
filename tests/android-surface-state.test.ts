import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JPaint } from "../src/android/graphics";
import { mangleMethod } from "../src/jvm/abi";

rt.linkNatives();
const scall = (cls: string, name: string, desc: string, ...args: unknown[]) =>
  (rt.link(cls).ctor as unknown as Record<string, (...values: unknown[]) => unknown>)[mangleMethod(name, desc)](...args);

test("Paint reset restores a fresh paint state", async () => {
  const paint = new JPaint();
  paint.color = 1; paint.style = 2; paint.strokeWidth = 3; paint.textSize = 4;
  paint.dash = [1, 2]; paint.fakeBold = true; paint.strikeThru = true;
  paint.shadowRadius = 5; paint.shadowColor = 6;
  await vcall(paint, "reset", "()V");

  const fresh = new JPaint();
  expect({ ...paint, tf: undefined }).toEqual({ ...fresh, tf: undefined });
  expect(paint.tf).toBe(fresh.tf);
});

test("Paint retains text scale and skew state", async () => {
  const paint = new JPaint();
  await vcall(paint, "setTextScaleX", "(F)V", 1.25);
  await vcall(paint, "setTextSkewX", "(F)V", -0.2);
  expect(await vcall(paint, "getTextScaleX", "()F")).toBe(1.25);
  expect(await vcall(paint, "getTextSkewX", "()F")).toBeCloseTo(-0.2);

  const copy = await newObj("android/graphics/Paint", "(Landroid/graphics/Paint;)V", paint);
  expect(await vcall(copy, "getTextSkewX", "()F")).toBeCloseTo(-0.2);
  await vcall(copy, "reset", "()V");
  expect(await vcall(copy, "getTextScaleX", "()F")).toBe(1);
  expect(await vcall(copy, "getTextSkewX", "()F")).toBe(0);
});

test("Paint retains font feature settings across copy and clears them on reset", async () => {
  const paint = new JPaint();
  expect(await vcall(paint, "getFontFeatureSettings", "()Ljava/lang/String;")).toBeNull();
  await vcall(paint, "setFontFeatureSettings", "(Ljava/lang/String;)V", "kern=0");
  expect(await vcall(paint, "getFontFeatureSettings", "()Ljava/lang/String;")).toBe("kern=0");

  const copy = await newObj("android/graphics/Paint", "(Landroid/graphics/Paint;)V", paint);
  expect(await vcall(copy, "getFontFeatureSettings", "()Ljava/lang/String;")).toBe("kern=0");
  await vcall(copy, "reset", "()V");
  expect(await vcall(copy, "getFontFeatureSettings", "()Ljava/lang/String;")).toBeNull();
});

test("TextView retains and exposes its shadow layer", async () => {
  const view = await newObj("android/widget/TextView");
  await vcall(view, "setShadowLayer", "(FFFI)V", 4.5, 2, -3, 0x7f123456);
  expect(await vcall(view, "getShadowRadius", "()F")).toBe(4.5);
  expect(await vcall(view, "getShadowDx", "()F")).toBe(2);
  expect(await vcall(view, "getShadowDy", "()F")).toBe(-3);
  expect(await vcall(view, "getShadowColor", "()I")).toBe(0x7f123456);
});

test("new window and process fields expose platform defaults", async () => {
  const params = await newObj("android/view/WindowManager$LayoutParams");
  expect(params.preferredRefreshRate).toBe(0);
  expect(scall("android/os/Process", "getStartRequestedUptimeMillis", "()J")).toBe(0n);
});

test("uname reports the emulated Linux ABI", async () => {
  const uts = scall("android/system/Os", "uname", "()Landroid/system/StructUtsname;");
  if (typeof uts !== "object" || uts === null || !("sysname" in uts) || !("release" in uts) || !("machine" in uts))
    throw new Error("uname returned an invalid StructUtsname");
  expect(uts.sysname).toBe("Linux");
  expect(String(uts.release)).toContain("webdroid");
  expect(["aarch64", "armv7l"]).toContain(String(uts.machine));
});
