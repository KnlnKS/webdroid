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
