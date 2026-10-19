// java.lang.ref.Reference's natives, which ART implements with its collector. A weak or soft reference may stay uncleared for as long as
// its referent is reachable from anywhere, and this heap is the engine's: a reference holds its referent until the program clears it, and
// nothing is ever enqueued by the collector.
import type { Code } from "../compiler/code.ts";
import { T } from "../compiler/wasmbin.ts";
import type { Compiler, Intrinsic } from "../compiler/j2w.ts";

const REFERENCE = "java/lang/ref/Reference", FINALIZER = "java/lang/ref/FinalizerReference";
const field = (cx: Compiler, name: string, desc: string) => ({ st: cx.structFor(REFERENCE), at: cx.fieldIndex(REFERENCE, { owner: REFERENCE, name, desc }) });

export const refIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => refIntrinsics.set(key, (cx, m, c) => f(cx, c));
const referent = (cx: Compiler, c: Code) => { const { st, at } = field(cx, "referent", "Ljava/lang/Object;"); c.lget(0).refCast(st).structGet(st, at); };
for (const cls of [REFERENCE, FINALIZER]) def(`${cls}.getReferent()Ljava/lang/Object;`, referent);
def(`${REFERENCE}.refersTo0(Ljava/lang/Object;)Z`, (cx, c) => { referent(cx, c); c.lget(1).call(cx.helper("acmp")); });
def(`${REFERENCE}.clearReferent()V`, (cx, c) => { const { st, at } = field(cx, "referent", "Ljava/lang/Object;"); c.lget(0).refCast(st).anyNull().structSet(st, at); });
// FinalizerReference.makeCircularListIfUnenqueued: a reference not yet in a queue's list joins it as a one-element circle
def(`${FINALIZER}.makeCircularListIfUnenqueued()Z`, (cx, c) => {
  const { st, at } = field(cx, "queueNext", "Ljava/lang/ref/Reference;");
  c.lget(0).refCast(st).structGet(st, at).refIsNull().if_(T.i32).lget(0).refCast(st).lget(0).structSet(st, at).i32(1).else_().i32(0).end();
});

// Cleaner.create(referent, thunk): the Cleaner is made without its referent, which a PhantomReference never gives back, so that the host can
// see the referent die and run the Cleaner (World.cleaners); the object keeps it alive for no other reason
refIntrinsics.set("sun/misc/Cleaner.create(Ljava/lang/Object;Ljava/lang/Runnable;)Lsun/misc/Cleaner;", (cx, m, c) => {
  const CLEANER = "sun/misc/Cleaner", ctor = cx.prog.resolve(CLEANER, "<init>", "(Ljava/lang/Object;Ljava/lang/Runnable;)V"), add = cx.prog.resolve(CLEANER, "add", "(Lsun/misc/Cleaner;)Lsun/misc/Cleaner;");
  if (!ctor || !add) { cx.gap(c, "sun.misc.Cleaner"); return; }
  const cleaner = c.newLocal(T.anyref);
  c.lget(1).refIsNull().if_(T.anyref).anyNull().else_();
  cx.construct(c, ctor, () => c.anyNull().lget(1)); c.lset(cleaner);
  c.lget(0).externConvertAny().lget(cleaner).externConvertAny().call(cx.imp.watch);
  c.lget(cleaner); cx.callMethod(c, add);
  c.end();
});
