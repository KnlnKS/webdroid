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
  /** a compareTo whose result only zero tests read */
  readonly signOnly?: boolean;
}

export interface PreparedMethod {
  readonly instructions: readonly PreparedInstruction[];
  readonly leaders: Readonly<Uint8Array>;
  readonly params: readonly string[];
  readonly widths: readonly number[];
  readonly sync: boolean;
  /** registers a numeric constant may reach: only these can hold 0 standing for null */
  readonly nullable: ReadonlySet<number>;
}

export type PreparationPhase = "decode" | "cfg" | "type";
type PreparationObserver = (phase: PreparationPhase, ms: number) => void;

type MutableInstruction = { -readonly [K in keyof PreparedInstruction]: PreparedInstruction[K] };
type Defs = Map<number, ReadonlySet<MutableInstruction>>;
type ArrayKinds = Map<number, "F" | "D">;

const NO_REGS: readonly number[] = [];
const NO_CARRIERS: ReadonlySet<number> = new Set();
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

export function endsBlock(op: number): boolean {
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

export function branchTargets(code: CodeItem, instruction: PreparedInstruction): readonly number[] {
  const op = instruction.op;
  if (op >= 0x28 && op <= 0x2a) return [instruction.pc + instruction.a];
  if (op === 0x2b || op === 0x2c) return switchCases(code, instruction).map(([, target]) => target);
  if (op >= 0x32 && op <= 0x3d) return [ifTarget(instruction)];
  return NO_TARGETS;
}

const NO_TARGETS: readonly number[] = [];

/** const/4 … const-wide/high16: the writes constant typing follows */
const isNumericConst = (op: number) => op >= 0x12 && op <= 0x19;
const isMove = (op: number) => op >= 0x01 && op <= 0x09;
const isFieldPut = (op: number) => (op >= 0x59 && op <= 0x5f) || (op >= 0x67 && op <= 0x6d);
const isMethodInvoke = (op: number) => (op >= 0x6e && op <= 0x72) || (op >= 0x74 && op <= 0x78) || (op >= 0xfa && op <= 0xfd);
const isInstanceInvoke = (op: number) => isMethodInvoke(op) && op !== 0x71 && op !== 0x77 && op < 0xfc;
/** the proto an invoke passes arguments by: a polymorphic call site's own, a call site's, or the method's */
function invokeProto(dex: DexFile, { op, b, c }: MutableInstruction): number {
  if (op === 0xfa || op === 0xfb) return c;
  if (op === 0xfc || op === 0xfd) return (dex.callSite(b)[2] as { idx: number }).idx;
  return dex.method(b).proto;
}
type FloatKind = "F" | "D";
const floatKind = (type: string): FloatKind | undefined => type === "F" || type === "D" ? type : undefined;

/** Visits each register the instruction reads as a float or double. An aput reads its value as
 *  its array's element kind, which only the caller's `arrayKind` knows. */
function floatReads(dex: DexFile, instruction: MutableInstruction, returnType: string,
  arrayKind: (reg: number) => FloatKind | undefined, visit: (reg: number, kind: FloatKind) => void): void {
  const { op, a, b, c, regs } = instruction;
  const operands = floatingOperands(op);
  if (operands) {
    if (op >= 0xc6) { visit(a, operands.kind); visit(b, operands.kind); }
    else { visit(b, operands.kind); if (!operands.unary) visit(c, operands.kind); }
  } else if (op === 0x4b || op === 0x4c) {
    const kind = arrayKind(b);
    if (kind) visit(a, kind);
  } else if (isFieldPut(op)) {
    const kind = floatKind(dex.type(dex.field(op <= 0x5f ? c : b).type));
    if (kind) visit(a, kind);
  } else if (isMethodInvoke(op)) {
    let index = isInstanceInvoke(op) ? 1 : 0;
    for (const type of dex.protoParamTypes(invokeProto(dex, instruction))) {
      const kind = floatKind(type);
      if (kind) visit(regs[index], kind);
      index += isWide(type) ? 2 : 1;
    }
  } else if ((op === 0x0f && returnType === "F") || (op === 0x10 && returnType === "D")) visit(a, returnType);
}

/** Registers a numeric constant may reach, following moves flow-insensitively; null without one. */
function constantCarriers(instructions: readonly MutableInstruction[]): Set<number> | null {
  let regs: Set<number> | null = null;
  for (const instruction of instructions) if (isNumericConst(instruction.op)) (regs ??= new Set()).add(instruction.a);
  if (!regs) return null;
  for (let grown = true; grown;) {
    grown = false;
    for (const { op, a, b } of instructions) if (isMove(op) && regs.has(b) && !regs.has(a)) { regs.add(a); grown = true; }
  }
  return regs;
}

/** Marks the constants a float or double reads (constKind) and the invokes whose receiver may
 *  be a null constant (nullRecv). The reaching-definition analysis runs only when some float read
 *  can see a constant; otherwise receivers are marked flow-insensitively, which only over-marks. */
function annotateConstants(dex: DexFile, code: CodeItem, signature: ReturnType<typeof parseMethodDesc>,
  isStatic: boolean, instructions: MutableInstruction[], leaders: Uint8Array, carriers: Set<number> | null): void {
  if (!carriers) return;
  let floatSeesConstant = false;
  for (const instruction of instructions) {
    floatReads(dex, instruction, signature.ret, () => "F", (reg) => { floatSeesConstant ||= carriers.has(reg); });
    if (floatSeesConstant) return typeConstants(dex, code, signature, isStatic, instructions, leaders);
  }
  for (const instruction of instructions) if (isInstanceInvoke(instruction.op) && carriers.has(instruction.regs[0])) instruction.nullRecv = true;
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
  const mark = (reg: number, kind: FloatKind) => {
    const definitions = liveDefs?.get(reg);
    if (definitions) for (const write of definitions) if (!write.constKind) write.constKind = kind;
  };
  const run = (leader: number, defs: Defs, arrays: ArrayKinds, markConsumers: boolean) => {
    const block = body.get(leader);
    if (!block) throw new Error(`missing basic block ${leader}`);
    let lastReturnType = "";
    liveDefs = markConsumers ? defs : null;
    for (const instruction of block) {
      const { op, a, b, c } = instruction;
      if (liveDefs) {
        floatReads(dex, instruction, retType, (reg) => arrays.get(reg), mark);
        if (isInstanceInvoke(op) && liveDefs.get(instruction.regs[0])?.size) instruction.nullRecv = true;
      }

      const setArrayKind = (reg: number, type: string) => {
        if (type === "[F") arrays.set(reg, "F");
        else if (type === "[D") arrays.set(reg, "D");
        else arrays.delete(reg);
      };
      if (op === 0x23) setArrayKind(a, dex.type(c));                                    // new-array
      else if (op === 0x1f) setArrayKind(a, dex.type(b));                               // check-cast
      else if (op === 0x54) setArrayKind(a, dex.type(dex.field(c).type));               // iget-object
      else if (op === 0x62) setArrayKind(a, dex.type(dex.field(b).type));               // sget-object
      else if (op === 0x0c) setArrayKind(a, lastReturnType);                            // move-result-object
      else if (op >= 0x07 && op <= 0x09) {                                              // move-object
        const kind = arrays.get(b);
        if (kind) arrays.set(a, kind); else arrays.delete(a);
      } else if (writesRegister(op)) arrays.delete(a);
      if (isMethodInvoke(op)) lastReturnType = dex.type(dex.proto(invokeProto(dex, instruction)).ret);
      else if (op !== 0x0c) lastReturnType = "";

      if (isNumericConst(op)) defs.set(a, new Set([instruction]));
      else if (isMove(op)) {
        const source = defs.get(b);
        if (source) defs.set(a, source); else defs.delete(a);
      } else if (writesRegister(op)) defs.delete(a);
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

/** the registers an instruction names; a written one comes first */
function registersOf({ fmt, a, b, c, regs }: MutableInstruction): readonly number[] {
  switch (fmt) {
    case "10x": case "10t": case "20t": case "30t": return NO_REGS;
    case "35c": case "3rc": case "45cc": case "4rcc": return regs;
    case "23x": return [a, b, c];
    case "12x": case "22x": case "32x": case "22b": case "22t": case "22s": case "22c": return [a, b];
    default: return [a];
  }
}

/** Does every path read the int written by the move-result at `from` only with zero tests, directly
 *  or through moves? Then only its sign matters. Any other read, a handler's included, needs it exact. */
function readAsSign(code: CodeItem, instructions: readonly MutableInstruction[], index: Int32Array, from: number): boolean {
  const seen = new Set<string>(), work: [number, number[]][] = [[from + 1, [instructions[from].a]]];
  for (let item = work.pop(); item; item = work.pop()) {
    let [k, live] = item;
    while (live.length && k >= 0 && k < instructions.length) {
      const key = `${k} ${live}`;
      if (seen.has(key)) break;
      seen.add(key);
      const ins = instructions[k], { op, pc, a } = ins;
      for (const t of code.tries) if (pc >= t.start && pc < t.end) {
        for (const [, handler] of t.handlers) work.push([index[handler], live]);
        if (t.catchAllAddr >= 0) work.push([index[t.catchAllAddr], live]);
      }
      const named = registersOf(ins);
      if (op >= 0x01 && op <= 0x03) live = !live.includes(ins.b) ? live.filter((r) => r !== a) : live.includes(a) ? live : [...live, a];
      else if (!(op >= 0x38 && op <= 0x3d) && named.some((r) => live.includes(r))) {
        // only overwritten: a destination the instruction does not also read
        if (!writesRegister(op) || named === ins.regs || (op >= 0xb0 && op <= 0xcf) || named.slice(1).some((r) => live.includes(r))) return false;
        live = live.filter((r) => r !== a);
      }
      if ((op >= 0x0e && op <= 0x11) || op === 0x27) break;
      const targets = branchTargets(code, ins);
      if (op >= 0x28 && op <= 0x2a) { k = index[targets[0]]; continue; }
      for (const target of targets) work.push([index[target], live]);
      k++;
    }
  }
  return true;
}

/** Marks the compareTo calls whose results are only tested against zero: a String receiver then
 *  compares natively, in one step instead of a char loop. */
function markSignOnly(dex: DexFile, code: CodeItem, instructions: MutableInstruction[]): void {
  let index: Int32Array | undefined;
  for (let k = 0; k + 1 < instructions.length; k++) {
    const ins = instructions[k], op = ins.op;
    if (op !== 0x6e && op !== 0x72 && op !== 0x74 && op !== 0x78 || ins.regs.length !== 2 || instructions[k + 1].op !== 0x0a) continue;
    if (dex.method(ins.b).name !== "compareTo") continue;
    const desc = dex.methodDesc(ins.b);
    if (desc !== "(Ljava/lang/Object;)I" && desc !== "(Ljava/lang/String;)I") continue;
    if (!index) { index = new Int32Array(code.insns.length).fill(-1); instructions.forEach((x, i) => { index![x.pc] = i; }); }
    if (readAsSign(code, instructions, index, k + 1)) ins.signOnly = true;
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
  const signature = parseMethodDesc(desc);
  const carriers = constantCarriers(instructions);
  annotateConstants(dex, code, signature, isStatic, instructions, leaders, carriers);
  markSignOnly(dex, code, instructions);
  if (observe) observe("type", performance.now() - started);

  return {
    instructions,
    leaders,
    params: signature.params,
    widths: signature.params.map((param) => isWide(param) ? 2 : 1),
    sync: instructions.every((instruction) => !maySuspend(instruction.op)),
    nullable: carriers ?? NO_CARRIERS,
  };
}

/** The cold tier's view of a preparation: it keeps only the instructions the analysis annotated
 *  and decodes the rest when they first run, so a cold method does not hold its decoded body. */
export function coldInstructions(code: CodeItem, prepared: PreparedMethod): (pc: number) => PreparedInstruction {
  const annotated = new Map<number, PreparedInstruction>();
  for (const instruction of prepared.instructions) if (instruction.constKind || instruction.nullRecv) annotated.set(instruction.pc, instruction);
  return (pc) => annotated.get(pc) ?? decode(code.insns, pc);
}
