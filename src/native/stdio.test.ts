import { expect, test } from "vite-plus/test";
import { mainThread } from "../jvm/natives/jentry.ts";
import { vfs } from "../shell/vfs.ts";
import { Cpu, setA64 } from "./cpu.ts";
import { lookupHost, stp } from "./host.ts";
import { libcInit } from "./libc.ts";
import { mem } from "./mem.ts";
import { fdFile, javaCloseFd, javaOpenFd, javaFdBytes, javaLseekFd, javaDupFd, javaReadFd, renamePath } from "./fs.ts";
import { kernelInit } from "./syscall.ts";
import { kernel, kernelCalls, libCalls } from "./calls.testkit.ts";


test("printf renders unmapped guest pointer values without dereferencing them", async () => {
  setA64(false); kernelInit(); libcInit();
  const cpu = new Cpu(mainThread, "printf-pointer-test"), out = mem.hostAlloc(80), fmt = mem.strdup("%p %p");
  try {
    await cpu.call(lookupHost("snprintf", "libc.so")!, [out, 80, fmt, 0xf107420c, 0xffffffff]);
    expect(mem.cstr(out)).toBe("0xf107420c 0xffffffff");
  } finally { cpu.dispose(); }
});

test("fixed file remapping preserves dirty shared bytes before replacing pages", async () => {
  setA64(true); kernelInit();
  const path = "/fixed-mapping-test";
  vfs.write(path, new Uint8Array(3));
  const fd = javaOpenFd(path, 2), cpu = new Cpu(mainThread, "fixed-mapping-test");
  const mmap = kernel("mmap"), munmap = kernel("munmap");
  let address = 0;
  try {
    address = await cpu.call(mmap, [0, 4096, 3, 1, fd, 0]);
    mem.st8(address, 17);
    mem.st8(address + 2, 18);
    mem.st8(address + 7, 99);
    const bytes = new Uint8Array(16);
    expect(await javaReadFd(fd,bytes)).toBe(3);
    expect([...bytes.subarray(0,3)]).toEqual([17,0,18]);
    expect(vfs.stat(path)?.size).toBe(3);
    expect(await javaReadFd(fd,bytes)).toBe(0);
    expect(await cpu.call(mmap, [address, 4096, 3, 0x11, fd, 0])).toBe(address);
    expect(mem.ld8u(address)).toBe(17);
    expect(vfs.read(path)?.[0]).toBe(17);
  } finally {
    if (address) await cpu.call(munmap, [address, 4096]);
    javaCloseFd(fd); vfs.delete(path); cpu.dispose(); setA64(false);
  }
});

test("shared file mappings see each other's synced stores and every writer's, without an older copy clobbering them", async () => {
  setA64(true); kernelInit();
  const path = "/coherent-mapping-test";
  vfs.write(path, new Uint8Array(4096));
  const fd = javaOpenFd(path, 2), cpu = new Cpu(mainThread, "coherent-mapping-test");
  const mmap = kernel("mmap"), munmap = kernel("munmap"), msync = kernel("msync");
  const pwrite = kernel("pwrite64"), buf = mem.hostAlloc(1);
  const maps: number[] = [];
  try {
    for (const prot of [1, 3, 3]) maps.push(await cpu.call(mmap, [0, 4096, prot, 1, fd, 0]));
    const [reader, a, b] = maps;
    mem.st8(a, 1); mem.st8(b + 1, 2);
    await cpu.call(msync, [b, 4096, 4]);
    await cpu.call(munmap, [a, 4096]);
    expect([...mem.bytes(reader, 2)]).toEqual([1, 2]);
    expect([...vfs.read(path)!.subarray(0, 2)]).toEqual([1, 2]);
    mem.st8(buf, 3);
    await cpu.call(pwrite, [fd, buf, 1, 2]);
    expect(mem.ld8u(b + 2)).toBe(3);
    // a Java stream's write and read go through the same page cache
    vfs.writeAt(fdFile(fd)!, 3, Uint8Array.of(4));
    expect(mem.ld8u(b + 3)).toBe(4);
    mem.st8(b + 4, 5);
    expect(vfs.read(path)?.[4]).toBe(5);
  } finally {
    for (const m of [maps[0], maps[2]]) if (m) await cpu.call(munmap, [m, 4096]);
    javaCloseFd(fd); vfs.delete(path); cpu.dispose(); setA64(false);
  }
});

