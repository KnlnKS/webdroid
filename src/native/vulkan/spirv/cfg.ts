// Functions and their structured control flow: selection and loop constructs become if, switch and
// loop statements, branches out of them break or continue, and phis assign hoisted vars on each edge.

import { O, SC, hasResult, operandIds, type Inst } from "./module.ts";
import { emitInst, line, value, as, type Ctx } from "./inst.ts";
import type { Translator } from "./layout.ts";

interface Block { label: number; insts: Inst[]; merge?: Inst; term: Inst }
export interface Fn { id: number; ret: number; params: number[]; blocks: Map<number, Block>; order: number[] }
type Construct = { kind: "loop"; header: number; merge: number; cont: number } | { kind: "switch"; merge: number } | { kind: "if"; merge: number };

/** the module's functions and its global variables, each result's type recorded */
export function partition(t: Translator): { fns: Map<number, Fn>; globals: Inst[] } {
  const fns = new Map<number, Fn>(), globals: Inst[] = [];
  let fn: Fn | null = null, block: Block | null = null;
  for (const inst of t.insts) {
    const { op, w } = inst;
    if (op === O.Function) { fn = { id: w[1], ret: w[0], params: [], blocks: new Map(), order: [] }; fns.set(w[1], fn); t.resultType.set(w[1], w[0]); continue; }
    if (!fn) { if (op === O.Variable) { globals.push(inst); t.resultType.set(w[1], w[0]); } continue; }
    if (op === O.FunctionEnd) { fn = null; continue; }
    if (op === O.FunctionParameter) { fn.params.push(w[1]); t.resultType.set(w[1], w[0]); continue; }
    if (op === O.Label) { block = { label: w[0], insts: [], term: inst }; fn.blocks.set(w[0], block); fn.order.push(w[0]); continue; }
    if (!block) continue;
    if (op === O.SelectionMerge || op === O.LoopMerge) block.merge = inst;
    else if (op === O.Branch || op === O.BranchConditional || op === O.Switch || op === O.Return || op === O.ReturnValue || op === O.Kill || op === O.Unreachable || op === O.TerminateInvocation) block.term = inst;
    else block.insts.push(inst);
    if (hasResult(op)) t.resultType.set(w[1], w[0]);
  }
  return { fns, globals };
}
/** the functions `entry` reaches, in the order it reaches them */
export function reach(fns: Map<number, Fn>, entry: number): Set<number> {
  const reached = new Set<number>(), visit = (id: number) => {
    if (reached.has(id)) return;
    reached.add(id);
    for (const b of fns.get(id)!.blocks.values()) for (const i of b.insts) if (i.op === O.FunctionCall) visit(i.w[2]);
  };
  visit(entry);
  return reached;
}

/** a WGSL pointer type into storage class `sc` */
const pointer = (sc: number, to: string) => sc === SC.Function ? `ptr<function, ${to}>` : sc === SC.Private || sc === SC.Input || sc === SC.Output ? `ptr<private, ${to}>`
  : sc === SC.Workgroup ? `ptr<workgroup, ${to}>` : sc === SC.StorageBuffer ? `ptr<storage, ${to}, read_write>` : sc === SC.PushConstant ? `ptr<storage, ${to}, read>` : `ptr<uniform, ${to}>`;

