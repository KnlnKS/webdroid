// What compiled code relies on that classes defined later can falsify: class-hierarchy decisions, sites that fail because a class is not loaded, and the code
// of other methods it holds (a build's direct calls, bodies run in place). Each is undone by putting the lazy-link stub back in the slots whose code relied on it
// (World.invalidate), so the next call compiles against what is there now. A decision is the compiled code's own, so undoing it leaves the code that holds the
// method's alone; any other undoing takes that code too (undoCode).
import { ACC, type MethodInfo } from "../compiler/program.ts";
import { failed } from "../compiler/linkage.ts";
import type { Compiler } from "../compiler/j2w.ts";
import type { World } from "./world.ts";
import type { UnitHeader } from "./aot.ts";

/** a class-hierarchy decision: calls of decl.name+desc run only the method `tk` of class `tc` (none if empty) */
interface Assumption { decl: string; name: string; desc: string; tc: string; tk: string; slots: Set<number> }
/** what each decision's target and declaration resolved to before a namespace change (Assumptions.rebound) */
export type Resolved = Map<Assumption, { target: MethodInfo; declared: MethodInfo }>;

export class Assumptions {
  private readonly w: World;
  /** the decisions by decl.name+desc */
  readonly decisions = new Map<string, Assumption>();
  /** the slots whose code fails a site because a class is not loaded, by class name: loading it undoes them */
  readonly absent = new Map<string, Set<number>>();
  /** the slots of the methods whose code holds a method's, by its slot */
  private holders = new Map<number, Set<number>>();
  constructor(w: World) { this.w = w; }

