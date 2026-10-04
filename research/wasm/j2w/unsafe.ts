// jdk.internal.misc.Unsafe's object accessors, as field-id based operations (plan S2).
//
// An offset is a cookie: an instance field's is its id (class id << 12 | index, what Field.offset carries), an array element's is
// ARRAY_BASE + index * scale. Fields are reached through a generated accessor per (field, operation) that the host hands out as a
// table slot (hostUnsafe); arrays are handled inline: an element of the operation's own width directly, a wider access to a byte[] as
// little-endian bytes (what heap ByteBuffer views do). Raw addresses (the getInt(long) forms) belong to the native heap and stay
// with the production natives.
import { OP } from "./code";
import { T, refNull } from "./wasmbin";
import { kindOf, type Kind } from "./program";
import type { ElemKind } from "./consts";
import type { Code } from "./code";
import type { Compiler, Intrinsic } from "./j2w";
import type { World } from "./lazy";
import { idOfClass } from "./classes";

/** the first array element's offset, above every field id */
export const ARRAY_BASE = 1 << 30;
type Ty = "Z" | "B" | "S" | "C" | "I" | "F" | "J" | "D" | "L";
const TYPES: Ty[] = ["Z", "B", "S", "C", "I", "F", "J", "D", "L"];
const WIDTH: Record<Ty, number> = { Z: 1, B: 1, S: 2, C: 2, I: 4, F: 4, J: 8, D: 8, L: 4 };
const NAME: Record<Ty, string> = { Z: "Boolean", B: "Byte", S: "Short", C: "Char", I: "Int", F: "Float", J: "Long", D: "Double", L: "Reference" };
const desc = (t: Ty) => (t === "L" ? "Ljava/lang/Object;" : t);
const kindOfTy = (t: Ty): Kind => kindOf(desc(t));
const ELEM: Record<number, ElemKind> = { 1: "i8", 2: "i16", 4: "i32", 8: "i64" };

/** host.info kinds of this file */
export const enum UInfo { FieldGet = 100, FieldPut, FieldCas, ComponentScale, AllocInstance }
/** the table slot of the accessor of field `a` for the operation `kind` (the field's kind must be `b`: 0 int-like, 1 long-like, 2 reference), 0 if there is none;
 *  or, by class id `a`, the element width of arrays of it and a constructor-less allocator */
export function hostUnsafe(w: World, kind: UInfo, a: number, b: number): number {
  const name = w.nameOf(kind === UInfo.AllocInstance || kind === UInfo.ComponentScale ? a : a >>> 12);
  if (kind === UInfo.ComponentScale) return name[0] === "#" ? WIDTH[name[1] as Ty] : 4;
  if (kind === UInfo.AllocInstance) {
    const jc = w.prog.get(name);
    return !jc || jc.isInterface ? 0 : w.synthSlot("alloc:" + name, { params: [], ret: "L", body: (cx, c) => { cx.emitEnsure(c, name); cx.emitNew(c, name); } });
  }
  const f = w.prog.get(name)?.fields[a & 0xfff];
  if (!f || f.isStatic || f.kind !== (["I", "J", "L"] as const)[b]) return 0;
  const op = kind === UInfo.FieldGet ? "get" : kind === UInfo.FieldPut ? "put" : "cas", k = f.kind;
  const params: Kind[] = op === "get" ? ["L"] : op === "put" ? ["L", k] : ["L", k, k];
  return w.synthSlot(`uf:${op}:${a}`, { params, ret: op === "get" ? k : op === "put" ? "V" : "I", body: (cx, c) => {
    const st = cx.structFor(name), at = cx.fieldIndex(name, f), o = c.newLocal(refNull(st));
    c.lget(0).refCast(st).lset(o);
    if (op === "get") c.lget(o).structGet(st, at);
    else if (op === "put") c.lget(o).lget(1).structSet(st, at);
    else {
      c.lget(o).structGet(st, at).lget(1); if (k === "L") c.call(cx.helper("acmp")); else c.raw(k === "I" ? OP.i32_eq : OP.i64_eq);
      c.if_(T.i32).lget(o).lget(2).structSet(st, at).i32(1).else_().i32(0).end();
    }
  } });
}

export const unsafeIntrinsics = new Map<string, Intrinsic>();
const U = "jdk/internal/misc/Unsafe.";
const def = (key: string, f: (cx: Compiler, c: Code) => void) => unsafeIntrinsics.set(U + key, (cx, m, c) => f(cx, c));
/** locals: 0 = this, 1 = object, 2 = offset (long), then the operation's values */
const OBJ = 1, OFF = 2;

