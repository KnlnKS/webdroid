// The second tier: a first-tier method that uses up its budget (host.hot) is compiled again with its busy callees copied in and guarded calls, by a compile
// worker when there is one (job, adopt), else here within a share of the time the program runs.
import type { MethodInfo } from "../compiler/program.ts";
import { methodOf } from "../compiler/program.ts";
import { FIRST, HOT, PENDING } from "./slots.ts";
import type { UnitJob, UnitResult } from "./unit.ts";
import type { World } from "./world.ts";

/** a small method without a loop asks LEAF_WAITS more budgets before it is compiled alone */
const LEAF_WAITS = 3;
/** second-tier compiling may take at most this share of the time the program has been hot (since the first request for it), a compile being expected to need UPGRADE_MS
 *  (a mean of measured compiles would carry the first compile's warm-up of the compiler into every later decision) */
const UPGRADE_SHARE = 0.3, UPGRADE_MS = 1;
/** what a method has asked of the second tier, by bit: it asked for it; from bit 1 up, the budgets a leaf method has waited (at most LEAF_WAITS) */
const REQUESTED = 1, LEAF_SHIFT = 1;

export class Upgrades {
  private readonly w: World;
  private asks = new Uint8Array(1 << 16);
  /** the methods refused a second-tier compile, longest waiting first, with how often */
  private refused = new Map<number, number>();
  /** when the second tier was first asked for, and the time spent compiling it since */
  private hotSince?: number;
  private upgradeMs = 0;
  constructor(w: World) { this.w = w; }
  /** whether the method in `slot` has asked for the second tier, or runs it */
  asked(slot: number): boolean { return slot < this.asks.length && (this.asks[slot] & REQUESTED) !== 0 || this.w.slots.any(slot, HOT); }
  /** host.hot: the method in `slot` has used up its budget; compile it again with its small callees copied in and guarded calls */
  upgrade(slot: number): void {
    const w = this.w, m = w.slots.methodAt(slot);
    if (!m || !w.slots.is(slot, FIRST)) return;
    if (slot >= this.asks.length) { const grown = new Uint8Array(Math.max(slot + 1, 2 * this.asks.length)); grown.set(this.asks); this.asks = grown; }
    this.asks[slot] |= REQUESTED;
    // a compile worker takes the job when there is one: the method keeps running its first-tier code until the unit arrives, and asks again if the unit is not taken
    const reset = () => { w.slots.counts()[slot] = 0; };
    if (w.slots.any(slot, PENDING)) { reset(); return; }
    // a small method without a loop is worth most copied into the units of the callers that run it in their loops: alone it waits a few budgets for them
    if (w.planner.leaf(m) && this.asks[slot] >> LEAF_SHIFT < LEAF_WAITS) { this.asks[slot] += 1 << LEAF_SHIFT; reset(); return; }
    if (w.opts.holdUpgrades?.() || this.offload(slot)) { reset(); return; }
    // the second tier is paid for out of the time the program runs: its compiling is kept to a share of it. A method that asks too soon waits in line and asks
    // again after another budget. The next compile the share allows goes to the outermost waiting method on the stack, whose unit can take in what it calls,
    // else to the one that has waited longest and asked again since, so it is still hot
    const t0 = performance.now();
    const wait = () => { this.refused.set(slot, (this.refused.get(slot) ?? 0) + 1); reset(); };
    if (!this.allowed(t0)) { wait(); return; }
    let pick = this.outermostWaiting() ?? slot;
    if (pick === slot) for (const [at, n] of this.refused) {
      if (!this.waits(at)) { this.refused.delete(at); continue; }
      if (n >= 2) { pick = at; break; }
    }
    this.refused.delete(pick);
    if (pick !== slot) wait();
    this.compile(pick, w.slots.methodAt(pick)!);
    this.upgradeMs += performance.now() - t0;
  }
  /** hands the second-tier compile of the method in `slot` to a compile worker; whether it was taken, or is to be asked for later */
  private offload(slot: number): boolean {
    const taken = this.w.compiler?.submit(this.w, slot);
    if (taken === true) this.w.slots.pending(slot, true);
    return !!taken;
  }
  /** the second-tier compile of the method in `slot` will not come: it may ask for it again, or be compiled inline */
  release(slot: number): void { this.w.slots.pending(slot, false); }
  /** compiles and installs the second-tier unit of `m` in `slot` */
  private compile(slot: number, m: MethodInfo): void {
    this.w.tiers.compileUnit(slot, true, (cx) => {
      const { installed, copies, plan } = this.w.planner.group(m);
      return { methods: installed, copies: copies.length, built: cx.buildUnit(installed, { copies, hot: true, plan }) };
    });
    this.w.stats.upgrades++;
  }
  private allowed(now: number): boolean {
    this.hotSince ??= now;
    return this.upgradeMs + UPGRADE_MS <= UPGRADE_SHARE * (now - this.hotSince);
  }
  /** the outermost Java frame of the running stack whose method waits for the second tier */
  private outermostWaiting(): number | undefined {
    if (!this.refused.size) return undefined;
    let found: number | undefined;
    for (const m of this.w.stacks.methodsOnStack()) { const slot = this.w.slotOf(m); if (this.refused.has(slot) && this.waits(slot)) found = slot; }
    return found;
  }
  /** whether the method in `slot` runs first-tier code and no second-tier unit for it is on its way */
  private waits(slot: number): boolean { return this.w.slots.is(slot, FIRST) && !this.w.slots.any(slot, PENDING); }
  /** the second-tier compile of the method in `slot` as a job for a compile worker (Tiering.job), unless it runs no first-tier code */
  job(slot: number): UnitJob | undefined {
    const w = this.w, m = w.slots.methodAt(slot);
    if (!m || !w.slots.is(slot, FIRST)) return undefined;
    const clock = w.units.clock(), { installed, copies, plan } = w.planner.group(m), made = w.tiers.job("upgrade", [installed], copies, plan);
    w.units.account(clock);
    return made?.job;
  }
  /** installs the second-tier unit a compile worker made for `slot`, if it is still sound here (Tiering.received) */
  adopt(slot: number, job: UnitJob, result: UnitResult, epoch: number): boolean {
    const w = this.w, clock = w.units.clock();
    this.release(slot);
    if (!w.slots.methodAt(slot) || !w.slots.is(slot, FIRST)) return false;
    const u = w.tiers.received(result, epoch);
    if (!u || !w.tiers.install(job.installed.map((id) => w.slotOf(methodOf(w.prog, id)!)), true, u, slot, clock)) return false;
    w.stats.methods += job.installed.length + job.copies.length; w.stats.upgrades++;
    return true;
  }
}
