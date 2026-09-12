import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("Semaphore.drainPermits returns positive, zero and negative counts and empties the semaphore", async () => {
  for (const permits of [7, 0, -3]) {
    const semaphore = await newObj("java/util/concurrent/Semaphore", "(I)V", permits);
    expect(await vcall(semaphore, "drainPermits", "()I")).toBe(permits);
    expect(await vcall(semaphore, "availablePermits", "()I")).toBe(0);
    expect(await vcall(semaphore, "drainPermits", "()I")).toBe(0);
    expect(await vcall(semaphore, "tryAcquire", "()Z")).toBe(0);
    await vcall(semaphore, "release", "()V");
    expect(await vcall(semaphore, "tryAcquire", "()Z")).toBe(1);
  }
});

test("draining permits does not complete a waiting acquisition", async () => {
  const semaphore = await newObj("java/util/concurrent/Semaphore", "(I)V", 1);
  let completed = false;
  const waiting = vcall(semaphore, "acquire", "(I)V", 2).then(() => { completed = true; });
  expect(await vcall(semaphore, "drainPermits", "()I")).toBe(1);
  await vcall(semaphore, "release", "()V");
  expect(completed).toBe(false);
  await vcall(semaphore, "release", "()V");
  await waiting;
  expect(completed).toBe(true);
  expect(await vcall(semaphore, "availablePermits", "()I")).toBe(0);
});
