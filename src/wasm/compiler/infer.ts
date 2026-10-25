// Register typing by live-range webs, for the compiler's local allocation.
//
// Method: live-range webs. Every definition (parameter or instruction) is a node; at control-flow
// joins the nodes of a LIVE register are unioned (so a web is a maximal live range, like an SSA
// phi-web), and each node carries a bitmask of kinds the def/uses allow. Moves and if-eq ties
// link kinds without merging live ranges. A web whose mask ends at 0 is a true conflict; a web
// whose mask keeps several bits (a constant never constrained by a use) is "underdetermined".
// Kinds: I = int-like (boolean/byte/short/char/int), F float, R reference (or null), J long, D double.
import { parseMethodDesc } from "../../jvm/abi.ts";
import type { CodeItem, DexFile } from "../../jvm/dex.ts";
import { argRegisters, invokeProto, type PreparedInstruction, type PreparedMethod } from "../../jvm/prepared.ts";
import { BINOPS, Family, familyOf, isInstanceInvoke, isInvoke, typeLetter, variantOf } from "../../jvm/opcodes.ts";
import { OP } from "./code.ts";
import { T, type VT } from "./wasmbin.ts";
import type { Kind } from "./program.ts";

export const I = 1, F = 2, R = 4, J = 8, D = 16;
const N32 = I | F | R, WIDE = J | D;
/** the kind of a value of type `desc` */
export const valueKind = (desc: string) => { const c = desc[0]; return c === "L" || c === "[" ? R : c === "J" ? J : c === "D" ? D : c === "F" ? F : I; };
/** by kind: the Wasm type a value is held in, its kind in the bits ABI, and for F and D the reinterpretations to and from those bits */
export const KINDS: { readonly [k: number]: { vt: VT; abi: Kind; toBits?: number; fromBits?: number } } = {
  [I]: { vt: T.i32, abi: "I" }, [R]: { vt: T.anyref, abi: "L" }, [J]: { vt: T.i64, abi: "J" },
  [F]: { vt: T.f32, abi: "I", toBits: OP.i32_reinterpret_f32, fromBits: OP.f32_reinterpret_i32 },
  [D]: { vt: T.f64, abi: "J", toBits: OP.i64_reinterpret_f64, fromBits: OP.f64_reinterpret_i64 },
};

interface Eff { u: number[]; d: number; dm: number; link: number }
const NOEFF: Eff = { u: [], d: -1, dm: 0, link: 0 };

/** The webs of one method: nodes are definitions (parameters included), unioned at joins where the register is live. */
interface WebAnalysis {
  pcToIdx: Int32Array;
  /** per node */
  mask: number[]; vreg: number[]; used: number[];
  find(node: number): number;
  /** the node defined by instruction i (-1: none) */
  defNode: Int32Array;
  /** the node each instruction reads each operand through, at `useAt[i] + slot`; -1 for none */
  useNode: Int32Array;
  useAt: Int32Array;
  useSlot(i: number, reg: number): number;
  /** the node of each parameter register at entry (-1: not a parameter) */
  paramNode: Int32Array;
  /** node pairs whose kinds must agree: moves and if-eq ties */
  links: number[];
  /** instructions the fixpoint reached (an unreachable one has no operand webs) */
  reached: Uint8Array;
  ranges(visit: (node: number, instruction: number) => void): void;
  /** the node register `reg` holds before instruction i, -1 for none */
  holds(i: number, reg: number): number;
}

