import { setTimeout as sleep } from "node:timers/promises";
import { expect, test } from "vite-plus/test";
import { JThread } from "../jvm/natives/jentry.ts";
import { Cpu, cpus, setA64 } from "./cpu.ts";
import { core, CORE_LIBC } from "./core.ts";
import { Args, hostFn, lookupHost } from "./host.ts";
import { mem } from "./mem.ts";
import { pthreadInit, startThread } from "./pthread.ts";

test("pthread attributes and cleanup handlers preserve bionic behavior", async () => {
  setA64(false); pthreadInit();
  const cpu = new Cpu(new JThread(), "pthread-test");
  const attr = mem.malloc(64), entry = mem.malloc(24), value = mem.malloc(4), out = mem.malloc(8);
  const routine = mem.reserve(4096, 4096);
  mem.u32.set([0xe3a0102a, 0xe5801000, 0xe12fff1e], routine >>> 2);
  const call = (name: string, args: number[]) => cpu.call(lookupHost(name, "libc.so")!, args);
  try {
    expect(await call("pthread_attr_init", [attr])).toBe(0);
    expect(await call("pthread_attr_setguardsize", [attr, 128])).toBe(0);
    expect(await call("pthread_attr_getguardsize", [attr, out])).toBe(0);
    expect(mem.ld32(out)).toBe(128);
    expect(await call("pthread_attr_setscope", [attr, 0])).toBe(0);
    expect(await call("pthread_attr_setscope", [attr, 1])).toBe(95);
    expect(await call("pthread_attr_setscope", [attr, 2])).toBe(22);
    await call("__pthread_cleanup_push", [entry, routine, value]);
    expect(mem.ld32(entry + 4) >>> 0).toBe(routine);
    await call("__pthread_cleanup_pop", [entry, 1]);
    expect(mem.ld32(value)).toBe(42);
  } finally {
    mem.free(attr); mem.free(entry); mem.free(value); mem.free(out); cpu.dispose();
  }
});

test("joinable pthread handles remain distinct after their routines exit", async () => {
  setA64(false); pthreadInit();
  const parent = new Cpu(new JThread(), "join-test");
  const routine = mem.reserve(4096, 4096), result = mem.malloc(8);
  mem.u32.set([0xe3a00007, 0xe12fff1e], routine >>> 2);
  try {
    const first = startThread(parent, routine, 0n, false);
    for (let i = 0; cpus.has(first) && i < 5000; i++) await sleep(1);
    expect(cpus.has(first)).toBe(false);
    const second = startThread(parent, routine, 0n, false);
    expect(second.pthreadSelf).not.toBe(first.pthreadSelf);
    expect(await parent.call(lookupHost("pthread_join", "libc.so")!, [first.pthreadSelf, result])).toBe(0);
    expect(mem.ld32(result)).toBe(7);
    expect(await parent.call(lookupHost("pthread_join", "libc.so")!, [second.pthreadSelf, result])).toBe(0);
    expect(mem.ld32(result)).toBe(7);
  } finally {
    mem.free(result); parent.dispose();
  }
});

test("rwlock words are shared by the core's uncontended calls and the host's waiters", async () => {
  setA64(false); pthreadInit();
  const lock = mem.malloc(64), reader = new Cpu(new JThread(), "reader"), writer = new Cpu(new JThread(), "writer");
  mem.memset(lock, 0, 64);
  const served = (cpu: Cpu, name: string) => { cpu.w[0] = lock; cpu.w[1] = 0; return core.libc_call(cpu.base, CORE_LIBC[name]); };
  const host = (cpu: Cpu, name: string) => { cpu.w[0] = lock; cpu.w[1] = 0; return hostFn("libc.so", name)!(cpu, new Args(cpu)); };
  const settled = async (p: unknown) => { let done = false; void (p as Promise<unknown>).then(() => { done = true; }); for (let i = 0; i < 5; i++) await Promise.resolve(); return done; };
  try {
    expect(served(reader, "pthread_rwlock_rdlock")).toBe(0);
    expect(served(reader, "pthread_rwlock_rdlock")).toBe(0);
    expect(served(writer, "pthread_rwlock_wrlock")).toBe(2);
    const blocked = host(writer, "pthread_rwlock_wrlock");
    expect(blocked).toBeInstanceOf(Promise);
    expect(served(reader, "pthread_rwlock_unlock")).toBe(2);
    expect(host(reader, "pthread_rwlock_unlock")).toBe(0);
    expect(await settled(blocked)).toBe(false);
    expect(host(reader, "pthread_rwlock_unlock")).toBe(0);
    expect(await blocked).toBe(0);
    expect([mem.ld32(lock) >>> 0, mem.ld32(lock + 4), mem.ld32(lock + 8)]).toEqual([0x80000000, writer.tid, 0]);
    expect(served(reader, "pthread_rwlock_tryrdlock")).toBe(0);
    expect(reader.w[0]).toBe(16);
    expect(served(writer, "pthread_rwlock_unlock")).toBe(0);
    expect(mem.ld32(lock)).toBe(0);
  } finally {
    mem.free(lock); reader.dispose(); writer.dispose();
  }
});
