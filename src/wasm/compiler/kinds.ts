// The kinds of a Java value by its descriptor's letter: the Wasm-level kind it is passed as, its register-typing kind (infer.ts) and the
// storage of an array element of its type.
import { T, type VT } from "./wasmbin.ts";
import { OP } from "./code.ts";

/** Wasm-level kinds: i32 (int, float bits, small ints), i64 (long, double bits), ref */
export type Kind = "I" | "J" | "L";
/** register-typing kinds: I int-like (boolean/byte/short/char/int), F float, R reference (or null), J long, D double */
export const I = 1, F = 2, R = 4, J = 8, D = 16;
export type ElemKind = "i8" | "i16" | "i32" | "i64" | "ref";

interface Letter { kind: Kind; value: number; elem: ElemKind }
const INT: Letter = { kind: "I", value: I, elem: "i32" }, REF: Letter = { kind: "L", value: R, elem: "ref" };
const LETTERS: Readonly<Record<string, Letter>> = {
  Z: { ...INT, elem: "i8" }, B: { ...INT, elem: "i8" }, C: { ...INT, elem: "i16" }, S: { ...INT, elem: "i16" }, I: INT,
  F: { kind: "I", value: F, elem: "i32" }, J: { kind: "J", value: J, elem: "i64" }, D: { kind: "J", value: D, elem: "i64" }, L: REF, "[": REF,
};
// by char code, as hot paths look letters up; any other letter is int-like, or for an array's element a reference
const BY_CODE: Letter[] = Array.from({ length: 128 }, (_, c) => LETTERS[String.fromCharCode(c)] ?? INT);
const KIND = BY_CODE.map((l) => l.kind), VALUE = Uint8Array.from(BY_CODE, (l) => l.value);
const ELEM = BY_CODE.map((l, c) => (LETTERS[String.fromCharCode(c)] ? l.elem : "ref"));

export const kindOf = (desc: string): Kind => KIND[desc.charCodeAt(0)] ?? "I";
/** the register-typing kind of a value of type `desc` */
export const valueKind = (desc: string): number => VALUE[desc.charCodeAt(0)] || I;
/** element storage kind of an array descriptor like "[I" */
export const elemKindOf = (desc: string): ElemKind => ELEM[desc.charCodeAt(1)] ?? "ref";
export const isRef = (desc: string): boolean => KIND[desc.charCodeAt(0)] === "L";
/** every reference slot is an anyref: a Java object, a String included (strings.ts), is a struct subtype of $Obj */
export const kindVT = (k: Kind): VT => (k === "I" ? T.i32 : k === "J" ? T.i64 : T.anyref);
/** by register-typing kind: the Wasm type a value is held in, its Wasm-level kind and for F and D the reinterpretations to and from those bits */
export const KINDS: { readonly [k: number]: { vt: VT; abi: Kind; toBits?: number; fromBits?: number } } = {
  [I]: { vt: T.i32, abi: "I" }, [R]: { vt: T.anyref, abi: "L" }, [J]: { vt: T.i64, abi: "J" },
  [F]: { vt: T.f32, abi: "I", toBits: OP.i32_reinterpret_f32, fromBits: OP.f32_reinterpret_i32 },
  [D]: { vt: T.f64, abi: "J", toBits: OP.i64_reinterpret_f64, fromBits: OP.f64_reinterpret_i64 },
};
