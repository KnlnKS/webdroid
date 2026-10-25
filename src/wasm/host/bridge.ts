// The host side of object references that cross the native boundary. A Java object reaches the host as an opaque value and
// is only ever looked into through generated Wasm accessors: the length and elements of an array, and one getter/setter per field. For
// the duration of a native call a reference becomes the value the native expects (a typed array copy for a primitive array
// reached through Object, a JS array for an object array, a field-reading Proxy for any other object) and what the native wrote is
// stored back when the call ends. A result the native returns is turned into a Java value: strings and references it was given pass
// through, host arrays are allocated in the Wasm heap, and an object a native made (a Struct*) is copied field by field.
import { PRIMS, dotName, mangleField } from "../../jvm/abi.ts";
import { rt, JObj } from "../../jvm/runtime.ts";
import { JThrowable } from "../../jvm/natives/jthrowable.ts";
import { ELEM_KINDS, TRANSFER_BASE, TRANSFER_BYTES } from "../compiler/consts.ts";
import { javaName, kindOf, methodKinds, type FieldInfo, type Kind, type MethodInfo } from "../compiler/program.ts";
import type { World } from "../link/world.ts";
import type { Strand } from "../link/sched.ts";
import type { BridgeScope, HostBridge, HostSpec, NativeSource } from "../link/hostapi.ts";
import { copyFn } from "../link/copy.ts";
import { count } from "./stats.ts";
import { readBufferBytes, type JBuffer } from "../../jvm/natives/jnio.ts";

type Fn = (...a: any[]) => any;
type Caller = { cls: string; key: string; call: Fn; rk: Kind | "V" };
/** the host's copy of a primitive array */
type HostView = ArrayBufferView & { length: number; BYTES_PER_ELEMENT: number };
const REF = Symbol("java reference");
const f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer), f64 = new Float64Array(1), i64 = new BigInt64Array(f64.buffer);

/** a field value as host code holds it: floats and doubles are numbers, a long a bigint, a boolean 0 or 1 */
export const fromBits = (v: number | bigint, desc: string): unknown => desc === "F" ? (i32[0] = v as number, f32[0]) : desc === "D" ? (i64[0] = v as bigint, f64[0]) : v;
export const toBits = (v: unknown, desc: string): unknown => desc === "F" ? (f32[0] = v as number, i32[0]) : desc === "D" ? (f64[0] = v as number, i64[0])
  : desc === "J" ? BigInt(v as bigint) : desc === "Z" ? +(v as boolean) : v;

/** the arguments of `m` as Java values in the form its Wasm function takes, and its result back */
const bitsOf = (m: MethodInfo, args: unknown[]): unknown[] => args.map((a, i) => kindOf(m.params[i]) === "L" ? a : toBits(a, m.params[i]));
const javaResult = (m: MethodInfo, rk: Kind | "V", r: unknown): unknown => rk === "V" ? undefined : rk === "L" ? r : fromBits(r as number | bigint, m.ret);

/** a new instance of class `cls`, initialized but not constructed */
export const newInstance = (w: World, cls: string): object => w.helpers.hostFn("e:new:" + cls, [], "L", (cx, c) => { cx.emitEnsure(c, cls); cx.emitNew(c, cls); })() as object;

/** the Java object a facade stands for */
export const refOf = (v: unknown): object | undefined => typeof v === "object" && v !== null ? (v as { [REF]?: object })[REF] : undefined;
/** what host code probes any object for (promises, serializers, error reporters: one namespace here), which is no read of a Java field */
const PROBES = new Set(["then", "toJSON", "message", "stack", "name", "$javaClass", "asymmetricMatch", "nodeType", "runtime"]);
const THROWABLE = "java/lang/Throwable", THROWABLE_ALIAS: Record<string, string> = { msg: mangleField(THROWABLE, "detailMessage"), cause: mangleField(THROWABLE, "cause") };

/** a native call's scope: the arrays it copied, each stored back when it ends */
class Scope implements BridgeScope {
  copies: { java: object; host: object; store: () => void }[] = [];
  held = false;
}