export function emitFunction(t: Translator, f: Fn): string {
  const ctx: Ctx = { t, fn: f, lines: [], depth: 1, vals: new Map(), refs: new Map(), mats: new Map(), hoisted: new Set(), phis: new Map(), done: new Set() };
  const params = f.params.map((p) => {
    const ty = t.type(t.resultType.get(p)!);
    if (ty.k === "ptr") { ctx.refs.set(p, `(*x_${p})`); return `x_${p}: ${pointer(ty.sc, t.wgsl(ty.to))}`; }
    ctx.vals.set(p, `x_${p}`);
    return `x_${p}: ${t.wgsl(t.resultType.get(p)!)}`;
  });
  // the block of each definition and the blocks of its uses: a value used outside its block is a function-scope var
  const defBlock = new Map<number, number>(), useBlocks = new Map<number, Set<number>>(), pointerOps = new Map<number, number[]>();
  for (const label of f.order) {
    const b = f.blocks.get(label)!;
    for (const i of b.insts) {
      if (hasResult(i.op)) defBlock.set(i.w[1], label);
      if (i.op === O.AccessChain || i.op === O.InBoundsAccessChain) pointerOps.set(i.w[1], [...i.w.subarray(2)]);
      if (i.op === O.Phi) {
        ctx.phis.set(label, [...(ctx.phis.get(label) ?? []), i]);
        for (let k = 2; k < i.w.length; k += 2) addUse(useBlocks, i.w[k], i.w[k + 1]);
        continue;
      }
      for (const a of operandIds(i)) addUse(useBlocks, a, label);
    }
    for (const a of termOperands(b.term)) addUse(useBlocks, a, label);
  }
  // a pointer's index operands are used wherever the pointer is
  const spread = (id: number, label: number, seen = new Set<number>()) => {
    if (seen.has(id)) return; seen.add(id);
    for (const a of pointerOps.get(id) ?? []) { addUse(useBlocks, a, label); spread(a, label, seen); }
  };
  for (const [id, blocks] of [...useBlocks]) for (const l of [...blocks]) spread(id, l);
  const decls: string[] = [];
  for (const [id, label] of defBlock) {
    const inst = findInst(f, id);
    if (!inst || inst.op === O.Variable || inst.op === O.AccessChain || inst.op === O.InBoundsAccessChain || inst.op === O.SampledImage || inst.op === O.Image) continue;
    const ty = t.type(t.resultType.get(id)!);
    if (ty.k === "ptr" || ty.k === "void" || ty.k === "image" || ty.k === "sampler" || ty.k === "sampled") continue;
    const uses = useBlocks.get(id);
    if (inst.op === O.Phi || (uses && [...uses].some((u) => u !== label))) {
      ctx.hoisted.add(id);
      decls.push(`  var x_${id}: ${t.wgsl(t.resultType.get(id)!)};`);
    }
  }
  // function-scope variables
  for (const label of f.order) for (const i of f.blocks.get(label)!.insts) if (i.op === O.Variable) {
    decls.push(`  var x_${i.w[1]}: ${t.wgsl(t.pointee(i.w[0]))}${i.w.length > 3 ? ` = ${value(ctx, i.w[3])}` : ""};`);
    ctx.refs.set(i.w[1], `x_${i.w[1]}`);
  }
  ctx.lines.push(...decls);
  emitRegion(ctx, f.order[0], [], new Set());
  const ret = t.type(f.ret).k === "void" ? "" : ` -> ${t.wgsl(f.ret)}`;
  return `fn f_${f.id}(${params.join(", ")})${ret} {\n${ctx.lines.join("\n")}\n}`;
}
function addUse(m: Map<number, Set<number>>, id: number, label: number): void { let s = m.get(id); if (!s) m.set(id, s = new Set()); s.add(label); }
function findInst(f: Fn, id: number): Inst | undefined {
  for (const b of f.blocks.values()) for (const i of b.insts) if (hasResult(i.op) && i.w[1] === id) return i;
  return undefined;
}
function termOperands(i: Inst): number[] {
  return i.op === O.BranchConditional || i.op === O.Switch || i.op === O.ReturnValue ? [i.w[0]] : [];
}

