// wd.native: modules, symbolize, traces, threads, unresolved/jniMissing, peek/poke.
import { modules, symbolizePc, backtrace } from "./dl";
import { hostTrace, calledMissing, unresolved, probed } from "./host";
import { killLog } from "./proc";
import { futexStats } from "./pthread";
import { jniMissing, jniTrace, registered } from "./jni";
import { Cpu, cpus, blockStats, stepMode, setStepMode, profile, blockAt, slice, isA64, setA64, hasProcessExited, yieldStats, sigHandlers, watchPcs, lastFault, allBlocks, invalidatedPages, invalidations, coldTier } from "./cpu";
import { mainThread } from "../jvm/natives/jlang";
import { mem } from "./mem";
import { RET_SENTINEL } from "./abi";
import { glProbe } from "./gles1";
import { glRing, glDebug } from "./gles3";
import { emitBlock } from "./arm";
import { emitA64Block } from "./a64";
import { emitThumbBlock } from "./thumb";
import { netDebug } from "./net";

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
  regs: () => [...cpus].map((c) => ({
    name: c.name, tid: c.tid, pc: symbolizePc(c.r[c.pcx] >>> 0), t: c.t, ic: c.ic,
    r: [...c.r].map((v) => (v >>> 0).toString(16)),
    // the high halves only exist in a 64-bit process, and printing 32 zeros in a 32-bit one
    // is noise rather than information
    ...(c.a64 ? { h: [...c.h].map((v) => (v >>> 0).toString(16)) } : {}),
    finished: c.finished, pending: !!c.pending, parked: c.parked, depth: c.depth, state: c.state, frames: [...c.frames], loops: c.loops, sigLog: c.sigLog.slice(-40), signals: [...c.signals], handling: [...c.handling], sigWait: !!c.sigWait,
  })),
  calledMissing, unresolved, probed, jniMissing, registered, exited: hasProcessExited, sigHandlers: () => [...sigHandlers].map(([s, h]) => [s, symbolizePc(h.fn)]), yieldStats, killLog, futexStats: () => Object.fromEntries(futexStats),
  blocks: blockStats,
  /** profileReset(n) also sets the slice budget: a smaller one samples the hot pcs more finely */
  profileReset: (instr = slice.instr) => { slice.instr = instr; profile.samples.clear(); },
  /** the JS a block compiles to. In a 64-bit process every pc is A64; in a 32-bit one an odd pc
   *  is Thumb — the low bit is the interworking bit, which A64 does not have. */
  src: (pc: number) => (isA64() ? emitA64Block(pc) : pc & 1 ? emitThumbBlock(pc & ~1) : emitBlock(pc)).src,
  /** top pcs at slice boundaries, symbolised (share of all samples) */
  profile: (n = 20) => {
    const total = [...profile.samples.values()].reduce((a, b) => a + b, 0);
    return [...profile.samples].sort((a, b) => b[1] - a[1]).slice(0, n).map(([pc, k]) => `${(100 * k / total).toFixed(1)}% ${symbolizePc(pc)}`);
  },
  /** step(true) single-steps every Cpu into step.ring (pc + changed registers) */
  step: (on = true) => { setStepMode(on); return stepMode; },
  stepRing: stepMode.ring, stepHits: stepMode.hits,
  mem: mem.stats, memObj: mem, cpus: () => [...cpus], blockAt,
  /** the frame-pointer chain of a thread; a watched pc logs its registers on every entry (set before its block compiles) */
  backtrace: (name: string) => { const c = [...cpus].find((c) => c.name === name); return c ? backtrace(c) : []; }, watchPcs, lastFault, allBlocks, invalidatedPages, invalidations, coldTier,
  peek: (a: number, n = 16) => Array.from(mem.bytes(a, n)).map((b) => b.toString(16).padStart(2, "0")).join(" "),
  cstr: (a: number) => mem.cstr(a),
  glProbe, glRing, gl3: glDebug, net: netDebug,
};
// a harness can arm the trace before boot: page.addInitScript(() => { globalThis.__wdNativeTrace = "regex" })
const pre = (globalThis as { __wdNativeTrace?: string }).__wdNativeTrace;
if (pre) { hostTrace.on = true; hostTrace.filter = pre === "." ? null : new RegExp(pre); hostTrace.max = 2000; }
if ((globalThis as { __wdNativeStep?: boolean }).__wdNativeStep) { setStepMode(true); stepMode.watch = (globalThis as { __wdNativeWatch?: number }).__wdNativeWatch ?? 0; }
/** microbenchmark: the classic byte-copy loop, 20M iterations on a scratch Cpu, run on BOTH
 *  emitters so the two tiers are quoted in one unit. The A64 form is the same six instructions
 *  (`clang -target aarch64-linux-gnu`), so the ratio is the register file's, not the loop's. */
let benchBufs: { src: number; dst: number } | null = null;
function bench(): string {
  const N = 20_000_000;
  // reserved once: the arena bump-allocates and never frees, so a second call must not take
  // another 40 MiB out of it
  benchBufs ??= { src: mem.reserve(N + 0x1000, 0x1000), dst: mem.reserve(N + 0x1000, 0x1000) };
  const { src, dst } = benchBufs;
  const A32 = [0xe7d1c003, 0xe2422001, 0xe7c0c003, 0xe2833001, 0xe3520000, 0x1afffffa, 0xe12fff1e];
  const A64 = [0x3863682c, 0xd1000442, 0x3823680c, 0x91000463, 0xb5ffff82, 0xd65f03c0];
  const was = isA64();
  const one = (words: number[], a64: boolean) => {
    setA64(a64);
    const code = mem.reserve(0x1000, 0x1000);
    for (let i = 0; i < words.length; i++) mem.u32[(code >>> 2) + i] = words[i];
    const c = new Cpu(mainThread, "bench");
    c.ensureStack();
    c.r[0] = dst; c.r[1] = src; c.r[2] = N; c.r[3] = 0;
    c.r[c.lrx] = RET_SENTINEL;
    c.setPc(code);
    const t0 = performance.now();
    while (c.runSlice(10_000_000) !== 2) { /* spin */ }
    const ms = performance.now() - t0;
    return `${(c.ic / ms / 1000).toFixed(0)}M instr/s (${c.ic} in ${ms.toFixed(0)}ms)`;
  };
  const arm = one(A32, false), a64 = one(A64, true);
  setA64(was);
  return `arm: ${arm} · a64: ${a64}`;
}
(native as unknown as { bench: () => string }).bench = bench;
