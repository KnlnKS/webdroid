// §4.6: a throwable that a handler discards unread needs no stack trace, and capturing one costs
// V8 a summary of every frame (about 4.5 µs of a 6.3 µs failed Integer.parseInt). A call site
// qualifies when every handler of its try item discards the exception (never reads the register
// move-exception wrote) and nothing the call reaches can observe or keep a throwable: platform
// bytecode whose own handlers discard, that stores no reference a throwable could be, that
// constructs only throwables keeping Throwable's fillInStackTrace, and that calls only such code or
// the natives listed here. While the call runs, `R.quiet.types` names the handled classes and
// captureStack skips throwables of those classes; the call's return or throw, a suspension and
// class initialization (arbitrary code) clear it. The analysis links and compiles nothing, so a
// call qualifies only once what it reaches has run (a hot compile, past 32 cold calls).

import type { CodeItem, DexFile } from "./dex";
import type { ClassInfo, Runtime } from "./runtime";
import type { LazyMethod } from "./compiler";
import { descToName, mangleMethod } from "./abi";
import { branchTargets, decodeInstructions, endsBlock, writesRegister, type PreparedInstruction as Ins } from "./prepared";

const FINAL = 0x10, PRIVATE = 0x2;
/** methods, as a call names them, that observe and keep no throwable: String and StringBuilder
 *  are final, and Throwable's constructors (direct calls) reach fillInStackTrace, which the
 *  constructing new-instance checks */
const PURE = new Set([
  ...["length()I", "charAt(I)C", "isEmpty()Z", "trim()Ljava/lang/String;", "indexOf(I)I", "indexOf(II)I",
    "indexOf(Ljava/lang/String;)I", "indexOf(Ljava/lang/String;I)I", "startsWith(Ljava/lang/String;)Z",
    "startsWith(Ljava/lang/String;I)Z", "substring(I)Ljava/lang/String;", "substring(II)Ljava/lang/String;",
    "equals(Ljava/lang/Object;)Z", "toString()Ljava/lang/String;"].map((s) => "java/lang/String." + s),
  ...["<init>()V", "<init>(I)V", "<init>(Ljava/lang/String;)V", "append(Ljava/lang/String;)Ljava/lang/StringBuilder;",
    "append(C)Ljava/lang/StringBuilder;", "append(I)Ljava/lang/StringBuilder;", "append(J)Ljava/lang/StringBuilder;",
    "toString()Ljava/lang/String;"].map((s) => "java/lang/StringBuilder." + s),
  "java/lang/Throwable.<init>()V", "java/lang/Throwable.<init>(Ljava/lang/String;)V", "java/lang/Character.digitImpl(II)I",
  "java/lang/Object.<init>()V",
]);
const M_FILL = mangleMethod("fillInStackTrace", "()Ljava/lang/Throwable;");

const invokeLike = (ins: Ins) => ins.fmt === "35c" || ins.fmt === "3rc" || ins.fmt === "45cc" || ins.fmt === "4rcc";
function registers(ins: Ins): readonly number[] {
  if (invokeLike(ins)) return ins.regs;
  switch (ins.fmt) {
    case "23x": return [ins.a, ins.b, ins.c];
    case "12x": case "22x": case "32x": case "22b": case "22t": case "22s": case "22c": return [ins.a, ins.b];
    case "10x": case "10t": case "20t": case "30t": return [];
    default: return [ins.a];
  }
}
/** the register an instruction only writes, else -1 */
const written = (ins: Ins) => !invokeLike(ins) && writesRegister(ins.op) && !(ins.op >= 0xb0 && ins.op <= 0xcf) ? ins.a : -1;

/** Does the handler at `pc` never read the exception? Every path from its move-exception is
 *  followed until it overwrites that register; a read of it, or of a wide pair holding it, fails,
 *  but for rethrowing it when `rethrows` (a synchronized block's handler, inside a callee). */
function discards(code: CodeItem, at: Map<number, Ins>, pc: number, rethrows = false): boolean {
  const first = at.get(pc);
  if (!first) return false;
  if (first.op !== 0x0d) return true;
  const x = first.a, seen = new Set<number>(), work = [pc + first.len];
  while (work.length) {
    const next = work.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const ins = at.get(next);
    if (!ins) return false;
    if (rethrows && ins.op === 0x27 && ins.a === x) continue;
    const regs = registers(ins), dest = written(ins);
    for (let k = dest < 0 ? 0 : 1; k < regs.length; k++) if (regs[k] === x || regs[k] === x - 1) return false;
    if (dest === x) continue;
    work.push(...branchTargets(code, ins));
    if (!endsBlock(ins.op)) work.push(next + ins.len);
    for (const t of code.tries) if (next >= t.start && next < t.end) work.push(...handlersOf(t));
  }
  return true;
}
const handlersOf = (t: CodeItem["tries"][number]) => t.catchAllAddr < 0 ? t.handlers.map(([, h]) => h) : [...t.handlers.map(([, h]) => h), t.catchAllAddr];
/** a class of the boot class path, the same in every loader */
const platform = (R: Runtime, cls: string) => R.platformClasses.has(cls) || R.natives.has(cls);
/** A platform class already linked and compiled (its methods and supers' installed). The analysis
 *  links and compiles nothing: that could stub, and report, a class the realm lacks. */
