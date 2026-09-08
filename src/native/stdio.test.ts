import { beforeAll, expect, test } from "bun:test";
import { mainThread } from "../jvm/natives/jlang";
import { vfs } from "../jvm/natives/jio";
import { libcInit } from "./libc";
import { Cpu, setA64 } from "./cpu";
import { lookupHost } from "./host";
import { mem } from "./mem";

let cpu: Cpu;

beforeAll(() => {
  setA64(false);
  libcInit();
  cpu = new Cpu(mainThread, "stdio test");
});

test("standard descriptors honor redirection, close and lowest-free reuse", async () => {
  const call = (name: string, ...args: number[]) => cpu.call(lookupHost(name, "libc.so")!, args);
  const pair = mem.malloc(8), data = mem.malloc(16);
  try {
    for (const fd of [1, 2]) {
      const saved = await call("dup", fd);
      await call("pipe2", pair, 0x800);
      const reader = mem.ld32(pair), writer = mem.ld32(pair + 4);
      try {
        expect(await call("dup2", writer, fd)).toBe(fd);
        await call("close", writer);
        mem.putCstr(data, "ready", 16);
        expect(await call("write", fd, data, 5)).toBe(5);
        expect(await call("read", reader, data, 16)).toBe(5);
        expect(mem.cstr(data)).toBe("ready");
        if (fd === 1) {
          expect(await call("puts", data)).toBeGreaterThanOrEqual(0);
          expect(await call("read", reader, data, 16)).toBe(6);
          expect(mem.u8[data + 5]).toBe(10);
        }
        expect(await call("close", fd)).toBe(0);
        expect(await call("read", reader, data, 16)).toBe(0);
        await call("pipe2", pair, 0x800);
        expect(mem.ld32(pair)).toBe(fd);
        await call("close", mem.ld32(pair)); await call("close", mem.ld32(pair + 4));
      } finally {
        await call("dup2", saved, fd); await call("close", saved); await call("close", reader);
      }
    }
  } finally { mem.free(pair); mem.free(data); }
});

test("fread fills complete elements across asynchronous short reads", async () => {
  const bytes = Uint8Array.from({ length: 12 }, (_, i) => i + 1);
  vfs.mount("/data/fread-range.bin", {
    size: bytes.length,
    read(offset, length) {
      return Promise.resolve(bytes.subarray(offset, offset + Math.min(length, 5)));
    },
  });
  const fopen = lookupHost("fopen", "libc.so");
  const fread = lookupHost("fread", "libc.so");
  const fclose = lookupHost("fclose", "libc.so");
  expect(fopen && fread && fclose).toBeTruthy();

  const fp = await cpu.call(fopen!, [mem.hostStr("/data/fread-range.bin"), mem.hostStr("rb")]);
  const dst = mem.hostAlloc(bytes.length);
  expect(await cpu.call(fread!, [dst, 4, 3, fp])).toBe(3);
  expect(mem.u8.slice(dst, dst + bytes.length)).toEqual(bytes);
  expect(await cpu.call(fclose!, [fp])).toBe(0);
});

test("FILE pushback is local to a stream and works on pipes through EOF", async () => {
  const call = (name: string, ...args: number[]) => cpu.call(lookupHost(name, "libc.so")!, args);
  const pair = mem.malloc(8), data = mem.malloc(8);
  await call("pipe", pair);
  const reader = mem.ld32(pair), writer = mem.ld32(pair + 4);
  const fp = await call("fdopen", reader, mem.hostStr("r"));
  try {
    expect(await call("ungetc", 0x158, fp)).toBe(88);
    expect(await call("fseek", fp, 0, 0)).toBe(-1);
    expect(mem.ld32(cpu.errnoAddr)).toBe(29);
    expect(await call("getc", fp)).toBe(88);
    mem.putCstr(data, "abc", 8);
    expect(await call("write", writer, data, 3)).toBe(3);
    expect(await call("getc", fp)).toBe(97);
    expect(await call("ungetc", 88, fp)).toBe(88);
    expect(await call("read", reader, data, 1)).toBe(1);
    expect(mem.u8[data]).toBe(98);
    expect(await call("ungetc", 89, fp)).toBe(89);
    expect(await call("fread", data, 1, 3, fp)).toBe(3);
    expect(mem.u8.slice(data, data + 3)).toEqual(Uint8Array.of(89, 88, 99));
    await call("close", writer);
    expect(await call("getc", fp)).toBe(-1);
    expect(await call("feof", fp)).toBe(1);
    expect(await call("ungetc", -1, fp)).toBe(-1);
    expect(await call("feof", fp)).toBe(1);
    expect(await call("ungetc", 90, fp)).toBe(90);
    expect(await call("feof", fp)).toBe(0);
    expect(await call("__srget", fp)).toBe(90);
    expect(await call("getc", fp)).toBe(-1);
  } finally { await call("fclose", fp); mem.free(pair); mem.free(data); }
});

