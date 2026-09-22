import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall, curThread, setCurThread, type JThread } from "../src/jvm/natives/jlang";

class Value extends JObj {
  constructor(readonly value: number) { super(); }
}
rt.register({
  name: "test/MapValue",
  ctor: Value,
  methods: {
    "equals(Ljava/lang/Object;)Z": async function (this: Value, other: unknown) {
      return other instanceof Value && this.value === other.value ? 1 : 0;
    },
    "hashCode()I": async function (this: Value) { return this.value; },
  },
});
rt.linkNatives();

const O = "Ljava/lang/Object;";
const map = (cls = "java/util/HashMap") => newObj(cls);
const put = (target: unknown, key: unknown, value: unknown) =>
  vcall(target, "put", `(${O}${O})${O}`, key, value);
const equals = (a: unknown, b: unknown) => vcall(a, "equals", `(${O})Z`, b);
const hash = (value: unknown) => vcall(value, "hashCode", "()I");

test("maps compare structurally and hash equal entries identically", async () => {
  const a = await map(), b = await map("java/util/LinkedHashMap");
  await put(a, "a", new Value(7));
  await put(a, "b", "value");
  await put(b, "b", "value");
  await put(b, "a", new Value(7));

  expect(await equals(a, b)).toBe(1);
  expect(await equals(b, a)).toBe(1);
  expect(await hash(a)).toBe(await hash(b));
});

test("a null mapping is distinct from an absent key", async () => {
  const a = await map(), b = await map();
  await put(a, "present", null);
  await put(b, "other", null);

  expect(await equals(a, b)).toBe(0);
  await put(b, "present", null);
  expect(await equals(a, b)).toBe(0);
});

test("copy constructors do not share mutable mapping entries", async () => {
  for (const name of ["java/util/HashMap", "java/util/EnumMap"]) {
    const source = await map(name);
    const key = name.endsWith("EnumMap") ? Reflect.get(rt.link("java/util/concurrent/TimeUnit").ctor, "s$SECONDS") : "key";
    await put(source, key, "before");
    const copy = await newObj(name, name.endsWith("EnumMap") ? "(Ljava/util/EnumMap;)V" : "(Ljava/util/Map;)V", source);
    await put(copy, key, "after");
    expect(await vcall(source, "get", `(${O})${O}`, key)).toBe("before");
    expect(await vcall(copy, "get", `(${O})${O}`, key)).toBe("after");
  }
});

test("hash maps filter stored hashes before calling key equality", async () => {
  class Key extends JObj { hash = 1; comparisons = 0; comparedOn: JThread | null = null; }
  rt.register({ name: "test/HashFilteredKey", ctor: Key, methods: {
    "hashCode()I": async function (this: Key) { await Promise.resolve(); return this.hash; },
    "equals(Ljava/lang/Object;)Z": function (this: Key) { this.comparedOn = curThread; this.comparisons++; return 1; },
  } });
  rt.link("test/HashFilteredKey");
  const a = new Key(), b = new Key(); b.hash = 2;
  const target = await map();
  await put(target, a, "first"); await put(target, b, "second");
  expect(await vcall(target, "size", "()I")).toBe(2);
  expect(b.comparisons).toBe(0);
  expect(await vcall(target, "get", `(${O})${O}`, b)).toBe("second");
  a.hash = 3;
  expect(await vcall(target, "get", `(${O})${O}`, a)).toBeNull();
  const lookup = new Key();
  const original = curThread, worker = await newObj("java/lang/Thread");
  let result: Promise<unknown>;
  setCurThread(worker);
  try { result = vcall(target, "get", `(${O})${O}`, lookup); }
  finally { setCurThread(original); }
  expect(await result).toBe("first");
  expect(lookup.comparisons).toBe(1);
  expect(lookup.comparedOn).toBe(worker);
});
