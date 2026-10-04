export const H = { ID: 0, DEPTH: 1, DISPLAY: 2, MAXD: 12, EXTRA: 14, IMT: 15, IMT_N: 16, VTAB: 47 };
export type ElemKind = "i8" | "i16" | "i32" | "i64" | "ref";
/** element storage kind of an array descriptor like "[I" */
export const elemKindOf = (desc: string): ElemKind => ({ Z: "i8", B: "i8", C: "i16", S: "i16", I: "i32", F: "i32", J: "i64", D: "i64" } as Record<string, ElemKind>)[desc[1]] ?? "ref";
export function f32bits(x: number): number { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x, true); return b.getInt32(0, true); }
export function f64bits(x: number): bigint { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x, true); return b.getBigInt64(0, true); }
