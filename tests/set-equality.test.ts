import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallMaybe } from "../src/jvm/natives/jlang";
rt.linkNatives();

const scall = (cls: string, name: string, desc: string, ...args: unknown[]) =>
  vcallMaybe(rt.link(cls).ctor, name, desc, ...args);
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
  const of = (...values: unknown[]) => scall("java/util/Set", "of", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/Set;", ...values);
  const immutable = await of("a", "b");
  expect(await vcall(immutable, "contains", "(Ljava/lang/Object;)Z", "a")).toBe(1);
  await expect(vcall(immutable, "add", "(Ljava/lang/Object;)Z", "c"))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/UnsupportedOperationException").ctor });
  await expect(of("a", "a")).rejects.toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
  await expect(Promise.resolve().then(() => of("a", null))).rejects.toMatchObject({ constructor: rt.link("java/lang/NullPointerException").ctor });
});

test("Collection.stream exposes collection contents to stream operations", async () => {
  const values = await newObj("java/util/ArrayList");
  await vcall(values, "add", "(Ljava/lang/Object;)Z", "a");
  await vcall(values, "add", "(Ljava/lang/Object;)Z", "b");
  const stream = await vcall(values, "stream", "()Ljava/util/stream/Stream;");
  expect(await vcall(stream, "count", "()J")).toBe(2n);
});

test("Map.of rejects null and duplicate keys and stays immutable", async () => {
  const of = (...values: unknown[]) => scall("java/util/Map", "of",
    "(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/Map;", ...values);
  const immutable = await of("a", 1, "b", 2);
  expect(await vcall(immutable, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "b")).toBe(2);
  await expect(vcall(immutable, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "c", 3))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/UnsupportedOperationException").ctor });
  const entries = await vcall(immutable, "entrySet", "()Ljava/util/Set;");
  const entryIterator = await vcall(entries, "iterator", "()Ljava/util/Iterator;");
  const entry = await vcall(entryIterator, "next", "()Ljava/lang/Object;");
  await expect(vcall(entry, "setValue", "(Ljava/lang/Object;)Ljava/lang/Object;", 3))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/UnsupportedOperationException").ctor });
  const keys = await vcall(immutable, "keySet", "()Ljava/util/Set;");
  await expect(vcall(keys, "clear", "()V"))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/UnsupportedOperationException").ctor });
  await expect(vcall(entryIterator, "remove", "()V"))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/UnsupportedOperationException").ctor });
  expect(await vcall(immutable, "size", "()I")).toBe(2);
  await expect(of("a", 1, "a", 2)).rejects.toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
  await expect(of("a", 1, "b", null)).rejects.toMatchObject({ constructor: rt.link("java/lang/NullPointerException").ctor });
});

test("Collections.disjoint uses value equality", async () => {
  const disjoint = (...values: unknown[]) => scall("java/util/Collections", "disjoint",
    "(Ljava/util/Collection;Ljava/util/Collection;)Z", ...values);
  expect(await disjoint(await set("java/util/HashSet", "a"), await set("java/util/HashSet", "b"))).toBe(1);
  expect(await disjoint(await set("java/util/HashSet", "a"), await set("java/util/LinkedHashSet", "a"))).toBe(0);
});

test("Collections wrappers stay live without exposing unmodifiable mutations", async () => {
  const list = await newObj("java/util/ArrayList");
  await vcall(list, "add", "(Ljava/lang/Object;)Z", "a");
  const readOnly = await scall("java/util/Collections", "unmodifiableList", "(Ljava/util/List;)Ljava/util/List;", list);
  expect(readOnly).not.toBe(list);
  await expect(vcall(readOnly, "add", "(Ljava/lang/Object;)Z", "blocked"))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/UnsupportedOperationException").ctor });
  const iterator = await vcall(readOnly, "iterator", "()Ljava/util/Iterator;");
  await vcall(iterator, "next", "()Ljava/lang/Object;");
  await expect(vcall(iterator, "remove", "()V"))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/UnsupportedOperationException").ctor });
  await vcall(list, "add", "(Ljava/lang/Object;)Z", "b");
  expect(await vcall(readOnly, "size", "()I")).toBe(2);

  const synchronized = await scall("java/util/Collections", "synchronizedList", "(Ljava/util/List;)Ljava/util/List;", list);
  expect(synchronized).not.toBe(list);
  await vcall(synchronized, "add", "(Ljava/lang/Object;)Z", "c");
  expect(await vcall(list, "size", "()I")).toBe(3);
});

test("List.of rejects null and stays immutable", async () => {
  const of = (...values: unknown[]) => scall("java/util/List", "of", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/util/List;", ...values);
  const immutable = await of("a", "b");
  expect(await vcall(immutable, "get", "(I)Ljava/lang/Object;", 1)).toBe("b");
  await expect(vcall(immutable, "add", "(Ljava/lang/Object;)Z", "c"))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/UnsupportedOperationException").ctor });
  await expect(Promise.resolve().then(() => of("a", null))).rejects.toMatchObject({ constructor: rt.link("java/lang/NullPointerException").ctor });
});

test("unordered and insertion-ordered sets do not implement SortedSet", () => {
  for (const name of ["HashSet", "LinkedHashSet", "EnumSet", "concurrent/CopyOnWriteArraySet", "concurrent/ConcurrentHashMap$KeySetView"]) {
    const set = rt.make("java/util/" + name);
    expect(rt.iof(set, "java/util/Set")).toBe(1);
    expect(rt.iof(set, "java/util/SortedSet")).toBe(0);
  }
  expect(rt.iof(rt.make("java/util/TreeSet"), "java/util/SortedSet")).toBe(1);
});
