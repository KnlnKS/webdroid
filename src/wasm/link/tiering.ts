// The first tier: a method's first call compiles it, with what its first run calls, into a unit that counts calls and loop iterations. A unit is installed
// here whether it was compiled here or by a compile worker (adopt): the second tier of a busy method (upgrades.ts) and loose first-tier units merged into one
// module (merges.ts) are compiled from the jobs this file describes.
import { Compiler } from "../compiler/j2w.ts";
import type { InlineFrame } from "../compiler/code.ts";
import type { CallPlan } from "../compiler/j2w.ts";
import type { MethodInfo } from "../compiler/program.ts";
import { THROWERS, throwerBody } from "../compiler/exc.ts";
import { mid, methodOf } from "../compiler/program.ts";
import { COUNT_SLOTS } from "../compiler/consts.ts";
import { definitionReady, initiatedType } from "./resolution.ts";
import type { LinkedUnit } from "./units.ts";
import type { UnitJob, UnitResult } from "./unit.ts";
import type { Built, Clock, World } from "./world.ts";

export class Tiering {
  private readonly w: World;
  /** ensure() units whose class may still be initializing: their slot, class and the <clinit> slot compiled beside them (-1 if none) */
  private initializing: [number, string, number][] = [];
  /** the number the next unit's functions carry (Compiler.buildUnit) */
  private unitSeq = 0;
  constructor(w: World) { this.w = w; }
  /** host.link: puts the code of what `slot` stands for in it, a build's if it has it, else compiled here. A method is compiled with the methods its first run
   *  calls (Planner.batch) into a unit of its own */
  linkSlot(slot: number): void {
    const w = this.w, s = w.slots.at(slot);
    if (!s || w.slots.compiled(slot)) return;
    if (s.k === "ensure") { this.linkEnsure(slot); return; }
    if (s.k === "method" && w.aot?.provide(slot)) return;
    const group = this.compileUnit(slot, false, (cx) => {
      if (s.k === "synth") return { methods: [], built: cx.buildSynthetic(s.name, s.d.params, (c) => s.d.body(cx, c), s.d.ret) };
      if (s.k === "thrower") return { methods: [], built: cx.buildSynthetic(s.name, THROWERS[s.name].params, (c) => throwerBody(cx, c, s.name)) };
      const batch = w.planner.batch(s.m);
      for (const m of batch) w.demand.methods.add(m);
      w.ahead.noteRun(batch);
      return { methods: batch, built: cx.buildUnit(batch) };
    });
    if (group.length) w.merges.loosen(group);
  }
  /** ensure() of a class linked on demand, in one unit with its <clinit> unless a build has that, which only ensure() calls */
  private linkEnsure(slot: number): void {
    this.settleInits();
    const w = this.w, cls = w.slots.blockClass[w.slots.blockOf(slot)], ci = w.prog.require(cls).byKey.get("<clinit>()V");
    const at = ci ? w.slotOf(ci) : -1, methods = ci && !w.slots.compiled(at) && !w.aot?.provide(at) ? [ci] : [];
    this.compileUnit(slot, false, (cx) => ({ methods, built: cx.buildUnit(methods, { ensures: [cls] }) }));
    if (methods.length) w.demand.methods.add(methods[0]);
    this.initializing.push([slot, cls, methods.length ? at : -1]);
  }
  /** Once a class is initialized its ensure() returns at once and its <clinit> is not called again: the slot gets the shared no-op, the <clinit> its stub,
   *  and the unit is retired */
  private settleInits(): void {
    const w = this.w, done: Function[] = [];
    this.initializing = this.initializing.filter(([slot, cls, at]) => {
      if (!w.initialized(cls)) return true;
      done.push(w.table.get(slot) as Function);
      w.slots.install(slot, w.rt.nop, false);
      if (at >= 0 && w.slots.compiled(at)) w.slots.unlink(at);
      return false;
    });
    if (done.length) w.merges.retire(done);
  }
  /** puts the lazy-link stub back for `slot` and for the methods compiled beside it, which call it directly */
  invalidate(slot: number): void {
    const slots = this.w.slots;
    for (const x of slots.group(slot) ?? [slot]) if (slots.compiled(x) && slots.unlink(x)) this.w.stats.invalidated++;
  }
  /** compiles a unit with `build`, which names the methods it installs (none for a runtime function or a class's ensure()), and installs it: its functions go
   *  in their slots, or in `slot`; first-tier units share helpers. The slots it installed. */
  compileUnit(slot: number, hot: boolean, build: (cx: Compiler) => { methods: MethodInfo[]; copies?: number; built: Built }): number[] {
    const w = this.w, clock = w.units.clock(), cx = new Compiler(w, this.unitSeq++);
    if (!hot) cx.shareHelpers();
    const { methods, copies = 0, built } = build(cx);
    w.stats.units++; w.stats.methods += methods.length + copies;
    const group = methods.map((m) => w.slotOf(m));
    this.install(group, hot, w.units.compiled(cx, w.units.of(cx), built, slot), slot, clock);
    return group;
  }
  /** installs unit `u`, putting its functions (`group`, by slot) in the table, or its one function in `slot`. Whether it was installed (Units.link) */
  install(group: number[], hot: boolean, u: LinkedUnit, slot: number, clock: Clock): boolean {
    const slots = this.w.slots, s = slots.at(slot)!;
    const place = (exports: Record<string, unknown>) => {
      if (s.k === "synth" || s.k === "thrower") { slots.install(slot, exports.m, false); return true; }
      const counts = slots.counts();
      for (const x of group) { slots.install(x, exports["m" + x], hot, group); if (x < COUNT_SLOTS) counts[x] = 0; }
      if (s.k === "ensure") slots.install(slot, exports["m" + slot], false);
      return true;
    };
    try { return !!this.w.units.link(u, place, clock); } catch (e) { throw new Error(`linking ${s.k === "method" ? mid(s.m) : s.k === "ensure" ? s.k : s.name}: ${(e as Error).message}`); }
  }

