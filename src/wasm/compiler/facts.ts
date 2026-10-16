// What holds on every path reaching an instruction, so the emitter drops checks that cannot fail: a reference web already null-checked (or
// made by an allocation or constant), a class whose initialization an earlier instruction on every path has requested. Class
// initialization never goes back and a null check stays true until its web is redefined, so a fact survives until its web is written.
// A reference that field accesses cast to a struct type more than once keeps the cast in a local of that type (the "shadow"), so a later
// access reads it instead of casting again: baseline code does not remove repeated casts. Handler entries start empty: a throw can come from anywhere in the try range.
import { endsBlock, branchTargets, type PreparedInstruction as Ins } from "../../jvm/prepared.ts";
import { R as KR } from "./infer.ts";
import { isInstanceInvoke } from "./opinfo.ts";
import type { MC } from "./method.ts";

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

/** the operand an instruction null-checks (every translation of it throws NullPointerException when it is null): 1 b, 2 a, 3 the receiver */
const CHECKED = new Uint8Array(256);
CHECKED.fill(1, 0x44, 0x60); // aget, aput, iget, iput
CHECKED[0x21] = 1; // array-length
for (const op of [0x1d, 0x1e, 0x26, 0x27]) CHECKED[op] = 2; // monitor-enter, monitor-exit, fill-array-data, throw
for (let op = 0; op < 0xfa; op++) if (isInstanceInvoke(op)) CHECKED[op] = 3;
function checkedReg(ins: Ins): number {
  switch (CHECKED[ins.op]) {
    case 1: return ins.b;
    case 2: return ins.a;
    case 3: return ins.regs.length ? ins.regs[0] : -1;
    default: return -1;
  }
}

/** applies the effect of `ins` to `f`, once it has been emitted */
export function step(mc: MC, ins: Ins, f: Facts): void {
  const reg = checkedReg(ins);
  if (reg >= 0 && !((ins.op === 0x70 || ins.op === 0x76) && mc.isStringInit(ins))) { const w = mc.typing.use(ins.pc, reg); if (w >= 0 && mc.typing.kind[w] === KR) f.nonNull.add(w); }
  const d = mc.typing.def(ins.pc);
  for (const c of mc.initedBy(ins)) f.inited.add(c);
  const shadow = mc.shadowKey(ins);
  if (shadow) f.typed.add(shadow);
  if (d < 0) return;
  const nn = mc.definesNonNull(ins, f);
  f.nonNull.delete(d);
  if (nn) f.nonNull.add(d);
  if (f.typed.size) { const p = d + ":"; for (const k of f.typed) if (k.startsWith(p)) f.typed.delete(k); }
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
      const inf = entry[b], inss = mc.blockIns[b];
      if (!dirty[b] || !inf || !inss) continue;
      dirty[b] = 0;
      const out = cloneFacts(inf);
      for (const ins of inss) step(mc, ins, out);
      const last = inss[inss.length - 1], fall = last.pc + last.len;
      const targets = branchTargets(mc.item, last);
      // a null test (if-eqz, if-nez) refines the facts along its two edges
      const test = last.op === 0x38 || last.op === 0x39 ? mc.typing.use(last.pc, last.a) : -1;
      const nonNullEdge = (taken: boolean) => (last.op === 0x39) === taken;
      const edge = (t: number, taken: boolean) => {
        let o = out;
        if (test >= 0 && mc.typing.kind[test] === KR && nonNullEdge(taken) && !out.nonNull.has(test)) { o = cloneFacts(out); o.nonNull.add(test); }
        push(flow.blockAt[t], o);
      };
      for (const t of targets) edge(t, true);
      if (!endsBlock(last.op) && flow.blockAt[fall] >= 0) edge(fall, false);
    }
  }
  return entry.map((e) => e ?? newFacts());
}
