import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { JHandler, JMessage } from "../src/android/os";
import { onMain } from "../src/android/mainloop";

class RecordingHandler extends JHandler {
  delivered: number[] = [];
}
class RecordingRunnable extends JObj {
  runs = 0;
  onRun: (() => void) | null = null;
}
rt.register({
  name: "test/RecordingHandler", ctor: RecordingHandler, sup: "android/os/Handler",
  methods: {
    "handleMessage(Landroid/os/Message;)V": function (this: RecordingHandler, message: JMessage) {
      this.delivered.push(message.arg1);
    },
  },
});
rt.register({
  name: "test/RecordingRunnable", ctor: RecordingRunnable, ifaces: ["java/lang/Runnable"],
  methods: { "run()V": function (this: RecordingRunnable) { this.runs++; this.onRun?.(); } },
});
rt.linkNatives();

function message(what: number, value: number): JMessage {
  const result = new JMessage();
  result.what = what;
  result.arg1 = value;
  return result;
}

test("removing queued messages preserves other keys and a later replacement", async () => {
  const handler = new RecordingHandler();
  await onMain(async () => {
    await vcall(handler, "sendMessage", "(Landroid/os/Message;)Z", message(3, 1));
    await vcall(handler, "sendMessage", "(Landroid/os/Message;)Z", message(4, 2));
    expect(await vcall(handler, "hasMessages", "(I)Z", 3)).toBe(1);
    await vcall(handler, "removeMessages", "(I)V", 3);
    expect(await vcall(handler, "hasMessages", "(I)Z", 3)).toBe(0);
    await vcall(handler, "sendMessage", "(Landroid/os/Message;)Z", message(3, 3));
  });
  await onMain(() => {});
  expect(handler.delivered).toEqual([2, 3]);
});

test("a delayed message can be removed after its timer expires behind a busy looper", async () => {
  const handler = new RecordingHandler();
  await onMain(async () => {
    await vcall(handler, "sendMessageDelayed", "(Landroid/os/Message;J)Z", message(3, 1), 1n);
    await Bun.sleep(20);
    expect(await vcall(handler, "hasMessages", "(I)Z", 3)).toBe(1);
    await vcall(handler, "removeMessages", "(I)V", 3);
    await vcall(handler, "sendMessage", "(Landroid/os/Message;)Z", message(3, 2));
  });
  await onMain(() => {});
  expect(handler.delivered).toEqual([2]);
});

test("removing queued callbacks permits reposting the same runnable", async () => {
  const handler = new RecordingHandler(), removed = new RecordingRunnable(), kept = new RecordingRunnable();
  await onMain(async () => {
    await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", removed);
    await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", kept);
    await vcall(handler, "removeCallbacks", "(Ljava/lang/Runnable;)V", removed);
    await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", removed);
  });
  await onMain(() => {});
  expect(removed.runs).toBe(1);
  expect(kept.runs).toBe(1);
});

test("hasCallbacks reflects queued runnable identity", async () => {
  const handler = new RecordingHandler(), runnable = new RecordingRunnable();
  await onMain(async () => {
    expect(await vcall(handler, "hasCallbacks", "(Ljava/lang/Runnable;)Z", runnable)).toBe(0);
    await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", runnable);
    expect(await vcall(handler, "hasCallbacks", "(Ljava/lang/Runnable;)Z", runnable)).toBe(1);
    await vcall(handler, "removeCallbacks", "(Ljava/lang/Runnable;)V", runnable);
    expect(await vcall(handler, "hasCallbacks", "(Ljava/lang/Runnable;)Z", runnable)).toBe(0);
  });
});

test("removeCallbacksAndMessages cancels queued messages and runnables", async () => {
  const handler = new RecordingHandler(), runnable = new RecordingRunnable();
  await onMain(async () => {
    await vcall(handler, "sendMessage", "(Landroid/os/Message;)Z", message(3, 1));
    await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", runnable);
    await vcall(handler, "removeCallbacksAndMessages", "(Ljava/lang/Object;)V", null);
    await vcall(handler, "post", "(Ljava/lang/Runnable;)Z", runnable);
  });
  await onMain(() => {});
  expect(handler.delivered).toEqual([]);
  expect(runnable.runs).toBe(1);
});

