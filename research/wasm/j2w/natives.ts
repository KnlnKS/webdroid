// The host boundary for natives (plan 3.5), generated from method descriptors. A native is registered once, in the production
// runtime; the Wasm import for it is derived from its descriptor: int-like kinds as i32, long as i64, float as f32, double as
// f64, java.lang.String as externref. A descriptor with any other type (an object or array) is not marshalled, so that native
// stays a recorded gap rather than receiving a value it cannot read.
import { Code, OP } from "./code";
import { T, type VT } from "./wasmbin";
import type { Compiler, Intrinsic } from "./j2w";
import type { MethodInfo } from "./program";
import { mid } from "./reach";

export type HostFn = (...a: any[]) => unknown;
export interface NativeSource {
  /** the registered implementation of `cls`.`key` (name+descriptor); an instance method's `this` is its receiver */
  find(cls: string, key: string, isStatic: boolean, hasBody: boolean): HostFn | undefined;
  /** a Java throwable raised by a native, by class and message */
  thrown(e: unknown): { cls: string; msg: string | null } | undefined;
}
/** classes natives raise: each gets a (String) constructor in every module so the host can build the throwable */
export const HOST_THROWABLES = ["java/lang/StringIndexOutOfBoundsException", "java/lang/IndexOutOfBoundsException", "java/lang/IllegalArgumentException",
  "java/lang/IllegalStateException", "java/lang/UnsupportedOperationException", "java/lang/NumberFormatException", "java/lang/NegativeArraySizeException",
  "java/lang/ArrayIndexOutOfBoundsException", "java/lang/NullPointerException", "java/lang/ArithmeticException", "java/lang/ClassCastException"];

const STRING = "Ljava/lang/String;";
const abi = (d: string): VT | undefined => d === STRING ? T.externref
  : ({ Z: T.i32, B: T.i32, S: T.i32, C: T.i32, I: T.i32, F: T.f32, D: T.f64, J: T.i64 } as Record<string, VT>)[d];

interface Plan { id: string; fn: HostFn; recv: boolean; params: VT[]; ret: VT | null; m: MethodInfo; idx: number }
/** what the host side needs after instantiation */
export interface HostContext { tag?: WebAssembly.Tag; mkthrow?: (id: number, msg: string | null) => unknown }

export class Natives {
  private plans = new Map<string, Plan | string>();
  /** class id of each throwable `mkthrow` can build */
  throwIds = new Map<string, number>();
  constructor(private src?: NativeSource) {}

  private plan(m: MethodInfo): Plan | string {
    const id = mid(m);
    let p = this.plans.get(id);
    if (p !== undefined) return p;
    // only String's bytecode is replaced by production methods: its representation is not an object
    const fn = m.codeOff && m.cls !== "java/lang/String" ? undefined : this.src?.find(m.cls, m.key, m.isStatic, m.codeOff !== 0);
    const recv = !m.isStatic, params: VT[] = [];
    p = !fn ? "unregistered" : recv && m.cls !== "java/lang/String" ? "object receiver" : "";
    if (!p) {
      if (recv) params.push(T.externref);
      for (const d of m.params) { const t = abi(d); if (t === undefined) { p = `${d} parameter`; break; } params.push(t); }
    }
    const ret = m.ret === "V" ? null : abi(m.ret);
    if (!p && ret === undefined) p = `${m.ret} result`;
    this.plans.set(id, p ||= { id, fn: fn!, recv, params, ret: ret ?? null, m, idx: -1 });
    return p;
  }
  binds(m: MethodInfo): boolean { return typeof this.plan(m) !== "string"; }
  /** why `m` has no host binding */
  reason(m: MethodInfo): string { const p = this.plan(m); return typeof p === "string" ? `native: ${p}` : "native/abstract"; }

