// Verifier-style register type inference prototype.
//
// Method: live-range webs. Every definition (parameter or instruction) is a node; at control-flow
// joins the nodes of a LIVE register are unioned (so a web is a maximal live range, like an SSA
// phi-web), and each node carries a bitmask of kinds the def/uses allow. Moves and if-eq ties
// link kinds without merging live ranges. A web whose mask ends at 0 is a true conflict; a web
// whose mask keeps several bits (a constant never constrained by a use) is "underdetermined".
// Kinds: I = int-like (boolean/byte/short/char/int), F float, R reference (or null), J long, D double.
import type { CodeItem, DexFile } from "../../../src/jvm/dex";
import { decodeInstructions, branchTargets, endsBlock, type PreparedInstruction } from "../../../src/jvm/prepared";
import { buildCfg } from "./cfg";
import { NO_THROW, isInvoke, isInstanceInvoke } from "./opinfo";

export const I = 1, F = 2, R = 4, J = 8, D = 16;
const N32 = I | F | R, WIDE = J | D;
export const KIND_NAMES: Record<number, string> = { [I]: "I", [F]: "F", [R]: "R", [J]: "J", [D]: "D" };
const kc = (c: string) => (c === "L" || c === "[" ? R : c === "J" ? J : c === "D" ? D : c === "F" ? F : I);
const pop = (m: number) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1) + ((m >> 4) & 1);

interface Eff { u: number[]; d: number; dm: number; link: number; zero: boolean; fconst: boolean }
const NOEFF: Eff = { u: [], d: -1, dm: 0, link: 0, zero: false, fconst: false };

export interface InferResult {
  skipped?: string;
  regs: number;
  /** used webs (live ranges with at least one use) */
  webs: number;
  deadDefs: number;
  conflicts: number;
  conflictsWithZero: number;
  underdetermined: number;
  underdeterminedZero: number;
  /** vregs holding >=2 kinds at different points, as webs resolve */
  multiKindVregs: number;
  /** ... that stop being multi-kind when webs containing a const-0 def are ignored */
  multiKindOnlyZero: number;
  /** vregs with any live web */
  vregs: number;
  /** wasm local counts */
  localsSplit: number;      // distinct (vreg, kind) pairs, wide counted once
  localsWebs: number;       // one local per live range
  localsUntyped: number;    // every 32-bit vreg an untyped i32 slot (wide takes two)
  localsUntypedWide: number;// i32 per vreg, but one i64 local per wide pair
  kindWebs: Record<string, number>;
  floatConsts: number;
  zeroConstWebs: number;
}

