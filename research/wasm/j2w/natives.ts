// The host boundary for natives (plan 3.5), generated from method descriptors. A native is registered once, in the production
// runtime; the Wasm import for it is derived from its descriptor: int-like kinds as i32, long as i64, float as f32, double as
// f64, java.lang.String as externref, a primitive array as a (pointer, length) pair into a linear-memory scratch region the
// stub copies it to and back from. Every other reference (a receiver, an object, an array of objects) crosses as an opaque
// externref; the host side turns it into the value the production native expects, and a reference result back into a Java value,
// through the Bridge (bridge.ts), which reaches fields and elements only through generated Wasm accessors.
import { Code, OP } from "./code";
import { T, type VT } from "./wasmbin";
import type { Compiler, Intrinsic } from "./j2w";
import { kindOf, type MethodInfo } from "./program";
import { elemKindOf, type ElemKind } from "./consts";
import { mid } from "./reach";
import { decodeInstructions } from "../../../src/jvm/prepared";
import { descToName } from "../../../src/jvm/abi";
import type { Bridge } from "./bridge";

export type HostFn = (...a: any[]) => unknown;
export interface NativeSource {
  /** the registered implementation of `cls`.`key` (name+descriptor); an instance method's `this` is its receiver. A String
   *  constructor's key is `<init>desc` and its implementation answers the String */
  find(cls: string, key: string, isStatic: boolean, hasBody: boolean): HostFn | undefined;
  /** a Java throwable raised by a native, by class and message */
  thrown(e: unknown): { cls: string; msg: string | null; obj?: object } | undefined;
  /** the Java class name of an object the production runtime made, if `v` is one: a native result the Bridge copies into the Wasm heap */
  classOf?(v: unknown): string | undefined;
  /** runs `run`, a `static ()V` native of `cls` that fills in static fields (initConstants), and answers the values it stored by "name:descriptor" */
  stores?(cls: string, run: () => void): Record<string, unknown>;
}
/** what the host side needs from the World */
export interface HostContext {
  mem: WebAssembly.Memory; sp: WebAssembly.Global;
  /** a Java throwable of a class with a message, and the exception that throws it through Wasm */
  throwable(cls: string, msg: string | null): object;
  raise(throwable: object): unknown;
  bridge: Bridge;
  /** records that compiled code ran into something it cannot do (World.onGap) */
  gap(what: string): void;
}

/** the primitive array classes natives take and return */
const PRIM_ARRAYS = ["Z", "B", "C", "S", "I", "J", "F", "D"].map((k) => "[" + k);
const STRING = "Ljava/lang/String;", STRING_CLASS = "java/lang/String";
const isPrimArray = (d: string) => PRIM_ARRAYS.includes(d);
const isRef = (d: string) => d[0] === "L" || d[0] === "[";
const abi = (d: string): VT | undefined => isRef(d) ? (isPrimArray(d) ? undefined : T.externref)
  : ({ Z: T.i32, B: T.i32, S: T.i32, C: T.i32, I: T.i32, F: T.f32, D: T.f64, J: T.i64 } as Record<string, VT>)[d];
/** bytes per element, by storage kind */
export const SIZE: Record<ElemKind, number> = { i8: 1, i16: 2, i32: 4, i64: 8, ref: 4 };
type View = ArrayBufferView & { length: number };
/** the typed array the production natives take for a primitive array class */
export const VIEWS: Record<string, new (b: ArrayBuffer, o: number, n: number) => View> = { Z: Uint8Array, B: Int8Array, C: Uint16Array, S: Int16Array, I: Int32Array, J: BigInt64Array, F: Float32Array, D: Float64Array };

/** String methods whose Java body needs charset or regex machinery (class objects, ICU natives), or ART's native doReplace, and whose
 *  production override is a self-contained JS routine; the rest of String runs its bytecode unless that reads the representation */
