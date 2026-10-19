import type { CodeItem } from "./dex.ts";
import { FMT_LEN, OPS, insnLen, type Fmt } from "./opcodes.ts";

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
}

export interface PreparedMethod {
  readonly instructions: readonly PreparedInstruction[];
  /** 1 at each pc that starts a basic block */
  readonly leaders: Readonly<Uint8Array>;
  /** every pc a try hands exceptions to, once each, in the order the tries name them */
  readonly handlerPcs: readonly number[];
  /** by instruction index, the handler pcs of the try covering it, unless it cannot throw */
  readonly handlers: readonly (readonly number[] | undefined)[];
}

type MutableInstruction = { -readonly [K in keyof PreparedInstruction]: PreparedInstruction[K] };

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

export function decodeInstruction(insns: Uint16Array, pc: number): MutableInstruction {
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

export function decodeInstructions(insns: Uint16Array): MutableInstruction[] {
  const instructions: MutableInstruction[] = [];
  for (let pc = 0; pc < insns.length;) {
    const first = insns[pc];
    if ((first & 0xff) === 0 && (first >> 8) !== 0) { pc += insnLen(insns, pc); continue; }
    const ins = decodeInstruction(insns, pc);
    instructions.push(ins);
    pc += ins.len;
  }
  return instructions;
}

/** ops that cannot throw: no handler edge is needed for them */
const NO_THROW = new Uint8Array(256);
for (const [lo, hi] of [[0x00, 0x19], [0x28, 0x2a], [0x2d, 0x3d], [0x7b, 0xe2]] as const) for (let o = lo; o <= hi; o++) NO_THROW[o] = 1;
for (const o of [0x93, 0x94, 0x9e, 0x9f, 0xb3, 0xb4, 0xbe, 0xbf, 0xd3, 0xd4, 0xdb, 0xdc]) NO_THROW[o] = 0; // int/long div, rem

export function endsBlock(op: number): boolean {
  return (op >= 0x0e && op <= 0x11) || op === 0x27 || (op >= 0x28 && op <= 0x2a);
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

/** the registers an instruction names; a written one comes first */
export function registersOf({ fmt, a, b, c, regs }: PreparedInstruction): readonly number[] {
  switch (fmt) {
    case "10x": case "10t": case "20t": case "30t": return NO_REGS;
    case "35c": case "3rc": case "45cc": case "4rcc": return regs;
    case "23x": return [a, b, c];
    case "12x": case "22x": case "32x": case "22b": case "22t": case "22s": case "22c": return [a, b];
    default: return [a];
  }
}
export function prepareMethod(code: CodeItem): PreparedMethod {
  const instructions = decodeInstructions(code.insns);
  const leaders = new Uint8Array(code.insns.length + 1);
  leaders[0] = 1;
  let end = 0;
  for (const instruction of instructions) {
    // nothing falls into code after payload data (the alignment nop before a payload follows a goto or throw)
    if (instruction.pc !== end) leaders[instruction.pc] = 1;
    end = instruction.pc + instruction.len;
    const targets = branchTargets(code, instruction);
    for (const target of targets) leaders[target] = 1;
    if (targets.length || endsBlock(instruction.op)) leaders[instruction.pc + instruction.len] = 1;
  }
  const all = new Set<number>(), handlers: (readonly number[] | undefined)[] = code.tries.length ? new Array(instructions.length) : [];
  for (const region of code.tries) {
    leaders[region.start] = 1;
    leaders[region.end] = 1;
    const pcs = region.handlers.map(([, address]) => address);
    if (region.catchAllAddr >= 0) pcs.push(region.catchAllAddr);
    for (const pc of pcs) { leaders[pc] = 1; all.add(pc); }
    let i = 0;
    for (let hi = instructions.length; i < hi;) { const mid = (i + hi) >> 1; if (instructions[mid].pc < region.start) i = mid + 1; else hi = mid; }
    for (; i < instructions.length && instructions[i].pc < region.end; i++) if (!NO_THROW[instructions[i].op]) handlers[i] = pcs;
  }
  return { instructions, leaders, handlerPcs: [...all], handlers };
}
