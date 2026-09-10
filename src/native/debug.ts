// wd.native: modules, symbolize, traces, threads, unresolved/jniMissing, peek/poke.
import { modules, symbolizePc, backtrace } from "./dl";
import { hostTrace, calledMissing, unresolved, probed, hostCounts, slotName } from "./host";
import { killLog } from "./proc";
import { futexStats } from "./pthread";
import { jniMissing, jniTrace, registered } from "./jni";
import { Cpu, cpus, codeStats, stepMode, setStepMode, profile, slice, isA64, setA64, hasProcessExited, yieldStats, sigHandlers, watchPcs, lastFault, invalidations } from "./cpu";
import { mainThread } from "../jvm/natives/jlang";
import { mem } from "./mem";
import { core, jitStats } from "./core";
import { glProbe } from "./gles1";
import { glRing, glDebug } from "./gles3";
import { netDebug } from "./net";

export const native = {
  modules,
  symbolize: symbolizePc,
  /** host-call trace: trace(true), trace(/^gl/), trace(false); the ring is trace.ring */
  trace(on: boolean | RegExp = true) {
    hostTrace.on = !!on;
    core.host_bypass(on ? 1 : 0);
    hostTrace.filter = on instanceof RegExp ? on : null;
    if (!on) hostTrace.ring.length = 0;
    return hostTrace;
  },
  jni: jniTrace,
  regs: () => [...cpus].map((c) => ({
    name: c.name, tid: c.tid, pc: symbolizePc(c.pc), t: c.t, ic: c.ic,
    r: [...Array(32)].map((_, i) => (c.w[2 * i] >>> 0).toString(16)),
    // the high halves only exist in a 64-bit process, and printing 32 zeros in a 32-bit one
    // is noise rather than information
    ...(c.a64 ? { h: [...Array(32)].map((_, i) => (c.w[2 * i + 1] >>> 0).toString(16)) } : {}),
    finished: c.finished, pending: !!c.pending, parked: c.parked, depth: c.depth, state: c.state, frames: [...c.frames], loops: c.loops, sigLog: c.sigLog.slice(-40), signals: [...c.signals], handling: [...c.handling], sigWait: !!c.sigWait,
  })),
  calledMissing, unresolved, probed, jniMissing, registered, exited: hasProcessExited, sigHandlers: () => [...sigHandlers].map(([s, h]) => [s, symbolizePc(h.fn)]), yieldStats, killLog, futexStats: () => Object.fromEntries(futexStats),
  blocks: codeStats, jit: jitStats,
  /** the host calls made, most often first */
  hostCalls: (n = 20) => [...hostCounts].map((k, i) => [k, i]).filter(([k]) => k).sort((a, b) => b[0] - a[0]).slice(0, n).map(([k, i]) => `${k} ${slotName(i)}`),
  /** profileReset(n) also sets the slice budget: a smaller one samples the hot pcs more finely */
  profileReset: (instr = slice.instr) => { slice.instr = instr; profile.samples.clear(); },
  /** top pcs at slice boundaries, symbolised (share of all samples) */
  profile: (n = 20) => {
    const total = [...profile.samples.values()].reduce((a, b) => a + b, 0);
    return [...profile.samples].sort((a, b) => b[1] - a[1]).slice(0, n).map(([pc, k]) => `${(100 * k / total).toFixed(1)}% ${symbolizePc(pc)}`);
  },
  /** step(true) single-steps every Cpu into step.ring (pc + changed registers) */
  step: (on = true) => { setStepMode(on); return stepMode; },
  stepRing: stepMode.ring, stepHits: stepMode.hits,
  mem: mem.stats, memObj: mem, cpus: () => [...cpus],
  /** the frame-pointer chain of a thread; a watched pc logs its registers on every entry */
  backtrace: (name: string) => { const c = [...cpus].find((c) => c.name === name); return c ? backtrace(c) : []; }, watchPcs, lastFault, invalidations,
  peek: (a: number, n = 16) => Array.from(mem.bytes(a, n)).map((b) => b.toString(16).padStart(2, "0")).join(" "),
  cstr: mem.cstr,
  glProbe, glRing, gl3: glDebug, net: netDebug,
};
// a harness can arm the trace before boot: page.addInitScript(() => { globalThis.__wdNativeTrace = "regex" })
const pre = (globalThis as { __wdNativeTrace?: string }).__wdNativeTrace;
if (pre) { hostTrace.on = true; hostTrace.filter = pre === "." ? null : new RegExp(pre); hostTrace.max = 2000; }
if ((globalThis as { __wdNativeStep?: boolean }).__wdNativeStep) { setStepMode(true); stepMode.watch = (globalThis as { __wdNativeWatch?: number }).__wdNativeWatch ?? 0; }
/** microbenchmark: 20M-iteration loops on a scratch Cpu, quoted as guest instructions per second.
 *  Encodings from clang; it runs on the slice loop, as guest code does. */