  // ---------- units compiled by a worker
  /** the job of compiling `units` (each a list of methods it installs, the first asked for) in a compile worker, with `copies` copied in: what it needs from this
   *  World's state, which only this World has. A unit that reaches a class whose definition is not ready is left out; undefined if none is left */
  job(kind: UnitJob["kind"], units: MethodInfo[][], copies: MethodInfo[] = [], plan: CallPlan = new Map()): { job: UnitJob; units: MethodInfo[][] } | undefined {
    const w = this.w, refs = this.refs(copies.length ? [[...units[0], ...copies]] : units);
    if (!refs.units.length) return undefined;
    w.stats.units++;
    const taken = copies.length ? units : refs.units, installed = taken.flat();
    return { units: taken, job: { kind, unit: this.unitSeq++, resolved: refs.resolved, prepared: refs.prepared, installed: installed.map(mid), copies: copies.map(mid),
      plan: [...plan].map(([key, ms]) => [key, ms.map(mid)]), long: [...installed, ...copies].map(mid).filter((id) => w.longLoops.has(id)) } };
  }
  /** what a compile worker must be told of this World's class loading to compile `units` as it would: the initiating identities their code resolves, and the
   *  hierarchies of those classes */
  private refs(units: MethodInfo[][]): { units: MethodInfo[][]; resolved: UnitJob["resolved"]; prepared: UnitJob["prepared"] } {
    const w = this.w, prog = w.prog, resolved: UnitJob["resolved"] = [], prepared: UnitJob["prepared"] = [];
    const seen = new Map<string, Set<string>>(), hierarchies = new Set<string>(), ready = new Map<string, boolean>();
    const own = (key: string) => { const cls = prog.get(key)!; return !!cls.dex && !!cls.def && prog.loaderOf(key) !== prog.boot; };
    const isReady = (key: string): boolean => {
      let r = ready.get(key);
      if (r === undefined) {
        ready.set(key, true);
        const cls = prog.get(key);
        r = !!cls && definitionReady(w, key) && (!own(key) || [...cls.sup ? [cls.sup] : [], ...cls.ifaces].every(isReady));
        ready.set(key, r);
      }
      return r;
    };
    const resolve = (referrer: string, name: string, key: string) => {
      const names = seen.get(referrer) ?? seen.set(referrer, new Set()).get(referrer)!;
      if (names.has(name)) return;
      names.add(name); resolved.push([referrer, name, key]);
      if (hierarchies.has(key)) return;
      hierarchies.add(key);
      const cls = prog.get(key)!;
      prepared.push([key, cls.sup, [...cls.ifaces]]);
      if (!own(key)) return;
      const indices = [...cls.def!.superIdx === 0xffffffff ? [] : [cls.def!.superIdx], ...cls.def!.interfaces];
      const targets = [...cls.sup ? [cls.sup] : [], ...cls.ifaces];
      indices.forEach((index, i) => resolve(key, cls.dex!.rawTypeName(index), targets[i]));
    };
    const owners = (m: MethodInfo) => !m.codeOff || w.intrinsic(m) ? [] : w.planner.planning(m).references.flatMap((name) => initiatedType(w, m.cls, name) ?? []);
    const taken: MethodInfo[][] = [];
    for (const u of units) {
      const os = u.map(owners);
      if (!os.every((o) => o.every((x) => isReady(x.key)))) continue;
      taken.push(u);
      u.forEach((m, i) => os[i].forEach((o) => resolve(m.cls, o.name, o.key)));
    }
    return { units: taken, resolved, prepared };
  }
  /** installs the unit a compile worker made for `job` (Upgrades.adopt, Merges.adopt), if it is still sound here */
  adopt(slot: number, job: UnitJob, result: UnitResult, epoch: number): boolean {
    return job.kind === "merge" ? this.w.merges.adopt(job, result, epoch) : this.w.upgrades.adopt(slot, job, result, epoch);
  }
  /** a worker's unit, if it was made for this World as it is (nothing was added to the Program since `epoch`, its natives are bound here) and the numbering its code
   *  relies on follows this World's (it was numbered from `result.numbering.from`), which takes it */
  received(result: UnitResult, epoch: number): LinkedUnit | undefined {
    const w = this.w, head = result.header, n = result.numbering;
    if (!w.units.admits(head, epoch)) return undefined;
    if ((n.names.length || n.tail.length || n.selectors.length || n.gaps.length || n.links.length) && !w.adopt(n)) return undefined;
    const traces = result.traces.map((t) => ({ name: t.name, m: t.m ? methodOf(w.prog, t.m) : undefined, offsets: t.offsets, pcs: t.pcs,
      inline: t.inline?.map(([m, pc, at]): InlineFrame => [methodOf(w.prog, m)!, pc, at]) }));
    return { head, module: result.module, traces };
  }
}
