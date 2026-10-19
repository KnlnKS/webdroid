// The calls compiled code makes into the scheduler (link/sched.ts): host.sync answers at once, host.block may suspend the strand, and the
// strand's identity (the globals `sid`, `thr` and `depth`) is kept in locals across a call other strands ran in.
import type { Code } from "./code.ts";
import type { Compiler } from "./j2w.ts";
import { OP } from "./code.ts";
import { HT, T, type VT } from "./wasmbin.ts";

/** what a blocking or synchronizing operation answers; the compiled code turns it into the exception (sched.ts blockStatus) */
export const St = { Ok: 0, Interrupted: 1, Imse: 2, Nbs: 3, Neg: 4, Nanos: 5, Proceed: 6, Block: 7 } as const;
export type St = (typeof St)[keyof typeof St];
/** loop iterations of one activation between two chances for another strand to run (a power of two) */
export const FUEL = 4096;
/** the strand id of host code that enters Java outside any strand */
export const ROOT = 1;

/** operations that answer at once (`host.sync`) */
export const Sync = { Try: 1, Exit: 2, Notify: 3, NotifyAll: 4, Unpark: 5, Interrupt: 6, Interrupted: 7, IsInterrupted: 8, Holds: 9, Create: 10, Status: 11, InitDone: 12, Bind: 13, Plain: 14, Resume: 15, IsMain: 16, ContextDeferred: 17, ContextSet: 18, SystemLoaderReady: 19, CanSuspend: 20, Rename: 21, Ended: 22 } as const;
export type Sync = (typeof Sync)[keyof typeof Sync];
/** operations that may wait (`host.block`, Suspending) */
export const Block = { Enter: 1, Wait: 2, Sleep: 3, Park: 4, Yield: 5, Init: 6, Net: 7 } as const;
export type Block = (typeof Block)[keyof typeof Block];

export const sidOf = (cx: Compiler) => cx.global("rt", "sid", T.i32, true);
export const thrOf = (cx: Compiler) => cx.global("rt", "thr", T.anyref, true);
/** pushes the object (or null) and the number (or 0) of a host call */
const operands = (c: Code, obj: (() => void) | null, a: (() => void) | null) => { if (obj) { obj(); c.externConvertAny(); } else c.refNull(HT.extern); if (a) a(); else c.f64const(0n); };
/** host.sync(op, obj, a): the status */
export function emitSync(cx: Compiler, c: Code, op: Sync, obj: (() => void) | null = null, a: (() => void) | null = null): void {
  c.i32(op); operands(c, obj, a); c.call(cx.imp.sync);
}
/** host.block(op, obj, a, b): the status. The strand's identity is kept in locals across the call, since other strands run while it waits. Host code at the
 *  top level has no stack of its own to suspend (the engine would refuse): there the status says so, without the call */
export function emitBlock(cx: Compiler, c: Code, op: Block, obj: (() => void) | null = null, a: (() => void) | null = null, b: (() => void) | null = null): void {
  c.gget(sidOf(cx)).i32(ROOT).raw(OP.i32_eq).if_(T.i32);
  emitSync(cx, c, Sync.Plain); c.drop().i32(St.Nbs);
  c.else_();
  const restore = emitSave(cx, c);
  emitRestored(cx, c, [], [T.i32], () => {
    c.i32(op); operands(c, obj, a); if (b) b(); else c.i32(0); c.call(cx.imp.block);
  }, restore);
  c.end();
}
/** keeps who the strand is (its id, its Thread and how deep its stack is) in locals; the function sets the globals again, after a call that other strands ran in */
export function emitSave(cx: Compiler, c: Code): () => void {
  const sid = sidOf(cx), thr = thrOf(cx), depth = cx.global("rt", "depth", T.i32, true), s = c.newLocal(T.i32), t = c.newLocal(T.anyref), d = c.newLocal(T.i32);
  c.gget(sid).lset(s).gget(thr).lset(t).gget(depth).lset(d);
  return () => { c.lget(s).gset(sid).lget(t).gset(thr).lget(d).gset(depth); emitSync(cx, c, Sync.Resume); c.drop(); };
}
/** after a host import that answers an externref, or parks the strand (Sched.parkNative) and answers nothing: the answer, settled if it parked, as an anyref */
export function emitSettled(cx: Compiler, c: Code): void {
  const wait = cx.global("rt", "wait", T.i32, true);
  c.gget(wait).ifType(cx.mb.addFuncType([T.externref], [T.externref]));
  c.drop().i32(0).gset(wait).call(cx.imp.annotationWait);
  c.end().anyConvertExtern();
}
/** JS Promise reactions can idle another strand before the engine resumes this catch. */
export function emitRestored(cx: Compiler, c: Code, params: VT[], results: VT[], call: () => void, restore = emitSave(cx, c)): void {
  const run = cx.mb.addFuncType(params, results), thrown = cx.mb.addFuncType(params, [T.exnref]);
  c.blockType(run).blockType(thrown).tryTableType(run, [[3, 0, 0]]);
  call();
  c.end().br(1).end();
  restore(); c.throwRef(); c.end();
  restore();
}