function linked(R: Runtime, cls: string): ClassInfo | undefined {
  if (!platform(R, cls)) return undefined;
  for (let r: Runtime | null = R; r; r = r.parent) {
    const info = r.classes.get(cls);
    if (info) return info.compiled || info.native ? info : undefined;
  }
}
const byPc = (instructions: readonly Ins[]) => new Map(instructions.map((i) => [i.pc, i]));

/** Per try item, its handlers' classes joined by "|" when every handler discards and each class
 *  is the platform's (the same class in every loader), else null. */
export function discardedTypes(R: Runtime, dex: DexFile, code: CodeItem, instructions: readonly Ins[]): (string | null)[] {
  const at = byPc(instructions);
  return code.tries.map((t) => {
    const names = t.handlers.map(([type]) => descToName(dex.type(type)));
    if (t.catchAllAddr >= 0) names.push("java/lang/Throwable");
    return names.every((n) => platform(R, n)) && handlersOf(t).every((h) => discards(code, at, h)) ? names.join("|") : null;
  });
}

const verdicts = new WeakMap<LazyMethod, boolean>();
/** Can a call of method `methodIdx` (by invoke opcode `op`) run only code that keeps and
 *  observes no throwable? */
export function transparentCall(R: Runtime, dex: DexFile, methodIdx: number, op: number): boolean {
  const ref = dex.method(methodIdx), cls = descToName(dex.type(ref.cls)), sig = ref.name + dex.methodDesc(methodIdx);
  if (PURE.has(`${cls}.${sig}`)) return true;
  for (let info = linked(R, cls) ?? null; info; info = info.superInfo) {
    const methods = info.native ? R.natives.get(info.name)?.methods : undefined;
    if (methods?.[sig] || methods?.["static " + sig]) return false;
    const rec = info.lazy?.find((r) => r.name + r.desc === sig);
    if (!rec) continue;
    // a virtual call reaches this body only if nothing can override it
    const exact = (op >= 0x6f && op <= 0x71) || (op >= 0x75 && op <= 0x77) || (info.flags & FINAL) || (rec.m.flags & (FINAL | PRIVATE));
    if (!exact || rec.fallthrough) return false;
    if (!rec.m.codeOff) return PURE.has(`${info.name}.${sig}`);
    let verdict = verdicts.get(rec);
    if (verdict === undefined) {
      verdicts.set(rec, false);  // a recursive call is not assumed to qualify
      verdicts.set(rec, verdict = transparentBody(R, rec.dex, rec.dex.code(rec.m.codeOff)));
    }
    return verdict;
  }
  return false;
}

function transparentBody(R: Runtime, dex: DexFile, code: CodeItem): boolean {
  const instructions = decodeInstructions(code.insns), at = byPc(instructions);
  if (!code.tries.every((t) => handlersOf(t).every((h) => discards(code, at, h, true)))) return false;
  return instructions.every((ins) => {
    const op = ins.op;
    if (op === 0x4d || op > 0xe2) return false;  // aput-object, invoke-polymorphic/custom
    if (op === 0x5b || op === 0x69) return holdsNoThrowable(R, dex.type(dex.field(op === 0x5b ? ins.c : ins.b).type));
    if (op === 0x24 || op === 0x25) return dex.type(ins.b).length === 2;
    if (op === 0x22) return keepsCapture(R, descToName(dex.type(ins.b)));
    if ((op >= 0x6e && op <= 0x72) || (op >= 0x74 && op <= 0x78)) return transparentCall(R, dex, ins.b, op);
    return true;
  });
}

/** Can no throwable be where `type` is declared? A primitive or primitive array, or a class other
 *  than Object that is not a throwable; an interface could be a throwable's. */
export function holdsNoThrowable(R: Runtime, type: string): boolean {
  if (type.length === 1) return true;
  if (type[0] === "[") return type.length === 2;
  const info = linked(R, descToName(type));
  return !!info && info.name !== "java/lang/Object" && !info.isInterface && !info.types.has("java/lang/Throwable");
}

/** a class that is no throwable, or one whose fillInStackTrace is Throwable's own */
function keepsCapture(R: Runtime, cls: string): boolean {
  const info = linked(R, cls);
  return !!info && (!info.types.has("java/lang/Throwable") || info.ctor.prototype[M_FILL] === linked(R, "java/lang/Throwable")?.ctor.prototype[M_FILL]);
}
