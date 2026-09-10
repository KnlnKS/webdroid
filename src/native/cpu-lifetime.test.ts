import { expect, test } from "bun:test";
import { JThread } from "../jvm/natives/jlang";
import { Cpu, bindCpu, cpuByTid, cpuFor, cpus, setA64 } from "./cpu";
import { HOST_DATA_END, STACK_END, MEM_SIZE } from "./abi";
import { ldp, PTR } from "./host";
import { jniInit, javaVM } from "./jni";
import { mem } from "./mem";

test("terminated native CPUs reclaim TLS, errno, JNI environments, stacks and registry entries", async () => {
  setA64(false); jniInit();
  const out = mem.malloc(PTR), guestTls = mem.malloc(256);
  const hostTop = mem.hostAlloc(0), count = cpus.size, before = mem.stats();
  const attach = ldp(ldp(javaVM.addr) + 4 * PTR);
  try {
    for (let i = 0; i < 3000; i++) {
      const thread = new JThread(), cpu = cpuFor(thread);
      expect(mem.ld32(cpu.tlsBase)).toBe(0);
      expect(mem.ld32(cpu.errnoAddr)).toBe(0);
      mem.st32(cpu.tlsBase, 123); mem.st32(cpu.errnoAddr, 45);
      await cpu.call(attach, [javaVM.addr, out, 0]);
      expect(ldp(out)).toBe(cpu.env);
      expect(ldp(cpu.env)).not.toBe(0);
      cpu.tlsBase = guestTls;
      cpu.dispose(); cpu.dispose();
      expect(cpuByTid(cpu.tid)).toBeUndefined();
    }
    expect(cpus.size).toBe(count);
    expect(mem.hostAlloc(0)).toBe(hostTop);
    expect(mem.stats().used).toBe(before.used);
    expect(mem.stats().blocks).toBe(before.blocks);
    mem.st32(guestTls, 99);
    expect(mem.ld32(guestTls)).toBe(99);
  } finally { mem.free(out); mem.free(guestTls); }
});

test("CPU disposal preserves a replacement thread binding and rejects active run loops", () => {
  const thread = new JThread(), first = cpuFor(thread), replacement = new Cpu(thread, "replacement");
  bindCpu(thread, replacement);
  first.dispose();
  expect(cpuFor(thread)).toBe(replacement);
  replacement.loops = 1;
  expect(() => replacement.dispose()).toThrow("running thread");
  expect(cpuByTid(replacement.tid)).toBe(replacement);
  replacement.loops = 0; replacement.dispose();
  const next = cpuFor(thread);
  expect(next).not.toBe(replacement);
  next.dispose();
});

test("failed allocations preserve space and overflow stacks are reused", () => {
  const top = mem.hostAlloc(0);
  expect(() => mem.hostAlloc(HOST_DATA_END)).toThrow("out of host data space");
  expect(mem.hostAlloc(0)).toBe(top);
  expect(() => mem.allocStack(MEM_SIZE)).toThrow("out of stack address space");
  const stack = mem.allocStack(0x100000);
  expect(stack.top).toBeLessThanOrEqual(STACK_END);
  mem.freeStack(stack.base, stack.top);
  const overflow = mem.allocStack(STACK_END);
  expect(overflow.top).toBeGreaterThan(STACK_END);
  mem.freeStack(overflow.base, overflow.top);
  expect(mem.allocStack(STACK_END)).toEqual(overflow);
  mem.freeStack(overflow.base, overflow.top);
});
