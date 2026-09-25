import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();
test("LongSparseArray orders full-width keys and searches insertion positions", async () => {
  const a = await newObj("android/util/LongSparseArray");
  const hi = 9007199254740993n;
  for (const [key, value] of [[hi, "high"], [-hi, "low"], [0n, "zero"]]) await vcall(a, "put", "(JLjava/lang/Object;)V", key, value);
  expect(await vcall(a, "keyAt", "(I)J", 0)).toBe(-hi);
  expect(await vcall(a, "indexOfKey", "(J)I", hi - 1n)).toBe(~2);
  expect(await vcall(a, "indexOfValue", "(Ljava/lang/Object;)I", "high")).toBe(2);
  const copy = await vcall(a, "clone", "()Landroid/util/LongSparseArray;");
  await vcall(a, "remove", "(J)V", hi);
  expect(await vcall(copy, "get", "(J)Ljava/lang/Object;", hi)).toBe("high");
});
test("Arrays.deepEquals compares nested primitive arrays with Java floating equality", async () => {
  const cls = rt.link("java/util/Arrays").ctor;
  const eq = (a: unknown[], b: unknown[]) => vcall(cls, "deepEquals", "([Ljava/lang/Object;[Ljava/lang/Object;)Z", a, b);
  expect(await eq([Float64Array.of(NaN, -0), [Int8Array.of(1, 2)]], [Float64Array.of(NaN, -0), [Int8Array.of(1, 2)]])).toBe(1);
  expect(await eq([Float64Array.of(-0)], [Float64Array.of(0)])).toBe(0);
  expect(await eq([Int8Array.of(1)], [Int16Array.of(1)])).toBe(0);
});
test("Collections.shuffle uses the supplied Random and updates the list", async () => {
  const random = await newObj("java/util/Random", "(J)V", 123n);
  const copyRandom = await newObj("java/util/Random", "(J)V", 123n);
  const list = await newObj("java/util/ArrayList");
  const expected = [0, 1, 2, 3, 4];
  for (const value of expected) await vcall(list, "add", "(Ljava/lang/Object;)Z", value);
  for (let i = expected.length; i > 1; i--) {
    const j = await vcall(copyRandom, "nextInt", "(I)I", i);
    [expected[i - 1], expected[j]] = [expected[j], expected[i - 1]];
  }
  await vcall(rt.link("java/util/Collections").ctor, "shuffle", "(Ljava/util/List;Ljava/util/Random;)V", list, random);
  expect(await vcall(list, "toArray", "()[Ljava/lang/Object;")).toEqual(expected);
});
test("Collections.rotate updates a live sublist", async () => {
  const list = await newObj("java/util/ArrayList");
  for (const value of [0, 1, 2, 3, 4]) await vcall(list, "add", "(Ljava/lang/Object;)Z", value);
  const middle = await vcall(list, "subList", "(II)Ljava/util/List;", 1, 4);
  await vcall(rt.link("java/util/Collections").ctor, "rotate", "(Ljava/util/List;I)V", middle, -1);
  expect(await vcall(list, "toArray", "()[Ljava/lang/Object;")).toEqual([0, 2, 3, 1, 4]);
});
