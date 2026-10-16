import { expect, test } from "bun:test";
import { JThread } from "../jvm/natives/jentry.ts";
import { Cpu, setA64 } from "./cpu.ts";
import { defineHost, lookupHost } from "./host.ts";
import { LIBC_SYSCALLS, libcInit } from "./libc.ts";
import { kernelInit, rawSyscall } from "./syscall.ts";
import { mem } from "./mem.ts";
import { procIdentity } from "../shell/procfs.ts";
import { device } from "../shell/config.ts";

/** a 64-bit process has no HLE libc: its calls reach the kernel by number */
const syscall = defineHost("test:syscall", (cpu, a) => rawSyscall(cpu, a.i(), a));

test("native user IDs match the process identity", async () => {
  setA64(true); kernelInit();
  const cpu = new Cpu(new JThread(), "identity-test");
  try {
    for (const name of ["getuid", "geteuid", "getgid", "getegid"]) {
      expect(await cpu.call(defineHost(name, LIBC_SYSCALLS[name]), [])).toBe(procIdentity.uid);
    }
  } finally { cpu.dispose(); setA64(false); }
});

test("sysinfo uses the device RAM in both native ABIs without overrunning its struct", async () => {
  for (const a64 of [false, true]) {
    setA64(a64); kernelInit();
    const cpu = new Cpu(new JThread(), "sysinfo-test"), out = mem.hostAlloc(128);
    const size = a64 ? 112 : 64;
    mem.st32(out + size, 0xfeedbeef);
    try {
      expect(await cpu.call(syscall, [a64 ? 179 : 116, out])).toBe(0);
      const unit = mem.ld32(out + (a64 ? 104 : 52));
      const total = a64 ? Number(mem.ld64(out + 32)) : mem.ld32(out + 16);
      expect(total * unit).toBe(device.cpu.memKb * 1024);
      expect(mem.ld32(out + size) >>> 0).toBe(0xfeedbeef);
    } finally { cpu.dispose(); }
  }
  setA64(false);
});

test("sort and search pass pointers in the guest ABI", async () => {
  setA64(false); kernelInit(); libcInit();
  const cpu = new Cpu(new JThread(), "comparator-test"), data = mem.malloc(20), cmp = mem.reserve(4096, 4096);
  mem.u32.set([0xe5900000, 0xe5911000, 0xe0400001, 0xe12fff1e], cmp >>> 2);
  mem.i32.set([9, -2, 4, 1, 4], data >>> 2);
  try {
    await cpu.call(lookupHost("qsort", "libc.so")!, [data, 4, 4, cmp]);
    expect(Array.from(mem.i32.slice(data >>> 2, (data >>> 2) + 4))).toEqual([-2, 1, 4, 9]);
    expect((await cpu.call(lookupHost("bsearch", "libc.so")!, [data + 16, data, 4, 4, cmp])) >>> 0).toBe(data + 8);
    mem.st32(data + 16, 8);
    expect(await cpu.call(lookupHost("bsearch", "libc.so")!, [data + 16, data, 4, 4, cmp])).toBe(0);
  } finally { mem.free(data); cpu.dispose(); }
});

test("memmem searches binary ranges without treating NUL as a terminator", async () => {
  setA64(false); kernelInit(); libcInit();
  const cpu = new Cpu(new JThread(), "memmem-test");
  const data = mem.malloc(8);
  mem.u8.set([1, 0, 2, 1, 0, 2, 0, 3], data);
  const search = lookupHost("memmem", "libc.so")!;
  try {
    expect(await cpu.call(search, [data, 8, data + 3, 3])).toBe(data);
    expect(await cpu.call(search, [data + 1, 7, data + 3, 3])).toBe(data + 3);
    expect(await cpu.call(search, [data, 2, data + 3, 3])).toBe(0);
    expect(await cpu.call(search, [data, 7, data + 7, 1])).toBe(0);
    expect(await cpu.call(search, [data, 8, data + 7, 1])).toBe(data + 7);
    expect(await cpu.call(search, [data, 0, 0, 0])).toBe(data);
  } finally { mem.free(data); cpu.dispose(); }
});

