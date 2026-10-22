// Region-transition benchmark: pnpm ts scripts/native-bench.ts same|cross arm|thumb, or call|call-same a64
// One million iterations per call; 25 warmup calls, then 25 samples. Each call checks the answer.
// Encodings from clang. Compare fresh processes serially.
import { Cpu, setA64, SliceExit } from "../src/native/cpu.ts";
import { mem } from "../src/native/mem.ts";
import { jitStats } from "../src/native/core.ts";
import { mainThread } from "../src/jvm/natives/jentry.ts";
import { RET_SENTINEL } from "../src/native/abi.ts";
import { placeLoop } from "../src/native/loop.testkit.ts";
const shape = process.argv[2] ?? "cross", isa = process.argv[3] ?? "arm", thumb = isa === "thumb", a64 = isa === "a64";
setA64(a64);
if (!(a64 ? ["call", "call-same"].includes(shape) : ["same", "cross"].includes(shape) && ["arm", "thumb"].includes(isa))) throw new Error("expected same|cross arm|thumb, or call|call-same a64");
const base = mem.reserve(8192, 4096), at = base + (shape === "cross" ? 4096 - 8 : 2048);
if (a64) {
  // mov x19, x30; 1: bl leaf; subs w0, w0, #1; b.ne 1b; mov x30, x19; ret / leaf: add w1, w1, #3; ret
  const leaf = shape === "call-same" ? at + 64 : base + 4096;
  [0xaa1e03f3, 0x94000000 | ((leaf - at - 4) >> 2), 0x71000400, 0x54ffffc1, 0xaa1303fe, 0xd65f03c0].forEach((word, i) => mem.st32(at + i * 4, word));
  mem.st32(leaf, 0x11000c21); mem.st32(leaf + 4, 0xd65f03c0);
} else placeLoop(at, thumb);
const c = new Cpu(mainThread, "bench");
c.ensureStack(); c.w[c.spx * 2] = c.stackTop; c.w[c.lrx * 2] = RET_SENTINEL;
const run = () => {
  const before = c.ic;
  c.w[0] = 1000000; c.w[2] = 0; c.setPc(at | +thumb);
  if (c.runSlice(10000000) !== SliceExit.Exit) throw new Error("native loop did not return within its instruction budget");
  if (c.ic - before !== (a64 ? 5000003 : 4000001)) throw new Error("wrong instruction count");
  if (c.w[2] !== 3000000 || c.w[0] !== 0) throw new Error("bad native result");
};
const samples: number[] = [];
for (let i = 0; i < 50; i++) {
  const t = performance.now();
  run(); samples.push(performance.now() - t);
  if (i % 5 === 4) await new Promise(r => setTimeout(r, 0));
}
console.log(JSON.stringify({ shape, isa, samples: samples.slice(25), regions: jitStats.regions, ic: c.ic }));
process.exit();