export class Bridge implements HostBridge {
  private w: World; private src?: NativeSource;
  /** the host form of each Java object a native has seen, so its identity is stable across calls */
  private facades = new WeakMap<object, object>();
  /** the host form of each array the calls in progress reached (a call that is passed one an enclosing call has copied shares the copy, which that call stores back); an array leaves it when the call that copied it ends */
  private live = new Map<object, object>();
  private owners = new WeakMap<object, object>();
  private bases = new WeakMap<object, number>();
  /** the open scopes, innermost last */
  private scopes: Scope[] = [];
  private fields = new Map<string, Map<string, FieldInfo>>();
  private accessors = { get: new WeakMap<FieldInfo, Fn>(), set: new WeakMap<FieldInfo, Fn>(), gets: new WeakMap<FieldInfo, Fn>(), sets: new WeakMap<FieldInfo, Fn>() };
  private ops?: { alen: Fn; acopy: Fn; aget: Fn; aset: Fn; js: Fn };

  constructor(w: World, src?: NativeSource) { this.w = w; this.src = src; }
  /** the array accessors, generated on first use (the World is still being constructed when its Bridge is) */
  private get op() {
    if (this.ops) return this.ops;
    const w = this.w;
    const alen = w.helpers.hostFn("b:alen", ["L"], "I", (cx, c) => {
      for (const k of ELEM_KINDS) { const t = cx.tArr[k]; c.lget(0).refTest(t).if_().lget(0).refCast(t).structGet(t, 2).refAsNonNull().arrayLen().ret().end(); }
      c.i32(-1);
    });
    // acopy(array, pointer, toMemory, from, count): elements [from, from + count) of a primitive array to or from linear memory
    const acopy = w.helpers.hostFn("b:acopy", ["L", "I", "I", "I", "I"], "V", (cx, c) => {
      cx.scratch();
      for (const k of ["i8", "i16", "i32", "i64"] as const) {
        const t = cx.tArr[k], data = c.newLocal({ ht: cx.tData[k], nullable: true });
        c.lget(0).refTest(t).if_().lget(0).refCast(t).structGet(t, 2).lset(data);
        const copy = (toMem: boolean) => c.lget(data).refAsNonNull().lget(1).lget(3).lget(4).call(copyFn(cx, k, toMem));
        c.lget(2).if_(); copy(true); c.else_(); copy(false); c.end().ret().end();
      }
    });
    const js = w.helpers.hostFn("b:js", ["L"], "L", (cx, c) => { c.lget(0); cx.str.toHost(c); c.anyConvertExtern(); });
    const aget = w.helpers.hostFn("b:aget", ["L", "I"], "L", (cx, c) => { c.lget(0).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lget(1).arrayGet(cx.tData.ref); });
    const aset = w.helpers.hostFn("b:aset", ["L", "I", "L"], "V", (cx, c) => { c.lget(0).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lget(1).lget(2).arraySet(cx.tData.ref); });
    return this.ops = { alen, acopy, aget, aset, js };
  }

  // ---------- the scope of a native call
  /** whether a native call is in progress */
  get open(): boolean { return this.scopes.length > 0; }
  begin(): Scope { const s = new Scope(); this.scopes.push(s); return s; }
  /** stores back what the call wrote to the arrays it reached, and releases the scratch it used; a held scope ends once it resumes */
  end(s: Scope): void {
    if (s.held) return;
    try { for (let i = s.copies.length - 1; i >= 0; i--) { this.live.delete(s.copies[i].java); s.copies[i].store(); } } finally {
      this.scopes.pop();
      if (!this.scopes.length && this.live.size) this.live.clear();
    }
  }
  /** `s`, the innermost scope, is its strand's while it waits. The scopes under it belong to the calls that entered Java on its way, which go on
   *  before it resumes over whatever scopes are open then. */
  hold(s: Scope): void { this.scopes.pop(); s.held = true; for (const c of s.copies) this.live.delete(c.java); }
  resume(s: Scope): void { s.held = false; this.scopes.push(s); for (const c of s.copies) this.live.set(c.java, c.host); }
  /** `host`, the copy of `java` the innermost call made, which `store` writes back when that call ends */
  private copied(java: object, host: object, store: () => void): void { this.scopes.at(-1)?.copies.push({ java, host, store }); }
  /** copies elements [from, from + count) of the primitive array `o` into `bytes`, or from it, through the transfer window */
  private transfer(o: object, size: number, from: number, count: number, bytes: Uint8Array, toHost: boolean): void {
    const per = TRANSFER_BYTES / size;
    for (let i = 0; i < count; i += per) {
      // acopy addresses element k at pointer + k * size, so the window holds element from + i
      const n = Math.min(per, count - i), at = TRANSFER_BASE - (from + i) * size, win = new Uint8Array(this.w.mem.buffer, TRANSFER_BASE, n * size);
      if (toHost) { this.op.acopy(o, at, 1, from + i, n); bytes.set(win, i * size); }
      else { win.set(bytes.subarray(i * size, (i + n) * size)); this.op.acopy(o, at, 0, from + i, n); }
    }
  }

