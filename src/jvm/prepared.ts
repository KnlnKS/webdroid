import { isWide, parseMethodDesc } from "./abi";
import type { CodeItem, DexFile } from "./dex";
import { FMT_LEN, OPS, insnLen, type Fmt } from "./opcodes";

export interface PreparedInstruction {
  readonly pc: number;
  readonly op: number;
  readonly name: string;
  readonly fmt: Fmt;
  readonly len: number;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly regs: readonly number[];
  readonly wideLit: bigint;
  readonly constKind?: "F" | "D";
  readonly nullRecv?: boolean;
}

export interface PreparedMethod {
  readonly instructions: readonly PreparedInstruction[];
  readonly leaders: Readonly<Uint8Array>;
  readonly params: readonly string[];
  readonly widths: readonly number[];
  readonly sync: boolean;
  readonly wasmEligible: boolean; // diagnostic only; false without an observer
}

export type PreparationPhase = "decode" | "cfg" | "type";
export type PreparationObserver = (phase: PreparationPhase, ms: number) => void;

type MutableInstruction = { -readonly [K in keyof PreparedInstruction]: PreparedInstruction[K] };
type Defs = Map<number, ReadonlySet<MutableInstruction>>;
type ArrayKinds = Map<number, "F" | "D">;

const NO_REGS: readonly number[] = [];
const s4 = (value: number) => (value << 28) >> 28;
const s8 = (value: number) => (value << 24) >> 24;
const s16 = (value: number) => (value << 16) >> 16;

function nibbleRegs(packed: number, firstUnit: number, count: number): number[] {
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = i === 4 ? (firstUnit >> 8) & 0xf : (packed >> (i * 4)) & 0xf;
  return out;
}

function rangeRegs(first: number, count: number): number[] {
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) out[i] = first + i;
  return out;
}

function decode(insns: Uint16Array, pc: number): MutableInstruction {
  const first = insns[pc];
  const op = first & 0xff;
  const entry = OPS[op];
  if (!entry) throw new Error(`bad opcode 0x${op.toString(16)}`);
  const [name, fmt] = entry;
  const ins: MutableInstruction = { pc, op, name, fmt, len: FMT_LEN[fmt], a: 0, b: 0, c: 0, regs: NO_REGS, wideLit: 0n };
  switch (fmt) {
    case "10x": break;
    case "12x": ins.a = (first >> 8) & 0xf; ins.b = first >> 12; break;
    case "11n": ins.a = (first >> 8) & 0xf; ins.b = s4(first >> 12); break;
    case "11x": ins.a = first >> 8; break;
    case "10t": ins.a = s8(first >> 8); break;
    case "20t": ins.a = s16(insns[pc + 1]); break;
    case "22x": ins.a = first >> 8; ins.b = insns[pc + 1]; break;
    case "21t": case "21s": case "21h": ins.a = first >> 8; ins.b = s16(insns[pc + 1]); break;
    case "21c": ins.a = first >> 8; ins.b = insns[pc + 1]; break;
    case "23x": ins.a = first >> 8; ins.b = insns[pc + 1] & 0xff; ins.c = insns[pc + 1] >> 8; break;
    case "22b": ins.a = first >> 8; ins.b = insns[pc + 1] & 0xff; ins.c = s8(insns[pc + 1] >> 8); break;
    case "22t": case "22s": ins.a = (first >> 8) & 0xf; ins.b = first >> 12; ins.c = s16(insns[pc + 1]); break;
    case "22c": ins.a = (first >> 8) & 0xf; ins.b = first >> 12; ins.c = insns[pc + 1]; break;
    case "30t": ins.a = insns[pc + 1] | (insns[pc + 2] << 16); break;
    case "32x": ins.a = insns[pc + 1]; ins.b = insns[pc + 2]; break;
    case "31i": case "31t": ins.a = first >> 8; ins.b = insns[pc + 1] | (insns[pc + 2] << 16); break;
    case "31c": ins.a = first >> 8; ins.b = (insns[pc + 1] | (insns[pc + 2] << 16)) >>> 0; break;
    case "35c":
      ins.a = first >> 12; ins.b = insns[pc + 1]; ins.regs = nibbleRegs(insns[pc + 2], first, ins.a); break;
    case "3rc":
      ins.a = first >> 8; ins.b = insns[pc + 1]; ins.regs = rangeRegs(insns[pc + 2], ins.a); break;
    case "45cc":
      ins.a = first >> 12; ins.b = insns[pc + 1]; ins.c = insns[pc + 3];
      ins.regs = nibbleRegs(insns[pc + 2], first, ins.a); break;
    case "4rcc":
      ins.a = first >> 8; ins.b = insns[pc + 1]; ins.c = insns[pc + 3];
      ins.regs = rangeRegs(insns[pc + 2], ins.a); break;
    case "51l":
      ins.a = first >> 8;
      ins.wideLit = BigInt.asIntN(64,
        BigInt(insns[pc + 1]) | (BigInt(insns[pc + 2]) << 16n) |
        (BigInt(insns[pc + 3]) << 32n) | (BigInt(insns[pc + 4]) << 48n));
      break;
    default: {
      const exhaustive: never = fmt;
      throw new Error(`unhandled instruction format ${exhaustive}`);
    }
  }
  return ins;
}

