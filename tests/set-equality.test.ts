import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";
rt.linkNatives();

const set = (cls: string, ...items: unknown[]) => newObj(cls).then(async (s) => {
  for (const v of items) await vcall(s, "add", "(Ljava/lang/Object;)Z", v);
  return s;
});
const eq = (a: unknown, b: unknown) => vcall(a, "equals", "(Ljava/lang/Object;)Z", b);
const hash = (o: unknown) => vcall(o, "hashCode", "()I");

test("empty sets are equal across Set implementations", async () => {
  const empty = await vcall(rt.link("java/util/Collections").ctor, "emptySet", "()Ljava/util/Set;");
  const hashSet = await set("java/util/HashSet");
  expect(await eq(hashSet, empty)).toBe(1);
  expect(await eq(empty, await set("java/util/LinkedHashSet"))).toBe(1);
  expect(await eq(hashSet, await newObj("java/util/ArrayList"))).toBe(0);
});

test("set equality is membership and its hash is the member hash sum", async () => {
  const a = await set("java/util/HashSet", "x", "y"), b = await set("java/util/LinkedHashSet", "y", "x");
  expect(await eq(a, b)).toBe(1);
  expect(await eq(a, await set("java/util/HashSet", "x"))).toBe(0);
  expect(await eq(a, await set("java/util/HashSet", "x", "z"))).toBe(0);
  expect(await hash(a)).toBe(await hash(b));
  expect(await hash(await set("java/util/HashSet"))).toBe(0);
});

test("a set is a value key in a HashMap", async () => {
  const map = await newObj("java/util/HashMap");
  await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", await set("java/util/HashSet", "k"), "v");
  expect(await vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", await set("java/util/LinkedHashSet", "k"))).toBe("v");
});

test("Set.of rejects null and duplicates and stays immutable", async () => {
  const of = (rt.link("java/util/Set").ctor as any)[mangleMethod("of", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/Set;")];
  const immutable = await of("a", "b");
  expect(await vcall(immutable, "contains", "(Ljava/lang/Object;)Z", "a")).toBe(1);
  await expect(vcall(immutable, "add", "(Ljava/lang/Object;)Z", "c"))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/UnsupportedOperationException").ctor });
  await expect(of("a", "a")).rejects.toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
  await expect(of("a", null)).rejects.toMatchObject({ constructor: rt.link("java/lang/NullPointerException").ctor });
});

test("Collection.stream exposes collection contents to stream operations", async () => {
  const values = await newObj("java/util/ArrayList");
  await vcall(values, "add", "(Ljava/lang/Object;)Z", "a");
  await vcall(values, "add", "(Ljava/lang/Object;)Z", "b");
  const stream = await vcall(values, "stream", "()Ljava/util/stream/Stream;");
  expect(await vcall(stream, "count", "()J")).toBe(2n);
});

test("Map.of rejects null and duplicate keys and stays immutable", async () => {
  const of = (rt.link("java/util/Map").ctor as any)[mangleMethod("of", "(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/Map;")];
  const immutable = await of("a", 1, "b", 2);
  expect(await vcall(immutable, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "b")).toBe(2);
  await expect(vcall(immutable, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "c", 3))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/UnsupportedOperationException").ctor });
  await expect(of("a", 1, "a", 2)).rejects.toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
  await expect(of("a", 1, "b", null)).rejects.toMatchObject({ constructor: rt.link("java/lang/NullPointerException").ctor });
});
