import { decodeInstructions, type PreparedInstruction } from "../../jvm/prepared";
import type { CodeItem } from "../../jvm/dex";
import type { Kind, MethodInfo } from "../compiler/program";
import type { Strand } from "../link/sched";

/** A committed DEX boundary. pc is the next instruction, executedPc the last
 * attempted instruction; a throwing instruction leaves its destination intact. */
export interface ColdSnapshot {
  readonly item: CodeItem;
  readonly method?: MethodInfo;
  readonly owner?: Strand;
  pc: number;
  executedPc: number;
  edges: number;
  sync: boolean;
  /** Caller depth before this activation is charged; compiled resume replaces that charge. */
  depth: number;
  bits: BigInt64Array;
  references: unknown[];
  kinds: Uint8Array;
  result?: { pc: number; kind: Kind; value: unknown };
  exception?: { pc: number; value: object };
  uninitialized: { reference: object; type: string; pc: number }[];
  monitors: { object: object; count: number }[];
}

const boundaries = new WeakMap<CodeItem, Map<number, PreparedInstruction>>();
function code(item: CodeItem): Map<number, PreparedInstruction> {
  let found = boundaries.get(item);
  if (!found) boundaries.set(item, found = new Map(decodeInstructions(item.insns).map(ins => [ins.pc, ins])));
  return found;
}

/** Used by interpreter restoration, slow execution and compiled resume entries. */
export function validateColdSnapshot(snapshot: ColdSnapshot, item = snapshot.item): void {
  if (snapshot.item !== item) throw new Error("cold snapshot belongs to a different method");
  if (snapshot.method) {
    const actual = snapshot.method.dex.code(snapshot.method.codeOff);
    if (actual.insns.buffer !== item.insns.buffer || actual.insns.byteOffset !== item.insns.byteOffset || actual.insns.length !== item.insns.length) throw new Error("cold snapshot method identity mismatch");
  }
  const instructions = code(item);
  if (!instructions.has(snapshot.pc) || !instructions.has(snapshot.executedPc)) throw new Error("cold snapshot is not at a DEX instruction boundary");
  if (snapshot.bits.length !== item.regs || snapshot.references.length !== item.regs || snapshot.kinds.length !== item.regs)
    throw new Error("cold snapshot register count mismatch");
  if (!Number.isInteger(snapshot.depth) || snapshot.depth < 0 || snapshot.depth > 0x7fffffff) throw new Error("invalid cold logical depth");
  if (typeof snapshot.sync !== "boolean") throw new Error("invalid cold suspension policy");
  if (!Number.isInteger(snapshot.edges) || snapshot.edges < 0 || snapshot.edges > 0x7fffffff) throw new Error("invalid cold snapshot edge count");
  for (let i = 0; i < item.regs; i++) if (snapshot.kinds[i] !== 0 && snapshot.kinds[i] !== 1) throw new Error("invalid cold snapshot register kind");
  const ins = instructions.get(snapshot.pc)!;
  if (snapshot.result) {
    const producer = instructions.get(snapshot.result!.pc);
    if (!producer || !/^(invoke|filled-new-array)/.test(producer.name) || producer.pc + producer.len !== snapshot.pc || snapshot.executedPc !== producer.pc)
      throw new Error("invalid pending cold result boundary");
    const expected = ins.name === "move-result-object" ? "L" : ins.name === "move-result-wide" ? "J" : "I";
    if (!ins.name.startsWith("move-result") || snapshot.result.kind !== expected) throw new Error("incompatible pending cold result");
    if (expected === "J" ? typeof snapshot.result.value !== "bigint" : expected === "I" &&
        (typeof snapshot.result.value !== "number" || !Number.isInteger(snapshot.result.value) || snapshot.result.value < -2147483648 || snapshot.result.value > 2147483647))
      throw new Error("invalid pending cold result value");
  } else if (ins.name.startsWith("move-result")) throw new Error("missing pending cold result");
  if (snapshot.exception) {
    if (ins.name !== "move-exception" || snapshot.exception.pc !== snapshot.executedPc || !snapshot.exception.value ||
        !item.tries.some(t => snapshot.exception!.pc >= t.start && snapshot.exception!.pc < t.end &&
          (t.catchAllAddr === snapshot.pc || t.handlers.some(h => h[1] === snapshot.pc)))) throw new Error("invalid pending cold exception boundary");
  } else if (ins.name === "move-exception") throw new Error("missing pending cold exception");
  for (const allocation of snapshot.uninitialized) if (!allocation.reference || allocation.type !== "java/lang/String" || !instructions.has(allocation.pc)) throw new Error("invalid cold uninitialized allocation");
  const objects = new Set<object>();
  for (const monitor of snapshot.monitors) {
    if (!monitor.object || !Number.isInteger(monitor.count) || monitor.count < 1 || objects.has(monitor.object) || !snapshot.owner)
      throw new Error("invalid cold monitor ownership");
    objects.add(monitor.object);
  }
}
