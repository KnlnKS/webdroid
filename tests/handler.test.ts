import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { JHandler } from "../src/android/os";
import { JMessage } from "../src/android/messenger";
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
