// Methods a statically bound call runs in place, as ART's inliner does: a straight-line body (an empty constructor, an accessor, a forwarder, a constructor
// that stores its arguments and calls its super's) becomes its steps, and a static check that returns at once unless its first argument is null (Kotlin's
// parameter checks) that test, calling the method when the argument is null. Stack traces stay the call's: a null receiver throws at the call, as the invoke
// does, and what a step throws or calls carries a frame of the method (Code.inline), so traces and caller-sensitive lookups see it.
import { argRegisters, decodeInstructions, ifTarget, type PreparedInstruction } from "../../jvm/prepared.ts";
import { ACC } from "../../jvm/dex.ts";
import { isWide } from "../../jvm/abi.ts";
import { failed, resolveFieldRef, resolveInvoke } from "./linkage.ts";
import { Invoke, invokeKind, isInvoke, narrowBits, wideBits } from "../../jvm/opcodes.ts";
import { STRING } from "./strings.ts";
import type { FieldInfo, MethodInfo, Program } from "./program.ts";

type Field = { decl: string; f: FieldInfo };
/** what a body passes on: its `p`th parameter (the receiver is 0), a constant's bits, or the value its `t`th step read or returned */
export type Val = { p: number } | { bits: number | bigint } | { t: number };
/** an operation of a body at its pc: a static field read, which runs where the body has it so class initialization and the value keep their order; a read
 *  or store of a parameter's field; a call of a method that binds statically, an instance one's on the method's own receiver */
export type Step = { pc: number } & ({ sget: Field } | { get: Field; obj: number } | { put: Field; obj: number; v: Val } | { call: MethodInfo; args: Val[] });
export type Seq = { k: "seq"; steps: Step[]; ret?: Val };
export type Trivial = Seq | { k: "check" };
const IGET = 0x52, IPUT = 0x59, SGET = 0x60, FIELD_OPS = 7, RETURN_VOID = 0x0e, RETURN = 0x0f, RETURN_OBJECT = 0x11, IF_EQZ = 0x38, IF_NEZ = 0x39;
const isRef = (desc: string) => desc[0] === "L" || desc[0] === "[";

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
  const [a, b] = insns;
  if (m.isStatic && m.ret === "V" && isRef(m.params[0] ?? "") && a.a === p0
    && (a.op === IF_NEZ && insns.find((i) => i.pc === ifTarget(a))?.op === RETURN_VOID || a.op === IF_EQZ && b.op === RETURN_VOID)) return { k: "check" };
}

/** static field reads, reads and stores of parameters' fields, at most one call, and a return of a parameter, a constant or a step's value */
function straight(prog: Program, m: MethodInfo, p0: number, insns: PreparedInstruction[]): Seq | undefined {
  // what each register holds, and whether it is the first of a pair
  const regs = new Map<number, [Val, boolean]>(), steps: Step[] = [], types = prog.typesOf(m.dex);
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
    const op = x.op, afterCall = justCalled, kind = isInvoke(op) ? invokeKind(op) : -1;
    justCalled = false;
    if (done) return;
    if (op >= 0x0a && op <= 0x0c) { if (!afterCall) return; define(x.a, op === 0x0b, { t: steps.length - 1 }); } // move-result
    else if (op >= 0x12 && op <= 0x19) define(x.a, op >= 0x16, { bits: op <= 0x15 ? narrowBits(op, x.b) : wideBits(op, x.b, x.wideLit) });
    else if (op >= SGET && op < SGET + FIELD_OPS) {
      const f = resolveFieldRef(prog, m.dex, x.b, true, m.cls);
      if (failed(f)) return;
      define(x.a, op === SGET + 1, step({ pc: x.pc, sget: f }));
    } else if (op >= IGET && op < IPUT + FIELD_OPS) {
      const obj = paramIn(x.b), f = resolveFieldRef(prog, m.dex, x.c, false, m.cls), v = val(x.a);
      if (obj === undefined || failed(f) || f.decl === STRING) return;
      if (op < IPUT) { define(x.a, op === IGET + 1, step({ pc: x.pc, get: f, obj })); continue; }
      if (!v || !fits(v, f.f.desc)) return;
      steps.push({ pc: x.pc, put: f, obj, v });
    } else if (kind === Invoke.Super || kind === Invoke.Direct || kind === Invoke.Static) {
      const ref = m.dex.method(x.b), declared = types.typeName(ref.cls);
      if (called || declared[0] === "[") return;
      const t = resolveInvoke(prog, kind, declared, ref.name, types.methodDesc(x.b), m.cls);
      if (failed(t) || t.cls === STRING || !t.isStatic && (m.isStatic || paramIn(x.regs[0]) !== 0)) return;
      const args: Val[] = t.isStatic ? [] : [{ p: 0 }], regs = argRegisters(x, t.params, args.length);
      for (let i = 0; i < regs.length; i++) { const v = val(regs[i]); if (!v || !fits(v, t.params[i])) return; args.push(v); }
      steps.push({ pc: x.pc, call: t, args });
      called = justCalled = true;
    } else if (op === RETURN_VOID) done = true;
    else if (op >= RETURN && op <= RETURN_OBJECT) {
      ret = val(x.a);
      if (!ret || !fits(ret, m.ret)) return;
      done = true;
    } else return;
  }
  return done ? { k: "seq", steps, ret } : undefined;
}
