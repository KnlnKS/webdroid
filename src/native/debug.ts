// wd.native: modules, symbolize, traces, threads, unresolved/jniMissing, peek/poke.
import { modules, symbolizePc } from "./dl";
import { hostTrace, calledMissing, unresolved } from "./host";
import { jniMissing, jniTrace, registered } from "./jni";
import { Cpu, cpus, blockStats, stepMode, setStepMode, profile, blockAt, slice } from "./cpu";
import { mainThread } from "../jvm/natives/jlang";
import { mem } from "./mem";
import { glProbe } from "./gles1";
import { emitBlock } from "./arm";
import { emitThumbBlock } from "./thumb";

export const native = {
  modules,
  symbolize: (pc: number) => symbolizePc(pc),
  /** host-call trace: trace(true), trace(/^gl/), trace(false); the ring is trace.ring */
  trace(on: boolean | RegExp = true) {
    hostTrace.on = !!on;
    hostTrace.filter = on instanceof RegExp ? on : null;
    if (!on) hostTrace.ring.length = 0;
    return hostTrace;
  },
  jni: jniTrace,
  regs: () => [...cpus].map((c) => ({ name: c.name, tid: c.tid, pc: symbolizePc(c.r[15] >>> 0), t: c.t, ic: c.ic, r: [...c.r].map((v) => (v >>> 0).toString(16)), finished: c.finished, pending: !!c.pending })),
  calledMissing, unresolved, jniMissing, registered,
  blocks: blockStats,
  /** profileReset(n) also sets the slice budget: a smaller one samples the hot pcs more finely */
  profileReset: (instr = slice.instr) => { slice.instr = instr; profile.samples.clear(); },
  /** the JS a block compiles to (odd pc = Thumb) */
  src: (pc: number) => (pc & 1 ? emitThumbBlock(pc & ~1) : emitBlock(pc)).src,
  /** top pcs at slice boundaries, symbolised (share of all samples) */
  profile: (n = 20) => {
    const total = [...profile.samples.values()].reduce((a, b) => a + b, 0);
    return [...profile.samples].sort((a, b) => b[1] - a[1]).slice(0, n).map(([pc, k]) => `${(100 * k / total).toFixed(1)}% ${symbolizePc(pc)}`);
  },
  /** step(true) single-steps every Cpu into step.ring (pc + changed registers) */
  step: (on = true) => { setStepMode(on); return stepMode; },
  stepRing: stepMode.ring, stepHits: stepMode.hits,
  mem: mem.stats, memObj: mem, cpus: () => [...cpus], blockAt,
  peek: (a: number, n = 16) => Array.from(mem.bytes(a, n)).map((b) => b.toString(16).padStart(2, "0")).join(" "),
  cstr: (a: number) => mem.cstr(a),
  glProbe,
};
// a harness can arm the trace before boot: page.addInitScript(() => { globalThis.__wdNativeTrace = "regex" })
const pre = (globalThis as { __wdNativeTrace?: string }).__wdNativeTrace;
if (pre) { hostTrace.on = true; hostTrace.filter = pre === "." ? null : new RegExp(pre); hostTrace.max = 2000; }
if ((globalThis as { __wdNativeStep?: boolean }).__wdNativeStep) { setStepMode(true); stepMode.watch = (globalThis as { __wdNativeWatch?: number }).__wdNativeWatch ?? 0; }
/** microbenchmark: the classic byte-copy loop, 20M iterations on a scratch Cpu (M instr/s) */
function bench(): string {
  const CODE = 0x00f00000;
  const words = [0xe7d1c003, 0xe2422001, 0xe7c0c003, 0xe2833001, 0xe3520000, 0x1afffffa, 0xe12fff1e];
  for (let i = 0; i < words.length; i++) mem.u32[(CODE >>> 2) + i] = words[i];
  const c = new Cpu(mainThread, "bench");
  c.ensureStack();
  const N = 20_000_000;
  c.r[0] = 0x3000000; c.r[1] = 0x5000000; c.r[2] = N; c.r[3] = 0; c.r[14] = 0x0fff_fff0; c.setPc(CODE);
  const t0 = performance.now();
  while (c.runSlice(10_000_000) !== 2) { /* spin */ }
  const ms = performance.now() - t0;
  return `${c.ic} instr in ${ms.toFixed(0)}ms → ${(c.ic / ms / 1000).toFixed(0)}M instr/s`;
}
(native as unknown as { bench: () => string }).bench = bench;
