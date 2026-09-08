import { afterAll, expect, test } from "bun:test";
import { JThread } from "../jvm/natives/jlang";
import { Cpu, setA64, sigHandlers } from "./cpu";
import { defineHost, lookupHost } from "./host";
import { libcInit, LAYOUT } from "./libc";
import { mem } from "./mem";

afterAll(() => { sigHandlers.clear(); setA64(false); });
const call = (cpu: Cpu, name: string, ...args: number[]) => cpu.call(lookupHost(name, "libc.so")!, args);

for (const a64 of [false, true]) test(`${a64 ? "A64" : "ARM32"} signal masks retain blocked signals and deliver after unblocking`, async () => {
  setA64(a64); libcInit();
  const cpu = new Cpu(new JThread(), "signal test"), p = mem.malloc(32), got: number[] = [];
  const handler = defineHost("signal_test_handler", (_c, a) => { got.push(a.i()); });
  sigHandlers.set(10, { fn: handler, flags: 0 });
  try {
    mem.memset(p, 0xcc, 32);
    expect(await call(cpu, "sigemptyset", p)).toBe(0);
    expect(mem.u8[p + (a64 ? 8 : 4)]).toBe(0xcc);
    expect(await call(cpu, "sigaddset", p, 10)).toBe(0);
    expect(await call(cpu, "sigismember", p, 10)).toBe(1);
    expect(await call(cpu, "sigismember", p, 0)).toBe(-1);
    expect(await call(cpu, "pthread_sigmask", 0, p, p + 16)).toBe(0);
    expect(cpu.signalMask).toBe(1n << 9n);
    cpu.kill(10); cpu.kill(10);
    await Promise.resolve();
    expect(got).toEqual([]);
    expect(await call(cpu, "sigpending", p + 16)).toBe(0);
    expect(mem.ld32(p + 16)).toBe(1 << 9);
    expect(await call(cpu, "sigprocmask", 1, p, 0)).toBe(0);
    await cpu.awaitIdleBase();
    expect(got).toEqual([10]);
    expect(cpu.signals).toEqual([]);
    expect(cpu.signalMask).toBe(0n);
    mem.st64(p, -1n);
    expect(await call(cpu, "syscall", a64 ? 135 : 175, 2, p, p + 16, 8)).toBe(0);
    expect(cpu.signalMask & ((1n << 8n) | (1n << 18n))).toBe(0n);
    expect(cpu.signalMask & (1n << 63n)).not.toBe(0n);
    expect(await call(cpu, "syscall", a64 ? 135 : 175, 2, p, 0, 4)).toBe(-1);
    expect(mem.ld32(cpu.errnoAddr)).toBe(22);
    mem.st32(cpu.errnoAddr, 99);
    expect(await call(cpu, "pthread_sigmask", 3, p, 0)).toBe(22);
    expect(mem.ld32(cpu.errnoAddr)).toBe(99);
  } finally { sigHandlers.delete(10); mem.free(p); }
});

for (const a64 of [false, true]) test(`${a64 ? "A64" : "ARM32"} sigaction handler masks defer other signals and restore the calling mask`, async () => {
  setA64(a64); libcInit();
  const cpu = new Cpu(new JThread(), "handler mask test"), p = mem.malloc(64), order: number[] = [];
  const second = defineHost("signal_mask_second", () => { order.push(12); });
  const first = defineHost("signal_mask_first", (c) => {
    expect(c.signalMask & (1n << 9n)).not.toBe(0n);
    expect(c.signalMask & (1n << 11n)).not.toBe(0n);
    c.kill(12); order.push(10);
  });
  sigHandlers.set(12, { fn: second, flags: 0 });
  try {
    mem.memset(p, 0, 64); mem.st32(p + LAYOUT.SA_HANDLER, first); mem.st32(p + (a64 ? 16 : 4), 1 << 11);
    expect(await call(cpu, "sigaction", 10, p, 0)).toBe(0);
    expect(await call(cpu, "sigaction", 10, 0, p + 32)).toBe(0);
    expect(mem.ld32(p + 32 + (a64 ? 16 : 4))).toBe(1 << 11);
    cpu.kill(10);
    await Promise.resolve(); await cpu.awaitIdleBase();
    await Promise.resolve(); await cpu.awaitIdleBase();
    expect(order).toEqual([10, 12]);
    expect(cpu.signalMask).toBe(0n);
  } finally { sigHandlers.clear(); mem.free(p); }
});

test("sigsuspend temporarily unmasks pending signals and restores its previous mask", async () => {
  setA64(true); libcInit();
  const cpu = new Cpu(new JThread(), "sigsuspend test"), p = mem.malloc(16);
  sigHandlers.set(10, { fn: defineHost("signal_suspend_handler", () => {}), flags: 0 });
  try {
    mem.st64(p, 1n << 9n); mem.st64(p + 8, 0n);
    await call(cpu, "sigprocmask", 2, p, 0);
    cpu.kill(10);
    expect(await call(cpu, "sigsuspend", p + 8)).toBe(-1);
    expect(mem.ld32(cpu.errnoAddr)).toBe(4);
    expect(cpu.signalMask).toBe(1n << 9n);
    expect(cpu.signals).toEqual([]);
  } finally { sigHandlers.delete(10); mem.free(p); }
});

test("pthread creation inherits the parent's signal mask", async () => {
  setA64(true); libcInit();
  const cpu = new Cpu(new JThread(), "signal parent"), p = mem.malloc(24);
  const child = defineHost("signal_child", (c) => { mem.st64(p + 16, c.signalMask); });
  try {
    mem.st64(p, 1n << 42n);
    await call(cpu, "sigprocmask", 2, p, 0);
    expect(await call(cpu, "pthread_create", p + 8, 0, child, 0)).toBe(0);
    expect(await call(cpu, "pthread_join", mem.ld32(p + 8), 0)).toBe(0);
    expect(mem.ld64(p + 16)).toBe(1n << 42n);
  } finally { mem.free(p); }
});

for (const a64 of [false, true]) test(`${a64 ? "svc" : "swi"} rt_sigprocmask uses kernel mask size and negative errors`, () => {
  setA64(a64);
  const cpu = new Cpu(new JThread(), "raw signal syscall"), p = mem.malloc(16);
  try {
    mem.st64(p, 1n << 40n);
    cpu.r[0] = 2; cpu.r[1] = p; cpu.r[2] = p + 8; cpu.r[3] = 8;
    cpu.r[a64 ? 8 : 7] = a64 ? 135 : 175;
    if (a64) cpu.svc(); else cpu.swi();
    expect(cpu.r[0]).toBe(0);
    expect(cpu.signalMask).toBe(1n << 40n);
    expect(mem.ld64(p + 8)).toBe(0n);
    cpu.r[0] = 2; cpu.r[3] = 4;
    if (a64) cpu.svc(); else cpu.swi();
    expect(cpu.r[0]).toBe(-22);
  } finally { mem.free(p); }
});
