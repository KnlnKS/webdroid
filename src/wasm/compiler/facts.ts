// What holds on every path reaching an instruction, so the emitter drops checks that cannot fail: a reference web already null-checked (or
// made by an allocation or constant), a class whose initialization an earlier instruction on every path has requested. Class
// initialization never goes back and a null check stays true until its web is redefined, so a fact survives until its web is written.
// A reference that field accesses cast to a struct type more than once keeps the cast in a local of that type (the "shadow"), so a later
// access reads it instead of casting again: baseline code does not remove repeated casts. Handler entries start empty: a throw can come from anywhere in the try range.
import { endsBlock, branchTargets, type PreparedInstruction as Ins } from "../../../src/jvm/prepared";
import { R as KR } from "./infer";
import type { MC } from "./method";

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

/** the register an instruction null-checks (every translation of it throws NullPointerException when the register is null), or -1 */
function checkedReg(ins: Ins): number {
  const n = ins.name;
  if (n.startsWith("iget") || n.startsWith("iput") || n.startsWith("aget") || n.startsWith("aput")) return ins.b;
  if (n === "array-length") return ins.b;
  if (n === "monitor-enter" || n === "monitor-exit" || n === "throw" || n === "fill-array-data") return ins.a;
  if (n.startsWith("invoke") && !n.startsWith("invoke-static") && n !== "invoke-custom" && !n.startsWith("invoke-polymorphic") && ins.regs.length) return ins.regs[0];
  return -1;
}

/** applies the effect of `ins` to `f`, once it has been emitted */
export function step(mc: MC, ins: Ins, f: Facts): void {
  const reg = checkedReg(ins);
  if (reg >= 0 && !(ins.name.startsWith("invoke-direct") && mc.isStringInit(ins))) { const w = mc.typing.use(ins.pc, reg); if (w >= 0 && mc.typing.kind[w] === KR) f.nonNull.add(w); }
  const d = mc.typing.def(ins.pc);
  const cls = mc.ensureTarget(ins);
  if (cls) for (const c of mc.cx.prog.chain(cls)) f.inited.add(c);
  const shadow = mc.shadowKey(ins);
  if (shadow) f.typed.add(shadow);
  if (d < 0) return;
  const nn = mc.definesNonNull(ins, f);
  f.nonNull.delete(d);
  if (nn) f.nonNull.add(d);
  for (const k of f.typed) if (k.startsWith(d + ":")) f.typed.delete(k);
}

/** the facts at the entry of each block */
export function analyze(mc: MC): Facts[] {
  const flow = mc.flow, n = flow.starts.length, entry: (Facts | undefined)[] = new Array(n);
  const start = newFacts();
  if (!mc.m.isStatic) { const w = mc.typing.param(mc.item.regs - mc.item.ins); if (w >= 0) start.nonNull.add(w); }
  entry[0] = start;
  const handlers = new Set<number>();
  for (const t of mc.item.tries) { for (const [, h] of t.handlers) handlers.add(flow.blockAt[h]); if (t.catchAllAddr >= 0) handlers.add(flow.blockAt[t.catchAllAddr]); }
  for (const h of handlers) entry[h] = newFacts();
  const push = (s: number, out: Facts) => {
    if (handlers.has(s)) return false;
    const cur = entry[s];
    if (!cur) { entry[s] = cloneFacts(out); return true; }
    return meet(cur, out);
  };
  for (let changed = true; changed;) {
    changed = false;
    for (let b = 0; b < n; b++) {
      const inf = entry[b], inss = mc.blockIns[b];
      if (!inf || !inss) continue;
      const out = cloneFacts(inf);
      for (const ins of inss) step(mc, ins, out);
      const last = inss[inss.length - 1], fall = last.pc + last.len;
      const targets = branchTargets(mc.item, last);
      // a null test refines the facts along its two edges
      const test = last.name === "if-eqz" || last.name === "if-nez" ? mc.typing.use(last.pc, last.a) : -1;
      const nonNullEdge = (taken: boolean) => (last.name === "if-nez") === taken;
      const edge = (t: number, taken: boolean) => {
        let o = out;
        if (test >= 0 && mc.typing.kind[test] === KR && nonNullEdge(taken) && !out.nonNull.has(test)) { o = cloneFacts(out); o.nonNull.add(test); }
        if (push(flow.blockAt[t], o)) changed = true;
      };
      for (const t of targets) edge(t, true);
      if (!endsBlock(last.op) && flow.blockAt[fall] >= 0) edge(fall, false);
    }
  }
  return entry.map((e) => e ?? newFacts());
}
