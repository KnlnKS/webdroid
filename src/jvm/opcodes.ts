// Dalvik opcode table: name + format. Format determines code-unit length & operand decode.
// https://source.android.com/docs/core/runtime/dalvik-bytecode
import type { CodeItem } from "./dex.ts";

export type Fmt =
  | "10x" | "12x" | "11n" | "11x" | "10t" | "20t" | "22x" | "21t" | "21s" | "21h"
  | "21c" | "23x" | "22b" | "22t" | "22s" | "22c" | "30t" | "32x" | "31i" | "31t"
  | "31c" | "35c" | "3rc" | "45cc" | "4rcc" | "51l";

export const FMT_LEN: Record<Fmt, number> = {
  "10x": 1, "12x": 1, "11n": 1, "11x": 1, "10t": 1,
  "20t": 2, "22x": 2, "21t": 2, "21s": 2, "21h": 2, "21c": 2, "23x": 2,
  "22b": 2, "22t": 2, "22s": 2, "22c": 2,
  "30t": 3, "32x": 3, "31i": 3, "31t": 3, "31c": 3, "35c": 3, "3rc": 3,
  "45cc": 4, "4rcc": 4, "51l": 5,
};

type Op = readonly [string, Fmt] | null;

const U = null; // unused

export const OPS: readonly Op[] = [
  ["nop", "10x"], ["move", "12x"], ["move/from16", "22x"], ["move/16", "32x"],
  ["move-wide", "12x"], ["move-wide/from16", "22x"], ["move-wide/16", "32x"],
  ["move-object", "12x"], ["move-object/from16", "22x"], ["move-object/16", "32x"],
  ["move-result", "11x"], ["move-result-wide", "11x"], ["move-result-object", "11x"],
  ["move-exception", "11x"], ["return-void", "10x"], ["return", "11x"],
  ["return-wide", "11x"], ["return-object", "11x"],
  ["const/4", "11n"], ["const/16", "21s"], ["const", "31i"], ["const/high16", "21h"],
  ["const-wide/16", "21s"], ["const-wide/32", "31i"], ["const-wide", "51l"], ["const-wide/high16", "21h"],
  ["const-string", "21c"], ["const-string/jumbo", "31c"], ["const-class", "21c"],
  ["monitor-enter", "11x"], ["monitor-exit", "11x"],
  ["check-cast", "21c"], ["instance-of", "22c"], ["array-length", "12x"],
  ["new-instance", "21c"], ["new-array", "22c"],
  ["filled-new-array", "35c"], ["filled-new-array/range", "3rc"], ["fill-array-data", "31t"],
  ["throw", "11x"], ["goto", "10t"], ["goto/16", "20t"], ["goto/32", "30t"],
  ["packed-switch", "31t"], ["sparse-switch", "31t"],
  ["cmpl-float", "23x"], ["cmpg-float", "23x"], ["cmpl-double", "23x"], ["cmpg-double", "23x"], ["cmp-long", "23x"],
  ["if-eq", "22t"], ["if-ne", "22t"], ["if-lt", "22t"], ["if-ge", "22t"], ["if-gt", "22t"], ["if-le", "22t"],
  ["if-eqz", "21t"], ["if-nez", "21t"], ["if-ltz", "21t"], ["if-gez", "21t"], ["if-gtz", "21t"], ["if-lez", "21t"],
  U, U, U, U, U, U,
  ["aget", "23x"], ["aget-wide", "23x"], ["aget-object", "23x"], ["aget-boolean", "23x"],
  ["aget-byte", "23x"], ["aget-char", "23x"], ["aget-short", "23x"],
  ["aput", "23x"], ["aput-wide", "23x"], ["aput-object", "23x"], ["aput-boolean", "23x"],
  ["aput-byte", "23x"], ["aput-char", "23x"], ["aput-short", "23x"],
  ["iget", "22c"], ["iget-wide", "22c"], ["iget-object", "22c"], ["iget-boolean", "22c"],
  ["iget-byte", "22c"], ["iget-char", "22c"], ["iget-short", "22c"],
  ["iput", "22c"], ["iput-wide", "22c"], ["iput-object", "22c"], ["iput-boolean", "22c"],
  ["iput-byte", "22c"], ["iput-char", "22c"], ["iput-short", "22c"],
  ["sget", "21c"], ["sget-wide", "21c"], ["sget-object", "21c"], ["sget-boolean", "21c"],
  ["sget-byte", "21c"], ["sget-char", "21c"], ["sget-short", "21c"],
  ["sput", "21c"], ["sput-wide", "21c"], ["sput-object", "21c"], ["sput-boolean", "21c"],
  ["sput-byte", "21c"], ["sput-char", "21c"], ["sput-short", "21c"],
  ["invoke-virtual", "35c"], ["invoke-super", "35c"], ["invoke-direct", "35c"],
  ["invoke-static", "35c"], ["invoke-interface", "35c"], U,
  ["invoke-virtual/range", "3rc"], ["invoke-super/range", "3rc"], ["invoke-direct/range", "3rc"],
  ["invoke-static/range", "3rc"], ["invoke-interface/range", "3rc"], U, U,
  ["neg-int", "12x"], ["not-int", "12x"], ["neg-long", "12x"], ["not-long", "12x"],
  ["neg-float", "12x"], ["neg-double", "12x"],
  ["int-to-long", "12x"], ["int-to-float", "12x"], ["int-to-double", "12x"],
  ["long-to-int", "12x"], ["long-to-float", "12x"], ["long-to-double", "12x"],
  ["float-to-int", "12x"], ["float-to-long", "12x"], ["float-to-double", "12x"],
  ["double-to-int", "12x"], ["double-to-long", "12x"], ["double-to-float", "12x"],
  ["int-to-byte", "12x"], ["int-to-char", "12x"], ["int-to-short", "12x"],
  ["add-int", "23x"], ["sub-int", "23x"], ["mul-int", "23x"], ["div-int", "23x"], ["rem-int", "23x"],
  ["and-int", "23x"], ["or-int", "23x"], ["xor-int", "23x"], ["shl-int", "23x"], ["shr-int", "23x"], ["ushr-int", "23x"],
  ["add-long", "23x"], ["sub-long", "23x"], ["mul-long", "23x"], ["div-long", "23x"], ["rem-long", "23x"],
  ["and-long", "23x"], ["or-long", "23x"], ["xor-long", "23x"], ["shl-long", "23x"], ["shr-long", "23x"], ["ushr-long", "23x"],
  ["add-float", "23x"], ["sub-float", "23x"], ["mul-float", "23x"], ["div-float", "23x"], ["rem-float", "23x"],
  ["add-double", "23x"], ["sub-double", "23x"], ["mul-double", "23x"], ["div-double", "23x"], ["rem-double", "23x"],
  ["add-int/2addr", "12x"], ["sub-int/2addr", "12x"], ["mul-int/2addr", "12x"], ["div-int/2addr", "12x"], ["rem-int/2addr", "12x"],
  ["and-int/2addr", "12x"], ["or-int/2addr", "12x"], ["xor-int/2addr", "12x"], ["shl-int/2addr", "12x"], ["shr-int/2addr", "12x"], ["ushr-int/2addr", "12x"],
  ["add-long/2addr", "12x"], ["sub-long/2addr", "12x"], ["mul-long/2addr", "12x"], ["div-long/2addr", "12x"], ["rem-long/2addr", "12x"],
  ["and-long/2addr", "12x"], ["or-long/2addr", "12x"], ["xor-long/2addr", "12x"], ["shl-long/2addr", "12x"], ["shr-long/2addr", "12x"], ["ushr-long/2addr", "12x"],
  ["add-float/2addr", "12x"], ["sub-float/2addr", "12x"], ["mul-float/2addr", "12x"], ["div-float/2addr", "12x"], ["rem-float/2addr", "12x"],
  ["add-double/2addr", "12x"], ["sub-double/2addr", "12x"], ["mul-double/2addr", "12x"], ["div-double/2addr", "12x"], ["rem-double/2addr", "12x"],
  ["add-int/lit16", "22s"], ["rsub-int", "22s"], ["mul-int/lit16", "22s"], ["div-int/lit16", "22s"],
  ["rem-int/lit16", "22s"], ["and-int/lit16", "22s"], ["or-int/lit16", "22s"], ["xor-int/lit16", "22s"],
  ["add-int/lit8", "22b"], ["rsub-int/lit8", "22b"], ["mul-int/lit8", "22b"], ["div-int/lit8", "22b"],
  ["rem-int/lit8", "22b"], ["and-int/lit8", "22b"], ["or-int/lit8", "22b"], ["xor-int/lit8", "22b"],
  ["shl-int/lit8", "22b"], ["shr-int/lit8", "22b"], ["ushr-int/lit8", "22b"],
  // 0xe3-0xf2: ART's quickened forms, which dexlayout and de-odexing emit. Their operand is a
  // resolved field or vtable OFFSET rather than an index, so nothing can compile them without
  // the layout the odex resolved them against — but they are here so a dex carrying one is
  // WALKABLE. Without a length insnLen throws and the whole file is unreadable before
  // compilation starts; with one, only a method that actually runs quickened bytecode fails,
  // and it says so. 0xf3-0xf9 are unused in ART too.
  ["iget-quick", "22c"], ["iget-wide-quick", "22c"], ["iget-object-quick", "22c"],
  ["iput-quick", "22c"], ["iput-wide-quick", "22c"], ["iput-object-quick", "22c"],
  ["invoke-virtual-quick", "35c"], ["invoke-virtual/range-quick", "3rc"],
  ["iput-boolean-quick", "22c"], ["iput-byte-quick", "22c"], ["iput-char-quick", "22c"], ["iput-short-quick", "22c"],
  ["iget-boolean-quick", "22c"], ["iget-byte-quick", "22c"], ["iget-char-quick", "22c"], ["iget-short-quick", "22c"],
  U, U, U, U, U, U, U,
  ["invoke-polymorphic", "45cc"], ["invoke-polymorphic/range", "4rcc"],
  ["invoke-custom", "35c"], ["invoke-custom/range", "3rc"],
  ["const-method-handle", "21c"], ["const-method-type", "21c"],
];