test("ARM EABI memory fill takes the byte count before the value", async () => {
  setA64(false); kernelInit(); libcInit();
  const cpu = new Cpu(new JThread(), "aeabi-memset-test"), data = mem.malloc(8);
  try {
    for (const name of ["__aeabi_memset", "__aeabi_memset4", "__aeabi_memset8"]) {
      mem.u8.fill(0x7f, data, data + 8);
      await cpu.call(lookupHost(name, "libc.so")!, [data, 3, 0x1234]);
      expect(Array.from(mem.u8.slice(data, data + 8))).toEqual([0x34, 0x34, 0x34, 0x7f, 0x7f, 0x7f, 0x7f, 0x7f]);
    }
  } finally { mem.free(data); cpu.dispose(); }
});

test("raw ARM faccessat accepts its three kernel arguments", async () => {
  setA64(false); kernelInit(); libcInit();
  const cpu = new Cpu(new JThread(), "faccessat-test"), path = mem.malloc(16);
  mem.u8.set(new TextEncoder().encode("/dev/urandom\0"), path);
  try {
    expect(await cpu.call(lookupHost("syscall", "libc.so")!, [334, -100, path, 0, 0x4000])).toBe(0);
  } finally { mem.free(path); cpu.dispose(); }
});

test("ARM64 syncfs flushes an open filesystem and rejects invalid descriptors", async () => {
  setA64(true); kernelInit();
  const cpu = new Cpu(new JThread(), "syncfs-test");
  try {
    expect(await cpu.call(syscall, [267, 0])).toBe(0);
    expect(await cpu.call(syscall, [267, -1])).toBe(-1);
    expect(mem.ld32(cpu.errnoAddr)).toBe(9);
  } finally { cpu.dispose(); setA64(false); }
});

test("ARM64 wait4 reports that no guest child exists", async () => {
  setA64(true); kernelInit();
  const cpu = new Cpu(new JThread(), "wait4-test");
  try {
    expect(await cpu.call(syscall, [260, -1, 0, 0, 0])).toBe(-1);
    expect(mem.ld32(cpu.errnoAddr)).toBe(10);
  } finally { cpu.dispose(); setA64(false); }
});

test("timegm64 returns seconds beyond the ARM32 time_t range", async () => {
  setA64(false); kernelInit(); libcInit();
  const cpu = new Cpu(new JThread(), "timegm64-test"), tm = mem.malloc(36);
  mem.i32.set([0, 0, 0, 1, 0, 140, 0, 0, 0], tm >>> 2);
  try {
    const lo = await cpu.call(lookupHost("timegm64", "libc.so")!, [tm]);
    expect(BigInt(cpu.ret1 >>> 0) << 32n | BigInt(lo >>> 0)).toBe(2208988800n);
  } finally { mem.free(tm); cpu.dispose(); }
});

test("A64 mmap keeps executable and low-hinted mappings where the core runs code", async () => {
  setA64(true); kernelInit();
  const cpu = new Cpu(new JThread(), "mmap-test"), mmap = defineHost("mmap", LIBC_SYSCALLS.mmap), size = 0x1000_0000;
  const anon = async (hint: bigint, prot: number) => {
    const lo = await cpu.call(mmap, [hint, BigInt(size), prot, 0x4022, -1, 0n]);
    return BigInt(cpu.ret1 >>> 0) << 32n | BigInt(lo >>> 0);
  };
  try {
    // V8 reserves its code range PROT_NONE with a low hint and makes pages executable later
    for (const [hint, prot] of [[0xf000_0000n, 0], [0n, 7]] as const) {
      const va = await anon(hint, prot);
      expect(va >> 32n).toBe(0n);
      expect(mem.unmapVa(va, size)).toBe(true);
    }
    const data = await anon(0n, 0);
    expect(data >> 32n).not.toBe(0n);
    expect(mem.unmapVa(data, size)).toBe(true);
  } finally { cpu.dispose(); setA64(false); }
});
