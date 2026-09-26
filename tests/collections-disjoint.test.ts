import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { newArrayList } from "../src/jvm/natives/jutil";
rt.linkNatives();

const disjoint = (a: unknown, b: unknown) => vcallAsync(rt.link("java/util/Collections").ctor, "disjoint", "(Ljava/util/Collection;Ljava/util/Collection;)Z", a, b);

test("disjoint handles empty collections, shared members and null", async () => {
  const empty = newArrayList(), list = newArrayList(["x", null]);
  expect(await disjoint(empty, empty)).toBe(1);
  expect(await disjoint(list, list)).toBe(0);
  expect(await disjoint(list, newArrayList(["y"]))).toBe(1);
  expect(await disjoint(list, newArrayList([null]))).toBe(0);
  expect(await disjoint(empty, null).catch(e => rt.iof(e, "java/lang/NullPointerException"))).toBe(1);
});

test("disjoint dispatches suspending equality and Set membership", async () => {
  class Value extends JObj {}
  rt.register({ name: "test/DisjointValue", ctor: Value, methods: {
    "equals(Ljava/lang/Object;)Z": async (other: unknown) => other instanceof Value ? 1 : 0,
    "hashCode()I": () => 19,
  } });
  rt.link("test/DisjointValue");
  const set = await newObj("java/util/HashSet");
  await vcall(set, "add", "(Ljava/lang/Object;)Z", new Value());
  expect(await disjoint(set, newArrayList([new Value()]))).toBe(0);
  expect(await disjoint(newArrayList([new Value()]), set)).toBe(0);
  expect(await disjoint(set, newArrayList(["other"]))).toBe(1);
});
