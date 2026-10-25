// jdk.internal.misc.Unsafe's object accessors, as field-id based operations.
//
// An offset is a cookie: an instance field's is a small number the World gives the field when reflection hands out its offset (libraries keep offsets in 20 bits, as ART's fit), a static field's likewise, an array element's is
// ARRAY_BASE + index * scale. Fields are reached through a generated accessor per (field, operation) that the host hands out as a
// table slot (hostUnsafe); arrays are handled inline: an element of the operation's own width directly, a wider access to a byte[] as
// little-endian bytes (what heap ByteBuffer views do). Raw addresses (the getInt(long) forms) belong to the native heap and stay
// with the production natives.
import { OP } from "../compiler/code.ts";
import { T, refNull } from "../compiler/wasmbin.ts";
import { kindOf, type Kind } from "../compiler/program.ts";
import { elemKindOf, type ElemKind } from "../compiler/consts.ts";
import { SIZE } from "./copy.ts";
import { PRIMS } from "../../jvm/abi.ts";
import type { Code } from "../compiler/code.ts";
import type { Compiler, Intrinsic } from "../compiler/j2w.ts";
import type { World } from "./world.ts";
import { memberArg, synthFamily } from "./synths.ts";
import { PerWorld } from "./perworld.ts";
import { idOfClass } from "./classes.ts";

import { rt } from "../compiler/rtfns.ts";
import { nativeLeaf } from "./memory.ts";
import { UInfo } from "../compiler/info.ts";
import { fieldClass, fieldIndex } from "../compiler/fieldid.ts";
import { kindVT } from "../compiler/kinds.ts";

/** the first array element's offset, above every field id */
const ARRAY_BASE = 1 << 30;
/** the offsets handed out for fields, small so that a library which keeps them in 20 bits finds them again: field id to offset and back */
const cookies = new PerWorld(() => ({ ofField: new Map<number, number>(), fields: [] as number[] }));
export function fieldCookie(w: World, id: number): number {
  const t = cookies.get(w);
  let c = t.ofField.get(id);
  // Byte accessors align the offset down to a word before reading an int.
  if (c === undefined) { t.ofField.set(id, c = t.fields.push(id) * 8); }
  return c;
}
/** a primitive's descriptor, or L for a reference */
type Ty = string;
const width = (t: Ty) => (t === "L" ? 4 : PRIMS[t].size);
const desc = (t: Ty) => (t === "L" ? "Ljava/lang/Object;" : t);

/** the table slot of the accessor of field `a` for the operation `kind` (the field's kind must be `b`: 0 int-like, 1 long-like, 2 reference), 0 if there is none;
 *  or, by class id `a`, the element width of arrays of it and a constructor-less allocator */