test("mremap carries a shared file mapping's range, and its new pages hold the file's bytes", async () => {
  setA64(true); kernelInit();
  const path = "/remapped-mapping-test", bytes = new Uint8Array(8192);
  bytes[4096] = 9;
  vfs.write(path, bytes);
  const fd = javaOpenFd(path, 2), cpu = new Cpu(mainThread, "remapped-mapping-test");
  const mmap = kernel("mmap"), mremap = kernel("mremap"), munmap = kernel("munmap"), msync = kernel("msync");
  let address = 0;
  try {
    address = await cpu.call(mmap, [0, 4096, 3, 1, fd, 0]);
    mem.st8(address, 7);
    address = await cpu.call(mremap, [address, 4096, 8192, 1 /* MREMAP_MAYMOVE */]);
    expect([mem.ld8u(address), mem.ld8u(address + 4096)]).toEqual([7, 9]);
    mem.st8(address + 4097, 8);
    await cpu.call(msync, [address, 8192, 4]);
    expect([...vfs.read(path)!.subarray(4096, 4098)]).toEqual([9, 8]);
    expect(vfs.read(path)?.[0]).toBe(7);
  } finally {
    if (address) await cpu.call(munmap, [address, 8192]);
    javaCloseFd(fd); vfs.delete(path); cpu.dispose(); setA64(false);
  }
});

test("a private file mapping grows with the file's bytes, and MAP_FIXED/MREMAP_FIXED take free address space", async () => {
  setA64(true); kernelInit();
  const path = "/private-mapping-test", bytes = new Uint8Array(8192);
  bytes[4096] = 9;
  vfs.write(path, bytes);
  const fd = javaOpenFd(path, 0), cpu = new Cpu(mainThread, "private-mapping-test");
  const mmap = kernel("mmap"), mremap = kernel("mremap"), munmap = kernel("munmap");
  const maps: [number | bigint, number][] = [];
  try {
    let address = await cpu.call(mmap, [0, 4096, 3, 2 /* MAP_PRIVATE */, fd, 0]);
    mem.st8(address, 7);
    address = await cpu.call(mremap, [address, 4096, 8192, 1]);
    maps.push([address, 8192]);
    expect([mem.ld8u(address), mem.ld8u(address + 4096)]).toEqual([7, 9]);
    expect(vfs.read(path)?.[0]).toBe(0);
    // a plane's tail unmapped, then mapped again at its address; and an unused plane taken whole
    const call64 = async (fn: number, args: (number | bigint)[]) => { const lo = await cpu.call(fn, args); return BigInt(cpu.ret1 >>> 0) << 32n | BigInt(lo >>> 0); };
    const plane = await call64(mmap, [0, 0x400000, 3, 0x22, -1, 0]);
    expect(plane >> 32n).not.toBe(0n);
    await cpu.call(munmap, [plane + 0x200000n, 0x200000]);
    expect(await call64(mmap, [plane + 0x300000n, 0x100000, 3, 0x32, -1, 0])).toBe(plane + 0x300000n);
    mem.st8(mem.txVa(plane + 0x300000n), 1);
    maps.push([plane, 0x400000]);
    const free = (plane & ~0xffffffffn) + 0x50_0000_0000n;
    expect(await call64(mremap, [address, 8192, 8192, 3, free])).toBe(free);
    maps[0] = [free, 8192];
    expect(mem.ld8u(mem.txVa(free + 4096n))).toBe(9);
  } finally {
    for (const [m, n] of maps) await cpu.call(munmap, [m, n]);
    javaCloseFd(fd); vfs.delete(path); cpu.dispose(); setA64(false);
  }
});

test("record-lock queries report no conflicting process lock through the guest pointer", async () => {
  setA64(true); kernelInit();
  const cpu = new Cpu(mainThread, "fcntl-test");
  const path = "/fcntl-test";
  vfs.write(path, new Uint8Array(0));
  const fd = javaOpenFd(path, 2);
  const lock = mem.hostAlloc(32);
  const fcntl = kernel("fcntl");
  try {
    for (const cmd of [5, 12]) {
      mem.memset(lock, 0, 32);
      mem.st16(lock, 1);
      mem.st64(lock + 8, 128n);
      mem.st64(lock + 16, 1n);
      expect(await cpu.call(fcntl, [fd, cmd, lock])).toBe(0);
      expect(mem.ld16u(lock)).toBe(2);
      expect(mem.ld64(lock + 8)).toBe(128n);
      expect(mem.ld64(lock + 16)).toBe(1n);
    }
  } finally { javaCloseFd(fd); vfs.delete(path); cpu.dispose(); }
});