/** analysis of the method, or why it was skipped */
function analyzeWebs(dex: DexFile, code: CodeItem, desc: string, isStatic: boolean, prepared: PreparedMethod): WebAnalysis | string {
  const R_ = code.regs, ins = prepared.instructions;
  if (!ins.length) return "empty";
  for (const x of ins) if (familyOf(x.op) === Family.None) return "quickened";
  const { first, last, succ, hsucc, handlers: handlerOfIdx } = prepared, B = first.length, n = ins.length;
  if (B * R_ > 30_000_000 || n * R_ > 150_000_000) return "too-large";

  // ---- per-instruction effects
  const sig = parseMethodDesc(desc);
  const retMask = valueKind(sig.ret);
  const effs: Eff[] = new Array(n);
  for (let i = 0; i < n; i++) effs[i] = effect(dex, ins[i], i ? ins[i - 1] : null, retMask);

  // ---- liveness (block live-in bitsets of W words), handler edges treated as successors
  const W = (R_ + 31) >> 5;
  const liveIn = new Int32Array(B * W);
  const preds: number[][] = new Array(B), work: number[] = new Array(B), inWork = new Uint8Array(B).fill(1);
  for (let b = 0; b < B; b++) { preds[b] = []; work[b] = B - 1 - b; }
  for (let b = 0; b < B; b++) { for (const s of succ[b]) preds[s].push(b); for (const s of hsucc[b]) preds[s].push(b); }
  const tmp = new Int32Array(W);
  const orLive = (b: number) => { for (let w = 0, o = b * W; w < W; w++) tmp[w] |= liveIn[o + w]; };
  const set = (r: number, on: boolean) => { if (on) tmp[r >> 5] |= 1 << r; else tmp[r >> 5] &= ~(1 << r); };
  const stepLive = (i: number) => {
    const e = effs[i];
    if (e.d >= 0) { set(e.d, false); if (e.dm & WIDE) set(e.d + 1, false); }
    for (let k = 0; k < e.u.length; k += 2) { const r = e.u[k]; if (r < R_) { set(r, true); if (e.u[k + 1] & WIDE && r + 1 < R_) set(r + 1, true); } }
    // a throwing instruction hands its PRE-state to the handlers
    const hs = handlerOfIdx[i];
    if (hs) for (const h of hs) orLive(h);
  };
  const liveOut = (b: number) => { tmp.fill(0); for (const s of succ[b]) orLive(s); };
  while (work.length) {
    const b = work.pop()!; inWork[b] = 0;
    liveOut(b);
    for (let i = last[b]; i >= first[b]; i--) stepLive(i);
    let changed = 0;
    for (let w = 0, o = b * W; w < W; w++) { changed |= tmp[w] & ~liveIn[o + w]; liveIn[o + w] |= tmp[w]; }
    if (changed) for (const p of preds[b]) if (!inWork[p]) { inWork[p] = 1; work.push(p); }
  }
  const liveList: Int32Array[] = new Array(B), regs = new Int32Array(R_);
  for (let b = 0; b < B; b++) {
    let k = 0;
    for (let r = 0; r < R_; r++) if (liveIn[b * W + (r >> 5)] & (1 << r)) regs[k++] = r;
    liveList[b] = regs.slice(0, k);
  }

  // ---- webs
  const parent: number[] = [], mask: number[] = [], vreg: number[] = [], used: number[] = [];
  const find = (x: number) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const mk = (m: number, r: number) => { parent.push(parent.length); mask.push(m); vreg.push(r); used.push(0); return parent.length - 1; };
  const union = (a: number, b: number) => {
    a = find(a); b = find(b);
    if (a === b) return;
    parent[b] = a; mask[a] &= mask[b]; used[a] |= used[b];
  };
  const defNode = new Int32Array(n).fill(-1);
  const links: number[] = [], linked = new Uint8Array(n);
  const reached = new Uint8Array(n);
  const useAt = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) useAt[i + 1] = useAt[i] + (effs[i].u.length >> 1);
  const useNode = new Int32Array(useAt[n]).fill(-1);
  /** the operand slot through which instruction i reads `reg`, -1 if it does not */
  const useSlot = (i: number, reg: number) => { const u = effs[i].u; for (let k = 0; k < u.length; k += 2) if (u[k] === reg) return k >> 1; return -1; };

  const inState: (Int32Array | null)[] = new Array(B).fill(null);
  const start = new Int32Array(R_).fill(-1);
  const paramNode = new Int32Array(R_).fill(-1);
  let p = R_ - code.ins;
  if (!isStatic) { start[p] = paramNode[p] = mk(R, p); p++; }
  for (const t of sig.params) {
    const m = valueKind(t);
    const node = mk(m, p);
    start[p] = paramNode[p] = node;
    if (m & WIDE) start[p + 1] = node;
    p += m & WIDE ? 2 : 1;
  }
  inState[0] = start;
  const queue = [0]; const queued = new Uint8Array(B); queued[0] = 1;
  const enqueue = (b: number) => { if (!queued[b]) { queued[b] = 1; queue.push(b); } };

  const joinInto = (t: number, st: Int32Array) => {
    let cur = inState[t];
    const live = liveList[t];
    if (!cur) {
      cur = new Int32Array(R_).fill(-1);
      for (let k = 0; k < live.length; k++) cur[live[k]] = st[live[k]];
      inState[t] = cur; enqueue(t); return;
    }
    let changed = false;
    for (let k = 0; k < live.length; k++) {
      const r = live[k], s = st[r], c = cur[r];
      if (s < 0) continue;
      if (c < 0) { cur[r] = s; changed = true; } else if (c !== s) union(c, s);
    }
    if (changed) enqueue(t);
  };

  const cst = (reg: number, m: number, st: Int32Array) => { const w = st[reg]; if (w >= 0) { const r = find(w); mask[r] &= m; used[r] = 1; } };
  let guard = 0;
  // the state through a block, which joinInto copies from
  const st = new Int32Array(R_);
  while (queue.length) {
    const b = queue.pop()!; queued[b] = 0;
    st.set(inState[b]!);
    if (++guard > B * 50 + 1000) return "no-fixpoint";
    for (let i = first[b]; i <= last[b]; i++) {
      const e = effs[i], hs = handlerOfIdx[i];
      reached[i] = 1;
      if (hs) for (const h of hs) joinInto(h, st);
      if (e.u.length) {
        const at = useAt[i];
        for (let k = 0; k < e.u.length; k += 2) if (e.u[k] < R_) { cst(e.u[k], e.u[k + 1], st); useNode[at + (k >> 1)] = st[e.u[k]]; }
      }
      if (e.link === 2 && !linked[i]) {
        const a = st[e.u[0]], c = st[e.u[2]];
        if (a >= 0 && c >= 0) { links.push(a, c); linked[i] = 1; }
      }
      if (e.d >= 0 && e.d < R_) {
        let node = defNode[i];
        if (node < 0) { node = defNode[i] = mk(e.dm, e.d); if (e.link === 1 && st[e.u[0]] >= 0) { links.push(node, st[e.u[0]]); } }
        st[e.d] = node;
        if (e.dm & WIDE && e.d + 1 < R_) st[e.d + 1] = node;
      }
    }
    for (const s of succ[b]) joinInto(s, st);
  }
  const ranges = (visit: (node: number, instruction: number) => void) => {
    const touch = (node: number, i: number) => { if (node >= 0) visit(find(node), i); };
    for (const node of paramNode) touch(node, 0);
    for (let b = 0; b < B; b++) {
      if (!inState[b]) continue;
      st.set(inState[b]!);
      for (const r of liveList[b]) touch(st[r], first[b]);
      for (let i = first[b]; i <= last[b]; i++) {
        if (!reached[i]) continue;
        // EH observes the pre-state even when the normal result overwrites a register.
        const hs = handlerOfIdx[i];
        if (hs) for (const h of hs) for (const r of liveList[h]) touch(st[r], i);
        for (let k = useAt[i]; k < useAt[i + 1]; k++) touch(useNode[k], i);
        const e = effs[i];
        if (e.d >= 0 && e.d < R_) {
          touch(defNode[i], i); st[e.d] = defNode[i];
          if (e.dm & WIDE && e.d + 1 < R_) st[e.d + 1] = defNode[i];
        }
      }
      for (const successor of succ[b]) for (const r of liveList[successor]) touch(st[r], last[b]);
    }
  };
  const holds = (i: number, reg: number) => {
    let j = i;
    while (prepared.blockAt[ins[j].pc] < 0) j--;
    let node = inState[prepared.blockAt[ins[j].pc]]?.[reg] ?? -1;
    for (; j < i; j++) { const e = effs[j]; if (e.d === reg || e.d + 1 === reg && e.dm & WIDE) node = defNode[j]; }
    return node;
  };
  return { pcToIdx: prepared.indexAt, mask, vreg, used, find, defNode, useNode, useAt, useSlot, paramNode, links, reached, ranges, holds };
}

