// wd.native: modules, symbolize, traces, threads, unresolved/jniMissing, peek/poke.
import { modules, symbolizePc, backtrace } from "./dl.ts";
import { hostTrace, calledMissing, unresolved, probed, hostCounts, slotName } from "./host.ts";
import { dispositions } from "./signals.ts";
import { killLog } from "./libc32/signal.ts";
import { futexStats } from "./thread.ts";
import { jniMissing, jniTrace, registered } from "./jni.ts";
import { cpus, codeStats, stepMode, setStepMode, profile, slice, watchPcs, lastFault, invalidations } from "./cpu.ts";
import { yieldStats } from "../jvm/yield.ts";
import { mem } from "./mem.ts";
import { processExited } from "../process-exit.ts";
import { core, jitStats } from "./core.ts";
import { netDebug } from "./socket/core.ts";

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
    r: [...Array(c.a64 ? 32 : 16)].map((_, i) => c.regHex(i)),
    finished: c.finished, pending: !!c.pending, parked: c.parked, depth: c.depth, state: c.state, frames: c.frames.map((f) => f.label), loops: c.loops, sigLog: [...c.sigLog], signals: [...c.signals.keys()], handling: [...c.handling], sigWait: !!c.sigWait,
  })),
  calledMissing, unresolved, probed, jniMissing, registered, exited: processExited, sigHandlers: () => [...dispositions].flatMap(([s, d]) => d.kind === "handler" ? [[s, symbolizePc(d.fn)]] : []), yieldStats, killLog, futexStats: () => Object.fromEntries(futexStats),
  blocks: codeStats, jit: jitStats,
  /** the wasm core itself: jit_fallback(lo, hi) + invalidate_range(addr, size) bisect a miscompile without a reload */
  core,
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
  stepRing: stepMode.ring,
  mem: mem.stats, memObj: mem, cpus: () => [...cpus],
  /** the frame-pointer chain of a thread; a watched pc logs its registers on every entry */
  backtrace: (name: string) => { const c = [...cpus].find((c) => c.name === name); return c ? backtrace(c) : []; }, watchPcs, lastFault, invalidations,
  peek: (a: number, n = 16) => Array.from(mem.bytes(a, n)).map((b) => b.toString(16).padStart(2, "0")).join(" "),
  cstr: mem.cstr,
  net: netDebug,
};
// a harness can arm the trace before boot: page.addInitScript(() => { globalThis.__wdNativeTrace = "regex" })
const pre = (globalThis as { __wdNativeTrace?: string }).__wdNativeTrace;
if (pre) { hostTrace.on = true; hostTrace.filter = pre === "." ? null : new RegExp(pre); hostTrace.max = 2000; }
if ((globalThis as { __wdNativeStep?: boolean }).__wdNativeStep) setStepMode(true);