export function hostUnsafe(w: World, kind: number, a: number, b: number): number {
  // the offset of an Unsafe access names its field by the number fieldCookie gave it; reflection passes the field's id itself
  if (kind >= UInfo.ObjGet && (a = cookies.peek(w)?.fields[a / 8 - 1] ?? -1) < 0) return 0;
  const name = w.nameOf(kind === UInfo.AllocInstance || kind === UInfo.ComponentScale ? a : fieldClass(a));
  if (kind === UInfo.ComponentScale) return name[0] === "#" ? PRIMS[name[1]]?.size ?? 0 : 4;
  if (kind === UInfo.AllocInstance) {
    const jc = w.prog.get(name);
    return !jc || jc.isInterface ? 0 : w.synthSlot("alloc:" + name, undefined, true);
  }
  const stat = kind === UInfo.StaticGet || kind === UInfo.StaticPut;
  const f = w.prog.get(name)?.fields[fieldIndex(a)];
  if (!f || f.isStatic !== stat || f.kind !== (["I", "J", "L"] as const)[b]) return 0;
  const op = kind === UInfo.FieldGet || kind === UInfo.StaticGet || kind === UInfo.ObjGet ? "get" : kind === UInfo.FieldPut || kind === UInfo.StaticPut || kind === UInfo.ObjPut ? "put" : "cas";
  // Field accessor bodies are pure; they are installed before their slot is returned so linking cannot split a VarHandle update
  return w.synthSlot(`uf:${stat ? "s" : ""}${op}:${name}:${fieldIndex(a)}`, undefined, true);
}
synthFamily("alloc", (_w, name) => ({ params: [], ret: "L", body: (cx, c) => { cx.emitEnsure(c, name); cx.emitNew(c, name); } }), true);
// uf:<op>:<class>:<field index>, op get, put or cas, or sget or sput for a static field
synthFamily("uf", (w, arg) => {
  const at = arg.indexOf(":"), op = arg.slice(0, at), [name, index] = memberArg(arg.slice(at + 1)), f = w.prog.get(name)?.fields[index], k = f?.kind;
  if (!f || !k) return undefined;
  // a static field's accessor takes the receiver slot too, so reflection reaches both kinds the same way
  if (op[0] === "s") return { params: op === "sget" ? ["L"] : ["L", k], ret: op === "sget" ? k : "V", body: (cx, c) => {
    const g = cx.staticGlobal(name, f.name, f.desc); if (op === "sget") c.gget(g); else c.lget(1).gset(g);
  } };
  return { params: op === "get" ? ["L"] : op === "put" ? ["L", k] : ["L", k, k], ret: op === "get" ? k : op === "put" ? "V" : "I", body: (cx, c) => {
    const st = cx.structFor(name), at = cx.fieldIndex(name, f), o = c.newLocal(refNull(st));
    c.lget(0).refCast(st).lset(o);
    const put = (v: number) => cx.emitFieldStore(c, name, f, () => c.lget(o), () => c.lget(v));
    if (op === "get") c.lget(o).structGet(st, at);
    else if (op === "put") put(1);
    else {
      c.lget(o).structGet(st, at).lget(1); if (k === "L") c.call(cx.helper("acmp")); else c.raw(k === "I" ? OP.i32_eq : OP.i64_eq);
      c.if_(T.i32); put(2); c.i32(1).else_().i32(0).end();
    }
  } };
}, true);

// Nine slots per field cookie: get/put/CAS for int/long/reference. Numbering rollback clears the cache.
rt("ufield", ["I", "I", "I"], "I", (cx, c) => {
  const t = cx.tVT, g = cx.global("rt", "unsafeSlots", refNull(t), true);
  const tab = c.newLocal(refNull(t)), index = c.newLocal(T.i32), n = c.newLocal(T.i32), slot = c.newLocal(T.i32);
  const query = () => c.i32(UInfo.ObjGet).lget(1).raw(OP.i32_add).lget(0).lget(2).call(cx.imp.info);
  c.lget(0).i32(7).raw(OP.i32_and).lget(0).i32(0).raw(OP.i32_le_s, OP.i32_or).if_(); query().ret(); c.end();
  c.lget(0).i32(3).raw(OP.i32_shr_u).i32(1).raw(OP.i32_sub).i32(9).raw(OP.i32_mul).lget(1).i32(3).raw(OP.i32_mul, OP.i32_add).lget(2).raw(OP.i32_add).lset(index);
  c.gget(g).ltee(tab).refIsNull().raw(OP.i32_eqz).if_();
  c.lget(index).lget(tab).refAsNonNull().arrayLen().raw(OP.i32_lt_u).if_();
  c.lget(tab).refAsNonNull().lget(index).arrayGet(t).ltee(slot).if_().lget(slot).ret().end().end().end();
  query().ltee(slot).raw(OP.i32_eqz).if_().i32(0).ret().end();
  // Linking a miss may roll back speculative slots; do not restore the old cache afterward.
  c.gget(g).ltee(tab).refIsNull().raw(OP.i32_eqz).if_().lget(tab).refAsNonNull().arrayLen().lset(n).end();
  c.lget(index).lget(n).raw(OP.i32_ge_u).if_();
  c.lget(index).i32(1).raw(OP.i32_add).lget(n).i32(1).raw(OP.i32_shl);
  c.lget(index).i32(1).raw(OP.i32_add).lget(n).i32(1).raw(OP.i32_shl, OP.i32_gt_u).select().arrayNewDefault(t).lset(tab);
  c.lget(n).if_().lget(tab).refAsNonNull().i32(0).gget(g).refAsNonNull().i32(0).lget(n).arrayCopy(t, t).end();
  c.lget(tab).gset(g).end();
  c.lget(tab).refAsNonNull().lget(index).lget(slot).arraySet(t).lget(slot);
}, true);

