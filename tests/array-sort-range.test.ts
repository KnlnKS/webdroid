import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("natural array range sorting awaits Comparable and preserves equal-element order", async () => {
  const comparable = (rank: number) => ({
    rank,
    [mangleMethod("compareTo", "(Ljava/lang/Object;)I")]: async (other: { rank: number }) => {
      await Promise.resolve();
      return rank - other.rank;
    },
  });
  const first = comparable(1), second = comparable(1), large = comparable(2);
  const array = [null, large, first, second, null];
  const sort = (from: number, to: number) => vcall(rt.link("java/util/Arrays").ctor, "sort", "([Ljava/lang/Object;II)V", array, from, to);
  await sort(1, 4);
  expect(array).toEqual([null, first, second, large, null]);
  for (const [from, to, cls] of [[3, 2, "IllegalArgumentException"], [-1, 0, "ArrayIndexOutOfBoundsException"], [0, 6, "ArrayIndexOutOfBoundsException"]] as const) {
    let error: unknown;
    try { await sort(from, to); } catch (e) { error = e; }
    expect(rt.iof(error, `java/lang/${cls}`)).toBe(1);
  }
});
