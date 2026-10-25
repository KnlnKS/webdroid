// The runtime module every module imports "rt" from: the exception tag, the globals of allocation, hashing, the Class table and the running strand, and the
// linker a lazy-link stub calls, which compiles the slot's code on its first call (Tiering.linkSlot). Its table entries are the throwers' stubs.
import { HT, ModuleBuilder, T, refNull, sleb, uleb } from "../compiler/wasmbin.ts";
import { Code } from "../compiler/code.ts";
import { H, ALLOC_WINDOW } from "../compiler/consts.ts";
import { declareBase, kindVT } from "../compiler/j2w.ts";
import { SLOT, THROWERS, type Thrower } from "../compiler/exc.ts";
import { Sync, ROOT } from "../compiler/hostcalls.ts";
import { suspending } from "./module.ts";
import type { World } from "./world.ts";

type Global = WebAssembly.Global;
export type Runtime = {
  tag: WebAssembly.Tag;
  alloc: Global; hash: Global; ctab: Global; unsafeSlots: Global; sid: Global; thr: Global; depth: Global; iw: Global; wait: Global; callee: Global;
  classId: (o: object) => number; link: (slot: number) => void; nop: Function;
};

function addLinker(mb: ModuleBuilder, state: [number, number, number]): number {
  const sig = mb.addFuncType([T.i32], []), link = mb.importFunc("linker", "link", sig);
  const due = mb.importFunc("linker", "due", mb.addFuncType([T.i32], [T.i32]));
  const wait = mb.importFunc("linker", "wait", sig), sync = mb.importFunc("linker", "sync", mb.addFuncType([T.i32, T.externref, T.f64], [T.i32]));
  const c = new Code(1);
  const saved = [c.newLocal(T.i32), c.newLocal(T.anyref), c.newLocal(T.i32)];
  const restore = () => {
    state.forEach((global, i) => c.lget(saved[i]).gset(global));
    c.i32(Sync.Resume).refNull(HT.extern).f64const(0n).call(sync).drop();
  };
  c.lget(0).call(due).if_();
  state.forEach((global, i) => c.gget(global).lset(saved[i]));
  // Promise reactions may idle another strand after admission restores it, before Wasm resumes.
  c.block().block(T.exnref).tryTable(null, [[3, 0, 0]]).lget(0).call(wait).end().br(1).end();
  restore(); c.throwRef(); c.end();
  restore();
  c.else_().lget(0).call(link).end();
  return mb.addFunc(sig, c.finish(), "$link");
}
export function startRuntime(w: World): Runtime {
  const mb = new ModuleBuilder(), b = declareBase(mb);
  mb.importTable("rt", "table", T.funcref, 0);
  mb.export("tag", "tag", mb.addTag(b.tTagFn));
  const i32Init = (v: number) => { const o = [0x41]; sleb(v, o); return o; };
  mb.export("callee", "global", mb.addGlobal(T.i32, true, i32Init(0)));
  const uleb2 = (v: number) => { const o: number[] = []; uleb(v, o); return o; };
  mb.export("alloc", "global", mb.addGlobal(T.i32, true, i32Init(-ALLOC_WINDOW)));
  mb.export("hash", "global", mb.addGlobal(T.i32, true, i32Init(0)));
  // the Class objects by class id (grown by classOf) and the id of the running Java thread, which init words record
  mb.export("ctab", "global", mb.addGlobal(refNull(b.tData.ref), true, [...i32Init(256), 0xfb, 7, ...uleb2(b.tData.ref)]));
  mb.export("unsafeSlots", "global", mb.addGlobal(refNull(b.tVT), true, new Code(0).refNull(b.tVT).b));
  const sid = mb.addGlobal(T.i32, true, i32Init(ROOT)), thr = mb.addGlobal(T.anyref, true, [0xd0, 0x6e]), depth = mb.addGlobal(T.i32, true, i32Init(0));
  mb.export("sid", "global", sid); mb.export("thr", "global", thr); mb.export("depth", "global", depth);
  const link = addLinker(mb, [sid, thr, depth]);
  mb.export("link", "func", link);
  mb.export("iw", "global", mb.addGlobal(T.i32, true, i32Init(0)));
  mb.export("wait", "global", mb.addGlobal(T.i32, true, i32Init(0)));
  const cid = mb.addFunc(mb.addFuncType([refNull(b.tObj)], [T.i32]), new Code(1).lget(0).refAsNonNull().structGet(b.tObj, 0).i32(H.ID).arrayGet(b.tVT).finish(), "classId");
  mb.export("classId", "func", cid);
  mb.export("nop", "func", mb.addFunc(mb.addFuncType([], []), new Code(0).finish(), "nop"));
  for (const name of Object.keys(SLOT) as Thrower[]) {
    const params = THROWERS[name].params.map((k) => kindVT(k)), sig = mb.addFuncType(params, []);
    const c = new Code(params.length).i32(SLOT[name]).call(link);
    params.forEach((_, i) => c.lget(i));
    const f = mb.addFunc(sig, c.i32(SLOT[name]).callIndirect(sig).finish(), "stub:" + name);
    mb.addElemActive(0, SLOT[name], [f]);
    w.slots.set(SLOT[name], { k: "thrower", name });
  }
  const linker = {
    link: (slot: number) => w.tiers.linkSlot(slot),
    due: (slot: number) => +(w.sched.canWait() && (w.sched.turnDue() || !!w.aot?.needsPreparation(slot))),
    wait: suspending((slot: number) => w.sched.admitLink(() => w.tiers.linkSlot(slot), () => w.aot?.prepare(slot))),
    sync: (op: number, obj: object | null, a: number) => w.sched.sync(op, obj, a),
  };
  const x = w.instantiate(mb.build(), { rt: { table: w.table }, linker }).exports as Record<string, any>;
  return { tag: x.tag, alloc: x.alloc, hash: x.hash, ctab: x.ctab, unsafeSlots: x.unsafeSlots, sid: x.sid, thr: x.thr, depth: x.depth, iw: x.iw, wait: x.wait,
    callee: x.callee, classId: x.classId, link: x.link, nop: x.nop };
}