function decodeInstructions(insns: Uint16Array): MutableInstruction[] {
  const instructions: MutableInstruction[] = [];
  for (let pc = 0; pc < insns.length;) {
    const first = insns[pc];
    if ((first & 0xff) === 0 && (first >> 8) !== 0) { pc += insnLen(insns, pc); continue; }
    const ins = decode(insns, pc);
    instructions.push(ins);
    pc += ins.len;
  }
  return instructions;
}

function endsBlock(op: number): boolean {
  return (op >= 0x0e && op <= 0x11) || op === 0x27 || (op >= 0x28 && op <= 0x2a);
}

function writesRegister(op: number): boolean {
  if (op === 0 || (op >= 0x0e && op <= 0x11) || (op >= 0x1d && op <= 0x1f) ||
      (op >= 0x26 && op <= 0x2c) || (op >= 0x32 && op <= 0x3d) ||
      (op >= 0x4b && op <= 0x51) || (op >= 0x59 && op <= 0x5f) ||
      (op >= 0x67 && op <= 0x78) || op === 0xe9 || op === 0xea ||
      (op >= 0xfa && op <= 0xfd)) return false;
  return true;
}

function maySuspend(op: number): boolean {
  return op === 0x1d || op === 0x22 || op === 0x24 || op === 0x25 ||
    (op >= 0x60 && op <= 0x6d) || (op >= 0x6e && op <= 0x78) ||
    op === 0xe9 || op === 0xea || (op >= 0xfa && op <= 0xfd);
}

function floatingOperands(op: number): { kind: "F" | "D"; unary: boolean } | null {
  if (op === 0x2d || op === 0x2e || (op >= 0xa6 && op <= 0xaa) || (op >= 0xc6 && op <= 0xca)) return { kind: "F", unary: false };
  if (op === 0x2f || op === 0x30 || (op >= 0xab && op <= 0xaf) || (op >= 0xcb && op <= 0xcf)) return { kind: "D", unary: false };
  if (op === 0x7f || (op >= 0x87 && op <= 0x89)) return { kind: "F", unary: true };
  if (op === 0x80 || (op >= 0x8a && op <= 0x8c)) return { kind: "D", unary: true };
  return null;
}

function isWasmNumericOpcode(op: number): boolean {
  return (op >= 0x2d && op <= 0x31) || (op >= 0x7b && op <= 0xe2);
}

function isWasmRegionOpcode(op: number): boolean {
  return op === 0 || (op >= 0x01 && op <= 0x09) || (op >= 0x0e && op <= 0x19) ||
    (op >= 0x28 && op <= 0x2a) || (op >= 0x2d && op <= 0x3d) ||
    (op >= 0x7b && op <= 0xe2);
}

export function ifTarget(instruction: PreparedInstruction): number {
  return instruction.pc + (instruction.fmt === "22t" ? instruction.c : instruction.b);
}

export function switchCases(code: CodeItem, instruction: PreparedInstruction): [number, number][] {
  const insns = code.insns;
  const payload = instruction.pc + instruction.b;
  const size = insns[payload + 1];
  const out: [number, number][] = [];
  const word = (at: number) => insns[at] | (insns[at + 1] << 16);
  for (let j = 0; j < size; j++) {
    if (instruction.name === "packed-switch") {
      out.push([word(payload + 2) + j, instruction.pc + word(payload + 4 + j * 2)]);
    } else {
      out.push([word(payload + 2 + j * 2), instruction.pc + word(payload + 2 + size * 2 + j * 2)]);
    }
  }
  return out;
}

