// Opcode families for the histogram, plus a few predicates shared by the passes.
import { OPS } from "../../../src/jvm/opcodes";

export const FAMILY: string[] = new Array(256).fill("other");
const set = (lo: number, hi: number, name: string) => { for (let o = lo; o <= hi; o++) FAMILY[o] = name; };

set(0x00, 0x00, "nop");
set(0x01, 0x03, "move"); set(0x04, 0x06, "move-wide"); set(0x07, 0x09, "move-object");
set(0x0a, 0x0c, "move-result"); set(0x0d, 0x0d, "move-exception");
set(0x0e, 0x11, "return");
set(0x12, 0x15, "const32"); set(0x16, 0x19, "const-wide"); set(0x1a, 0x1b, "const-string"); set(0x1c, 0x1c, "const-class");
set(0x1d, 0x1e, "monitor"); set(0x1f, 0x1f, "check-cast"); set(0x20, 0x20, "instance-of"); set(0x21, 0x21, "array-length");
set(0x22, 0x22, "new-instance"); set(0x23, 0x23, "new-array"); set(0x24, 0x25, "filled-new-array"); set(0x26, 0x26, "fill-array-data");
set(0x27, 0x27, "throw"); set(0x28, 0x2a, "goto"); set(0x2b, 0x2b, "packed-switch"); set(0x2c, 0x2c, "sparse-switch");
set(0x2d, 0x30, "cmp-float/double"); set(0x31, 0x31, "cmp-long");
set(0x32, 0x37, "if"); set(0x38, 0x3d, "if-z");
// aget/aput: width classes 32 (int|float), wide, object, 8 (boolean/byte), 16 (char/short)
const widthName = ["32", "wide", "obj", "8", "8", "16", "16"];
for (let k = 0; k < 7; k++) {
  FAMILY[0x44 + k] = "aget-" + widthName[k]; FAMILY[0x4b + k] = "aput-" + widthName[k];
  FAMILY[0x52 + k] = "iget-" + widthName[k]; FAMILY[0x59 + k] = "iput-" + widthName[k];
  FAMILY[0x60 + k] = "sget-" + widthName[k]; FAMILY[0x67 + k] = "sput-" + widthName[k];
}
FAMILY[0x6e] = "invoke-virtual"; FAMILY[0x6f] = "invoke-super"; FAMILY[0x70] = "invoke-direct"; FAMILY[0x71] = "invoke-static"; FAMILY[0x72] = "invoke-interface";
FAMILY[0x74] = "invoke-virtual"; FAMILY[0x75] = "invoke-super"; FAMILY[0x76] = "invoke-direct"; FAMILY[0x77] = "invoke-static"; FAMILY[0x78] = "invoke-interface";
set(0xfa, 0xfb, "invoke-polymorphic"); set(0xfc, 0xfd, "invoke-custom"); set(0xfe, 0xff, "const-method-handle/type");
set(0xe3, 0xf2, "quickened");

// arithmetic by type; div/rem split out (wasm traps on /0 and MIN/-1; rem-float/double have no wasm op)
const arith = (op: number, t: string, div: boolean) => { FAMILY[op] = div ? `divrem-${t}` : `arith-${t}`; };
for (let k = 0; k < 11; k++) {
  const dv = k === 3 || k === 4;
  arith(0x90 + k, "int", dv); arith(0xb0 + k, "int", dv);
  arith(0x9b + k, "long", dv); arith(0xbb + k, "long", dv);
}
for (let k = 0; k < 5; k++) {
  const dv = k === 3 || k === 4;
  arith(0xa6 + k, "float", k === 4); arith(0xc6 + k, "float", k === 4);
  arith(0xab + k, "double", k === 4); arith(0xcb + k, "double", k === 4);
  void dv;
}
FAMILY[0xaa] = "rem-float"; FAMILY[0xca] = "rem-float"; FAMILY[0xaf] = "rem-double"; FAMILY[0xcf] = "rem-double";
for (let o = 0xd0; o <= 0xd7; o++) arith(o, "int", o === 0xd3 || o === 0xd4);
for (let o = 0xd8; o <= 0xe2; o++) arith(o, "int", o === 0xdb || o === 0xdc);
set(0x7b, 0x7c, "arith-int"); set(0x7d, 0x7e, "arith-long"); FAMILY[0x7f] = "arith-float"; FAMILY[0x80] = "arith-double";
set(0x81, 0x8f, "conv");
FAMILY[0x87] = "conv-f2i/l (sat)"; FAMILY[0x88] = "conv-f2i/l (sat)"; FAMILY[0x8a] = "conv-d2i/l (sat)"; FAMILY[0x8b] = "conv-d2i/l (sat)";

export const isInvoke = (op: number) => (op >= 0x6e && op <= 0x78 && op !== 0x73 && op !== 0x79) || (op >= 0xfa && op <= 0xfd);
export const isRangeInvoke = (op: number) => op >= 0x74 && op <= 0x78;
export const isInstanceInvoke = (op: number) => isInvoke(op) && op !== 0x71 && op !== 0x77 && op < 0xfc;

/** ops that cannot throw: no handler edge is needed for them */
export const NO_THROW = new Uint8Array(256);
for (const [lo, hi] of [[0x00, 0x09], [0x0a, 0x0d], [0x12, 0x1a + 0], [0x28, 0x2a], [0x2d, 0x37], [0x38, 0x3d], [0x7b, 0x8f]] as const) for (let o = lo; o <= hi; o++) NO_THROW[o] = 1;
NO_THROW[0x1a] = 0; // const-string can throw (OOM) but ART treats it as throwing; keep the edge
for (let o = 0x90; o <= 0xe2; o++) NO_THROW[o] = 1;
for (const o of [0x93, 0x94, 0x9e, 0x9f, 0xb3, 0xb4, 0xbe, 0xbf, 0xd3, 0xd4, 0xdb, 0xdc]) NO_THROW[o] = 0; // int/long div, rem
for (let o = 0x0e; o <= 0x11; o++) NO_THROW[o] = 1; // ART flags return as non-throwing (kReturn, not kThrow)
export const OPNAME = (op: number) => OPS[op]?.[0] ?? "?";
