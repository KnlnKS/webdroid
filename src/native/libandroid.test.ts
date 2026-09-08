import { afterAll, beforeAll, expect, test } from "bun:test";
import { JThread, mainThread } from "../jvm/natives/jlang";
import { inMainJob } from "../android/mainloop";
import { Cpu, setA64 } from "./cpu";
import { defineHost, lookupHost } from "./host";
import { libcInit } from "./libc";
import { ndkInit } from "./libandroid";
import { mem } from "./mem";

const host = (name: string) => lookupHost(name)!;
beforeAll(() => { setA64(true); libcInit(); ndkInit(); });
afterAll(() => setA64(false));

test("timerfd absolute deadlines wake ALooper and return expiration counts", async () => {
  const cpu = new Cpu(new JThread(), "looper test"), timer = await cpu.call(host("timerfd_create"), [1, 0x800]);
  const looper = await cpu.call(host("ALooper_prepare"), [1]);
  const out = mem.hostAlloc(24), value = mem.hostAlloc(32), count = mem.hostAlloc(8);
  expect(await cpu.call(host("ALooper_addFd"), [looper, timer, 7, 1, 0, 0x123456789n])).toBe(1);
  await cpu.call(host("clock_gettime"), [1, value + 16]);
  const nanoseconds = mem.ld64(value + 16) * 1_000_000_000n + mem.ld64(value + 24) + 20_000_000n;
  mem.st64(value + 16, nanoseconds / 1_000_000_000n);
  mem.st64(value + 24, nanoseconds % 1_000_000_000n);
  expect(await cpu.call(host("timerfd_settime"), [timer, 1, value, 0])).toBe(0);
  expect(await cpu.call(host("ALooper_pollOnce"), [500, out, out + 4, out + 8])).toBe(7);
  expect(mem.ld32(out)).toBe(timer);
  expect(mem.ld32(out + 4)).toBe(1);
  expect(mem.ld64(out + 8)).toBe(0x123456789n);
  expect(await cpu.call(host("read"), [timer, count, 8])).toBe(8);
  expect(mem.ld64(count)).toBe(1n);
  expect(await cpu.call(host("read"), [timer, count, 8])).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(11);
  expect(await cpu.call(host("ALooper_pollOnce"), [0, 0, 0, 0])).toBe(-3);
  expect(await cpu.call(host("ALooper_removeFd"), [looper, timer])).toBe(1);
  mem.st64(value, 1n); mem.st64(value + 8, 0n);
  mem.st64(value + 16, 1n); mem.st64(value + 24, 0n);
  await cpu.call(host("timerfd_settime"), [timer, 0, value, 0]);
  mem.u8.fill(0, value, value + 32);
  const previous = mem.hostAlloc(32);
  expect(await cpu.call(host("timerfd_settime"), [timer, 0, value, previous])).toBe(0);
  expect(mem.ld64(previous)).toBe(1n);
  expect(mem.ld64(previous + 16) * 1_000_000_000n + mem.ld64(previous + 24)).toBeGreaterThan(0n);
  await cpu.call(host("timerfd_gettime"), [timer, value]);
  expect(mem.ld64(value + 16)).toBe(0n);
  expect(mem.ld64(value + 24)).toBe(0n);
  await cpu.call(host("close"), [timer]);
});

test("ALooper wakes an indefinite poll and unregisters callbacks returning zero", async () => {
  const cpu = new Cpu(new JThread(), "callback test"), other = new Cpu(new JThread(), "wake test");
  const looper = await cpu.call(host("ALooper_prepare"), [0]);
  const pending = cpu.call(host("ALooper_pollOnce"), [-1, 0, 0, 0]);
  await other.call(host("ALooper_wake"), [looper]);
  expect(await pending).toBe(-1);
  const fd = await cpu.call(host("eventfd"), [1, 0x800]);
  let calls = 0;
  const callback = defineHost("looper test callback", (_cpu, args) => {
    expect(args.i()).toBe(fd); expect(args.i()).toBe(1); expect(args.va()).toBe(0x123456789n);
    calls++; return 0;
  });
  await cpu.call(host("ALooper_addFd"), [looper, fd, -1, 1, callback, 0x123456789n]);
  expect(await cpu.call(host("ALooper_pollOnce"), [0, 0, 0, 0])).toBe(-2);
  expect(calls).toBe(1);
  expect(await cpu.call(host("ALooper_pollOnce"), [0, 0, 0, 0])).toBe(-3);
  await cpu.call(host("close"), [fd]);
});

test("main-thread native fd callbacks enter the Java main queue", async () => {
  const cpu = new Cpu(mainThread, "main looper test");
  const looper = await cpu.call(host("ALooper_prepare"), [0]), fd = await cpu.call(host("eventfd"), [1, 0x800]);
  let resolve!: () => void;
  const called = new Promise<void>((done) => { resolve = done; });
  const callback = defineHost("main looper test callback", () => { expect(inMainJob()).toBe(true); resolve(); return 0; });
  await cpu.call(host("ALooper_addFd"), [looper, fd, -1, 1, callback, 0]);
  await called;
  await cpu.call(host("close"), [fd]);
});

test("ALooper retains guest output addresses across memory plane relocation", async () => {
  const cpu = new Cpu(new JThread(), "relocating poll"), writer = new Cpu(new JThread(), "poll writer");
  const looper = await cpu.call(host("ALooper_prepare"), [1]);
  const fd = await cpu.call(host("eventfd"), [0, 0x800]);
  await cpu.call(host("ALooper_addFd"), [looper, fd, 7, 1, 0, 0x123456789n]);
  const reservations: (number | bigint)[] = [];
  const plane = () => {
    for (;;) {
      const address = mem.mapVa(0x1ffff000, true);
      if (!address) throw new Error("native reservation failed");
      reservations.push(address);
      if (typeof address === "bigint") return address;
    }
  };
  try {
    const address = plane(), blocker = plane();
    expect(mem.commitVa(address, 4096)).toBe(true);
    const previous = mem.txVa(address);
    mem.bytes(previous, 16).fill(0);
    const pending = cpu.call(host("ALooper_pollOnce"), [1000, address, address + 4n, address + 8n]);
    expect(mem.commitVa(blocker, 1 << 25)).toBe(true);
    expect(mem.commitVa(address, 2 << 25)).toBe(true);
    const current = mem.txVa(address);
    expect(current).not.toBe(previous);
    const value = mem.hostAlloc(8); mem.st64(value, 1n);
    await writer.call(host("write"), [fd, value, 8]);
    expect(await pending).toBe(7);
    expect(mem.ld32(current)).toBe(fd);
    expect(mem.ld32(current + 4)).toBe(1);
    expect(mem.ld64(current + 8)).toBe(0x123456789n);
  } finally {
    await cpu.call(host("close"), [fd]);
    for (const address of reservations) mem.unmapVa(BigInt(address), 0x1ffff000);
  }
});
