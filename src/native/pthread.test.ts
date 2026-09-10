import { afterAll, expect, spyOn, test } from "bun:test";
import { JThread } from "../jvm/natives/jlang";
import { rt } from "../jvm/runtime";
import { Cpu, cpuByTid, cpus, invalidateRange, setA64, sigHandlers, type CallArg } from "./cpu";
import { E } from "./abi";
import { defineHost, ldp, lookupHost } from "./host";
import { libcInit } from "./libc";
import { mem } from "./mem";

afterAll(() => setA64(false));
/** a thread's pthread key values live in guest memory, where the core serves them from */
const tls = (c: Cpu, key: number): bigint => mem.ld64(c.tlsTab + 8 * key);
const setTls = (c: Cpu, key: number, v: bigint): void => mem.st64(c.tlsTab + 8 * key, v);
const call = (cpu: Cpu, name: string, ...args: CallArg[]) => cpu.call(lookupHost(name, "libc.so")!, args);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

for (const a64 of [false, true]) test(`${a64 ? "A64" : "ARM32"} pthread churn reclaims CPUs and preserves pointer-width join results`, async () => {
  setA64(a64); libcInit();
  const cpu = new Cpu(new JThread(), "pthread parent"), p = mem.malloc(96), baseline = cpus.size;
  const start = p + 80, value = a64 ? 0x123456789abcdef0n : 0x9abcdef0n;
  mem.st32(start, a64 ? 0xd65f03c0 : 0xe12fff1e); invalidateRange(start, 4);
  try {
    mem.memset(p + 16, 0xff, 56);
    expect(await call(cpu, "pthread_attr_init", p + 16)).toBe(0);
    expect(await call(cpu, "pthread_attr_getdetachstate", p + 16, p + 8)).toBe(0);
    expect(mem.ld32(p + 8)).toBe(0);
    expect(await call(cpu, "pthread_attr_setdetachstate", p + 16, 2)).toBe(E.INVAL);
    expect(await call(cpu, "pthread_attr_setdetachstate", p + 16, 1)).toBe(0);
    expect(await call(cpu, "pthread_attr_getdetachstate", p + 16, p + 8)).toBe(0);
    expect(mem.ld32(p + 8)).toBe(1);
    for (let i = 0; i < 64; i++) {
      const detached = i % 2 !== 0;
      expect(await call(cpu, "pthread_create", p, detached ? p + 16 : 0, start, a64 ? value : Number(value))).toBe(0);
      const tid = ldp(p);
      if (detached) await tick();
      else {
        mem.st64(p + 8, -1n);
        expect(await call(cpu, "pthread_join", tid, p + 8)).toBe(0);
        expect(a64 ? mem.ld64(p + 8) : BigInt(mem.ld32(p + 8) >>> 0)).toBe(value);
        if (!a64) expect(mem.ld32(p + 12)).toBe(-1);
      }
      expect(cpuByTid(tid)).toBeUndefined();
      expect(cpus.size).toBe(baseline);
      expect(await call(cpu, "pthread_join", tid, 0)).toBe(E.SRCH);
    }
    expect(await call(cpu, "pthread_join", cpu.tid, 0)).toBe(E.DEADLK);
  } finally { cpu.dispose(); invalidateRange(start, 4); mem.free(p); }
});

test("pthread detach handles running and completed threads without allowing duplicate joins", async () => {
  setA64(true); libcInit();
  const cpu = new Cpu(new JThread(), "detach parent"), p = mem.malloc(16);
  let release = () => {};
  const gate = new Promise<number>((resolve) => { release = () => resolve(42); });
  const start = defineHost("pthread_detach_gate", () => gate);
  try {
    await call(cpu, "pthread_create", p, 0, start, 0);
    const tid = ldp(p);
    expect(await call(cpu, "pthread_detach", tid)).toBe(0);
    expect(await call(cpu, "pthread_detach", tid)).toBe(E.INVAL);
    expect(await call(cpu, "pthread_join", tid, 0)).toBe(E.INVAL);
    release(); await tick();
    expect(cpuByTid(tid)).toBeUndefined();
    expect(await call(cpu, "pthread_detach", tid)).toBe(E.SRCH);
    await call(cpu, "pthread_create", p, 0, start, 0);
    const completed = ldp(p);
    await tick();
    expect(cpuByTid(completed)).toBeUndefined();
    expect(await call(cpu, "pthread_detach", completed)).toBe(0);
    expect(await call(cpu, "pthread_join", completed, 0)).toBe(E.SRCH);
  } finally { release(); cpu.dispose(); mem.free(p); }
});

