import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("PriorityBlockingQueue keeps a compared item queued until insertion completes", async () => {
  let compareStarted!: () => void, finishCompare!: () => void;
  const started = new Promise<void>((resolve) => { compareStarted = resolve; });
  const gate = new Promise<void>((resolve) => { finishCompare = resolve; });
  class Entry extends JObj { key: number | null = null; }
  rt.register({ name: "test/PriorityQueueEntry", ctor: Entry, methods: {
    "compareTo(Ljava/lang/Object;)I": async function (this: Entry, other: Entry) {
      compareStarted();
      await gate;
      if (this.key === null || other.key === null) throw new Error("compared a released entry");
      return this.key - other.key;
    },
  } });
  const queue = await newObj("java/util/concurrent/PriorityBlockingQueue");
  const first = rt.make("test/PriorityQueueEntry") as Entry, second = rt.make("test/PriorityQueueEntry") as Entry;
  first.key = 1; second.key = 2;
  await vcall(queue, "offer", "(Ljava/lang/Object;)Z", first);
  const insertion = vcall(queue, "offer", "(Ljava/lang/Object;)Z", second);
  await started;
  let released = false;
  const removal = vcall(queue, "remove", "(Ljava/lang/Object;)Z", first).then(() => {
    first.key = null;
    released = true;
  });
  await Promise.resolve();
  expect(released).toBe(false);
  finishCompare();
  await Promise.all([insertion, removal]);
  expect(await vcall(queue, "poll", "()Ljava/lang/Object;")).toBe(second);
});