/** length in code units of instruction at insns[pc]; handles payload pseudo-instructions */
export function insnLen(insns: Uint16Array, pc: number): number {
  const unit = insns[pc];
  const op = unit & 0xff;
  if (op === 0x00) {
    const ident = unit >> 8;
    if (ident === 0x01) return 4 + insns[pc + 1] * 2;           // packed-switch-payload
    if (ident === 0x02) return 2 + insns[pc + 1] * 4;           // sparse-switch-payload
    if (ident === 0x03) {
      const width = insns[pc + 1];
      const count = insns[pc + 2] | (insns[pc + 3] << 16);
      return 4 + ((width * count + 1) >> 1);                    // fill-array-data-payload
    }
    return 1;
  }
  const entry = OPS[op];
  if (!entry) throw new Error(`bad opcode 0x${op.toString(16)} at pc ${pc}`);
  return FMT_LEN[entry[1]];
}
/** what an instruction does, which each pass over a method's code switches on; quickened and unused opcodes are None, as nothing compiles them */
export const Family = {
  None: 0, Nop: 1, Move: 2, MoveResult: 3, MoveException: 4, ReturnVoid: 5, Return: 6, Const: 7, ConstString: 8, ConstClass: 9, Monitor: 10,
  CheckCast: 11, InstanceOf: 12, ArrayLength: 13, NewInstance: 14, NewArray: 15, FilledNewArray: 16, FillArrayData: 17, Throw: 18, Goto: 19,
  Switch: 20, Compare: 21, If: 22, IfZ: 23, Aget: 24, Aput: 25, Iget: 26, Iput: 27, Sget: 28, Sput: 29, Invoke: 30, Unary: 31, Binop: 32,
  Binop2addr: 33, BinopLit: 34, ConstMethodHandle: 35, ConstMethodType: 36,
} as const;
export type Family = (typeof Family)[keyof typeof Family];
/** an invoke's kind in opcode order; a range form has its plain form's */
export const Invoke = { Virtual: 0, Super: 1, Direct: 2, Static: 3, Interface: 4, Polymorphic: 5, Custom: 6 } as const;
export type Invoke = (typeof Invoke)[keyof typeof Invoke];
/** the operations of the binary ops in DEX order: int and long take all eleven, float and double the first five; a literal op's second is rsub */
export const BINOPS = ["add", "sub", "mul", "div", "rem", "and", "or", "xor", "shl", "shr", "ushr"] as const;
export type Binop = (typeof BINOPS)[number];