  /** records what the code of a unit compiled here relies on: `slot` owns what no method of the unit does */
  record(cx: Pick<Compiler, "assumptions" | "absent" | "held">, slot?: number): void {
    const late = this.lateFor(cx.assumptions);
    for (const [decl, name, desc, target, owner] of cx.assumptions) this.decide(decl, name, desc, target?.cls ?? "", target?.key ?? "", this.owner(owner, slot), late);
    for (const [name, owner] of cx.absent) this.absentAt(name, this.owner(owner, slot));
    this.hold(cx.held);
  }
  /** records what the code of a unit made elsewhere relies on, once it is in its slots: a site failing on a class missing where it was made is undone if the class is here */
  recordHeader(head: Pick<UnitHeader, "assumptions" | "missing" | "held">): void {
    const late = this.lateFor(head.assumptions);
    for (const [decl, name, desc, tc, tk, at] of head.assumptions) this.decide(decl, name, desc, tc, tk, at, late);
    for (const [name, at] of head.missing) if (this.w.prog.get(name)) this.undoCode(at); else this.absentAt(name, at);
    this.hold(head.held ?? []);
  }
  // a compile can link a class after deciding about its supertypes' implementations, and a worker's hierarchy has only the deferred classes it linked
  private lateFor(decisions: readonly (readonly [string, ...unknown[]])[]): Map<string, string[]> | undefined {
    return this.w.cha.late.size && decisions.length ? this.lateBy(new Set(decisions.map(([decl]) => decl)), this.w.cha.late) : undefined;
  }
  private owner(owner: MethodInfo | undefined, slot: number | undefined): number {
    const at = owner ? this.w.slotOf(owner) : slot;
    if (at === undefined) throw new Error("compiled code relies on something with no invalidation owner");
    return at;
  }
  /** code in slot `at` runs only `tc`'s method `tk` for calls of decl.name+desc, unless a class linked late (`late`) already falsifies that */
  private decide(decl: string, name: string, desc: string, tc: string, tk: string, at: number, late: Map<string, string[]> | undefined): void {
    const by = late?.get(decl);
    if (by && !this.holds({ name, desc, tc, tk }, by)) { this.w.invalidate(at); return; }
    const key = `${decl}.${name}${desc}`;
    let a = this.decisions.get(key);
    if (!a) this.decisions.set(key, a = { decl, name, desc, tc, tk, slots: new Set() });
    a.slots.add(at);
  }
  /** the code of the methods after each slot of `held` holds the code of the method of that slot (Compiler.held) */
  hold(held: readonly number[][]): void {
    for (const [callee, ...by] of held) { const s = this.holders.get(callee); if (s) for (const x of by) s.add(x); else this.holders.set(callee, new Set(by)); }
  }
  /** undoes the code of `slot` and, transitively, the code that holds it */
  undoCode(slot: number): void {
    const todo = [slot];
    for (let i = 0; i < todo.length; i++) {
      const by = this.holders.get(todo[i]);
      if (by) { this.holders.delete(todo[i]); todo.push(...by); }
      this.w.invalidate(todo[i]);
    }
  }
  /** the code of `slot` fails a site because class `name` is not loaded */
  absentAt(name: string, slot: number): void {
    (this.absent.get(name) ?? this.absent.set(name, new Set()).get(name)!).add(slot);
  }
  /** undoes the code that failed sites for the classes `added` defines */
  loaded(added: string[]): void {
    if (this.absent.size) for (const name of added) {
      const slots = this.absent.get(name);
      if (!slots) continue;
      for (const slot of slots) this.undoCode(slot);
      this.absent.delete(name);
    }
  }
  /** undoes the decisions a concrete class among `reached`, which joining the class hierarchy made reachable, falsifies */
  joined(reached: Set<string>): void {
    // a decision about the implementations of decl.name+desc changes only when a concrete subtype of decl that has one becomes reachable
    const now = this.lateBy(this.decls(), reached);
    for (const [key, a] of this.decisions) {
      const by = now.get(a.decl);
      if (!by || this.holds(a, by)) continue;
      this.undo(key, a);
    }
  }
  /** before a namespace change: what the decisions' targets and declarations resolve to */
  resolved(): Resolved {
    const prog = this.w.prog, out: Resolved = new Map();
    for (const a of this.decisions.values()) {
      const target = a.tc ? prog.get(a.tc)?.byKey.get(a.tk) : undefined;
      const declared = prog.resolve(a.decl, a.name, a.desc);
      if (target && target.key === a.tk && target.desc === a.desc && declared && !declared.isStatic && declared.desc === a.desc) out.set(a, { target, declared });
    }
    return out;
  }
  /** after a namespace change: undoes every decision whose target or declaration resolves differently than `before`, or that the concrete subtypes of its
   *  declaring class the change can affect falsify (`affects`, by whether the change names a type of its descriptor), and every site that failed for an absent class */
  rebound(before: Resolved, affects: (desc: string) => (name: string) => boolean): void {
    const w = this.w, prog = w.prog;
    let lateBy: Map<string, string[]> | undefined;
    const subtypes = new Map<(name: string) => boolean, Map<string, string[]>>();
    for (const [key, a] of this.decisions) {
      for (const slot of a.slots) {
        const state = w.slots.peek(slot);
        // Unmaterialized AOT slots and private helper owners can still hold live code.
        if (!w.helpers.isHelper(slot) && state && (state.k === "ensure" || !state.done)) a.slots.delete(slot);
      }
      if (!a.slots.size) { this.decisions.delete(key); continue; }
      const saved = before.get(a), declared = prog.resolve(a.decl, a.name, a.desc);
      const sameTarget = saved && saved.target === prog.get(a.tc)?.byKey.get(a.tk) && saved.target.key === a.tk && saved.target.desc === a.desc;
      const samePrototype = declared && declared === saved?.declared && !declared.isStatic && declared.desc === a.desc;
      const affected = affects(a.desc), cache = subtypes.get(affected) ?? subtypes.set(affected, new Map()).get(affected)!;
      let by = cache.get(a.decl);
      if (!by) cache.set(a.decl, by = ((lateBy ??= this.lateBy(this.decls(), w.cha.members())).get(a.decl) ?? []).filter(affected));
      if (sameTarget && samePrototype && this.holds(a, by)) continue;
      this.undo(key, a);
    }
    for (const slots of this.absent.values()) for (const slot of slots) this.undoCode(slot);
    this.absent.clear();
  }
  private undo(key: string, a: Assumption): void {
    for (const slot of a.slots) this.w.invalidate(slot);
    this.decisions.delete(key);
  }
  private decls(): Set<string> { return new Set([...this.decisions.values()].map((a) => a.decl)); }
  /** the concrete classes among `names` by each of their supertypes in `decls`, themselves included. Only the supertypes a decision names are asked
   *  about, so no index of every class by every supertype is kept: an app's classes number in the hundreds of thousands, each with dozens of supertypes. */
  private lateBy(decls: ReadonlySet<string>, names: Iterable<string>): Map<string, string[]> {
    const prog = this.w.prog, out = new Map<string, string[]>(), memo = new Map<string, readonly string[]>(), none: readonly string[] = [];
    // most classes reach no decl or the decls of one supertype only: those share an array
    const within = (n: string): readonly string[] => {
      const memoed = memo.get(n);
      if (memoed) return memoed;
      const c = prog.get(n);
      let s: readonly string[] = decls.has(n) ? [n] : none, found: Set<string> | undefined;
      const join = (xs: readonly string[]) => {
        if (!xs.length || xs === s) return;
        if (!s.length) { s = xs; return; }
        found ??= new Set(s);
        for (const x of xs) found.add(x);
      };
      if (c) { if (c.sup) join(within(c.sup)); for (const i of c.ifaces) join(within(i)); }
      if (found) s = [...found];
      memo.set(n, s);
      return s;
    };
    for (const n of names) {
      const c = prog.get(n);
      if (!c || c.isInterface || c.flags & ACC.ABSTRACT) continue;
      for (const d of within(n)) { let a = out.get(d); if (!a) out.set(d, a = []); a.push(n); }
    }
    return out;
  }
  /** whether the implementation code relied on for decl.name+desc (`tc`'s method `tk`, none if empty) stands once the concrete classes `by`, all subtypes of decl, exist */
  private holds(a: { name: string; desc: string; tc: string; tk: string }, by: string[]): boolean {
    const prog = this.w.prog, target = a.tc ? prog.get(a.tc)?.byKey.get(a.tk) : undefined;
    for (const n of by) { const m = prog.dispatchFor(n, a.name, a.desc); if (m && (failed(m) || m !== target)) return false; }
    return true;
  }
}