/** the array in local OBJ at index (offset - ARRAY_BASE) / width, as local `idx` */
const index = (c: Code, t: Ty): number => {
  const idx = c.newLocal(T.i32), shift = Math.log2(WIDTH[t]);
  c.lget(OFF).i64(BigInt(ARRAY_BASE)).raw(OP.i64_sub).raw(OP.i32_wrap_i64).i32(shift).raw(OP.i32_shr_u).lset(idx);
  return idx;
};
const slotOf = (cx: Compiler, c: Code, kind: UInfo, k: Kind): number => {
  const slot = c.newLocal(T.i32);
  cx.info(c, kind, () => c.lget(OFF).raw(OP.i32_wrap_i64), () => c.i32({ I: 0, J: 1, L: 2 }[k])); c.lset(slot);
  c.lget(slot).raw(OP.i32_eqz).if_(); cx.gap(c, "Unsafe: no accessor for this offset"); c.end();
  return slot;
};
const onArray = (c: Code) => c.lget(OFF).i64(BigInt(ARRAY_BASE)).raw(OP.i64_ge_s);

function emitGet(cx: Compiler, c: Code, t: Ty): void {
  const k = kindOfTy(t), w = WIDTH[t], ek: ElemKind = t === "L" ? "ref" : ELEM[w], { tArr, tData } = cx;
  const signed = t === "B" || t === "S";
  const wide = w === 8;
  onArray(c).if_(cx.vtOf(k));
  const idx = index(c, t);
  c.lget(OBJ).refTest(tArr[ek]).if_(cx.vtOf(k));
  c.lget(OBJ).refCast(tArr[ek]).structGet(tArr[ek], 2).lget(idx);
  if (ek === "i8" || ek === "i16") signed ? c.arrayGetS(tData[ek]) : c.arrayGetU(tData[ek]); else c.arrayGet(tData[ek]);
  c.else_();
  if (w > 1 && t !== "L") {            // a wider read of a byte[]: little-endian bytes
    const data = c.newLocal(refNull(tData.i8)), at = c.newLocal(T.i32);
    c.lget(OBJ).refTest(tArr.i8).if_(cx.vtOf(k));
    c.lget(OBJ).refCast(tArr.i8).structGet(tArr.i8, 2).lset(data);
    c.lget(OFF).i64(BigInt(ARRAY_BASE)).raw(OP.i64_sub).raw(OP.i32_wrap_i64).lset(at);
    wide ? c.i64(0n) : c.i32(0);
    for (let j = w - 1; j >= 0; j--) {
      wide ? c.i64(8n).raw(OP.i64_shl) : c.i32(8).raw(OP.i32_shl);
      c.lget(data).refAsNonNull().lget(at).i32(j).raw(OP.i32_add).arrayGetU(tData.i8);
      if (wide) c.raw(OP.i64_extend_i32_u, OP.i64_or); else c.raw(OP.i32_or);
    }
    if (t === "S") c.raw(OP.i32_extend16_s);
    c.else_(); cx.gap(c, `Unsafe.get${NAME[t]} on this array`); c.unreachable().end();
  } else { cx.gap(c, `Unsafe.get${NAME[t]} on this array`); c.unreachable(); }
  c.end();
  c.else_();
  const slot = slotOf(cx, c, UInfo.FieldGet, k);
  c.lget(OBJ).lget(slot).callIndirect(cx.sig(["L"], k));
  c.end();
}

