import { describe, expect, test } from "bun:test";
import { decodeAndroidPacked, decodeRelr } from "./elf";

const sleb = (input: number | bigint): number[] => {
  let value = BigInt(input);
  const out: number[] = [];
  for (;;) {
    const byte = Number(value & 0x7fn);
    value >>= 7n;
    const done = (value === 0n && !(byte & 0x40)) || (value === -1n && !!(byte & 0x40));
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
};
const aps2 = (...values: (number | bigint)[]) => Uint8Array.from([65, 80, 83, 50, ...values.flatMap(sleb)]);

describe("Android packed relocations", () => {
  test("streams grouped RELA offsets, info and addends", () => {
    const info = (3n << 32n) | 1027n, got: unknown[] = [];
    decodeAndroidPacked("test", aps2(2, 0, 2, 15, 8, info, -4), true, (r) => got.push(r));
    expect(got).toEqual([
      { off: 8, info, addend: -4 },
      { off: 16, info, addend: -4 },
    ]);
  });

  test("accumulates ungrouped RELA values", () => {
    const a = (1n << 32n) | 1025n, b = (2n << 32n) | 1026n, got: unknown[] = [];
    decodeAndroidPacked("test", aps2(2, 4, 2, 8, 12, a, 5, 20, b, -2), true, (r) => got.push(r));
    expect(got).toEqual([
      { off: 16, info: a, addend: 5 },
      { off: 36, info: b, addend: 3 },
    ]);
  });

  test("decodes REL groups without addends", () => {
    const info = (4n << 8n) | 23n, got: unknown[] = [];
    decodeAndroidPacked("test", aps2(2, 0, 2, 3, 4, info), false, (r) => got.push(r));
    expect(got).toEqual([
      { off: 4, info, addend: 0 },
      { off: 8, info, addend: 0 },
    ]);
  });

  test("rejects malformed streams", () => {
    expect(() => decodeAndroidPacked("test", new Uint8Array(), true, () => {})).toThrow(/header/);
    expect(() => decodeAndroidPacked("test", aps2(1, 0, 1), true, () => {})).toThrow(/truncated/);
    expect(() => decodeAndroidPacked("test", aps2(1, 0, 0, 0), true, () => {})).toThrow(/group size/);
    expect(() => decodeAndroidPacked("test", aps2(1, 0, 2, 0), true, () => {})).toThrow(/group size/);
    expect(() => decodeAndroidPacked("test", aps2(1, 0, 1, 8, 4, 23, 1), false, () => {})).toThrow(/addend/);
  });
});

describe("RELR relocations", () => {
  test("streams direct addresses and bitmap entries", () => {
    const words = new BigUint64Array([0x1000n, 0b1011n, 0x1300n]), got: number[] = [];
    decodeRelr("test", new Uint8Array(words.buffer), 8, (off) => got.push(off));
    expect(got).toEqual([0x1000, 0x1008, 0x1018, 0x1300]);
  });

  test("decodes 32-bit words and rejects malformed tables", () => {
    const words = new Uint32Array([0x2000, 0b111]), got: number[] = [];
    decodeRelr("test", new Uint8Array(words.buffer), 4, (off) => got.push(off));
    expect(got).toEqual([0x2000, 0x2004, 0x2008]);
    expect(() => decodeRelr("test", Uint8Array.of(1), 8, () => {})).toThrow(/size/);
    expect(() => decodeRelr("test", new Uint8Array(new BigUint64Array([3n]).buffer), 8, () => {})).toThrow(/precedes/);
  });
});

function decode(values: number[], rela = true): number[][] {
  const rows: number[][] = [];
  decodeAndroidPacked("test", aps2(...values), rela, r => rows.push([r.off, Number(r.info), r.addend]));
  return rows;
}

test("APS2 carries grouped addends across groups and resets groups without addends", () => {
  expect(decode([5, 0x100, 2, 15, 8, 1027, 64, 2, 9, 4294968321, 16, -16, 8, 32, 1, 3, 8, 1027])).toEqual([
    [0x108, 1027, 64], [0x110, 1027, 64], [0x120, 4294968321, 48],
    [0x128, 4294968321, 80], [0x130, 1027, 0],
  ]);
});
test("APS2 decodes individual info, offsets and negative addend deltas", () => {
  expect(decode([2, 0x200, 2, 8, 8, 1027, -32, -16, 8589934849, 8])).toEqual([
    [0x208, 1027, -32], [0x1f8, 8589934849, -24],
  ]);
  expect(decode([2, 0, 2, 2, 4, 23, 258], false)).toEqual([[4, 23, 0], [8, 258, 0]]);
});
test("APS2 rejects malformed headers, counts, groups and truncated encodings", () => {
  expect(() => decodeAndroidPacked("test", new Uint8Array(4), true, () => {})).toThrow("header");
  for (const values of [[-1, 0], [1, 0, 0, 0], [1, 0, 2, 0], [1, 0, 1, 16], [1, 0, 1, 3, 8]]) {
    expect(() => decode(values)).toThrow();
  }
  expect(() => decode([1, 0, 1, 8], false)).toThrow(/group|addend/);
});

test("ELF32 and ELF64 apply RELR address and high bitmap bits before reading constructors", async () => {
  const { loadElf } = await import("./elf");
  const { mem } = await import("./mem");
  for (const wide of [false, true]) for (const android of [false, true]) {
    const ptr = wide ? 8 : 4, bytes = new Uint8Array(4096), d = new DataView(bytes.buffer);
    const put = (off: number, value: number) => d.setUint32(off, value, true);
    put(0, 0x464c457f); bytes[4] = wide ? 2 : 1; bytes[5] = 1;
    d.setUint16(18, wide ? 0xb7 : 0x28, true);
    put(wide ? 32 : 28, 64);
    d.setUint16(wide ? 54 : 42, wide ? 56 : 32, true);
    d.setUint16(wide ? 56 : 44, 2, true);
    const ph = (p: number, type: number, at: number, size: number) => {
      put(p, type); put(p + (wide ? 8 : 4), at); put(p + (wide ? 16 : 8), at);
      put(p + (wide ? 32 : 16), size); put(p + (wide ? 40 : 20), size);
    };
    ph(64, 1, 0, 4096); ph(64 + (wide ? 56 : 32), 2, 0x100, 12 * ptr);
    const tags = [[android ? 0x6fffe000 : 36, 0x300], [android ? 0x6fffe001 : 35, ptr * 2],
      [android ? 0x6fffe003 : 37, ptr], [25, 0x400], [27, ptr * 2]];
    tags.forEach(([tag, value], i) => { put(0x100 + i * ptr * 2, tag); put(0x100 + i * ptr * 2 + ptr, value); });
    put(0x300, 0x400); put(0x300 + ptr, wide ? 3 : 0x80000003);
    if (wide) put(0x300 + ptr + 4, 0x80000000);
    const high = 0x400 + (ptr * 8 - 1) * ptr;
    put(0x400, 0x77); put(0x400 + ptr, 0x88); put(high, 0x99);
    const mod = loadElf("relr-test", bytes, () => { throw new Error("unexpected symbol"); });
    expect(mod.initArray).toEqual([mod.base + 0x77, mod.base + 0x88]);
    expect(mem.u32[(mod.base + high) >>> 2]).toBe(mod.base + 0x99);
  }
});
