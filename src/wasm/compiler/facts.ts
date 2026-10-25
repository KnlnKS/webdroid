// What holds on every path reaching an instruction, so the emitter drops checks that cannot fail: a reference web already null-checked (or
// made by an allocation or constant), a class whose initialization an earlier instruction on every path has requested. Class
// initialization never goes back and a null check stays true until its web is redefined, so a fact survives until its web is written.
// A reference that field accesses cast to a struct type more than once keeps the cast in a local of that type (the "shadow"), so a later
// access reads it instead of casting again: baseline code does not remove repeated casts. Handler entries start empty: a throw can come from anywhere in the try range.
import { ifTarget, type PreparedInstruction as Ins } from "../../jvm/prepared.ts";
import { R as KR } from "./infer.ts";
import { Family, Invoke, familyOf, invokeKind, isFieldAccess, nullChecked, typeLetter, variantOf } from "../../jvm/opcodes.ts";
import { failed } from "./linkage.ts";
import type { MC } from "./method.ts";

const NONE: readonly string[] = [];

/** `typed` holds "web:struct" for a web whose shadow local for that struct type currently holds the web's value */
export interface Facts { nonNull: Set<number>; inited: Set<string>; typed: Set<string> }
export const newFacts = (): Facts => ({ nonNull: new Set(), inited: new Set(), typed: new Set() });
export const cloneFacts = (f: Facts): Facts => ({ nonNull: new Set(f.nonNull), inited: new Set(f.inited), typed: new Set(f.typed) });
const meet = (a: Facts, b: Facts): boolean => {
  let changed = false;
  for (const w of a.nonNull) if (!b.nonNull.has(w)) { a.nonNull.delete(w); changed = true; }
  for (const c of a.inited) if (!b.inited.has(c)) { a.inited.delete(c); changed = true; }
  for (const k of a.typed) if (!b.typed.has(k)) { a.typed.delete(k); changed = true; }
  return changed;
};


/** the facts of one method's code: what each instruction adds to them, and what holds at the entry of each block */
export class MethodFacts {
  /** "web:struct" of the field accesses whose object is cast to that struct more than once in the method: they share a shadow local */
  readonly shadowKeys = new Set<string>();
  readonly entry: Facts[];
  private mc: MC;
  private initedAt = new Map<number, readonly string[]>();
  private shadowAt = new Map<number, string | undefined>();
  constructor(mc: MC) {
    this.mc = mc;
    const seen = new Set<string>();
    for (const ins of mc.prepared.instructions) {
      const key = this.fieldKey(ins);
      if (key === undefined) continue;
      if (seen.has(key)) this.shadowKeys.add(key); else seen.add(key);
    }
    this.entry = this.analyze();
  }

  /** applies the effect of `ins` to `f`, once it has been emitted */
  step(ins: Ins, f: Facts): void {
    // a String constructor call's receiver is the allocation, which holds null until the call makes the String
    const mc = this.mc, reg = nullChecked(ins);
    if (reg >= 0 && mc.strings.get(ins.pc) !== "init") { const w = mc.typing.use(ins.pc, reg); if (w >= 0 && mc.typing.kind[w] === KR) f.nonNull.add(w); }
    const d = mc.typing.def(ins.pc);
    for (const c of this.initedBy(ins)) f.inited.add(c);
    const shadow = this.shadowKey(ins);
    if (shadow) f.typed.add(shadow);
    if (d < 0) return;
    const nn = this.definesNonNull(ins, f);
    f.nonNull.delete(d);
    if (nn) f.nonNull.add(d);
    if (f.typed.size) { const p = d + ":"; for (const k of f.typed) if (k.startsWith(p)) f.typed.delete(k); }
  }

