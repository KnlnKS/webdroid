// libcore.io.Memory over the native core's memory, and the storage of direct buffers. ART allocates a DirectByteBuffer's bytes as a non-movable byte[]
// that native code sees at its address; a Wasm GC array cannot be seen from linear memory, so the buffer's MemoryRef takes a block of the core's
// memory instead (no array, `buffer` is null), freed when the MemoryRef is collected. Java code, natives and native code then read the same bytes.
// An address in the first 4 GiB above the core's reserved low pages is read and written by runtime functions over that memory (guest.ts); another is
// an external mapping or a higher plane, which the production natives answer.
import { OP } from "../compiler/code";
import { T } from "../compiler/wasmbin";
import type { Code } from "../compiler/code";
import type { Intrinsic } from "../compiler/j2w";
import "./guest";

/** the guest's first mapped address (src/native/abi.ts LOW) */
const LOW = 0x1_0000n;
const MEMORY = "libcore/io/Memory.", MEMORY_REF = "java/nio/DirectByteBuffer$MemoryRef";
export const memoryIntrinsics = new Map<string, Intrinsic>();

/** leaves 1 when the address in local `a` (a long) is one the runtime functions reach */
const guest = (c: Code, a: number) => c.lget(a).i64(LOW).raw(OP.i64_sub).i64(0x1_0000_0000n - LOW).raw(OP.i64_lt_u);

const SCALARS: [peek: string, poke: string, bits: 8 | 16 | 32 | 64][] = [["peekByte(J)B", "pokeByte(JB)V", 8], ["peekShortNative(J)S", "pokeShortNative(JS)V", 16],
  ["peekIntNative(J)I", "pokeIntNative(JI)V", 32], ["peekLongNative(J)J", "pokeLongNative(JJ)V", 64]];
for (const [peek, poke, bits] of SCALARS) {
  memoryIntrinsics.set(MEMORY + peek, (cx, m, c) => {
    guest(c, 0).if_(bits === 64 ? T.i64 : T.i32).lget(0).raw(OP.i32_wrap_i64); cx.callRt(c, `gld${bits}`);
    c.else_(); cx.natives.call(cx, c, m); c.end();
  });
  memoryIntrinsics.set(MEMORY + poke, (cx, m, c) => {
    guest(c, 0).if_().lget(0).raw(OP.i32_wrap_i64).lget(1); cx.callRt(c, `gst${bits}`);
    c.else_(); cx.natives.call(cx, c, m); c.end();
  });
}

// peek/poke<Kind>Array(address, array, index, count[, swap]): count elements between native memory and the array's elements from index
const ARRAYS: [string, "i8" | "i16" | "i32" | "i64", boolean][] = [["Byte", "i8", false], ["Char", "i16", true], ["Short", "i16", true], ["Int", "i32", true],
  ["Long", "i64", true], ["Float", "i32", true], ["Double", "i64", true]];
const DESC: Record<string, string> = { Byte: "B", Char: "C", Short: "S", Int: "I", Long: "J", Float: "F", Double: "D" };
for (const [kind, ek, swaps] of ARRAYS) for (const peek of [true, false]) {
  const sig = `${peek ? "peek" : "poke"}${kind}Array(J[${DESC[kind]}II${swaps ? "Z" : ""})V`;
  memoryIntrinsics.set(MEMORY + sig, (cx, m, c) => {
    const ARR = 1, INDEX = 2, COUNT = 3, SWAP = 4, len = c.newLocal(T.i32), tArr = cx.tArr[ek];
    guest(c, 0).if_();
    c.lget(ARR).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
    c.lget(ARR).refCast(tArr).structGet(tArr, 2).arrayLen().lset(len);
    // index < 0 || count < 0 || index > len - count
    c.lget(INDEX).i32(0).raw(OP.i32_lt_s).lget(COUNT).i32(0).raw(OP.i32_lt_s).raw(OP.i32_or).lget(INDEX).lget(len).lget(COUNT).raw(OP.i32_sub).raw(OP.i32_gt_s).raw(OP.i32_or)
      .if_().lget(INDEX).lget(len); cx.callThrower(c, "aioobe"); c.end();
    c.lget(ARR).lget(INDEX).lget(COUNT).lget(0).raw(OP.i32_wrap_i64);
    if (swaps) c.lget(SWAP); else c.i32(0);
    cx.callRt(c, `${peek ? "gget" : "gput"}_${ek}`);
    c.else_(); cx.natives.call(cx, c, m); c.end();
  });
}

// MemoryRef(int capacity): the block, in place of ART's non-movable array and the address it gives
memoryIntrinsics.set(`${MEMORY_REF}.<init>(I)V`, (cx, m, c) => {
  const st = cx.structFor(MEMORY_REF), field = (name: string, desc: string) => cx.fieldIndex(MEMORY_REF, { owner: MEMORY_REF, name, desc }), address = c.newLocal(T.i64);
  c.lget(0).externConvertAny().lget(1).call(cx.imp.galloc).lset(address);
  c.lget(address).raw(OP.i64_eqz).if_().lget(1).raw(OP.i64_extend_i32_u); cx.callThrower(c, "oom"); c.end();
  c.lget(0).refCast(st).lget(address).structSet(st, field("allocatedAddress", "J"));
  c.lget(0).refCast(st).i32(1).structSet(st, field("isAccessible", "Z"));
});
