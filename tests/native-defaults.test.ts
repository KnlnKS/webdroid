import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { mkIter } from "../src/jvm/natives/jutil";

class Consumer extends JObj { values: unknown[] = []; }
rt.register({ name: "test/NativeIteratorConsumer", ctor: Consumer, ifaces: ["java/util/function/Consumer"], methods: {
  "accept(Ljava/lang/Object;)V": function (this: Consumer, value: unknown) { this.values.push(value); },
} });
rt.linkNatives();

test("native-created iterators receive interface defaults without explicit class initialization", async () => {
  const iterator = mkIter(["first", "second", "third"]), consumer = new Consumer();
  expect(await vcall(iterator, "next", "()Ljava/lang/Object;")).toBe("first");
  await vcall(iterator, "forEachRemaining", "(Ljava/util/function/Consumer;)V", consumer);
  expect(consumer.values).toEqual(["second", "third"]);
  expect(await vcall(iterator, "hasNext", "()Z")).toBe(0);
  await vcall(iterator, "remove", "()V");
  expect(iterator.arr).toEqual(["first", "second"]);
});
