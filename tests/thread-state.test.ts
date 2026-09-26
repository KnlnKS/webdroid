import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { JThread, mainThread, newObj, park, vcall, vcallAsync } from "../src/jvm/natives/jlang";

rt.linkNatives();
const state = async (thread: unknown) => vcall(await vcall(thread, "getState", "()Ljava/lang/Thread$State;"), "name", "()Ljava/lang/String;");

test("Thread states distinguish new, runnable and terminated threads", async () => {
  const thread = await newObj("java/lang/Thread");
  expect(await state(thread)).toBe("NEW");
  expect(await state(mainThread)).toBe("RUNNABLE");
  await vcall(thread, "start", "()V");
  await vcall(thread, "join", "()V");
  expect(await state(thread)).toBe("TERMINATED");
  await expect(vcallAsync(thread, "start", "()V")).rejects.toBeDefined();
});

test("Thread states expose monitor contention, timed parking, wakeup and interruption", async () => {
  const thread = new JThread(); thread.alive = 1;
  const lock = {}, owner = new JThread(); owner.alive = 1;
  rt.monitors.enter(lock, owner);
  const entered = rt.monitors.enter(lock, thread);
  expect(await state(thread)).toBe("BLOCKED");
  rt.monitors.exit(lock, owner);
  await entered;
  rt.monitors.exit(lock, thread);
  let wake = () => {};
  const waiting = park(thread, (resume) => { wake = resume; return () => {}; });
  expect(await state(thread)).toBe("WAITING");
  wake(); await waiting;
  expect(await state(thread)).toBe("RUNNABLE");
  const timed = park(thread, () => () => {}, 10000);
  expect(await state(thread)).toBe("TIMED_WAITING");
  const interrupted = timed.then(() => false, () => true);
  await vcall(thread, "interrupt", "()V");
  expect(await interrupted).toBe(true);
  expect(await state(thread)).toBe("RUNNABLE");
});
