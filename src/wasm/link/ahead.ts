// Compiling ahead of the first call, in idle time: the methods the methods that ran call, so that an interaction's first calls find their code rather than
// compile it. The demand marks measure how much of what a launch compiled on demand this would have found.
import { ACC, type MethodInfo } from "../compiler/program.ts";
import { COUNT_SLOTS } from "../compiler/exc.ts";
import { mid } from "../compiler/ids.ts";
import type { World } from "./world.ts";

/** the methods a unit compiled ahead of their first call holds (AheadCompiler.compile), how many methods its calls are taken from, and the most it compiles in a World */
const AHEAD_UNIT = 16, AHEAD_ROOTS = 4096, AHEAD_MAX = 8192;

export class AheadCompiler {
  private readonly w: World;
  constructor(w: World) { this.w = w; }
  /** methods that ran, the latest last, then methods compiled ahead: what is compiled ahead are the methods they call */
  private roots: MethodInfo[] = [];
  /** methods to compile ahead, the next last */
  private queue: MethodInfo[] = [];
  /** the slots of methods compiled ahead that have not been seen to run: a build is made of what runs */
  private unran = new Set<number>();
  noteRun(ms: MethodInfo[]): void {
    if (!this.w.instantiates) return;
    this.roots.push(...ms);
    if (this.roots.length > AHEAD_ROOTS) this.roots.splice(0, this.roots.length - AHEAD_ROOTS / 2);
  }
  /** the methods compiled ahead that have run since joining the World's demand, and their calls are compiled ahead in turn */
  noteRuns(): void {
    for (const at of this.unran) {
      const s = this.w.slots.peek(at);
      if (s?.k !== "method" || !s.done) { this.unran.delete(at); continue; }
      if (!this.w.tiers.asked(at) && !(at < COUNT_SLOTS && this.w.tiers.counts()[at])) continue;
      this.unran.delete(at);
      this.w.demand.methods.add(s.m);
      this.noteRun([s.m]);
    }
  }
  /** the slot of `t` if it is worth compiling ahead: its class is linked and neither compiled code nor a build's module holds it */
  private candidate(t: MethodInfo): number {
    const rt = this.w.classes.get(t.cls);
    if (!rt || !t.codeOff || t.flags & ACC.NATIVE || this.w.intrinsic(t)) return -1;
    const slot = rt.slotBase + t.index, s = this.w.slots.at(slot);
    return s?.k !== "method" || s.done || this.w.tiers.pending(slot) || this.w.aot?.holds(slot) ? -1 : slot;
  }
  /** Idle time: compiles the first-tier code of the methods that the methods that ran call when the call has one target, then what those call, in units of AHEAD_UNIT,
   *  until `until`, so that an interaction's first calls find their code rather than compile it. Whether any is left. */
  compile(until: number): boolean {
    this.noteRuns();
    while (performance.now() < until && this.w.stats.ahead < AHEAD_MAX) {
      const unit: MethodInfo[] = [];
      while (unit.length < AHEAD_UNIT) {
        const t = this.queue.pop();
        if (t) { if (!unit.includes(t) && this.candidate(t) >= 0) unit.push(t); continue; }
        const root = this.roots.pop();
        if (!root) break;
        if (root.codeOff) for (const { t } of this.w.planner.calls(root)) if (t && this.candidate(t) >= 0) this.queue.push(t);
      }
      if (!unit.length) return false;
      const group = this.w.tiers.compileUnit(this.w.slotOf(unit[0]), false, (cx) => ({ methods: unit, built: cx.buildUnit(unit) }))!;
      this.w.stats.ahead += unit.length;
      for (const at of group) this.unran.add(at);
      // what these call is likely next in turn, after what the methods that ran call
      this.roots.unshift(...unit);
    }
    return this.w.stats.ahead < AHEAD_MAX;
  }
  /** where the demand and the linked classes stand, for demandSince; then the linked classes' methods with code that have no code yet, how many were compiled ahead, and the call frontier's sizes */
  demandMark(): number[] {
    let uncompiled = 0;
    for (const [name, rt] of this.w.classes) for (const m of this.w.prog.get(name)?.methods ?? []) {
      if (!m.codeOff || m.flags & ACC.NATIVE) continue;
      const s = this.w.slots.peek(rt.slotBase + m.index);
      if ((!s || s.k === "method" && !s.done) && !this.w.aot?.holds(rt.slotBase + m.index)) uncompiled++;
    }
    // the methods without code that the methods with code call: every target of a call, and only a call's one target
    const frontier = this.markFrontier = new Set(), single = this.markSingle = new Set();
    for (const s of this.w.slots.made()) {
      if (s?.k !== "method" || !s.done || !s.m.codeOff) continue;
      for (const { t, targets } of this.w.planner.calls(s.m)) {
        for (const x of targets ?? (t ? [t] : [])) {
          const at = this.w.classes.get(x.cls);
          const xs = at && this.w.slots.peek(at.slotBase + x.index);
          if (x.codeOff && !(xs?.k === "method" && xs.done)) { frontier.add(x); if (x === t) single.add(x); }
        }
      }
    }
    return [this.w.demand.methods.size, this.w.classes.size, uncompiled, this.w.stats.ahead, frontier.size, single.size];
  }
  private markFrontier = new Set<MethodInfo>();
  private markSingle = new Set<MethodInfo>();
  /** the methods compiled on demand since `mark`, each with whether its class was linked by then and whether a method with code called it then (any target, the one target) */
  demandSince([methods, classes]: number[]): [string, boolean, boolean, boolean][] {
    const before = new Set<string>();
    for (const name of this.w.classes.keys()) { if (before.size >= classes) break; before.add(name); }
    return [...this.w.demand.methods].slice(methods).map((m) => [mid(m), before.has(m.cls), this.markFrontier.has(m), this.markSingle.has(m)]);
  }
}
