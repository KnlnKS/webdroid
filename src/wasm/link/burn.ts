// Optimizing busy first-tier code in idle time. The engine runs a Wasm function as baseline code until it has charged the function's tiering budget, its
// size at each return and loop back-edge: a method of an interaction's flat code that runs some hundreds of times stays baseline code for the launch,
// at a third to a half of its optimized speed. The optimizing compile inlines from the call counts the baseline code recorded, which only the method's
// real calls give it. Once a method has run enough calls for those, the burner calls it with the warm word set (Compiler.emitWarmExit): each call
// returns at once through the end of its function, charging the whole function, so the engine optimizes it on a background thread with the feedback
// of its real calls. Nothing of the method runs.
import { COUNT_SLOTS, WARM_AT } from "../compiler/consts.ts";
import { methodKinds, type Kind } from "../compiler/program.ts";
import { FIRST } from "./slots.ts";
import type { World } from "./world.ts";

/** the calls and loop iterations a method has run before its feedback is worth optimizing with: an inlined call's count must outweigh its callee's size */
const BURN_AT = 64;
/** the calls that charge the default budget (13,000,000) for a function of 400 bytes of baseline code; larger ones need fewer, and smaller ones are worth
 *  most inlined into their callers. A call costs some nanoseconds */
const BURN_CALLS = 1 << 15;
/** calls between looks at the clock */
const BURN_CHUNK = 4096;

const zero = (k: Kind): 0 | 0n | null => k === "J" ? 0n : k === "L" ? null : 0;

export class Burner {
  private readonly w: World;
  /** the code burned: a slot's new code is burned again */
  private readonly burned = new WeakSet<Function>();
  /** slots to burn, the next last, and the calls the first still needs */
  private queue: number[] = [];
  private left = BURN_CALLS;
  constructor(w: World) { this.w = w; }
  /** the unburned first-tier code of `slot`'s method, which has the warm exit: second-tier code runs its method whatever the warm word says, and a stub compiles it */
  private code(slot: number): Function | undefined {
    if (!this.w.slots.is(slot, FIRST) || !this.w.slots.methodAt(slot)) return undefined;
    const f = this.w.table.get(slot) as Function;
    return this.burned.has(f) ? undefined : f;
  }
  /** the first-tier methods that have run BURN_AT calls or asked for the second tier, busiest first */
  private scan(): number[] {
    const counts = this.w.slots.counts(), n = Math.min(COUNT_SLOTS, this.w.slots.size), found: number[] = [];
    for (let slot = 0; slot < n; slot++) if ((counts[slot] >= BURN_AT || this.w.upgrades.asked(slot)) && this.code(slot)) found.push(slot);
    return found.sort((a, b) => counts[a] - counts[b]);
  }
  /** Idle time: burns the busy first-tier methods until `until`. Whether any is left. */
  burn(until: number): boolean {
    if (!this.queue.length) this.queue = this.scan();
    const warm = new Int32Array(this.w.mem.buffer, WARM_AT, 1);
    warm[0] = 1;
    try {
      while (this.queue.length && performance.now() < until) {
        const slot = this.queue[this.queue.length - 1], f = this.code(slot);
        if (!f) { this.queue.pop(); this.left = BURN_CALLS; continue; }
        const m = this.w.slots.methodAt(slot)!, args = methodKinds(m).params.map(zero), depth = this.w.rt.depth.value;
        for (let i = Math.min(this.left, BURN_CHUNK); i > 0; i--) f(...args);
        if (this.w.rt.depth.value !== depth) throw new Error(`${m.cls}.${m.name} ran while burning`);
        if ((this.left -= BURN_CHUNK) > 0) continue;
        this.queue.pop(); this.burned.add(f); this.w.stats.burned++; this.left = BURN_CALLS;
      }
    } finally { warm[0] = 0; }
    return this.queue.length > 0;
  }
}