function emitPut(cx: Compiler, c: Code, t: Ty): void {
  const k = kindOfTy(t), w = WIDTH[t], ek: ElemKind = t === "L" ? "ref" : ELEM[w], { tArr, tData } = cx, V = 3;
  onArray(c).if_();
  const idx = index(c, t);
  c.lget(OBJ).refTest(tArr[ek]).if_();
  c.lget(OBJ).refCast(tArr[ek]).structGet(tArr[ek], 2).lget(idx).lget(V).arraySet(tData[ek]);
  c.else_();
  if (w > 1 && t !== "L") {
    const data = c.newLocal(refNull(tData.i8)), at = c.newLocal(T.i32);
    c.lget(OBJ).refTest(tArr.i8).if_();
    c.lget(OBJ).refCast(tArr.i8).structGet(tArr.i8, 2).lset(data);
    c.lget(OFF).i64(BigInt(ARRAY_BASE)).raw(OP.i64_sub).raw(OP.i32_wrap_i64).lset(at);
    for (let j = 0; j < w; j++) {
      c.lget(data).refAsNonNull().lget(at).i32(j).raw(OP.i32_add).lget(V);
      if (j) { w === 8 ? c.i64(BigInt(8 * j)).raw(OP.i64_shr_u) : c.i32(8 * j).raw(OP.i32_shr_u); }
      if (w === 8) c.raw(OP.i32_wrap_i64);
      c.arraySet(tData.i8);
    }
    c.else_(); cx.gap(c, `Unsafe.put${NAME[t]} on this array`); c.unreachable().end();
  } else { cx.gap(c, `Unsafe.put${NAME[t]} on this array`); c.unreachable(); }
  c.end();
  c.else_();
  const slot = slotOf(cx, c, UInfo.FieldPut, k);
  c.lget(OBJ).lget(V).lget(slot).callIndirect(cx.sig(["L", k], "V"));
  c.end();
}

function emitCas(cx: Compiler, c: Code, t: "I" | "J" | "L"): void {
  const k = kindOfTy(t), ek: ElemKind = t === "L" ? "ref" : t === "I" ? "i32" : "i64", { tArr, tData } = cx, EXP = 3, NEW = 4;
  onArray(c).if_(T.i32);
  const idx = index(c, t), data = c.newLocal(refNull(tData[ek]));
  c.lget(OBJ).refCast(tArr[ek]).structGet(tArr[ek], 2).lset(data);
  c.lget(data).refAsNonNull().lget(idx).arrayGet(tData[ek]).lget(EXP); if (t === "L") c.call(cx.helper("acmp")); else c.raw(t === "I" ? OP.i32_eq : OP.i64_eq);
  c.if_(T.i32).lget(data).refAsNonNull().lget(idx).lget(NEW).arraySet(tData[ek]).i32(1).else_().i32(0).end();
  c.else_();
  const slot = slotOf(cx, c, UInfo.FieldCas, k);
  c.lget(OBJ).lget(EXP).lget(NEW).lget(slot).callIndirect(cx.sig(["L", k, k], "I"));
  c.end();
}

for (const t of TYPES) {
  const n = NAME[t], d = desc(t);
  const names = t === "L" ? ["Reference", "ReferenceVolatile"] : t === "I" || t === "J" ? [n, n + "Volatile"] : [n];
  for (const g of names) def(`get${g}(Ljava/lang/Object;J)${d}`, (cx, c) => emitGet(cx, c, t));
  const puts = t === "L" ? ["Reference", "ReferenceVolatile", "OrderedObject"] : t === "I" || t === "J" ? [n, n + "Volatile", "Ordered" + n] : [n];
  for (const p of puts) def(`put${p}(Ljava/lang/Object;J${d})V`, (cx, c) => emitPut(cx, c, t));
}
for (const [t, names] of [["I", ["compareAndSetInt", "compareAndSwapInt"]], ["J", ["compareAndSetLong", "compareAndSwapLong"]], ["L", ["compareAndSetReference", "compareAndSwapObject"]]] as const) {
  const d = desc(t);
  for (const n of names) def(`${n}(Ljava/lang/Object;J${d}${d})Z`, (cx, c) => emitCas(cx, c, t));
}
for (const f of ["fullFence", "loadFence", "storeFence"]) def(`${f}()V`, () => {});
def("addressSize()I", (cx, c) => { c.i32(8); });
def("pageSize()I", (cx, c) => { c.i32(4096); });
def("getArrayBaseOffsetForComponentType(Ljava/lang/Class;)I", (cx, c) => { c.i32(ARRAY_BASE); });
def("getArrayIndexScaleForComponentType(Ljava/lang/Class;)I", (cx, c) => { cx.info(c, UInfo.ComponentScale, () => { c.lget(0); idOfClass(cx, c); }); });
def("allocateInstance(Ljava/lang/Class;)Ljava/lang/Object;", (cx, c) => {
  const s = c.newLocal(T.i32);
  cx.info(c, UInfo.AllocInstance, () => { c.lget(1); idOfClass(cx, c); }); c.ltee(s).raw(OP.i32_eqz).if_(); cx.callThrower(c, "inste"); c.end();
  c.lget(s).callIndirect(cx.sig([], "L"));
});
