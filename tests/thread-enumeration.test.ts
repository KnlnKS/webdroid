import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { jarray } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";

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
    expect(await vcall(cls, "activeCount", "()I")).toBe(count + 1);
    const threads = jarray(new Array(count + 2).fill(null), "Ljava/lang/Thread;");
    expect(await vcall(cls, "enumerate", "([Ljava/lang/Thread;)I", threads)).toBe(count + 1);
    expect(threads).toContain(thread);
  } finally { task.finish?.(); }
  await vcall(thread, "join", "()V");
  expect(await vcall(cls, "activeCount", "()I")).toBe(count);
});
