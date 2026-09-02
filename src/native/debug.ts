// wd.native: modules, symbolize, traces, threads, unresolved/jniMissing, peek/poke.
import { modules, symbolizePc } from "./dl";
import { hostTrace, calledMissing, unresolved } from "./host";
import { jniMissing, jniTrace, registered } from "./jni";
import { cpus, blockStats, stepMode, setStepMode } from "./cpu";
import { mem } from "./mem";
import { glProbe } from "./gles1";

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
  pcRing: (tid?: number) => { const c = [...cpus].find((x) => tid === undefined || x.tid === tid); return c ? Array.from({ length: 64 }, (_, i) => symbolizePc(c.ring[(c.rp + 1 + i) & 63] >>> 0)) : []; },
  calledMissing, unresolved, jniMissing, registered,
  blocks: blockStats,
  /** step(true) single-steps every Cpu into step.ring (pc + changed registers) */
  step: (on = true) => { setStepMode(on); return stepMode; },
  stepRing: stepMode.ring, stepHits: stepMode.hits,
  mem: mem.stats,
  peek: (a: number, n = 16) => Array.from(mem.bytes(a, n)).map((b) => b.toString(16).padStart(2, "0")).join(" "),
  cstr: (a: number) => mem.cstr(a),
  glProbe,
};
// a harness can arm the trace before boot: page.addInitScript(() => { globalThis.__wdNativeTrace = "regex" })
const pre = (globalThis as { __wdNativeTrace?: string }).__wdNativeTrace;
if (pre) { hostTrace.on = true; hostTrace.filter = pre === "." ? null : new RegExp(pre); hostTrace.max = 2000; }
if ((globalThis as { __wdNativeStep?: boolean }).__wdNativeStep) { setStepMode(true); stepMode.watch = (globalThis as { __wdNativeWatch?: number }).__wdNativeWatch ?? 0; }
