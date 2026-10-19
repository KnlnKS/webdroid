import { PRIMS } from "../../jvm/abi.ts";

export const H = { ID: 0, DEPTH: 1, DISPLAY: 2, MAXD: 12, EXTRA: 14, IMT: 15, IMT_N: 16, VTAB: 47 };
/** an array class's display holds only Object and itself, so the words after them describe its elements: the component class id, and how a
 *  value is tested against it: depth + 1 for a class within the display, ELEM_IFACE for an interface or a class beyond it, ELEM_OTHER otherwise */
export const ELEM = H.DISPLAY + 2, ELEM_KIND = H.DISPLAY + 3, ELEM_IFACE = -2, ELEM_OTHER = -1;
export type ElemKind = "i8" | "i16" | "i32" | "i64" | "ref";
const OF_SIZE: Record<number, ElemKind> = { 1: "i8", 2: "i16", 4: "i32", 8: "i64" };
/** element storage kind of an array descriptor like "[I" */
export const elemKindOf = (desc: string): ElemKind => { const p = PRIMS[desc[1]]; return p ? OF_SIZE[p.size] : "ref"; };
export function f32bits(x: number): number { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x, true); return b.getInt32(0, true); }
export function f64bits(x: number): bigint { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x, true); return b.getBigInt64(0, true); }
/** java.lang.Math's transcendental natives, by arity: the host's Math, imported as they are rather than wrapped as natives */
export const MATH_ARITY = { acos: 1, asin: 1, atan: 1, cbrt: 1, cos: 1, cosh: 1, exp: 1, expm1: 1, log: 1, log10: 1, log1p: 1, sin: 1, sinh: 1, tan: 1, tanh: 1,
  atan2: 2, hypot: 2, pow: 2 } as const;
