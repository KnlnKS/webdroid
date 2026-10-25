// The host boundary for natives, generated from method descriptors. A native is registered once, in src/jvm/natives
// or src/android; the Wasm import for it is derived from its descriptor: int-like kinds as i32, long as i64, float as f32, double as
// f64, java.lang.String as externref, a primitive array as a (pointer, length) pair into a linear-memory scratch region the
// stub copies it to and back from. Every other reference (a receiver, an object, an array of objects) crosses as an opaque
// externref; the host side turns it into the value the production native expects, and a reference result back into a Java value,
// through the Bridge (bridge.ts), which reaches fields and elements only through generated Wasm accessors.
import { Code, OP } from "../compiler/code.ts";
import { T, type VT } from "../compiler/wasmbin.ts";
import type { Compiler, Intrinsic } from "../compiler/j2w.ts";
import { ACC, kindOf, mid, type MethodInfo } from "../compiler/program.ts";
import { elemKindOf, type ElemKind } from "../compiler/consts.ts";
import { KINDS, valueKind } from "../compiler/infer.ts";
import { decodeInstructions } from "../../jvm/prepared.ts";
import { PRIMS, type NativeImpl, type PrimArray } from "../../jvm/abi.ts";
import { Bridge } from "./bridge.ts";
import { adaptImport, reportSuspended, reportSuspendError } from "./suspend.ts";
import { specClass, type HostBridge, type HostContext, type HostFn, type NativeBinder, type NativeSource } from "../link/hostapi.ts";
import type { World } from "../link/world.ts";
import { SIZE, copyFn } from "../link/copy.ts";
import { emitSave, emitRestored, ROOT } from "../compiler/hostcalls.ts";
import { crossings } from "./stats.ts";

const OBJECT = "Ljava/lang/Object;", STRING = "Ljava/lang/String;", STRING_CLASS = "java/lang/String";
const isPrimArray = (d: string) => d.length === 2 && d[0] === "[" && d[1] in PRIMS;
const isRef = (d: string) => d[0] === "L" || d[0] === "[";
const abi = (d: string): VT | undefined => isRef(d) ? (isPrimArray(d) ? undefined : T.externref) : KINDS[valueKind(d)].vt;
/** String methods whose Java body builds a Pattern and a Matcher per call, and whose production override, a self-contained JS routine,
 *  measured tens of times faster; the rest of String runs its bytecode unless that reads the representation */
