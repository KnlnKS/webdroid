import { rt, JObj, driven, type Gen, type NativeSpec } from "../runtime";
import { PRIM_ARRAYS, type PrimElem, floatToIntBits, intBitsToFloat, doubleToLongBits, longBitsToDouble } from "../abi";
import { classDesc, type JClass } from "./jlang";
import { mem } from "../../native/mem";
import { physical } from "./jmemory";
import { addressSize } from "./jvmruntime";

// Java threads share one cooperative realm, so these non-suspending Unsafe operations
// need no host synchronization.
class JUnsafe extends JObj {}
const unsafe = new JUnsafe();
const sunMethods: NativeSpec["methods"] = {
  "static getUnsafe()Lsun/misc/Unsafe;": () => unsafe,
  // raw memory is the process's native heap (sun.nio.fs passes paths through it)
  "allocateMemory(J)J": (size: bigint) => {
    if (size < 0n || size > 0x7fffffffn) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    const p = mem.malloc(Number(size));
    if (!p) throw rt.mkThrowable("java/lang/OutOfMemoryError", null);
    return BigInt(mem.va(p));
  },
  "freeMemory(J)V": (address: bigint) => mem.free(physical(address)),
  "putByte(JB)V": (address: bigint, value: number) => mem.st8(physical(address), value),
  "setMemory(JJB)V": (address: bigint, bytes: bigint, value: number) => mem.memset(physical(address), value, Number(bytes)),
  // NativeObject's struct accessors (sun.nio.ch's iovecs), with pointers as wide as the guest's
  "addressSize()I": addressSize,
  "pageSize()I": () => 4096,
  "getByte(J)B": (a: bigint) => mem.ld8s(physical(a)),
  "getShort(J)S": (a: bigint) => mem.ld16s(physical(a)),
  "getChar(J)C": (a: bigint) => mem.ld16u(physical(a)),
  "getInt(J)I": (a: bigint) => mem.ld32(physical(a)),
  "getLong(J)J": (a: bigint) => mem.ld64(physical(a)),
  "getFloat(J)F": (a: bigint) => mem.ldf32(physical(a)),
  "getDouble(J)D": (a: bigint) => mem.ldf64(physical(a)),
  "putShort(JS)V": (a: bigint, v: number) => mem.st16(physical(a), v),
  "putChar(JC)V": (a: bigint, v: number) => mem.st16(physical(a), v),
  "putInt(JI)V": (a: bigint, v: number) => mem.st32(physical(a), v),
  "putLong(JJ)V": (a: bigint, v: bigint) => mem.st64(physical(a), v),
  "putFloat(JF)V": (a: bigint, v: number) => mem.stf32(physical(a), v),
  "putDouble(JD)V": (a: bigint, v: number) => mem.stf64(physical(a), v),
  "allocateInstance(Ljava/lang/Class;)Ljava/lang/Object;": driven(function* (cls: JClass): Gen {
    const info = cls.ci!;
    const p = rt.initClass(info); if (p) yield p;
    return new info.ctor();
  }),
  "objectFieldOffset(Ljava/lang/reflect/Field;)J": fieldOffset,
  "arrayBaseOffset(Ljava/lang/Class;)I": () => 0,
  "arrayIndexScale(Ljava/lang/Class;)I": arrayIndexScale,
  "getObject(Ljava/lang/Object;J)Ljava/lang/Object;": uGet,
  "getObjectVolatile(Ljava/lang/Object;J)Ljava/lang/Object;": uGet,
  "putObject(Ljava/lang/Object;JLjava/lang/Object;)V": uPut,
  "putObjectVolatile(Ljava/lang/Object;JLjava/lang/Object;)V": uPut,
  "putOrderedObject(Ljava/lang/Object;JLjava/lang/Object;)V": uPut,
  "compareAndSwapObject(Ljava/lang/Object;JLjava/lang/Object;Ljava/lang/Object;)Z": casRef,
  "compareAndSwapLong(Ljava/lang/Object;JJJ)Z": casLong,
  "compareAndSwapInt(Ljava/lang/Object;JII)Z": casInt,
  "getInt(Ljava/lang/Object;J)I": uGetInt,
  "putInt(Ljava/lang/Object;JI)V": uPutInt,
  "getLong(Ljava/lang/Object;J)J": uGetLong,
  "putLong(Ljava/lang/Object;JJ)V": uPutLong,
  ...Object.fromEntries(([
    ["Boolean", "Z", (v: DataView, at: number) => (v.getUint8(at) ? 1 : 0), (v: DataView, at: number, x: number) => v.setUint8(at, x ? 1 : 0)],
    ["Byte", "B", (v: DataView, at: number) => v.getInt8(at), (v: DataView, at: number, x: number) => v.setInt8(at, x)],
    ["Char", "C", (v: DataView, at: number) => v.getUint16(at, true), (v: DataView, at: number, x: number) => v.setUint16(at, x, true)],
    ["Short", "S", (v: DataView, at: number) => v.getInt16(at, true), (v: DataView, at: number, x: number) => v.setInt16(at, x, true)],
    ["Float", "F", (v: DataView, at: number) => v.getFloat32(at, true), (v: DataView, at: number, x: number) => v.setFloat32(at, x, true)],
    ["Double", "D", (v: DataView, at: number) => v.getFloat64(at, true), (v: DataView, at: number, x: number) => v.setFloat64(at, x, true)],
  ] as const).flatMap(([n, d, get, put]) => [
    [`get${n}(Ljava/lang/Object;J)${d}`, (o: any, off: bigint) => { const view = uView(o); if (view) return get(view, Number(off)); const v = uGet(o, off); return d === "Z" ? (v ? 1 : 0) : v ?? 0; }],
    [`put${n}(Ljava/lang/Object;J${d})V`, (o: any, off: bigint, v: number) => { const view = uView(o); if (view) put(view, Number(off), v); else uPut(o, off, v); }],
  ])),
  "getLongVolatile(Ljava/lang/Object;J)J": uGetLong,
  "getIntVolatile(Ljava/lang/Object;J)I": uGetInt,
  "putIntVolatile(Ljava/lang/Object;JI)V": uPutInt,
  "getAndAddInt(Ljava/lang/Object;JI)I": intRmw((a, b) => (a + b) | 0),
  "getAndAddLong(Ljava/lang/Object;JJ)J": longRmw((a, b) => BigInt.asIntN(64, a + b)),
  "getAndSetInt(Ljava/lang/Object;JI)I": intRmw((_, b) => b),
  "putLongVolatile(Ljava/lang/Object;JJ)V": uPutLong,
  "putOrderedLong(Ljava/lang/Object;JJ)V": uPutLong,
  "getAndSetObject(Ljava/lang/Object;JLjava/lang/Object;)Ljava/lang/Object;": getAndSetRef,
};
rt.register({ name: "sun/misc/Unsafe", ctor: JUnsafe, statics: { theUnsafe: unsafe }, methods: sunMethods });
// jdk.internal.misc.Unsafe keeps libcore's class for its statics and checked helpers. Its natives
// are sun.misc.Unsafe's operations under the JDK's names, where an object is a "Reference"; the
// accessors and read-modify-writes libcore composes from them (a getAndAdd is a volatile read and a
// weak CAS in a loop, three frames each) are single operations here.
{
  const O = "Ljava/lang/Object;", fence = () => {};
  const jdk: NonNullable<NativeSpec["methods"]> = {
    "addressSize()I": addressSize, "pageSize()I": () => 4096,
    "fullFence()V": fence, "loadFence()V": fence, "storeFence()V": fence, "loadLoadFence()V": fence, "storeStoreFence()V": fence,
    "getAndBitwiseAndInt(Ljava/lang/Object;JI)I": intRmw((a, b) => a & b),
    "getAndBitwiseOrInt(Ljava/lang/Object;JI)I": intRmw((a, b) => a | b),
    "getAndBitwiseXorInt(Ljava/lang/Object;JI)I": intRmw((a, b) => a ^ b),
    "getAndSetLong(Ljava/lang/Object;JJ)J": longRmw((_, b) => b),
    [`getAndSetReference(${O}J${O})${O}`]: getAndSetRef, [`getAndSetObject(${O}J${O})${O}`]: getAndSetRef,
  };
  for (const sig of ["getAndAddInt(Ljava/lang/Object;JI)I", "getAndSetInt(Ljava/lang/Object;JI)I", "getAndAddLong(Ljava/lang/Object;JJ)J",
    "allocateInstance(Ljava/lang/Class;)Ljava/lang/Object;", "allocateMemory(J)J", "freeMemory(J)V", "putByte(JB)V",
    ...[["Boolean", "Z"], ["Byte", "B"], ["Char", "C"], ["Short", "S"], ["Float", "F"], ["Double", "D"]].flatMap(([n, d]) => [`get${n}(${O}J)${d}`, `put${n}(${O}J${d})V`])])
    jdk[sig] = sunMethods[sig];
  for (const n of ["compareAndSwapInt", "compareAndSetInt", "weakCompareAndSetInt"]) jdk[`${n}(${O}JII)Z`] = casInt;
  for (const n of ["compareAndSwapLong", "compareAndSetLong"]) jdk[`${n}(${O}JJJ)Z`] = casLong;
  for (const n of ["compareAndSwapObject", "compareAndSetObject", "compareAndSetReference", "weakCompareAndSetReference"]) jdk[`${n}(${O}J${O}${O})Z`] = casRef;
  for (const m of ["", "Acquire", "Opaque", "Volatile"]) {
    jdk[`getInt${m}(${O}J)I`] = uGetInt;
    jdk[`getLong${m}(${O}J)J`] = uGetLong;
    jdk[`getReference${m}(${O}J)${O}`] = uGet;
    if (m !== "Opaque") jdk[`getObject${m}(${O}J)${O}`] = uGet;
  }
  for (const m of ["", "Release", "Opaque", "Volatile", "Ordered"]) {
    const put = m === "Ordered" ? "putOrdered" : "put", suffix = m === "Ordered" ? "" : m;
    jdk[`${put}Int${suffix}(${O}JI)V`] = uPutInt;
    jdk[`${put}Long${suffix}(${O}JJ)V`] = uPutLong;
    if (m !== "Ordered") jdk[`putReference${m}(${O}J${O})V`] = uPut;
    if (m !== "Opaque") jdk[`${put}Object${suffix}(${O}J${O})V`] = uPut;
  }
  rt.register({ name: "jdk/internal/misc/Unsafe", ctor: class extends JObj {}, platformClinit: true, methods: jdk });
  // private static natives, which only the class's own names reach
  rt.registerJnis("jdk/internal/misc/Unsafe", {
    "getArrayBaseOffsetForComponentType(Ljava/lang/Class;)I": () => 0,
    "getArrayIndexScaleForComponentType(Ljava/lang/Class;)I": (c: JClass) => PRIM_ARRAYS[classDesc(c) as PrimElem]?.BYTES_PER_ELEMENT ?? 4,
  });
}
// Unsafe "offsets" index this table of fields, with a stride of 8 so the word arithmetic
// protobuf's Android accessor applies to them (offset & ~3, (offset & 3) << 3) is an identity.
/** A field's accessors, compiled with its property name so each access stays monomorphic. An
 *  int or long access to a float or double field moves its bits. Reads of a field a TS object
 *  never set see its zero. */