test("pthread exit values survive TLS destructor rounds and destructor failures still reclaim CPUs", async () => {
  setA64(true); libcInit();
  const cpu = new Cpu(new JThread(), "destructor parent"), p = mem.malloc(24), seen: bigint[] = [];
  let key = 0;
  const dtor = defineHost("pthread_test_destructor", (child, args) => {
    seen.push(args.va()); expect(tls(child, key)).toBe(0n);
    setTls(child, key, 7n);
  });
  const start = defineHost("pthread_test_tls", (child) => { setTls(child, key, 3n); return 99; });
  try {
    await call(cpu, "pthread_key_create", p, dtor); key = mem.ld32(p);
    await call(cpu, "pthread_create", p + 8, 0, start, 0);
    const tid = ldp(p + 8);
    expect(await call(cpu, "pthread_join", tid, p + 16)).toBe(0);
    expect(mem.ld64(p + 16)).toBe(99n);
    expect(seen).toEqual([3n, 7n, 7n, 7n]);
    expect(cpuByTid(tid)).toBeUndefined();
    await call(cpu, "pthread_create", p + 8, 0, lookupHost("pthread_exit", "libc.so")!, 0x123456789abcdef0n);
    expect(await call(cpu, "pthread_join", ldp(p + 8), p + 16)).toBe(0);
    expect(mem.ld64(p + 16)).toBe(0x123456789abcdef0n);
    await call(cpu, "pthread_key_delete", key);
    const errors: unknown[] = [], previous = rt.onUncaught;
    const logging = spyOn(console, "error").mockImplementation(() => {});
    rt.onUncaught = (error) => errors.push(error);
    try {
      const broken = defineHost("pthread_broken_destructor", () => { throw new Error("destructor failure"); });
      await call(cpu, "pthread_key_create", p, broken); key = mem.ld32(p);
      await call(cpu, "pthread_create", p + 8, 0, start, 0);
      const failed = ldp(p + 8);
      expect(await call(cpu, "pthread_join", failed, 0)).toBe(0);
      expect(errors).toHaveLength(1);
      expect(cpuByTid(failed)).toBeUndefined();
    } finally { rt.onUncaught = previous; logging.mockRestore(); }
  } finally { await call(cpu, "pthread_key_delete", key); cpu.dispose(); mem.free(p); }
});

test("pthread cleanup waits for a signal handler started by its final destructor", async () => {
  setA64(true); libcInit();
  const cpu = new Cpu(new JThread(), "exit signal parent"), p = mem.malloc(16);
  let release = () => {}, started = () => {}, key = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const handler = defineHost("pthread_exit_signal", async (child) => {
    started(); await gate;
    expect(child.finished).toBe(false);
    expect(child.tlsBase).not.toBe(0);
    mem.st32(child.errnoAddr, 123);
  });
  sigHandlers.set(10, { fn: handler, flags: 0 });
  const dtor = defineHost("pthread_signal_destructor", (child) => { child.signals.push(10); });
  const start = defineHost("pthread_signal_entry", (child) => { setTls(child, key, 1n); return 42; });
  try {
    await call(cpu, "pthread_key_create", p, dtor); key = mem.ld32(p);
    await call(cpu, "pthread_create", p + 8, 0, start, 0);
    const tid = ldp(p + 8);
    await ready;
    let joined = false;
    const joining = call(cpu, "pthread_join", tid, 0).then((result) => { joined = true; return result; });
    await tick();
    expect(joined).toBe(false);
    expect(cpuByTid(tid)).toBeDefined();
    release();
    expect(await joining).toBe(0);
    expect(cpuByTid(tid)).toBeUndefined();
  } finally { release(); sigHandlers.delete(10); await call(cpu, "pthread_key_delete", key); cpu.dispose(); mem.free(p); }
});
