// Unsafe's natives over raw addresses: the process's native heap (sun.nio.fs passes paths through it,
// sun.nio.ch's NativeObject its iovecs) or an external mapping, whose accesses may suspend. The Wasm
// tier's intrinsics make every access to a Java object or array, and call these with a null base.
import { rt } from "../runtime.ts";
import { PRIMS } from "../abi.ts";
import { mem } from "../../native/mem.ts";
import { physical, isExternal, externalRead, externalWrite, writeAt } from "./jmemory.ts";

type Get = (view: DataView, at: number) => any;
type Put = (view: DataView, at: number, v: any) => void;
/** each primitive's load and store in the native heap, and in an external mapping's DataView */
const ACCESS: Record<string, { ld(p: number): any; st(p: number, v: any): void; get: Get; put: Put }> = {
  Z: { ld: (p) => mem.ld8s(p) ? 1 : 0, st: (p, v) => mem.st8(p, v ? 1 : 0), get: (v, i) => v.getUint8(i) ? 1 : 0, put: (v, i, x) => v.setUint8(i, x ? 1 : 0) },
  B: { ld: (p) => mem.ld8s(p), st: (p, v) => mem.st8(p, v), get: (v, i) => v.getInt8(i), put: (v, i, x) => v.setInt8(i, x) },
  S: { ld: (p) => mem.ld16s(p), st: (p, v) => mem.st16(p, v), get: (v, i) => v.getInt16(i, true), put: (v, i, x) => v.setInt16(i, x, true) },
  C: { ld: (p) => mem.ld16u(p), st: (p, v) => mem.st16(p, v), get: (v, i) => v.getUint16(i, true), put: (v, i, x) => v.setUint16(i, x, true) },
  I: { ld: (p) => mem.ld32(p), st: (p, v) => mem.st32(p, v), get: (v, i) => v.getInt32(i, true), put: (v, i, x) => v.setInt32(i, x, true) },
  J: { ld: (p) => mem.ld64(p), st: (p, v) => mem.st64(p, v), get: (v, i) => v.getBigInt64(i, true), put: (v, i, x) => v.setBigInt64(i, x, true) },
  F: { ld: (p) => mem.ldf32(p), st: (p, v) => mem.stf32(p, v), get: (v, i) => v.getFloat32(i, true), put: (v, i, x) => v.setFloat32(i, x, true) },
  D: { ld: (p) => mem.ldf64(p), st: (p, v) => mem.stf64(p, v), get: (v, i) => v.getFloat64(i, true), put: (v, i, x) => v.setFloat64(i, x, true) },
};
const read = (d: string) => { const k = ACCESS[d], width = PRIMS[d].size; return (a: bigint) => isExternal(a) ? externalRead(a, width, k.get) : k.ld(physical(a)); };
const write = (d: string) => { const k = ACCESS[d], width = PRIMS[d].size; return (a: bigint, v: unknown) => isExternal(a) ? externalWrite(a, width, v, k.put) : k.st(physical(a), v); };
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
  "putByte(JB)V": write("B"),
  [`getIntVolatile(${O}J)I`]: (_o: null, a: bigint) => read("I")(a),
  [`getLongVolatile(${O}J)J`]: (_o: null, a: bigint) => read("J")(a),
  [`putIntVolatile(${O}JI)V`]: (_o: null, a: bigint, v: number) => write("I")(a, v),
  [`putLongVolatile(${O}JJ)V`]: (_o: null, a: bigint, v: bigint) => write("J")(a, v),
  [`putOrderedLong(${O}JJ)V`]: (_o: null, a: bigint, v: bigint) => write("J")(a, v),
  [`compareAndSwapInt(${O}JII)Z`]: unsupportedRaw, [`compareAndSwapLong(${O}JJJ)Z`]: unsupportedRaw,
  [`compareAndSwapObject(${O}J${O}${O})Z`]: unsupportedRaw, [`putOrderedObject(${O}J${O})V`]: unsupportedRaw,
};
for (const d in ACCESS) {
  const get = read(d), put = write(d), { title } = PRIMS[d];
  shared[`get${title}(${O}J)${d}`] = (_o: null, a: bigint) => get(a);
  shared[`put${title}(${O}J${d})V`] = (_o: null, a: bigint, v: unknown) => put(a, v);
}

const sun: Record<string, Function> = {
  ...shared,
  "setMemory(JJB)V": (address: bigint, bytes: bigint, value: number) =>
    isExternal(address) ? writeAt(address, new Uint8Array(Number(bytes)).fill(value)) : mem.memset(physical(address), value, Number(bytes)),
  [`getObject(${O}J)${O}`]: unsupportedRaw, [`getObjectVolatile(${O}J)${O}`]: unsupportedRaw,
  [`putObject(${O}J${O})V`]: unsupportedRaw, [`putObjectVolatile(${O}J${O})V`]: unsupportedRaw,
};
for (const d in ACCESS) if (d !== "Z") { sun[`get${PRIMS[d].title}(J)${d}`] = read(d); sun[`put${PRIMS[d].title}(J${d})V`] = write(d); }
rt.registerJnis("sun/misc/Unsafe", sun);

// jdk.internal.misc.Unsafe: the same operations under the JDK's names, where an object is a "Reference"
rt.registerJnis("jdk/internal/misc/Unsafe", {
  ...shared,
  [`putOrderedInt(${O}JI)V`]: (_o: null, a: bigint, v: number) => write("I")(a, v),
  [`compareAndSetInt(${O}JII)Z`]: unsupportedRaw, [`compareAndSetLong(${O}JJJ)Z`]: unsupportedRaw, [`compareAndSetReference(${O}J${O}${O})Z`]: unsupportedRaw,
  [`getReference(${O}J)${O}`]: unsupportedRaw, [`getReferenceVolatile(${O}J)${O}`]: unsupportedRaw,
  [`putReference(${O}J${O})V`]: unsupportedRaw, [`putReferenceVolatile(${O}J${O})V`]: unsupportedRaw,
});
