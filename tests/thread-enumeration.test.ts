import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { jarray } from "../src/jvm/abi";
import { newObj, vcall, curThread, mainThread } from "../src/jvm/natives/jlang";
import { mainLooper } from "../src/android/os";

class WaitingTask extends JObj { finish: (() => void) | null = null; }
rt.register({ name: "test/EnumerationTask", ctor: WaitingTask, ifaces: ["java/lang/Runnable"], methods: {
  "run()V": function (this: WaitingTask) { return new Promise<void>(resolve => { this.finish = resolve; }); },
} });
rt.linkNatives();

test("thread enumeration includes suspended live threads and removes completed threads", async () => {
  const cls = rt.link("java/lang/Thread").ctor;
  const count = await vcall(cls, "activeCount", "()I");
  const task = await newObj("test/EnumerationTask");
  const thread = await newObj("java/lang/Thread", "(Ljava/lang/Runnable;)V", task);
  await vcall(thread, "start", "()V");
  await Bun.sleep(0);
  try {
    expect(curThread).toBe(mainThread);
    expect(await vcall(cls, "activeCount", "()I")).toBe(count + 1);
    const threads = jarray(new Array(count + 2).fill(null), "Ljava/lang/Thread;");
    expect(await vcall(cls, "enumerate", "([Ljava/lang/Thread;)I", threads)).toBe(count + 1);
    expect(threads).toContain(thread);
  } finally { task.finish?.(); }
  await vcall(thread, "join", "()V");
  expect(await vcall(cls, "activeCount", "()I")).toBe(count);
});

test("a suspended looper job releases ambient thread identity while preserving queue order", async () => {
  const thread = await newObj("java/lang/Thread"), looper = rt.make("android/os/Looper") as typeof mainLooper;
  looper.thread = thread;
  let started!: () => void, finish!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  const events: string[] = [];
  const first = looper.run(() => {
    expect(curThread).toBe(thread); events.push("first"); started(); return held;
  });
  const second = looper.run(() => { expect(curThread).toBe(thread); events.push("second"); });
  await began;
  try {
    expect(curThread).toBe(mainThread);
    expect(events).toEqual(["first"]);
  } finally { finish(); }
  await Promise.all([first, second]);
  expect(events).toEqual(["first", "second"]);
  expect(curThread).toBe(mainThread);
});
