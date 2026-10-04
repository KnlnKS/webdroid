// java.lang.ref.Reference's natives, which ART implements with its collector. A weak or soft reference may stay uncleared for as long as
// its referent is reachable from anywhere, and this heap is the engine's: a reference holds its referent until the program clears it, and
// nothing is ever enqueued by the collector.
import type { Code } from "./code";
import type { Compiler, Intrinsic } from "./j2w";

const REFERENCE = "java/lang/ref/Reference", FINALIZER = "java/lang/ref/FinalizerReference";
const field = (cx: Compiler, name: string, desc: string) => {
  const owner = REFERENCE, f = { owner, name, desc }, st = cx.structFor(owner);
  return { st, at: cx.fieldIndex(owner, f) };
};

export const refIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => refIntrinsics.set(key, (cx, m, c) => f(cx, c));
const referent = (cx: Compiler, c: Code) => { const { st, at } = field(cx, "referent", "Ljava/lang/Object;"); c.lget(0).refCast(st).structGet(st, at); };
for (const cls of [REFERENCE, FINALIZER]) def(`${cls}.getReferent()Ljava/lang/Object;`, referent);
def(`${REFERENCE}.refersTo0(Ljava/lang/Object;)Z`, (cx, c) => { referent(cx, c); c.lget(1).call(cx.helper("acmp")); });
def(`${REFERENCE}.clearReferent()V`, (cx, c) => { const { st, at } = field(cx, "referent", "Ljava/lang/Object;"); c.lget(0).refCast(st).anyNull().structSet(st, at); });
// FinalizerReference.makeCircularListIfUnenqueued: a reference not yet in a queue's list joins it as a one-element circle
def(`${FINALIZER}.makeCircularListIfUnenqueued()Z`, (cx, c) => {
  const { st, at } = field(cx, "queueNext", "Ljava/lang/ref/Reference;");
  c.lget(0).refCast(st).structGet(st, at).refIsNull().if_().lget(0).refCast(st).lget(0).structSet(st, at).i32(1).else_().i32(0).end();
});
