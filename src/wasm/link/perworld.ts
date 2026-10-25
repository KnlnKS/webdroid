// State a link module keeps for each World.
import type { World } from "./world.ts";

/** what derived state is made again after: any change of the Program's classes (World.changed), or only a namespace change, which rewrites their types (Namespaces) */
export type Derived = "changed" | "rebound";
const derived: Record<Derived, PerWorld<unknown>[]> = { changed: [], rebound: [] };

/** state made for a World on first use; state `from` the Program is made again once that changes */
export class PerWorld<S> {
  private readonly states = new WeakMap<World, S>();
  private readonly make: (w: World) => S;
  constructor(make: (w: World) => S, from?: Derived) { this.make = make; if (from) derived[from].push(this); }
  get(w: World): S { let s = this.states.get(w); if (s === undefined) this.states.set(w, s = this.make(w)); return s; }
  /** the state, if it was made */
  peek(w: World): S | undefined { return this.states.get(w); }
  /** forgets `w`'s state derived from its classes, and with `rebound` that derived from their namespaces' resolution too */
  static forget(w: World, rebound: boolean): void {
    for (const s of rebound ? [...derived.changed, ...derived.rebound] : derived.changed) s.states.delete(w);
  }
}
