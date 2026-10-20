// Unsafe's natives over raw addresses: the process's native heap (sun.nio.fs passes paths through it,
// sun.nio.ch's NativeObject its iovecs) or an external mapping, whose accesses may suspend. The Wasm
// tier's intrinsics make every access to a Java object or array, and call these with a null base.
import { rt, waits } from "../runtime.ts";
import { PRIMS } from "../abi.ts";
import { mem } from "../../native/mem.ts";
import { physical, isExternal, peek, poke, writeAt } from "./jmemory.ts";
import { addressSize } from "./jvmruntime.ts";

const unsupportedRaw = (): never => { throw rt.mkThrowable("java/lang/UnsupportedOperationException", "raw reference or atomic Unsafe access is unsupported"); };

const O = "Ljava/lang/Object;", peekI = peek("I"), peekJ = peek("J"), pokeI = poke("I"), pokeJ = poke("J");
/** both classes' natives: raw memory, and the (Object, long) accessors at a null base */
const shared: Record<string, Function> = {
  "addressSize()I": addressSize,
  "allocateMemory(J)J": (size: bigint) => {
    if (size < 0n || size > 0x7fffffffn) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    const p = mem.malloc(Number(size));
    if (!p) throw rt.mkThrowable("java/lang/OutOfMemoryError", null);
    return BigInt(mem.va(p));
  },
  "freeMemory(J)V": (address: bigint) => mem.free(physical(address)),
  "setMemory(JJB)V": (address: bigint, bytes: bigint, value: number) =>
    isExternal(address) ? writeAt(address, new Uint8Array(Number(bytes)).fill(value)) : mem.memset(physical(address), value, Number(bytes)),
  [`getIntVolatile(${O}J)I`]: waits((_o: null, a: bigint) => peekI(a)),
  [`getLongVolatile(${O}J)J`]: waits((_o: null, a: bigint) => peekJ(a)),
  [`putIntVolatile(${O}JI)V`]: (_o: null, a: bigint, v: number) => pokeI(a, v),
  [`putLongVolatile(${O}JJ)V`]: (_o: null, a: bigint, v: bigint) => pokeJ(a, v),
  [`putOrderedLong(${O}JJ)V`]: (_o: null, a: bigint, v: bigint) => pokeJ(a, v),
  [`compareAndSwapInt(${O}JII)Z`]: unsupportedRaw, [`compareAndSwapLong(${O}JJJ)Z`]: unsupportedRaw,
  [`compareAndSwapObject(${O}J${O}${O})Z`]: unsupportedRaw, [`putOrderedObject(${O}J${O})V`]: unsupportedRaw,
};
for (const d in PRIMS) {
  const get = peek(d), put = poke(d), { title } = PRIMS[d];
  shared[`get${title}(${O}J)${d}`] = waits((_o: null, a: bigint) => get(a));
  shared[`put${title}(${O}J${d})V`] = (_o: null, a: bigint, v: unknown) => put(a, v);
  if (d !== "Z") { shared[`get${title}(J)${d}`] = get; shared[`put${title}(J${d})V`] = put; }
}

rt.registerJnis("sun/misc/Unsafe", {
  ...shared,
  [`getObject(${O}J)${O}`]: unsupportedRaw, [`getObjectVolatile(${O}J)${O}`]: unsupportedRaw,
  [`putObject(${O}J${O})V`]: unsupportedRaw, [`putObjectVolatile(${O}J${O})V`]: unsupportedRaw,
});
// jdk.internal.misc.Unsafe: the same operations under the JDK's names, where an object is a "Reference"
rt.registerJnis("jdk/internal/misc/Unsafe", {
  ...shared,
  [`putOrderedInt(${O}JI)V`]: (_o: null, a: bigint, v: number) => pokeI(a, v),
  [`compareAndSetInt(${O}JII)Z`]: unsupportedRaw, [`compareAndSetLong(${O}JJJ)Z`]: unsupportedRaw, [`compareAndSetReference(${O}J${O}${O})Z`]: unsupportedRaw,
  [`getReference(${O}J)${O}`]: unsupportedRaw, [`getReferenceVolatile(${O}J)${O}`]: unsupportedRaw,
  [`putReference(${O}J${O})V`]: unsupportedRaw, [`putReferenceVolatile(${O}J${O})V`]: unsupportedRaw,
});
