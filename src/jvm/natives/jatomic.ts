import { rt, JObj, type NativeSpec, type ClassInfo, driven, type Gen } from "../runtime";
import { vcall } from "./jlang";
import { jarray } from "../abi";

// ── java.util.concurrent.atomic on one JS thread: every operation is already atomic. The scalar,
// array and field-updater forms share one operation table over their three kinds of cell.
type Methods = NonNullable<NativeSpec["methods"]>;
const A = "java/util/concurrent/atomic/", O = "Ljava/lang/Object;";
interface Kind {
  d: string;
  zero: unknown;
  wrap?: (v: any) => unknown;          // numeric kinds: the arithmetic ops
  one?: unknown;
  unary?: [string, string];            // [interface method, desc] of the update function
  binary?: [string, string];
}
const INT: Kind = { d: "I", zero: 0, wrap: (v) => v | 0, one: 1, unary: ["applyAsInt", "(I)I"], binary: ["applyAsInt", "(II)I"] };
const LONG: Kind = { d: "J", zero: 0n, wrap: (v) => BigInt.asIntN(64, v), one: 1n, unary: ["applyAsLong", "(J)J"], binary: ["applyAsLong", "(JJ)J"] };
const REF: Kind = { d: O, zero: null, unary: ["apply", `(${O})${O}`], binary: ["apply", `(${O}${O})${O}`] };
const BOOL: Kind = { d: "Z", zero: 0 };
type Cell = "scalar" | "array" | "field";
const oob = (i: number): never => { throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", "index " + i); };
/** one read-modify-write per cell kind; `fn` maps the current value and the argument to the new one */
function rmw(k: Kind, cell: Cell, fn: (cur: any, x: any) => unknown, old: boolean) {
  if (cell === "scalar") return function (this: { v: unknown }, x?: unknown) { const o = this.v, n = fn(o, x); this.v = n; return old ? o : n; };
  if (cell === "array") return function (this: { a: any }, i: number, x?: unknown) {
    const a = this.a;
    if (i >>> 0 >= a.length) oob(i);
    const o = a[i], n = fn(o, x); a[i] = n; return old ? o : n;
  };
  return function (this: { prop: string }, t: any, x?: unknown) {
    if (t == null) rt.npe();
    const o = t[this.prop] ?? k.zero, n = fn(o, x); t[this.prop] = n; return old ? o : n;
  };
}
/** a read-modify-write whose new value comes from a Java function object, which may suspend */
function rmwAsync(k: Kind, cell: Cell, call: (f: unknown, cur: unknown, x: unknown) => unknown, old: boolean, arg: boolean) {
  const read = cell === "scalar" ? (s: any) => s.v : cell === "array" ? (s: any, i: any) => (i >>> 0 < s.a.length ? s.a[i] : oob(i)) : (s: any, t: any) => (t ?? rt.npe())[s.prop] ?? k.zero;
  const write = cell === "scalar" ? (s: any, _: unknown, v: unknown) => { s.v = v; } : cell === "array" ? (s: any, i: any, v: unknown) => { s.a[i] = v; } : (s: any, t: any, v: unknown) => { t[s.prop] = v; };
  const body = driven(function* (self: unknown, at: unknown, x: unknown, f: unknown): Gen {
    const o = read(self, at), n = yield call(f, o, x);
    write(self, at, n);
    return old ? o : n;
  });
  if (cell === "scalar") return arg ? function (this: unknown, x: unknown, f: unknown) { return body(this, null, x, f); } : function (this: unknown, f: unknown) { return body(this, null, null, f); };
  return arg ? function (this: unknown, at: unknown, x: unknown, f: unknown) { return body(this, at, x, f); } : function (this: unknown, at: unknown, f: unknown) { return body(this, at, null, f); };
}
function atomicOps(k: Kind, cell: Cell): Methods {
  const pre = cell === "array" ? "I" : cell === "field" ? O : "", d = k.d, m: Methods = {};
  const def = (name: string, arg: string, ret: string, fn: (cur: any, x: any) => unknown, old: boolean) => { m[`${name}(${pre}${arg})${ret}`] = rmw(k, cell, fn, old); };
  // the field updaters have none of the Java 9 memory-order variants
  const orders = cell !== "field";
  for (const name of ["get", ...orders ? ["getPlain", "getOpaque", "getAcquire"] : []]) def(name, "", d, (c) => c, true);
  for (const name of ["set", "lazySet", ...orders ? ["setPlain", "setOpaque", "setRelease"] : []]) def(name, d, "V", (_, x) => x, true);
  def("getAndSet", d, d, (_, x) => x, true);
  const cas = (name: string) => {
    m[`${name}(${pre}${d}${d})Z`] = cell === "scalar"
      ? function (this: { v: unknown }, e: unknown, v: unknown) { if (this.v !== e) return 0; this.v = v; return 1; }
      : cell === "array"
        ? function (this: { a: any }, i: number, e: unknown, v: unknown) { if (i >>> 0 >= this.a.length) oob(i); if (this.a[i] !== e) return 0; this.a[i] = v; return 1; }
        : function (this: { prop: string }, t: any, e: unknown, v: unknown) { if (t == null) rt.npe(); if ((t[this.prop] ?? k.zero) !== e) return 0; t[this.prop] = v; return 1; };
  };
  for (const name of ["compareAndSet", "weakCompareAndSet", ...orders ? ["weakCompareAndSetPlain", "weakCompareAndSetVolatile", "weakCompareAndSetAcquire", "weakCompareAndSetRelease"] : []]) cas(name);
  if (k.wrap) {
    const w = k.wrap, one = k.one as any;
    def("incrementAndGet", "", d, (c) => w(c + one), false);
    def("decrementAndGet", "", d, (c) => w(c - one), false);
    def("getAndIncrement", "", d, (c) => w(c + one), true);
    def("getAndDecrement", "", d, (c) => w(c - one), true);
    def("addAndGet", d, d, (c, x) => w(c + x), false);
    def("getAndAdd", d, d, (c, x) => w(c + x), true);
  }
  if (k.unary) {
    const P = k === INT ? "Int" : k === LONG ? "Long" : "";
    const [um, ud] = k.unary, [bm, bd] = k.binary!;
    const unary = `Ljava/util/function/${P}UnaryOperator;`, binary = `Ljava/util/function/${P}BinaryOperator;`;
    const up = (f: unknown, c: unknown) => vcall(f, um, ud, c), acc = (f: unknown, c: unknown, x: unknown) => vcall(f, bm, bd, c, x);
    m[`getAndUpdate(${pre}${unary})${d}`] = rmwAsync(k, cell, up, true, false);
    m[`updateAndGet(${pre}${unary})${d}`] = rmwAsync(k, cell, up, false, false);
    m[`getAndAccumulate(${pre}${d}${binary})${d}`] = rmwAsync(k, cell, acc, true, true);
    m[`accumulateAndGet(${pre}${d}${binary})${d}`] = rmwAsync(k, cell, acc, false, true);
  }
  return m;
}
const numberMethods = (d: string): Methods => ({
  "intValue()I": function (this: { v: number | bigint }) { return typeof this.v === "bigint" ? Number(BigInt.asIntN(32, this.v)) : this.v; },
  "longValue()J": function (this: { v: number | bigint }) { return BigInt(this.v); },
  "floatValue()F": function (this: { v: number | bigint }) { return Math.fround(Number(this.v)); },
  "doubleValue()D": function (this: { v: number | bigint }) { return Number(this.v); },
  "toString()Ljava/lang/String;": function (this: { v: unknown }) { return String(this.v); },
  "<init>()V": function () {},
  [`<init>(${d})V`]: function (this: { v: unknown }, v: unknown) { this.v = v; },
});
const serial = (uid: bigint, name: string, desc: string, prop: string) => ({ uid, fields: [{ name, desc, prop }] });
class JAtomicInt extends JObj { v = 0; }
class JAtomicLong extends JObj { v = 0n; }
class JAtomicBool extends JObj { v = 0; }
class JAtomicRef extends JObj { v: unknown = null; }
rt.register({
  name: A + "AtomicInteger", ctor: JAtomicInt, sup: "java/lang/Number", ifaces: ["java/io/Serializable"],
  serialization: serial(6214790243416807050n, "value", "I", "v"), methods: { ...atomicOps(INT, "scalar"), ...numberMethods("I") },
});
rt.register({
  name: A + "AtomicLong", ctor: JAtomicLong, sup: "java/lang/Number", ifaces: ["java/io/Serializable"],
  serialization: serial(1927816293512124184n, "value", "J", "v"), methods: { ...atomicOps(LONG, "scalar"), ...numberMethods("J") },
});
rt.register({
  name: A + "AtomicBoolean", ctor: JAtomicBool, ifaces: ["java/io/Serializable"],
  serialization: serial(4654671469794556979n, "value", "I", "v"),
  methods: {
    ...atomicOps(BOOL, "scalar"),
    "<init>()V": function () {},
    "<init>(Z)V": function (this: JAtomicBool, v: number) { this.v = v; },
    "toString()Ljava/lang/String;": function (this: JAtomicBool) { return this.v ? "true" : "false"; },
  },
});
rt.register({
  name: A + "AtomicReference", ctor: JAtomicRef, ifaces: ["java/io/Serializable"],
  serialization: serial(-1848883965231344442n, "value", O, "v"),
  methods: {
    ...atomicOps(REF, "scalar"),
    "<init>()V": function () {},
    [`<init>(${O})V`]: function (this: JAtomicRef, v: unknown) { this.v = v; },
    "toString()Ljava/lang/String;": function (this: JAtomicRef) { return this.v == null ? "null" : vcall(this.v, "toString", "()Ljava/lang/String;"); },
  },
});

class JAtomicArray extends JObj { a: any = []; }
const ARRAYS: [string, Kind, string, (n: number) => ArrayLike<unknown>, bigint][] = [
  ["AtomicIntegerArray", INT, "[I", (n) => new Int32Array(n), 2862133569453604235n],
  ["AtomicLongArray", LONG, "[J", (n) => new BigInt64Array(n), -2308431214976778248n],
  ["AtomicReferenceArray", REF, "[Ljava/lang/Object;", (n) => jarray(new Array(n).fill(null)), -6209656149925076980n],
];
for (const [name, k, desc, make, uid] of ARRAYS) {
  rt.register({
    name: A + name, ctor: class extends JAtomicArray {}, ifaces: ["java/io/Serializable"],
    serialization: serial(uid, "array", desc, "a"),
    methods: {
      ...atomicOps(k, "array"),
      "<init>(I)V": function (this: JAtomicArray, n: number) {
        if (n < 0) throw rt.mkThrowable("java/lang/NegativeArraySizeException", String(n));
        this.a = make(n);
      },
      [`<init>(${desc})V`]: function (this: JAtomicArray, src: ArrayLike<unknown> | null) {
        if (src == null) rt.npe();
        this.a = (src as unknown as { slice(): unknown }).slice();
      },
      "length()I": function (this: JAtomicArray) { return this.a.length; },
      "toString()Ljava/lang/String;": function (this: JAtomicArray) {
        return k === REF ? vcall(rt.link("java/util/Arrays").ctor, "toString", `([${O})Ljava/lang/String;`, this.a) : `[${Array.from(this.a).join(", ")}]`;
      },
    },
  });
}

class JAtomicMarkable extends JObj { v: unknown = null; mark = 0; }
rt.register({
  name: A + "AtomicMarkableReference", ctor: JAtomicMarkable,
  methods: {
    [`<init>(${O}Z)V`]: function (this: JAtomicMarkable, v: unknown, m: number) { this.v = v; this.mark = m; },
    [`getReference()${O}`]: function (this: JAtomicMarkable) { return this.v; },
    "isMarked()Z": function (this: JAtomicMarkable) { return this.mark; },
    [`get([Z)${O}`]: function (this: JAtomicMarkable, out: Uint8Array) { out[0] = this.mark; return this.v; },
    [`set(${O}Z)V`]: function (this: JAtomicMarkable, v: unknown, m: number) { this.v = v; this.mark = m; },
    [`compareAndSet(${O}${O}ZZ)Z`]: function (this: JAtomicMarkable, e: unknown, v: unknown, em: number, m: number) {
      if (this.v !== e || this.mark !== em) return 0;
      this.v = v; this.mark = m; return 1;
    },
    [`attemptMark(${O}Z)Z`]: function (this: JAtomicMarkable, e: unknown, m: number) { if (this.v !== e) return 0; this.mark = m; return 1; },
  },
});

// ── Atomic*FieldUpdater: operate on the mangled property resolved from the class
function fieldProp(cls: { ci?: ClassInfo | null } | null, name: string): string {
  for (let ci = cls?.ci; ci; ci = ci.superInfo) {
    const p = ci.fieldTable.get(name);
    if (p) return p;
  }
  return name;
}
class JFieldUpdater extends JObj { prop = ""; }
const UPDATERS: [string, Kind, string][] = [
  ["AtomicIntegerFieldUpdater", INT, "(Ljava/lang/Class;Ljava/lang/String;)"],
  ["AtomicLongFieldUpdater", LONG, "(Ljava/lang/Class;Ljava/lang/String;)"],
  ["AtomicReferenceFieldUpdater", REF, "(Ljava/lang/Class;Ljava/lang/Class;Ljava/lang/String;)"],
];
for (const [name, k, args] of UPDATERS) {
  rt.register({
    name: A + name, ctor: class extends JFieldUpdater {},
    methods: {
      ...atomicOps(k, "field"),
      [`static newUpdater${args}L${A}${name};`]: (cls: { ci?: ClassInfo | null } | null, ...rest: unknown[]) => {
        const u = rt.make(A + name) as JFieldUpdater;
        u.prop = fieldProp(cls, rest[rest.length - 1] as string);
        return u;
      },
    },
  });
}
// libcore's AtomicLong asks whether the VM compares-and-sets 8 bytes without a lock; JS does
rt.registerJni("java/util/concurrent/atomic/AtomicLong", "VMSupportsCS8()Z", () => 1);
