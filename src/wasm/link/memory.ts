// libcore.io.Memory over the byte[] a direct buffer lives in. ART allocates a DirectByteBuffer's storage with VMRuntime.newNonMovableArray and
// reaches it by the address VMRuntime.addressOf names. In the Wasm heap that array cannot move either, but it is not in linear memory, so
// addressOf pins it in a table and answers an address that says which: NM_BASE + (table index << 32) + byte offset. The peek and poke natives
// read and write the array when handed such an address, and every other address is native memory, which the production natives answer.
import { OP } from "../compiler/code";
import { T, refNull } from "../compiler/wasmbin";
import type { Code } from "../compiler/code";
import type { Compiler, Intrinsic } from "../compiler/j2w";

/** the pinned arrays' address space, above the external mappings' (jmemory.ts EXTERNAL..EXTERNAL * 2) */
const NM_BASE = 1n << 50n, NM_TABLE = 1;
const MEMORY = "libcore/io/Memory.";
export const memoryIntrinsics = new Map<string, Intrinsic>();

/** leaves 1 when the address in local `a` is a pinned array's */
const isPinned = (c: Code, a: number) => c.lget(a).i64(50n).raw(OP.i64_shr_u).i64(1n).raw(OP.i64_eq);

/** the byte[] address local `a` names (a local) and the offset of its first byte in it (a local); n bytes from there must be inside it */
function locate(cx: Compiler, c: Code, a: number, n: () => void): { data: number; off: number } {
  const data = c.newLocal(refNull(cx.tData.i8)), off = c.newLocal(T.i32), len = c.newLocal(T.i32), tArr = cx.tArr.i8;
  c.lget(a).i64(32n).raw(OP.i64_shr_u, OP.i32_wrap_i64).i32(0x3ffff).raw(OP.i32_and).tableGet(NM_TABLE).anyConvertExtern().refCast(tArr).structGet(tArr, 2).lset(data);
  c.lget(a).raw(OP.i32_wrap_i64).lset(off).lget(data).refAsNonNull().arrayLen().lset(len);
  // off + n > len, in unsigned arithmetic
  c.lget(off).lget(len).raw(OP.i32_gt_u); n(); c.lget(len).lget(off).raw(OP.i32_sub).raw(OP.i32_gt_u).raw(OP.i32_or).if_().lget(off).lget(len); cx.callThrower(c, "aioobe"); c.end();
  return { data, off };
}

/** where byte p of a `w`-byte value goes: reversed (a static `true`) or as it is, or reversed when local `swap` is 1 */
function bytePos(c: Code, p: number, w: number, swap: number | boolean): void {
  if (typeof swap === "number") c.i32(p).lget(swap).i32(w - 1).raw(OP.i32_mul).raw(OP.i32_xor); else c.i32(swap ? w - 1 - p : p);
}
/** pushes the `w`-byte little-endian value at byte p of `data` + `off`, its bytes taken in reverse when `swap` says so; w is 1, 2, 4 or 8 */
function load(cx: Compiler, c: Code, data: number, off: number, at: () => void, w: number, swap: number | boolean = false): void {
  const byteAt = (p: number) => {
    c.lget(data).refAsNonNull().lget(off); at(); c.raw(OP.i32_add);
    bytePos(c, p, w, swap);
    c.raw(OP.i32_add).arrayGetU(cx.tData.i8);
  };
  if (w === 8) c.i64(0n); else c.i32(0);
  for (let p = w - 1; p >= 0; p--) {
    if (w === 8) c.i64(8n).raw(OP.i64_shl); else c.i32(8).raw(OP.i32_shl);
    byteAt(p);
    if (w === 8) c.raw(OP.i64_extend_i32_u, OP.i64_or); else c.raw(OP.i32_or);
  }
}
/** stores the `w`-byte value in local `v` little-endian at `data` + `off` + at, bytes reversed when `swap` says so */
function store(cx: Compiler, c: Code, data: number, off: number, at: () => void, w: number, v: () => void, swap: number | boolean = false): void {
  for (let p = 0; p < w; p++) {
    c.lget(data).refAsNonNull().lget(off); at(); c.raw(OP.i32_add);
    bytePos(c, p, w, swap);
    c.raw(OP.i32_add);
    v();
    if (p) { w === 8 ? c.i64(BigInt(8 * p)).raw(OP.i64_shr_u) : c.i32(8 * p).raw(OP.i32_shr_u); }
    if (w === 8) c.raw(OP.i32_wrap_i64);
    c.arraySet(cx.tData.i8);
  }
}