interface UField {
  get(o: any): unknown; put(o: any, v: unknown): void;
  getInt(o: any): number; putInt(o: any, v: number): void;
  getLong(o: any): bigint; putLong(o: any, v: bigint): void;
}
const unsafeFields: UField[] = [];
const unsafeIndex = new Map<string, number>();
export function fieldOffset(f: { prop: string; desc: string }): bigint {
  const key = f.desc + ":" + f.prop;
  let i = unsafeIndex.get(key);
  if (i === undefined) {
    const at = `o[${JSON.stringify(f.prop)}]`, fl = f.desc === "F", db = f.desc === "D";
    i = unsafeFields.length;
    unsafeFields.push(new Function("F2I", "I2F", "D2L", "L2D", `return {
get(o){return ${at}},put(o,v){${at}=v},
getInt(o){return ${fl ? `F2I(${at}??0)` : `${at}??0`}},putInt(o,v){${at}=${fl ? "I2F(v)" : "v"}},
getLong(o){return ${db ? `D2L(${at}??0)` : `${at}??0n`}},putLong(o,v){${at}=${db ? "L2D(v)" : "v"}}}`)(
      floatToIntBits, intBitsToFloat, doubleToLongBits, longBitsToDouble));
    unsafeIndex.set(key, i);
  }
  return BigInt(i * 8);
}
// Each operation converts its offset once, as the low word of a BigInt64Array store: in V8 that is
// about half the cost of Number(), which is most of an access's cost.
const offWord = new BigInt64Array(1), offLow = new Int32Array(offWord.buffer);
const low32 = (off: bigint) => { offWord[0] = off; return offLow[0]; };
const uField = (off: bigint) => unsafeFields[low32(off) >> 3];
/** a reference: an object array's element (4 bytes each), or a field */
function uGet(o: any, off: bigint): unknown {
  if (Array.isArray(o)) return o[low32(off) >> 2] ?? null;
  if (ArrayBuffer.isView(o)) return (o as any)[Number(off)] ?? null;
  return uField(off).get(o) ?? null;
}
function uPut(o: any, off: bigint, v: unknown): void {
  if (Array.isArray(o)) o[low32(off) >> 2] = v;
  else if (ArrayBuffer.isView(o)) (o as any)[Number(off)] = v;
  else uField(off).put(o, v);
}
const unsafeViews = new WeakMap<object, DataView>();
function uView(o: unknown): DataView | null {
  if (!ArrayBuffer.isView(o)) return null;
  let view = unsafeViews.get(o);
  if (!view) { view = new DataView(o.buffer, o.byteOffset, o.byteLength); unsafeViews.set(o, view); }
  return view;
}
function viewGetInt(o: ArrayBufferView, off: bigint): number {
  const view = uView(o)!, offset = Number(off);
  if (offset + 4 <= view.byteLength || offset < 0 || offset >= view.byteLength) return view.getInt32(offset, true);
  let value = 0;
  for (let i = 0; offset + i < view.byteLength; i++) value |= view.getUint8(offset + i) << (i * 8);
  return value | 0;
}
function viewPutInt(o: ArrayBufferView, off: bigint, value: number): void {
  const view = uView(o)!, offset = Number(off);
  if (offset + 4 <= view.byteLength || offset < 0 || offset >= view.byteLength) { view.setInt32(offset, value, true); return; }
  for (let i = 0; offset + i < view.byteLength; i++) view.setUint8(offset + i, value >>> (i * 8));
}
function uGetInt(o: any, off: bigint): number { return ArrayBuffer.isView(o) ? viewGetInt(o, off) : uField(off).getInt(o); }
function uPutInt(o: any, off: bigint, value: number): void {
  if (ArrayBuffer.isView(o)) viewPutInt(o, off, value); else uField(off).putInt(o, value);
}
function uGetLong(o: any, off: bigint): bigint { return ArrayBuffer.isView(o) ? uView(o)!.getBigInt64(Number(off), true) : uField(off).getLong(o); }
function uPutLong(o: any, off: bigint, value: bigint): void {
  if (ArrayBuffer.isView(o)) uView(o)!.setBigInt64(Number(off), value, true); else uField(off).putLong(o, value);
}
/** an int read-modify-write returning the old value */
function intRmw(op: (cur: number, x: number) => number) { return (o: any, off: bigint, x: number) => {
  if (ArrayBuffer.isView(o)) { const old = viewGetInt(o, off); viewPutInt(o, off, op(old, x)); return old; }
  const f = uField(off), old = f.getInt(o);
  f.putInt(o, op(old, x));
  return old;
}; }
function longRmw(op: (cur: bigint, x: bigint) => bigint) { return (o: any, off: bigint, x: bigint) => {
  if (ArrayBuffer.isView(o)) { const view = uView(o)!, at = Number(off), old = view.getBigInt64(at, true); view.setBigInt64(at, op(old, x), true); return old; }
  const f = uField(off), old = f.getLong(o);
  f.putLong(o, op(old, x));
  return old;
}; }
function casInt(o: any, off: bigint, exp: number, val: number): number {
  if (ArrayBuffer.isView(o)) { if (viewGetInt(o, off) !== exp) return 0; viewPutInt(o, off, val); return 1; }
  const f = uField(off);
  if (f.getInt(o) !== exp) return 0;
  f.putInt(o, val); return 1;
}
function casLong(o: any, off: bigint, exp: bigint, val: bigint): number {
  if (ArrayBuffer.isView(o)) { const view = uView(o)!, at = Number(off); if (view.getBigInt64(at, true) !== exp) return 0; view.setBigInt64(at, val, true); return 1; }
  const f = uField(off);
  if (f.getLong(o) !== exp) return 0;
  f.putLong(o, val); return 1;
}
function casRef(o: any, off: bigint, exp: unknown, val: unknown): number {
  if (Array.isArray(o)) {
    const i = low32(off) >> 2, cur = o[i];
    if (cur !== exp && !(cur === undefined && exp === null)) return 0;
    o[i] = val; return 1;
  }
  const f = uField(off), cur = f.get(o);
  if (cur !== exp && !(cur === undefined && exp === null)) return 0;
  f.put(o, val); return 1;
}
function getAndSetRef(o: any, off: bigint, v: unknown): unknown {
  if (Array.isArray(o)) { const i = low32(off) >> 2, old = o[i] ?? null; o[i] = v; return old; }
  const f = uField(off), old = f.get(o) ?? null;
  f.put(o, v); return old;
}
function arrayIndexScale(cls: JClass): number {
  return PRIM_ARRAYS[cls.arrDesc?.[1] as PrimElem]?.BYTES_PER_ELEMENT ?? 4;
}
