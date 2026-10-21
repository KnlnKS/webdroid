// The two tiers of compiled code. A method's first call compiles it, with what its first run calls, into a first-tier unit that counts calls and loop
// iterations; one that uses up its budget is compiled again with its busy callees copied in (`upgrade`), here or by a compile worker (`upgradeJob`,
// `adoptUnit`). Loose first-tier units are merged by a worker into one module, and the units merged away are dropped a batch at a time.
import { Compiler, type CallPlan } from "../compiler/j2w.ts";
import type { InlineFrame } from "../compiler/code.ts";
import type { MethodInfo } from "../compiler/program.ts";
import { COUNT_BASE, COUNT_SLOTS, THROWERS, throwerBody, wasmFrameNames, deepStack } from "../compiler/exc.ts";
import { mid, methodOf } from "../compiler/ids.ts";
import { definitionReady, initiatedType } from "./resolution.ts";
import { defaultLoop } from "./sched.ts";
import type { Slot } from "./slots.ts";
import type { LinkedUnit } from "./units.ts";
import type { UnitResult, UpgradeJob } from "./unit.ts";
import type { Built, Clock, World } from "./world.ts";

/** the engine charges a module some tens of KB of external memory however small, and external memory drives full collections: once MERGE_AT first-tier units
 *  are loose, a compile worker merges up to MERGE_MAX of their methods into one module */
const MERGE_AT = 1024, MERGE_MAX = 512;
/** A unit merged away is freed by the collection after nothing holds it, and freeing a module costs that collection's pause some 40 µs (the engine's
 *  second-pass weak callbacks free its native code): the thousands a launch's merges leave would stop the thread for 100-170 ms at once. They are dropped
 *  a batch at a time instead, the next once a collection has freed one of the last, or after RETIRE_WAIT_MS: RETIRE_BATCH while the app answers input,
 *  RETIRE_MAX otherwise, since units held until they are freed keep their external memory, which drives full collections */
const RETIRE_BATCH = 32, RETIRE_MAX = 512, RETIRE_WAIT_MS = 5000;
/** a small method without a loop asks LEAF_WAITS more budgets before it is compiled alone */
const LEAF_WAITS = 3;
/** a slot's tier state, by bit: second-tier code is in it, a compile worker has the second-tier compile of its method, and its method has asked for the
 *  second tier; from bit LEAF_SHIFT up, the budgets a leaf method has waited (at most LEAF_WAITS) */
const HOT = 1, PENDING = 2, REQUESTED = 4, LEAF_SHIFT = 3;
/** second-tier compiling may take at most this share of the time the program has been hot (since the first request for it), a compile being expected to need UPGRADE_MS
 *  (a mean of measured compiles would carry the first compile's warm-up of the compiler into every later decision) */
const UPGRADE_SHARE = 0.3, UPGRADE_MS = 1;