export function inferMethod(dex: DexFile, code: CodeItem, desc: string, isStatic: boolean, instrs?: readonly PreparedInstruction[], constKinds?: Map<number, number>): InferResult {
  const R_ = code.regs;
  const ins = instrs ?? decodeInstructions(code.insns);
  const empty = (skipped: string): InferResult => ({ skipped, regs: R_, webs: 0, deadDefs: 0, conflicts: 0, conflictsWithZero: 0, underdetermined: 0, underdeterminedZero: 0, multiKindVregs: 0, multiKindOnlyZero: 0, vregs: 0, localsSplit: 0, localsWebs: 0, localsUntyped: R_, localsUntypedWide: R_, kindWebs: {}, floatConsts: 0, zeroConstWebs: 0 });
  if (!ins.length) return empty("empty");
  if (ins.some((x) => x.op >= 0xe3 && x.op <= 0xf2)) return empty("quickened");
  const cfg = buildCfg(code, ins);
  const n = ins.length;
  if (cfg.n * R_ > 30_000_000 || n * R_ > 150_000_000) return empty("too-large");

  // ---- per-instruction effects
  const sig = parseDesc(desc);
  const retMask = kc(sig.ret[0]);
  const effs: Eff[] = new Array(n);
  for (let i = 0; i < n; i++) effs[i] = effect(dex, ins[i], i ? ins[i - 1] : null, retMask);

  // handler blocks per instruction (try ranges are disjoint in dex, handlers repeat)
  const handlerOfIdx: (number[] | null)[] = new Array(n).fill(null);
  if (code.tries.length) {
    for (const r of code.tries) {
      const hs: number[] = r.handlers.map(([, h]) => cfg.blockOfIdx[cfg.pcToIdx[h]]);
      if (r.catchAllAddr >= 0) hs.push(cfg.blockOfIdx[cfg.pcToIdx[r.catchAllAddr]]);
      for (let i = Math.max(0, cfg.pcToIdx[r.start]); i < n && ins[i].pc < r.end; i++) if (ins[i].pc >= r.start) handlerOfIdx[i] = hs;
    }
  }

  // ---- liveness (block live-in), handler edges treated as successors
  const B = cfg.n;
  const liveIn: Uint8Array[] = Array.from({ length: B }, () => new Uint8Array(R_));
  const preds: number[][] = Array.from({ length: B }, () => []);
  for (let b = 0; b < B; b++) for (const s of [...cfg.succ[b], ...cfg.hsucc[b]]) preds[s].push(b);
  const work: number[] = Array.from({ length: B }, (_, k) => B - 1 - k), inWork = new Uint8Array(B).fill(1);
  const tmp = new Uint8Array(R_);
  while (work.length) {
    const b = work.pop()!; inWork[b] = 0;
    tmp.fill(0);
    for (const s of cfg.succ[b]) { const l = liveIn[s]; for (let r = 0; r < R_; r++) if (l[r]) tmp[r] = 1; }
    for (let i = cfg.lastIdx[b]; i >= cfg.firstIdx[b]; i--) {
      const e = effs[i];
      if (e.d >= 0) { tmp[e.d] = 0; if (e.dm & WIDE) tmp[e.d + 1] = 0; }
      for (let k = 0; k < e.u.length; k += 2) { const r = e.u[k]; if (r < R_) { tmp[r] = 1; if (e.u[k + 1] & WIDE && r + 1 < R_) tmp[r + 1] = 1; } }
      // a throwing instruction hands its PRE-state to the handlers
      const hs = handlerOfIdx[i];
      if (hs && !NO_THROW[ins[i].op]) for (const h of hs) { const l = liveIn[h]; for (let r = 0; r < R_; r++) if (l[r]) tmp[r] = 1; }
    }
    const cur = liveIn[b];
    let changed = false;
    for (let r = 0; r < R_; r++) if (tmp[r] && !cur[r]) { cur[r] = 1; changed = true; }
    if (changed) for (const p of preds[b]) if (!inWork[p]) { inWork[p] = 1; work.push(p); }
  }
  if (process.env.DBG2) for (let b = 0; b < B; b++) console.log("blk", b, "pc", ins[cfg.firstIdx[b]].pc, "succ", cfg.succ[b].map((x) => ins[cfg.firstIdx[x]].pc).join(","), "h", cfg.hsucc[b].map((x) => ins[cfg.firstIdx[x]].pc).join(","), "live", [...liveIn[b]].map((v, r) => (v ? r : -1)).filter((x) => x >= 0).join(","));
  const liveList = liveIn.map((l) => { const o: number[] = []; for (let r = 0; r < R_; r++) if (l[r]) o.push(r); return Int32Array.from(o); });

  // ---- webs
  const parent: number[] = [], mask: number[] = [], vreg: number[] = [], used: number[] = [], zero: number[] = [], fcon: number[] = [];
  const find = (x: number) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const mk = (m: number, r: number, z: boolean, fc: boolean) => { parent.push(parent.length); mask.push(m); vreg.push(r); used.push(0); zero.push(z ? 1 : 0); fcon.push(fc ? 1 : 0); return parent.length - 1; };
  const union = (a: number, b: number) => {
    a = find(a); b = find(b);
    if (a === b) return;
    parent[b] = a; mask[a] &= mask[b]; used[a] |= used[b]; zero[a] |= zero[b]; fcon[a] |= fcon[b];
  };
  const defNode = new Int32Array(n).fill(-1);
  const links: number[] = [], linked = new Uint8Array(n);

  const inState: (Int32Array | null)[] = new Array(B).fill(null);
  const start = new Int32Array(R_).fill(-1);
  let p = R_ - code.ins;
  if (!isStatic) start[p++] = mk(R, p - 1, false, false);
  for (const t of sig.params) {
    const m = kc(t[0]);
    const node = mk(m, p, false, false);
    start[p] = node;
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
  while (queue.length) {
    const b = queue.pop()!; queued[b] = 0;
    const st = Int32Array.from(inState[b]!);
    if (++guard > B * 50 + 1000) return empty("no-fixpoint");
    for (let i = cfg.firstIdx[b]; i <= cfg.lastIdx[b]; i++) {
      const e = effs[i], x = ins[i];
      const hs = handlerOfIdx[i];
      if (hs && !NO_THROW[x.op]) for (const h of hs) joinInto(h, st);
      for (let k = 0; k < e.u.length; k += 2) if (e.u[k] < R_) cst(e.u[k], e.u[k + 1], st);
      if (e.link === 2 && !linked[i]) {
        const a = st[e.u[0]], c = st[e.u[2]];
        if (a >= 0 && c >= 0) { links.push(a, c); linked[i] = 1; }
      }
      if (e.d >= 0 && e.d < R_) {
        let node = defNode[i];
        if (node < 0) { node = defNode[i] = mk(e.dm, e.d, e.zero, e.fconst); if (e.link === 1 && st[e.u[0]] >= 0) { links.push(node, st[e.u[0]]); } }
        st[e.d] = node;
        if (e.dm & WIDE && e.d + 1 < R_) st[e.d + 1] = node;
      }
    }
    for (const s of cfg.succ[b]) joinInto(s, st);
  }

  // ---- kind components over webs (moves / ties), then results
  const kp = new Map<number, number>();
  const kf = (x: number): number => { let r = kp.get(x) ?? x; while (r !== (kp.get(r) ?? r)) r = kp.get(r) ?? r; return r; };
  const roots = new Set<number>();
  for (let w = 0; w < parent.length; w++) roots.add(find(w));
  for (let k = 0; k < links.length; k += 2) {
    const a = kf(find(links[k])), c = kf(find(links[k + 1]));
    if (a !== c) kp.set(c, a);
  }
  const compMask = new Map<number, number>(), compUsed = new Map<number, number>(), compZero = new Map<number, number>();
  for (const w of roots) {
    const c = kf(w);
    compMask.set(c, (compMask.get(c) ?? 31) & mask[w]);
    compUsed.set(c, (compUsed.get(c) ?? 0) | used[w]);
    compZero.set(c, (compZero.get(c) ?? 0) | zero[w]);
  }
  if (constKinds) for (let i = 0; i < n; i++) { const op = ins[i].op; if (defNode[i] >= 0 && op >= 0x12 && op <= 0x19) constKinds.set(ins[i].pc, compMask.get(kf(find(defNode[i])))!); }
  const res = empty("");
  delete res.skipped;
  let deadDefs = 0, floatConsts = 0, zeroConstWebs = 0;
  const conflictComps = new Set<number>(), undetComps = new Set<number>();
  const perVreg = new Map<number, { det: number; amb: number[]; zeroDet: number; zeroAmb: number }>();
  const kindWebs: Record<string, number> = { I: 0, F: 0, R: 0, J: 0, D: 0, "?": 0 };
  let webs = 0, localsWebs = 0;
  const wideLo = new Set<number>();
  for (const w of roots) {
    const c = kf(w), m = compMask.get(c)!;
    if (!used[w]) { deadDefs++; continue; }
    webs++; localsWebs++;
    if (zero[w]) zeroConstWebs++;
    if (fcon[w] && m === F) floatConsts++;
    if (m === 0) { conflictComps.add(c); if (process.env.DBG) console.log("conflict web", w, "vreg", vreg[w], "defs", [...defNode].map((d, i) => (d >= 0 && find(d) === w ? ins[i].pc : -1)).filter((x) => x >= 0).join(","), "mask", mask[w]); continue; }
    const rec = perVreg.get(vreg[w]) ?? { det: 0, amb: [], zeroDet: 0, zeroAmb: 0 };
    if (pop(m) === 1) { rec.det |= m; if (!zero[w]) rec.zeroDet |= m; kindWebs[KIND_NAMES[m]]++; if (m & WIDE) wideLo.add(vreg[w]); }
    else { rec.amb.push(m); if (compUsed.get(c)) undetComps.add(c); kindWebs["?"]++; }
    perVreg.set(vreg[w], rec);
  }
  // params are used webs only if read; they still occupy a local: count never-read params too
  let multi = 0, multiOnlyZero = 0, localsSplit = 0;
  for (const [, rec] of perVreg) {
    let kinds = rec.det;
    for (const m of rec.amb) { if (!(kinds & m)) kinds |= m & -m; }   // ambiguous webs join an existing kind when they can
    localsSplit += pop(kinds);
    if (pop(kinds) > 1) { multi++; if (pop(rec.zeroDet) <= 1) multiOnlyZero++; }
  }
  const undetZero = [...undetComps].filter((c) => compZero.get(c)).length;
  Object.assign(res, {
    webs, deadDefs, conflicts: conflictComps.size, conflictsWithZero: [...conflictComps].filter((c) => compZero.get(c)).length,
    underdetermined: undetComps.size, underdeterminedZero: undetZero, multiKindVregs: multi, multiKindOnlyZero: multiOnlyZero,
    vregs: perVreg.size, localsSplit, localsWebs, localsUntyped: R_, localsUntypedWide: R_ - wideLo.size, kindWebs, floatConsts, zeroConstWebs,
  });
  return res;
}

function parseDesc(desc: string): { params: string[]; ret: string } {
  const params: string[] = [];
  let i = 1;
  while (desc[i] !== ")") {
    const s = i;
    while (desc[i] === "[") i++;
    if (desc[i] === "L") while (desc[i] !== ";") i++;
    i++;
    params.push(desc.slice(s, i));
  }
  return { params, ret: desc.slice(i + 1) };
}

function effect(dex: DexFile, x: PreparedInstruction, prev: PreparedInstruction | null, retMask: number): Eff {
  const { op, a, b, c } = x;
  const E = (u: number[], d = -1, dm = 0, extra: Partial<Eff> = {}): Eff => ({ u, d, dm, link: 0, zero: false, fconst: false, ...extra });
  if (op <= 0x00) return NOEFF;
  if (op <= 0x03) return E([b, N32], a, N32, { link: 1 });
  if (op <= 0x06) return E([b, WIDE], a, WIDE, { link: 1 });
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
  if (op <= 0x15) return E([], a, b === 0 ? N32 : I | F, { zero: b === 0, fconst: true });
  if (op <= 0x19) return E([], a, WIDE);
  if (op <= 0x1c) return E([], a, R);
  if (op <= 0x1e) return E([a, R]);
  if (op === 0x1f) return E([a, R], a, R);
  if (op === 0x20) return E([b, R], a, I);
  if (op === 0x21) return E([b, R], a, I);
  if (op === 0x22) return E([], a, R);
  if (op === 0x23) return E([b, I], a, R);
  if (op === 0x24 || op === 0x25) {
    const el = kc(dex.type(b)[1] ?? "L");
    return E(x.regs.flatMap((r) => [r, el]));
  }
  if (op === 0x26) return E([a, R]);
  if (op === 0x27) return E([a, R]);
  if (op <= 0x2a) return NOEFF;
  if (op <= 0x2c) return E([a, I]);
  if (op <= 0x2e) return E([b, F, c, F], a, I);
  if (op <= 0x30) return E([b, D, c, D], a, I);
  if (op === 0x31) return E([b, J, c, J], a, I);
  if (op <= 0x37) {
    const eq = op <= 0x33;
    return eq ? E([a, I | R, b, I | R], -1, 0, { link: 2 }) : E([a, I, b, I]);
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
      else if (op === 0xfc || op === 0xfd) params = dex.protoParamTypes((dex.callSite(b)[2] as { idx: number }).idx);
      else params = dex.protoParamTypes(dex.method(b).proto);
    } catch { return E(x.regs.flatMap((r) => [r, N32])); }
    let k = 0;
    if (isInstanceInvoke(op)) u.push(x.regs[k++], R);
    for (const t of params) { const m = kc(t[0]); if (x.regs[k] === undefined) break; u.push(x.regs[k], m); k += m & WIDE ? 2 : 1; }
    return E(u);
  }
  if (op >= 0x7b && op <= 0x8f) {
    const T: Record<number, [number, number]> = {
      0x7b: [I, I], 0x7c: [I, I], 0x7d: [J, J], 0x7e: [J, J], 0x7f: [F, F], 0x80: [D, D],
      0x81: [I, J], 0x82: [I, F], 0x83: [I, D], 0x84: [J, I], 0x85: [J, F], 0x86: [J, D],
      0x87: [F, I], 0x88: [F, J], 0x89: [F, D], 0x8a: [D, I], 0x8b: [D, J], 0x8c: [D, F],
      0x8d: [I, I], 0x8e: [I, I], 0x8f: [I, I],
    };
    const [from, to] = T[op];
    return E([b, from], a, to);
  }
  if (op >= 0x90 && op <= 0xcf) {
    const two = op >= 0xb0, base = two ? op - 0xb0 + 0x90 : op;
    let t: number, shiftTwo = false;
    if (base <= 0x9a) t = I; else if (base <= 0xa5) { t = J; shiftTwo = base >= 0xa3; } else if (base <= 0xaa) t = F; else t = D;
    const src2 = shiftTwo ? I : t;
    return two ? E([a, t, b, src2], a, t) : E([b, t, c, src2], a, t);
  }
  if (op >= 0xd0 && op <= 0xe2) return E([b, I], a, I);
  if (op >= 0xfe) return E([], a, R);
  return NOEFF;
}

function retOf(dex: DexFile, x: PreparedInstruction): string | null {
  try {
    if (x.op === 0xfa || x.op === 0xfb) return dex.type(dex.proto(x.c).ret);
    if (x.op === 0xfc || x.op === 0xfd) return dex.type(dex.proto((dex.callSite(x.b)[2] as { idx: number }).idx).ret);
    return dex.type(dex.proto(dex.method(x.b).proto).ret);
  } catch { return null; }
}
export { retOf, parseDesc };
