import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";

rt.linkNatives();
test("hash maps expose their actual collection contracts", () => {
  for (const name of ["java/util/HashMap", "java/util/LinkedHashMap", "java/util/concurrent/ConcurrentHashMap", "java/util/WeakHashMap", "java/util/IdentityHashMap", "java/util/Hashtable", "java/util/EnumMap", "android/util/ArrayMap"]) {
    const map = rt.make(name);
    expect(rt.iof(map, "java/util/Map")).toBe(1);
    expect(rt.iof(map, "java/util/SortedMap")).toBe(0);
    expect(rt.iof(map, "java/util/concurrent/ConcurrentMap")).toBe(name.endsWith("/ConcurrentHashMap") ? 1 : 0);
  }
  expect(rt.iof(rt.make("java/util/TreeMap"), "java/util/SortedMap")).toBe(1);
});
