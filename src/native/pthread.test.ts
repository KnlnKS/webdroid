import { expect, test } from "bun:test";
import { JThread } from "../jvm/natives/jlang";
import { Cpu, cpus, setA64 } from "./cpu";
import { lookupHost } from "./host";
import { mem } from "./mem";
import { pthreadInit, startThread } from "./pthread";

test("pthread attributes and cleanup handlers preserve bionic behavior", async () => {
  setA64(true); pthreadInit();
  const cpu = new Cpu(new JThread(), "pthread-test");
  const attr = mem.malloc(64), entry = mem.malloc(24), value = mem.malloc(4), out = mem.malloc(8);
  const routine = mem.reserve(4096, 4096);
  mem.u32.set([0x52800541, 0xb9000001, 0xd65f03c0], routine >>> 2);
  const call = (name: string, args: number[]) => cpu.call(lookupHost(name, "libc.so")!, args);
  try {
    expect(await call("pthread_attr_init", [attr])).toBe(0);
    expect(await call("pthread_attr_setguardsize", [attr, 128])).toBe(0);
    expect(await call("pthread_attr_getguardsize", [attr, out])).toBe(0);
    expect(Number(mem.ld64(out))).toBe(128);
    expect(await call("pthread_attr_setscope", [attr, 0])).toBe(0);
    expect(await call("pthread_attr_setscope", [attr, 1])).toBe(95);
    expect(await call("pthread_attr_setscope", [attr, 2])).toBe(22);
    await call("__pthread_cleanup_push", [entry, routine, value]);
    expect(mem.ld32(entry + 8) >>> 0).toBe(routine);
    await call("__pthread_cleanup_pop", [entry, 1]);
    expect(mem.ld32(value)).toBe(42);
  } finally {
    mem.free(attr); mem.free(entry); mem.free(value); mem.free(out); cpu.dispose(); setA64(false);
  }
});

test("joinable pthread handles remain distinct after their routines exit", async () => {
  setA64(true); pthreadInit();
  const parent = new Cpu(new JThread(), "join-test");
  const routine = mem.reserve(4096, 4096), result = mem.malloc(8);
  mem.u32.set([0x528000e0, 0xd65f03c0], routine >>> 2);
  try {
    const first = startThread(parent, routine, 0n, false);
    for (let i = 0; cpus.has(first) && i < 5000; i++) await Bun.sleep(1);
    expect(cpus.has(first)).toBe(false);
    const second = startThread(parent, routine, 0n, false);
    expect(second.pthreadSelf).not.toBe(first.pthreadSelf);
    expect(await parent.call(lookupHost("pthread_join", "libc.so")!, [first.pthreadSelf, result])).toBe(0);
    expect(mem.ld64(result)).toBe(7n);
    expect(await parent.call(lookupHost("pthread_join", "libc.so")!, [second.pthreadSelf, result])).toBe(0);
    expect(mem.ld64(result)).toBe(7n);
  } finally {
    mem.free(result); parent.dispose(); setA64(false);
  }
});
