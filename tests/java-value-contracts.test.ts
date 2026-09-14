import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("Math.getExponent extracts IEEE fields at subnormal, power-of-two and nonfinite boundaries", async () => {
  const math = rt.link("java/lang/Math").ctor;
  for (const [value, exponent] of [[0, -1023], [Number.MIN_VALUE, -1023], [1, 0], [1 - Number.EPSILON / 2, -1], [2, 1], [-8, 3], [Infinity, 1024], [NaN, 1024]]) {
    expect(await vcall(math, "getExponent", "(D)I", value)).toBe(exponent);
  }
  expect(await vcall(math, "getExponent", "(F)I", 2 ** -149)).toBe(-127);
});
test("EnumSet factories and clones preserve Java class identity", async () => {
  const es = rt.link("java/util/EnumSet").ctor;
  const days = rt.link("java/time/DayOfWeek").ctor;
  const values: unknown[] = await vcall(days, "values", "()[Ljava/time/DayOfWeek;");
  const set = await vcall(es, "of", "(Ljava/lang/Enum;[Ljava/lang/Enum;)Ljava/util/EnumSet;", values[0], values.slice(0, 4));
  expect(rt.iof(set, "java/util/EnumSet")).toBe(1);
  const clone = await vcall(set, "clone", "()Ljava/lang/Object;");
  expect(rt.iof(clone, "java/util/EnumSet")).toBe(1);
  await vcall(clone, "clear", "()V");
  expect(await vcall(set, "size", "()I")).toBe(4);
  const copy = await vcall(es, "copyOf", "(Ljava/util/Collection;)Ljava/util/EnumSet;", set);
  expect(await vcall(copy, "equals", "(Ljava/lang/Object;)Z", set)).toBe(1);
});
