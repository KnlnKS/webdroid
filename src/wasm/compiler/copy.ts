// Primitive arrays between Wasm GC arrays and linear memory: element sizes and the generated copy loop.
import { Code, OP } from "./code.ts";
import { T } from "./wasmbin.ts";
import type { Compiler } from "./j2w.ts";
import type { ElemKind } from "./consts.ts";

/** bytes per element, by storage kind */
export const SIZE: Record<ElemKind, number> = { i8: 1, i16: 2, i32: 4, i64: 8, ref: 4 };

/** copy(data, pointer, from, count): elements [from, from + count) of the array to (`toMem`) or from linear memory, where element i is at
 *  pointer + i * size. Eight bytes at a time through two 32-bit words, element by element for the tail and for 64-bit elements. */
export function copyFn(cx: Compiler, ek: ElemKind, toMem: boolean): number {
  return cx.memo(`copy:${ek}:${toMem}`, () => {
    const c = new Code(4), i = c.newLocal(T.i32), end = c.newLocal(T.i32), arr = cx.tData[ek], size = SIZE[ek], pack = size === 8 ? 1 : 4 / size;
    const get = (k: number) => { c.lget(0).lget(i); if (k) c.i32(k).raw(OP.i32_add); return ek === "i32" || ek === "i64" ? c.arrayGet(arr) : c.arrayGetU(arr); };
    const addr = () => c.lget(1).lget(i).i32(Math.log2(size)).raw(OP.i32_shl).raw(OP.i32_add);
    const advance = (n: number) => c.lget(i).i32(n).raw(OP.i32_add).lset(i);
    c.lget(2).lset(i).lget(2).lget(3).raw(OP.i32_add).lset(end);
    if (pack > 1 || ek === "i32") {
      const bits = 32 / pack, words = 2, step = pack * words, w = c.newLocal(T.i32);
      c.block().loop().lget(i).i32(step).raw(OP.i32_add).lget(end).raw(OP.i32_gt_s).brIf(1);
      for (let word = 0; word < words; word++) {
        if (toMem) {
          addr(); get(word * pack);
          for (let k = 1; k < pack; k++) get(word * pack + k).i32(k * bits).raw(OP.i32_shl).raw(OP.i32_or);
          c.mem(OP.i32_store, 0, word * 4);
        } else {
          addr().mem(OP.i32_load, 0, word * 4).lset(w);
          for (let k = 0; k < pack; k++) {
            c.lget(0).lget(i).i32(word * pack + k).raw(OP.i32_add).lget(w);
            if (k) c.i32(k * bits).raw(OP.i32_shr_u);
            c.arraySet(arr);
          }
        }
      }
      advance(step).br(0).end().end();
    }
    c.block().loop().lget(i).lget(end).raw(OP.i32_ge_s).brIf(1);
    if (toMem) {
      addr(); get(0);
      if (ek === "i16") c.mem(OP.i32_store16, 1); else if (ek === "i8") c.mem(OP.i32_store8, 0); else c.mem(ek === "i64" ? OP.i64_store : OP.i32_store, ek === "i64" ? 3 : 2);
    } else {
      c.lget(0).lget(i); addr();
      if (ek === "i16") c.mem(OP.i32_load16_u, 1); else if (ek === "i8") c.mem(OP.i32_load8_u, 0); else c.mem(ek === "i64" ? OP.i64_load : OP.i32_load, ek === "i64" ? 3 : 2);
      c.arraySet(arr);
    }
    advance(1).br(0).end().end();
    return cx.mb.addFunc(cx.mb.addFuncType([{ ht: arr, nullable: false }, T.i32, T.i32, T.i32], []), c.finish(), `$copy:${ek}:${toMem}`);
  });
}

/** pushes the value of local `v` with the bytes of its low 32 bits reversed */
function bswap32(c: Code, v: number): void {
  c.lget(v).i32(24).raw(OP.i32_shl).lget(v).i32(0xff00).raw(OP.i32_and).i32(8).raw(OP.i32_shl).raw(OP.i32_or)
    .lget(v).i32(8).raw(OP.i32_shr_u).i32(0xff00).raw(OP.i32_and).raw(OP.i32_or).lget(v).i32(24).raw(OP.i32_shr_u).raw(OP.i32_or);
}
/** copy as `copyFn`, with the bytes of each 16-, 32- or 64-bit element reversed on the way (a buffer in the order other than the machine's) */
export function copySwapFn(cx: Compiler, ek: "i16" | "i32" | "i64", toMem: boolean): number {
  return cx.memo(`copys:${ek}:${toMem}`, () => {
    const c = new Code(4), i = c.newLocal(T.i32), end = c.newLocal(T.i32), arr = cx.tData[ek], size = SIZE[ek];
    const v = c.newLocal(T.i32), hi = c.newLocal(T.i32), wide = c.newLocal(T.i64);
    const addr = () => c.lget(1).lget(i).i32(Math.log2(size)).raw(OP.i32_shl).raw(OP.i32_add);
    /** the element on the stack, reversed */
    const swap = () => {
      if (ek === "i16") { c.lset(v).lget(v).i32(0xff).raw(OP.i32_and).i32(8).raw(OP.i32_shl).lget(v).i32(8).raw(OP.i32_shr_u).i32(0xff).raw(OP.i32_and).raw(OP.i32_or); return; }
      if (ek === "i32") { c.lset(v); bswap32(c, v); return; }
      c.lset(wide).lget(wide).raw(OP.i32_wrap_i64).lset(v).lget(wide).i64(32n).raw(OP.i64_shr_u).raw(OP.i32_wrap_i64).lset(hi);
      bswap32(c, hi); c.raw(OP.i64_extend_i32_u); bswap32(c, v); c.raw(OP.i64_extend_i32_u).i64(32n).raw(OP.i64_shl).raw(OP.i64_or);
    };
    c.lget(2).lset(i).lget(2).lget(3).raw(OP.i32_add).lset(end);
    c.block().loop().lget(i).lget(end).raw(OP.i32_ge_s).brIf(1);
    if (toMem) {
      addr(); c.lget(0).lget(i); if (ek === "i16") c.arrayGetU(arr); else c.arrayGet(arr);
      swap();
      if (ek === "i16") c.mem(OP.i32_store16, 1); else c.mem(ek === "i64" ? OP.i64_store : OP.i32_store, ek === "i64" ? 3 : 2);
    } else {
      c.lget(0).lget(i); addr();
      if (ek === "i16") c.mem(OP.i32_load16_u, 1); else c.mem(ek === "i64" ? OP.i64_load : OP.i32_load, ek === "i64" ? 3 : 2);
      swap();
      c.arraySet(arr);
    }
    c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
    return cx.mb.addFunc(cx.mb.addFuncType([{ ht: arr, nullable: false }, T.i32, T.i32, T.i32], []), c.finish(), `$copys:${ek}:${toMem}`);
  });
}
