import { afterAll, beforeAll, expect, test } from "bun:test";
import { setA64 } from "./cpu";
import { core, CORE_LIBC } from "./core";
import { mem } from "./mem";

beforeAll(() => setA64(true));
afterAll(() => setA64(false));

test("core copies preserve overlap and invalidate executed pages across the copied range", () => {
  const p = mem.memalign(0x1000, 0x4000), cp = core.cpu_alloc(1, 1);
  const args = new BigUint64Array(mem.buf, cp, 3);
  const copy = (d: number, s: number, n: number, id = CORE_LIBC.memmove) => {
    args.set([BigInt(d), BigInt(s), BigInt(n)]);
    expect(core.libc_call(cp, id)).toBe(0);
    expect(args[0]).toBe(BigInt(d));
  };
  try {
    for (const id of [CORE_LIBC.memcpy, CORE_LIBC.memmove]) {
      for (const offset of [-33, -1, 0, 1, 33, 256]) {
        const bytes = mem.bytes(p, 512);
        bytes.set(Uint8Array.from({ length: 512 }, (_, i) => i));
        const expected = bytes.slice();
        expected.copyWithin(64 + offset, 64, 192);
        copy(p + 64 + offset, p + 64, 128, id);
        expect(bytes).toEqual(expected);
      }
      copy(0xffffffff, 0xffffffff, 0, id);
    }
    mem.st32(p + 0x1000, 0xd503201f); // A64 nop
    expect(core.exec_word(cp, 0xd503201f, p + 0x1000)).toBe(0);
    const before = core.cpu_stat(1);
    copy(p, p + 0x1000, 0x3000);
    expect(core.cpu_stat(1)).toBe(before + 1);
  } finally {
    core.cpu_free(cp);
    mem.free(p);
  }
});

test("core zlib checksums preserve incremental state", () => {
  const p = mem.malloc(9), cp = core.cpu_alloc(1, 1);
  const args = new BigUint64Array(mem.buf, cp, 3);
  mem.write(p, new TextEncoder().encode("123456789"));
  const update = (id: number, initial: number, offset: number, length: number) => {
    args.set([BigInt(initial >>> 0), BigInt(p + offset), BigInt(length)]);
    expect(core.libc_call(cp, id)).toBe(0);
    return Number(args[0] & 0xffffffffn);
  };
  try {
    expect(update(CORE_LIBC.crc32, update(CORE_LIBC.crc32, 0, 0, 4), 4, 5)).toBe(0xcbf43926);
    expect(update(CORE_LIBC.adler32, update(CORE_LIBC.adler32, 1, 0, 4), 4, 5)).toBe(0x091e01de);
  } finally {
    core.cpu_free(cp);
    mem.free(p);
  }
});

test("A64 transient mappings stay out of the malloc arena", () => {
  const warmup = mem.malloc(16);
  mem.free(warmup);
  const before = mem.stats();
  const small = mem.mapVa(0x000f_f000, false);
  if (typeof small !== "number") throw new Error("small mapping left the fast path");
  expect(mem.unmapPages(small, 0x000f_f000)).toBe(true);

  const mapping = mem.mapVa(0x0010_0000, false);
  const reservation = mem.mapVa(0x7000_0000, true);
  if (typeof mapping !== "bigint" || typeof reservation !== "bigint") {
    throw new Error("large A64 mapping did not receive a virtual plane");
  }
  const allocation = mem.malloc(0x1000);

  const interleaved = mem.stats();
  expect(mapping >> 32n).not.toBe(0n);
  expect(reservation >> 32n).not.toBe(0n);
  expect(interleaved.planes).toBe(before.planes + 2);
  expect(interleaved.chunks).toBe(before.chunks + 1);
  expect(interleaved.peak - before.peak).toBeLessThan(0x10_0000);

  mem.free(allocation);
  expect(mem.unmapVa(mapping, 0x0010_0000)).toBe(true);
  expect(mem.unmapVa(reservation, 0x7000_0000)).toBe(true);
  expect(mem.stats().planes).toBe(before.planes);
});