/** Kind components: webs tied by moves and if-eq share a kind; the mask of a component is the intersection of its webs'. */
function componentMask(a: WebAnalysis): (root: number) => number {
  const n = a.mask.length, kp = new Int32Array(n), mask = new Int32Array(n).fill(31);
  for (let i = 0; i < n; i++) kp[i] = i;
  const kf = (x: number) => { while (kp[x] !== x) { kp[x] = kp[kp[x]]; x = kp[x]; } return x; };
  for (let k = 0; k < a.links.length; k += 2) {
    const x = kf(a.find(a.links[k])), c = kf(a.find(a.links[k + 1]));
    if (x !== c) kp[c] = x;
  }
  for (let w = 0; w < n; w++) if (a.find(w) === w) mask[kf(w)] &= a.mask[w];
  return (root) => mask[kf(root)];
}

/** Typed webs and conservative instruction intervals for local storage. */
export interface Typing {
  /** kind (I, F, R, J or D) of each web */
  kind: number[];
  /** Inclusive intervals include definitions, uses, block edges and EH pre-state. */
  ranges(): { start: number[]; end: number[] };
  /** whether the instruction at `pc` can execute at all */
  reached(pc: number): boolean;
  /** the web the instruction at `pc` reads register `reg` through, -1 if it does not */
  use(pc: number, reg: number): number;
  /** the web the instruction at `pc` defines, -1 if it defines none that is ever read */
  def(pc: number): number;
  /** the web of the parameter held in `reg` on entry, -1 if it is never read */
  param(reg: number): number;
  /** the web register `reg` holds where the instruction at `pc` starts, -1 for none that is ever read */
  holds(pc: number, reg: number): number;
}
/** Webs by lowest kind bit left in their component: an unconstrained int/float/null constant is an int. Throws when the code cannot be typed. */
export function inferTyping(dex: DexFile, code: CodeItem, desc: string, isStatic: boolean, prepared: PreparedMethod): Typing {
  const a = analyzeWebs(dex, code, desc, isStatic, prepared);
  if (typeof a === "string") throw new Error("type inference " + a);
  const maskOf = componentMask(a), id = new Int32Array(a.mask.length).fill(-1), kind: number[] = [];
  const web = (node: number): number => {
    if (node < 0) return -1;
    const root = a.find(node);
    if (!a.used[root]) return -1;
    let w = id[root];
    if (w < 0) {
      const m = maskOf(root);
      if (!m) throw new Error("type conflict in v" + a.vreg[root]);
      id[root] = w = kind.length; kind.push(m & -m);
    }
    return w;
  };
  const idxOfPc = a.pcToIdx;
  return {
    kind,
    ranges() {
      const start: number[] = [], end: number[] = [];
      a.ranges((node, i) => { const w = web(node); if (w >= 0) { start[w] = Math.min(start[w] ?? i, i); end[w] = Math.max(end[w] ?? i, i); } });
      return { start, end };
    },
    reached(pc) { return !!a.reached[idxOfPc[pc]]; },
    use(pc, reg) { const i = idxOfPc[pc], k = a.useSlot(i, reg); return k < 0 ? -1 : web(a.useNode[a.useAt[i] + k]); },
    def(pc) { return web(a.defNode[idxOfPc[pc]]); },
    param(reg) { return web(a.paramNode[reg]); },
    holds(pc, reg) { return web(a.holds(idxOfPc[pc], reg)); },
  };
}

