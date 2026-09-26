import { expect, test } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { vcall, curThread, JThread, mainThread, setCurThread, vcallOn, vcallAsync } from "../src/jvm/natives/jlang";
import { newArrayList } from "../src/jvm/natives/jutil";

class Sequential extends rt.link("java/util/AbstractSequentialList").ctor {
  values = newArrayList(["a", "b", "c"]);
  positions: number[] = [];
  failure: unknown = null;
}
rt.register({ name: "test/Sequential", ctor: Sequential, sup: "java/util/AbstractSequentialList", methods: {
  "size()I": function (this: Sequential) { return vcall(this.values, "size", "()I"); },
  "listIterator(I)Ljava/util/ListIterator;": async function (this: Sequential, index: number) {
    await Promise.resolve();
    this.positions.push(index);
    if (this.failure) throw this.failure;
    return vcall(this.values, "listIterator", "(I)Ljava/util/ListIterator;", index);
  },
} });
rt.linkNatives();

test("sequential list access and bulk insertion use the subclass's live iterator", async () => {
  const list = new Sequential();
  expect(await vcall(list, "get", "(I)Ljava/lang/Object;", 1)).toBe("b");
  expect(await vcall(list, "set", "(ILjava/lang/Object;)Ljava/lang/Object;", 1, "B")).toBe("b");
  expect(await vcall(list, "remove", "(I)Ljava/lang/Object;", 0)).toBe("a");
  await vcall(list, "add", "(ILjava/lang/Object;)V", 1, "x");
  list.positions.length = 0;
  expect(await vcall(list, "addAll", "(ILjava/util/Collection;)Z", 1, newArrayList(["y", "z"]))).toBe(1);
  expect(list.positions).toEqual([1]);
  expect(await vcall(list, "toArray", "()[Ljava/lang/Object;")).toEqual(["B", "y", "z", "x", "c"]);
  list.positions.length = 0;
  const it = await vcall(list, "iterator", "()Ljava/util/Iterator;");
  expect(list.positions).toEqual([0]);
  expect(await vcall(it, "next", "()Ljava/lang/Object;")).toBe("B");
  await vcall(it, "remove", "()V");
  expect(await vcall(list, "get", "(I)Ljava/lang/Object;", 0)).toBe("y");
  expect(await vcall(list, "indexOf", "(Ljava/lang/Object;)I", "x")).toBe(2);
  expect(await vcall(list, "addAll", "(ILjava/util/Collection;)Z", 4, newArrayList())).toBe(0);
  expect(rt.iof(list, "java/util/List")).toBe(1);
});

test("sequential list converts iterator exhaustion without suppressing other failures", async () => {
  const list = new Sequential();
  for (const [name, desc, args] of [
    ["get", "(I)Ljava/lang/Object;", [3]],
    ["set", "(ILjava/lang/Object;)Ljava/lang/Object;", [3, "x"]],
    ["remove", "(I)Ljava/lang/Object;", [3]],
  ] satisfies [string, string, unknown[]][]) {
    await expect(vcallAsync(list, name, desc, ...args)).rejects.toMatchObject({ msg: "Index: 3" });
  }
  const failure = rt.mkThrowable("java/lang/UnsupportedOperationException", "iterator is immutable");
  list.failure = failure;
  await expect(vcallAsync(list, "add", "(ILjava/lang/Object;)V", 0, "x")).rejects.toBe(failure);
  list.failure = rt.mkThrowable("java/util/NoSuchElementException", "exhausted");
  await expect(vcallAsync(list, "addAll", "(ILjava/util/Collection;)Z", 8, newArrayList())).rejects.toMatchObject({ msg: "Index: 8" });
});


test("sequential iterator callbacks retain their caller after suspension", async () => {
  const seen: JThread[] = [];
  class ThreadIterator extends JObj {}
  rt.register({ name: "test/SequentialThreadIterator", ctor: ThreadIterator, methods: {
    "next()Ljava/lang/Object;": async () => { seen.push(curThread); await Promise.resolve(); return "old"; },
    "set(Ljava/lang/Object;)V": () => { seen.push(curThread); },
  } });
  class ThreadList extends rt.link("java/util/AbstractSequentialList").ctor {}
  rt.register({ name: "test/SequentialThreadList", ctor: ThreadList, sup: "java/util/AbstractSequentialList", methods: {
    "listIterator(I)Ljava/util/ListIterator;": async () => { seen.push(curThread); await Promise.resolve(); return new ThreadIterator(); },
  } });
  rt.linkNatives();
  const caller = new JThread();
  const result = vcallOn(caller, new ThreadList(), "set", "(ILjava/lang/Object;)Ljava/lang/Object;", 0, "new");
  setCurThread(mainThread);
  expect(await result).toBe("old");
  expect(seen.map(thread => thread === caller)).toEqual([true, true, true]);
  expect(curThread).toBe(mainThread);
});