/** the constant pool an instruction's reference indexes; the quickened forms hold offsets instead */
export const Pool = { None: 0, String: 1, Type: 2, Field: 3, Method: 4, Proto: 5, Handle: 6, CallSite: 7 } as const;
export type Pool = (typeof Pool)[keyof typeof Pool];
const FAMILY = new Uint8Array(256), VARIANT = new Uint8Array(256), TYPE = new Array<string>(256).fill(""), THROWS = new Uint8Array(256).fill(1);
const POOL = new Uint8Array(256), IN_C = new Uint8Array(256);
/** opcodes `lo` to `hi` as `family`: each its variant and type letter by its position in the run */
function def(family: Family, lo: number, hi: number, type: (i: number) => string = () => "", variant: (i: number) => number = (i) => i) {
  for (let op = lo; op <= hi; op++) { FAMILY[op] = family; TYPE[op] = type(op - lo); VARIANT[op] = variant(op - lo); }
}
const letters = (s: string) => (i: number) => s[i];
/** a binary op's operand type and operation, by its position among the 32 of its form */
const binopType = (i: number) => (i < 11 ? "I" : i < 22 ? "J" : i < 27 ? "F" : "D"), binop = (i: number) => (i < 11 ? i : i < 22 ? i - 11 : i < 27 ? i - 22 : i - 27);
def(Family.Nop, 0x00, 0x00); def(Family.Move, 0x01, 0x09, (i) => "IJL"[(i / 3) | 0]); def(Family.MoveResult, 0x0a, 0x0c, letters("IJL"));
def(Family.MoveException, 0x0d, 0x0d); def(Family.ReturnVoid, 0x0e, 0x0e); def(Family.Return, 0x0f, 0x11, letters("IJL"));
def(Family.Const, 0x12, 0x19, (i) => (i < 4 ? "I" : "J")); def(Family.ConstString, 0x1a, 0x1b); def(Family.ConstClass, 0x1c, 0x1c);
def(Family.Monitor, 0x1d, 0x1e); def(Family.CheckCast, 0x1f, 0x1f); def(Family.InstanceOf, 0x20, 0x20); def(Family.ArrayLength, 0x21, 0x21);
def(Family.NewInstance, 0x22, 0x22); def(Family.NewArray, 0x23, 0x23); def(Family.FilledNewArray, 0x24, 0x25); def(Family.FillArrayData, 0x26, 0x26);
def(Family.Throw, 0x27, 0x27); def(Family.Goto, 0x28, 0x2a); def(Family.Switch, 0x2b, 0x2c); def(Family.Compare, 0x2d, 0x31, letters("FFDDJ"));
def(Family.If, 0x32, 0x37); def(Family.IfZ, 0x38, 0x3d);
([[Family.Aget, 0x44], [Family.Aput, 0x4b], [Family.Iget, 0x52], [Family.Iput, 0x59], [Family.Sget, 0x60], [Family.Sput, 0x67]] as const)
  .forEach(([family, lo]) => def(family, lo, lo + 6, letters("IJLZBCS")));