export class Tiering {
  private readonly w: World;
  /** the slots of the methods compiled in one unit, by slot: they call each other directly, so they are reset together. A merge compares a unit's list with
   *  the one its slots have now */
  private readonly groupOf = new Map<number, number[]>();
  /** each slot's tier state (HOT and the bits beside it), grown as slots are */
  private state = new Uint8Array(1 << 16);
  /** the methods refused a second-tier compile, longest waiting first, with how often */
  private refused = new Map<number, number>();
  /** when the second tier was first asked for, and the time spent compiling it since */
  private hotSince?: number;
  private upgradeMs = 0;
  /** the number the next unit's functions carry (Compiler.buildUnit) */
  private unitSeq = 0;
  /** first-tier units of methods (their slots) not merged yet, oldest first, and those of the merge on its way */
  private loose: number[][] = [];
  private merging: number[][] = [];
  private mergeAt = MERGE_AT;
  /** ensure() units whose class may still be initializing: their slot, class and the <clinit> slot compiled beside them (-1 if none) */
  private initializing: [number, string, number][] = [];
  private countView?: Int32Array;
  constructor(w: World) { this.w = w; }
  private is(slot: number, bits: number): boolean { return slot < this.state.length && (this.state[slot] & bits) !== 0; }
  private set(slot: number, bits: number): void {
    if (slot >= this.state.length) { const grown = new Uint8Array(Math.max(slot + 1, 2 * this.state.length)); grown.set(this.state); this.state = grown; }
    this.state[slot] |= bits;
  }
  private clear(slot: number, bits: number): void { if (slot < this.state.length) this.state[slot] &= ~bits; }
  /** whether second-tier code is in `slot` */
  hot(slot: number): boolean { return this.is(slot, HOT); }
  /** whether a compile worker has the second-tier compile of the method in `slot` */
  pending(slot: number): boolean { return this.is(slot, PENDING); }
  /** whether the method in `slot` has asked for the second tier, or runs it */
  asked(slot: number): boolean { return this.is(slot, HOT | REQUESTED); }
  /** host.link: compile what `slot` stands for and put it in the table. A method is compiled alone, cheaply, and counts its calls and loop
   *  iterations; `upgrade` recompiles the hot ones with their small callees. */
  linkSlot(slot: number): void {
    const s = this.w.slots.at(slot);
    if (!s || s.done) return;
    if (s.k === "ensure") { this.linkEnsure(slot); return; }
    if (s.k === "method" && this.w.aot?.provide(slot)) return;
    const group = this.compileUnit(slot, false, (cx) => {
      if (s.k !== "method") return { methods: [], built: s.k === "synth" ? cx.buildSynthetic(s.name, s.d!.params, (c) => s.d!.body(cx, c), s.d!.ret)
        : cx.buildSynthetic(s.name, THROWERS[s.name].params, (c) => throwerBody(cx, c, s.name)) };
      const batch = this.w.planner.batch(s.m);
      for (const m of batch) this.w.demand.methods.add(m);
      this.w.ahead.noteRun(batch);
      return { methods: batch, built: cx.buildUnit(batch) };
    })!;
    if (group.length && this.w.compiler) {
      this.loose.push(group);
      if (this.loose.length >= this.mergeAt) this.w.compiler.merge(this.w);
    }
  }
  private mergeable(g: number[]): boolean {
    return g.every((at) => { const s = this.w.slots.peek(at); return s?.k === "method" && s.done && !this.is(at, HOT | PENDING) && this.groupOf.get(at) === g; });
  }
  /** the oldest loose units, merged into one module by a compile worker; the merged code calls through the table, so each method can be reset alone */
  mergeJob(): UpgradeJob | undefined {
    this.loose.push(...this.merging.filter((g) => this.mergeable(g)));
    this.merging = [];
    if (this.loose.length < this.mergeAt) return undefined;
    const clock = this.w.units.clock(), groups: number[][] = [];
    let n = 0, size = 0;
    for (; n < this.loose.length && size < MERGE_MAX; n++) {
      const g = this.loose[n];
      if (this.mergeable(g)) { groups.push(g); size += g.length; }
    }
    this.loose.splice(0, n);
    const units = groups.map((g) => g.map((at) => this.w.slots.peekMethod(at)!.m)), refs = this.jobRefs(units), taken = new Set(refs.units);
    groups.forEach((g, i) => (taken.has(units[i]) ? this.merging : this.loose).push(g));
    this.w.units.account(clock);
    // what is not ready waits for more units to be linked
    if (!refs.units.length) { this.mergeAt = this.loose.length + MERGE_AT / 4; return undefined; }
    this.mergeAt = MERGE_AT;
    return this.job(refs.units.flat(), [], refs, new Map(), true);
  }
  /** ensure() of a class linked on demand, in one unit with its <clinit>, which only ensure() calls */
  private linkEnsure(slot: number): void {
    this.settleInits();
    const cls = this.w.slots.blockClass[this.w.slots.blockOf(slot)], ci = this.w.prog.require(cls).byKey.get("<clinit>()V");
    const at = ci && this.w.slotOf(ci), clinit = at === undefined ? undefined : this.w.slots.at(at);
    const methods = clinit?.k === "method" && !clinit.done && !this.w.aot?.provide(at!) ? [clinit.m] : [];
    this.compileUnit(slot, false, (cx) => ({ methods, built: cx.buildUnit(methods, { ensures: [cls] }) }));
    if (methods.length) this.w.demand.methods.add(methods[0]);
    this.initializing.push([slot, cls, methods.length ? at! : -1]);
  }
  /** Once a class is initialized its ensure() returns at once and its <clinit> is not called again: the slot gets the shared no-op, the <clinit> its stub,
   *  and the unit is retired */
  private settleInits(): void {
    const done: Function[] = [];
    this.initializing = this.initializing.filter(([slot, cls, at]) => {
      if (!this.w.initialized(cls)) return true;
      done.push(this.w.table.get(slot) as Function);
      this.w.table.set(slot, this.w.rt.nop);
      const s = at < 0 ? undefined : this.w.slots.at(at);
      if (s?.k === "method" && s.done) this.unlink(at, s);
      return false;
    });
    if (done.length) this.retire(done);
  }
  /** puts the lazy-link stub back for `slot` and for the methods compiled beside it, which call it directly */
  invalidate(slot: number): void {
    const w = this.w;
    if (w.helpers.invalidate(slot)) { w.stats.invalidated++; return; }
    for (const x of this.groupOf.get(slot) ?? [slot]) {
      // a slot without state holds compiled code only if a loaded build module installed it
      const s = w.slots.peek(x) ?? (w.aot?.installed(x) ? w.slots.at(x) : undefined);
      if (s?.k !== "ensure" && s?.done && this.unlink(x, s)) w.stats.invalidated++;
    }
  }
  /** puts the stub back in `slot`, which holds compiled code, and forgets the code's tier and unit; whether the slot has a stub to put back */
  private unlink(slot: number, s: Slot): boolean {
    if (!this.w.stubs.restoreStub(slot, s)) return false;
    s.done = false; this.clear(slot, HOT); this.groupOf.delete(slot);
    return true;
  }
  /** host.hot: the method in `slot` has used up its budget; compile it again with its small callees copied in and guarded calls */
  upgrade(slot: number): void {
    const s = this.w.slots.at(slot);
    if (s?.k !== "method" || !s.done || this.is(slot, HOT)) return;
    this.set(slot, REQUESTED);
    // a compile worker takes the job when there is one: the method keeps running its first-tier code until the unit arrives, and asks again if the unit is not taken
    const reset = () => { this.counts()[slot] = 0; };
    if (this.is(slot, PENDING)) { reset(); return; }
    // a small method without a loop is worth most copied into the units of the callers that run it in their loops: alone it waits a few budgets for them
    if (this.w.planner.leaf(s.m) && this.state[slot] >> LEAF_SHIFT < LEAF_WAITS) { this.state[slot] += 1 << LEAF_SHIFT; reset(); return; }
    if (this.w.opts.holdUpgrades?.() || this.offload(slot)) { reset(); return; }
    // the second tier is paid for out of the time the program runs: its compiling is kept to a share of it. A method that asks too soon waits in line and asks
    // again after another budget. The next compile the share allows goes to the outermost waiting method on the stack, whose unit can take in what it calls,
    // else to the one that has waited longest and asked again since, so it is still hot
    const t0 = performance.now();
    const wait = () => { this.refused.set(slot, (this.refused.get(slot) ?? 0) + 1); reset(); };
    if (!this.upgradeAllowed(t0)) { wait(); return; }
    let pick = this.outermostWaiting() ?? slot;
    if (pick === slot) for (const [w, n] of this.refused) {
      if (!this.waits(w)) { this.refused.delete(w); continue; }
      if (n >= 2) { pick = w; break; }
    }
    this.refused.delete(pick);
    if (pick !== slot) wait();
    this.compileHot(pick, this.w.slots.method(pick)!.m);
    this.upgradeMs += performance.now() - t0;
  }
  /** hands the second-tier compile of the method in `slot` to a compile worker; whether it was taken, or is to be asked for later */
  private offload(slot: number): boolean {
    const taken = this.w.compiler?.submit(this.w, slot);
    if (taken === true) this.set(slot, PENDING);
    return !!taken;
  }
  /** compiles and installs the second-tier unit of `m` in `slot` */
  private compileHot(slot: number, m: MethodInfo): void {
    this.compileUnit(slot, true, (cx, seq) => {
      const { installed, copies, plan } = this.w.planner.group(m);
      return { methods: installed, copies: copies.length, built: cx.buildUnit(installed, { copies, hot: true, plan, seq }) };
    });
    this.w.stats.upgrades++;
  }
  /** compiles a unit with `build`, which names the methods it installs (none for a runtime function or a class's ensure()), and installs it: its functions go
   *  in their slots, or in `slot`; first-tier units share helpers. The slots it installed. */
  compileUnit(slot: number, hot: boolean, build: (cx: Compiler, seq: number) => { methods: MethodInfo[]; copies?: number; built: Built }): number[] {
    const clock = this.w.units.clock(), cx = new Compiler(this.w);
    if (!hot) cx.shareHelpers();
    const { methods, copies = 0, built } = build(cx, this.unitSeq++);
    this.w.stats.units++; this.w.stats.methods += methods.length + copies;
    const group = methods.map((m) => this.w.slotOf(m));
    this.install(group, hot, this.w.units.compiled(cx, this.w.units.of(cx), built, slot), slot, clock);
    return group;
  }
  private upgradeAllowed(now: number): boolean {
    this.hotSince ??= now;
    return this.upgradeMs + UPGRADE_MS <= UPGRADE_SHARE * (now - this.hotSince);
  }
  /** the outermost Java frame of the running stack whose method waits for the second tier (V8 names Wasm frames by function, which are named by method id) */
  private outermostWaiting(): number | undefined {
    if (!this.refused.size) return undefined;
    let found: number | undefined;
    for (const name of wasmFrameNames(deepStack().stack ?? "")) {
      const m = methodOf(this.w.prog, name.replace(/^\$dispatch:/, "").split("#")[0]), slot = m && this.w.slotOf(m);
      if (slot !== undefined && this.refused.has(slot) && this.waits(slot)) found = slot;
    }
    return found;
  }
  /** whether the method in `slot` runs first-tier code and no second-tier unit for it is on its way */
  private waits(slot: number): boolean { const s = this.w.slots.at(slot); return s?.k === "method" && s.done && !this.is(slot, HOT | PENDING); }
  /** the second-tier compile of the method in `slot` as a job for a compile worker: what it needs from this World's state, which only this World has */
  upgradeJob(slot: number): UpgradeJob | undefined {
    const s = this.w.slots.at(slot);
    if (s?.k !== "method" || !s.done || this.is(slot, HOT)) return undefined;
    const clock = this.w.units.clock(), { installed, copies, plan } = this.w.planner.group(s.m);
    const refs = this.jobRefs([[...installed, ...copies]]);
    this.w.units.account(clock);
    return refs.units.length ? this.job(installed, copies, refs, plan) : undefined;
  }
  private job(installed: MethodInfo[], copies: MethodInfo[], refs: Pick<UpgradeJob, "resolved" | "prepared">, plan: CallPlan, merge?: boolean): UpgradeJob {
    this.w.stats.units++;
    return { merge, resolved: refs.resolved, prepared: refs.prepared, unit: this.unitSeq++, installed: installed.map(mid), copies: copies.map(mid), plan: [...plan].map(([key, ms]) => [key, ms.map(mid)]), long: [...installed, ...copies].map(mid).filter((id) => this.w.longLoops.has(id)) };
  }
  /** what a compile worker must be told of this World's class loading to compile `units` as it would: the initiating identities their code resolves, and the
   *  hierarchies of those classes. A unit that reaches a class whose definition is not ready is left out */
  private jobRefs(units: MethodInfo[][]): { units: MethodInfo[][]; resolved: [string, string, string][]; prepared: [string, string | null, string[]][] } {
    const resolved: [string, string, string][] = [], prepared: [string, string | null, string[]][] = [];
    const seen = new Map<string, Set<string>>(), hierarchies = new Set<string>(), ready = new Map<string, boolean>();
    const own = (key: string) => { const cls = this.w.prog.get(key)!; return !!cls.dex && !!cls.def && this.w.prog.loaderOf(key) !== this.w.prog.boot; };
    const isReady = (key: string): boolean => {
      let r = ready.get(key);
      if (r === undefined) {
        ready.set(key, true);
        const cls = this.w.prog.get(key);
        r = !!cls && definitionReady(this.w, key) && (!own(key) || [...cls.sup ? [cls.sup] : [], ...cls.ifaces].every(isReady));
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
      const cls = this.w.prog.get(key)!;
      prepared.push([key, cls.sup, [...cls.ifaces]]);
      if (!own(key)) return;
      const indices = [...cls.def!.superIdx === 0xffffffff ? [] : [cls.def!.superIdx], ...cls.def!.interfaces];
      const targets = [...cls.sup ? [cls.sup] : [], ...cls.ifaces];
      indices.forEach((index, i) => resolve(key, cls.dex!.rawTypeName(index), targets[i]));
    };
    const owners = (m: MethodInfo) => !m.codeOff || this.w.intrinsic(m) ? [] : this.w.planner.planning(m).references.flatMap((name) => initiatedType(this.w, m.cls, name) ?? []);
    const taken: MethodInfo[][] = [];
    for (const u of units) {
      const os = u.map(owners);
      if (!os.every((o) => o.every((x) => isReady(x.key)))) continue;
      taken.push(u);
      u.forEach((m, i) => os[i].forEach((o) => resolve(m.cls, o.name, o.key)));
    }
    return { units: taken, resolved, prepared };
  }
  /** the second-tier compile of the method in `slot` will not come: it may ask for it again, or be compiled inline */
  release(slot: number): void { this.clear(slot, PENDING); }
  /** installs the second-tier unit a compile worker made for `slot`, if it is still sound here (Tiering.received) */
  adoptUnit(slot: number, job: UpgradeJob, result: UnitResult, epoch: number): boolean {
    if (job.merge) return this.adoptMerged(job, result, epoch);
    const s = this.w.slots.at(slot), clock = this.w.units.clock();
    this.release(slot);
    if (s?.k !== "method" || !s.done || this.is(slot, HOT)) return false;
    const u = this.received(result, epoch);
    if (!u || !this.install(job.installed.map((id) => this.w.slotOf(methodOf(this.w.prog, id)!)), true, u, slot, clock)) return false;
    this.w.stats.methods += job.installed.length + job.copies.length; this.w.stats.upgrades++;
    return true;
  }
  /** a worker's unit, if it was made for this World as it is (nothing was added to the Program since `epoch`, its natives are bound here) and the numbering its code
   *  relies on follows this World's (it was numbered from `result.numbering.from`), which takes it */
  private received(result: UnitResult, epoch: number): LinkedUnit | undefined {
    const head = result.header, n = result.numbering;
    if (!this.w.units.admits(head, epoch)) return undefined;
    if ((n.names.length || n.tail.length || n.selectors.length || n.gaps.length || n.links.length) && !this.w.adopt(n)) return undefined;
    const traces = result.traces.map((t) => ({ name: t.name, m: t.m ? methodOf(this.w.prog, t.m) : undefined, offsets: t.offsets, pcs: t.pcs,
      inline: t.inline?.map(([m, pc, at]): InlineFrame => [methodOf(this.w.prog, m)!, pc, at]) }));
    return { head, module: result.module, traces };
  }
  /** installs merged first-tier code in the slots of the units it was merged from that still hold them; the others keep what they have */
  private adoptMerged(job: UpgradeJob, result: UnitResult, epoch: number): boolean {
    const groups = this.merging, clock = this.w.units.clock();
    this.merging = [];
    const u = this.received(result, epoch), liveGroups = groups.filter((g) => this.mergeable(g));
    if (!u) { this.loose.push(...liveGroups); return false; }
    const live = liveGroups.flat(), merged = new Set(live);
    if (!live.length) return true;
    // one function of each unit holds its instance, and so its module
    const units = liveGroups.map((g) => this.w.table.get(g[0]) as Function);
    const kept = job.installed.map((id) => this.w.slotOf(methodOf(this.w.prog, id)!)).filter((at) => !merged.has(at)).map((at) => [at, this.w.table.get(at)] as const);
    const placed = this.w.units.link(u, () => {
      for (const [at, f] of kept) this.w.table.set(at, f);
      for (const at of live) this.groupOf.set(at, [at]);
      return true;
    }, clock);
    if (!placed) { this.loose.push(...liveGroups); return false; }
    this.retire(units);
    this.w.stats.merged += live.length;
    return true;
  }
  private retired: Function[] = [];
  private retiring = false;
  private retiredCollected = new FinalizationRegistry<number>((batch) => { this.w.stats.collected++; if (batch === this.retireBatch) this.dropRetired(); });
  private retireBatch = 0;
  private retire(units: Function[]): void {
    this.retired.push(...units);
    if (!this.retiring) this.dropRetired();
  }
  private dropRetired(): void {
    const batch = this.retired.splice(0, this.w.opts.answering?.() ? RETIRE_BATCH : RETIRE_MAX), id = ++this.retireBatch;
    this.retiring = batch.length > 0;
    if (!batch.length) return;
    for (const f of batch) this.retiredCollected.register(f, id);
    this.w.stats.retired += batch.length;
    (this.w.opts.loop ?? defaultLoop).after(RETIRE_WAIT_MS, () => { if (this.retireBatch === id) this.dropRetired(); });
  }
  /** installs unit `u`, putting its functions (`group`, by slot) in the table; a slot already compiled keeps its original stub. Whether it was installed (Units.link) */
  install(group: number[], hot: boolean, u: LinkedUnit, slot: number, clock: Clock): boolean {
    const s = this.w.slots.at(slot)!;
    const place = (exports: Record<string, any>) => {
      const set = (at: number, name: string) => {
        this.w.slots.at(at)!.done = true;
        this.w.table.set(at, exports[name]);
      };
      if (s.k !== "method" && s.k !== "ensure") { set(slot, "m"); return true; }
      for (const x of group) { set(x, "m" + x); this.groupOf.set(x, group); if (hot) this.set(x, HOT); else this.clear(x, HOT); if (x < COUNT_SLOTS) this.counts()[x] = 0; }
      if (s.k === "ensure") { s.done = true; this.w.table.set(slot, exports["m" + slot]); }
      return true;
    };
    try { return !!this.w.units.link(u, place, clock); } catch (e) { throw new Error(`linking ${s.k === "method" ? mid(s.m) : s.k === "ensure" ? s.k : s.name}: ${(e as Error).message}`); }
  }
  /** calls and loop iterations counted so far for the method in `slot` */
  count(slot: number): number { return slot < COUNT_SLOTS ? this.counts()[slot] : 0; }
  /** the call and loop counters, a view kept until the memory grows */
  counts(): Int32Array {
    if (this.countView?.buffer !== this.w.mem.buffer) this.countView = new Int32Array(this.w.mem.buffer, COUNT_BASE, COUNT_SLOTS);
    return this.countView;
  }
  /** the slots whose code a unit installed */
  unitSlots(): IterableIterator<number> { return this.groupOf.keys(); }
}
