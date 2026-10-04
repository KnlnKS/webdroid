// The Java thread of the process, while it has one. ART makes the main Thread when the runtime starts: allocated and recorded as the
// running thread before its constructor runs, which calls Thread.currentThread(). `thr` (the runtime module's global) is the running
// thread, the one place a scheduler changes when there are several.
import type { Code } from "../compiler/code";
import type { Compiler, Intrinsic } from "../compiler/j2w";
import { rt } from "../compiler/rtfns";
import { OP } from "../compiler/code";
import { T } from "../compiler/wasmbin";

const THREAD = "java/lang/Thread", GROUP = "java/lang/ThreadGroup", NORM_PRIORITY = 5;
const currentThread = (cx: Compiler) => cx.global("rt", "thr", T.anyref, true);
/** the interrupt flag of the running thread (the other Thread objects can only be unstarted) */
const isCurrent = (cx: Compiler, c: Code) => c.lget(0).gget(currentThread(cx)).call(cx.helper("acmp"));
const interruptFlag = (cx: Compiler) => cx.global("rt", "intr", T.i32, true);

// curThread(): the running thread, made on first use as ART's Thread::CreatePeer does for the main thread
rt("curThread", [], "L", (cx, c) => {
  const g = currentThread(cx), ctor = cx.prog.resolve(THREAD, "<init>", `(L${GROUP};Ljava/lang/String;IZ)V`);
  if (!ctor) { cx.gap(c, "Thread.<init>(ThreadGroup, String, int, boolean)"); return; }
  c.gget(g).refIsNull().if_();
  cx.emitEnsure(c, THREAD); cx.emitNew(c, THREAD); c.gset(g);
  c.gget(g); cx.emitEnsure(c, GROUP); c.gget(cx.staticGlobal(GROUP, "mainThreadGroup")); cx.str.literal(c, "main"); c.i32(NORM_PRIORITY).i32(0);
  cx.callMethod(c, ctor);
  // ART records the native thread in the peer, which is what Thread.isAlive reads
  const st = cx.structFor(THREAD), peer = cx.fieldIndex(THREAD, { owner: THREAD, name: "nativePeer", desc: "J" });
  c.gget(g).refCast(st).i64(1n).structSet(st, peer);
  c.end().gget(g);
});

export const threadIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => threadIntrinsics.set(key, (cx, m, c) => f(cx, c));
def("java/lang/Thread.currentThread()Ljava/lang/Thread;", (cx, c) => { cx.callRt(c, "curThread"); });
// Thread.nativeGetStatus(hasBeenStarted): the ordinal of the Thread.State of the running thread (RUNNABLE), else NEW or TERMINATED as for a thread with no native peer
def("java/lang/Thread.nativeGetStatus(Z)I", (cx, c) => {
  isCurrent(cx, c).if_(T.i32).i32(1).else_().lget(1).if_(T.i32).i32(5).else_().i32(0).end().end();
});
def("java/lang/Thread.isInterrupted()Z", (cx, c) => { isCurrent(cx, c).gget(interruptFlag(cx)).raw(OP.i32_and); });
def("java/lang/Thread.interrupted()Z", (cx, c) => { c.gget(interruptFlag(cx)).i32(0).gset(interruptFlag(cx)); });
def("java/lang/Thread.interrupt0()V", (cx, c) => { isCurrent(cx, c).if_().i32(1).gset(interruptFlag(cx)).end(); });
for (const key of ["yield()V", "setPriority0(I)V", "setNativeName(Ljava/lang/String;)V"]) def(`java/lang/Thread.${key}`, () => {});
// a monitor here is a null check (one Java thread), so nothing waits on it and a notification wakes nobody
for (const n of ["notify", "notifyAll"]) def(`java/lang/Object.${n}()V`, () => {});
