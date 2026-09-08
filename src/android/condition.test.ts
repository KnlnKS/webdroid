import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";

test("condition variables retain open state, broadcast, close, and time out", async () => {
  const c = await newObj("android/os/ConditionVariable", "(Z)V", 1);
  expect(await vcall(c, "block", "(J)Z", 1n)).toBe(1);
  await vcall(c, "close", "()V");
  expect(await vcall(c, "block", "(J)Z", 1n)).toBe(0);
  let released = 0;
  const waits = [0, 1].map(() => vcall(c, "block", "()V").then(() => { released++; }));
  await Promise.resolve();
  expect(released).toBe(0);
  await vcall(c, "open", "()V");
  await Promise.all(waits);
  expect(released).toBe(2);
  expect(await vcall(c, "block", "(J)Z", 0n)).toBe(1);
  await vcall(c, "close", "()V");
  expect(await vcall(c, "block", "(J)Z", -1n)).toBe(0);
});
