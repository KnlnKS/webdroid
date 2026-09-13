import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod, mangleStaticField } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JTextPaint } from "../src/android/text";
import { typefaceFor } from "../src/android/graphics";

rt.linkNatives();
const scall = (cls: string, name: string, desc: string, ...args: unknown[]) =>
  (rt.link(cls).ctor as unknown as Record<string, (...values: unknown[]) => unknown>)[mangleMethod(name, desc)](...args);

test("TypefaceSpan retains and applies a supplied typeface", async () => {
  const typeface = typefaceFor("monospace", 1);
  const span = await newObj("android/text/style/TypefaceSpan", "(Landroid/graphics/Typeface;)V", typeface);
  expect(await vcall(span, "getTypeface", "()Landroid/graphics/Typeface;")).toBe(typeface);
  expect(await vcall(span, "getFamily", "()Ljava/lang/String;")).toBeNull();

  const paint = new JTextPaint();
  await vcall(span, "updateMeasureState", "(Landroid/text/TextPaint;)V", paint);
  expect(paint.tf).toBe(typeface);
});

test("PluralRules uses locale cardinal categories", async () => {
  const Locale = rt.link("java/util/Locale").ctor as unknown as Record<string, unknown>;
  const english = Locale[mangleStaticField("ENGLISH")];
  const rules = scall("android/icu/text/PluralRules", "forLocale", "(Ljava/util/Locale;)Landroid/icu/text/PluralRules;", english);
  expect(await vcall(rules, "select", "(D)Ljava/lang/String;", 1)).toBe("one");
  expect(await vcall(rules, "select", "(D)Ljava/lang/String;", 2)).toBe("other");
});

test("storage stats is a known unavailable device service", async () => {
  const context = await newObj("android/content/Context");
  const cls = rt.classFor("android/app/usage/StorageStatsManager");
  expect(await vcall(context, "getSystemServiceName", "(Ljava/lang/Class;)Ljava/lang/String;", cls)).toBe("storagestats");
  expect(await vcall(context, "getSystemService", "(Ljava/lang/Class;)Ljava/lang/Object;", cls)).toBeNull();
});