  // ---------- static initializer natives
  /** runs a `static ()V` native of `cls` and stores the static fields it filled in into the Wasm class */
  initialize(cls: string, run: () => unknown): void {
    const stored = this.src?.stores?.(cls, () => { run(); }) ?? (run(), {});
    for (const [key, v] of Object.entries(stored)) {
      const [name, desc] = key.split(":"), f = this.w.prog.get(cls)?.fields.find((x) => x.isStatic && x.name === name && (desc === undefined || x.desc === desc));
      if (!f) continue;
      this.w.helpers.hostFn(`b:sset:${cls}.${name}`, [f.kind], "V", (cx, c) => { c.lget(0).gset(cx.staticGlobal(cls, name, f.desc)); })(f.kind === "L" ? this.toJava(v, f.desc) : toBits(v, f.desc));
    }
  }

  // ---------- Java to host
  /** `range` is the (offset, length) the native's contract names inside a primitive array, when it does (natives.ts RANGES): only those elements cross */
  toHost(v: unknown, _desc?: string, range?: [number, number]): unknown {
    if (v === null || v === undefined || typeof v === "string") return v ?? null;
    const o = v as object, hit = this.live.get(o) ?? this.facades.get(o) ?? this.w.hosts.hostOf(o);
    if (hit) return hit;
    const name = this.w.classNameOf(o);
    if (name === "java/lang/String") return this.op.js(o);
    if (name[0] !== "[") {
      const spec = this.w.hosts.specOf(name);
      return spec ? this.attach(o, name, spec) : this.facade(o, name);
    }
    return name.length === 2 ? this.primArray(o, name, range) : this.refArray(o, name);
  }
  private primArray(o: object, name: string, range?: [number, number]): unknown {
    const len = this.op.alen(o), { size, array } = PRIMS[name[1]];
    const [from, count] = range && range[0] >= 0 && range[1] >= 0 && range[0] <= len && range[1] <= len - range[0] ? range : [0, len];
    const host = new array(count), bytes = new Uint8Array(host.buffer);
    this.transfer(o, size, from, count, bytes, true);
    this.live.set(o, host); this.owners.set(host, o); this.bases.set(host, from);
    this.copied(o, host, () => this.transfer(o, size, from, count, bytes, false));
    return host;
  }
  /** `offset`, an index into the whole array, as an index into `host`, which holds the elements from a range's start */
  offsetIn(host: unknown, offset: number): number { return offset - (this.bases.get(host as object) ?? 0); }
  private refArray(o: object, name: string): unknown {
    const len = this.op.alen(o), elem = name.slice(1), host: unknown[] & { $t?: string } = new Array(len);
    this.live.set(o, host); this.owners.set(host, o);
    for (let i = 0; i < len; i++) host[i] = this.toHost(this.op.aget(o, i), elem);
    host.$t = elem;
    const seen = host.slice();
    this.copied(o, host, () => { for (let i = 0; i < len; i++) if (host[i] !== seen[i]) this.op.aset(o, i, this.toJava(host[i], elem)); });
    return host;
  }
  private fieldsOf(name: string): Map<string, FieldInfo> {
    let m = this.fields.get(name);
    if (!m) this.fields.set(name, m = new Map(this.w.prog.layout(name).map((f) => [mangleField(f.owner, f.name), f])));
    return m;
  }
  /** one function per class, operation and kind serves the instance fields of that kind the class declares, picked by their index: a module per field is dear */
  private accessor(op: "get" | "set", f: FieldInfo): Fn {
    let fn = this.accessors[op].get(f);
    if (fn) return fn;
    const same = this.w.prog.require(f.owner).fields.filter((x) => !x.isStatic && x.kind === f.kind), i = same.indexOf(f);
    const any = this.w.helpers.hostFn(`b:${op}:${f.owner}:${f.kind}`, op === "get" ? ["L", "I"] : ["L", "I", f.kind], op === "get" ? f.kind : "V", (cx, c) => {
      const st = cx.structFor(f.owner);
      for (let k = 0; k <= same.length; k++) c.block();
      c.lget(1).brTable(same.map((_, k) => k), same.length);
      for (const x of same) {
        c.end().lget(0).refCast(st);
        if (op === "get") c.structGet(st, cx.fieldIndex(f.owner, x)); else c.lget(2).structSet(st, cx.fieldIndex(f.owner, x));
        c.ret();
      }
      c.end().unreachable();
    });
    this.accessors[op].set(f, fn = op === "get" ? (o: object) => any(o, i) : (o: object, v: unknown) => any(o, i, v));
    return fn;
  }
  /** a throwable's facade stands where a native's JThrowable does (`instanceof`, `msg`, `cause`) */
  private facade(o: object, name: string): object {
    const fields = this.fieldsOf(name), bridge = this, throwable = this.w.prog.isSubclass(name, THROWABLE);
    const proxy = new Proxy(Object.create(throwable ? JThrowable.prototype : JObj.prototype), {
      get(t, p) {
        if (p === REF) return o;
        if (p === "$javaClass" && throwable) return javaName(name);
        if (p === "jframes" && throwable) return bridge.frames(o);
        const f = typeof p === "string" ? fields.get(throwable && THROWABLE_ALIAS[p] || p) : undefined;
        if (!f) {
          if (typeof p === "string" && !(p in t) && !PROBES.has(p)) { count("wasmFacadeMisses"); rt.noteMissing(`facade ${name}.${p}`); }
          return Reflect.get(t, p);
        }
        const raw = bridge.accessor("get", f)(o);
        // outside a native's scope (a callback after its call waited) the read opens its own, which nothing else would close
        return f.kind !== "L" ? fromBits(raw, f.desc) : bridge.open ? bridge.toHost(raw, f.desc) : bridge.scoped(() => bridge.toHost(raw, f.desc));
      },
      set(_t, p, v) {
        const f = typeof p === "string" ? fields.get(throwable && THROWABLE_ALIAS[p] || p) : undefined;
        if (!f) throw new Error(`${name} has no field behind ${String(p)}`);
        bridge.write(f, o, f.kind === "L" ? bridge.toJava(v, f.desc) : v);
        return true;
      },
    });
    this.facades.set(o, proxy); this.owners.set(proxy, o);
    return proxy;
  }