const HOST_FIRST = /^(matches|replaceAll|replaceFirst)\(/;
/** must `m`, a String method with a body, be replaced by its production override */
function overridden(m: MethodInfo): boolean {
  return HOST_FIRST.test(m.key) || decodeInstructions(m.dex.code(m.codeOff).insns).some((i) => (i.name.startsWith("iget") || i.name.startsWith("iput")) && m.dex.typeName(m.dex.field(i.c).cls) === STRING_CLASS);
}

/** the (offset, length) positions of each array parameter `impl` touches only in that range (NativeImpl.ranges), by position in the import's Java
 *  parameters (receiver first). The array is copied for that range alone. */
const rangesOf = (m: MethodInfo, impl: NativeImpl): Map<number, [number, number]> => {
  const out = new Map<number, [number, number]>(), shift = m.isStatic || m.isCtor ? 0 : 1;
  for (const [a, o, l] of impl.ranges ?? []) out.set(a + shift, [o + shift, l + shift]);
  return out;
};

/** whether a native that answers a Promise where it was not expected to may still wait: its call site settles the Promise with a Suspending import. Its arrays are views of the
 *  scratch region it reserved, which stays reserved while it waits (the call site lowers the scratch top only if nothing was reserved above it meanwhile) */
const parkable = (p: Plan): boolean => !p.suspends && !p.always;
/** whether a Suspending native has arrays to give back or answers one: they reach the call site through `land` once it has resumed */
const lands = (p: Plan): boolean => p.suspends && (p.retArray !== null || p.args.some(isPrimArray));
/** The primitive result kind shared by settle and landing imports. */
const resultKind = (p: Plan): string => (p.ret === null ? "v" : p.ret === T.externref ? "x" : p.ret === T.i64 ? "j" : p.ret === T.f32 ? "f" : p.ret === T.f64 ? "d" : "i");

const settleKey = (p: Plan): string => "settle:" + resultKind(p);
const landingKey = (p: Plan): string => "land:" + resultKind(p);
const importKey = (p: Plan): string => p.id + (p.suspends ? p.always ? "#s" : "#p" : "");
interface Landing { own: [number, PrimArray][]; result: PrimArray | null; value: unknown; error?: unknown }

interface Plan {
  id: string; fn: HostFn; recv: boolean;
  /** whether it may answer a Promise: it then has a Suspending import beside its plain one (`id#s`), which a strand's stack calls, since the plain one cannot wait */
  suspends: boolean;
  /** whether it always does, which leaves the Suspending import alone */
  always: boolean;
  /** whether a Promise it answers only says to call it again once settled (`retries`) */
  retry: boolean;
  /** whether it takes and answers Java values as they are (NativeImpl.raw): its references are all opaque */
  raw: boolean;
  /** the class whose statics a `static ()V` native fills in, which the Bridge copies into the Wasm class */
  initializes: string | null;
  /** the import's parameters, with an array as two (pointer, length) */
  params: VT[]; ret: VT | null;
  /** the Java-level parameters in order, receiver first, as descriptors */
  args: string[];
  /** per array parameter (position in `args`), the positions of its offset and length parameters */
  ranges: Map<number, [number, number]>;
  /** the array class a result is, if any */
  retArray: string | null;
  /** whether the result is a String */
  retString: boolean;
  /** the descriptor of a result that is an object or an object array, which the Bridge turns into a Java value */
  retRef: string | null;
  /** the import of each World (they differ in memory and exceptions) */
  wrapped?: WeakMap<HostContext, HostFn>;
  waiting?: WeakMap<HostContext, HostFn>;
  plainLanding?: WeakMap<HostContext, HostFn>;
}

export class Natives implements NativeBinder {
  readonly source: NativeSource | undefined;
  /** the plans of the natives by id, for the imports; and of every method, since what a method binds to depends on the Program it is in (a host class changes it) */
  private plans = new Map<string, Plan | string>();
  private byMethod = new WeakMap<MethodInfo, Plan | string>();
  constructor(source: NativeSource | undefined = undefined) { this.source = source; }
  bridge(w: World): HostBridge { return new Bridge(w, this.source); }

  /** `m` as a host import; `override` asks for the production method even where the bytecode would run (an intrinsic's error path) */
  private plan(m: MethodInfo, override = false): Plan | string {
    const id = mid(m);
    let p = this.byMethod.get(m);
    if (p === "bytecode" && override) p = undefined;
    if (p !== undefined) return p;
    // a String constructor is a call site making the String: its host side is a static answering it
    const ctor = m.isCtor && m.cls === STRING_CLASS, recv = !m.isStatic && !ctor;
    // a String is not an object: bytecode that reads its representation (count, hash) is replaced by the production methods
    if (m.codeOff && !ctor && !override && (m.cls !== STRING_CLASS || !overridden(m))) { this.plans.set(id, p = "bytecode"); this.byMethod.set(m, p); return p; }
    // a native with no implementation yet (a JNI library binds its natives when it is loaded) finds one when it is called
    const cls = specClass(m.cls), impl = this.source?.find(cls, m.key, m.isStatic, m.codeOff !== 0) ?? (!m.codeOff && m.flags & ACC.NATIVE ? this.source?.late?.(cls, m.key) : undefined);
    const raw = !!impl?.raw, opaque = (d: string) => (raw && isRef(d) ? OBJECT : d);
    const args = (recv ? [m.cls === STRING_CLASS ? STRING : `L${m.cls};`, ...m.params] : m.params).map(opaque), params: VT[] = [];
    p = !impl ? "unregistered" : "";
    for (const d of p ? [] : args) {
      const t = abi(d);
      if (t !== undefined) params.push(t); else params.push(T.i32, T.i32);
    }
    const rd = opaque(ctor ? STRING : m.ret), ret = rd === "V" ? null : abi(rd) ?? null, retArray = isPrimArray(rd) ? rd : null;
    p ||= { id, fn: impl!.fn, recv, suspends: impl!.wait === "maybe" || impl!.wait === "always", always: impl!.wait === "always", retry: impl!.wait === "retry", raw, initializes: !raw && m.isStatic && !m.params.length && m.ret === "V" ? m.cls : null, params, ret: retArray ? T.i32 : ret, args, ranges: rangesOf(m, impl!), retArray, retString: rd === STRING, retRef: !raw && isRef(rd) && rd !== STRING && !retArray ? rd : null };
    this.plans.set(id, p);
    this.byMethod.set(m, p);
    return p;
  }
  /** makes the host import of native `m` available, as compiling a method that calls it does (a precompiled module imports it by id); whether it has one */
  prepare(m: MethodInfo): boolean { return typeof this.plan(m, true) !== "string"; }
  binds(m: MethodInfo): boolean { return typeof this.plan(m) !== "string"; }
  /** why `m` has no host binding */
  reason(m: MethodInfo): string { const p = this.plan(m); return typeof p === "string" ? `native: ${p}` : "native/abstract"; }

  /** adds the imports of the natives `methods` call (and of the methods themselves); before any function of the module is defined */
  declare(cx: Compiler, methods: Iterable<MethodInfo>): void {
    const add = (m: MethodInfo, override: boolean) => {
      const p = this.plan(m, override);
      if (typeof p === "string") return;
      for (const key of p.suspends && !p.always ? [p.id + "#p", p.id + "#s"] : [importKey(p)]) {
        if (!cx.nativeImports.has(key)) cx.nativeImports.set(key, cx.mb.importFunc("n", key, cx.mb.addFuncType(p.params, lands(p) ? [T.externref] : p.ret === null ? [] : [p.ret])));
      }
      if (parkable(p) && !cx.nativeImports.has(settleKey(p))) cx.nativeImports.set(settleKey(p), cx.mb.importFunc("n", settleKey(p), cx.mb.addFuncType([], p.ret === null ? [] : [p.ret])));
      if (lands(p)) {
        if (!cx.nativeImports.has("land:check")) cx.nativeImports.set("land:check", cx.mb.importFunc("n", "land:check", cx.mb.addFuncType([T.externref], [])));
        if (!cx.nativeImports.has("land")) cx.nativeImports.set("land", cx.mb.importFunc("n", "land", cx.mb.addFuncType([T.externref, T.i32, T.i32], [T.i32])));
        if (!cx.nativeImports.has(landingKey(p))) cx.nativeImports.set(landingKey(p), cx.mb.importFunc("n", landingKey(p), cx.mb.addFuncType([T.externref], p.ret === null ? [] : [p.ret])));
      }
    };
    const string = cx.prog.get(STRING_CLASS);
    for (const m of methods) {
      add(m, !!cx.w.opts.intrinsics.get(mid(m)));
      // the String constructors a method calls are factories over their host implementation
      if (m.codeOff) for (const ins of decodeInstructions(m.dex.code(m.codeOff).insns)) {
        if (!ins.name.startsWith("invoke-direct")) continue;
        const mr = m.dex.method(ins.b);
        if (mr.name !== "<init>" || m.dex.typeName(mr.cls) !== STRING_CLASS) continue;
        const ctor = string?.byKey.get("<init>" + m.dex.methodDesc(ins.b));
        if (ctor) add(ctor, false);
      }
    }
  }
  /** m's body is a call of its host import */
  stub(m: MethodInfo): Intrinsic | undefined { return this.binds(m) ? (cx, mm, c) => this.call(cx, c, mm) : undefined; }
  /** the function making a String the way constructor `m` does, over the production implementation */
  factory(cx: Compiler, m: MethodInfo): number | undefined {
    const p = this.plan(m);
    if (typeof p === "string" || !cx.nativeImports.has(importKey(p))) return undefined;
    return cx.memo("factory:" + p.id, () => {
      const c = new Code(p.args.length);
      this.call(cx, c, m);
      return cx.mb.addFunc(cx.sig(m.params.map(kindOf), "L"), c.finish(), p.id);
    });
  }

  /** emits `m` over its own parameter locals: converts them to the import's types, calls it, converts the result */
  call(cx: Compiler, c: Code, m: MethodInfo): void {
    const p = this.plan(m, true), imp = typeof p === "string" ? undefined : cx.nativeImports.get(importKey(p));
    if (typeof p === "string" || imp === undefined) { cx.gap(c, `${mid(m)}: ${typeof p === "string" ? "native: " + p : "no host import"}`); return; }
    // other strands run while this one waits: it keeps who it is in locals and sets the globals again after the call
    const restore = p.suspends ? emitSave(cx, c) : null;
    const parkedRestore = parkable(p) ? emitSave(cx, c) : null;
    const arrays: ReturnType<Natives["copyIn"]>[] = [];
    const scratch = p.args.some(isPrimArray) || p.retArray ? cx.scratch() : -1, sp0 = scratch >= 0 ? c.newLocal(T.i32) : -1;
    const top = scratch >= 0 && parkable(p) ? c.newLocal(T.i32) : -1, back = lands(p) ? c.newLocal(T.i32) : -1, landed = lands(p) ? c.newLocal(T.externref) : -1;
    if (scratch >= 0) c.gget(scratch).lset(sp0);
    p.args.forEach((d, i) => {
      const t = abi(d);
      if (t === undefined) { const a = this.copyIn(cx, c, i, d, scratch, p.ranges.get(i), arrays); arrays.push(a); c.lget(a.ptr).lget(a.len); return; }
      c.lget(i);
      if (t === T.f32) c.raw(OP.f32_reinterpret_i32); else if (t === T.f64) c.raw(OP.f64_reinterpret_i64); else if (d === STRING) cx.str.toHost(c); else if (t === T.externref) c.externConvertAny();
    });
    if (top >= 0) c.gget(scratch).i32(7).raw(OP.i32_add).i32(-8).raw(OP.i32_and).lset(top);
    if (!restore) {
      c.call(imp);
      // the native answered a Promise: this strand settles it, waiting on its own stack, and takes its value in place of the placeholder the import answered
      if (parkable(p)) {
        const settle = cx.nativeImports.get(settleKey(p))!, wait = cx.global("rt", "wait", T.i32, true);
        c.gget(wait);
        if (p.ret === null) c.if_(); else c.ifType(cx.mb.addFuncType([p.ret], [p.ret]));
        if (p.ret !== null) c.drop();
        c.i32(0).gset(wait);
        emitRestored(cx, c, [], p.ret === null ? [] : [p.ret], () => { c.call(settle); }, parkedRestore!);
        c.end();
      }
    }
    else {
      // a throw out of the call finds the globals as another strand left them: they are set again before it goes on
      const results = lands(p) ? [T.externref] : p.ret === null ? [] : [p.ret], run = cx.mb.addFuncType(p.params, results);
      emitRestored(cx, c, p.params, results, () => {
        if (p.always) { c.call(imp); return; }
        // the host's top level has no stack to suspend: it calls the plain import, which reports a Promise
        c.gget(cx.global("rt", "sid", T.i32, true)).i32(ROOT).raw(OP.i32_eq).ifType(run).call(imp).else_().call(cx.nativeImports.get(p.id + "#s")!).end();
      }, restore);
      // Each call carries its private arrays through JSPI; only the resumed Wasm caller writes shared scratch.
      if (landed >= 0) {
        const land = cx.nativeImports.get("land")!;
        c.lset(landed).gget(scratch).lset(back);
        for (const a of arrays) c.lget(a.len).i32(0).raw(OP.i32_ge_s).lget(a.alias).raw(OP.i32_eqz).raw(OP.i32_and).if_().lget(landed).lget(a.ptr).lget(a.len).call(land).lset(a.ptr).end();
        if (p.retArray) c.lget(landed).i32(-1).i32(0).call(land).drop();
        c.lget(landed).call(cx.nativeImports.get(landingKey(p))!);
      }
    }
    if (p.ret === T.f32) c.raw(OP.i32_reinterpret_f32); else if (p.ret === T.f64) c.raw(OP.i64_reinterpret_f64); else if (p.ret === T.externref) { if (p.retString) cx.str.fromHost(c); else c.anyConvertExtern(); }
    // an array result is copied from where the host left it, past the parameter regions; the arguments are copied back first
    const rlen = p.retArray ? c.newLocal(T.i32) : -1;
    if (p.retArray) c.lset(rlen);
    for (const a of arrays) c.lget(a.len).i32(0).raw(OP.i32_ge_s).lget(a.alias).raw(OP.i32_eqz).raw(OP.i32_and).if_().lget(a.data).refAsNonNull().lget(a.ptr).lget(a.from).lget(a.count).call(copyFn(cx, a.ek, false)).end();
    if (p.retArray) this.copyOut(cx, c, p.retArray, rlen, scratch);
    if (top >= 0) c.gget(scratch).lget(top).raw(OP.i32_le_u).if_().lget(sp0).gset(scratch).end();
    else if (back >= 0) c.lget(back).gset(scratch);
    else if (scratch >= 0) c.lget(sp0).gset(scratch);
    if (landed >= 0) c.lget(landed).call(cx.nativeImports.get("land:check")!);
  }
  /** copies array parameter `i` of class `d` into a fresh scratch region, leaving its (pointer, length), or (0, -1) for null; only the
   *  elements [from, from + count) are copied when the native's contract names a range inside the array (NativeImpl.ranges), all of them otherwise */
  private copyIn(cx: Compiler, c: Code, i: number, d: string, sp: number, range: [number, number] | undefined, before: { i: number; data: number; ptr: number; len: number; ek: ElemKind; ranged: boolean }[]) {
    const ek = elemKindOf(d), data = c.newLocal({ ht: cx.tData[ek], nullable: true }), ptr = c.newLocal(T.i32), len = c.newLocal(T.i32), from = c.newLocal(T.i32), count = c.newLocal(T.i32), alias = c.newLocal(T.i32);
    // an array passed twice is one region: two copies would each be written back, the later over the first's changes
    const same = range ? [] : before.filter((b) => b.ek === ek && !b.ranged);
    for (const b of same) {
      c.lget(i).lget(b.i).call(cx.helper("acmp")).if_().lget(b.ptr).lset(ptr).lget(b.len).lset(len).lget(b.data).lset(data).i32(1).lset(alias).else_();
    }
    c.lget(i).refIsNull().if_().i32(-1).lset(len).else_()
      .lget(i).refCast(cx.tArr[ek]).structGet(cx.tArr[ek], 2).lset(data).lget(data).refAsNonNull().arrayLen().lset(len).lget(len).lset(count)
      .lget(len).i32(SIZE[ek]).raw(OP.i32_mul).call(this.reserveFn(cx, sp)).lset(ptr);
    if (range) {
      const [o, n] = range;
      c.lget(o).i32(0).raw(OP.i32_ge_s).lget(n).i32(0).raw(OP.i32_ge_s).raw(OP.i32_and).lget(o).lget(len).raw(OP.i32_le_s).raw(OP.i32_and)
        .lget(n).lget(len).lget(o).raw(OP.i32_sub).raw(OP.i32_le_s).raw(OP.i32_and).if_().lget(o).lset(from).lget(n).lset(count).end();
    }
    c.lget(data).refAsNonNull().lget(ptr).lget(from).lget(count).call(copyFn(cx, ek, true)).end();
    same.forEach(() => c.end());
    return { i, data, ptr, len, from, count, ek, alias, ranged: !!range };
  }
  /** the array result of the host call: `rlen` elements at the scratch top, or null */
  private copyOut(cx: Compiler, c: Code, d: string, rlen: number, sp: number): void {
    const ek = elemKindOf(d), data = c.newLocal({ ht: cx.tData[ek], nullable: true });
    c.lget(rlen).i32(0).raw(OP.i32_lt_s).if_(T.anyref).anyNull().else_()
      .lget(rlen).arrayNewDefault(cx.tData[ek]).lset(data)
      .lget(data).refAsNonNull().gget(sp).i32(0).lget(rlen).call(copyFn(cx, ek, false))
      .gget(cx.vtGlobal(d)).refAsNonNull().i64(0n).lget(data).refAsNonNull().structNew(cx.tArr[ek]).end();
  }
  /** reserve(bytes) -> pointer: 8-aligned scratch past the current top, the memory grown to hold it */
  private reserveFn(cx: Compiler, sp: number): number {
    return cx.memo("reserve", () => {
      const c = new Code(1), ptr = c.newLocal(T.i32), end = c.newLocal(T.i32);
      c.gget(sp).i32(7).raw(OP.i32_add).i32(-8).raw(OP.i32_and).lset(ptr).lget(ptr).lget(0).raw(OP.i32_add).lset(end);
      c.lget(end).memorySize().i32(16).raw(OP.i32_shl).raw(OP.i32_gt_u).if_()
        .lget(end).memorySize().i32(16).raw(OP.i32_shl).raw(OP.i32_sub).i32(0xffff).raw(OP.i32_add).i32(16).raw(OP.i32_shr_u).memoryGrow().i32(-1).raw(OP.i32_eq).if_().unreachable().end().end();
      c.lget(end).gset(sp).lget(ptr);
      return cx.mb.addFunc(cx.mb.addFuncType([T.i32], [T.i32]), c.finish(), "$reserve");
    });
  }

  /** the "n" import module for `ids`: each native with its exception and suspension handling, and its arrays viewed in memory */
  imports(ctx: HostContext, ids: Iterable<string>): Record<string, HostFn> {
    const out: Record<string, HostFn> = {};
    const throwJava = (t: { cls: string; msg: string | null; obj?: object; java?: object }): never => {
      if (t.java) throw ctx.raise(t.java);
      const j = ctx.throwable(t.cls, t.msg);
      if (t.obj) ctx.bridge.copyFields(t.obj as Record<string, unknown>, j, t.cls);
      throw ctx.raise(j);
    };
    const raise = (e: unknown): never => {
      const t = this.source?.thrown(e);
      if (!t) throw e;
      return throwJava(t);
    };
    const view = (kind: string, ptr: number, len: number) => len < 0 ? null : new PRIMS[kind].array(ctx.mem.buffer, ptr, len);
    // `reserve(bytes)`: 8-aligned scratch past the current top
    const reserve = (bytes: number): number => {
      const at = ((ctx.sp.value as number) + 7) & -8, need = at + bytes, have = ctx.mem.buffer.byteLength;
      ctx.sp.value = at;
      if (need > have) ctx.mem.grow(Math.ceil((need - have) / 65536));
      return at;
    };
    // a result array is left at the scratch top, which the stub copies out
    const put = (r: PrimArray | null) => {
      if (r === null) return -1;
      const at = reserve(r.byteLength);
      new (r.constructor as typeof Uint8Array)(ctx.mem.buffer, at, r.length).set(r as never);
      return r.length;
    };
    const aux: Aux = {
      // Release copied arguments before the native can re-enter Java.
      release: (list) => { for (const [ptr] of list) if (ptr < (ctx.sp.value as number)) ctx.sp.value = ptr; },
      own: (list, kind, ptr, len) => {
        const v = view(kind, ptr, len) as (PrimArray & { slice(): PrimArray }) | null;
        if (v === null) return null;
        const same = list.find(([at, copy]) => at === ptr && copy.constructor === v.constructor && copy.byteLength === v.byteLength);
        if (same) return same[1];
        const copy = v.slice(); list.push([ptr, copy]); return copy;
      },
    };
    const land = (rec: Landing, ptr: number, len: number): number => {
      if (ptr < 0) { put(rec.result); return 0; }
      const mine = rec.own.find(([at, copy]) => at === ptr && copy.length === len);
      if (!mine) return ptr;
      const bytes = mine[1].byteLength, at = reserve(bytes);
      new Uint8Array(ctx.mem.buffer, at, bytes).set(new Uint8Array(mine[1].buffer, mine[1].byteOffset, bytes));
      ctx.sp.value = at + bytes;
      return at;
    };
    for (const key of ids) {
      if (key.startsWith("settle:")) { out[key] = ctx.sched.settle() as HostFn; continue; }
      if (key === "land:check") { out[key] = ((rec: Landing) => { if ("error" in rec) throw rec.error; }) as HostFn; continue; }
      if (key.startsWith("land:")) { out[key] = ((rec: Landing) => rec.value) as HostFn; continue; }
      if (key === "land") { out[key] = land as HostFn; continue; }
      const waits = key.endsWith("#s"), landing = key.endsWith("#p"), id = waits || landing ? key.slice(0, -2) : key, p = this.plans.get(id);
      if (typeof p === "string" || !p) continue;
      const cache = waits ? (p.waiting ??= new WeakMap()) : landing ? (p.plainLanding ??= new WeakMap()) : (p.wrapped ??= new WeakMap()), cached = cache.get(ctx);
      if (cached) { out[key] = cached; continue; }
      // The module's import name fixes its suspension/landing ABI, even when a
      // native bound after the build is now known to answer Promises.
      const abiPlan = { ...p, suspends: waits || landing, always: waits && p.always };
      const planned = (suspending: boolean) => wrapper(abiPlan, p.fn, raise, () => {
        reportSuspended(id);
        ctx.gap(`${id}: native suspended (answers a Promise)`);
        return throwJava({ cls: "java/lang/UnsatisfiedLinkError", msg: `${id}: native suspended` });
      }, view, put, ctx.bridge, parkable(abiPlan) ? { ...aux, canWait: () => ctx.sched.canWait(), park: (promise) => { if (!p.retry) reportSuspended(id); ctx.sched.parkNative(promise); }, owes: () => ctx.sched.owes(), yield: (promise) => ctx.sched.parkNative(promise) } : aux, suspending);
      cache.set(ctx, out[key] = adaptImport(planned, ctx, waits));
    }
    return out;
  }
}

interface Aux {
  release(list: [number, PrimArray][]): void;
  own(list: [number, PrimArray][], kind: string, ptr: number, len: number): PrimArray | null;
  /** a plain native answered a Promise: whether this stack can wait for it, and handing it to the call site to settle */
  canWait?(): boolean;
  /** whether the strand has made so many nested entries that it should wait once (Sched.owes), and handing the call site the Promise to wait for */
  owes?(): boolean;
  yield?(promise: Promise<unknown>): void;
  park?(promise: Promise<unknown>): void;
}
type Maker = (f: HostFn, raise: (e: unknown) => never, suspended: () => never, view: (k: string, p: number, l: number) => unknown, put: (r: PrimArray | null) => number,
  B: HostBridge, D: string[], RD: string | null, CLS: string | null, X: Aux, S: (e: unknown) => void, K: typeof crossings) => HostFn;
const makers = new Map<string, Maker>();
/** one function per shape: a native runs under try/catch so a Java throwable it raises becomes a Wasm exception, and a native that
 *  suspends (answers a Promise) is reported, not mistaken for a value; array parameters become views, an array result is stored, and
 *  other references are turned into host values for the call and back into Java values after it (bridge.ts).
 *  A Suspending native works on private copies of its arrays; when it answers a Promise, the Bridge scope it opened is set aside while it
 *  waits and taken up again when it resumes, since other strands open and close theirs meanwhile. */
function wrapper(p: Plan, f: HostFn, raise: Parameters<Maker>[1], suspended: Parameters<Maker>[2], view: Parameters<Maker>[3], put: Parameters<Maker>[4], B: HostBridge, X: Aux, susp: boolean): HostFn {
  const parked = parkable(p), objects = p.args.map((d) => !p.raw && isRef(d) && d !== STRING && !isPrimArray(d)), // a native that takes a long may be handed the address of a Java array: it reaches the array by `deref` (a copy of its own), which is stored back when the native returns
  bridged = objects.some(Boolean) || p.retRef !== null || p.initializes !== null || (!p.raw && p.args.includes("J"));
  const key = p.args.map((d, i) => isPrimArray(d) ? d : objects[i] ? "r" : "v").join() + p.recv + p.retArray + (p.retRef !== null) + bridged + (p.initializes !== null) + JSON.stringify([...p.ranges]) + susp + parked + p.retry + (p.ret ?? "v") + p.raw + p.args.includes("J");
  let make = makers.get(key);
  if (!make) {
    const at: number[] = [];
    p.args.reduce((n, d, i) => (at[i] = n, n + (isPrimArray(d) ? 2 : 1)), 0);
    const names = at.flatMap((n, i) => isPrimArray(p.args[i]) ? ["a" + n, "a" + (n + 1)] : ["a" + n]);
    // an Object argument with a range reaches the native as just that range, at offset 0
    const pre: string[] = [], arrayPre: string[] = [], args = p.args.map((d, i) => isPrimArray(d) ? (susp ? `X.own(own,${JSON.stringify(d[1])},a${at[i]},a${at[i] + 1})` : `view(${JSON.stringify(d[1])},a${at[i]},a${at[i] + 1})`) : objects[i] ? `h${i}` : "a" + at[i]);
    p.args.forEach((d, i) => {
      if (susp && isPrimArray(d)) { arrayPre.push(`const h${i}=${args[i]};`); args[i] = `h${i}`; }
      if (!objects[i]) return;
      const r = p.ranges.get(i);
      pre.push(`const h${i}=B.toHost(a${at[i]},D[${i}]${r ? `,[a${at[r[0]]},a${at[r[1]]}]` : ""});`);
      if (r) args[r[0]] = `B.offsetIn(h${i},a${at[r[0]]})`;
    });
    const call = p.initializes !== null ? "B.initialize(CLS,f)" : p.recv ? `f.call(${args.join(",")})` : `f(${args.join(",")})`;
    const scope = bridged ? ["const s=B.begin()", "B.end(s)"] : ["", ""], hold = bridged ? "B.hold(s);" : "", resume = bridged ? "B.resume(s);" : "";
    const toJava = p.retRef !== null ? "r=B.toJava(r,RD);" : "", result = `return ${p.retArray ? "put(r)" : "r"}`;
    // a plain native with no arrays may answer a Promise: its scope is set aside, and the call site waits for the result the Promise settles to
    const zero = p.ret === T.i64 ? "0n" : p.ret === T.externref ? "null" : p.ret === null ? "undefined" : "0", done = `try{r=v;${toJava}${result}}catch(e){return raise(e)}finally{${scope[1]}}`;
    const settle = `(v)=>{${resume}${done}},(e)=>{${resume}${scope[1]};return raise(e)}`;
    // a native that retries is called again (`run`, over fresh views of its arrays), its scope taken up for the call and set aside again if it waits once more
    const fail = `(e)=>{${resume}${scope[1]};return raise(e)}`;
    const again = `const again=()=>{${resume}try{r=run()}catch(e){${scope[1]};return raise(e)}if(r instanceof Promise){${hold}return r.then(again,${fail})}try{${toJava}${result}}catch(e){return raise(e)}finally{${scope[1]}}};`;
    const park = `if(r instanceof Promise){if(!X.canWait())return suspended();${hold}${p.retry ? `${again}X.park(r.then(again,${fail}))` : `X.park(r.then(${settle}))`};return ${zero}}if(X.owes()){${hold}X.yield(Promise.resolve(r).then(${settle}));return ${zero}}`;
    const failure = lands(p) ? `try{return raise(e)}catch(error){return {own:${susp ? "own" : "[]"},result:null,value:${p.retArray ? "-1" : zero},error}}` : "return raise(e)";
    const returned = lands(p) ? `return {own:${susp ? "own" : "[]"},result:${p.retArray ? "r" : "null"},value:${p.retArray ? "r===null?-1:r.length" : "r"}}` : result;
    // a Suspending native answers a Promise only when it waits: a value answered at once leaves the strand on its stack
    const wait = susp ? `if(r instanceof Promise){${hold}return(async()=>{try{try{r=await r}finally{${resume}}${toJava}}catch(e){${failure}}finally{${scope[1]}}
${returned}})()}`
      : parked ? park : "if(r instanceof Promise){r.catch(()=>{});return suspended();}";
    make = new Function("f", "raise", "suspended", "view", "put", "B", "D", "RD", "CLS", "X", "S", "K", `"use strict";return function(${names.join(",")}){K.n++;${susp ? "const own=[];" : ""}${scope[0]};let r${p.retry ? ",run" : ""};try{${arrayPre.join("")}${susp ? "X.release(own);" : ""}${pre.join("")}${p.retry ? `run=()=>${call};r=run()` : `r=${call}`}}catch(e){S(e);${scope[1]};${failure}}
${susp ? wait : ""}try{${susp ? "" : wait}${toJava}}catch(e){${failure}}finally{${scope[1]}}
${returned}}`) as Maker;
    makers.set(key, make);
  }
  return make(f, raise, suspended, view, put, B, p.args, p.retRef, p.initializes, X, reportSuspendError, crossings);
}