/** by the pc of each constructor call `sites` names "init": the registers besides the receiver that hold the object it initializes, copies made after the
 *  allocation `sites` names "alloc" (ART's verifier types them as that allocation until the call; running the allocation again makes another) */
export function uninitAliases(dex: DexFile, code: CodeItem, prepared: PreparedMethod, sites: ReadonlyMap<number, "alloc" | "init">): Map<number, number[]> {
  const { instructions: ins, first, last, succ, hsucc } = prepared, n = code.regs, out = new Map<number, number[]>();
  // by block: the allocation (its instruction index) each register holds on entry, -1 for none; a handler starts with none
  const entry: (Int32Array | undefined)[] = new Array(first.length), none = new Int32Array(n).fill(-1), st = new Int32Array(n);
  const queue = [0], queued = new Uint8Array(first.length);
  entry[0] = none.slice(); queued[0] = 1;
  const join = (b: number, from: Int32Array) => {
    const cur = entry[b];
    let changed = !cur;
    if (!cur) entry[b] = from.slice();
    else for (let r = 0; r < n; r++) if (cur[r] >= 0 && cur[r] !== from[r]) { cur[r] = -1; changed = true; }
    if (changed && !queued[b]) { queued[b] = 1; queue.push(b); }
  };
  const forget = (p: number) => { for (let r = 0; r < n; r++) if (st[r] === p) st[r] = -1; };
  while (queue.length) {
    const b = queue.pop()!; queued[b] = 0; st.set(entry[b]!);
    for (let i = first[b]; i <= last[b]; i++) {
      const x = ins[i], kind = sites.get(x.pc);
      if (kind === "alloc") { forget(i); st[x.a] = i; continue; }
      if (kind === "init") {
        const p = st[x.regs[0]], copies: number[] = [];
        if (p < 0) continue;
        for (let r = 0; r < n; r++) if (st[r] === p && r !== x.regs[0]) copies.push(r);
        if (copies.length) out.set(x.pc, copies); else out.delete(x.pc);
        forget(p);
        continue;
      }
      if (familyOf(x.op) === Family.Move && typeLetter(x.op) === "L") { st[x.a] = st[x.b]; continue; }
      const { d, dm } = effect(dex, x, i ? ins[i - 1] : null, 0);
      if (d >= 0) { st[d] = -1; if (dm & WIDE && d + 1 < n) st[d + 1] = -1; }
    }
    for (const h of hsucc[b]) join(h, none);
    for (const s of succ[b]) join(s, st);
  }
  return out;
}

