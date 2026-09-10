import { expect, test } from "bun:test";
import { JObj, rt } from "../runtime";
import { mangleMethod } from "../abi";
import { linkInit, newObj, vcall } from "./jlang";
import "./jutil";
import "./jreflect";

test("Collections.sort dispatches to custom list storage and overrides", async () => {
  class SortList extends JObj { values: unknown[] = ["c", "a", "b"]; }
  rt.register({ name: "webdroid/SortList", ctor: SortList, ifaces: ["java/util/List"], methods: {
    "toArray()[Ljava/lang/Object;": function (this: SortList) { return this.values.slice(); },
    "set(ILjava/lang/Object;)Ljava/lang/Object;": function (this: SortList, i: number, value: unknown) {
      const old = this.values[i]; this.values[i] = value; return old;
    },
  } });
  const list = await newObj("webdroid/SortList", null);
  const collections = (await linkInit("java/util/Collections")).ctor;
  await collections[mangleMethod("sort", "(Ljava/util/List;)V")](list);
  expect(list.values).toEqual(["a", "b", "c"]);
  let received: unknown;
  list[mangleMethod("sort", "(Ljava/util/Comparator;)V")] = async (cmp: unknown) => { received = cmp; };
  const cmp = new JObj();
  await collections[mangleMethod("sort", "(Ljava/util/List;Ljava/util/Comparator;)V")](list, cmp);
  expect(received).toBe(cmp);
});

test("map view iterator removal unlinks fast and custom-equality entries", async () => {
  let comparisons = 0;
  class ViewKey extends JObj {}
  rt.register({ name: "webdroid/MapViewRemovalKey", ctor: ViewKey, methods: {
    "equals(Ljava/lang/Object;)Z": function (this: ViewKey, other: unknown) { comparisons++; return this === other ? 1 : 0; },
  } });
  await linkInit("webdroid/MapEntry");
  await linkInit("webdroid/SetView");
  for (const view of ["keySet", "values", "entrySet"]) {
    const map = await newObj("java/util/LinkedHashMap");
    const key = await newObj("webdroid/MapViewRemovalKey", null);
    await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "fast", "same");
    await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", key, "same");
    const collection = await vcall(map, view, view === "values" ? "()Ljava/util/Collection;" : "()Ljava/util/Set;");
    const iterator = await vcall(collection, "iterator", "()Ljava/util/Iterator;");
    for (const remaining of [1, 0]) {
      await vcall(iterator, "next", "()Ljava/lang/Object;");
      comparisons = 0;
      await vcall(iterator, "remove", "()V");
      expect(comparisons).toBe(0);
      expect(await vcall(map, "size", "()I")).toBe(remaining);
      expect(await vcall(collection, "size", "()I")).toBe(remaining);
    }
    expect(await vcall(iterator, "hasNext", "()Z")).toBe(0);
    await expect(vcall(iterator, "remove", "()V")).rejects.toBeDefined();
  }
});

test("successive cache evictions remove each resource only once", async () => {
  await linkInit("webdroid/MapEntry");
  await linkInit("webdroid/SetView");
  const map = await newObj("java/util/LinkedHashMap");
  for (const key of ["first", "second", "third"]) await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", key, key);
  const removed = [];
  for (let i = 0; i < 3; i++) {
    const entries = await vcall(map, "entrySet", "()Ljava/util/Set;");
    const iterator = await vcall(entries, "iterator", "()Ljava/util/Iterator;");
    const entry = await vcall(iterator, "next", "()Ljava/lang/Object;");
    removed.push(await vcall(entry, "getValue", "()Ljava/lang/Object;"));
    await vcall(iterator, "remove", "()V");
  }
  expect(removed).toEqual(["first", "second", "third"]);
  expect(await vcall(map, "size", "()I")).toBe(0);
});

