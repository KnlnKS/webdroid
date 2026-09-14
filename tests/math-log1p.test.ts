import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("Math.log1p preserves tiny values, signed zero and domain endpoints", async () => {
  const log1p = (x: number) => vcall(rt.link("java/lang/Math").ctor, "log1p", "(D)D", x);
  expect(await log1p(1e-20)).toBe(1e-20);
  expect(Object.is(await log1p(-0), -0)).toBe(true);
  expect(await log1p(-1)).toBe(-Infinity);
  expect(await log1p(Infinity)).toBe(Infinity);
  expect(await log1p(-2)).toBeNaN();
  expect(await log1p(NaN)).toBeNaN();
});
