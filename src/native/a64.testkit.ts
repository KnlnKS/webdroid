// The harness the A64 decoder tests share: a code page reserved through mem.reserve (never an
// address the stack allocator can march into), a fresh Cpu, and the slice loop run to the return
// sentinel. Encodings in the tests come from `clang -target aarch64-linux-gnu`, never hand-derived.
import { mem } from "./mem";
import { Cpu, coldTier } from "./cpu";
import { mainThread } from "../jvm/natives/jlang";
import { RET_SENTINEL } from "./abi";

export const RET = 0xd65f03c0;

/** one Cpu for every run: a thread stack is address space that is never given back */
let shared: Cpu | null = null;
function execute(words: number[], setup: (c: Cpu) => void, heat: number): Cpu {
  const savedHeat = coldTier.heat;
  coldTier.heat = heat;
  try {
    const at = mem.reserve((words.length * 4 + 0xfff) & ~0xfff, 0x1000);
    for (let i = 0; i < words.length; i++) mem.u32[(at >>> 2) + i] = words[i];
    const c = (shared ??= new Cpu(mainThread, "test"));
    c.r.fill(0); c.h.fill(0); c.si.fill(0);
    c.n = c.z = c.c = c.v = c.q = c.t = c.excl = c.fpcr = c.fpsr = 0;
    c.ensureStack();
    c.r[c.spx] = c.stackTop;
    setup(c);
    c.r[30] = RET_SENTINEL;
    c.setPc(at);
    while (c.runSlice(10000) !== 2) { /* spin */ }
    return c;
  } finally {
    coldTier.heat = savedHeat;
  }
}

/** Decoder tests exercise the emitter; cold-tier tests opt in explicitly below. */
export function run(words: number[], setup: (c: Cpu) => void = () => {}): Cpu {
  return execute(words, setup, 0);
}

export function runCold(words: number[], setup: (c: Cpu) => void = () => {}, heat = 255): Cpu {
  return execute(words, setup, heat);
}

/** a page whose byte at offset i is i & 0xff, for load/store tests */
export function pattern(): number {
  const buf = mem.reserve(0x1000, 0x1000);
  for (let i = 0; i < 0x1000; i++) mem.u8[buf + i] = i & 0xff;
  return buf;
}
