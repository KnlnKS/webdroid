import { expect, test } from "bun:test";
import { mainThread } from "../src/jvm/natives/jlang";
import { Cpu, setA64 } from "../src/native/cpu";
import { hostLib, lookupHost } from "../src/native/host";
import { pthreadInit, startThread } from "../src/native/pthread";

test("joinable pthread handles stay distinct until joined", async () => {
  setA64(true); pthreadInit();
  hostLib("libc.so", { webdroid_test_thread_return: () => 0 });
  const start = lookupHost("webdroid_test_thread_return", "libc.so");
  const join = lookupHost("pthread_join", "libc.so");
  if (start === undefined || join === undefined) throw new Error("pthread entry point unavailable");
  const parent = new Cpu(mainThread, "pthread-handle-parent");
  const first = startThread(parent, start, 0n, false);
  try {
    for (let i = 0; !first.finished && i < 100; i++) await new Promise(r => setTimeout(r, 1));
    expect(first.finished).toBe(true);
    const second = startThread(parent, start, 0n, false);
    expect(second.pthreadSelf).not.toBe(first.pthreadSelf);
    expect(await parent.call(join, [first.pthreadSelf, 0])).toBe(0);
    expect(await parent.call(join, [second.pthreadSelf, 0])).toBe(0);
  } finally { parent.dispose(); setA64(false); }
});