test("removeCallbacksAndMessages keeps work belonging to another token", async () => {
  const handler = new RecordingHandler();
  const removedToken = new JObj(), keptToken = new JObj();
  const removed = new RecordingRunnable(), kept = new RecordingRunnable();
  await onMain(async () => {
    const first = message(3, 1), second = message(3, 2);
    first.obj = removedToken; second.obj = keptToken;
    await vcall(handler, "sendMessage", "(Landroid/os/Message;)Z", first);
    await vcall(handler, "sendMessage", "(Landroid/os/Message;)Z", second);
    await vcall(handler, "postDelayed", "(Ljava/lang/Runnable;Ljava/lang/Object;J)Z", removed, removedToken, 0n);
    await vcall(handler, "postDelayed", "(Ljava/lang/Runnable;Ljava/lang/Object;J)Z", kept, keptToken, 0n);
    await vcall(handler, "removeCallbacksAndMessages", "(Ljava/lang/Object;)V", removedToken);
  });
  await onMain(() => {});
  expect(handler.delivered).toEqual([2]);
  expect(removed.runs).toBe(0);
  expect(kept.runs).toBe(1);
});

test("a long-lived Handler releases completed callback keys", async () => {
  const handler = new RecordingHandler();
  await onMain(() => {
    for (let i = 0; i < 1000; i++) handler.post(new RecordingRunnable(), 0);
  });
  await onMain(() => {});
  expect(handler.pending.size).toBe(0);
});

test("a callback can repost itself while being dispatched", async () => {
  const handler = new RecordingHandler(), runnable = new RecordingRunnable();
  runnable.onRun = () => { if (runnable.runs === 1) handler.post(runnable, 0); };
  await onMain(() => handler.post(runnable, 0));
  await onMain(() => {});
  await onMain(() => {});
  expect(runnable.runs).toBe(2);
  expect(handler.pending.size).toBe(0);
});

class IdleHandler extends JObj { calls = 0; keep = true; wake: (() => void) | null = null; }
rt.register({ name: "test/QueueIdleHandler", ctor: IdleHandler, ifaces: ["android/os/MessageQueue$IdleHandler"], methods: {
  "queueIdle()Z": function (this: IdleHandler) { this.calls++; this.wake?.(); return +this.keep; },
} });
rt.link("test/QueueIdleHandler");
test("queue idle state excludes future messages and removes cancelled due work", async () => {
  const handler = new RecordingHandler();
  const queue = await vcall(handler.looper, "getQueue", "()Landroid/os/MessageQueue;");
  await onMain(async () => {
    handler.send(message(1, 0), 10000);
    expect(await vcall(queue, "isIdle", "()Z")).toBe(1);
    handler.send(message(2, 0), 0);
    expect(await vcall(queue, "isIdle", "()Z")).toBe(0);
    handler.cancel(2);
    expect(await vcall(queue, "isIdle", "()Z")).toBe(1);
    handler.cancel(1);
  });
});
test("idle handlers run once per idle transition and can be removed", async () => {
  const handler = new RecordingHandler(), idle = new IdleHandler();
  const queue = await vcall(handler.looper, "getQueue", "()Landroid/os/MessageQueue;");
  let notified = new Promise<void>(resolve => { idle.wake = resolve; });
  await vcall(queue, "addIdleHandler", "(Landroid/os/MessageQueue$IdleHandler;)V", idle);
  await notified;
  expect(idle.calls).toBe(1);
  notified = new Promise<void>(resolve => { idle.wake = resolve; });
  handler.send(message(1, 2), 0);
  await notified;
  expect(idle.calls).toBe(2);
  await vcall(queue, "removeIdleHandler", "(Landroid/os/MessageQueue$IdleHandler;)V", idle);
  handler.send(message(1, 3), 0);
  await onMain(() => {});
  expect(idle.calls).toBe(2);
});