/** the array element holding byte `at` of the array (local `at`), as an i64 in `value` and the bit offset of the byte within it in `shift` */
function element(cx: Compiler, c: Code, ek: ElemKind, data: number, at: number, shift: number): void {
  const size = SIZE[ek], d = cx.tData[ek];
  c.lget(data).refAsNonNull().lget(at).i32(Math.log2(size)).raw(OP.i32_shr_u);
  if (ek === "i8" || ek === "i16") c.arrayGetU(d); else c.arrayGet(d);
  if (ek !== "i64") c.raw(OP.i64_extend_i32_u);
  c.lget(at).i32(size - 1).raw(OP.i32_and).i32(3).raw(OP.i32_shl).lset(shift);
}
// uget(array, byte offset, width): `width` bytes of the array from that offset, little-endian, in an i64
rt("uget", ["L", "I", "I"], "J", (cx, c) => {
  const res = c.newLocal(T.i64), k = c.newLocal(T.i32), at = c.newLocal(T.i32), shift = c.newLocal(T.i32);
  for (const ek of ["i8", "i16", "i32", "i64"] as const) {
    const t = cx.tArr[ek], data = c.newLocal(refNull(cx.tData[ek]));
    c.lget(0).refTest(t).if_().lget(0).refCast(t).structGet(t, 2).lset(data);
    c.lget(2).i32(1).raw(OP.i32_sub).lset(k);
    c.block().loop().lget(k).i32(0).raw(OP.i32_lt_s).brIf(1);
    c.lget(1).lget(k).raw(OP.i32_add).lset(at);
    element(cx, c, ek, data, at, shift);
    c.lget(shift).raw(OP.i64_extend_i32_u, OP.i64_shr_u).i64(0xffn).raw(OP.i64_and);
    c.lget(res).i64(8n).raw(OP.i64_shl).raw(OP.i64_or).lset(res);
    c.lget(k).i32(1).raw(OP.i32_sub).lset(k).br(0).end().end();
    c.lget(res).ret().end();
  }
  cx.gap(c, "Unsafe: a read of this array"); c.i64(0n);
}, true);
// uput(array, byte offset, width, value): the low `width` bytes of value into the array from that offset
rt("uput", ["L", "I", "I", "J"], "V", (cx, c) => {
  const k = c.newLocal(T.i32), at = c.newLocal(T.i32), shift = c.newLocal(T.i32);
  for (const ek of ["i8", "i16", "i32", "i64"] as const) {
    const t = cx.tArr[ek], d = cx.tData[ek], data = c.newLocal(refNull(d)), i64 = ek === "i64";
    c.lget(0).refTest(t).if_().lget(0).refCast(t).structGet(t, 2).lset(data);
    c.block().loop().lget(k).lget(2).raw(OP.i32_ge_s).brIf(1);
    c.lget(1).lget(k).raw(OP.i32_add).lset(at);
    c.lget(data).refAsNonNull().lget(at).i32(Math.log2(SIZE[ek])).raw(OP.i32_shr_u);
    element(cx, c, ek, data, at, shift);                        // the element, widened to i64
    c.i64(0xffn).lget(shift).raw(OP.i64_extend_i32_u, OP.i64_shl).i64(-1n).raw(OP.i64_xor, OP.i64_and);
    c.lget(3).lget(k).i32(3).raw(OP.i32_shl).raw(OP.i64_extend_i32_u, OP.i64_shr_u).i64(0xffn).raw(OP.i64_and).lget(shift).raw(OP.i64_extend_i32_u, OP.i64_shl).raw(OP.i64_or);
    if (!i64) c.raw(OP.i32_wrap_i64);
    c.arraySet(d);
    c.lget(k).i32(1).raw(OP.i32_add).lset(k).br(0).end().end().ret().end();
  }
  cx.gap(c, "Unsafe: a write of this array");
}, true);