function emitRegion(c: Ctx, start: number, stack: Construct[], stop: Set<number>): void {
  let label: number | null = start;
  while (label !== null && !stop.has(label)) {
    if (c.done.has(label)) throw new Error(`SPIR-V: block %${label} reached twice`);
    c.done.add(label);
    const b: Block = c.fn.blocks.get(label)!;
    for (const i of b.insts) if (i.op !== O.Phi) emitInst(c, i);
    label = emitTerminator(c, b, stack, stop);
  }
}
/** a branch from `from` to `to`: the phi assignments it makes, then a break or continue where it leaves the construct */
function branch(c: Ctx, from: number, to: number, stack: Construct[]): { next: number | null } {
  for (const phi of c.phis.get(to) ?? []) {
    for (let k = 2; k < phi.w.length; k += 2) if (phi.w[k + 1] === from) line(c, `x_${phi.w[1]} = ${value(c, phi.w[k])};`);
  }
  for (let k = stack.length - 1; k >= 0; k--) {
    const s = stack[k];
    if (s.kind === "loop" && to === s.cont) { line(c, "continue;"); return { next: null }; }
    if (s.kind === "loop" && to === s.header) return { next: null };
    if (s.merge === to) {
      if (s.kind === "if") return { next: null };
      // WGSL's break leaves the innermost loop or switch
      if (stack.slice(k + 1).some((x) => x.kind !== "if")) throw new Error("SPIR-V: a break out of more than one loop or switch");
      line(c, "break;");
      return { next: null };
    }
  }
  return { next: to };
}
function emitTerminator(c: Ctx, b: Block, stack: Construct[], stop: Set<number>): number | null {
  const term = b.term, w = term.w, merge = b.merge;
  if (merge?.op === O.LoopMerge) {
    const m = merge.w[0], cont = merge.w[1];
    line(c, "loop {");
    c.depth++;
    const loop: Construct = { kind: "loop", header: b.label, merge: m, cont };
    const inner = [...stack, loop];
    // the header's own branch into the loop body
    if (term.op === O.BranchConditional) {
      const [cond, t1, f1] = [w[0], w[1], w[2]];
      if (f1 === m) { line(c, `if (!(${value(c, cond)})) { break; }`); emitBody(c, b.label, t1, inner, cont); }
      else if (t1 === m) { line(c, `if (${value(c, cond)}) { break; }`); emitBody(c, b.label, f1, inner, cont); }
      else throw new Error("SPIR-V: a loop header branching to neither its merge nor body alone");
    } else if (term.op === O.Branch) emitBody(c, b.label, w[0], inner, cont);
    else throw new Error("SPIR-V: a loop header without a branch");
    // the continue construct, ending in the back edge
    line(c, "continuing {");
    c.depth++;
    if (cont !== b.label) emitContinue(c, cont, loop, inner);
    c.depth--;
    line(c, "}");
    c.depth--;
    line(c, "}");
    return m;
  }
  switch (term.op) {
    case O.Branch: return branch(c, b.label, w[0], stack).next;
    case O.BranchConditional: {
      const [cond, t1, f1] = [w[0], w[1], w[2]];
      if (merge?.op === O.SelectionMerge) {
        const m = merge.w[0], inner: Construct[] = [...stack, { kind: "if", merge: m }];
        line(c, `if (${value(c, cond)}) {`);
        c.depth++; emitArm(c, b.label, t1, inner, m); c.depth--;
        if (f1 !== m || (c.phis.get(m) ?? []).length) { line(c, "} else {"); c.depth++; emitArm(c, b.label, f1, inner, m); c.depth--; }
        line(c, "}");
        // a merge block a phi or break left unreached is still where the code goes on
        return stop.has(m) ? null : m;
      }
      // a conditional break or continue
      line(c, `if (${value(c, cond)}) {`);
      c.depth++; const a = branch(c, b.label, t1, stack); if (a.next !== null) emitRegion(c, a.next, stack, stop); c.depth--;
      line(c, "} else {");
      c.depth++; const e = branch(c, b.label, f1, stack); if (e.next !== null) emitRegion(c, e.next, stack, stop); c.depth--;
      line(c, "}");
      return null;
    }
    case O.Switch: {
      if (merge?.op !== O.SelectionMerge) throw new Error("SPIR-V: a switch without a merge");
      const m = merge.w[0], signed = c.t.signed(c.t.resultType.get(w[0])!), inner: Construct[] = [...stack, { kind: "switch", merge: m }];
      const cases = new Map<number, number[]>();
      for (let k = 2; k < w.length; k += 2) cases.set(w[k + 1], [...(cases.get(w[k + 1]) ?? []), w[k]]);
      line(c, `switch (${value(c, w[0])}) {`);
      c.depth++;
      for (const [target, lits] of cases) {
        line(c, `case ${lits.map((l) => signed ? `${l | 0}i` : `${l >>> 0}u`).join(", ")}${target === w[1] ? ", default" : ""}: {`);
        c.depth++; emitArm(c, b.label, target, inner, m); c.depth--;
        line(c, "}");
      }
      if (!cases.has(w[1])) { line(c, "default: {"); c.depth++; emitArm(c, b.label, w[1], inner, m); c.depth--; line(c, "}"); }
      c.depth--;
      line(c, "}");
      return stop.has(m) ? null : m;
    }
    case O.Return: line(c, "return;"); return null;
    case O.ReturnValue: line(c, `return ${as(c, w[0], c.fn.ret)};`); return null;
    case O.Kill: case O.TerminateInvocation: line(c, "discard;"); return null;
    case O.Unreachable: return null;
    default: throw new Error(`SPIR-V: terminator ${term.op}`);
  }
}
function emitArm(c: Ctx, from: number, target: number, stack: Construct[], merge: number): void {
  const r = branch(c, from, target, stack);
  if (r.next !== null && r.next !== merge) emitRegion(c, r.next, stack, new Set([merge]));
}
function emitBody(c: Ctx, from: number, target: number, stack: Construct[], cont: number): void {
  const r = branch(c, from, target, stack);
  if (r.next !== null && r.next !== cont) emitRegion(c, r.next, stack, new Set([cont]));
}
function emitContinue(c: Ctx, start: number, loop: Extract<Construct, { kind: "loop" }>, stack: Construct[]): void {
  let label: number | null = start;
  while (label !== null) {
    if (c.done.has(label)) throw new Error(`SPIR-V: block %${label} reached twice`);
    c.done.add(label);
    const b: Block = c.fn.blocks.get(label)!;
    for (const i of b.insts) if (i.op !== O.Phi) emitInst(c, i);
    const term = b.term;
    if (term.op === O.Branch) label = branch(c, b.label, term.w[0], stack).next;
    else if (term.op === O.BranchConditional) {
      const [cond, t1, f1] = [term.w[0], term.w[1], term.w[2]];
      if (b.merge) { label = emitTerminator(c, b, stack, new Set([loop.header])); continue; }
      // the back edge or the loop's exit
      const phisOf = (to: number) => (c.phis.get(to) ?? []).flatMap((phi) => { const out: string[] = []; for (let k = 2; k < phi.w.length; k += 2) if (phi.w[k + 1] === b.label) out.push(`x_${phi.w[1]} = ${value(c, phi.w[k])};`); return out; });
      for (const s of [...phisOf(t1), ...phisOf(f1)]) line(c, s);
      if (t1 === loop.header && f1 === loop.merge) line(c, `break if !(${value(c, cond)});`);
      else if (f1 === loop.header && t1 === loop.merge) line(c, `break if ${value(c, cond)};`);
      else throw new Error("SPIR-V: a continue construct ending other than in its back edge");
      label = null;
    } else throw new Error("SPIR-V: a continue construct ending other than in a branch");
  }
}