test("independent file opens share writes, growth and truncation without sharing position", async () => {
  setA64(true); kernelInit();
  const cpu = new Cpu(mainThread, "shared-file-test"), path = "/shared-file-test";
  vfs.write(path, Uint8Array.of(1, 2));
  const writer = javaOpenFd(path, 2), reader = javaOpenFd(path, 0), buf = mem.hostAlloc(8192);
  const call = kernelCalls(cpu);
  try {
    mem.st8(buf, 7);
    expect(await call("pwrite64", writer, buf, 1, 5000)).toBe(1);
    expect(await call("pread64", reader, buf, 2, 4999)).toBe(2);
    expect([...mem.bytes(buf, 2)]).toEqual([0, 7]);
    expect(vfs.read(path)?.length).toBe(5001);
    expect(await call("read", reader, buf, 1)).toBe(1);
    expect(mem.ld8u(buf)).toBe(1);
    expect(await call("ftruncate", writer, 1)).toBe(0);
    expect(await call("pread64", reader, buf, 1, 1)).toBe(0);
    vfs.write(path, Uint8Array.of(4, 5, 6));
    expect(await call("pread64", reader, buf, 3, 0)).toBe(3);
    expect([...mem.bytes(buf, 3)]).toEqual([4, 5, 6]);
  } finally { javaCloseFd(writer); javaCloseFd(reader); vfs.delete(path); cpu.dispose(); }
});

test("open files and mappings retain their identity through rename and unlink", () => {
  const from = "/mapped-file-test", to = "/mapped-file-renamed";
  vfs.write(from, Uint8Array.of(1));
  const fd = javaOpenFd(from, 2), file = fdFile(fd)!;
  expect(renamePath(from, to)).toBe(0);
  vfs.writeAt(file, 0, Uint8Array.of(2));
  expect(vfs.read(to)).toEqual(Uint8Array.of(2));
  expect(vfs.read(from)).toBeNull();
  javaCloseFd(fd);
  vfs.writeAt(file, 1, Uint8Array.of(3));
  expect(vfs.read(to)).toEqual(Uint8Array.of(2, 3));
  vfs.delete(to); vfs.write(to, Uint8Array.of(9));
  vfs.writeAt(file, 0, Uint8Array.of(4));
  expect(vfs.read(to)).toEqual(Uint8Array.of(9));
  vfs.delete(to);
});

test("descriptor bytes retain shared positions and read lazy files through short reads", async () => {
  const path = "/descriptor-bytes", bytes = Uint8Array.of(1, 2, 3, 4, 5);
  for (const lazy of [false, true]) {
    if (lazy) vfs.lazyFiles.set(path, { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + Math.min(length, 2)) });
    else vfs.write(path, bytes);
    const fd = javaOpenFd(path, 0), dup = javaDupFd(fd);
    try {
      expect(javaLseekFd(fd, 1, 0)).toBe(1);
      expect(await javaFdBytes(dup)).toEqual(Uint8Array.of(2, 3, 4, 5));
      expect(javaLseekFd(fd, 0, 1)).toBe(1);
      expect(await javaFdBytes(fd)).toEqual(Uint8Array.of(2, 3, 4, 5));
      expect(javaLseekFd(fd, 9, 0)).toBe(9);
      expect(await javaFdBytes(fd)).toEqual(new Uint8Array(0));
    } finally { javaCloseFd(fd); javaCloseFd(dup); vfs.delete(path); }
    expect(await javaFdBytes(fd)).toBeNull();
  }
});

test("descriptor bytes await pipe data without closing the caller's descriptor", async () => {
  setA64(true); kernelInit();
  const cpu = new Cpu(mainThread, "descriptor-pipe-test"), buffer = mem.malloc(16);
  const call = kernelCalls(cpu);
  expect(await call("pipe2", buffer, 0)).toBe(0);
  const reader = mem.ld32(buffer), writer = mem.ld32(buffer + 4);
  try {
    const pending = javaFdBytes(reader);
    mem.write(buffer + 8, Uint8Array.of(4, 5, 6));
    expect(await call("write", writer, buffer + 8, 3)).toBe(3);
    javaCloseFd(writer);
    expect(await pending).toEqual(Uint8Array.of(4, 5, 6));
    expect(await javaFdBytes(reader)).toEqual(new Uint8Array(0));
  } finally { javaCloseFd(reader); mem.free(buffer); cpu.dispose(); }
});

test("inotify waits on a real descriptor and reports completed file writes", async () => {
  setA64(true); kernelInit();
  const cpu = new Cpu(mainThread, "inotify-test"), path = "/inotify-test", buf = mem.malloc(32), name = mem.strdup(path);
  const call = kernelCalls(cpu);
  vfs.write(path, Uint8Array.of(1));
  const fd = await call("inotify_init"), wd = await call("inotify_add_watch", fd, name, 0x8);
  try {
    expect(fd).toBeGreaterThan(2);
    expect(wd).toBeGreaterThan(0);
    const pending = call("read", fd, buf, 32);
    vfs.write(path, Uint8Array.of(2));
    expect(await pending).toBe(16);
    expect(mem.ld32(buf)).toBe(wd);
    expect(mem.ld32(buf + 4)).toBe(0x8);
  } finally { javaCloseFd(fd); vfs.delete(path); mem.free(name); mem.free(buf); cpu.dispose(); setA64(false); }
});