def(Family.Invoke, 0x6e, 0x72); def(Family.Invoke, 0x74, 0x78);
def(Family.Invoke, 0xfa, 0xfb, undefined, () => Invoke.Polymorphic); def(Family.Invoke, 0xfc, 0xfd, undefined, () => Invoke.Custom);
def(Family.Unary, 0x7b, 0x8f); def(Family.Binop, 0x90, 0xaf, binopType, binop); def(Family.Binop2addr, 0xb0, 0xcf, binopType, binop);
def(Family.BinopLit, 0xd0, 0xd7, () => "I"); def(Family.BinopLit, 0xd8, 0xe2, () => "I");
def(Family.ConstMethodHandle, 0xfe, 0xfe); def(Family.ConstMethodType, 0xff, 0xff);
for (let op = 0; op < 256; op++) {
  switch (FAMILY[op]) {
    case Family.Nop: case Family.Move: case Family.MoveResult: case Family.MoveException: case Family.ReturnVoid: case Family.Return: case Family.Const:
    case Family.Goto: case Family.Compare: case Family.If: case Family.IfZ: case Family.Unary: THROWS[op] = 0; break;
    // int and long division and remainder throw ArithmeticException
    case Family.Binop: case Family.Binop2addr: case Family.BinopLit: THROWS[op] = +((VARIANT[op] === 3 || VARIANT[op] === 4) && (TYPE[op] === "I" || TYPE[op] === "J")); break;
    case Family.ConstString: POOL[op] = Pool.String; break;
    case Family.ConstClass: case Family.CheckCast: case Family.NewInstance: case Family.FilledNewArray: POOL[op] = Pool.Type; break;
    case Family.InstanceOf: case Family.NewArray: POOL[op] = Pool.Type; IN_C[op] = 1; break;
    case Family.Iget: case Family.Iput: POOL[op] = Pool.Field; IN_C[op] = 1; break;
    case Family.Sget: case Family.Sput: POOL[op] = Pool.Field; break;
    case Family.Invoke: POOL[op] = VARIANT[op] === Invoke.Custom ? Pool.CallSite : Pool.Method; break;
    case Family.ConstMethodHandle: POOL[op] = Pool.Handle; break;
    case Family.ConstMethodType: POOL[op] = Pool.Proto; break;
  }
}
export const familyOf = (op: number): Family => FAMILY[op] as Family;
/** an instruction's place in its family: an invoke's kind (Invoke), a test's comparison (eq, ne, lt, ge, gt, le), a binary op's operation (BINOPS), a
 *  unary op's position from neg-int, a monitor-exit's or sparse-switch's 1 */
