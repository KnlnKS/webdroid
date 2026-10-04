// Class initialization (JLS 12.4.2) as one state word per class that has init work:
//   0 uninitialized | (tid << 2) | 1 being initialized by thread tid | 2 initialized | 3 erroneous
// A use site tests `state != 2` and calls the class's ensure function. A request from the initializing thread returns at once
// (re-entry and cycles see the half-initialized class); a request from another thread waits in `initWait`, the hook the
// scheduler fills in once there is more than one Java thread. A <clinit> that throws marks the class erroneous: an Error
// propagates as it is, anything else is wrapped in ExceptionInInitializerError, and later uses throw NoClassDefFoundError.
import { Code, OP } from "./code";
import { T } from "./wasmbin";
import { mid } from "./reach";
import type { Compiler } from "./j2w";

export const INIT_DONE = 2, INIT_FAILED = 3;

export class InitModel {
  private state = new Map<string, number>();     // class -> global holding its state word
  private ensureFn = new Map<string, number>();
  private gTid = -1;
  constructor(private cx: Compiler) {}

  private needs(n: string): boolean {
    const c = this.cx.prog.get(n); if (!c) return false;
    return c.byKey.has("<clinit>()V") || !!c.def?.staticValuesOff || (c.sup ? this.needs(c.sup) : false) || (!c.isInterface && this.cx.prog.defaultIfaces(n).some((i) => this.needs(i)));
  }
  declare(n: string): void {
    if (!this.needs(n)) return;
    const { mb } = this.cx;
    if (this.gTid < 0) {
      this.gTid = mb.addGlobal(T.i32, true, [0x41, 1]); mb.export("tid", "global", this.gTid);
      const w = this.cx.helpers.initWait = mb.reserveFunc(this.cx.sig(["I"], "V"), "$initWait"), c = new Code(1);
      this.cx.gap(c, "class initialization owned by another thread: needs the thread scheduler"); mb.setBody(w, c.finish());
    }
    this.state.set(n, mb.addGlobal(T.i32, true, [0x41, 0]));
    this.ensureFn.set(n, mb.reserveFunc(this.cx.sig([], "V"), `ensure:${n}`));
  }

  /** at a use site: run the class's initialization unless it is complete */
  ensure(c: Code, cls: string): void {
    const g = this.state.get(cls); if (g === undefined) return;
    c.gget(g).i32(INIT_DONE).raw(OP.i32_ne).if_().call(this.ensureFn.get(cls)!).end();
  }

  emit(n: string): void {
    const f = this.ensureFn.get(n); if (f === undefined) return;
    const { cx } = this, { prog, helpers: h } = cx, jc = prog.get(n)!, g = this.state.get(n)!, c = new Code(0);
    const e = c.newLocal(cx.vtOf("L"));
    c.block().block().loop();                                   // exit, claim, retry
    c.gget(g).i32(INIT_DONE).raw(OP.i32_eq).brIf(2);
    c.gget(g).i32(INIT_FAILED).raw(OP.i32_eq).if_().call(h.ncdfe).end();
    c.gget(g).raw(OP.i32_eqz).brIf(1);
    c.gget(g).i32(2).raw(OP.i32_shr_u).gget(this.gTid).raw(OP.i32_eq).brIf(2);
    c.i32(cx.classId.get(n) ?? 0).call(h.initWait).br(0);
    c.end().end();
    c.gget(this.gTid).i32(2).raw(OP.i32_shl).i32(1).raw(OP.i32_or).gset(g);
    c.block(cx.vtOf("L")).tryTable(null, [[0, cx.tag, 0]]);
    if (jc.sup && this.ensureFn.has(jc.sup)) c.call(this.ensureFn.get(jc.sup)!);
    for (const i of prog.defaultIfaces(n)) if (this.ensureFn.has(i)) c.call(this.ensureFn.get(i)!);
    cx.emitStatics(c, n);
    const ci = jc.byKey.get("<clinit>()V");
    if (ci && cx.fn.has(mid(ci))) c.call(cx.fn.get(mid(ci))!);
    c.i32(INIT_DONE).gset(g).br(2);
    c.end().unreachable().end();                                // the thrown Throwable is on the stack
    c.lset(e).i32(INIT_FAILED).gset(g);
    const err = cx.classId.get("java/lang/Error");
    if (err !== undefined) c.lget(e).i32(err).i32(cx.prog.chain("java/lang/Error").length - 1).call(h.iof).if_().lget(e).throw_(cx.tag).end();
    // ExceptionInInitializerError(Throwable) only stores the cause (the stack trace is not captured here)
    const eiie = "java/lang/ExceptionInInitializerError", w = c.newLocal(cx.vtOf("L")), st = cx.structFor(eiie);
    cx.emitNew(c, eiie); c.lset(w);
    if (prog.get(eiie)?.dex) c.lget(w).refCast(st).lget(e).structSet(st, cx.fieldIndex(eiie, { owner: "java/lang/Throwable", name: "cause", desc: "Ljava/lang/Throwable;" }));
    c.lget(w).throw_(cx.tag).end();
    cx.mb.setBody(f, c.finish());
  }
}
