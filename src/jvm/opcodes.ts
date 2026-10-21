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
export const isMoveResult = (op: number) => op >= 0x0a && op <= 0x0c;
export const isReturn = (op: number) => op >= 0x0e && op <= 0x11;
export const isGoto = (op: number) => op >= 0x28 && op <= 0x2a;
export const isIf = (op: number) => op >= 0x32 && op <= 0x3d;
/** return, throw and goto: nothing falls through them */
export const endsBlock = (op: number) => isReturn(op) || op === 0x27 || isGoto(op);
export const isInvoke = (op: number) => (op >= 0x6e && op <= 0x78 && op !== 0x73) || (op >= 0xfa && op <= 0xfd);
/** iget and iput: quickened forms never compile */
export const isFieldAccess = (op: number) => op >= 0x52 && op <= 0x5f;
export const isInstanceInvoke = (op: number) => isInvoke(op) && op !== 0x71 && op !== 0x77 && op < 0xfc;
/** the bits of a narrow constant, const/4 to const/high16 (0x12-0x15) */
export const narrowBits = (op: number, b: number): number => op === 0x15 ? b << 16 : b;
/** the bits of a wide constant, const-wide/16 to const-wide/high16 (0x16-0x19) */
export const wideBits = (op: number, b: number, wide: bigint): bigint => op === 0x18 ? wide : op === 0x19 ? BigInt(b) << 48n : BigInt(b);

/** an invoke's kind in opcode order; a range form has its plain form's */
export const Invoke = { Virtual: 0, Super: 1, Direct: 2, Static: 3, Interface: 4, Polymorphic: 5, Custom: 6 } as const;
export type Invoke = (typeof Invoke)[keyof typeof Invoke];
/** the kind of an invoke opcode (isInvoke) */
export const invokeKind = (op: number): Invoke => (op >= 0xfa ? op >= 0xfc ? Invoke.Custom : Invoke.Polymorphic : (op - 0x6e) % 6) as Invoke;

/** the constant pool an instruction's reference indexes; the quickened forms hold offsets instead */
export const Pool = { None: 0, String: 1, Type: 2, Field: 3, Method: 4, Proto: 5, Handle: 6, CallSite: 7 } as const;
export type Pool = (typeof Pool)[keyof typeof Pool];
const POOL = new Uint8Array(256), IN_C = new Uint8Array(256);
POOL.fill(Pool.String, 0x1a, 0x1c).fill(Pool.Type, 0x22, 0x26).fill(Pool.Field, 0x52, 0x6e).fill(Pool.Method, 0x6e, 0x79).fill(Pool.Method, 0xfa, 0xfc).fill(Pool.CallSite, 0xfc, 0xfe);
POOL[0x1c] = POOL[0x1f] = POOL[0x20] = Pool.Type;
POOL[0x73] = Pool.None; POOL[0xfe] = Pool.Handle; POOL[0xff] = Pool.Proto;
IN_C.fill(1, 0x52, 0x60); IN_C[0x20] = IN_C[0x23] = 1;
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