test("fts walks directories in pre- and postorder", async () => {
  setA64(false); kernelInit(); libcInit();
  const cpu = new Cpu(mainThread, "fts-test"), path = mem.strdup("/fts-test"), argv = mem.malloc(16);
  vfs.mkdir("/fts-test"); vfs.mkdir("/fts-test/sub");
  vfs.write("/fts-test/a", Uint8Array.of(1)); vfs.write("/fts-test/sub/b", Uint8Array.of(2));
  stp(argv, path); stp(argv + 4, 0);
  const open = lookupHost("fts_open", "libc.so")!, read = lookupHost("fts_read", "libc.so")!, close = lookupHost("fts_close", "libc.so")!;
  try {
    const walk = await cpu.call(open, [argv, 16, 0]);
    const entries: [string, number][] = [];
    for (;;) {
      const entry = Number(await cpu.call(read, [walk]));
      if (!entry) break;
      entries.push([mem.cstr(entry + 68), mem.ld16u(entry + 58)]);
    }
    expect(entries).toEqual([["fts-test", 1], ["a", 8], ["sub", 1], ["b", 8], ["sub", 6], ["fts-test", 6]]);
    expect(await cpu.call(close, [walk])).toBe(0);
  } finally {
    mem.free(argv); mem.free(path); vfs.delete("/fts-test/a"); vfs.delete("/fts-test/sub/b");
    vfs.rmdir("/fts-test/sub"); vfs.rmdir("/fts-test"); cpu.dispose();
  }
});

test("writev and readv move each iovec in order through a pipe, stopping short rather than waiting", async () => {
  setA64(true); kernelInit();
  const cpu = new Cpu(mainThread, "iovec-test"), buffer = mem.malloc(64);
  const call = kernelCalls(cpu);
  const iov = (at: number, ...parts: [number, number][]) => parts.forEach(([base, len], i) => { mem.st64(at + i * 16, BigInt(base)); mem.st64(at + i * 16 + 8, BigInt(len)); });
  expect(await call("pipe2", buffer, 0)).toBe(0);
  const reader = mem.ld32(buffer), writer = mem.ld32(buffer + 4);
  try {
    mem.write(buffer + 8, Uint8Array.of(1, 2, 3, 4, 5));
    iov(buffer + 16, [buffer + 8, 2], [buffer + 8, 0], [buffer + 11, 2]);
    expect(await call("writev", writer, buffer + 16, 3)).toBe(4);
    iov(buffer + 16, [buffer + 56, 3], [buffer + 60, 3]);
    expect(await call("readv", reader, buffer + 16, 2)).toBe(4);
    expect([...mem.bytes(buffer + 56, 3), ...mem.bytes(buffer + 60, 1)]).toEqual([1, 2, 4, 5]);
    // a read that fills one iovec and would then wait returns what it has
    expect(await call("write", writer, buffer + 8, 2)).toBe(2);
    iov(buffer + 16, [buffer + 56, 2], [buffer + 60, 3]);
    expect(await call("readv", reader, buffer + 16, 2)).toBe(2);
  } finally { javaCloseFd(reader); javaCloseFd(writer); mem.free(buffer); cpu.dispose(); setA64(false); }
});

test("a fifo goes with its file and ends when its last writer closes", async () => {
  setA64(false); kernelInit(); libcInit();
  const cpu = new Cpu(mainThread, "fifo-test"), path = mem.strdup("/fifo-test"), buf = mem.malloc(4);
  const call = libCalls(cpu, "libc.so");
  try {
    expect(await call("mkfifo", path, 0o600)).toBe(0);
    const reader = javaOpenFd("/fifo-test", 0x800), writer = javaOpenFd("/fifo-test", 1), copy = javaDupFd(writer);
    javaCloseFd(writer);
    expect(await call("read", reader, buf, 4)).toBe(-1);                   // EAGAIN: a writer is still open
    javaCloseFd(copy);
    expect(await call("read", reader, buf, 4)).toBe(0);
    javaCloseFd(reader);
    expect(await call("unlinkat", -100, path, 0)).toBe(0);
    vfs.write("/fifo-test", Uint8Array.of(7));
    const file = javaOpenFd("/fifo-test", 0);
    expect(await call("read", file, buf, 4)).toBe(1);
    javaCloseFd(file);
    vfs.delete("/fifo-test");
    expect(await call("mkfifo", path, 0o600)).toBe(0);
  } finally { vfs.delete("/fifo-test"); mem.free(path); mem.free(buf); cpu.dispose(); setA64(false); }
});