test("Arrays.asList returns a linked Serializable list backed by its array", async () => {
  await linkInit("java/lang/Class");
  const arrays = (await linkInit("java/util/Arrays")).ctor;
  const values = ["first", "second"];
  const list = await vcall(arrays, "asList", "([Ljava/lang/Object;)Ljava/util/List;", values);
  expect(await vcall(rt.classFor("java/io/Serializable"), "isInstance", "(Ljava/lang/Object;)Z", list)).toBe(1);
  expect(await vcall(list, "get", "(I)Ljava/lang/Object;", 0)).toBe("first");
  await vcall(list, "set", "(ILjava/lang/Object;)Ljava/lang/Object;", 0, "updated");
  expect(values[0]).toBe("updated");
  values[1] = "changed";
  expect(await vcall(list, "get", "(I)Ljava/lang/Object;", 1)).toBe("changed");
});

test("Map.compute receives old values, removes null results and preserves values on failure", async () => {
  let result: unknown = "initial", fail = false;
  const seen: unknown[] = [];
  rt.register({ name: "webdroid/ComputeFunction", ctor: class extends JObj {}, ifaces: ["java/util/function/BiFunction"], methods: {
    "apply(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": (_key: unknown, old: unknown) => {
      seen.push(old); if (fail) throw new Error("failed remapping"); return result;
    },
  } });
  const fn = await newObj("webdroid/ComputeFunction", null);
  for (const cls of ["java/util/HashMap", "java/util/concurrent/ConcurrentHashMap"]) {
    const map = await newObj(cls);
    result = "initial"; fail = false;
    expect(await vcall(map, "compute", "(Ljava/lang/Object;Ljava/util/function/BiFunction;)Ljava/lang/Object;", "key", fn)).toBe("initial");
    expect(seen.at(-1)).toBeNull();
    fail = true;
    await expect(vcall(map, "compute", "(Ljava/lang/Object;Ljava/util/function/BiFunction;)Ljava/lang/Object;", "key", fn)).rejects.toThrow("failed remapping");
    expect(await vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "key")).toBe("initial");
    fail = false; result = null;
    expect(await vcall(map, "compute", "(Ljava/lang/Object;Ljava/util/function/BiFunction;)Ljava/lang/Object;", "key", fn)).toBeNull();
    expect(seen.at(-1)).toBe("initial");
    expect(await vcall(map, "containsKey", "(Ljava/lang/Object;)Z", "key")).toBe(0);
  }
});

test("conditional map removal distinguishes missing and null values and preserves the synchronous fast path", async () => {
  for (const cls of ["java/util/HashMap", "java/util/concurrent/ConcurrentHashMap"]) {
    const map = await newObj(cls);
    const remove = rt.link(cls).ctor.prototype[mangleMethod("remove", "(Ljava/lang/Object;Ljava/lang/Object;)Z")].bind(map);
    expect(remove("missing", null)).toBe(0);
    await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "key", "value");
    expect(remove("key", "other")).toBe(0);
    expect(remove("key", "value")).toBe(1);
    expect(await vcall(map, "containsKey", "(Ljava/lang/Object;)Z", "key")).toBe(0);
  }
  const map = await newObj("java/util/HashMap");
  await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "key", null);
  expect(await vcall(map, "remove", "(Ljava/lang/Object;Ljava/lang/Object;)Z", "key", null)).toBe(1);
});

