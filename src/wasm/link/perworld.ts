// State a link module keeps for each World.
import type { World } from "./world.ts";

const rebound: PerWorld<unknown>[] = [];

/** state made for a World on first use; `rebind` state is derived from the Program's types and is made again once a namespace change rewrites them */
export class PerWorld<S> {
  private readonly states = new WeakMap<World, S>();
  private readonly make: (w: World) => S;
  constructor(make: (w: World) => S, rebind = false) { this.make = make; if (rebind) rebound.push(this); }
  get(w: World): S { let s = this.states.get(w); if (s === undefined) this.states.set(w, s = this.make(w)); return s; }
  /** the state, if it was made */
  peek(w: World): S | undefined { return this.states.get(w); }
  /** forgets `w`'s rebind state (Namespaces.rebind) */
  static rebound(w: World): void { for (const s of rebound) s.states.delete(w); }
}
