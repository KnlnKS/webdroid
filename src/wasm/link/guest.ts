// Runtime functions over the native core's memory (the "gmem" import of cx.guest()): scalar loads and stores at a 32-bit address, and copies of a
// primitive array's elements to and from it, which memory.ts calls for libcore.io.Memory. They are runtime functions, not inline code, so that the
// memory's type (shared or not) is declared by a module made when it is used, never by precompiled code.
import { Code, OP } from "../compiler/code.ts";
import { T } from "../compiler/wasmbin.ts";
import { SIZE, copyFn, copySwapFn } from "../compiler/copy.ts";
import { rt } from "../compiler/rtfns.ts";
import type { ElemKind } from "../compiler/consts.ts";
import type { Compiler } from "../compiler/j2w.ts";

function notifyWrite(cx: Compiler): number {
  return cx.memo("guest:wrote", () => {
    const c = new Code(2), page = c.newLocal(T.i32), end = c.newLocal(T.i32), last = c.newLocal(T.i32);
    const flags = cx.global("rt", "gflags", T.i32, false), shift = cx.w.opts.guest!.pageShift;
    c.lget(1).raw(OP.i32_eqz).if_().ret().end();
    c.lget(0).i32(shift).raw(OP.i32_shr_u).lset(page);
    c.lget(0).lget(1).raw(OP.i32_add).i32(1).raw(OP.i32_sub).ltee(last).i32(shift).raw(OP.i32_shr_u).lset(end);
    c.lget(last).lget(0).raw(OP.i32_lt_u).if_().i32(0xffffffff >>> shift).lset(end).end();
    c.loop().gget(flags).lget(page).raw(OP.i32_add).mem(OP.i32_load8_u, 0).i32(1).raw(OP.i32_and).if_();
    c.lget(0).lget(1).call(cx.imp.gwrote).ret().end();
    c.lget(page).lget(end).raw(OP.i32_lt_u).if_().lget(page).i32(1).raw(OP.i32_add).lset(page).br(1).end().end();
    return cx.mb.addFunc(cx.mb.addFuncType([T.i32, T.i32], []), c.finish(), "$guest:wrote");
  });
}

// gld<bits>(address): the value at address, a byte or short sign-extended; gst<bits>(address, value)
for (const [bits, op, store] of [[8, 0x2c, OP.i32_store8], [16, 0x2e, OP.i32_store16], [32, OP.i32_load, OP.i32_store], [64, OP.i64_load, OP.i64_store]] as const) {
  const wide = bits === 64, align = Math.log2(bits / 8);
  rt(`gld${bits}`, ["I"], wide ? "J" : "I", (cx, c) => { cx.guest(); c.lget(0).mem(op, align); }, true);
  rt(`gst${bits}`, wide ? ["I", "J"] : ["I", "I"], "V", (cx, c) => { cx.guest(); c.lget(0).lget(1).mem(store, align).lget(0).i32(bits / 8).call(notifyWrite(cx)); }, true);
}

// gget_<kind>(array, from, count, address, swap): count elements from the memory at address into the array from index `from`; gput_ the other way.
// Each element's bytes are reversed when swap is not 0.
for (const ek of ["i8", "i16", "i32", "i64"] as ElemKind[]) for (const toMem of [false, true]) {
  rt(`g${toMem ? "put" : "get"}_${ek}`, ["L", "I", "I", "I", "I"], "V", (cx, c) => {
    cx.guest();
    const t = cx.tArr[ek];
    // A later array access or memory store can trap after a partial copy.
    if (toMem) {
      const length = c.newLocal(T.i64);
      c.lget(2).i32(0).raw(OP.i32_gt_s).if_().lget(3);
      c.lget(2).raw(OP.i64_extend_i32_u).i64(BigInt(Math.log2(SIZE[ek]))).raw(OP.i64_shl).ltee(length).i64(0xffffffffn).raw(OP.i64_gt_u);
      c.if_(T.i32).i32(-1).else_().lget(length).raw(OP.i32_wrap_i64).end().call(notifyWrite(cx)).end();
    }
    // the copy functions place element 0 at their pointer
    const copy = (fn: number) => c.lget(0).refCast(t).structGet(t, 2).lget(3).lget(1).i32(Math.log2(SIZE[ek])).raw(OP.i32_shl).raw(OP.i32_sub).lget(1).lget(2).call(fn);
    if (ek === "i8") copy(copyFn(cx, ek, toMem));
    else { c.lget(4).if_(); copy(copySwapFn(cx, ek as "i16" | "i32" | "i64", toMem)); c.else_(); copy(copyFn(cx, ek, toMem)); c.end(); }
  }, true);
}