export const unsafeIntrinsics = new Map<string, Intrinsic>();
/** the internal class and the one apps know (sun.misc.Unsafe, whose accessors are natives of the same shapes under older names) */
const UNSAFES = ["jdk/internal/misc/Unsafe", "sun/misc/Unsafe"];
const def = (key: string, f: (cx: Compiler, c: Code) => void) => {
  // the newer names (Reference, compareAndSet) are the internal class's only, and its getObject and putObject are bytecode over them
  const only = /Reference|compareAndSet/.test(key) ? 0 : /^(get|put)Object/.test(key) ? 1 : -1;
  UNSAFES.forEach((u, i) => { if (only < 0 || only === i) unsafeIntrinsics.set(`${u}.${key}`, (cx, m, c) => {
    if (key.includes("(Ljava/lang/Object;J")) {
      // A null base is a raw address. The host owns external mappings and their suspension.
      c.lget(1).refIsNull().if_();
      nativeLeaf(cx, c, m);
      c.ret().end();
    }
    f(cx, c);
  }); });
};
/** locals: 0 = this, 1 = object, 2 = offset (long), then the operation's values */
const OBJ = 1, OFF = 2;

/** the array in local OBJ at index (offset - ARRAY_BASE) / width, as local `idx` */
const index = (c: Code, t: Ty): number => {
  const idx = c.newLocal(T.i32), shift = Math.log2(width(t));
  c.lget(OFF).i64(BigInt(ARRAY_BASE)).raw(OP.i64_sub).raw(OP.i32_wrap_i64).i32(shift).raw(OP.i32_shr_u).lset(idx);
  return idx;
};
const slotOf = (cx: Compiler, c: Code, kind: UInfo, k: Kind): number => {
  const slot = c.newLocal(T.i32);
  c.lget(OFF).raw(OP.i32_wrap_i64).i32(kind - UInfo.ObjGet).i32({ I: 0, J: 1, L: 2 }[k]); cx.callRt(c, "ufield"); c.lset(slot);
  c.lget(slot).raw(OP.i32_eqz).if_(); cx.gap(c, "Unsafe: no accessor for this offset"); c.end();
  return slot;
};
const onArray = (c: Code) => c.lget(OFF).i64(BigInt(ARRAY_BASE)).raw(OP.i64_ge_s);

function emitGet(cx: Compiler, c: Code, t: Ty): void {
  const k = kindOf(t), w = width(t), ek = elemKindOf("[" + t), { tArr } = cx;
  onArray(c).if_(kindVT(k));
  const idx = index(c, t);
  c.lget(OBJ).refTest(tArr[ek]).if_(kindVT(k));
  c.lget(OBJ).refCast(tArr[ek]).structGet(tArr[ek], 2).lget(idx);
  cx.emitElementLoad(c, t);
  c.else_();
  // an access of another width than the array's elements: the bytes of the elements, little-endian, as a ByteBuffer view reads them
  if (t === "L") { cx.gap(c, "Unsafe.getReference on this array"); c.unreachable(); }
  else {
    c.lget(OBJ).lget(OFF).i64(BigInt(ARRAY_BASE)).raw(OP.i64_sub).raw(OP.i32_wrap_i64).i32(w); cx.callRt(c, "uget");
    if (k === "I") c.raw(OP.i32_wrap_i64);
    if (t === "B") c.raw(OP.i32_extend8_s); else if (t === "S") c.raw(OP.i32_extend16_s);
  }
  c.end();
  c.else_();
  const slot = slotOf(cx, c, UInfo.ObjGet, k);
  c.lget(OBJ).lget(slot).callIndirect(cx.sig(["L"], k));
  c.end();
}

