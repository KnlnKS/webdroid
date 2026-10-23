// Optimizing busy first-tier code in idle time. The engine runs a Wasm function as baseline code until it has charged the function's tiering budget, its
// size at each return and loop back-edge: a method of an interaction's flat code that runs some hundreds of times stays baseline code for the launch,
// at a third to a half of its optimized speed. The optimizing compile inlines from the call counts the baseline code recorded, which only the method's
// real calls give it. Once a method has run enough calls for those, the burner calls it with the warm word set (Compiler.emitWarmExit): each call
// returns at once through the end of its function, charging the whole function, so the engine optimizes it on a background thread with the feedback
// of its real calls. Nothing of the method runs.
import { COUNT_SLOTS, WARM_AT } from "../compiler/consts.ts";
import { methodKinds } from "../compiler/program.ts";
import type { World } from "./world.ts";

/** the calls and loop iterations a method has run before its feedback is worth optimizing with: an inlined call's count must outweigh its callee's size */
const BURN_AT = 64;
/** the calls that charge the default budget (13,000,000) for a function of 400 bytes of baseline code; larger ones need fewer, and smaller ones are worth
 *  most inlined into their callers. A call costs some nanoseconds */
const BURN_CALLS = 1 << 15;
/** calls between looks at the clock */
const BURN_CHUNK = 4096;

type Zero = 0 | 0n | null;

export class Burner {
  private readonly w: World;
  /** slots burned, so that each is burned once for the code in it */
  private readonly burned = new Set<number>();
  /** slots to burn, the next last, and the calls the first still needs */
  private queue: number[] = [];
  private left = 0;
  /** stops burning for the rest of the process: a call that did not return at once means code without the warm exit */
  private failed = false;
  constructor(w: World) { this.w = w; }
  /** whether `slot` holds first-tier code of a method, which has the warm exit */
  private burnable(slot: number): boolean {
    const s = this.w.slots.peekMethod(slot) ?? (this.w.aot?.installed(slot) ? this.w.slots.method(slot) : undefined);
    return !!s?.done && !this.w.tiers.hot(slot);
  }
  /** the first-tier methods that have run BURN_AT calls or asked for the second tier, busiest first */
  private scan(): number[] {
    const counts = this.w.tiers.counts(), n = Math.min(COUNT_SLOTS, this.w.slots.made().length, this.w.table.length), found: number[] = [];
    for (let slot = 0; slot < n; slot++) {
      if ((counts[slot] >= BURN_AT || this.w.tiers.asked(slot)) && !this.burned.has(slot) && this.burnable(slot)) found.push(slot);
    }
    return found.sort((a, b) => counts[a] - counts[b]);
  }
  /** Idle time: burns the busy first-tier methods until `until`. Whether any is left. */
  burn(until: number): boolean {
    if (this.failed || !this.w.instantiates) return false;
    if (!this.queue.length) { this.queue = this.scan(); this.left = BURN_CALLS; }
    const warm = new Int32Array(this.w.mem.buffer, WARM_AT, 1);
    warm[0] = 1;
    try {
      while (this.queue.length && performance.now() < until) {
        const slot = this.queue[this.queue.length - 1];
        // what was installed since the scan may be second-tier code, which runs its method whatever the warm word says, and a slot whose code was undone
        // holds its stub again, which would compile and run the method
        if (!this.burnable(slot)) { this.queue.pop(); this.left = BURN_CALLS; continue; }
        const f = this.w.table.get(slot) as (...args: Zero[]) => unknown, s = this.w.slots.peekMethod(slot)!;
        const args: Zero[] = methodKinds(s.m).params.map((k) => k === "J" ? 0n : k === "L" ? null : 0);
        const depth = this.w.rt.depth.value;
        for (let i = Math.min(this.left, BURN_CHUNK); i > 0; i--) f(...args);
        if (this.w.rt.depth.value !== depth) throw new Error(`${s.m.cls}.${s.m.name} ran while burning`);
        this.left -= BURN_CHUNK;
        if (this.left <= 0) { this.queue.pop(); this.burned.add(slot); this.w.stats.burned++; this.left = BURN_CALLS; }
      }
    } catch (e) { this.failed = true; throw e; }
    finally { warm[0] = 0; }
    return this.queue.length > 0;
  }
  /** forgets that `slot` was burned: new code is in it */
  installed(slot: number): void { this.burned.delete(slot); }
}
