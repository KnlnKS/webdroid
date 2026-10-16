// Corpus statistics over the compiler's web analysis (src/wasm/compiler/infer.ts): conflicts, underdetermined webs, multi-kind vregs, local counts.
import type { CodeItem, DexFile } from "../../../src/jvm/dex.ts";
import { decodeInstructions, type PreparedInstruction } from "../../../src/jvm/prepared.ts";
import { analyzeWebs, components, retOf, I, F, R, J, D } from "../../../src/wasm/compiler/infer.ts";

const KIND_NAMES: Record<number, string> = { [I]: "I", [F]: "F", [R]: "R", [J]: "J", [D]: "D" };

export { I, F, R, J, D, KIND_NAMES, retOf };
const WIDE = J | D;
const pop = (m: number) => (m & 1) + ((m >> 1) & 1) + ((m >> 2) & 1) + ((m >> 3) & 1) + ((m >> 4) & 1);

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
  const empty = (skipped: string): InferResult => ({ skipped, regs: R_, webs: 0, deadDefs: 0, conflicts: 0, conflictsWithZero: 0, underdetermined: 0, underdeterminedZero: 0, multiKindVregs: 0, multiKindOnlyZero: 0, vregs: 0, localsSplit: 0, localsWebs: 0, localsUntyped: R_, localsUntypedWide: R_, kindWebs: {}, floatConsts: 0, zeroConstWebs: 0 });
  const a = analyzeWebs(dex, code, desc, isStatic, instrs);
  if (typeof a === "string") return empty(a);
  const comp = components(a), ins = a.ins, { kf } = comp;
  if (constKinds) for (let i = 0; i < ins.length; i++) { const op = ins[i].op; if (a.defNode[i] >= 0 && op >= 0x12 && op <= 0x19) constKinds.set(ins[i].pc, comp.mask.get(kf(a.find(a.defNode[i])))!); }
  const res = empty("");
  delete res.skipped;
  let deadDefs = 0, floatConsts = 0, zeroConstWebs = 0;
  const conflictComps = new Set<number>(), undetComps = new Set<number>();
  const perVreg = new Map<number, { det: number; amb: number[]; zeroDet: number; zeroAmb: number }>();
  const kindWebs: Record<string, number> = { I: 0, F: 0, R: 0, J: 0, D: 0, "?": 0 };
  let webs = 0, localsWebs = 0;
  const wideLo = new Set<number>();
  for (const w of comp.roots) {
    const c = kf(w), m = comp.mask.get(c)!;
    if (!a.used[w]) { deadDefs++; continue; }
    webs++; localsWebs++;
    if (a.zero[w]) zeroConstWebs++;
    if (a.fcon[w] && m === F) floatConsts++;
    if (m === 0) { conflictComps.add(c); continue; }
    const rec = perVreg.get(a.vreg[w]) ?? { det: 0, amb: [], zeroDet: 0, zeroAmb: 0 };
    if (pop(m) === 1) { rec.det |= m; if (!a.zero[w]) rec.zeroDet |= m; kindWebs[KIND_NAMES[m]]++; if (m & WIDE) wideLo.add(a.vreg[w]); }
    else { rec.amb.push(m); if (comp.used.get(c)) undetComps.add(c); kindWebs["?"]++; }
    perVreg.set(a.vreg[w], rec);
  }
  // params are used webs only if read; they still occupy a local: count never-read params too
  let multi = 0, multiOnlyZero = 0, localsSplit = 0;
  for (const [, rec] of perVreg) {
    let kinds = rec.det;
    for (const m of rec.amb) { if (!(kinds & m)) kinds |= m & -m; }   // ambiguous webs join an existing kind when they can
    localsSplit += pop(kinds);
    if (pop(kinds) > 1) { multi++; if (pop(rec.zeroDet) <= 1) multiOnlyZero++; }
  }
  const undetZero = [...undetComps].filter((c) => comp.zero.get(c)).length;
  Object.assign(res, {
    webs, deadDefs, conflicts: conflictComps.size, conflictsWithZero: [...conflictComps].filter((c) => comp.zero.get(c)).length,
    underdetermined: undetComps.size, underdeterminedZero: undetZero, multiKindVregs: multi, multiKindOnlyZero: multiOnlyZero,
    vregs: perVreg.size, localsSplit, localsWebs, localsUntyped: R_, localsUntypedWide: R_ - wideLo.size, kindWebs, floatConsts, zeroConstWebs,
  });
  return res;
}
