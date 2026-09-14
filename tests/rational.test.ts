import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();
const rational = (n: number, d: number) => newObj("android/util/Rational", "(II)V", n, d);

test("Rational reduces values and preserves exact order near integer limits", async () => {
  const a = await rational(6, -8), b = await rational(-3, 4);
  expect(await vcall(a, "toString", "()Ljava/lang/String;")).toBe("-3/4");
  expect(await vcall(a, "equals", "(Ljava/lang/Object;)Z", b)).toBe(1);
  expect(await vcall(a, "hashCode", "()I")).toBe(await vcall(b, "hashCode", "()I"));
  expect(await vcall(await rational(2147483646, 2147483647), "compareTo", "(Landroid/util/Rational;)I", await rational(2147483645, 2147483646))).toBe(1);
  const parsed = await vcall(rt.link("android/util/Rational").ctor, "parseRational", "(Ljava/lang/String;)Landroid/util/Rational;", "3:+6");
  expect(await vcall(parsed, "doubleValue", "()D")).toBe(0.5);
});

test("Rational orders NaN and saturates infinite conversions", async () => {
  const nan = await rational(0, 0), inf = await rational(5, 0), neg = await rational(-2, 0);
  expect(await vcall(nan, "equals", "(Ljava/lang/Object;)Z", await rational(0, 0))).toBe(1);
  expect(await vcall(nan, "compareTo", "(Landroid/util/Rational;)I", inf)).toBe(1);
  expect(await vcall(neg, "compareTo", "(Landroid/util/Rational;)I", await rational(-500, 1))).toBe(-1);
  expect(await vcall(inf, "intValue", "()I")).toBe(2147483647);
  expect(await vcall(neg, "longValue", "()J")).toBe(-9223372036854775808n);
  expect(await vcall(nan, "intValue", "()I")).toBe(0);
});
