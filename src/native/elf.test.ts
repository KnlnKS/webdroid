import { expect, test } from "bun:test";
import { packedRelocations } from "./elf";

function aps2(values: number[]): Uint8Array {
  const bytes = [65, 80, 83, 50];
  for (const n of values) {
    let value = BigInt(n);
    for (;;) {
      const byte = Number(value & 127n);
      value >>= 7n;
      const end = value === 0n && !(byte & 64) || value === -1n && !!(byte & 64);
      bytes.push(byte | (end ? 0 : 128));
      if (end) break;
    }
  }
  return Uint8Array.from(bytes);
}
function decode(values: number[], rela = true): number[][] {
  const rows: number[][] = [];
  packedRelocations(aps2(values), rela, (...row) => rows.push(row));
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
  expect(() => packedRelocations(new Uint8Array(4), true, () => {})).toThrow("header");
  for (const values of [[-1, 0], [1, 0, 0, 0], [1, 0, 2, 0], [1, 0, 1, 16], [1, 0, 1, 3, 8]]) {
    expect(() => decode(values)).toThrow();
  }
  expect(() => decode([1, 0, 1, 8], false)).toThrow("group");
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