  /** the Java frames the throwable `o` recorded, for the report of an exception nothing caught */
  private frames(o: object): string[] | undefined {
    const f = this.fieldsOf(THROWABLE).get(mangleField(THROWABLE, "backtrace")), state = f && this.accessor("get", f)(o);
    return state ? this.w.stacks.stackTrace(state).map((x) => `${dotName(x.cls)}.${x.method}:${x.line}`) : undefined;
  }

  // ---------- host objects (hostclass.ts)
  /** the host object of Java object `o` of class `name`, which `spec` implements: made now, with the fields it shares with Java */
  private attach(o: object, name: string, spec: HostSpec): object {
    const host = new spec.ctor();
    this.w.hosts.bind(o, host);
    this.share(host, o, name);
    return host;
  }
  /** the Java object of host object `host`, which a host-made object has none of until it crosses: an instance of its spec's class */
  private shellOf(host: object): object | undefined {
    const known = this.w.hosts.shellOf(host);
    if (known) return known;
    const spec = this.w.hosts.specOfHost(host);
    if (!spec || !this.w.prog.get(spec.name)) return undefined;
    const cls = this.w.hosts.javaClass(spec);
    const java = newInstance(this.w, cls);
    this.w.hosts.bind(java, host);
    this.share(host, java, cls);
    return java;
  }
  private properties = new Map<string, Map<string, FieldInfo>>();
  /** the host properties that stand for fields of Java class `name`: each field under its mangled name, and the fields the specs name under their host property */
  private propertiesOf(name: string): Map<string, FieldInfo> {
    let props = this.properties.get(name);
    if (!props) {
      props = new Map(this.fieldsOf(name));
      const layout = this.w.prog.layout(name);
      for (const [java, prop] of this.w.hosts.fieldsOf(name)) {
        const f = layout.filter((x) => x.name === java).pop();
        if (f) props.set(prop, f);
      }
      this.properties.set(name, props);
    }
    return props;
  }
  /** makes the fields of `java`, an instance of `name`, the properties of `host` that stand for them. What the host object holds in such a property when it is made (its defaults) is
   *  stored into the field, unless Java has written the field already. */
  private share(host: object, java: object, name: string): void {
    for (const [prop, f] of this.propertiesOf(name)) {
      let get: Fn | undefined, set: Fn | undefined;
      const read = () => (get ??= this.accessor("get", f)), write = () => (set ??= this.accessor("set", f));
      const own = Object.getOwnPropertyDescriptor(host, prop);
      if (own && "value" in own && own.value !== undefined && !this.written(read()(java), f)) write()(java, f.kind === "L" ? this.toJava(own.value, f.desc) : toBits(own.value, f.desc));
      Object.defineProperty(host, prop, { configurable: true,
        get: () => { const raw = read()(java); return f.kind !== "L" ? fromBits(raw, f.desc) : raw === null || typeof raw === "string" ? raw : this.scoped(() => this.toHost(raw, f.desc)); },
        set: (v: unknown) => write()(java, f.kind === "L" ? this.toJava(v, f.desc) : toBits(v, f.desc)) });
    }
  }
  private written(raw: unknown, f: FieldInfo): boolean { return f.kind === "L" ? raw !== null : f.kind === "J" ? raw !== 0n : raw !== 0; }
  private scoped<T>(f: () => T): T { const s = this.begin(); try { return f(); } finally { this.end(s); } }

