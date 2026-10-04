// The entry seam for harnesses whose host code can wait: wasmEntry's calls into Java from host code outside any native, each run on a strand of its own
// and answering a Promise, which jentry's contract allows (a call "answers a Promise when the callee suspends"). A plain call cannot wait for a read, a
// decode or a class initialization that does. Inside a native the calls stay plain, since natives expect an answer at once. Track C's entries on strands
// will replace this.
import { fieldNames } from "../../src/jvm/runtime";
import { useEntry, type Entry } from "../../src/jvm/natives/jentry";
import { fromBits, toBits } from "../../src/wasm/host/bridge";
import { fieldNamesOf, wasmEntry } from "../../src/wasm/host/entry";
import type { World } from "../../src/wasm/link/world";
import { kindOf, type MethodInfo } from "../../src/wasm/compiler/program";

export function strandEntry(w: World): Entry {
  const base = wasmEntry(w), bridge = w.bridge as unknown as {
    begin(): number; end(mark: number): void; toJava(v: unknown, desc: string): unknown; toHost(v: unknown, desc?: string): unknown;
    owners: WeakMap<object, object>; readBack(j: object, host: ArrayBufferView): void; saved: number[];
    invoke(m: MethodInfo, recv: object | null, args: unknown[]): unknown;
  };
  /** `f` on a strand, a Java exception leaving it as the facade of the throwable, as wasmEntry throws it */
  const onStrand = async <T>(f: Function, ...args: unknown[]): Promise<T> => {
    const s = w.sched.strand();
    try { return await s.call(f, ...args) as T; } catch (e) {
      const java = w.throwable(w.boundary(e));
      throw java ? bridge.toHost(java) : e;
    } finally { s.end(); }
  };
  const hostLevel = () => bridge.saved.length === 0;
  const plainInvoke = bridge.invoke.bind(bridge);
  const asyncInvoke = async (m: MethodInfo, recv: object | null, args: unknown[]) => {
    const kinds = [...(m.isStatic ? [] : ["L" as const]), ...m.params.map(kindOf)], rk = m.ret === "V" ? "V" : kindOf(m.ret);
    const call = w.hostFn(`b:call:${m.cls}.${m.key}`, kinds, rk, (cx, c) => {
      if (m.isStatic) cx.emitEnsure(c, m.cls);
      kinds.forEach((_, i) => c.lget(i));
      cx.callMethod(c, m);
    });
    // the scope of the conversions is closed while the strand runs: the natives it calls open their own
    const scoped = <T>(f: () => T): T => { const mark = bridge.begin(); try { return f(); } finally { bridge.end(mark); } };
    const given = scoped(() => args.map((a, i) => kindOf(m.params[i]) === "L" ? bridge.toJava(a, m.params[i]) : toBits(a, m.params[i])));
    const r = await onStrand(call, ...(m.isStatic ? [] : [recv]), ...given);
    return scoped(() => {
      args.forEach((a, i) => { if (ArrayBuffer.isView(a) && given[i] && !bridge.owners.has(a)) bridge.readBack(given[i] as object, a); });
      return rk === "V" ? undefined : rk === "L" ? bridge.toHost(r, m.ret) : fromBits(r as never, m.ret);
    });
  };
  bridge.invoke = (m, recv, args) => hostLevel() ? asyncInvoke(m, recv, args) : plainInvoke(m, recv, args);
  const init = (cls: string) => onStrand<void>(w.hostFn("e:init:" + cls, [], "V", (cx, c) => { cx.emitEnsure(c, cls); }));
  const construct = async (cls: string, ctor: MethodInfo, args: unknown[]) => {
    const o = await onStrand<object>(w.hostFn("e:new:" + cls, [], "L", (cx, c) => { cx.emitEnsure(c, cls); cx.emitNew(c, cls); }));
    await bridge.invoke(ctor, o, args);
    return bridge.toHost(o);
  };
  const entry: Entry = {
    ...base,
    newObj(cls, desc = "()V", ...args) {
      const ctor = w.prog.get(cls)?.byKey.get("<init>" + desc);
      return ctor && hostLevel() ? construct(cls, ctor, args) : base.newObj(cls, desc, ...args);
    },
    // a class already initialized is read at once, which lets a harness hold its statics after one awaited linkInit
    staticField(cls, field) {
      const read = () => base.linkClass(cls).static(field) as never;
      return !hostLevel() || w.initialized(cls) || !w.needsInit(cls) ? (hostLevel() ? read() : base.staticField(cls, field)) : init(cls).then(read) as never;
    },
    linkInit(cls) { return hostLevel() ? init(cls).then(() => base.linkClass(cls)) : base.linkInit(cls); },
    initClass(cls) { return hostLevel() ? (base.linkClass(cls), init(cls)) : base.initClass(cls); },
  };
  useEntry(entry);
  fieldNames.find = fieldNamesOf(w);
  return entry;
}
