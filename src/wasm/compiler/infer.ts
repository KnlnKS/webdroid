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
import type { PreparedInstruction, PreparedMethod } from "../../jvm/prepared.ts";
import { buildCfg } from "./cfg.ts";
import { isInvoke, isInstanceInvoke } from "./opinfo.ts";

export const I = 1, F = 2, R = 4, J = 8, D = 16;
const N32 = I | F | R, WIDE = J | D;
const kc = (c: string) => (c === "L" || c === "[" ? R : c === "J" ? J : c === "D" ? D : c === "F" ? F : I);

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
}

/** analysis of the method, or why it was skipped */
function analyzeWebs(dex: DexFile, code: CodeItem, desc: string, isStatic: boolean, prepared: PreparedMethod): WebAnalysis | string {
  const R_ = code.regs, ins = prepared.instructions;
  if (!ins.length) return "empty";
  for (const x of ins) if (x.op >= 0xe3 && x.op <= 0xf2) return "quickened";
  const cfg = buildCfg(code, prepared), handlerOfIdx = cfg.handlers;
  const n = ins.length;
  if (cfg.n * R_ > 30_000_000 || n * R_ > 150_000_000) return "too-large";

  // ---- per-instruction effects
  const sig = parseMethodDesc(desc);
  const retMask = kc(sig.ret[0]);
  const effs: Eff[] = new Array(n);
  for (let i = 0; i < n; i++) effs[i] = effect(dex, ins[i], i ? ins[i - 1] : null, retMask);

  // ---- liveness (block live-in bitsets of W words), handler edges treated as successors
  const B = cfg.n, W = (R_ + 31) >> 5;
  const liveIn = new Int32Array(B * W);
  const preds: number[][] = new Array(B), work: number[] = new Array(B), inWork = new Uint8Array(B).fill(1);
  for (let b = 0; b < B; b++) { preds[b] = []; work[b] = B - 1 - b; }
  for (let b = 0; b < B; b++) { for (const s of cfg.succ[b]) preds[s].push(b); for (const s of cfg.hsucc[b]) preds[s].push(b); }
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
  const liveOut = (b: number) => { tmp.fill(0); for (const s of cfg.succ[b]) orLive(s); };
  while (work.length) {
    const b = work.pop()!; inWork[b] = 0;
    liveOut(b);
    for (let i = cfg.lastIdx[b]; i >= cfg.firstIdx[b]; i--) stepLive(i);
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
    const m = kc(t[0]);
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
    for (let i = cfg.firstIdx[b]; i <= cfg.lastIdx[b]; i++) {
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
    for (const s of cfg.succ[b]) joinInto(s, st);
  }
  const ranges = (visit: (node: number, instruction: number) => void) => {
    const touch = (node: number, i: number) => { if (node >= 0) visit(find(node), i); };
    for (const node of paramNode) touch(node, 0);
    for (let b = 0; b < B; b++) {
      if (!inState[b]) continue;
      st.set(inState[b]!);
      for (const r of liveList[b]) touch(st[r], cfg.firstIdx[b]);
      for (let i = cfg.firstIdx[b]; i <= cfg.lastIdx[b]; i++) {
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
      for (const successor of cfg.succ[b]) for (const r of liveList[successor]) touch(st[r], cfg.lastIdx[b]);
    }
  };
  return { pcToIdx: cfg.pcToIdx, mask, vreg, used, find, defNode, useNode, useAt, useSlot, paramNode, links, reached, ranges };
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
  };
}

/** the operand and result kinds of the unary operations 0x7b (neg-int) to 0x8f (int-to-short) */
/** the operand and result kinds of each unary op, neg-int (0x7b) to int-to-short (0x8f) */
export const UNARY: readonly [number, number][] = [
  [I, I], [I, I], [J, J], [J, J], [F, F], [D, D],
  [I, J], [I, F], [I, D], [J, I], [J, F], [J, D],
  [F, I], [F, J], [F, D], [D, I], [D, J], [D, F],
  [I, I], [I, I], [I, I],
];
/** the operations of the binary ops in DEX order: int and long take all eleven, float and double the first five; a literal op's second is rsub */
export const BINOPS = ["add", "sub", "mul", "div", "rem", "and", "or", "xor", "shl", "shr", "ushr"] as const;
export type Binop = (typeof BINOPS)[number];
/** the operand kind and operation of a binary op without a literal (0x90-0xcf, either form) */
export const binopKind = (op: number): number => { const i = (op - 0x90) & 0x1f; return i < 11 ? I : i < 22 ? J : i < 27 ? F : D; };
export const binopName = (op: number): Binop => { const i = (op - 0x90) & 0x1f; return BINOPS[i < 11 ? i : i < 22 ? i - 11 : i < 27 ? i - 22 : i - 27]; };

function effect(dex: DexFile, x: PreparedInstruction, prev: PreparedInstruction | null, retMask: number): Eff {
  const { op, a, b, c } = x;
  const E = (u: number[], d = -1, dm = 0, link = 0): Eff => ({ u, d, dm, link });
  if (op <= 0x00) return NOEFF;
  if (op <= 0x03) return E([b, N32], a, N32, 1);
  if (op <= 0x06) return E([b, WIDE], a, WIDE, 1);
  if (op <= 0x09) return E([b, R], a, R);
  if (op <= 0x0c) {
    let m = N32;
    if (op === 0x0b) m = WIDE; else if (op === 0x0c) m = R;
    if (prev) {
      if (isInvoke(prev.op)) { const r = retOf(dex, prev); if (r) m = kc(r[0]); }
      else if (prev.op === 0x24 || prev.op === 0x25) m = R;
    }
    return E([], a, m);
  }
  if (op === 0x0d) return E([], a, R);
  if (op === 0x0e) return NOEFF;
  if (op === 0x0f) return E([a, retMask & N32 ? retMask : N32]);
  if (op === 0x10) return E([a, retMask & WIDE ? retMask : WIDE]);
  if (op === 0x11) return E([a, R]);
  if (op <= 0x15) return E([], a, b === 0 ? N32 : I | F);
  if (op <= 0x19) return E([], a, WIDE);
  if (op <= 0x1c) return E([], a, R);
  if (op <= 0x1e) return E([a, R]);
  if (op === 0x1f) return E([a, R], a, R);
  if (op <= 0x21) return E([b, R], a, I);
  if (op === 0x22) return E([], a, R);
  if (op === 0x23) return E([b, I], a, R);
  if (op === 0x24 || op === 0x25) {
    const el = kc(dex.type(b)[1] ?? "L");
    return E(x.regs.flatMap((r) => [r, el]));
  }
  if (op <= 0x27) return E([a, R]);
  if (op <= 0x2a) return NOEFF;
  if (op <= 0x2c) return E([a, I]);
  if (op <= 0x2e) return E([b, F, c, F], a, I);
  if (op <= 0x30) return E([b, D, c, D], a, I);
  if (op === 0x31) return E([b, J, c, J], a, I);
  if (op <= 0x37) {
    const eq = op <= 0x33;
    return eq ? E([a, I | R, b, I | R], -1, 0, 2) : E([a, I, b, I]);
  }
  if (op <= 0x3d) return E([a, op <= 0x39 ? I | R : I]);
  if (op >= 0x44 && op <= 0x4a) {
    const m = op === 0x44 ? I | F : op === 0x45 ? WIDE : op === 0x46 ? R : I;
    return E([b, R, c, I], a, m);
  }
  if (op >= 0x4b && op <= 0x51) {
    const m = op === 0x4b ? I | F : op === 0x4c ? WIDE : op === 0x4d ? R : I;
    return E([a, m, b, R, c, I]);
  }
  if (op >= 0x52 && op <= 0x58) return E([b, R], a, kc(dex.type(dex.field(c).type)[0]));
  if (op >= 0x59 && op <= 0x5f) return E([a, kc(dex.type(dex.field(c).type)[0]), b, R]);
  if (op >= 0x60 && op <= 0x66) return E([], a, kc(dex.type(dex.field(b).type)[0]));
  if (op >= 0x67 && op <= 0x6d) return E([a, kc(dex.type(dex.field(b).type)[0])]);
  if (isInvoke(op)) {
    const u: number[] = [];
    let params: string[] = [];
    try {
      if (op === 0xfa || op === 0xfb) params = dex.protoParamTypes(c);
      else if (op === 0xfc || op === 0xfd) params = dex.protoParamTypes(dex.callSiteProto(b));
      else params = dex.protoParamTypes(dex.method(b).proto);
    } catch { return E(x.regs.flatMap((r) => [r, N32])); }
    let k = 0;
    if (isInstanceInvoke(op)) u.push(x.regs[k++], R);
    for (const t of params) { const m = kc(t[0]); if (x.regs[k] === undefined) break; u.push(x.regs[k], m); k += m & WIDE ? 2 : 1; }
    return E(u);
  }
  if (op >= 0x7b && op <= 0x8f) { const [from, to] = UNARY[op - 0x7b]; return E([b, from], a, to); }
  if (op >= 0x90 && op <= 0xcf) {
    const two = op >= 0xb0, t = binopKind(op), name = binopName(op);
    const src2 = t === J && (name === "shl" || name === "shr" || name === "ushr") ? I : t;
    return two ? E([a, t, b, src2], a, t) : E([b, t, c, src2], a, t);
  }
  if (op >= 0xd0 && op <= 0xe2) return E([b, I], a, I);
  if (op >= 0xfe) return E([], a, R);
  return NOEFF;
}

function retOf(dex: DexFile, x: PreparedInstruction): string | null {
  try {
    if (x.op === 0xfa || x.op === 0xfb) return dex.type(dex.proto(x.c).ret);
    if (x.op === 0xfc || x.op === 0xfd) return dex.type(dex.proto(dex.callSiteProto(x.b)).ret);
    return dex.type(dex.proto(dex.method(x.b).proto).ret);
  } catch { return null; }
}