  private callers = new WeakMap<MethodInfo, Caller>();
  private strandCallers = new WeakMap<MethodInfo, Caller>();
  /** Cache the World wrapper, which retains its lazy-link invalidation, rather than a raw Wasm export. */
  private caller(m: MethodInfo, suspend = false) {
    const cache = suspend ? this.strandCallers : this.callers;
    let entry = cache.get(m);
    if (entry?.cls === m.cls && entry.key === m.key) return entry;
    const { params: kinds, ret: rk } = methodKinds(m);
    const slot = this.w.slotOf(m), ensure = m.isStatic && this.w.needsInit(m.cls) ? this.w.ensureSlot(m.cls) : -1;
    let call: Fn;
    if (suspend) { const invoke = this.w.helpers.invoker(kinds, rk, true); call = (s: Strand, ...a: unknown[]) => invoke(s, slot, ensure, ...a); }
    else { const invoke = this.w.helpers.invoker(kinds, rk); call = (...a: unknown[]) => invoke(slot, ensure, ...a); }
    cache.set(m, entry = { cls: m.cls, key: m.key, call, rk });
    return entry;
  }
  /** Java method `m` (a static one, or on the Java object `recv`) with host arguments, on strand `s`, whose stack can wait: the way a native calls into Java. A static method's
   *  class is initialized first. An array passed is copied for the call, and what the method wrote to it is read back. The answer is the host value, or a Promise of it when
   *  the call waited. The call itself has no scope: the natives it reaches open their own, and one scope that outlived them would hand a native the copy of an array an
   *  earlier native reached */
  invokeOn(s: Strand, m: MethodInfo, recv: object | null, args: unknown[]): unknown {
    const { call, rk } = this.caller(m, true);
    const given = this.scoped(() => this.javaArgs(m, args));
    const finish = (r: unknown) => this.scoped(() => {
      this.readBackAll(args, given);
      return this.hostResult(m, rk, r);
    });
    const r = call(s, ...(m.isStatic ? [] : [recv]), ...given);
    return r instanceof Promise ? r.then(finish) : finish(r);
  }
  private javaArgs(m: MethodInfo, args: unknown[]): unknown[] { return args.map((a, i) => kindOf(m.params[i]) === "L" ? this.toJava(a, m.params[i]) : toBits(a, m.params[i])); }
  private hostResult(m: MethodInfo, rk: Kind | "V", r: unknown): unknown { return rk === "V" ? undefined : rk === "L" ? this.toHost(r, m.ret) : fromBits(r as number | bigint, m.ret); }

