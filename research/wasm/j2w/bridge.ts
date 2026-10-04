// The host side of object references that cross the native boundary (plan 3.5). A Java object reaches the host as an opaque value and
// is only ever looked into through generated Wasm accessors: the length and elements of an array, and one getter/setter per field. For
// the duration of a native call a reference becomes the value the production native expects (a typed array copy for a primitive array
// reached through Object, a JS array for an object array, a field-reading Proxy for any other object) and what the native wrote is
// stored back when the call ends. A result the native returns is turned into a Java value: strings and references it was given pass
// through, host arrays are allocated in the Wasm heap, and an object the production runtime made (a Struct*) is copied field by field.
import { mangleField } from "../../../src/jvm/abi";
import { elemKindOf, type ElemKind } from "./consts";
import type { FieldInfo, Kind } from "./program";
import type { Compiler } from "./j2w";
import type { World } from "./lazy";
import type { NativeSource } from "./natives";
import { VIEWS, SIZE, copyFn } from "./natives";

type Fn = (...a: any[]) => any;
const KINDS: ElemKind[] = ["i32", "ref", "i8", "i16", "i64"];
const REF = Symbol("java reference");
const f32 = new Float32Array(1), i32 = new Int32Array(f32.buffer), f64 = new Float64Array(1), i64 = new BigInt64Array(f64.buffer);
/** the primitive array class whose elements a typed array holds */
const ARRAY_OF: [Function, string][] = [[Int8Array, "[B"], [Uint8Array, "[Z"], [Uint16Array, "[C"], [Int16Array, "[S"], [Int32Array, "[I"], [BigInt64Array, "[J"], [Float32Array, "[F"], [Float64Array, "[D"]];

/** a field value as the production runtime holds it: floats and doubles are numbers, a long a bigint, a boolean 0 or 1 */
const fromBits = (v: number | bigint, desc: string): unknown => desc === "F" ? (i32[0] = v as number, f32[0]) : desc === "D" ? (i64[0] = v as bigint, f64[0]) : v;
const toBits = (v: unknown, desc: string): unknown => desc === "F" ? (f32[0] = v as number, i32[0]) : desc === "D" ? (f64[0] = v as number, i64[0])
  : desc === "J" ? BigInt(v as bigint) : desc === "Z" ? +(v as boolean) : v;

export class Bridge {
  /** the host form of each Java object a native has seen, so its identity is stable across calls */
  private facades = new WeakMap<object, object>();
  /** during a call: the host form of each array it reached, the Java array of each host form */
  private live = new Map<object, object>();
  private owners = new WeakMap<object, object>();
  private undo: (() => void)[] = [];
  private saved: number[] = [];
  private fields = new Map<string, Map<string, FieldInfo>>();
  private ops?: { alen: Fn; acopy: Fn; aget: Fn; aset: Fn };

  constructor(private w: World, private src?: NativeSource) {}
  /** the array accessors, generated on first use (the World is still being constructed when its Bridge is) */
  private get op() {
    if (this.ops) return this.ops;
    const hostFn = (name: string, params: Kind[], ret: Kind | "V", body: (cx: Compiler, c: import("./code").Code) => void) => this.w.hostFn(name, params, ret, body);
    const alen = hostFn("b:alen", ["L"], "I", (cx, c) => {
      for (const k of KINDS) { const t = cx.tArr[k]; c.lget(0).refTest(t).if_().lget(0).refCast(t).structGet(t, 2).refAsNonNull().arrayLen().ret().end(); }
      c.i32(-1);
    });
    // acopy(array, pointer, toMemory): all of a primitive array to or from linear memory
    const acopy = hostFn("b:acopy", ["L", "I", "I"], "V", (cx, c) => {
      cx.scratch();
      for (const k of ["i8", "i16", "i32", "i64"] as const) {
        const t = cx.tArr[k], data = c.newLocal({ ht: cx.tData[k], nullable: true });
        c.lget(0).refTest(t).if_().lget(0).refCast(t).structGet(t, 2).lset(data);
        const copy = (toMem: boolean) => c.lget(data).refAsNonNull().lget(1).lget(data).refAsNonNull().arrayLen().call(copyFn(cx, k, toMem));
        c.lget(2).if_(); copy(true); c.else_(); copy(false); c.end().ret().end();
      }
    });
    const aget = hostFn("b:aget", ["L", "I"], "L", (cx, c) => { c.lget(0).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lget(1).arrayGet(cx.tData.ref); });
    const aset = hostFn("b:aset", ["L", "I", "L"], "V", (cx, c) => { c.lget(0).refCast(cx.tArr.ref).structGet(cx.tArr.ref, 2).lget(1).lget(2).arraySet(cx.tData.ref); });
    return this.ops = { alen, acopy, aget, aset };
  }

  // ---------- the scope of a native call
  begin(): number { this.saved.push(this.w.sp.value as number); return this.undo.length; }
  /** stores back what the call wrote to the arrays it reached, and releases the scratch it used */
  end(mark: number): void {
    try { for (const u of this.undo.splice(mark).reverse()) u(); } finally {
      this.w.sp.value = this.saved.pop()!;
      if (!this.saved.length) this.live.clear();
    }
  }
  private region(bytes: number): number {
    const at = (((this.w.sp.value as number) + 7) & -8), need = at + bytes, have = this.w.mem.buffer.byteLength;
    if (need > have) this.w.mem.grow(Math.ceil((need - have) / 65536));
    this.w.sp.value = need;
    return at;
  }

