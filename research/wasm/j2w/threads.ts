// The Java thread of the process, while it has one. ART makes the main Thread when the runtime starts: allocated and recorded as the
// running thread before its constructor runs, which calls Thread.currentThread(). `thr` (the runtime module's global) is the running
// thread, the one place a scheduler changes when there are several.
import type { Code } from "./code";
import type { Compiler, Intrinsic } from "./j2w";
import { rt } from "./rtfns";
import { T } from "./wasmbin";

const THREAD = "java/lang/Thread", GROUP = "java/lang/ThreadGroup", NORM_PRIORITY = 5;
export const currentThread = (cx: Compiler) => cx.global("rt", "thr", T.anyref, true);

// curThread(): the running thread, made on first use as ART's Thread::CreatePeer does for the main thread
rt("curThread", [], "L", (cx, c) => {
  const g = currentThread(cx), ctor = cx.prog.resolve(THREAD, "<init>", `(L${GROUP};Ljava/lang/String;IZ)V`);
  if (!ctor) { cx.gap(c, "Thread.<init>(ThreadGroup, String, int, boolean)"); return; }
  c.gget(g).refIsNull().if_();
  cx.emitEnsure(c, THREAD); cx.emitNew(c, THREAD); c.gset(g);
  c.gget(g); cx.emitEnsure(c, GROUP); c.gget(cx.staticGlobal(GROUP, "mainThreadGroup")); cx.str.literal(c, "main"); c.i32(NORM_PRIORITY).i32(0);
  cx.callMethod(c, ctor);
  c.end().gget(g);
});

export const threadIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => threadIntrinsics.set(key, (cx, m, c) => f(cx, c));
def("java/lang/Thread.currentThread()Ljava/lang/Thread;", (cx, c) => { cx.callRt(c, "curThread"); });
// a monitor here is a null check (one Java thread), so nothing waits on it and a notification wakes nobody
for (const n of ["notify", "notifyAll"]) def(`java/lang/Object.${n}()V`, () => {});
