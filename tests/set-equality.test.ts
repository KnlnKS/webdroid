import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
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
test("unordered and insertion-ordered sets do not implement SortedSet", () => {
  for (const name of ["HashSet", "LinkedHashSet", "EnumSet", "concurrent/CopyOnWriteArraySet", "concurrent/ConcurrentHashMap$KeySetView"]) {
    const set = rt.make("java/util/" + name);
    expect(rt.iof(set, "java/util/Set")).toBe(1);
    expect(rt.iof(set, "java/util/SortedSet")).toBe(0);
  }
  expect(rt.iof(rt.make("java/util/TreeSet"), "java/util/SortedSet")).toBe(1);
});
