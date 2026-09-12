import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("PhantomReference never yields its referent and enqueues nothing", async () => {
  const queue = await newObj("java/lang/ref/ReferenceQueue");
  const referent = await newObj("java/lang/Object");
  const ref = await newObj("java/lang/ref/PhantomReference", "(Ljava/lang/Object;Ljava/lang/ref/ReferenceQueue;)V", referent, queue);
  expect(rt.iof(ref, "java/lang/ref/Reference")).toBe(1);
  expect(await vcall(ref, "get", "()Ljava/lang/Object;")).toBeNull();
  expect(await vcall(queue, "poll", "()Ljava/lang/ref/Reference;")).toBeNull();
  expect(await vcall(queue, "remove", "(J)Ljava/lang/ref/Reference;", 5n)).toBeNull();
});

test("InheritableThreadLocal values reach threads created afterwards", async () => {
  const local = await newObj("java/lang/InheritableThreadLocal");
  await vcall(local, "set", "(Ljava/lang/Object;)V", "inherited");
  const thread = await newObj("java/lang/Thread");
  expect(thread.locals.get(local)).toBe("inherited");
  expect(await vcall(local, "get", "()Ljava/lang/Object;")).toBe("inherited");
  await vcall(await newObj("java/lang/Object"), "hashCode", "()I");
  expect(rt.iof(local, "java/lang/ThreadLocal")).toBe(1);
});
