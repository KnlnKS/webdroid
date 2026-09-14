import { FMT_LEN, OPS, insnLen, type Fmt } from "./opcodes";

export interface PreparedInstruction {
  pc: number;
  op: number;
  name: string;
  fmt: Fmt;
  len: number;
  a: number;
  b: number;
  c: number;
  regs: number[];
  wideLit: bigint;
  constKind?: "F" | "D";
  nullRecv?: boolean;
}

export interface PreparedMethod {
  readonly instructions: PreparedInstruction[];
  readonly leaders: Uint8Array;
  readonly sync: boolean;
}

const NO_REGS: number[] = [];
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

function decode(insns: Uint16Array, pc: number): PreparedInstruction {
  const first = insns[pc];
  const op = first & 0xff;
  const entry = OPS[op];
  if (!entry) throw new Error(`bad opcode 0x${op.toString(16)}`);
  const [name, fmt] = entry;
  const ins: PreparedInstruction = { pc, op, name, fmt, len: FMT_LEN[fmt], a: 0, b: 0, c: 0, regs: NO_REGS, wideLit: 0n };
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
  }
  return ins;
}

export function decodeInstructions(insns: Uint16Array): PreparedInstruction[] {
  const instructions: PreparedInstruction[] = [];
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

export function writesRegister(op: number): boolean {
  if (op === 0 || (op >= 0x0e && op <= 0x11) || (op >= 0x1d && op <= 0x1f) ||
      (op >= 0x26 && op <= 0x2c) || (op >= 0x32 && op <= 0x3d) ||
      (op >= 0x4b && op <= 0x51) || (op >= 0x59 && op <= 0x5f) ||
      (op >= 0x67 && op <= 0x78) || op === 0xe9 || op === 0xea ||
      (op >= 0xfa && op <= 0xfd)) return false;
  return true;
}

export function maySuspend(op: number): boolean {
  return op === 0x1d || op === 0x22 || op === 0x24 || op === 0x25 ||
    (op >= 0x60 && op <= 0x6d) || (op >= 0x6e && op <= 0x78) ||
    op === 0xe9 || op === 0xea || (op >= 0xfa && op <= 0xfd);
}

export function floatingOperands(op: number): { kind: "F" | "D"; unary: boolean } | null {
  if (op === 0x2d || op === 0x2e || (op >= 0xa6 && op <= 0xaa) || (op >= 0xc6 && op <= 0xca)) return { kind: "F", unary: false };
  if (op === 0x2f || op === 0x30 || (op >= 0xab && op <= 0xaf) || (op >= 0xcb && op <= 0xcf)) return { kind: "D", unary: false };
  if (op === 0x7f || (op >= 0x87 && op <= 0x89)) return { kind: "F", unary: true };
  if (op === 0x80 || (op >= 0x8a && op <= 0x8c)) return { kind: "D", unary: true };
  return null;
}