  // ---------- Java values, for native code that holds Java objects itself (JNI): nothing is copied or wrapped, so an array is the one Java has
  /** Java method `m` on `recv` with Java values (a reference as it is, a float or double as a number, a long as a bigint): a Java value */
  call(m: MethodInfo, recv: object | null, args: unknown[]): unknown {
    const { call, rk } = this.caller(m);
    const given = bitsOf(m, args);
    const r = this.w.unwound(() => call(...(m.isStatic ? [] : [recv]), ...given));
    return javaResult(m, rk, r);
  }
  /** `call` on strand `s`, whose stack can wait: the Java value, or a Promise of it when the call waited */
  callOn(s: Strand, m: MethodInfo, recv: object | null, args: unknown[]): unknown {
    const { call, rk } = this.caller(m, true);
    const finish = (r: unknown) => javaResult(m, rk, r);
    const r = call(s, ...(m.isStatic ? [] : [recv]), ...bitsOf(m, args));
    return r instanceof Promise ? r.then(finish) : finish(r);
  }
  /** field `f` of `o`, or of its class when static, as a Java value; the class of a static field is initialized by whoever found the field */
  read(f: FieldInfo, o: object | null): unknown {
    const raw = f.isStatic ? this.staticAccessor("get", f)() : this.accessor("get", f)(o);
    return f.kind === "L" ? raw : fromBits(raw, f.desc);
  }
  /** a native's store into a long field claims the handle it holds as compiled code's store does (World.claims) */
  write(f: FieldInfo, o: object | null, v: unknown): void {
    const given = f.kind === "L" ? v : toBits(v, f.desc);
    if (f.isStatic) this.staticAccessor("set", f)(given);
    else {
      this.accessor("set", f)(o, given);
      if (this.w.claims(f)) this.w.opts.claim?.(o!, given as bigint);
    }
  }
  private staticAccessor(op: "get" | "set", f: FieldInfo): Fn {
    const cache = this.accessors[op === "get" ? "gets" : "sets"];
    let fn = cache.get(f);
    if (!fn) cache.set(f, fn = this.w.helpers.hostFn(`b:${op}s:${f.owner}.${f.name}:${f.desc}`, op === "get" ? [] : [f.kind], op === "get" ? f.kind : "V", (cx, c) => {
      const g = cx.staticGlobal(f.owner, f.name, f.desc);
      if (op === "get") c.gget(g); else c.lget(0).gset(g);
    }));
    return fn;
  }
  arrayLength(a: object): number { return this.op.alen(a); }
  element(a: object, i: number): unknown { return this.op.aget(a, i); }
  readBuffer(b: object, at: number, n: number): Uint8Array | Promise<Uint8Array> {
    const fail = (e: unknown): never => {
      const t = this.src?.thrown(e);
      if (!t) throw e;
      const java = t.java ?? this.w.helpers.makeThrowable(t.cls, t.msg);
      if (t.obj && !t.java) this.scoped(() => this.copyFields(t.obj as Record<string, unknown>, java, t.cls));
      throw this.w.exception(java);
    };
    try {
      return this.scoped(() => {
        const bytes = readBufferBytes(this.toHost(b) as JBuffer, at, n);
        return bytes instanceof Promise ? bytes.then(bytes => bytes.slice(), fail) : bytes.slice();
      });
    } catch (e) { return fail(e); }
  }
  setElement(a: object, i: number, v: unknown): void { this.op.aset(a, i, v); }
  newArray(name: string, n: number): object { return this.newArrayOf(name)(n); }