test("conditional map removal uses Java equality and cannot delete a value replaced during comparison", async () => {
  class EqualValue extends JObj { value = ""; }
  rt.register({ name: "webdroid/ConditionalEqualValue", ctor: EqualValue, methods: {
    "equals(Ljava/lang/Object;)Z": function (this: EqualValue, other: unknown) { return other instanceof EqualValue && other.value === this.value ? 1 : 0; },
  } });
  const key = Object.assign(await newObj("webdroid/ConditionalEqualValue", null), { value: "key" });
  const equalKey = Object.assign(await newObj("webdroid/ConditionalEqualValue", null), { value: "key" });
  const value = Object.assign(await newObj("webdroid/ConditionalEqualValue", null), { value: "value" });
  const equalValue = Object.assign(await newObj("webdroid/ConditionalEqualValue", null), { value: "value" });
  const map = await newObj("java/util/concurrent/ConcurrentHashMap");
  await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", key, value);
  expect(await vcall(map, "remove", "(Ljava/lang/Object;Ljava/lang/Object;)Z", equalKey, equalValue)).toBe(1);
  let release: (equal: number) => void = () => {};
  const compared = new Promise<number>((resolve) => { release = resolve; });
  rt.register({ name: "webdroid/DeferredEquality", ctor: class extends JObj {}, methods: { "equals(Ljava/lang/Object;)Z": () => compared } });
  const deferred = await newObj("webdroid/DeferredEquality", null);
  await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "key", value);
  const pending = vcall(map, "remove", "(Ljava/lang/Object;Ljava/lang/Object;)Z", "key", deferred);
  await vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", "key", "replacement");
  release(1);
  expect(await pending).toBe(0);
  expect(await vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", "key")).toBe("replacement");
});

test("sorting preserves the initiating thread across comparator suspensions", async () => {
  const { JThread, curThread, setCurThread } = await import("./jlang");
  const { sortInPlace } = await import("./jutil");
  const previous = curThread, owner = new JThread(), other = new JThread();
  const callers: unknown[] = [];
  rt.register({ name: "webdroid/ThreadComparator", ctor: class extends JObj {}, methods: {
    "compare(Ljava/lang/Object;Ljava/lang/Object;)I": async (a: number, b: number) => {
      callers.push(rt.th());
      await Promise.resolve(); setCurThread(other);
      return a - b;
    },
  } });
  const comparator = await newObj("webdroid/ThreadComparator", null), values = [4, 1, 3, 2];
  try {
    setCurThread(owner);
    const pending = sortInPlace(values, comparator);
    queueMicrotask(() => setCurThread(other));
    await pending;
    expect(values).toEqual([1, 2, 3, 4]);
    expect(callers.length).toBeGreaterThan(1);
    expect(callers.every((thread) => thread === owner)).toBe(true);
    const tree = await newObj("java/util/TreeSet", "(Ljava/util/Comparator;)V", comparator);
    for (const value of values) { setCurThread(owner); await vcall(tree, "add", "(Ljava/lang/Object;)Z", value); }
    callers.length = 0;
    setCurThread(owner);
    await vcall(tree, "add", "(Ljava/lang/Object;)Z", 5);
    expect(callers.length).toBeGreaterThan(1);
    expect(callers.every((thread) => thread === owner)).toBe(true);
  } finally { setCurThread(previous); }
});

test("map computation preserves the caller for mapping and overridable writes", async () => {
  const { JThread, curThread, setCurThread } = await import("./jlang");
  const previous = curThread, owner = new JThread(), other = new JThread();
  const callers: unknown[] = [];
  const Base = rt.link("java/util/HashMap").ctor;
  rt.register({ name: "webdroid/ThreadMap", ctor: class extends Base {}, sup: "java/util/HashMap", methods: {
    "get(Ljava/lang/Object;)Ljava/lang/Object;": async () => { await Promise.resolve(); setCurThread(other); return null; },
    "put(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": () => { callers.push(rt.th()); return null; },
  } });
  const apply = async () => { callers.push(rt.th()); await Promise.resolve(); setCurThread(other); return "mapped"; };
  rt.register({ name: "webdroid/ThreadMapping", ctor: class extends JObj {}, methods: {
    "apply(Ljava/lang/Object;)Ljava/lang/Object;": apply,
    "apply(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": apply,
  } });
  const map = await newObj("webdroid/ThreadMap"), fn = await newObj("webdroid/ThreadMapping", null);
  try {
    for (const [name, type] of [["compute", "BiFunction"], ["computeIfAbsent", "Function"]]) {
      setCurThread(owner);
      expect(await vcall(map, name, `(Ljava/lang/Object;Ljava/util/function/${type};)Ljava/lang/Object;`, "key", fn)).toBe("mapped");
    }
    expect(callers).toEqual([owner, owner, owner, owner]);
  } finally { setCurThread(previous); }
});