let benchBufs: { src: number; dst: number; code: number[] } | null = null;
async function bench(): Promise<string> {
  const N = 20_000_000;
  // reserved once: the arena bump-allocates and never frees, so a second call must not take
  // another 40 MiB out of it. The code pages come from the arena, which survives the ABI
  // switch (the image region does not), so a second call runs the regions the first compiled
  // (the engine's tiered-up code, on Chrome) rather than compiling afresh
  benchBufs ??= { src: mem.reserve(N + 0x1000, 0x1000), dst: mem.reserve(N + 0x1000, 0x1000), code: [] };
  const { src, dst } = benchBufs;
  const copy = [dst, src, N, 0], sum = [src, N, 0];
  // the transfer cost: `mov x4, x30; loop: blr x3; subs x2, x2, #1; b.ne loop; ret x4` calling `f: add x0, x0, #1; ret`
  // the flag cost: byte sums with cmp+conditional add (A32) and cmp+csel (A64), and a Thumb sum whose every op sets flags
  const programs: [string, boolean, number[], number[] | ((code: number) => number[]), boolean?][] = [
    ["arm copy", false, [0xe7d1c003, 0xe2422001, 0xe7c0c003, 0xe2833001, 0xe3520000, 0x1afffffa, 0xe12fff1e], copy],
    ["a64 copy", true, [0x3863682c, 0xd1000442, 0x3823680c, 0x91000463, 0xb5ffff82, 0xd65f03c0], copy],
    ["a64 call", true, [0xaa1e03e4, 0xd63f0060, 0xf1000442, 0x54ffffc1, 0xd65f0080, 0x91000400, 0xd65f03c0], (code) => [0, 0, N, code + 20]],
    ["thumb sum", false, [0x7803, 0x1c40, 0x18d2, 0x3901, 0xd1fa, 0x4770], sum, true],
    ["a32 sum", false, [0xe4d03001, 0xe0822003, 0xe2511001, 0x1afffffb, 0xe12fff1e], sum],
    ["a32 cmp", false, [0xe4d03001, 0xe3530040, 0x30822003, 0xe2511001, 0x1afffffa, 0xe12fff1e], sum],
    ["a64 sum", true, [0x38401403, 0x0b030042, 0x71000421, 0x54ffffa1, 0xd65f03c0], sum],
    ["a64 cmp", true, [0x38401403, 0x7101007f, 0x1a831042, 0x71000421, 0x54ffff81, 0xd65f03c0], sum],
  ];
  const was = isA64();
  const out: string[] = [];
  for (const [name, a64, words, args, thumb] of programs) {
    setA64(a64);
    const code = (benchBufs!.code[out.length] ??= mem.memalign(0x1000, 0x1000));
    if (thumb) for (let i = 0; i < words.length; i++) mem.u16[(code >>> 1) + i] = words[i];
    else for (let i = 0; i < words.length; i++) mem.u32[(code >>> 2) + i] = words[i];
    const c = new Cpu(mainThread, "bench"), a = typeof args === "function" ? args(code) : args, at = thumb ? code | 1 : code;
    // twice: the first pass compiles the region, the second is the steady state
    await c.call(at, a);
    const t0 = performance.now(), ic0 = c.ic;
    await c.call(at, a);
    out.push(`${name} ${((c.ic - ic0) / (performance.now() - t0) / 1000).toFixed(0)}M`);
  }
  setA64(was);
  return out.join(" · ");
}
(native as unknown as { bench: () => Promise<string> }).bench = bench;