test("FILE pushback leaves file bytes unchanged and participates in positioning", async () => {
  const call = (name: string, ...args: number[]) => cpu.call(lookupHost(name, "libc.so")!, args);
  const path = "/data/stdio-pushback.bin", bytes = Uint8Array.of(97, 98, 99, 100);
  vfs.write(path, bytes);
  const fp = await call("fopen", mem.hostStr(path), mem.hostStr("rb"));
  const data = mem.malloc(8), pos = mem.malloc(8);
  try {
    expect(await call("getc", fp)).toBe(97);
    expect(await call("ungetc", 88, fp)).toBe(88);
    expect(await call("ftell", fp)).toBe(0);
    expect(await call("fread", data, 2, 2, fp)).toBe(2);
    expect(mem.u8.slice(data, data + 4)).toEqual(Uint8Array.of(88, 98, 99, 100));
    expect(await call("ungetc", 89, fp)).toBe(89);
    expect(await call("ftell", fp)).toBe(3);
    expect(await call("fgetpos", fp, pos)).toBe(0);
    expect(mem.ld32(pos)).toBe(3);
    expect(await call("fseek", fp, 0, 1)).toBe(0);
    expect(await call("getc", fp)).toBe(100);
    expect(await call("ungetc", 90, fp)).toBe(90);
    expect(await call("fsetpos", fp, pos)).toBe(0);
    expect(await call("getc", fp)).toBe(100);
    expect(await call("ungetc", 90, fp)).toBe(90);
    await call("rewind", fp);
    expect(await call("getc", fp)).toBe(97);
    expect(await call("ungetc", 90, fp)).toBe(90);
    expect(await call("freopen", mem.hostStr(path), mem.hostStr("rb"), fp)).toBe(fp);
    expect(await call("getc", fp)).toBe(97);
    expect(await call("ungetc", 90, fp)).toBe(90);
    expect(await call("fseeko", fp, 2, 0)).toBe(0);
    expect(await call("getc", fp)).toBe(99);
    expect(await call("ungetc", 57, fp)).toBe(57);
    expect(await call("fscanf", fp, mem.hostStr("%d"), data)).toBe(1);
    expect(mem.ld32(data)).toBe(9);
    expect(await call("getc", fp)).toBe(100);
  } finally { await call("fclose", fp); mem.free(data); mem.free(pos); }
  expect(vfs.read(path)).toEqual(bytes);
});

test("socketpair status flags and aliases follow fd semantics", async () => {
  const socketpair = lookupHost("socketpair", "libc.so");
  const fcntl = lookupHost("fcntl", "libc.so");
  const dup = lookupHost("dup", "libc.so");
  const close = lookupHost("close", "libc.so");
  const sendto = lookupHost("sendto", "libc.so");
  const recvfrom = lookupHost("recvfrom", "libc.so");
  expect(socketpair && fcntl && dup && close && sendto && recvfrom).toBeTruthy();

  const pair = mem.hostAlloc(8);
  expect(await cpu.call(socketpair!, [1, 1, 0, pair])).toBe(0);
  const writer = mem.ld32(pair), reader = mem.ld32(pair + 4);
  expect(await cpu.call(fcntl!, [reader, 3, 0])).toBe(2);
  expect(await cpu.call(fcntl!, [reader, 4, 0x800])).toBe(0);
  expect(await cpu.call(fcntl!, [reader, 3, 0])).toBe(0x802);

  const alias = await cpu.call(dup!, [writer]);
  expect(await cpu.call(close!, [writer])).toBe(0);
  const byte = mem.hostAlloc(1);
  expect(await cpu.call(recvfrom!, [reader, byte, 1, 0, 0, 0])).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(11);

  mem.st8(byte, 0x5a);
  expect(await cpu.call(sendto!, [alias, byte, 1, 0x4000, 0, 0])).toBe(1);
  mem.st8(byte, 0);
  expect(await cpu.call(recvfrom!, [reader, byte, 1, 0, 0, 0])).toBe(1);
  expect(mem.u8[byte]).toBe(0x5a);

  expect(await cpu.call(close!, [alias])).toBe(0);
  expect(await cpu.call(recvfrom!, [reader, byte, 1, 0, 0, 0])).toBe(0);
  expect(await cpu.call(close!, [reader])).toBe(0);
});


test("directory-relative file operations resolve an open directory", async () => {
  vfs.mkdir("/data/openat-test");
  vfs.write("/data/openat-test/value", Uint8Array.of(42));
  const open = lookupHost("open", "libc.so")!, openat = lookupHost("__openat_2", "libc.so")!;
  const close = lookupHost("close", "libc.so")!, read = lookupHost("read", "libc.so")!;
  const dir = await cpu.call(open, [mem.hostStr("/data/openat-test"), 0x4000]);
  const mkdir = lookupHost("mkdirat", "libc.so")!;
  expect(await cpu.call(mkdir, [dir, mem.hostStr("child"), 0o700])).toBe(0);
  expect(vfs.isDir("/data/openat-test/child")).toBe(true);
  expect(await cpu.call(mkdir, [dir, mem.hostStr("child"), 0o700])).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(17);
  const fd = await cpu.call(openat, [dir, mem.hostStr("value"), 0]);
  const stat = lookupHost("fstatat64", "libc.so")!, info = mem.hostAlloc(128);
  expect(await cpu.call(stat, [dir, mem.hostStr("value"), info, 0])).toBe(0);
  expect(mem.ld64(info + 48)).toBe(1n);
  expect(await cpu.call(stat, [fd, mem.hostStr(""), info, 0x1000])).toBe(0);
  expect(mem.ld64(info + 48)).toBe(1n);
  expect(await cpu.call(stat, [fd, mem.hostStr("value"), info, 0])).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(20);
  const access = lookupHost("faccessat", "libc.so")!;
  expect(await cpu.call(access, [dir, mem.hostStr("value"), 4, 0])).toBe(0);
  expect(await cpu.call(access, [dir, mem.hostStr("absent"), 0, 0])).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(2);
  const byte = mem.hostAlloc(1);
  expect(await cpu.call(read, [fd, byte, 1])).toBe(1);
  expect(mem.u8[byte]).toBe(42);
  expect(await cpu.call(openat, [fd, mem.hostStr("value"), 0])).toBe(-1);
  expect(mem.ld32(cpu.errnoAddr)).toBe(20);
  await cpu.call(close, [fd]);
  await cpu.call(close, [dir]);
});