export const variantOf = (op: number): number => VARIANT[op];
/** the descriptor letter of what an instruction moves, returns, defines as a constant, compares or computes, or of an array element or field it accesses;
 *  a 32-bit move, return or constant's is I and a wide one's J */
export const typeLetter = (op: number): string => TYPE[op];
/** whether an instruction can throw: one that cannot takes no handler edge */
export const mayThrow = (op: number): boolean => THROWS[op] === 1;
export const isMoveResult = (op: number) => FAMILY[op] === Family.MoveResult;
export const isGoto = (op: number) => FAMILY[op] === Family.Goto;
export const isIf = (op: number) => FAMILY[op] === Family.If || FAMILY[op] === Family.IfZ;
/** return, throw and goto: nothing falls through them */
export const endsBlock = (op: number) => { const f = FAMILY[op]; return f === Family.Return || f === Family.ReturnVoid || f === Family.Throw || f === Family.Goto; };
export const isInvoke = (op: number) => FAMILY[op] === Family.Invoke;
/** iget and iput: quickened forms never compile */
export const isFieldAccess = (op: number) => FAMILY[op] === Family.Iget || FAMILY[op] === Family.Iput;
/** the kind of an invoke opcode (isInvoke) */
export const invokeKind = (op: number): Invoke => VARIANT[op] as Invoke;
/** an invoke whose first register is its receiver */
export const isInstanceInvoke = (op: number) => FAMILY[op] === Family.Invoke && VARIANT[op] !== Invoke.Static && VARIANT[op] !== Invoke.Custom;
/** the register an instruction null-checks (each translation of it throws NullPointerException when it holds null), -1 for none */
export function nullChecked(ins: { op: number; a: number; b: number; regs: readonly number[] }): number {
  switch (FAMILY[ins.op]) {
    case Family.Aget: case Family.Aput: case Family.Iget: case Family.Iput: case Family.ArrayLength: return ins.b;
    case Family.Monitor: case Family.FillArrayData: case Family.Throw: return ins.a;
    case Family.Invoke: return isInstanceInvoke(ins.op) && VARIANT[ins.op] !== Invoke.Polymorphic && ins.regs.length ? ins.regs[0] : -1;
    default: return -1;
  }
}
/** the bits of a narrow constant, const/4 to const/high16 (0x12-0x15) */
export const narrowBits = (op: number, b: number): number => op === 0x15 ? b << 16 : b;
/** the bits of a wide constant, const-wide/16 to const-wide/high16 (0x16-0x19) */
export const wideBits = (op: number, b: number, wide: bigint): bigint => op === 0x18 ? wide : op === 0x19 ? BigInt(b) << 48n : BigInt(b);

/** the pool an instruction's reference indexes: invoke-polymorphic's is its method, whose prototype is its c */
export const referenceOf = (op: number): Pool => POOL[op] as Pool;
/** the index of an instruction's reference: c for instance-of, new-array, iget and iput, b for the others */
export const referenceIndex = (ins: { op: number; b: number; c: number }): number => IN_C[ins.op] ? ins.c : ins.b;

/** the references of a method's code, each with the opcode that makes it (-1 for a catch handler's type) */
interface RefVisitor {
  /** an invoke-kind/range instruction's method_id */
  invoke?(op: number, method: number): void;
  /** the type_id of const-class, check-cast, instance-of, new-instance, new-array, filled-new-array/range or a catch handler */
  type?(op: number, type: number): void;
  /** the field_id of an iget/iput/sget/sput */
  field?(op: number, field: number): void;
}
export function walkRefs(code: CodeItem, v: RefVisitor): void {
  const insns = code.insns;
  walkInsns(insns, (op, pc) => {
    const pool = POOL[op];
    if (pool === Pool.Method && op < 0xfa) v.invoke?.(op, insns[pc + 1]);
    else if (pool === Pool.Type) v.type?.(op, insns[pc + 1]);
    else if (pool === Pool.Field) v.field?.(op, insns[pc + 1]);
  });
  if (v.type) for (const t of code.tries) for (const [type] of t.handlers) v.type(-1, type);
}
/** every instruction's opcode and pc; one unwalkable instruction must not cost us the rest of the program */
function walkInsns(insns: Uint16Array, visit: (op: number, pc: number) => void) {
  for (let pc = 0; pc < insns.length;) {
    visit(insns[pc] & 0xff, pc);
    let len: number;
    try { len = insnLen(insns, pc); } catch { return; }
    if (len <= 0) return;
    pc += len;
  }
}
