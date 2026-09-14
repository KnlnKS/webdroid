import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();
test("reference queue state survives explicit enqueue, blocked removal and repeated enqueue", async () => {
  const queue = await newObj("java/lang/ref/ReferenceQueue");
  const value = new JObj();
  const ref = await newObj("java/lang/ref/WeakReference", "(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V", value, queue);
  expect(await vcall(ref, "get", "()Ljava/lang/Object;")).toBe(value);
  expect(await vcall(ref, "isEnqueued", "()Z")).toBe(0);
  const waiting = vcall(queue, "remove", "()Ljava/lang/ref/Reference;");
  expect(await vcall(ref, "enqueue", "()Z")).toBe(1);
  expect(await waiting).toBe(ref);
  expect(await vcall(ref, "get", "()Ljava/lang/Object;")).toBeNull();
  expect(await vcall(ref, "isEnqueued", "()Z")).toBe(0);
  expect(await vcall(ref, "enqueue", "()Z")).toBe(0);
  expect(await vcall(queue, "poll", "()Ljava/lang/ref/Reference;")).toBeNull();
});
test("references accept Java string values and clearing does not enqueue them", async () => {
  const queue = await newObj("java/lang/ref/ReferenceQueue");
  const ref = await newObj("java/lang/ref/WeakReference", "(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V", "text", queue);
  expect(await vcall(ref, "get", "()Ljava/lang/Object;")).toBe("text");
  await vcall(ref, "clear", "()V");
  expect(await vcall(ref, "get", "()Ljava/lang/Object;")).toBeNull();
  expect(await vcall(queue, "poll", "()Ljava/lang/ref/Reference;")).toBeNull();
  expect(await vcall(queue, "remove", "(J)Ljava/lang/ref/Reference;", 1n)).toBeNull();
});
