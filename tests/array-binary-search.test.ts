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