function branchTargets(code: CodeItem, instruction: PreparedInstruction): readonly number[] {
  const op = instruction.op;
  if (op >= 0x28 && op <= 0x2a) return [instruction.pc + instruction.a];
  if (op === 0x2b || op === 0x2c) return switchCases(code, instruction).map(([, target]) => target);
  if (op >= 0x32 && op <= 0x3d) return [ifTarget(instruction)];
  return NO_TARGETS;
}

const NO_TARGETS: readonly number[] = [];

const isInstanceInvoke = (op: number) =>
  (op >= 0x6e && op <= 0x70) || op === 0x72 || (op >= 0x74 && op <= 0x76) || op === 0x78 || op === 0xfa || op === 0xfb;

/** Could this instruction consume a constant as a float or double? */
function readsFloating(dex: DexFile, instruction: MutableInstruction, returnType: string): boolean {
  const op = instruction.op;
  if (floatingOperands(op) || op === 0x4b || op === 0x4c) return true;   // aput/aput-wide: the array may hold floats
  if (op === 0x59 || op === 0x5a || op === 0x67 || op === 0x68) {
    const type = dex.type(dex.field(op < 0x67 ? instruction.c : instruction.b).type);
    return type === "F" || type === "D";
  }
  if ((op >= 0x6e && op <= 0x72) || (op >= 0x74 && op <= 0x78))
    return dex.protoParamTypes(dex.method(instruction.b).proto).some((type) => type === "F" || type === "D");
  return (op === 0x0f && returnType === "F") || (op === 0x10 && returnType === "D");
}

/** Without floating reads, constant typing only decides which receivers may be a null constant:
 *  any register a constant is written to (flow-insensitive, so it can only over-mark). */
function markConstantReceivers(instructions: MutableInstruction[]): void {
  const constants = new Set<number>();
  for (const instruction of instructions) if (instruction.op >= 0x12 && instruction.op <= 0x19) constants.add(instruction.a);
  for (const instruction of instructions) {
    if (isInstanceInvoke(instruction.op) && constants.has(instruction.regs[0])) instruction.nullRecv = true;
  }
}

