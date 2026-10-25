// Loose first-tier units merged into one module by a compile worker, and the modules of units no longer used (merged away, or an ensure() whose class is
// initialized) dropped a batch at a time.
import { methodOf } from "../compiler/program.ts";
import { FIRST, PENDING } from "./slots.ts";
import { defaultLoop } from "./sched.ts";
import type { UnitJob, UnitResult } from "./unit.ts";
import type { World } from "./world.ts";

/** the engine charges a module some tens of KB of external memory however small, and external memory drives full collections: once MERGE_AT first-tier units
 *  are loose, a compile worker merges up to MERGE_MAX of their methods into one module */
const MERGE_AT = 1024, MERGE_MAX = 512;
/** A unit merged away is freed by the collection after nothing holds it, and freeing a module costs that collection's pause some 40 µs (the engine's
 *  second-pass weak callbacks free its native code): the thousands a launch's merges leave would stop the thread for 100-170 ms at once. They are dropped
 *  a batch at a time instead, the next once a collection has freed one of the last, or after RETIRE_WAIT_MS: RETIRE_BATCH while the app answers input,
 *  RETIRE_MAX otherwise, since units held until they are freed keep their external memory, which drives full collections */
const RETIRE_BATCH = 32, RETIRE_MAX = 512, RETIRE_WAIT_MS = 5000;

export class Merges {
  private readonly w: World;
  /** first-tier units of methods (their slots) not merged yet, oldest first, and those of the merge on its way */
  private loose: number[][] = [];
  private merging: number[][] = [];
  private mergeAt = MERGE_AT;
  constructor(w: World) { this.w = w; }
  /** a first-tier unit (its slots) was installed: merged with others once enough are loose */
  loosen(group: number[]): void {
    const compiler = this.w.compiler;
    if (!compiler) return;
    this.loose.push(group);
    if (this.loose.length >= this.mergeAt) compiler.merge(this.w);
  }
  /** whether a unit still holds the first-tier code of every one of its slots, and no second-tier unit is on its way for one */
  private mergeable(g: number[]): boolean { const slots = this.w.slots; return g.every((at) => slots.is(at, FIRST) && !slots.any(at, PENDING) && slots.group(at) === g); }
  /** the oldest loose units, merged into one module by a compile worker; the merged code calls through the table, so each method can be reset alone */
  job(): UnitJob | undefined {
    this.loose.push(...this.merging.filter((g) => this.mergeable(g)));
    this.merging = [];
    if (this.loose.length < this.mergeAt) return undefined;
    const w = this.w, clock = w.units.clock(), groups: number[][] = [];
    let n = 0, size = 0;
    for (; n < this.loose.length && size < MERGE_MAX; n++) {
      const g = this.loose[n];
      if (this.mergeable(g)) { groups.push(g); size += g.length; }
    }
    this.loose.splice(0, n);
    const units = groups.map((g) => g.map((at) => w.slots.methodAt(at)!)), made = w.tiers.job("merge", units), taken = new Set(made?.units);
    groups.forEach((g, i) => (taken.has(units[i]) ? this.merging : this.loose).push(g));
    w.units.account(clock);
    // what is not ready waits for more units to be linked
    if (!made) { this.mergeAt = this.loose.length + MERGE_AT / 4; return undefined; }
    this.mergeAt = MERGE_AT;
    return made.job;
  }
  /** installs merged first-tier code in the slots of the units it was merged from that still hold them; the others keep what they have */
  adopt(job: UnitJob, result: UnitResult, epoch: number): boolean {
    const w = this.w, groups = this.merging, clock = w.units.clock();
    this.merging = [];
    const u = w.tiers.received(result, epoch), liveGroups = groups.filter((g) => this.mergeable(g));
    if (!u) { this.loose.push(...liveGroups); return false; }
    const live = liveGroups.flat(), merged = new Set(live);
    if (!live.length) return true;
    // one function of each unit holds its instance, and so its module
    const units = liveGroups.map((g) => w.table.get(g[0]) as Function);
    const kept = job.installed.map((id) => w.slotOf(methodOf(w.prog, id)!)).filter((at) => !merged.has(at)).map((at) => [at, w.table.get(at)] as const);
    const placed = w.units.link(u, () => {
      for (const [at, f] of kept) w.table.set(at, f);
      for (const at of live) w.slots.install(at, w.table.get(at), false, [at]);
      return true;
    }, clock);
    if (!placed) { this.loose.push(...liveGroups); return false; }
    this.retire(units);
    w.stats.merged += live.length;
    return true;
  }

  private retired: Function[] = [];
  private retiring = false;
  private retiredCollected = new FinalizationRegistry<number>((batch) => { this.w.stats.collected++; if (batch === this.retireBatch) this.dropRetired(); });
  private retireBatch = 0;
  private cancelRetire = () => {};
  /** functions that each hold the module of a unit no longer used: dropped a batch at a time */
  retire(units: Function[]): void {
    this.retired.push(...units);
    if (!this.retiring) this.dropRetired();
  }
  private dropRetired(): void {
    const w = this.w, batch = this.retired.splice(0, w.opts.answering?.() ? RETIRE_BATCH : RETIRE_MAX), id = ++this.retireBatch;
    this.retiring = batch.length > 0;
    if (!batch.length) return;
    for (const f of batch) this.retiredCollected.register(f, id);
    w.stats.retired += batch.length;
    this.cancelRetire = (w.opts.loop ?? defaultLoop).after(RETIRE_WAIT_MS, () => { if (this.retireBatch === id) this.dropRetired(); });
  }
  /** stops waiting on retired code (World.close), whose timer would hold the World */
  close(): void { this.retired.length = 0; this.cancelRetire(); }
}
