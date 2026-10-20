// libcore.io.Memory over the native core's memory, and the storage of direct buffers. ART allocates a DirectByteBuffer's bytes as a non-movable byte[]
// that native code sees at its address; a Wasm GC array cannot be seen from linear memory, so the buffer's MemoryRef takes a block of the core's
// memory instead (no array, `buffer` is null), freed when the MemoryRef is collected. Java code, natives and native code then read the same bytes.
// An address in the first 4 GiB above the core's reserved low pages is read and written by runtime functions over that memory (guest.ts); another is
// an external mapping or a higher plane, which the production natives answer.
import { Code, OP } from "../compiler/code.ts";
import { T } from "../compiler/wasmbin.ts";
import { rtfns } from "../compiler/rtfns.ts";
import { kindVT, type Compiler, type Intrinsic } from "../compiler/j2w.ts";
import type { MethodInfo } from "../compiler/program.ts";
import { elemKindOf } from "../compiler/consts.ts";
import { PRIMS } from "../../jvm/abi.ts";
import "./guest.ts";

/** the guest's first mapped address (src/native/abi.ts LOW) */
const LOW = 0x1_0000n;
const MEMORY = "libcore/io/Memory.", MEMORY_REF = "java/nio/DirectByteBuffer$MemoryRef";
/** External reads can page in; retain the native suspension epilogue, with no Java call target. */
export const nativeLeaf = (cx: Compiler, c: Code, m: MethodInfo): void => { const n = c.targets.length; cx.natives.call(cx, c, m); c.targets.length = n; };
export const memoryIntrinsics = new Map<string, Intrinsic>();

/** leaves 1 when all `width` bytes from the address `address` pushes (a long) are ones the runtime functions reach */
export const guestRange = (c: Code, address: () => void, width: number): Code => {
  address(); return c.i64(LOW).raw(OP.i64_sub).i64(0x1_0000_0000n - LOW - BigInt(width) + 1n).raw(OP.i64_lt_u);
};
const guest = (c: Code, a: number) => guestRange(c, () => c.lget(a), 1);

const SCALARS: [peek: string, poke: string, bits: 8 | 16 | 32 | 64][] = [["peekByte(J)B", "pokeByte(JB)V", 8], ["peekShortNative(J)S", "pokeShortNative(JS)V", 16],
  ["peekIntNative(J)I", "pokeIntNative(JI)V", 32], ["peekLongNative(J)J", "pokeLongNative(JJ)V", 64]];
export function memoryScalarMethod(cx: Compiler, peek: boolean, bits: 8 | 16 | 32 | 64): MethodInfo {
  const scalar = SCALARS.find(s => s[2] === bits)!, key = scalar[peek ? 0 : 1], at = key.indexOf("(");
  return cx.prog.resolve("libcore/io/Memory", key.slice(0, at), key.slice(at))!;
}
/** The view bridge inlines pure guest operations so cooperative lazy links cannot split an atomic access. */
export function emitMemoryScalar(cx: Compiler, c: Code, m: MethodInfo, peek: boolean, bits: 8 | 16 | 32 | 64, inlineRuntime = false): void {
  const call = (name: string) => {
    if (!inlineRuntime) { cx.callRt(c, name); return; }
    const d = rtfns.get(name)!;
    c.call(cx.defineFn(`memory:inline:${name}`, d.params.map(kindVT), d.ret === "V" ? [] : [kindVT(d.ret)], (body) => d.body(cx, body)));
  };
  guest(c, 0).if_(peek ? bits === 64 ? T.i64 : T.i32 : undefined).lget(0).raw(OP.i32_wrap_i64);
  if (!peek) c.lget(1);
  call(`${peek ? "gld" : "gst"}${bits}`);
  c.else_(); nativeLeaf(cx, c, m); c.end();
}
for (const [peek, poke, bits] of SCALARS) {
  memoryIntrinsics.set(MEMORY + peek, (cx, m, c) => emitMemoryScalar(cx, c, m, true, bits));
  memoryIntrinsics.set(MEMORY + poke, (cx, m, c) => emitMemoryScalar(cx, c, m, false, bits));
}

// peek/poke<Kind>Array(address, array, index, count[, swap]): count elements between native memory and the array's elements from index;
// a byte has no order to swap
for (const [d, { title }] of Object.entries(PRIMS)) if (d !== "Z") for (const peek of [true, false]) {
  const swaps = d !== "B", ek = elemKindOf("[" + d), sig = `${peek ? "peek" : "poke"}${title}Array(J[${d}II${swaps ? "Z" : ""})V`;
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
    c.else_(); nativeLeaf(cx, c, m); c.end();
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

// ART backs the direct buffers it allocates with a byte[], through which Cronet's Java side reads what native code wrote. Here array() answers a
// copy of the buffer's block made at the call; writes to it do not reach the block, so hasArray() stays false and code that checks it uses get and
// put. A buffer over other memory (JNI's) has no array, as in ART.
const BUFFER = "java/nio/ByteBuffer";
for (const array of [true, false]) memoryIntrinsics.set(`${BUFFER}.${array ? "array()[B" : "arrayOffset()I"}`, (cx, m, c) => {
  const get = (owner: string, name: string, desc: string) => { const st = cx.structFor(owner); c.refCast(st).structGet(st, cx.fieldIndex(owner, cx.prog.resolveField(owner, name, desc)!)); };
  const hb = c.newLocal(T.anyref), address = c.newLocal(T.i32), size = c.newLocal(T.i32), direct = "java/nio/DirectByteBuffer";
  c.lget(0); get(BUFFER, "hb", "[B"); c.ltee(hb).refIsNull().if_();
  c.lget(0); cx.emitInstanceOf(c, direct); c.if_();
  c.lget(0); get(direct, "memoryRef", `L${MEMORY_REF};`); get(MEMORY_REF, "allocatedAddress", "J"); c.raw(OP.i32_wrap_i64).ltee(address).call(cx.imp.gblock).lset(size);
  c.end();
  c.lget(size).raw(OP.i32_eqz).if_(); cx.throwNew(c, "java/lang/UnsupportedOperationException"); c.end();
  c.end();
  c.lget(0); get(BUFFER, "isReadOnly", "Z"); c.if_(); cx.throwNew(c, "java/nio/ReadOnlyBufferException"); c.end();
  if (!array) { c.lget(0); get(BUFFER, "offset", "I"); return; }
  c.lget(hb).refIsNull().if_();
  cx.emitNewArray(c, "[B", () => c.lget(size)); c.ltee(hb).i32(0).lget(size).lget(address).i32(0); cx.callRt(c, "gget_i8");
  c.end().lget(hb);
});
