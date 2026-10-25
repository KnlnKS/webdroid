// Methods a statically bound call runs in place, as ART's inliner does: a straight-line body (an empty constructor, an accessor, a forwarder, a constructor
// that stores its arguments and calls its super's) becomes its steps, and a static check that returns at once unless its first argument is null (Kotlin's
// parameter checks) that test, calling the method when the argument is null. Stack traces stay the call's: a null receiver throws at the call, as the invoke
// does, and what a step throws or calls carries a frame of the method (Code.inline), so traces and caller-sensitive lookups see it.
import { argRegisters, decodeInstructions, ifTarget, type PreparedInstruction } from "../../jvm/prepared.ts";
import { ACC } from "../../jvm/dex.ts";
import { isWide } from "../../jvm/abi.ts";
import { failed, invokeSite, resolveFieldRef } from "./linkage.ts";
import { Family, Invoke, familyOf, invokeKind, narrowBits, typeLetter, variantOf, wideBits } from "../../jvm/opcodes.ts";
import { STRING } from "./strings.ts";
import type { FieldInfo, MethodInfo, Program } from "./program.ts";
import { isRef } from "./kinds.ts";

type Field = { decl: string; f: FieldInfo };
/** what a body passes on: its `p`th parameter (the receiver is 0), a constant's bits, or the value its `t`th step read or returned */
export type Val = { p: number } | { bits: number | bigint } | { t: number };
/** an operation of a body at its pc: a static field read, which runs where the body has it so class initialization and the value keep their order; a read
 *  or store of a parameter's field; a call of a method that binds statically, an instance one's on the method's own receiver */
export type Step = { pc: number } & ({ sget: Field } | { get: Field; obj: number } | { put: Field; obj: number; v: Val } | { call: MethodInfo; args: Val[] });
export type Seq = { k: "seq"; steps: Step[]; ret?: Val };
export type Trivial = Seq | { k: "check" };

/** what a call of `m` reduces to, if its code is trivial and its references link as the Program resolves them */
export function trivialOf(prog: Program, m: MethodInfo): Trivial | undefined {
  if (!prog.linksStatically(prog.loaderOf(m.cls))) return undefined;
  let t = prog.trivials.get(m);
  if (t === undefined) prog.trivials.set(m, t = classify(prog, m) ?? null);
  return t ?? undefined;
}
/** whether a body does nothing: a call of it only initializes the class of a static method */
export const isEmpty = (t: Trivial | undefined): boolean => t?.k === "seq" && !t.steps.length && !t.ret;

function classify(prog: Program, m: MethodInfo): Trivial | undefined {
  if (!m.codeOff || m.cls === STRING || m.flags & (ACC.SYNCHRONIZED | ACC.DECLARED_SYNCHRONIZED)) return;
  const item = m.dex.code(m.codeOff);
  if (item.tries.length || item.insns.length > 16) return;
  const p0 = item.regs - item.ins, insns = decodeInstructions(item.insns);
  return check(m, p0, insns) ?? straight(prog, m, p0, insns);
}

/** if-nez p0, :done … :done return-void, or if-eqz p0, :more; return-void */
function check(m: MethodInfo, p0: number, insns: PreparedInstruction[]): Trivial | undefined {
  const [a, b] = insns, returns = (x?: PreparedInstruction) => !!x && familyOf(x.op) === Family.ReturnVoid, test = variantOf(a.op);
  if (m.isStatic && m.ret === "V" && isRef(m.params[0] ?? "") && a.a === p0 && familyOf(a.op) === Family.IfZ
    && (test === 1 && returns(insns.find((i) => i.pc === ifTarget(a))) || test === 0 && returns(b))) return { k: "check" };
}

/** static field reads, reads and stores of parameters' fields, at most one call, and a return of a parameter, a constant or a step's value */
function straight(prog: Program, m: MethodInfo, p0: number, insns: PreparedInstruction[]): Seq | undefined {
  // what each register holds, and whether it is the first of a pair
  const regs = new Map<number, [Val, boolean]>(), steps: Step[] = [];
  let r = p0, n = 0, ret: Val | undefined, done = false, called = false, justCalled = false;
  const define = (reg: number, wide: boolean, v: Val) => {
    for (const [at, [, w]] of regs) if (at <= reg + (wide ? 1 : 0) && reg <= at + (w ? 1 : 0)) regs.delete(at);
    regs.set(reg, [v, wide]);
  };
  const param = (wide: boolean) => { define(r, wide, { p: n++ }); r += wide ? 2 : 1; };
  if (!m.isStatic) param(false);
  for (const t of m.params) param(isWide(t));
  const val = (reg: number): Val | undefined => regs.get(reg)?.[0];
  const paramIn = (reg: number): number | undefined => { const v = val(reg); return v && "p" in v ? v.p : undefined; };
  // a constant of a reference is null
  const fits = (v: Val, desc: string) => !("bits" in v) || !isRef(desc) || v.bits === 0;
  const step = (s: Step): Val => ({ t: steps.push(s) - 1 });
  for (const x of insns) {
    const op = x.op, family = familyOf(op), wide = typeLetter(op) === "J", afterCall = justCalled, kind = family === Family.Invoke ? invokeKind(op) : -1;
    justCalled = false;
    if (done) return;
    if (family === Family.MoveResult) { if (!afterCall) return; define(x.a, wide, { t: steps.length - 1 }); }
    else if (family === Family.Const) define(x.a, wide, { bits: wide ? wideBits(op, x.b, x.wideLit) : narrowBits(op, x.b) });
    else if (family === Family.Sget) {
      const f = resolveFieldRef(prog, m.dex, x.b, true, m.cls);
      if (failed(f)) return;
      define(x.a, wide, step({ pc: x.pc, sget: f }));
    } else if (family === Family.Iget || family === Family.Iput) {
      const obj = paramIn(x.b), f = resolveFieldRef(prog, m.dex, x.c, false, m.cls), v = val(x.a);
      if (obj === undefined || failed(f) || f.decl === STRING) return;
      if (family === Family.Iget) { define(x.a, wide, step({ pc: x.pc, get: f, obj })); continue; }
      if (!v || !fits(v, f.f.desc)) return;
      steps.push({ pc: x.pc, put: f, obj, v });
    } else if (kind === Invoke.Super || kind === Invoke.Direct || kind === Invoke.Static) {
      const t = invokeSite(prog, m, x.b, kind).target;
      if (called || t === "clone" || failed(t) || t.cls === STRING || !t.isStatic && (m.isStatic || paramIn(x.regs[0]) !== 0)) return;
      const args: Val[] = t.isStatic ? [] : [{ p: 0 }], regs = argRegisters(x, t.params, args.length);
      for (let i = 0; i < regs.length; i++) { const v = val(regs[i]); if (!v || !fits(v, t.params[i])) return; args.push(v); }
      steps.push({ pc: x.pc, call: t, args });
      called = justCalled = true;
    } else if (family === Family.ReturnVoid) done = true;
    else if (family === Family.Return) {
      ret = val(x.a);
      if (!ret || !fits(ret, m.ret)) return;
      done = true;
    } else return;
  }
  return done ? { k: "seq", steps, ret } : undefined;
}
