// Unsafe's natives over raw addresses: the process's native heap (sun.nio.fs passes paths through it,
// sun.nio.ch's NativeObject its iovecs) or an external mapping, whose accesses may suspend. The Wasm
// tier's intrinsics make every access to a Java object or array, and call these with a null base.
import { rt } from "../runtime.ts";
import { mem } from "../../native/mem.ts";
import { physical, isExternal, externalRead, externalWrite, writeAt } from "./jmemory.ts";

type Get = (view: DataView, at: number) => any;
type Put = (view: DataView, at: number, v: any) => void;
interface Prim { name: string; d: string; width: number; ld(p: number): any; st(p: number, v: any): void; get: Get; put: Put }
const PRIMS: Prim[] = [
  { name: "Boolean", d: "Z", width: 1, ld: (p) => mem.ld8s(p) ? 1 : 0, st: (p, v) => mem.st8(p, v ? 1 : 0), get: (v, i) => v.getUint8(i) ? 1 : 0, put: (v, i, x) => v.setUint8(i, x ? 1 : 0) },
  { name: "Byte", d: "B", width: 1, ld: (p) => mem.ld8s(p), st: (p, v) => mem.st8(p, v), get: (v, i) => v.getInt8(i), put: (v, i, x) => v.setInt8(i, x) },
  { name: "Short", d: "S", width: 2, ld: (p) => mem.ld16s(p), st: (p, v) => mem.st16(p, v), get: (v, i) => v.getInt16(i, true), put: (v, i, x) => v.setInt16(i, x, true) },
  { name: "Char", d: "C", width: 2, ld: (p) => mem.ld16u(p), st: (p, v) => mem.st16(p, v), get: (v, i) => v.getUint16(i, true), put: (v, i, x) => v.setUint16(i, x, true) },
  { name: "Int", d: "I", width: 4, ld: (p) => mem.ld32(p), st: (p, v) => mem.st32(p, v), get: (v, i) => v.getInt32(i, true), put: (v, i, x) => v.setInt32(i, x, true) },
  { name: "Long", d: "J", width: 8, ld: (p) => mem.ld64(p), st: (p, v) => mem.st64(p, v), get: (v, i) => v.getBigInt64(i, true), put: (v, i, x) => v.setBigInt64(i, x, true) },
  { name: "Float", d: "F", width: 4, ld: (p) => mem.ldf32(p), st: (p, v) => mem.stf32(p, v), get: (v, i) => v.getFloat32(i, true), put: (v, i, x) => v.setFloat32(i, x, true) },
  { name: "Double", d: "D", width: 8, ld: (p) => mem.ldf64(p), st: (p, v) => mem.stf64(p, v), get: (v, i) => v.getFloat64(i, true), put: (v, i, x) => v.setFloat64(i, x, true) },
];
const read = (k: Prim) => (a: bigint) => isExternal(a) ? externalRead(a, k.width, k.get) : k.ld(physical(a));
const write = (k: Prim) => (a: bigint, v: unknown) => isExternal(a) ? externalWrite(a, k.width, v, k.put) : k.st(physical(a), v);
const prim = (d: string) => PRIMS.find((k) => k.d === d)!;
const unsupportedRaw = (): never => { throw rt.mkThrowable("java/lang/UnsupportedOperationException", "raw reference or atomic Unsafe access is unsupported"); };

const O = "Ljava/lang/Object;";
/** both classes' natives: raw memory, and the (Object, long) accessors at a null base */
const shared: Record<string, Function> = {
  "allocateMemory(J)J": (size: bigint) => {
    if (size < 0n || size > 0x7fffffffn) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    const p = mem.malloc(Number(size));
    if (!p) throw rt.mkThrowable("java/lang/OutOfMemoryError", null);
    return BigInt(mem.va(p));
  },
  "freeMemory(J)V": (address: bigint) => mem.free(physical(address)),
  "putByte(JB)V": write(prim("B")),
  [`getIntVolatile(${O}J)I`]: (_o: null, a: bigint) => read(prim("I"))(a),
  [`getLongVolatile(${O}J)J`]: (_o: null, a: bigint) => read(prim("J"))(a),
  [`putIntVolatile(${O}JI)V`]: (_o: null, a: bigint, v: number) => write(prim("I"))(a, v),
  [`putLongVolatile(${O}JJ)V`]: (_o: null, a: bigint, v: bigint) => write(prim("J"))(a, v),
  [`putOrderedLong(${O}JJ)V`]: (_o: null, a: bigint, v: bigint) => write(prim("J"))(a, v),
  [`compareAndSwapInt(${O}JII)Z`]: unsupportedRaw, [`compareAndSwapLong(${O}JJJ)Z`]: unsupportedRaw,
  [`compareAndSwapObject(${O}J${O}${O})Z`]: unsupportedRaw, [`putOrderedObject(${O}J${O})V`]: unsupportedRaw,
};
for (const k of PRIMS) {
  const get = read(k), put = write(k);
  shared[`get${k.name}(${O}J)${k.d}`] = (_o: null, a: bigint) => get(a);
  shared[`put${k.name}(${O}J${k.d})V`] = (_o: null, a: bigint, v: unknown) => put(a, v);
}

const sun: Record<string, Function> = {
  ...shared,
  "setMemory(JJB)V": (address: bigint, bytes: bigint, value: number) =>
    isExternal(address) ? writeAt(address, new Uint8Array(Number(bytes)).fill(value)) : mem.memset(physical(address), value, Number(bytes)),
  [`getObject(${O}J)${O}`]: unsupportedRaw, [`getObjectVolatile(${O}J)${O}`]: unsupportedRaw,
  [`putObject(${O}J${O})V`]: unsupportedRaw, [`putObjectVolatile(${O}J${O})V`]: unsupportedRaw,
};
for (const k of PRIMS) if (k.d !== "Z") { sun[`get${k.name}(J)${k.d}`] = read(k); sun[`put${k.name}(J${k.d})V`] = write(k); }
rt.registerJnis("sun/misc/Unsafe", sun);

// jdk.internal.misc.Unsafe: the same operations under the JDK's names, where an object is a "Reference"
rt.registerJnis("jdk/internal/misc/Unsafe", {
  ...shared,
  [`putOrderedInt(${O}JI)V`]: (_o: null, a: bigint, v: number) => write(prim("I"))(a, v),
  [`compareAndSetInt(${O}JII)Z`]: unsupportedRaw, [`compareAndSetLong(${O}JJJ)Z`]: unsupportedRaw, [`compareAndSetReference(${O}J${O}${O})Z`]: unsupportedRaw,
  [`getReference(${O}J)${O}`]: unsupportedRaw, [`getReferenceVolatile(${O}J)${O}`]: unsupportedRaw,
  [`putReference(${O}J${O})V`]: unsupportedRaw, [`putReferenceVolatile(${O}J${O})V`]: unsupportedRaw,
});
