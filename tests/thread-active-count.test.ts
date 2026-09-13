import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";

class BlockingRunnable extends JObj {
  done = Promise.resolve();
}
rt.register({
  name: "test/BlockingRunnable", ctor: BlockingRunnable, ifaces: ["java/lang/Runnable"],
  methods: { "run()V": function (this: BlockingRunnable) { return this.done; } },
});
rt.linkNatives();

test("Thread.activeCount follows live modeled threads", async () => {
  const active: unknown = Reflect.get(rt.link("java/lang/Thread").ctor, mangleMethod("activeCount", "()I"));
  expect(typeof active).toBe("function");
  if (typeof active !== "function") return;
  const before = active();
  let release = () => {};
  const runnable = new BlockingRunnable();
  runnable.done = new Promise<void>((resolve) => { release = resolve; });
  const thread = await newObj("java/lang/Thread", "(Ljava/lang/Runnable;)V", runnable);
  await vcall(thread, "start", "()V");
  expect(active()).toBe(before + 1);
  release();
  await vcall(thread, "join", "()V");
  expect(active()).toBe(before);
});