const SCALARS: [string, number][] = [["peekByte(J)B", 1], ["peekShortNative(J)S", 2], ["peekIntNative(J)I", 4], ["peekLongNative(J)J", 8]];
for (const [sig, w] of SCALARS) memoryIntrinsics.set(MEMORY + sig, (cx, m, c) => {
  const ret = w === 8 ? T.i64 : T.i32;
  isPinned(c, 0).if_(ret);
  const { data, off } = locate(cx, c, 0, () => c.i32(w));
  if (w === 1) c.lget(data).refAsNonNull().lget(off).arrayGetS(cx.tData.i8);
  else { load(cx, c, data, off, () => c.i32(0), w); if (w === 2) c.raw(OP.i32_extend16_s); }
  c.else_(); cx.natives.call(cx, c, m); c.end();
});
for (const [sig, w] of [["pokeByte(JB)V", 1], ["pokeShortNative(JS)V", 2], ["pokeIntNative(JI)V", 4], ["pokeLongNative(JJ)V", 8]] as const) memoryIntrinsics.set(MEMORY + sig, (cx, m, c) => {
  isPinned(c, 0).if_();
  const { data, off } = locate(cx, c, 0, () => c.i32(w));
  store(cx, c, data, off, () => c.i32(0), w, () => c.lget(1));
  c.else_(); cx.natives.call(cx, c, m); c.end();
});

// peek/poke<Kind>Array(address, array, index, count[, swap]): count elements between native memory and the array's elements from index
const ARRAYS: [string, "i8" | "i16" | "i32" | "i64", number, boolean][] = [["Byte", "i8", 1, false], ["Char", "i16", 2, true], ["Short", "i16", 2, true], ["Int", "i32", 4, true],
  ["Long", "i64", 8, true], ["Float", "i32", 4, true], ["Double", "i64", 8, true]];
const DESC: Record<string, string> = { Byte: "B", Char: "C", Short: "S", Int: "I", Long: "J", Float: "F", Double: "D" };
for (const [kind, ek, w, swaps] of ARRAYS) for (const peek of [true, false]) {
  const sig = `${peek ? "peek" : "poke"}${kind}Array(J[${DESC[kind]}II${swaps ? "Z" : ""})V`;
  memoryIntrinsics.set(MEMORY + sig, (cx, m, c) => {
    const ARR = 1, INDEX = 2, COUNT = 3, SWAP = swaps ? 4 : -1;
    isPinned(c, 0).if_();
    c.lget(ARR).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
    const arr = c.newLocal(refNull(cx.tData[ek])), len = c.newLocal(T.i32), i = c.newLocal(T.i32);
    c.lget(ARR).refCast(cx.tArr[ek]).structGet(cx.tArr[ek], 2).lset(arr).lget(arr).refAsNonNull().arrayLen().lset(len);
    // index < 0 || count < 0 || index > len - count
    c.lget(INDEX).i32(0).raw(OP.i32_lt_s).lget(COUNT).i32(0).raw(OP.i32_lt_s).raw(OP.i32_or).lget(INDEX).lget(len).lget(COUNT).raw(OP.i32_sub).raw(OP.i32_gt_s).raw(OP.i32_or)
      .if_().lget(INDEX).lget(len); cx.callThrower(c, "aioobe"); c.end();
    const { data, off } = locate(cx, c, 0, () => c.lget(COUNT).i32(w).raw(OP.i32_mul));
    // the loop is emitted once for each byte order, the order tested once
    const pos = c.newLocal(T.i32), v = c.newLocal(w === 8 ? T.i64 : T.i32);
    const loop = (rev: boolean) => {
      c.i32(0).lset(i).lget(off).lset(pos);
      c.block().loop().lget(i).lget(COUNT).raw(OP.i32_ge_s).brIf(1);
      if (peek) {
        c.lget(arr).refAsNonNull().lget(INDEX).lget(i).raw(OP.i32_add);
        load(cx, c, data, pos, () => c.i32(0), w, rev);
        c.arraySet(cx.tData[ek]);
      } else {
        c.lget(arr).refAsNonNull().lget(INDEX).lget(i).raw(OP.i32_add); ek === "i8" || ek === "i16" ? c.arrayGetU(cx.tData[ek]) : c.arrayGet(cx.tData[ek]); c.lset(v);
        store(cx, c, data, pos, () => c.i32(0), w, () => c.lget(v), rev);
      }
      c.lget(i).i32(1).raw(OP.i32_add).lset(i).lget(pos).i32(w).raw(OP.i32_add).lset(pos).br(0).end().end();
    };
    if (ek === "i8") {
      // byte to byte is a copy of the range
      if (peek) c.lget(arr).refAsNonNull().lget(INDEX).lget(data).refAsNonNull().lget(off).lget(COUNT).arrayCopy(cx.tData.i8, cx.tData.i8);
      else c.lget(data).refAsNonNull().lget(off).lget(arr).refAsNonNull().lget(INDEX).lget(COUNT).arrayCopy(cx.tData.i8, cx.tData.i8);
    } else { c.lget(SWAP).if_(); loop(true); c.else_(); loop(false); c.end(); }
    c.else_(); cx.natives.call(cx, c, m); c.end();
  });
}

// VMRuntime.addressOf(array): a byte[] is pinned (the one direct buffers allocate), anything else is the production handle
memoryIntrinsics.set("dalvik/system/VMRuntime.addressOf(Ljava/lang/Object;)J", (cx, m, c) => {
  c.lget(1).refTest(cx.tArr.i8).if_(T.i64);
  c.lget(1).externConvertAny().call(cx.imp.pin).raw(OP.i64_extend_i32_u).i64(32n).raw(OP.i64_shl).i64(NM_BASE).raw(OP.i64_or);
  c.else_(); cx.natives.call(cx, c, m); c.end();
});