function typeConstants(
  dex: DexFile,
  code: CodeItem,
  signature: ReturnType<typeof parseMethodDesc>,
  isStatic: boolean,
  instructions: MutableInstruction[],
  leadersMap: Uint8Array,
): void {
  const leaders = instructions.filter((instruction) => leadersMap[instruction.pc]).map((instruction) => instruction.pc);
  const body = new Map<number, MutableInstruction[]>();
  let current: MutableInstruction[] | undefined;
  for (const instruction of instructions) {
    if (leadersMap[instruction.pc]) {
      current = [];
      body.set(instruction.pc, current);
    }
    if (!current) throw new Error(`instruction ${instruction.pc} has no basic block`);
    current.push(instruction);
  }

  const retType = signature.ret;
  let liveDefs: Defs | null = null;
  const mark = (reg: number, kind: "F" | "D") => {
    const definitions = liveDefs?.get(reg);
    if (definitions) for (const write of definitions) if (!write.constKind) write.constKind = kind;
  };
  const run = (leader: number, defs: Defs, arrays: ArrayKinds, markConsumers: boolean) => {
    const block = body.get(leader);
    if (!block) throw new Error(`missing basic block ${leader}`);
    let lastReturnType = "";
    liveDefs = markConsumers ? defs : null;
    for (const instruction of block) {
      const name = instruction.name;
      const operand = floatingOperands(instruction.op);
      if (operand) {
        const kind = operand.kind;
        if (name.endsWith("/2addr")) { mark(instruction.a, kind); mark(instruction.b, kind); }
        else if (operand.unary) mark(instruction.b, kind);
        else { mark(instruction.b, kind); mark(instruction.c, kind); }
      } else if (name === "aput" || name === "aput-wide") {
        const kind = arrays.get(instruction.b);
        if (kind) mark(instruction.a, kind);
      } else if (name.startsWith("iput") || name.startsWith("sput")) {
        const fieldType = dex.type(dex.field(name.startsWith("iput") ? instruction.c : instruction.b).type);
        if (fieldType === "F") mark(instruction.a, "F");
        else if (fieldType === "D") mark(instruction.a, "D");
      } else if (name.startsWith("invoke") && !name.startsWith("invoke-custom")) {
        const instance = !name.startsWith("invoke-static");
        if (instance && liveDefs?.get(instruction.regs[0])?.size) instruction.nullRecv = true;
        let registerIndex = instance ? 1 : 0;
        for (const paramType of dex.protoParamTypes(dex.method(instruction.b).proto)) {
          if (paramType === "F") mark(instruction.regs[registerIndex], "F");
          else if (paramType === "D") mark(instruction.regs[registerIndex], "D");
          registerIndex += isWide(paramType) ? 2 : 1;
        }
      } else if (name === "return" && retType === "F") mark(instruction.a, "F");
      else if (name === "return-wide" && retType === "D") mark(instruction.a, "D");

      const setArrayKind = (reg: number, type: string) => {
        if (type === "[F") arrays.set(reg, "F");
        else if (type === "[D") arrays.set(reg, "D");
        else arrays.delete(reg);
      };
      if (name === "new-array") setArrayKind(instruction.a, dex.type(instruction.c));
      else if (name === "check-cast") setArrayKind(instruction.a, dex.type(instruction.b));
      else if (name === "iget-object") setArrayKind(instruction.a, dex.type(dex.field(instruction.c).type));
      else if (name === "sget-object") setArrayKind(instruction.a, dex.type(dex.field(instruction.b).type));
      else if (name === "move-result-object") setArrayKind(instruction.a, lastReturnType);
      else if (name === "move-object" || name === "move-object/from16" || name === "move-object/16") {
        const kind = arrays.get(instruction.b);
        if (kind) arrays.set(instruction.a, kind); else arrays.delete(instruction.a);
      } else if (writesRegister(instruction.op)) arrays.delete(instruction.a);
      if (name.startsWith("invoke") && !name.startsWith("invoke-custom")) {
        lastReturnType = dex.type(dex.proto(dex.method(instruction.b).proto).ret);
      } else if (name !== "move-result-object") {
        lastReturnType = "";
      }

      if (name.startsWith("const/") || name === "const" || name.startsWith("const-wide")) {
        defs.set(instruction.a, new Set([instruction]));
      } else if (name === "move" || name === "move/from16" || name === "move/16" ||
          name === "move-wide" || name === "move-wide/from16" || name === "move-wide/16" ||
          name === "move-object" || name === "move-object/from16" || name === "move-object/16") {
        const source = defs.get(instruction.b);
        if (source) defs.set(instruction.a, source); else defs.delete(instruction.a);
      } else if (writesRegister(instruction.op)) {
        defs.delete(instruction.a);
      }
    }
    return { defs, arrays };
  };

  const paramArrays: ArrayKinds = new Map();
  const params = signature.params;
  let paramRegister = code.regs - code.ins + (isStatic ? 0 : 1);
  for (const paramType of params) {
    if (paramType === "[F") paramArrays.set(paramRegister, "F");
    else if (paramType === "[D") paramArrays.set(paramRegister, "D");
    paramRegister += isWide(paramType) ? 2 : 1;
  }
  if (leaders.length === 1) {
    run(leaders[0], new Map(), new Map(paramArrays), true);
    return;
  }

  const successors = new Map<number, number[]>();
  for (const [leader, block] of body) {
    const last = block.at(-1);
    if (!last) throw new Error(`empty basic block ${leader}`);
    const targets = new Set(branchTargets(code, last).filter((target) => body.has(target)));
    if (!endsBlock(last.op)) {
      const next = last.pc + last.len;
      if (body.has(next)) targets.add(next);
    }
    successors.set(leader, [...targets]);
  }
  for (const region of code.tries) {
    const handlers = region.handlers.map(([, address]) => address)
      .concat(region.catchAllAddr >= 0 ? [region.catchAllAddr] : []);
    for (const [leader, block] of body) {
      const last = block.at(-1);
      if (!last || last.pc < region.start || leader >= region.end) continue;
      const targets = successors.get(leader);
      if (!targets) throw new Error(`missing successors for block ${leader}`);
      for (const handler of handlers) if (body.has(handler) && !targets.includes(handler)) targets.push(handler);
    }
  }

  const inDefs = new Map<number, Defs>(leaders.map((leader) => [leader, new Map()] as const));
  const inArrays = new Map<number, ArrayKinds | null>(leaders.map((leader) => [leader, null] as const));
  inArrays.set(leaders[0], new Map(paramArrays));
  const work = [...leaders];
  const queued = new Set(leaders);
  for (let workIndex = 0; workIndex < work.length; workIndex++) {
    const leader = work[workIndex];
    queued.delete(leader);
    const entryDefs = inDefs.get(leader);
    if (!entryDefs) throw new Error(`missing definition state for block ${leader}`);
    const state = run(leader, new Map(entryDefs), new Map(inArrays.get(leader) ?? []), false);
    const targets = successors.get(leader);
    if (!targets) throw new Error(`missing successors for block ${leader}`);
    for (const target of targets) {
      let changed = false;
      const destination = inDefs.get(target);
      if (!destination) throw new Error(`missing definition state for block ${target}`);
      for (const [reg, definitions] of state.defs) {
        const existing = destination.get(reg);
        if (!existing) { destination.set(reg, definitions); changed = true; continue; }
        if (existing === definitions) continue;
        let merged: Set<MutableInstruction> | undefined;
        for (const definition of definitions) {
          if (!existing.has(definition)) (merged ??= new Set(existing)).add(definition);
        }
        if (merged) { destination.set(reg, merged); changed = true; }
      }
      const destinationArrays = inArrays.get(target);
      if (destinationArrays === null || destinationArrays === undefined) {
        inArrays.set(target, new Map(state.arrays));
        changed = true;
      } else {
        for (const [reg, kind] of [...destinationArrays]) {
          if (state.arrays.get(reg) !== kind) { destinationArrays.delete(reg); changed = true; }
        }
      }
      if (changed && !queued.has(target)) { queued.add(target); work.push(target); }
    }
  }
  for (const leader of leaders) {
    const entryDefs = inDefs.get(leader);
    if (!entryDefs) throw new Error(`missing definition state for block ${leader}`);
    run(leader, new Map(entryDefs), new Map(inArrays.get(leader) ?? []), true);
  }
}