  private analyze(): Facts[] {
    const mc = this.mc, { instructions, blockAt, first, last, succ, fall: falls } = mc.prepared, n = first.length, entry: (Facts | undefined)[] = new Array(n);
    const start = newFacts();
    if (!mc.m.isStatic) { const w = mc.typing.param(mc.item.regs - mc.item.ins); if (w >= 0) start.nonNull.add(w); }
    entry[0] = start;
    const handlers = new Set<number>();
    for (const pc of mc.prepared.handlerPcs) handlers.add(blockAt[pc]);
    for (const h of handlers) entry[h] = newFacts();
    // blocks whose entry facts changed since they were last stepped
    const dirty = new Uint8Array(n).fill(1);
    let changed = true;
    const push = (s: number, out: Facts) => {
      if (handlers.has(s)) return;
      const cur = entry[s];
      if (!cur) entry[s] = cloneFacts(out); else if (!meet(cur, out)) return;
      dirty[s] = 1; changed = true;
    };
    while (changed) {
      changed = false;
      for (let b = 0; b < n; b++) {
        const inf = entry[b];
        if (!dirty[b] || !inf) continue;
        dirty[b] = 0;
        const out = cloneFacts(inf);
        for (let i = first[b]; i <= last[b]; i++) this.step(instructions[i], out);
        // a null test (if-eqz, if-nez) refines the facts along its two edges, unless both reach one block
        const test = instructions[last[b]], nez = variantOf(test.op) === 1, w = familyOf(test.op) === Family.IfZ && variantOf(test.op) < 2 ? mc.typing.use(test.pc, test.a) : -1;
        const taken = w >= 0 && mc.typing.kind[w] === KR && !out.nonNull.has(w) ? blockAt[ifTarget(test)] : -1, fall = falls[b];
        if (taken < 0 || taken === fall) { for (const s of succ[b]) push(s, out); continue; }
        const refined = cloneFacts(out);
        refined.nonNull.add(w);
        push(taken, nez ? refined : out);
        if (fall >= 0) push(fall, nez ? out : refined);
      }
    }
    return entry.map((e) => e ?? newFacts());
  }
  /** the classes whose initialization `ins` requests, as its translation does: its target and the target's superclasses */
  private initedBy(ins: Ins): readonly string[] {
    const f = familyOf(ins.op);
    if (f !== Family.NewInstance && f !== Family.Sget && f !== Family.Sput && !(f === Family.Invoke && invokeKind(ins.op) === Invoke.Static)) return NONE;
    let r = this.initedAt.get(ins.pc);
    if (!r) { const cls = this.ensureTarget(ins); this.initedAt.set(ins.pc, r = cls ? this.mc.cx.prog.chain(cls) : []); }
    return r;
  }
  private ensureTarget(ins: Ins): string | undefined {
    const mc = this.mc;
    if (mc.deferredSite(ins)) return undefined;
    const f = familyOf(ins.op);
    if (f === Family.NewInstance) return mc.strings.has(ins.pc) ? undefined : mc.types.typeName(ins.b);
    if (f !== Family.Invoke) { const r = mc.fieldOf(ins.b, true); return failed(r) ? undefined : r.f.owner; }
    const { target } = mc.invoke(ins);
    return target === "clone" || failed(target) ? undefined : target.cls;
  }
  /** whether the register `ins` defines surely holds a reference: an allocation, a constant, the exception caught, or a copy of one */
  private definesNonNull(ins: Ins, f: Facts): boolean {
    const family = familyOf(ins.op);
    if (family === Family.NewInstance) return !this.mc.strings.has(ins.pc);
    if (family === Family.ConstString || family === Family.ConstClass || family === Family.NewArray || family === Family.MoveException) return true;
    const from = family === Family.CheckCast ? ins.a : family === Family.Move && typeLetter(ins.op) === "L" ? ins.b : -1;
    const w = from < 0 ? -1 : this.mc.typing.use(ins.pc, from);
    return w >= 0 && f.nonNull.has(w);
  }
  /** the shadow key of the field access `ins` if its object shares a cast, else undefined */
  private shadowKey(ins: Ins): string | undefined {
    if (!this.shadowKeys.size || !isFieldAccess(ins.op)) return undefined;
    if (this.shadowAt.has(ins.pc)) return this.shadowAt.get(ins.pc);
    const key = this.fieldKey(ins), shared = key !== undefined && this.shadowKeys.has(key) ? key : undefined;
    this.shadowAt.set(ins.pc, shared);
    return shared;
  }
  /** "web:struct" of an iget or iput's object and the struct of its field, unless it is a symbolic site or its field fails to resolve */
  private fieldKey(ins: Ins): string | undefined {
    const mc = this.mc;
    if (!isFieldAccess(ins.op) || mc.deferredSite(ins)) return undefined;
    const w = mc.typing.use(ins.pc, ins.b);
    if (w < 0) return undefined;
    const r = mc.fieldOf(ins.c, false);
    return failed(r) ? undefined : `${w}:${mc.cx.structFor(r.decl)}`;
  }
}
