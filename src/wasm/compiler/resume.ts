import { decodeInstructions } from "../../jvm/prepared";
import { ACC, type MethodInfo } from "./program";
import { validateColdSnapshot, type ColdSnapshot } from "../cold/state";
import { R } from "./infer";
import { Compiler } from "./j2w";

export type ResumeState = ColdSnapshot & { readonly method: MethodInfo; readonly activation: object };
export const resumeImports = {
  bits: (s: ResumeState, register: number) => s.bits[register],
  reference: (s: ResumeState, register: number) => s.kinds[register] === 0 ? null : s.references[register],
};
const transferred = new WeakSet<object>();

function boundary(method: MethodInfo, pc: number) {
  const item = method.dex.code(method.codeOff), instructions = decodeInstructions(item.insns);
  const index = instructions.findIndex(i => i.pc === pc), ins = instructions[index];
  if (!ins) throw new Error("invalid resume PC");
  const pending = ins.name.startsWith("move-result") || ins.name === "move-exception";
  const next = pending ? instructions[index + 1]?.pc : pc;
  if (next === undefined) throw new Error("resume after pending value leaves method");
  return { ins, next, pending };
}

function inputs(state: ResumeState, at: ReturnType<typeof boundary>): ResumeState {
  if (!at.pending) return state;
  const kind = at.ins.name === "move-exception" ? "L" : state.result!.kind;
  const value = at.ins.name === "move-exception" ? state.exception!.value : state.result!.value;
  const bits = state.bits.slice(), references = [...state.references], kinds = state.kinds.slice();
  if (kind === "L") { references[at.ins.a] = value; bits[at.ins.a] = 0n; kinds[at.ins.a] = 1; }
  else { bits[at.ins.a] = BigInt(value as number | bigint); references[at.ins.a] = null; kinds[at.ins.a] = 0; }
  return { ...state, pc: at.next, executedPc: at.ins.pc, bits, references, kinds, result: undefined, exception: undefined };
}

export interface ResumeOwnership {
  /** Validate method, strand, handler selection and held monitors before any transfer. */
  validate(state: ResumeState): void;
  /** Retire the cold activation after preflight; exceptions after this point cannot retry it. */
  claim(state: ResumeState): void;
}

/** Validation fails before execution; after transfer even a throw must never restart the cold activation. */
export function takeResume(method: MethodInfo, pc: number, registers: readonly { register: number; kind: number }[], ownership?: ResumeOwnership) {
  const at = boundary(method, pc);
  return (state: ResumeState): ResumeState => {
    if (state.method !== method || state.pc !== pc || !state.activation || typeof state.activation !== "object") throw new Error("resume activation identity mismatch");
    if (transferred.has(state.activation)) throw new Error("cold activation already transferred");
    validateColdSnapshot(state);
    if (!state.uninitialized || state.uninitialized.length || !state.monitors || method.flags & ACC.SYNCHRONIZED) throw new Error("unsupported active resume state");
    if (state.monitors.length && (!ownership || !state.owner)) throw new Error("resume needs monitor ownership validation");
    const validated: unknown = ownership?.validate(state);
    if (validated !== undefined) throw new Error("resume ownership validation must be synchronous");
    const loaded = inputs(state, at);
    for (const { register, kind } of registers) {
      const reference = loaded.kinds[register];
      if (reference !== 0 && reference !== 1) throw new Error("invalid resume register kind");
      if (kind === R ? reference !== 1 && loaded.bits[register] !== 0n : reference !== 0) throw new Error("resume register kind mismatch");
    }
    transferred.add(state.activation);
    const claimed: unknown = ownership?.claim(state);
    if (claimed !== undefined) throw new Error("resume ownership claim must be synchronous");
    return loaded;
  };
}

export function checkedResume(method: MethodInfo, pc: number, registers: readonly { register: number; kind: number }[], entry: (s: ResumeState) => unknown, ownership?: ResumeOwnership) {
  const take = takeResume(method, pc, registers, ownership);
  return (state: ResumeState) => entry(take(state));
}

export function resumeUnit(cx: Compiler, method: MethodInfo, pc: number) {
  const built = cx.buildResume(method, boundary(method, pc).next);
  if (cx.gaps.length) throw new Error(`cannot compile resume entry: ${cx.gaps.join("; ")}`);
  return { cx, built, imports: { resume: resumeImports },
    take: (ownership: ResumeOwnership) => takeResume(method, pc, built.registers, ownership),
    bind: (entry: (state: ResumeState) => unknown, ownership?: ResumeOwnership) => checkedResume(method, pc, built.registers, entry, ownership) };
}