  /** adds the imports; before any function of the module is defined */
  declare(cx: Compiler, methods: Iterable<MethodInfo>): void {
    for (const m of methods) {
      const p = this.plan(m);
      if (typeof p !== "string" && p.idx < 0) p.idx = cx.mb.importFunc("n", p.id, cx.mb.addFuncType(p.params, p.ret === null ? [] : [p.ret]));
    }
  }
  /** m's body is a call of its host import */
  stub(m: MethodInfo): Intrinsic | undefined { return this.binds(m) ? (cx, mm, c) => this.call(cx, c, mm) : undefined; }
  /** emits `m` over its own parameter locals: converts them to the import's types, calls it, converts the result */
  call(cx: Compiler, c: Code, m: MethodInfo): void {
    const p = this.plan(m);
    if (typeof p === "string" || p.idx < 0) { cx.gap(c, `${mid(m)}: ${typeof p === "string" ? "native: " + p : "no host import"}`); return; }
    p.params.forEach((t, i) => {
      c.lget(i);
      if (t === T.f32) c.raw(OP.f32_reinterpret_i32); else if (t === T.f64) c.raw(OP.f64_reinterpret_i64); else if (t === T.externref) c.externOfAny();
    });
    c.call(p.idx);
    if (p.ret === T.f32) c.raw(OP.i32_reinterpret_f32); else if (p.ret === T.f64) c.raw(OP.i64_reinterpret_f64); else if (p.ret === T.externref) c.anyOfExtern();
  }

  /** helper imports the intrinsics call to raise what Java raises; each is `throw`-only */
  helper = {} as Record<"charsBounds", number>;
  importHelpers(cx: Compiler): void {
    this.helper.charsBounds = cx.mb.importFunc("h", "charsBounds", cx.mb.addFuncType([T.i32, T.i32, T.i32], []));
  }

  /** `mkthrow(classId, message)` and the throwable ids, exported for the host */
  emitThrower(cx: Compiler): void {
    const { mb } = cx, c = new Code(2), t = c.newLocal(T.anyref);
    for (const cls of HOST_THROWABLES) {
      const id = cx.classId.get(cls), ctor = cx.prog.resolve(cls, "<init>", "(Ljava/lang/String;)V");
      if (id === undefined || !ctor || !cx.fn.has(mid(ctor)) || !cx.vtGlobal.has(cls)) continue;
      this.throwIds.set(cls, id);
      c.lget(0).i32(id).raw(OP.i32_eq).if_();
      cx.emitEnsure(c, cls); cx.emitNew(c, cls); c.lset(t).lget(t).lget(1).anyOfExtern().call(cx.fnOf(ctor)).lget(t).ret().end();
    }
    c.unreachable();
    mb.export("mkthrow", "func", mb.addFunc(mb.addFuncType([T.i32, T.externref], [T.anyref]), c.finish(), "$mkthrow"));
  }

  /** the "n" import module: each native with its exception and suspension handling */
  imports(ctx: HostContext): { n: Record<string, HostFn>; h: Record<string, HostFn> } {
    const out: Record<string, HostFn> = {};
    const throwJava = (t: { cls: string; msg: string | null }, e?: unknown): never => {
      const cls = this.throwIds.get(t.cls);
      if (cls === undefined || !ctx.mkthrow) throw e ?? new Error(`${t.cls}: ${t.msg}`);
      throw new WebAssembly.Exception(ctx.tag!, [ctx.mkthrow(cls, t.msg)]);
    };
    const raise = (e: unknown): never => throwJava(this.src?.thrown(e) ?? { cls: "", msg: null }, e);
    const suspended = (id: string): never => { throw new Error(`${id}: native suspended`); };
    for (const p of this.plans.values()) {
      if (typeof p === "string" || p.idx < 0) continue;
      out[p.id] = wrapper(p.params.length, p.recv)(p.fn, raise, () => suspended(p.id));
    }
    // String(char[], int, int) with a bad range: the message runtime.ts strChars gives
    const h = { charsBounds: (off: number, n: number, len: number) => throwJava({ cls: "java/lang/StringIndexOutOfBoundsException", msg: `offset ${off}, count ${n}, length ${len}` }) };
    return { n: out, h };
  }
}

const wrappers = new Map<string, (f: HostFn, raise: (e: unknown) => never, suspended: () => never) => HostFn>();
/** one function per arity: a native runs under try/catch so a Java throwable it raises becomes a Wasm exception, and a native that
 *  suspends (answers a Promise) is reported, not mistaken for a value */
function wrapper(n: number, recv: boolean) {
  const key = `${n}${recv}`;
  let w = wrappers.get(key);
  if (!w) {
    const a = Array.from({ length: n }, (_, i) => "a" + i), call = recv ? `f.call(${a.join(",")})` : `f(${a.join(",")})`;
    w = new Function("f", "raise", "suspended", `"use strict";return function(${a.join(",")}){try{const r=${call};if(r instanceof Promise)return suspended();return r}catch(e){return raise(e)}}`) as never;
    wrappers.set(key, w!);
  }
  return w!;
}