function emitPut(cx: Compiler, c: Code, t: Ty): void {
  const k = kindOf(t), w = width(t), ek = elemKindOf("[" + t), { tArr, tData } = cx, V = 3;
  onArray(c).if_();
  const idx = index(c, t);
  c.lget(OBJ).refTest(tArr[ek]).if_();
  c.lget(OBJ).refCast(tArr[ek]).structGet(tArr[ek], 2).lget(idx).lget(V).arraySet(tData[ek]);
  c.else_();
  if (t === "L") { cx.gap(c, "Unsafe.putReference on this array"); c.unreachable(); }
  else {
    c.lget(OBJ).lget(OFF).i64(BigInt(ARRAY_BASE)).raw(OP.i64_sub).raw(OP.i32_wrap_i64).i32(w).lget(V);
    if (k === "I") c.raw(OP.i64_extend_i32_u);
    cx.callRt(c, "uput");
  }
  c.end();
  c.else_();
  const slot = slotOf(cx, c, UInfo.ObjPut, k);
  c.lget(OBJ).lget(V).lget(slot).callIndirect(cx.sig(["L", k], "V"));
  c.end();
}

function emitCas(cx: Compiler, c: Code, t: "I" | "J" | "L"): void {
  const k = kindOf(t), ek = elemKindOf("[" + t), { tArr, tData } = cx, EXP = 3, NEW = 4;
  onArray(c).if_(T.i32);
  const idx = index(c, t), data = c.newLocal(refNull(tData[ek]));
  c.lget(OBJ).refCast(tArr[ek]).structGet(tArr[ek], 2).lset(data);
  c.lget(data).refAsNonNull().lget(idx).arrayGet(tData[ek]).lget(EXP); if (t === "L") c.call(cx.helper("acmp")); else c.raw(t === "I" ? OP.i32_eq : OP.i64_eq);
  c.if_(T.i32).lget(data).refAsNonNull().lget(idx).lget(NEW).arraySet(tData[ek]).i32(1).else_().i32(0).end();
  c.else_();
  const slot = slotOf(cx, c, UInfo.ObjCas, k);
  c.lget(OBJ).lget(EXP).lget(NEW).lget(slot).callIndirect(cx.sig(["L", k, k], "I"));
  c.end();
}

for (const t of [...Object.keys(PRIMS), "L"]) {
  const n = t === "L" ? "Reference" : PRIMS[t].title, d = desc(t);
  const names = t === "L" ? ["Reference", "ReferenceVolatile", "Object", "ObjectVolatile"] : t === "I" || t === "J" ? [n, n + "Volatile"] : [n];
  for (const g of names) def(`get${g}(Ljava/lang/Object;J)${d}`, (cx, c) => emitGet(cx, c, t));
  const puts = t === "L" ? ["Reference", "ReferenceVolatile", "Object", "ObjectVolatile", "OrderedObject"] : t === "I" || t === "J" ? [n, n + "Volatile", "Ordered" + n] : [n];
  for (const p of puts) def(`put${p}(Ljava/lang/Object;J${d})V`, (cx, c) => emitPut(cx, c, t));
}
for (const [t, names] of [["I", ["compareAndSetInt", "compareAndSwapInt"]], ["J", ["compareAndSetLong", "compareAndSwapLong"]], ["L", ["compareAndSetReference", "compareAndSwapObject"]]] as const) {
  const d = desc(t);
  for (const n of names) def(`${n}(Ljava/lang/Object;J${d}${d})Z`, (cx, c) => emitCas(cx, c, t));
}
for (const f of ["fullFence", "loadFence", "storeFence"]) def(`${f}()V`, () => {});
def("pageSize()I", (cx, c) => { c.i32(4096); });
def("getArrayBaseOffsetForComponentType(Ljava/lang/Class;)I", (cx, c) => { c.i32(ARRAY_BASE); });
def("getArrayIndexScaleForComponentType(Ljava/lang/Class;)I", (cx, c) => { cx.info(c, UInfo.ComponentScale, () => { c.lget(0); idOfClass(cx, c); }); });
def("allocateInstance(Ljava/lang/Class;)Ljava/lang/Object;", (cx, c) => {
  const s = c.newLocal(T.i32);
  cx.info(c, UInfo.AllocInstance, () => { c.lget(1); idOfClass(cx, c); }); c.ltee(s).raw(OP.i32_eqz).if_(); cx.callThrower(c, "inste"); c.end();
  c.lget(s).callIndirect(cx.sig([], "L"));
});