export function prepareMethod(
  dex: DexFile,
  code: CodeItem,
  desc: string,
  isStatic: boolean,
  observe?: PreparationObserver,
): PreparedMethod {
  let started = observe ? performance.now() : 0;
  const instructions = decodeInstructions(code.insns);
  if (observe) observe("decode", performance.now() - started);

  started = observe ? performance.now() : 0;
  const leaders = new Uint8Array(code.insns.length + 1);
  leaders[0] = 1;
  for (const instruction of instructions) {
    const targets = branchTargets(code, instruction);
    for (const target of targets) leaders[target] = 1;
    if (targets.length || endsBlock(instruction.op)) leaders[instruction.pc + instruction.len] = 1;
  }
  for (const region of code.tries) {
    leaders[region.start] = 1;
    leaders[region.end] = 1;
    for (const [, address] of region.handlers) leaders[address] = 1;
    if (region.catchAllAddr >= 0) leaders[region.catchAllAddr] = 1;
  }
  if (observe) observe("cfg", performance.now() - started);

  started = observe ? performance.now() : 0;
  // Only numeric const writes can seed the reaching-definition analysis, and it only has to run
  // when something could read one of them as a float or double.
  const signature = parseMethodDesc(desc);
  if (instructions.some((instruction) => instruction.op >= 0x12 && instruction.op <= 0x19)) {
    if (instructions.some((instruction) => readsFloating(dex, instruction, signature.ret)))
      typeConstants(dex, code, signature, isStatic, instructions, leaders);
    else markConstantReceivers(instructions);
  }
  if (observe) observe("type", performance.now() - started);

  const sync = instructions.every((instruction) => !maySuspend(instruction.op));
  const wasmEligible = observe !== undefined && !code.tries.length &&
    signature.params.every((type) => type.length === 1) && signature.ret.length === 1 &&
    instructions.some((instruction) => isWasmNumericOpcode(instruction.op)) &&
    instructions.every((instruction) => isWasmRegionOpcode(instruction.op)) &&
    instructions.some((instruction) => branchTargets(code, instruction).some((target) => target <= instruction.pc));
  return {
    instructions,
    leaders,
    params: signature.params,
    widths: signature.params.map((param) => isWide(param) ? 2 : 1),
    sync,
    wasmEligible,
  };
}
