import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
const O = "Ljava/lang/Object;";

test("LruCache resize evicts least-recent entries and snapshot is independent", async () => {
  const cache = await newObj("android/util/LruCache", "(I)V", 3);
  for (const key of ["a", "b", "c"]) await vcall(cache, "put", `(${O}${O})${O}`, key, key);
  await vcall(cache, "get", `(${O})${O}`, "a");
  await vcall(cache, "resize", "(I)V", 2);
  expect(await vcall(cache, "get", `(${O})${O}`, "b")).toBe(null);
  expect(await vcall(cache, "hitCount", "()I")).toBe(1);
  expect(await vcall(cache, "missCount", "()I")).toBe(1);
  expect(await vcall(cache, "evictionCount", "()I")).toBe(1);
  const snapshot = await vcall(cache, "snapshot", "()Ljava/util/Map;");
  await vcall(cache, "remove", `(${O})${O}`, "a");
  expect(await vcall(snapshot, "get", `(${O})${O}`, "a")).toBe("a");
  await expect(vcall(cache, "resize", "(I)V", 0)).rejects.toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
});
