import { afterAll, beforeAll, expect, test } from "bun:test";
import { setA64 } from "./cpu";
import { core, CORE_LIBC } from "./core";
import { mem } from "./mem";

beforeAll(() => setA64(true));
afterAll(() => setA64(false));

test("core copies preserve overlap and invalidate executed pages across the copied range", () => {
  const p = mem.memalign(0x1000, 0x4000), cp = core.cpu_alloc(1, 1001, 1000, 1);
  const args = new BigUint64Array(mem.buf, cp, 4);
  const copy = (d: number, s: number, n: number, id = CORE_LIBC.memmove) => {
    args.set([BigInt(d), BigInt(s), BigInt(n), 0xffffffffffffffffn]);
    expect(core.libc_call(cp, id)).toBe(0);
    expect(args[0]).toBe(BigInt(d));
  };
  try {
    for (const id of [CORE_LIBC.memcpy, CORE_LIBC.memmove, CORE_LIBC.__memcpy_chk]) {
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
    const beforeOverflow = mem.bytes(p, 128).slice();
    args.set([BigInt(p), BigInt(p + 256), 128n, 127n]);
    expect(core.libc_call(cp, CORE_LIBC.__memcpy_chk)).toBe(2);
    expect(mem.bytes(p, 128)).toEqual(beforeOverflow);
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

test("core softfp math reads only the low word of each ARM32 register", () => {
  const cp = core.cpu_alloc(1, 1001, 1000, 0);
  const x = new BigUint64Array(mem.buf, cp, 4);
  const words = (v: number) => Array.from(new Uint32Array(Float64Array.of(v).buffer), BigInt);
  // compiled ARM32 code spills only the low words, so the upper ones can hold anything
  x.set([...words(2), ...words(10)].map((w) => 0xdeadbeef_00000000n | w));
  try {
    expect(core.libc_call(cp, CORE_LIBC.pow)).toBe(0);
    expect(new Float64Array(BigUint64Array.of(x[0] | x[1] << 32n).buffer)[0]).toBe(1024);
  } finally {
    core.cpu_free(cp);
  }
});

test("core zlib checksums preserve incremental state", () => {
  const p = mem.malloc(9), cp = core.cpu_alloc(1, 1001, 1000, 1);
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

test("the memory commits as pages come into use, and views made before keep their bytes", () => {
  const committed = mem.u8.length, early = mem.malloc(16), view = mem.bytes(early, 16);
  expect(committed).toBeLessThan(0x4000_0000);
  view[3] = 7;
  const big = mem.mapPages(committed);                    // past what is committed: the memory grows under it
  expect(mem.u8.length).toBeGreaterThanOrEqual(big + committed);
  mem.st8(big + committed - 1, 1);
  expect(view[3]).toBe(7);                                // shared, the grow detached nothing
  const plane = mem.mapVa(0x0040_0000, false);
  if (typeof plane !== "bigint") throw new Error("large A64 mapping did not receive a virtual plane");
  expect(mem.txVa(plane)).toBeLessThan(mem.u8.length);
  expect(mem.unmapVa(plane, 0x0040_0000)).toBe(true);
  expect(mem.unmapPages(big, committed)).toBe(true);
  mem.free(early);
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

test("mremap grows a mapping in place only into free address space", () => {
  const va = mem.mapVa(0x0020_0000, false);
  if (typeof va !== "bigint") throw new Error("large A64 mapping did not receive a virtual plane");
  mem.st8(mem.txVa(va), 5);
  expect(mem.extendVa(va, 0x0020_0000, 0x0080_0000)).toBe(true);
  expect(mem.u8[mem.txVa(va)]).toBe(5);
  expect(mem.u8[mem.txVa(va + 0x7f_ffffn)]).toBe(0);
  expect(mem.extendVa(va, 0x0010_0000, 0x0090_0000)).toBe(false);          // not the plane's end
  expect(mem.unmapVa(va, 0x0080_0000)).toBe(true);

  const low = mem.mapPages(0x4000);
  mem.unmapPages(low + 0x3000, 0x1000);
  expect(mem.extendVa(BigInt(low), 0x1000, 0x2000)).toBe(false);
  expect(mem.extendVa(BigInt(low), 0x3000, 0x4000)).toBe(true);
  expect(mem.residentVa(BigInt(low + 0x3000))).toBe(1);
  mem.unmapPages(low, 0x4000);
});

test("MAP_FIXED below a plane's mapping keeps the mapping's bytes at their addresses", () => {
  const va = mem.mapVa(0x0020_0000, false);
  if (typeof va !== "bigint") throw new Error("large A64 mapping did not receive a virtual plane");
  mem.st8(mem.txVa(va + 0x1000n), 5);
  expect(mem.mapFixed(va - 0x10_0000n, 0x10_0000)).toBe(true);
  expect(mem.commitVa(va - 0x10_0000n, 0x10_0000)).toBe(true);
  expect(mem.u8[mem.txVa(va + 0x1000n)]).toBe(5);
  expect(mem.u8[mem.txVa(va - 0x1000n)]).toBe(0);
  expect(mem.mapFixed(0x1000n, 0x1000)).toBe(false);                    // the core's own space
  expect(mem.unmapVa(va - 0x10_0000n, 0x30_0000)).toBe(true);
});

test("writable mappings beyond the pool commit on first touch, as Linux overcommits", () => {
  const size = 0x1_0080_0000;
  const va = mem.mapVa(size, false);
  if (typeof va !== "bigint") throw new Error("overcommitted mapping was refused");
  const before = mem.stats().chunks;
  const p = mem.txVa(va + 0x10_0000n);
  expect(mem.u8[p]).toBe(0);
  mem.st8(p, 7);
  expect(mem.u8[mem.txVa(va + 0x10_0000n)]).toBe(7);
  expect(mem.stats().chunks - before).toBe(1);
  // a host write past the committed pages commits them where the host already points
  mem.write(p, new Uint8Array(0x30_0000).fill(9));
  expect(mem.u8[mem.txVa(va + 0x3f_ffffn)]).toBe(9);
  expect(mem.txVa(va + 0x10_0000n)).toBe(p);
  expect(mem.unmapVa(va, size)).toBe(true);
});

test("a reservation commits sparsely, as an allocator's strided regions do", () => {
  const size = 0x2_1000_0000, va = mem.mapVa(size, true);
  if (typeof va !== "bigint") throw new Error("reservation refused");
  const before = mem.stats().chunks;
  for (let region = 1n; region < 33n; region += 8n) {
    const at = va + region * 0x1000_0000n + 0x3000n;
    expect(mem.commitVa(at, 0x4_0000)).toBe(true);
    mem.st32(mem.txVa(at), Number(region));
  }
  for (let region = 1n; region < 33n; region += 8n) expect(mem.ld32(mem.txVa(va + region * 0x1000_0000n + 0x3000n))).toBe(Number(region));
  expect(mem.stats().chunks - before).toBe(4);
  // unmapping a unit inside an extent returns it and keeps the units on either side
  const region = va + 0x1_8000_0000n, unit = 0x20_0000n;
  expect(mem.commitVa(region, 3 * Number(unit))).toBe(true);
  mem.st32(mem.txVa(region), 7); mem.st32(mem.txVa(region + 2n * unit), 9);
  const committed = mem.stats().chunks;
  expect(mem.unmapVa(region + unit, Number(unit))).toBe(true);
  expect(mem.stats().chunks).toBe(committed - 1);
  expect([mem.ld32(mem.txVa(region)), mem.ld32(mem.txVa(region + 2n * unit))]).toEqual([7, 9]);
  expect(mem.unmapVa(va, size)).toBe(true);
  expect(mem.stats().chunks).toBe(before);
});

test("mprotect accepts mapped ELF image pages", () => {
  const image = mem.reserve(8192, 4096);
  expect(mem.unmapPages(image, 4096)).toBe(true);
  expect(mem.commitVa(BigInt(image + 4096), 4096)).toBe(true);
  expect(mem.commitVa(BigInt(image), 4096)).toBe(false);
});