/** the operand and result kinds of each unary op, neg-int (0x7b) to int-to-short (0x8f) */
export const UNARY: readonly [number, number][] = [
  [I, I], [I, I], [J, J], [J, J], [F, F], [D, D],
  [I, J], [I, F], [I, D], [J, I], [J, F], [J, D],
  [F, I], [F, J], [F, D], [D, I], [D, J], [D, F],
  [I, I], [I, I], [I, I],
];

/** the kind a move, move-result or return of type letter `t` (typeLetter) carries: a 32-bit value is an int, float or reference, a wide one a long or double */
const MOVED: Record<string, number> = { I: N32, J: WIDE, L: R };
/** the kind of an array element aget or aput of type letter `t` reads or writes: aget and aput take an int or float */
const element = (t: string) => (t === "I" ? I | F : t === "J" ? WIDE : t === "L" ? R : I);

function effect(dex: DexFile, x: PreparedInstruction, prev: PreparedInstruction | null, retMask: number): Eff {
  const { op, a, b, c } = x, t = typeLetter(op), family = familyOf(op);
  const E = (u: number[], d = -1, dm = 0, link = 0): Eff => ({ u, d, dm, link });
  switch (family) {
    case Family.Move: return t === "L" ? E([b, R], a, R) : E([b, MOVED[t]], a, MOVED[t], 1);
    case Family.MoveResult: {
      let m = MOVED[t];
      if (prev && isInvoke(prev.op)) { const r = retOf(dex, prev); if (r) m = valueKind(r); }
      else if (prev && familyOf(prev.op) === Family.FilledNewArray) m = R;
      return E([], a, m);
    }
    case Family.Return: return E([a, retMask & MOVED[t] ? retMask : MOVED[t]]);
    case Family.Const: return E([], a, t === "J" ? WIDE : b === 0 ? N32 : I | F);
    case Family.MoveException: case Family.ConstString: case Family.ConstClass: case Family.NewInstance: case Family.ConstMethodHandle: case Family.ConstMethodType:
      return E([], a, R);
    case Family.Monitor: case Family.FillArrayData: case Family.Throw: return E([a, R]);
    case Family.CheckCast: return E([a, R], a, R);
    case Family.InstanceOf: case Family.ArrayLength: return E([b, R], a, I);
    case Family.NewArray: return E([b, I], a, R);
    case Family.FilledNewArray: { const el = valueKind(dex.type(b)[1] ?? "L"); return E(x.regs.flatMap((r) => [r, el])); }
    case Family.Switch: return E([a, I]);
    case Family.Compare: { const m = valueKind(t); return E([b, m, c, m], a, I); }
    // if-eq and if-ne also compare references, and tie their operands' kinds
    case Family.If: return variantOf(op) < 2 ? E([a, I | R, b, I | R], -1, 0, 2) : E([a, I, b, I]);
    case Family.IfZ: return E([a, variantOf(op) < 2 ? I | R : I]);
    case Family.Aget: return E([b, R, c, I], a, element(t));
    case Family.Aput: return E([a, element(t), b, R, c, I]);
    case Family.Iget: return E([b, R], a, valueKind(dex.type(dex.field(c).type)));
    case Family.Iput: return E([a, valueKind(dex.type(dex.field(c).type)), b, R]);
    case Family.Sget: return E([], a, valueKind(dex.type(dex.field(b).type)));
    case Family.Sput: return E([a, valueKind(dex.type(dex.field(b).type))]);
    case Family.Invoke: {
      const u: number[] = [];
      let params: string[] = [];
      try { params = dex.protoParamTypes(invokeProto(dex, x)); } catch { return E(x.regs.flatMap((r) => [r, N32])); }
      const first = isInstanceInvoke(op) ? 1 : 0, regs = argRegisters(x, params, first);
      if (first) u.push(x.regs[0], R);
      for (let i = 0; i < regs.length && regs[i] !== undefined; i++) u.push(regs[i], valueKind(params[i]));
      return E(u);
    }
    case Family.Unary: { const [from, to] = UNARY[variantOf(op)]; return E([b, from], a, to); }
    case Family.Binop: case Family.Binop2addr: {
      const k = valueKind(t), name = BINOPS[variantOf(op)], by = k === J && (name === "shl" || name === "shr" || name === "ushr") ? I : k;
      return family === Family.Binop2addr ? E([a, k, b, by], a, k) : E([b, k, c, by], a, k);
    }
    case Family.BinopLit: return E([b, I], a, I);
    default: return NOEFF;
  }
}

function retOf(dex: DexFile, x: PreparedInstruction): string | null {
  try { return dex.type(dex.proto(invokeProto(dex, x)).ret); } catch { return null; }
}
