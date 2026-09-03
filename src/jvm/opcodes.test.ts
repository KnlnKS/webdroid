import { expect, test } from "bun:test";
import { OPS, FMT_LEN, insnLen } from "./opcodes";

// ART's quickened forms. A dex carrying one cannot be compiled — the operand is a resolved
// offset, not an index — but it must still be WALKABLE, or one odexed method makes the whole
// file unreadable before compilation starts.
const QUICK: Record<number, [string, number]> = {
  0xe3: ["iget-quick", 2], 0xe4: ["iget-wide-quick", 2], 0xe5: ["iget-object-quick", 2],
  0xe6: ["iput-quick", 2], 0xe7: ["iput-wide-quick", 2], 0xe8: ["iput-object-quick", 2],
  0xe9: ["invoke-virtual-quick", 3], 0xea: ["invoke-virtual/range-quick", 3],
  0xeb: ["iput-boolean-quick", 2], 0xec: ["iput-byte-quick", 2],
  0xed: ["iput-char-quick", 2], 0xee: ["iput-short-quick", 2],
  0xef: ["iget-boolean-quick", 2], 0xf0: ["iget-byte-quick", 2],
  0xf1: ["iget-char-quick", 2], 0xf2: ["iget-short-quick", 2],
};

test("quickened opcodes have a name and a length", () => {
  for (const [op, [name, len]] of Object.entries(QUICK)) {
    const entry = OPS[Number(op)];
    expect(entry?.[0]).toBe(name);
    expect(FMT_LEN[entry![1]]).toBe(len);
    expect(insnLen(Uint16Array.of(Number(op), 0, 0, 0), 0)).toBe(len);
  }
});

test("a method body full of quickened instructions walks to its end", () => {
  // iget-quick, invoke-virtual-quick, iput-short-quick, return-void
  const insns = Uint16Array.of(0x10e3, 0x0008, 0x20e9, 0x0004, 0x0010, 0x10ee, 0x000c, 0x000e);
  let pc = 0, seen = 0;
  while (pc < insns.length) { pc += insnLen(insns, pc); seen++; }
  expect(pc).toBe(insns.length);
  expect(seen).toBe(4);
});

test("every opcode slot is either an instruction or deliberately unused", () => {
  // the unused slots ART itself leaves: 0x3e-0x43, 0x73, 0x79-0x7a, 0xf3-0xf9
  const unused = new Set([0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x73, 0x79, 0x7a, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9]);
  for (let op = 0; op <= 0xff; op++) {
    if (unused.has(op)) expect(OPS[op]).toBeNull();
    else expect(OPS[op], `opcode 0x${op.toString(16)}`).not.toBeNull();
  }
});