  // ---------- host to Java
  toJava(v: unknown, desc: string): unknown {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return this.w.javaString(v);
    const o = v as object, known = this.owners.get(o);
    if (known) {
      // the host's copy of a Java array in this scope, which it may have written since it got it (a copy whose scope ended stores nothing back)
      if (this.live.get(known) !== o) return known;
      if (ArrayBuffer.isView(o)) this.sync(known, o as HostView, true);
      else if (Array.isArray(o)) { const elem = this.w.classNameOf(known).slice(1); o.forEach((e, i) => this.op.aset(known, i, this.toJava(e, elem))); }
      return known;
    }
    if (ArrayBuffer.isView(o)) return this.newPrimArray(o as ArrayBufferView & { length: number });
    if (Array.isArray(o)) return this.newRefArray(o as unknown[] & { $t?: string }, desc);
    const java = this.shellOf(o);
    if (java) return java;
    const cls = this.src?.classOf?.(o);
    // a throwable a native raised without Java code (hostThrowable) becomes a Java one with its message
    if (cls && o instanceof JThrowable) return this.w.helpers.makeThrowable(cls, o.msg);
    if (cls) return this.copyObject(o as Record<string, unknown>, cls);
    throw new Error(`a native returned a host value of no Java class (${(o as { constructor?: { name?: string } }).constructor?.name}) where ${desc} was expected`);
  }
  /** what the method wrote to the arrays the host passed, into the host's copies: those made for the call and those of this scope */
  private readBackAll(args: unknown[], given: unknown[]): void {
    args.forEach((a, i) => {
      if (!given[i] || typeof a !== "object" || this.owners.has(a!) && this.live.get(given[i] as object) !== a) return;
      if (ArrayBuffer.isView(a)) this.sync(given[i] as object, a as HostView, false);
      else if (Array.isArray(a)) for (let k = 0; k < a.length; k++) a[k] = this.toHost(this.op.aget(given[i] as object, k));
    });
  }
  /** copies the elements of the host copy `host` of the Java array `j` (the range from its base, when it holds one) into the array, or the array's into it */
  private sync(j: object, host: HostView, toJava: boolean): void {
    this.transfer(j, host.BYTES_PER_ELEMENT, this.bases.get(host) ?? 0, host.length, new Uint8Array(host.buffer, host.byteOffset, host.byteLength), !toJava);
  }
  private newArrayOf(name: string): Fn {
    return this.w.helpers.hostFn("b:new:" + name, ["I"], "L", (cx, c) => cx.emitNewArray(c, name, () => c.lget(0)));
  }
  private newPrimArray(a: ArrayBufferView & { length: number }): object {
    const name = "[" + Object.entries(PRIMS).find(([, p]) => a instanceof p.array)![0], j = this.newArrayOf(name)(a.length);
    this.transfer(j, (a as HostView).BYTES_PER_ELEMENT, 0, a.length, new Uint8Array(a.buffer, a.byteOffset, a.byteLength), false);
    return j;
  }
  private newRefArray(a: unknown[] & { $t?: string }, desc: string): object {
    const elem = a.$t ?? (desc[0] === "[" ? desc.slice(1) : "Ljava/lang/Object;"), j = this.newArrayOf("[" + elem)(a.length);
    a.forEach((e, i) => this.op.aset(j, i, this.toJava(e, elem)));
    return j;
  }
  /** an object the host made with rt.make (a Struct*, a FileDescriptor), copied into the Wasm heap with its fields (not its identity): an object the host creates to keep is made with newObj */
  private copyObject(o: Record<string, unknown>, cls: string): object {
    const j = newInstance(this.w, cls);
    this.copyFields(o, j, cls);
    return j;
  }
  /** the fields the production object holds under the names of the classes below Throwable, set on the Java object of the same class */
  copyFields(o: Record<string, unknown>, j: object, cls: string): void {
    for (const f of this.fieldsOf(cls).values()) {
      const v = o[mangleField(f.owner, f.name)];
      if (v !== undefined) this.accessor("set", f)(j, f.kind === "L" ? this.toJava(v, f.desc) : toBits(v, f.desc));
    }
  }
}
