import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("Arrays.binarySearch awaits a comparator and reports insertion points", async () => {
  const comparator = {
    [mangleMethod("compare", "(Ljava/lang/Object;Ljava/lang/Object;)I")]: async (a: number, b: number) => {
      await Promise.resolve();
      return b - a;
    },
  };
  const arrays = rt.link("java/util/Arrays").ctor;
  const desc = "([Ljava/lang/Object;Ljava/lang/Object;Ljava/util/Comparator;)I";
  for (const [key, result] of [[9, 0], [5, 1], [2, 2], [10, -1], [6, -2], [0, -4]]) {
    expect(await vcall(arrays, "binarySearch", desc, [9, 5, 2], key, comparator)).toBe(result);
  }
  expect(await vcall(arrays, "binarySearch", desc, ["a", "b", "d"], "b", null)).toBe(1);
});
for (const [type, ArrayType] of [["F", Float32Array], ["D", Float64Array]] as const) {
  test(`Arrays.binarySearch orders ${type} NaN and signed zero and validates ranges`, async () => {
    const arrays = rt.link("java/util/Arrays").ctor;
    const values = new ArrayType([-Infinity, -2, -0, 0, 1, Infinity, NaN]);
    for (const [i, value] of values.entries()) {
      expect(await vcall(arrays, "binarySearch", `([${type}${type})I`, values, value)).toBe(i);
    }
    expect(await vcall(arrays, "binarySearch", `([${type}${type})I`, values, 0.5)).toBe(-5);
    expect(await vcall(arrays, "binarySearch", `([${type}II${type})I`, values, 2, 5, -2)).toBe(-3);
    expect(await vcall(arrays, "binarySearch", `([${type}II${type})I`, values, 2, 5, NaN)).toBe(-6);
    for (const [from, to, error] of [[4, 2, "IllegalArgumentException"], [-1, 2, "ArrayIndexOutOfBoundsException"], [0, 8, "ArrayIndexOutOfBoundsException"]] as const) {
      try { await vcall(arrays, "binarySearch", `([${type}II${type})I`, values, from, to, 0); throw new Error("Accepted invalid range"); }
      catch (e) { expect(rt.iof(e, "java/lang/" + error)).toBe(1); }
    }
    const cls = rt.link(type === "F" ? "java/lang/Float" : "java/lang/Double").ctor;
    expect(await vcall(cls, "compare", `(${type}${type})I`, -0, 0)).toBe(-1);
    expect(await vcall(cls, "compare", `(${type}${type})I`, 0, -0)).toBe(1);
    expect(await vcall(cls, "compare", `(${type}${type})I`, NaN, NaN)).toBe(0);
  });
}