  // ---------- Java to host
  toHost(v: unknown, _desc?: string): unknown {
    if (v === null || v === undefined || typeof v === "string") return v ?? null;
    const o = v as object, hit = this.live.get(o) ?? this.facades.get(o);
    if (hit) return hit;
    const name = this.w.classNameOf(o);
    if (name[0] !== "[") return this.facade(o, name);
    return name.length === 2 ? this.primArray(o, name) : this.refArray(o, name);
  }
  private primArray(o: object, name: string): unknown {
    const len = this.op.alen(o), size = SIZE[elemKindOf(name)], at = this.region(len * size);
    this.op.acopy(o, at, 1);
    const host = new VIEWS[name[1]](this.w.mem.buffer.slice(at, at + len * size), 0, len);
    this.live.set(o, host); this.owners.set(host, o);
    this.undo.push(() => { new Uint8Array(this.w.mem.buffer, at, len * size).set(new Uint8Array(host.buffer, host.byteOffset, len * size)); this.op.acopy(o, at, 0); });
    return host;
  }
  private refArray(o: object, name: string): unknown {
    const len = this.op.alen(o), elem = name.slice(1), host: unknown[] & { $t?: string } = new Array(len);
    this.live.set(o, host); this.owners.set(host, o);
    for (let i = 0; i < len; i++) host[i] = this.toHost(this.op.aget(o, i), elem);
    host.$t = elem;
    const seen = host.slice();
    this.undo.push(() => { for (let i = 0; i < len; i++) if (host[i] !== seen[i]) this.op.aset(o, i, this.toJava(host[i], elem)); });
    return host;
  }
  private fieldsOf(name: string): Map<string, FieldInfo> {
    let m = this.fields.get(name);
    if (!m) this.fields.set(name, m = new Map(this.w.prog.layout(name).map((f) => [mangleField(f.owner, f.name), f])));
    return m;
  }
  private accessor(op: "get" | "set", f: FieldInfo): Fn {
    return this.w.hostFn(`b:${op}:${f.owner}.${f.name}`, op === "get" ? ["L"] : ["L", f.kind], op === "get" ? f.kind : "V", (cx, c) => {
      const st = cx.structFor(f.owner), at = cx.fieldIndex(f.owner, f);
      c.lget(0).refCast(st);
      if (op === "get") c.structGet(st, at); else c.lget(1).structSet(st, at);
    });
  }
  private facade(o: object, name: string): object {
    const fields = this.fieldsOf(name), bridge = this;
    const proxy = new Proxy({}, {
      get(_t, p) {
        if (p === REF) return o;
        const f = typeof p === "string" ? fields.get(p) : undefined;
        if (!f) return undefined;
        const raw = bridge.accessor("get", f)(o);
        return f.kind === "L" ? bridge.toHost(raw, f.desc) : fromBits(raw, f.desc);
      },
      set(_t, p, v) {
        const f = typeof p === "string" ? fields.get(p) : undefined;
        if (!f) throw new Error(`${name} has no field behind ${String(p)}`);
        bridge.accessor("set", f)(o, f.kind === "L" ? bridge.toJava(v, f.desc) : toBits(v, f.desc));
        return true;
      },
    });
    this.facades.set(o, proxy); this.owners.set(proxy, o);
    return proxy;
  }

  // ---------- host to Java
  toJava(v: unknown, desc: string): unknown {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return v;
    const o = v as object, known = this.owners.get(o);
    if (known) return known;
    if (ArrayBuffer.isView(o)) return this.newPrimArray(o as ArrayBufferView & { length: number });
    if (Array.isArray(o)) return this.newRefArray(o as unknown[] & { $t?: string }, desc);
    const cls = this.src?.classOf?.(o);
    if (cls) return this.copyObject(o as Record<string, unknown>, cls);
    throw new Error(`a native returned a host value of no Java class where ${desc} was expected`);
  }
  private newArray(name: string): Fn {
    return this.w.hostFn("b:new:" + name, ["I"], "L", (cx, c) => cx.emitNewArray(c, name, () => c.lget(0)));
  }
  private newPrimArray(a: ArrayBufferView & { length: number }): object {
    const name = ARRAY_OF.find(([t]) => a instanceof t)![1], j = this.newArray(name)(a.length), bytes = a.byteLength, at = this.region(bytes);
    new Uint8Array(this.w.mem.buffer, at, bytes).set(new Uint8Array(a.buffer, a.byteOffset, bytes));
    this.op.acopy(j, at, 0);
    return j;
  }
  private newRefArray(a: unknown[] & { $t?: string }, desc: string): object {
    const elem = a.$t ?? (desc[0] === "[" ? desc.slice(1) : "Ljava/lang/Object;"), j = this.newArray("[" + elem)(a.length);
    a.forEach((e, i) => this.op.aset(j, i, this.toJava(e, elem)));
    return j;
  }
  /** an object the production runtime made, copied into the Wasm heap with its fields (not its identity) */
  private copyObject(o: Record<string, unknown>, cls: string): object {
    const j = this.w.hostFn("b:alloc:" + cls, [], "L", (cx, c) => { cx.emitEnsure(c, cls); cx.emitNew(c, cls); })();
    for (const f of this.fieldsOf(cls).values()) {
      const v = o[mangleField(f.owner, f.name)];
      if (v !== undefined) this.accessor("set", f)(j, f.kind === "L" ? this.toJava(v, f.desc) : toBits(v, f.desc));
    }
    return j;
  }
}
