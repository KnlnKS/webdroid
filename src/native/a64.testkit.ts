// The harness the A64 tests share: a code page reserved through mem.reserve (never an address
// the stack allocator can march into), a fresh Cpu, and the slice loop run to the return
// sentinel. Encodings in the tests come from `clang -target aarch64-linux-gnu`, never hand-derived.
import { mem } from "./mem";
import { Cpu } from "./cpu";
import { mainThread } from "../jvm/natives/jlang";
import { RET_SENTINEL } from "./abi";

export const RET = 0xd65f03c0;

/** one Cpu for every run: a thread stack is address space that is never given back */
let shared: Cpu | null = null;
export function run(words: number[], setup: (c: Cpu) => void = () => {}): Cpu {
  const at = mem.reserve((words.length * 4 + 0xfff) & ~0xfff, 0x1000);
  for (let i = 0; i < words.length; i++) mem.u32[(at >>> 2) + i] = words[i];
  const c = (shared ??= new Cpu(mainThread, "test"));
  c.w.fill(0); c.si.fill(0);
  c.cpsr = 0; c.excl = 0; c.fpcr = 0; c.fpsr = 0;
  c.ensureStack();
  c.w[62] = c.stackTop;
  setup(c);
  c.w[60] = RET_SENTINEL;
  c.setPc(at);
  while (c.runSlice(10000) !== 2) { /* spin */ }
  return c;
}
/** the tiers agree by construction until the JIT lands; the name keeps the tests' shape */
export const runCold = run;

/** a page whose byte at offset i is i & 0xff, for load/store tests */
export function pattern(): number {
  const buf = mem.reserve(0x1000, 0x1000);
  for (let i = 0; i < 0x1000; i++) mem.u8[buf + i] = i & 0xff;
  return buf;
}
