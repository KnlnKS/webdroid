// Functions of every module that its code calls directly, defined on first use (Compiler.helper). They are the same in every module, so a sharing unit
// imports or exports them.
import { HEAP_LIMIT } from "../../jvm/abi.ts";
import { OP, type Code } from "./code.ts";
import { HT, T, ref, refNull, type VT } from "./wasmbin.ts";
import { H, type ElemKind } from "./consts.ts";
import { ALLOC_WINDOW } from "./exc.ts";
import { Block, Sync, emitBlock, emitSync } from "./hostcalls.ts";
import type { Compiler } from "./j2w.ts";

interface Helper { params: VT[]; results: VT[]; body: (c: Code) => void }
/** by name, a helper's signature and body in a Compiler's module */
export const helpers = new Map<string, (cx: Compiler) => Helper>();
const def = (name: string, make: (cx: Compiler) => Helper) => { helpers.set(name, make); };
const L = T.anyref;

for (const [name, wide, rem] of [["idiv", false, false], ["irem", false, true], ["ldiv", true, false], ["lrem", true, true]] as const) def(name, (cx) => {
  const W = wide ? T.i64 : T.i32;
  return { params: [W, W], results: [W], body: (c) => {
    c.lget(1).raw(wide ? OP.i64_eqz : OP.i32_eqz).if_(); cx.callThrower(c, "arith"); c.end();
    // x / -1 = -x and x % -1 = 0 without the INT_MIN trap
    c.lget(1); wide ? c.i64(-1n) : c.i32(-1); c.raw(wide ? OP.i64_eq : OP.i32_eq).if_(W);
    if (rem) wide ? c.i64(0n) : c.i32(0);
    else { wide ? c.i64(0n) : c.i32(0); c.lget(0).raw(wide ? OP.i64_sub : OP.i32_sub); }
    c.else_().lget(0).lget(1).raw(wide ? (rem ? OP.i64_rem_s : OP.i64_div_s) : (rem ? OP.i32_rem_s : OP.i32_div_s)).end();
  } };
});
for (const [name, W, lt, gt, eq, nanGreater] of [["cmplf", T.f32, OP.f32_lt, OP.f32_gt, OP.f32_eq, false], ["cmpgf", T.f32, OP.f32_lt, OP.f32_gt, OP.f32_eq, true],
  ["cmpld", T.f64, OP.f64_lt, OP.f64_gt, OP.f64_eq, false], ["cmpgd", T.f64, OP.f64_lt, OP.f64_gt, OP.f64_eq, true]] as const) def(name, () => ({ params: [W, W], results: [T.i32], body: (c) => {
  c.lget(0).lget(1).raw(eq).if_(T.i32).i32(0).else_();
  if (nanGreater) c.lget(0).lget(1).raw(lt).if_(T.i32).i32(-1).else_().i32(1).end();
  else c.lget(0).lget(1).raw(gt).if_(T.i32).i32(1).else_().i32(-1).end();
  c.end();
} }));
/** obj when it is null or passes `test` (of obj, class id and any depth), else ClassCastException */
const cast = (name: string, params: VT[], test: (cx: Compiler, c: Code) => void) => def(name, (cx) => ({ params: [L, T.i32, ...params], results: [L], body: (c) => {
  c.lget(0).refIsNull().raw(OP.i32_eqz).if_();
  test(cx, c);
  c.raw(OP.i32_eqz).if_().lget(0).call(cx.helper("vtab")).i32(H.ID).arrayGet(cx.tVT).lget(1); cx.callThrower(c, "cce"); c.end();
  c.end().lget(0);
} }));
cast("cast", [T.i32], (cx, c) => c.lget(0).lget(1).lget(2).call(cx.helper("iof")));
cast("castImpl", [], (cx, c) => c.lget(0).lget(1).call(cx.helper("implements")));
cast("castArr", [], (cx, c) => { c.lget(0).lget(1); cx.callRt(c, "instArr"); });
// iof(obj, class id, depth): obj != null && vt[DEPTH] >= depth && vt[DISPLAY + depth] == id
def("iof", (cx) => ({ params: [L, T.i32, T.i32], results: [T.i32], body: (c) => {
  const tVT = cx.tVT, vt = c.newLocal(refNull(tVT));
  c.lget(0).refIsNull().if_().i32(0).ret().end();
  c.lget(0).call(cx.helper("vtab")).lset(vt);
  c.lget(vt).refAsNonNull().i32(H.DEPTH).arrayGet(tVT).lget(2).raw(OP.i32_lt_s).if_().i32(0).ret().end();
  c.lget(vt).refAsNonNull().lget(2).i32(H.DISPLAY).raw(OP.i32_add).arrayGet(tVT).lget(1).raw(OP.i32_eq);
} }));
// implements(obj, interface id): scan the interface ids after the slow-pair region (see World.vtWords)
def("implements", (cx) => ({ params: [L, T.i32], results: [T.i32], body: (c) => {
  const tVT = cx.tVT, vt = c.newLocal(refNull(tVT)), p = c.newLocal(T.i32), n = c.newLocal(T.i32), i = c.newLocal(T.i32);
  c.lget(0).refIsNull().if_().i32(0).ret().end();
  c.lget(0).call(cx.helper("vtab")).lset(vt);
  c.lget(vt).refAsNonNull().i32(H.EXTRA).arrayGet(tVT).lset(p);
  c.lget(p).lget(vt).refAsNonNull().lget(p).arrayGet(tVT).i32(2).raw(OP.i32_mul).raw(OP.i32_add).i32(2).raw(OP.i32_add).lset(p);
  c.lget(vt).refAsNonNull().lget(p).arrayGet(tVT).lset(n);
  c.lget(p).i32(1).raw(OP.i32_add).lset(p);
  c.block().loop();
  c.lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
  c.lget(vt).refAsNonNull().lget(p).lget(i).raw(OP.i32_add).arrayGet(tVT).lget(1).raw(OP.i32_eq).if_().i32(1).ret().end();
  c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end().i32(0);
} }));
// imtslow(vt, selector): the slot of the implementation; scans the learned pairs, else asks the host and learns the answer
def("imtslow", (cx) => ({ params: [refNull(cx.tVT), T.i32], results: [T.i32], body: (c) => {
  const tVT = cx.tVT, p = c.newLocal(T.i32), n = c.newLocal(T.i32), i = c.newLocal(T.i32), slot = c.newLocal(T.i32);
  c.lget(0).refAsNonNull().i32(H.EXTRA).arrayGet(tVT).lset(p);
  c.lget(0).refAsNonNull().lget(p).i32(1).raw(OP.i32_add).arrayGet(tVT).lset(n);
  c.block().loop();
  c.lget(i).lget(n).raw(OP.i32_ge_s).brIf(1);
  const at = (off: number) => c.lget(0).refAsNonNull().lget(p).lget(i).i32(2).raw(OP.i32_mul).raw(OP.i32_add).i32(off).raw(OP.i32_add);
  at(2).arrayGet(tVT).lget(1).raw(OP.i32_eq).if_().lget(0).refAsNonNull().lget(p).lget(i).i32(2).raw(OP.i32_mul).raw(OP.i32_add).i32(3).raw(OP.i32_add).arrayGet(tVT).ret().end();
  c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
  c.lget(0).refAsNonNull().i32(H.ID).arrayGet(tVT).lget(1).call(cx.imp.imtMiss).lset(slot);
  // learn it while there is room (cap = vt[p], n = vt[p + 1])
  c.lget(n).lget(0).refAsNonNull().lget(p).arrayGet(tVT).raw(OP.i32_lt_s).if_();
  const put = (off: number, v: () => void) => { c.lget(0).refAsNonNull().lget(p).lget(n).i32(2).raw(OP.i32_mul).raw(OP.i32_add).i32(off).raw(OP.i32_add); v(); c.arraySet(tVT); };
  put(2, () => c.lget(1)); put(3, () => c.lget(slot));
  c.lget(0).refAsNonNull().lget(p).i32(1).raw(OP.i32_add).lget(n).i32(1).raw(OP.i32_add).arraySet(tVT).end();
  c.lget(slot);
} }));
// aput:<element kind>(array, index, value): the store of an array element out of line, for code that runs once (method.ts emitAput)
for (const k of ["i8", "i16", "i32", "i64", "ref"] as ElemKind[]) def("aput:" + k, (cx) => ({ params: [L, T.i32, k === "ref" ? L : k === "i64" ? T.i64 : T.i32], results: [], body: (c) => {
  const data = c.newLocal(ref(cx.tData[k])), index = () => c.lget(1);
  c.lget(0); cx.arrayData(c, k).lset(data);
  cx.boundsCheck(c, index, () => c.lget(data).arrayLen());
  cx.emitElementStore(c, k, 0, () => c.lget(data), index, () => c.lget(2));
} }));
// the header word: the monitor (thin lock owner and count, or an inflated monitor's index) in its low half, the identity hash in its high half
def("hash", (cx) => ({ params: [L], results: [T.i32], body: (c) => {
  const tObj = cx.tObj, w = c.newLocal(T.i64), hv = c.newLocal(T.i32), g = cx.global("rt", "hash", T.i32, true);
  c.lget(0).refTest(tObj).raw(OP.i32_eqz).if_().lget(0).call(cx.helper("shash")).ret().end();
  c.lget(0).refCast(tObj).structGet(tObj, 1).ltee(w).i64(32n).raw(OP.i64_shr_u, OP.i32_wrap_i64).ltee(hv).raw(OP.i32_eqz).if_()
    .gget(g).i32(0x3c6ef372 | 0).raw(OP.i32_add).ltee(hv).gset(g)
    .lget(0).refCast(tObj).lget(w).lget(hv).raw(OP.i64_extend_i32_u).i64(32n).raw(OP.i64_shl, OP.i64_or).structSet(tObj, 1).end();
  c.lget(hv);
} }));
// menter(obj), mexit(obj): the thin lock in the header word's low half (monitor.ts): the owning strand's id << 8 | count. `lock ^ id << 8` is the count when the
// strand holds the lock, so one unsigned compare tells that from free, another strand's and inflated (negative); anything but those cases is the host's
for (const enter of [true, false]) def(enter ? "menter" : "mexit", (cx) => ({ params: [L], results: [], body: (c) => {
  const tObj = cx.tObj, o = c.newLocal(ref(tObj)), w = c.newLocal(T.i64), l = c.newLocal(T.i32), s8 = c.newLocal(T.i32);
  c.gget(cx.global("rt", "sid", T.i32, true)).i32(8).raw(OP.i32_shl).lset(s8);
  c.lget(0).refCast(tObj).ltee(o).structGet(tObj, 1).ltee(w).raw(OP.i32_wrap_i64).lset(l);
  const store = (v: () => void) => { c.lget(o).lget(w); v(); c.raw(enter ? OP.i64_add : OP.i64_sub).structSet(tObj, 1); };
  if (enter) {
    c.lget(l).raw(OP.i32_eqz).if_();
    store(() => c.lget(s8).i32(1).raw(OP.i32_or, OP.i64_extend_i32_u));
    c.ret().end();
    c.lget(l).lget(s8).raw(OP.i32_xor).i32(255).raw(OP.i32_lt_u).if_();
    store(() => c.i64(1n));
    c.ret().end();
  } else {
    c.lget(l).lget(s8).raw(OP.i32_xor).lset(s8);
    c.lget(s8).i32(256).raw(OP.i32_lt_u).if_();
    store(() => c.lget(l).raw(OP.i64_extend_i32_u).i64(1n).lget(s8).i32(1).raw(OP.i32_eq).select());
    c.ret().end();
  }
  c.lget(0); cx.callRt(c, enter ? "menterSlow" : "mexitSlow");
} }));
// newLen(len, shift): the length itself once it is a legal array length and the allocation fits the budget
def("newLen", (cx) => ({ params: [T.i32, T.i32], results: [T.i32], body: (c) => {
  const bytes = c.newLocal(T.i64);
  c.lget(0).i32(0).raw(OP.i32_lt_s).if_().lget(0); cx.callThrower(c, "nase"); c.end();
  c.lget(0).raw(OP.i64_extend_i32_u).lget(1).raw(OP.i64_extend_i32_u, OP.i64_shl).lset(bytes);
  c.lget(bytes).i64(BigInt(HEAP_LIMIT)).raw(OP.i64_gt_u).if_().lget(bytes); cx.callThrower(c, "oom"); c.end();
  cx.allocBytes(c, () => c.lget(bytes).raw(OP.i32_wrap_i64));
  c.lget(0);
} }));
// allocSlow(): the allocation window is used up; the host decides whether the heap really is full. Garbage that only a finalizer frees (a native handle
// its owner holds) counts until the event loop has run the finalizers, so a full heap gets two turns of the loop, each with a collection, before it is an error
def("allocSlow", (cx) => ({ params: [], results: [], body: (c) => {
  const g = cx.global("rt", "alloc", T.i32, true);
  c.i32(-ALLOC_WINDOW).gset(g);
  for (let turn = 0; turn < 2; turn++) {
    c.call(cx.imp.heapCheck).if_();
    emitSync(cx, c, Sync.CanSuspend); c.if_();
    emitBlock(cx, c, Block.Yield, null, null, () => c.i32(1)); c.drop().end();
  }
  c.call(cx.imp.heapCheck).if_().i64(BigInt(ALLOC_WINDOW)); cx.callThrower(c, "oom"); c.end();
  c.end().end();
} }));
// vtab(obj): its vtable; acmp(a, b): identity, every non-null reference being an Object; shash(s): a String's hash
def("vtab", (cx) => ({ params: [L], results: [ref(cx.tVT)], body: (c) => { c.lget(0).refCast(cx.tObj).structGet(cx.tObj, 0); } }));
def("acmp", () => ({ params: [L, L], results: [T.i32], body: (c) => { c.lget(0).refCast(HT.eq, true).lget(1).refCast(HT.eq, true).refEq(); } }));
def("shash", (cx) => ({ params: [L], results: [T.i32], body: (c) => { c.lget(0).call(cx.str.hash()); } }));
