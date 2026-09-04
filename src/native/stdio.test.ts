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
