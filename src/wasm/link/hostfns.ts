// Functions over Java values that the host calls: generated once per name, rebuilt when a class-hierarchy decision their code relies on is undone.
import { T } from "../compiler/wasmbin.ts";
import { Code, OP } from "../compiler/code.ts";
import type { Kind } from "../compiler/program.ts";
import { Compiler, kindVT, type FnTrace } from "../compiler/j2w.ts";
import type { Strand } from "./sched.ts";
import type { Clock, World } from "./world.ts";

export class HostFunctions {
  private readonly w: World;
  constructor(w: World) { this.w = w; }
  private hostFns = new Map<string, Function>();
  // Private helper owners do not consume method-table numbering shared with compile workers.
  private helperSlots: (Function | undefined)[] = [];
  private helperInvalidations = new Map<number, () => void>();
  /** whether `slot` belongs to a helper: helpers own their class-hierarchy decisions apart from the table */
  isHelper(slot: number): boolean { return this.helperInvalidations.has(slot); }
  /** has the helper of `slot` rebuilt before its next call; whether `slot` is a helper's */
  invalidate(slot: number): boolean { const f = this.helperInvalidations.get(slot); f?.(); return !!f; }
  private helperGetter(slot: number, rebuild: (slot: number) => Function): () => Function {
    let dirty = false;
    this.helperInvalidations.set(slot, () => { dirty = true; });
    return () => {
      // an invalidation while it rebuilds holds for the next call
      if (dirty) { dirty = false; this.helperSlots[-slot - 1] = rebuild(slot); }
      return this.helperSlots[-slot - 1]!;
    };
  }
  private helperUnit(cx: Compiler, imports: Record<string, any>, built: { bytes: Uint8Array; traces: FnTrace[] }, clock: Clock, rebuild: (slot: number) => Function, slot?: number): { get: () => Function; raw?: Function } {
    const dependent = cx.assumptions.some(a => !a[4]) || cx.absent.some(a => !a[1]);
    if (slot !== undefined || !dependent) return this.w.units.instantiate(cx, imports, built, slot, clock, (e) => { const raw = e.m as Function; return { get: () => raw, raw }; });
    const at = -this.helperSlots.push(undefined);
    return this.w.units.instantiate(cx, imports, built, at, clock, (e) => { this.helperSlots[-at - 1] = e.m as Function; return { get: this.helperGetter(at, rebuild) }; });
  }
  private hostRebuilder(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code) => void, prepare?: (cx: Compiler) => void): (slot: number) => Function {
    return slot => this.buildHostFn(name, params, ret, body, prepare, slot).get();
  }
  private buildHostFn(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code) => void, prepare?: (cx: Compiler) => void, slot?: number) {
    const clock = this.w.units.clock(), cx = new Compiler(this.w); prepare?.(cx);
    const built = cx.buildSynthetic(name, params, c => body(cx, c), ret);
    this.w.stats.units++;
    return this.helperUnit(cx, this.w.units.of(cx), built, clock, this.hostRebuilder(name, params, ret, body, prepare), slot);
  }
  /** a helper callable from the host: its function, or one that follows its rebuilds */
  private synchronousHelper({ get, raw: fixed }: { get: () => Function; raw?: Function }): Function {
    if (fixed) return this.w.sched.synchronousExport(fixed);
    let raw: Function | undefined, call: Function;
    return (...args: unknown[]) => {
      const current = get();
      if (raw !== current) { raw = current; call = this.w.sched.synchronousExport(raw); }
      return call(...args);
    };
  }
  /** runs the Cleaner of a native allocation once its referent has been collected (sun.misc.Cleaner.create), as ART's reference queue daemon does: as a call
   *  that may block, since a thunk may wait (FileChannelImpl's Unmapper unmaps a file mapping). The Cleaner reports a failing thunk itself. */
  private clean?: (cleaner: object) => Promise<unknown>;
  cleaners = new FinalizationRegistry<object>((cleaner) => {
    (this.clean ??= this.w.entryAsync("sun/misc/Cleaner", "clean", "()V"))(cleaner).catch(() => {});
  });
  /** a function over Java values, generated once under `name` and callable from the host: an int is a number, a long a bigint, a reference an opaque value */
  hostFn(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code) => void, prepare?: (cx: Compiler) => void): (...a: any[]) => any {
    let f = this.hostFns.get(name);
    if (!f) {
      this.hostFns.set(name, f = this.synchronousHelper(this.buildHostFn(name, params, ret, body, prepare)));
    }
    return f as never;
  }
  /** calls the method in table slot `slot`, first running the class initializer in slot `ensure` unless it is -1: one helper per signature serves every method of it */
  invoker(params: Kind[], ret: Kind | "V", suspend: true): (s: Strand, slot: number, ensure: number, ...a: unknown[]) => unknown;
  invoker(params: Kind[], ret: Kind | "V", suspend?: false): (slot: number, ensure: number, ...a: unknown[]) => unknown;
  invoker(params: Kind[], ret: Kind | "V", suspend = false): (...a: any[]) => unknown {
    const name = `inv${suspend ? "s" : ""}:${params.join("")}>${ret}`, all: Kind[] = ["I", "I", ...params];
    const body = (cx: Compiler, c: Code, arg: (i: number) => void) => {
      arg(1); c.i32(0).raw(OP.i32_ge_s).if_(); arg(1); c.callIndirect(cx.sig([], "V")).end();
      params.forEach((_, i) => arg(i + 2)); arg(0); c.callIndirect(cx.sig(params, ret));
    };
    return suspend ? this.callFn(name, all, ret, body) : this.hostFn(name, all, ret, (cx, c) => body(cx, c, (i) => { c.lget(i); }));
  }
  private callFns = new Map<string, (s: Strand, ...a: any[]) => unknown>();
  // The compiled call must not retain the emitter closure and its Compiler.
  // Build it in a separate activation from the persistent token/caller state.
  private callRebuilder(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code, arg: (i: number) => void) => void, prepare: ((cx: Compiler) => void) | undefined, state: { d: WebAssembly.Global; v: WebAssembly.Global; thr: WebAssembly.Global }): (slot: number) => Function {
    return slot => this.buildCallFn(name, params, ret, body, prepare, state, slot).get();
  }
  private buildCallFn(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code, arg: (i: number) => void) => void, prepare?: (cx: Compiler) => void, state?: { d: WebAssembly.Global; v: WebAssembly.Global; thr: WebAssembly.Global }, slot?: number) {
    const clock = this.w.units.clock(), cx = new Compiler(this.w), vt = ret === "V" ? T.i32 : ret === "L" ? T.externref : kindVT(ret);
    prepare?.(cx);
    const d = state?.d ?? new WebAssembly.Global({ value: "i32", mutable: true }, 0), thr = state?.thr ?? new WebAssembly.Global({ value: "externref", mutable: true }, null);
    const v = state?.v ?? new WebAssembly.Global({ value: ret === "J" ? "i64" : ret === "L" ? "externref" : "i32", mutable: true }, ret === "J" ? 0n : ret === "L" ? null : 0);
    const built = cx.buildSynthetic(name, ["I", ...params], (c) => {
      const done = cx.global("call", "d", T.i32, true), value = cx.global("call", "v", vt, true), thrown = cx.global("call", "x", T.externref, true);
      const e = c.newLocal(T.anyref), res = ret === "V" ? -1 : c.newLocal(kindVT(ret));
      c.block(T.anyref).tryTable(null, [[0, cx.tag, 0]]);
      body(cx, c, (i) => { c.lget(i + 1); });
      if (res >= 0) { c.lset(res).lget(res); if (ret === "L") c.externConvertAny(); c.gset(value); }
      c.lget(0).gset(done);
      if (res >= 0) c.lget(res);
      c.ret().end().unreachable().end();
      c.lset(e).lget(e).externConvertAny().gset(thrown).i32(0).lget(0).raw(OP.i32_sub).gset(done).lget(e).throw_(cx.tag);
    }, ret);
    this.w.stats.units++;
    const { get, raw } = this.helperUnit(cx, { ...this.w.units.of(cx), call: { d, v, x: thr } }, built, clock, this.callRebuilder(name, params, ret, body, prepare, { d, v, thr }), slot);
    return { get, raw, d, v, thr };
  }
  /** a Java call that may wait, made of `body` over the parameters (`arg(i)` pushes parameter i; the body leaves a result of kind `ret`), run on strand `s`: the result at once when the
   *  call did not wait (a Java exception is thrown as a WebAssembly.Exception), else a Promise of it. The module records how the call ended in globals of its own, which the
   *  call's token says are this call's: a promising export answers a Promise even when it never waited. */
  callFn(name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code, arg: (i: number) => void) => void, prepare?: (cx: Compiler) => void): (s: Strand, ...a: any[]) => unknown {
    let f = this.callFns.get(name);
    if (f) return f;
    const { get, raw, d, v, thr } = this.buildCallFn(name, params, ret, body, prepare);
    const enter = raw ? (s: Strand, ...args: unknown[]) => s.call(raw, ...args)
      : (s: Strand, ...args: unknown[]) => s.call(get(), ...args);
    Object.defineProperty(enter, "name", { value: "webdroid:callFn" });
    let token = 0;
    this.callFns.set(name, f = (s, ...args) => {
      token = token % 0x3fffffff + 1;
      const caller = this.w.stacks.bridge(s), leave = caller.leave;
      const mine = token;
      let p: Promise<unknown>;
      this.w.tiers.refreshHotUnits();
      try { p = enter(s, mine, ...args); } catch (error) { leave(); throw error; }
      const state = d.value as number;
      if (state !== mine && state !== -mine) {
        caller.suspended();
        const complete = () => {
          if (d.value === mine && ret === "L") v.value = null;
          else if (d.value === -mine) thr.value = null;
          leave();
        };
        p.then(complete, complete); return p;
      }
      leave();
      p.catch(() => {});
      // the globals are not to keep the last result alive
      if (state < 0) { const t = thr.value as object; thr.value = null; throw this.w.exception(t); }
      const result = ret === "V" ? undefined : v.value;
      if (ret === "L") v.value = null;
      return result;
    });
    return f;
  }
  /** calls a Java function made of `body` (as callFn's) with `args`, waiting only where strand `parent` can: on a new strand of its own then, which answers a Promise if
   *  it waited, else plainly */
  mayWait(parent: Strand, name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: Code, arg: (i: number) => void) => void, args: unknown[], prepare?: (cx: Compiler) => void): unknown {
    if (!this.w.sched.canWait(parent)) return this.w.unwound(() => this.hostFn(name, params, ret, (cx, c) => body(cx, c, (i) => { c.lget(i); }), prepare)(...args));
    const s = this.w.sched.strand(parent.thread, parent);
    let result: unknown;
    try { result = this.callFn(name, params, ret, body, prepare)(s, ...args); } catch (e) { s.end(); throw e; }
    if (result instanceof Promise) return result.finally(() => s.end());
    s.end(); return result;
  }
  /** field readers are made again: field layouts follow a changed namespace */
  forgetFieldReaders(): void { this.fieldReaders.clear(); }
  private fieldReaders = new Map<string, (obj: object) => unknown>();
  /** a JS function reading instance field `name` of `cls` from a Java object that crossed to JS (a reference field gives an opaque object) */
  fieldReader<T = unknown>(cls: string, name: string, desc: string): (obj: object) => T {
    const key = cls + "." + name + ":" + desc;
    let read = this.fieldReaders.get(key);
    if (!read) {
      const f = this.w.prog.resolveField(cls, name, desc);
      if (!f) throw new Error(`field ${cls}.${name} not found`);
      this.fieldReaders.set(key, read = this.synchronousHelper(this.buildHostFn("get:" + key, ["L"], f.kind, (cx, c) => {
        const st = cx.structFor(cls);
        c.lget(0).refAsNonNull().refCast(st).structGet(st, cx.fieldIndex(cls, f));
      })) as (obj: object) => unknown);
    }
    return read as (obj: object) => T;
  }
  private throwMakers = new Map<string, (msg: string | null) => object>();
  /** a Java throwable of class `cls` with `msg`, built by a synthetic Wasm function: the way a native raises one */
  makeThrowable(cls: string, msg: string | null): object {
    let make = this.throwMakers.get(cls);
    if (!make) {
      const f = this.hostFn("mk:" + cls, ["L"], "L", (cx, c) => {
        const ctor = this.w.prog.resolve(cls, "<init>", "()V"), detail = this.w.prog.resolveField("java/lang/Throwable", "detailMessage", "Ljava/lang/String;")!, st = cx.structFor("java/lang/Throwable");
        const exn = c.newLocal(T.anyref);
        cx.emitEnsure(c, cls); cx.emitNew(c, cls); c.lset(exn);
        if (ctor?.codeOff) { c.lget(exn); cx.callMethod(c, ctor); }
        c.lget(exn).refCast(st).lget(0).structSet(st, cx.fieldIndex("java/lang/Throwable", detail)).lget(exn);
      });
      this.throwMakers.set(cls, make = (m) => f(m === null ? null : this.w.javaString(m)));
    }
    return make(msg);
  }
}