const HOST_FIRST = /^(getBytes|matches|replaceAll|replaceFirst)\(|^replace\(CC\)/;
/** must `m`, a String method with a body, be replaced by its production override */
function overridden(m: MethodInfo): boolean {
  return HOST_FIRST.test(m.key) || decodeInstructions(m.dex.code(m.codeOff).insns).some((i) => (i.name.startsWith("iget") || i.name.startsWith("iput")) && descToName(m.dex.type(m.dex.field(i.c).cls)) === STRING_CLASS);
}

interface Plan {
  id: string; fn: HostFn; recv: boolean;
  /** the class whose statics a `static ()V` native fills in, which the Bridge copies into the Wasm class */
  initializes: string | null;
  /** the import's parameters, with an array as two (pointer, length) */
  params: VT[]; ret: VT | null;
  /** the Java-level parameters in order, receiver first, as descriptors */
  args: string[];
  /** the array class a result is, if any */
  retArray: string | null;
  /** the descriptor of a result that is an object or an object array, which the Bridge turns into a Java value */
  retRef: string | null;
  /** the import of each World (they differ in memory and exceptions) */
  wrapped?: WeakMap<HostContext, HostFn>;
}

export class Natives {
  private plans = new Map<string, Plan | string>();
  constructor(private src?: NativeSource) {}
  get source(): NativeSource | undefined { return this.src; }

  /** `m` as a host import; `override` asks for the production method even where the bytecode would run (an intrinsic's error path) */
  private plan(m: MethodInfo, override = false): Plan | string {
    const id = mid(m);
    let p = this.plans.get(id);
    if (p === "bytecode" && override) p = undefined;
    if (p !== undefined) return p;
    // a String constructor is a call site making the String: its host side is a static answering it
    const ctor = m.isCtor && m.cls === STRING_CLASS, recv = !m.isStatic && !ctor;
    // a String is not an object: bytecode that reads its representation (count, hash) is replaced by the production methods
    if (m.codeOff && !ctor && !override && (m.cls !== STRING_CLASS || !overridden(m))) { this.plans.set(id, p = "bytecode"); return p; }
    const fn = this.src?.find(m.cls, m.key, m.isStatic, m.codeOff !== 0);
    const args = recv ? [m.cls === STRING_CLASS ? STRING : `L${m.cls};`, ...m.params] : m.params, params: VT[] = [];
    p = !fn ? "unregistered" : "";
    for (const d of p ? [] : args) {
      const t = abi(d);
      if (t !== undefined) params.push(t); else params.push(T.i32, T.i32);
    }
    const rd = ctor ? STRING : m.ret, ret = rd === "V" ? null : abi(rd) ?? null, retArray = isPrimArray(rd) ? rd : null;
    this.plans.set(id, p ||= { id, fn: fn!, recv, initializes: m.isStatic && !m.params.length && m.ret === "V" ? m.cls : null, params, ret: retArray ? T.i32 : ret, args, retArray, retRef: isRef(rd) && rd !== STRING && !retArray ? rd : null });
    return p;
  }
  binds(m: MethodInfo): boolean { return typeof this.plan(m) !== "string"; }
  /** why `m` has no host binding */
  reason(m: MethodInfo): string { const p = this.plan(m); return typeof p === "string" ? `native: ${p}` : "native/abstract"; }

  /** adds the imports of the natives `methods` call (and of the methods themselves); before any function of the module is defined */
  declare(cx: Compiler, methods: Iterable<MethodInfo>): void {
    const add = (m: MethodInfo, override: boolean) => {
      const p = this.plan(m, override);
      if (typeof p !== "string" && !cx.nativeImports.has(p.id)) cx.nativeImports.set(p.id, cx.mb.importFunc("n", p.id, cx.mb.addFuncType(p.params, p.ret === null ? [] : [p.ret])));
    };
    const string = cx.prog.get(STRING_CLASS);
    for (const m of methods) {
      add(m, !!cx.w.opts.intrinsics.get(mid(m)));
      // the String constructors a method calls are factories over their host implementation
      if (m.codeOff) for (const ins of decodeInstructions(m.dex.code(m.codeOff).insns)) {
        if (!ins.name.startsWith("invoke-direct")) continue;
        const mr = m.dex.method(ins.b);
        if (mr.name !== "<init>" || descToName(m.dex.type(mr.cls)) !== STRING_CLASS) continue;
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
    if (typeof p === "string" || !cx.nativeImports.has(p.id)) return undefined;
    return cx.memo("factory:" + p.id, () => {
      const c = new Code(p.args.length);
      this.call(cx, c, m);
      return cx.mb.addFunc(cx.sig(m.params.map(kindOf), "L"), c.finish(), p.id);
    });
  }

  /** emits `m` over its own parameter locals: converts them to the import's types, calls it, converts the result */
  call(cx: Compiler, c: Code, m: MethodInfo): void {
    const p = this.plan(m, true), imp = typeof p === "string" ? undefined : cx.nativeImports.get(p.id);
    if (typeof p === "string" || imp === undefined) { cx.gap(c, `${mid(m)}: ${typeof p === "string" ? "native: " + p : "no host import"}`); return; }
    const arrays: ReturnType<Natives["copyIn"]>[] = [];
    const scratch = p.args.some(isPrimArray) || p.retArray ? cx.scratch() : -1, sp0 = scratch >= 0 ? c.newLocal(T.i32) : -1;
    if (scratch >= 0) c.gget(scratch).lset(sp0);
    p.args.forEach((d, i) => {
      const t = abi(d);
      if (t === undefined) { const a = this.copyIn(cx, c, i, d, scratch); arrays.push(a); c.lget(a.ptr).lget(a.len); return; }
      c.lget(i);
      if (t === T.f32) c.raw(OP.f32_reinterpret_i32); else if (t === T.f64) c.raw(OP.f64_reinterpret_i64); else if (t === T.externref) c.externConvertAny();
    });
    c.call(imp);
    if (p.ret === T.f32) c.raw(OP.i32_reinterpret_f32); else if (p.ret === T.f64) c.raw(OP.i64_reinterpret_f64); else if (p.ret === T.externref) c.anyConvertExtern();
    // an array result is copied from where the host left it, past the parameter regions; the arguments are copied back first
    const rlen = p.retArray ? c.newLocal(T.i32) : -1;
    if (p.retArray) c.lset(rlen);
    for (const a of arrays) c.lget(a.len).i32(0).raw(OP.i32_ge_s).if_().lget(a.data).refAsNonNull().lget(a.ptr).lget(a.len).call(this.copy(cx, a.ek, false)).end();
    if (p.retArray) this.copyOut(cx, c, p.retArray, rlen, scratch);
    if (scratch >= 0) c.lget(sp0).gset(scratch);
  }
  /** copies array parameter `i` of class `d` into a fresh scratch region, leaving its (pointer, length), or (0, -1) for null */
  private copyIn(cx: Compiler, c: Code, i: number, d: string, sp: number) {
    const ek = elemKindOf(d), data = c.newLocal({ ht: cx.tData[ek], nullable: true }), ptr = c.newLocal(T.i32), len = c.newLocal(T.i32);
    c.lget(i).refIsNull().if_().i32(-1).lset(len).else_()
      .lget(i).refCast(cx.tArr[ek]).structGet(cx.tArr[ek], 2).lset(data).lget(data).refAsNonNull().arrayLen().lset(len)
      .lget(len).i32(SIZE[ek]).raw(OP.i32_mul).call(this.reserveFn(cx, sp)).lset(ptr)
      .lget(data).refAsNonNull().lget(ptr).lget(len).call(this.copy(cx, ek, true)).end();
    return { data, ptr, len, ek };
  }
  /** the array result of the host call: `rlen` elements at the scratch top, or null */
  private copyOut(cx: Compiler, c: Code, d: string, rlen: number, sp: number): void {
    const ek = elemKindOf(d), data = c.newLocal({ ht: cx.tData[ek], nullable: true });
    c.lget(rlen).i32(0).raw(OP.i32_lt_s).if_(T.anyref).anyNull().else_()
      .lget(rlen).arrayNewDefault(cx.tData[ek]).lset(data)
      .lget(data).refAsNonNull().gget(sp).lget(rlen).call(this.copy(cx, ek, false))
      .gget(cx.vtGlobal(d)).refAsNonNull().i32(0).lget(data).refAsNonNull().structNew(cx.tArr[ek]).end();
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
  private copy(cx: Compiler, ek: ElemKind, toMem: boolean): number { return copyFn(cx, ek, toMem); }

  /** the "n" import module for `ids`: each native with its exception and suspension handling, and its arrays viewed in memory */
  imports(ctx: HostContext, ids: Iterable<string>): Record<string, HostFn> {
    const out: Record<string, HostFn> = {};
    const throwJava = (t: { cls: string; msg: string | null; obj?: object }): never => {
      if (process.env.DBG) console.error("THROW", t.cls, t.msg);
      const j = ctx.throwable(t.cls, t.msg);
      if (t.obj) ctx.bridge.copyFields(t.obj as Record<string, unknown>, j, t.cls);
      throw ctx.raise(j);
    };
    const raise = (e: unknown): never => {
      const t = this.src?.thrown(e);
      if (!t) { if (process.env.DBG) console.error((e as Error).stack); throw e; }
      return throwJava(t);
    };
    const view = (kind: string, ptr: number, len: number) => len < 0 ? null : new VIEWS[kind](ctx.mem.buffer, ptr, len);
    // a result array is left at the scratch top, which the stub copies out
    const put = (r: View | null) => {
      if (r === null) return -1;
      const at = ctx.sp.value as number, need = at + r.byteLength, have = ctx.mem.buffer.byteLength;
      if (need > have) ctx.mem.grow(Math.ceil((need - have) / 65536));
      new (r.constructor as typeof Uint8Array)(ctx.mem.buffer, at, r.length).set(r as never);
      return r.length;
    };
    for (const id of ids) {
      const p = this.plans.get(id);
      if (typeof p === "string" || !p) continue;
      if (process.env.TRACE) { const g = p.fn; p.fn = function (this: unknown, ...a: unknown[]) { let r: unknown; try { r = g.apply(this, a); return r; } finally { if (process.env.TRACE === "stack") console.error(new Error().stack?.split("\n").filter((l) => l.includes("wasm") && !l.includes("stub:")).slice(0, 12).map((l) => l.replace(/ \(wasm.*/, "")).join("\n")); console.error("N", id, a.map((x) => typeof x === "string" || typeof x === "number" ? JSON.stringify(x) : typeof x === "bigint" ? x + "n" : x && (x as {length?: number}).length !== undefined ? `[${(x as {length: number}).length}]` : typeof x), "=>", typeof r === "string" ? JSON.stringify(r) : typeof r); } }; }
      out[id] = (p.wrapped ??= new WeakMap()).get(ctx) ?? (p.wrapped.set(ctx, wrapper(p, p.fn, raise, () => { ctx.gap(`${id}: native suspended (answers a Promise)`); return throwJava({ cls: "java/lang/UnsatisfiedLinkError", msg: `${id}: native suspended` }); }, view, put, ctx.bridge)), p.wrapped.get(ctx)!);
    }
    return out;
  }
}

/** copy(data, pointer, length): the array into memory (`toMem`) or memory into the array */
export function copyFn(cx: Compiler, ek: ElemKind, toMem: boolean): number {
  return cx.memo(`copy:${ek}:${toMem}`, () => {
    const c = new Code(3), i = c.newLocal(T.i32), arr = cx.tData[ek], shift = Math.log2(SIZE[ek]);
    const addr = () => c.lget(1).lget(i).i32(shift).raw(OP.i32_shl).raw(OP.i32_add);
    c.block().loop().lget(i).lget(2).raw(OP.i32_ge_s).brIf(1);
    if (toMem) {
      addr(); c.lget(0).lget(i);
      if (ek === "i16") c.arrayGetU(arr).mem(OP.i32_store16, 1); else if (ek === "i8") c.arrayGetU(arr).mem(OP.i32_store8, 0);
      else c.arrayGet(arr).mem(ek === "i64" ? OP.i64_store : OP.i32_store, ek === "i64" ? 3 : 2);
    } else {
      c.lget(0).lget(i); addr();
      if (ek === "i16") c.mem(OP.i32_load16_u, 1); else if (ek === "i8") c.mem(OP.i32_load8_u, 0); else c.mem(ek === "i64" ? OP.i64_load : OP.i32_load, ek === "i64" ? 3 : 2);
      c.arraySet(arr);
    }
    c.lget(i).i32(1).raw(OP.i32_add).lset(i).br(0).end().end();
    return cx.mb.addFunc(cx.mb.addFuncType([{ ht: arr, nullable: false }, T.i32, T.i32], []), c.finish(), `$copy:${ek}:${toMem}`);
  });
}

type Maker = (f: HostFn, raise: (e: unknown) => never, suspended: () => never, view: (k: string, p: number, l: number) => unknown, put: (r: View | null) => number,
  B: Bridge, D: string[], RD: string | null, CLS: string | null) => HostFn;
const makers = new Map<string, Maker>();
/** one function per shape: a native runs under try/catch so a Java throwable it raises becomes a Wasm exception, and a native that
 *  suspends (answers a Promise) is reported, not mistaken for a value; array parameters become views, an array result is stored, and
 *  other references are turned into host values for the call and back into Java values after it (bridge.ts) */
function wrapper(p: Plan, f: HostFn, raise: Parameters<Maker>[1], suspended: Parameters<Maker>[2], view: Parameters<Maker>[3], put: Parameters<Maker>[4], B: Bridge): HostFn {
  const objects = p.args.map((d) => isRef(d) && d !== STRING && !isPrimArray(d)), bridged = objects.some(Boolean) || p.retRef !== null || p.initializes !== null;
  const key = p.args.map((d, i) => isPrimArray(d) ? d : objects[i] ? "r" : "v").join() + p.recv + p.retArray + (p.retRef !== null) + bridged + (p.initializes !== null);
  let make = makers.get(key);
  if (!make) {
    let n = 0;
    const names: string[] = [], args = p.args.map((d, i) => {
      if (!isPrimArray(d)) { names.push("a" + n); return objects[i] ? `B.toHost(a${n++},D[${i}])` : "a" + n++; }
      names.push("a" + n, "a" + (n + 1)); n += 2;
      return `view(${JSON.stringify(d[1])},a${n - 2},a${n - 1})`;
    });
    const call = p.initializes !== null ? "B.initialize(CLS,f)" : p.recv ? `f.call(${args.join(",")})` : `f(${args.join(",")})`;
    const scope = bridged ? ["const s=B.begin()", "B.end(s)"] : ["", ""];
    make = new Function("f", "raise", "suspended", "view", "put", "B", "D", "RD", "CLS", `"use strict";return function(${names.join(",")}){${scope[0]};let r;try{r=${call}}catch(e){${scope[1]};return raise(e)}
try{if(r instanceof Promise)return suspended();${p.retRef !== null ? "r=B.toJava(r,RD);" : ""}}catch(e){return raise(e)}finally{${scope[1]}}
return ${p.retArray ? "put(r)" : "r"}}`) as Maker;
    makers.set(key, make);
  }
  return make(f, raise, suspended, view, put, B, p.args, p.retRef, p.initializes);
}
