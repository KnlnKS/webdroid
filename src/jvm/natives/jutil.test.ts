import { expect, test } from "bun:test";
import { JObj, rt } from "../runtime";
import { mangleMethod } from "../abi";
import { linkInit, newObj, vcall } from "./jlang";
import "./jutil";
import "./jreflect";

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