test("CopyOnWriteArrayList dispatch snapshots survive listeners removing themselves", async () => {
  const list = await newObj("java/util/concurrent/CopyOnWriteArrayList");
  for (const value of ["first", "second", "last"]) await vcall(list, "add", "(Ljava/lang/Object;)Z", value);
  const it = await vcall(list, "iterator", "()Ljava/util/Iterator;"), delivered: unknown[] = [];
  while (await vcall(it, "hasNext", "()Z")) {
    const value = await vcall(it, "next", "()Ljava/lang/Object;"); delivered.push(value);
    await vcall(list, "remove", "(Ljava/lang/Object;)Z", value);
    if (value === "first") await vcall(list, "add", "(Ljava/lang/Object;)Z", "new");
  }
  expect(delivered).toEqual(["first", "second", "last"]); expect(list.a).toEqual(["new"]);
  const cursor = await vcall(list, "listIterator", "(I)Ljava/util/ListIterator;", 1);
  await vcall(list, "set", "(ILjava/lang/Object;)Ljava/lang/Object;", 0, "changed");
  expect(await vcall(cursor, "previous", "()Ljava/lang/Object;")).toBe("new");
  for (const [name, desc, args] of [["remove", "()V", []], ["set", "(Ljava/lang/Object;)V", ["x"]], ["add", "(Ljava/lang/Object;)V", ["x"]]] as const) {
    await expect(vcall(cursor, name, desc, ...args)).rejects.toBeInstanceOf(rt.link("java/lang/UnsupportedOperationException").ctor);
  }
  await expect(vcall(list, "listIterator", "(I)Ljava/util/ListIterator;", 2)).rejects.toBeDefined();
});

test("sorted collections retry indices invalidated while a comparator suspends", async () => {
  rt.register({ name: "webdroid/AsyncSortedComparator", ctor: class extends JObj {}, methods: {
    "compare(Ljava/lang/Object;Ljava/lang/Object;)I": async (a: number, b: number) => a - b,
  } });
  const cmp = await newObj("webdroid/AsyncSortedComparator", null);
  const set = await newObj("java/util/TreeSet", "(Ljava/util/Comparator;)V", cmp);
  const add = (n: number) => vcall(set, "add", "(Ljava/lang/Object;)Z", n);
  await add(10); await add(12);
  expect(await Promise.all([add(19), add(16), add(19)])).toEqual([1, 1, 0]);
  expect(await vcall(set, "toArray", "()[Ljava/lang/Object;")).toEqual([10, 12, 16, 19]);
  expect(await Promise.all([vcall(set, "remove", "(Ljava/lang/Object;)Z", 12), add(11), add(13)])).toEqual([1, 1, 1]);
  expect(await vcall(set, "toArray", "()[Ljava/lang/Object;")).toEqual([10, 11, 13, 16, 19]);
  const pending = add(20);
  await vcall(set, "clear", "()V");
  expect(await pending).toBe(1);
  expect(await vcall(set, "toArray", "()[Ljava/lang/Object;")).toEqual([20]);

  const map = await newObj("java/util/TreeMap", "(Ljava/util/Comparator;)V", cmp);
  const put = (n: number) => vcall(map, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;", n, String(n));
  await put(10); await put(12);
  expect(await Promise.all([put(19), put(16), put(19)])).toEqual([null, null, "19"]);
  expect(await vcall(map, "remove", "(Ljava/lang/Object;)Ljava/lang/Object;", 16)).toBe("16");
  const keys = await vcall(map, "keySet", "()Ljava/util/Set;");
  expect(await vcall(keys, "toArray", "()[Ljava/lang/Object;")).toEqual([10, 12, 19]);
});
