import { JObj, rt, driven, type Gen, type NativeSpec } from "../runtime";
import { mkIter, newArrayList, toJsArray, sortInPlace, newLinkedHashSet } from "./jutil";
import { vcall, after, box, boxInt, JLong, JDouble } from "./jlang";
import { jarray } from "../abi";
import { JStream, JIntStream, JLongStream, JDoubleStream, mkStream, mkIntStream, mkLongStream, mkDoubleStream } from "./jstream-values";

type Methods = NonNullable<NativeSpec["methods"]>;
type Fn = (...a: any[]) => unknown;
const O = "Ljava/lang/Object;", F = "java/util/function/", S = "java/util/stream/";

// ── java.util.function: [interface, single abstract method, super-interface]
const PRIMS = [["Int", "I"], ["Long", "J"], ["Double", "D"]] as const;
const FUNCTIONS: [string, string, string?][] = [
  ["Supplier", `get()${O}`], ["Function", `apply(${O})${O}`], ["BiFunction", `apply(${O}${O})${O}`],
  ["UnaryOperator", `apply(${O})${O}`, "Function"], ["BinaryOperator", `apply(${O}${O})${O}`, "BiFunction"],
  ["Consumer", `accept(${O})V`], ["BiConsumer", `accept(${O}${O})V`], ["Predicate", `test(${O})Z`], ["BiPredicate", `test(${O}${O})Z`],
  ["BooleanSupplier", "getAsBoolean()Z"],
  ...PRIMS.flatMap(([P, d]): [string, string][] => [
    [`${P}Supplier`, `getAs${P}()${d}`], [`${P}Function`, `apply(${d})${O}`], [`${P}Predicate`, `test(${d})Z`], [`${P}Consumer`, `accept(${d})V`],
    [`${P}UnaryOperator`, `applyAs${P}(${d})${d}`], [`${P}BinaryOperator`, `applyAs${P}(${d}${d})${d}`],
    [`To${P}Function`, `applyAs${P}(${O})${d}`], [`To${P}BiFunction`, `applyAs${P}(${O}${O})${d}`], [`Obj${P}Consumer`, `accept(${O}${d})V`],
    ...PRIMS.filter(([Q]) => Q !== P).map(([Q, e]): [string, string] => [`${P}To${Q}Function`, `applyAs${Q}(${d})${e}`]),
  ]),
];
const SAM = new Map(FUNCTIONS.map(([n, sig]) => { const p = sig.indexOf("("); return [n, [sig.slice(0, p), sig.slice(p)] as const]; }));
/** call a functional object's single abstract method */
function invoke(iface: string, f: unknown, ...a: unknown[]): any {
  if (f == null) rt.npe();
  const [m, d] = SAM.get(iface)!;
  return vcall(f, m, d, ...a);
}
class JLambda extends JObj { declare f: Fn; }
const lambdas = new Map<string, new () => JLambda>();
/** a host function handed to Java as an instance of the functional interface */
export function lambda(iface: string, f: Fn): JLambda {
  rt.link("webdroid/fn/" + iface);
  const l = new (lambdas.get(iface)!)();
  l.f = f;
  return l;
}
const fnDesc = (iface: string) => `L${F}${iface};`;
const compareWith = (c: unknown, a: unknown, b: unknown): number | Promise<number> => vcall(c, "compare", `(${O}${O})I`, a, b);
// the interfaces and their default methods are libcore's; these are the host lambdas handed to Java
for (const [name, sig] of FUNCTIONS) {
  const C = class extends JLambda {};
  lambdas.set(name, C);
  rt.register({ name: "webdroid/fn/" + name, ctor: C, ifaces: [F + name], methods: { [sig]: function (this: JLambda, ...a: unknown[]) { return this.f(...a); } } });
}

// ── Optional and its primitive forms
class JOptional extends JObj { v: unknown = null; }
const mkOpt = (v: unknown) => { rt.link("java/util/Optional"); const o = new JOptional(); o.v = v ?? null; return o; };
const noValue = (): never => { throw rt.mkThrowable("java/util/NoSuchElementException", "No value present"); };
class JPrimOptional extends JObj { present = false; v: number | bigint = 0; }
const optCtors = new Map<string, new () => JPrimOptional>();
const mkOptOf = (P: string, v?: number | bigint) => {
  rt.link(`java/util/Optional${P}`);
  const o = new (optCtors.get(P)!)();
  if (v !== undefined) { o.present = true; o.v = v; }
  return o;
};
for (const [P, d] of PRIMS) {
  const self = `Ljava/util/Optional${P};`, C = class extends JPrimOptional {};
  optCtors.set(P, C);
  rt.register({
    name: `java/util/Optional${P}`, ctor: C,
    methods: {
      [`static empty()${self}`]: () => mkOptOf(P),
      [`static of(${d})${self}`]: (v: number | bigint) => mkOptOf(P, v),
      "isPresent()Z": function (this: JPrimOptional) { return +this.present; },
      "isEmpty()Z": function (this: JPrimOptional) { return +!this.present; },
      [`getAs${P}()${d}`]: function (this: JPrimOptional) { return this.present ? this.v : noValue(); },
      [`orElseThrow()${d}`]: function (this: JPrimOptional) { return this.present ? this.v : noValue(); },
      [`orElse(${d})${d}`]: function (this: JPrimOptional, other: number | bigint) { return this.present ? this.v : other; },
      [`orElseGet(${fnDesc(P + "Supplier")})${d}`]: function (this: JPrimOptional, s: unknown) { return this.present ? this.v : invoke(P + "Supplier", s); },
      [`orElseThrow(${fnDesc("Supplier")})${d}`]: driven(function* (this: JPrimOptional, s: unknown): Gen {
        if (this.present) return this.v;
        throw yield invoke("Supplier", s);
      }),
      [`ifPresent(${fnDesc(P + "Consumer")})V`]: function (this: JPrimOptional, c: unknown) { return this.present ? invoke(P + "Consumer", c, this.v) : undefined; },
      [`ifPresentOrElse(${fnDesc(P + "Consumer")}Ljava/lang/Runnable;)V`]: function (this: JPrimOptional, c: unknown, r: unknown) {
        return this.present ? invoke(P + "Consumer", c, this.v) : vcall(r, "run", "()V");
      },
      "equals(Ljava/lang/Object;)Z": function (this: JPrimOptional, o: unknown) {
        return +(o instanceof C && o.present === this.present && (!this.present || Object.is(o.v, this.v)));
      },
      "hashCode()I": function (this: JPrimOptional) { return this.present ? Number(BigInt.asIntN(32, BigInt(Math.trunc(Number(this.v))))) : 0; },
      "toString()Ljava/lang/String;": function (this: JPrimOptional) { return this.present ? `Optional${P}[${this.v}]` : `Optional${P}.empty`; },
    },
  });
}
rt.register({
  name: "java/util/Optional", ctor: JOptional,
  methods: {
    "static of(Ljava/lang/Object;)Ljava/util/Optional;": (v: unknown) => mkOpt(v ?? rt.npe()),
    "static ofNullable(Ljava/lang/Object;)Ljava/util/Optional;": (v: unknown) => mkOpt(v),
    "static empty()Ljava/util/Optional;": () => mkOpt(null),
    "isPresent()Z": function (this: JOptional) { return this.v === null ? 0 : 1; },
    "isEmpty()Z": function (this: JOptional) { return this.v === null ? 1 : 0; },
    "get()Ljava/lang/Object;": function (this: JOptional) { return this.v ?? noValue(); },
    "orElseThrow()Ljava/lang/Object;": function (this: JOptional) { return this.v ?? noValue(); },
    "orElse(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JOptional, d: unknown) { return this.v ?? d; },
    "orElseGet(Ljava/util/function/Supplier;)Ljava/lang/Object;": function (this: JOptional, s: unknown) { return this.v ?? invoke("Supplier", s); },
    "orElseThrow(Ljava/util/function/Supplier;)Ljava/lang/Object;": driven(function* (this: JOptional, s: unknown): Gen {
      if (this.v === null) throw yield invoke("Supplier", s);
      return this.v;
    }),
    "or(Ljava/util/function/Supplier;)Ljava/util/Optional;": function (this: JOptional, s: unknown) { return this.v === null ? invoke("Supplier", s) : this; },
    "filter(Ljava/util/function/Predicate;)Ljava/util/Optional;": driven(function* (this: JOptional, p: unknown): Gen {
      return this.v === null || (yield invoke("Predicate", p, this.v)) ? this : mkOpt(null);
    }),
    "map(Ljava/util/function/Function;)Ljava/util/Optional;": function (this: JOptional, f: unknown) {
      return this.v === null ? this : after(invoke("Function", f, this.v), mkOpt);
    },
    "flatMap(Ljava/util/function/Function;)Ljava/util/Optional;": function (this: JOptional, f: unknown) {
      return this.v === null ? this : after(invoke("Function", f, this.v), (o) => o ?? rt.npe());
    },
    "stream()Ljava/util/stream/Stream;": function (this: JOptional) { return mkStream(this.v === null ? [] : [this.v]); },
    "ifPresent(Ljava/util/function/Consumer;)V": function (this: JOptional, c: unknown) {
      return this.v === null ? undefined : invoke("Consumer", c, this.v);
    },
    "ifPresentOrElse(Ljava/util/function/Consumer;Ljava/lang/Runnable;)V": function (this: JOptional, c: unknown, r: unknown) {
      return this.v === null ? vcall(r, "run", "()V") : invoke("Consumer", c, this.v);
    },
    "equals(Ljava/lang/Object;)Z": driven(function* (this: JOptional, o: unknown): Gen {
      return o instanceof JOptional && (o.v === this.v || o.v !== null && this.v !== null && !!(yield vcall(this.v, "equals", `(${O})Z`, o.v))) ? 1 : 0;
    }),
    "hashCode()I": function (this: JOptional) { return this.v === null ? 0 : vcall(this.v, "hashCode", "()I"); },
    "toString()Ljava/lang/String;": function (this: JOptional) {
      return this.v === null ? "Optional.empty" : after(vcall(this.v, "toString", "()Ljava/lang/String;"), (s) => `Optional[${s}]`);
    },
  },
});

// ── summary statistics
class JStats extends JObj { count = 0; sum: number | bigint = 0; min: number | bigint = Infinity; max: number | bigint = -Infinity; }
const statsCtors = new Map<string, new () => JStats>();
function mkStats(P: string, values: (number | bigint)[]): JStats {
  rt.link(`java/util/${P}SummaryStatistics`);
  const s = new (statsCtors.get(P)!)();
  if (P === "Long") { s.sum = 0n; s.min = BigInt("9223372036854775807"); s.max = -BigInt("9223372036854775808"); }
  else if (P === "Int") { s.min = 2147483647; s.max = -2147483648; }
  for (const v of values) statsAccept(s, v);
  return s;
}
function statsAccept(s: JStats, v: number | bigint): void {
  s.count++;
  s.sum = typeof v === "bigint" ? BigInt.asIntN(64, (s.sum as bigint) + v) : (s.sum as number) + v;
  if (v < s.min) s.min = v;
  if (v > s.max) s.max = v;
}
for (const [P, d] of PRIMS) {
  const C = class extends JStats {};
  statsCtors.set(P, C);
  const sumDesc = P === "Double" ? "D" : "J";
  rt.register({
    name: `java/util/${P}SummaryStatistics`, ctor: C, ifaces: [F + P + "Consumer"],
    methods: {
      "<init>()V": function (this: JStats) { Object.assign(this, mkStats(P, [])); },
      [`accept(${d})V`]: function (this: JStats, v: number | bigint) { statsAccept(this, v); },
      ...(P === "Long" ? { "accept(I)V": function (this: JStats, v: number) { statsAccept(this, BigInt(v)); } } : {}),
      [`combine(Ljava/util/${P}SummaryStatistics;)V`]: function (this: JStats, o: JStats) {
        this.count += o.count;
        this.sum = typeof o.sum === "bigint" ? BigInt.asIntN(64, (this.sum as bigint) + o.sum) : (this.sum as number) + o.sum;
        if (o.min < this.min) this.min = o.min;
        if (o.max > this.max) this.max = o.max;
      },
      "getCount()J": function (this: JStats) { return BigInt(this.count); },
      [`getSum()${sumDesc}`]: function (this: JStats) { return P === "Int" ? BigInt(this.sum) : this.sum; },
      [`getMin()${d}`]: function (this: JStats) { return this.min; },
      [`getMax()${d}`]: function (this: JStats) { return this.max; },
      "getAverage()D": function (this: JStats) { return this.count ? Number(this.sum) / this.count : 0; },
      "toString()Ljava/lang/String;": function (this: JStats) {
        const avg = this.count ? Number(this.sum) / this.count : 0;
        return `${P}SummaryStatistics{count=${this.count}, sum=${this.sum}, min=${this.min}, average=${avg.toFixed(6)}, max=${this.max}}`;
      },
    },
  });
}

// ── java.util.stream, the sequential subset. Every stage runs eagerly over a JS array: a lambda
// here is an async compiled method on one thread, so laziness would buy nothing and cost the
// whole Spliterator machinery. Stream sources arrive as an already-drained array; infinite
// sources (generate, two-argument iterate) are not offered.
class JSpliterator extends JObj { a: unknown[] = []; }
class JPrimIterator extends JObj { a: unknown[] = []; i = 0; box: (v: any) => unknown = (v) => v; }
interface StreamKind {
  P: "" | "Int" | "Long" | "Double";
  d: string;
  mk(a: unknown[]): JObj & { a: unknown[] };
  box(v: unknown): unknown;
  norm(v: any): unknown;
}
const OBJ_KIND: StreamKind = { P: "", d: O, mk: mkStream as StreamKind["mk"], box: (v) => v, norm: (v) => v };
const KINDS: StreamKind[] = [
  OBJ_KIND,
  { P: "Int", d: "I", mk: mkIntStream as StreamKind["mk"], box: (v) => boxInt(v as number), norm: (v) => v | 0 },
  { P: "Long", d: "J", mk: mkLongStream as StreamKind["mk"], box: (v) => box(JLong, v as bigint), norm: (v) => BigInt.asIntN(64, BigInt(v)) },
  { P: "Double", d: "D", mk: mkDoubleStream as StreamKind["mk"], box: (v) => box(JDouble, v as number), norm: (v) => +v },
];
const kindOf = (P: string) => KINDS.find((k) => k.P === P)!;
const streamDesc = (k: StreamKind) => `L${S}${k.P}Stream;`;
type Stage = JObj & { a: unknown[] };
/** a stage that feeds each element to a callback, possibly suspending, which fills the next stage */
const mapInto = driven(function* mapInto(k: StreamKind, a: unknown[], run: (x: any, out: unknown[]) => unknown): Gen {
  const out: unknown[] = [];
  for (const x of a) yield run(x, out);
  return k.mk(out);
});
/** the elements up to (takeWhile) or from (dropWhile) the first that fails the predicate */
const whileStage = (k: StreamKind, pred: string, take: boolean) => driven(function* (this: Stage, p: unknown): Gen {
  let i = 0;
  while (i < this.a.length && (yield invoke(pred, p, this.a[i]))) i++;
  return k.mk(take ? this.a.slice(0, i) : this.a.slice(i));
});
function sumOf(k: StreamKind, a: unknown[]): unknown {
  if (k.P === "Long") return (a as bigint[]).reduce((s, v) => BigInt.asIntN(64, s + v), 0n);
  if (k.P === "Int") return (a as number[]).reduce((s, v) => (s + v) | 0, 0);
  // DoubleStream.sum compensates (Kahan) as Collectors.summingDouble does
  let sum = 0, c = 0;
  for (const v of a as number[]) { const y = v - c, t = sum + y; c = t - sum - y; sum = t; }
  return sum;
}
function streamMethods(k: StreamKind): Methods {
  const self = streamDesc(k), P = k.P, d = k.d, prim = P !== "";
  const pred = P + "Predicate", cons = P + "Consumer", binop = P + "BinaryOperator";
  const opt = `Ljava/util/Optional${P};`, mkOptional = (v?: unknown) => (prim ? mkOptOf(P, v as number | bigint) : mkOpt(v));
  // sequential and eager: the ordered and unordered forms are one operation
  const forEach = driven(function* (this: Stage, c: unknown): Gen { for (const x of this.a) yield invoke(cons, c, x); });
  const first = function (this: Stage) { return this.a.length ? mkOptional(this.a[0] ?? rt.npe()) : mkOptional(); };
  const m: Methods = {
    [`static empty()${self}`]: () => k.mk([]),
    [`static of(${d})${self}`]: (v: unknown) => k.mk([v]),
    [`static of([${d})${self}`]: (vs: ArrayLike<unknown>) => k.mk(Array.from(vs ?? rt.npe())),
    [`static concat(${self}${self})${self}`]: (a: Stage, b: Stage) => k.mk([...a.a, ...b.a]),
    [`static iterate(${d}${fnDesc(pred)}${fnDesc(prim ? P + "UnaryOperator" : "UnaryOperator")})${self}`]: driven(function* (seed: unknown, has: unknown, next: unknown): Gen {
      const out: unknown[] = [];
      for (let v = seed; yield invoke(pred, has, v); v = yield invoke(prim ? P + "UnaryOperator" : "UnaryOperator", next, v)) out.push(v);
      return k.mk(out);
    }),
    [`filter(${fnDesc(pred)})${self}`]: function (this: Stage, p: unknown) {
      return mapInto(k, this.a, (x, out) => after(invoke(pred, p, x), (r) => { if (r) out.push(x); }));
    },
    [`map(${fnDesc(prim ? P + "UnaryOperator" : "Function")})${self}`]: function (this: Stage, f: unknown) {
      return mapInto(k, this.a, (x, out) => after(invoke(prim ? P + "UnaryOperator" : "Function", f, x), (y) => { out.push(k.norm(y)); }));
    },
    [`flatMap(${fnDesc(prim ? P + "Function" : "Function")})${self}`]: function (this: Stage, f: unknown) {
      return mapInto(k, this.a, (x, out) => after(invoke(prim ? P + "Function" : "Function", f, x), (s: Stage | null) => { if (s) out.push(...s.a); }));
    },
    [`peek(${fnDesc(cons)})${self}`]: function (this: Stage, c: unknown) {
      return mapInto(k, this.a, (x, out) => after(invoke(cons, c, x), () => { out.push(x); }));
    },
    [`distinct()${self}`]: function (this: Stage) {
      return prim ? k.mk([...new Set(this.a)]) : after(newLinkedHashSet(this.a), (set) => after(toJsArray(set), (a) => k.mk(a.slice())));
    },
    [`sorted()${self}`]: function (this: Stage) {
      const out = this.a.slice();
      if (prim) { out.sort((a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0)); return k.mk(out); }
      return after(sortInPlace(out, null), () => k.mk(out));
    },
    [`limit(J)${self}`]: function (this: Stage, n: bigint) {
      if (n < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", String(n));
      return k.mk(this.a.slice(0, Number(n)));
    },
    [`skip(J)${self}`]: function (this: Stage, n: bigint) {
      if (n < 0n) throw rt.mkThrowable("java/lang/IllegalArgumentException", String(n));
      return k.mk(this.a.slice(Number(n)));
    },
    [`takeWhile(${fnDesc(pred)})${self}`]: whileStage(k, pred, true),
    [`dropWhile(${fnDesc(pred)})${self}`]: whileStage(k, pred, false),
    [`forEach(${fnDesc(cons)})V`]: forEach,
    [`forEachOrdered(${fnDesc(cons)})V`]: forEach,
    [`reduce(${d}${fnDesc(binop)})${d}`]: driven(function* (this: Stage, identity: unknown, op: unknown): Gen {
      let acc = identity;
      for (const x of this.a) acc = yield invoke(binop, op, acc, x);
      return acc;
    }),
    [`reduce(${fnDesc(binop)})${opt}`]: driven(function* (this: Stage, op: unknown): Gen {
      if (!this.a.length) return mkOptional();
      let acc = this.a[0];
      for (let i = 1; i < this.a.length; i++) acc = yield invoke(binop, op, acc, this.a[i]);
      return mkOptional(acc ?? rt.npe());
    }),
    [`collect(${fnDesc("Supplier")}${fnDesc(prim ? `Obj${P}Consumer` : "BiConsumer")}${fnDesc("BiConsumer")})${O}`]: driven(function* (this: Stage, s: unknown, acc: unknown): Gen {
      const r = yield invoke("Supplier", s);
      for (const x of this.a) yield invoke(prim ? `Obj${P}Consumer` : "BiConsumer", acc, r, x);
      return r;
    }),
    "count()J": function (this: Stage) { return BigInt(this.a.length); },
    [`anyMatch(${fnDesc(pred)})Z`]: driven(function* (this: Stage, p: unknown): Gen {
      for (const x of this.a) if (yield invoke(pred, p, x)) return 1;
      return 0;
    }),
    [`allMatch(${fnDesc(pred)})Z`]: driven(function* (this: Stage, p: unknown): Gen {
      for (const x of this.a) if (!(yield invoke(pred, p, x))) return 0;
      return 1;
    }),
    [`noneMatch(${fnDesc(pred)})Z`]: driven(function* (this: Stage, p: unknown): Gen {
      for (const x of this.a) if (yield invoke(pred, p, x)) return 0;
      return 1;
    }),
    [`findFirst()${opt}`]: first,
    [`findAny()${opt}`]: first,
    "isParallel()Z": () => 0,
    "close()V": () => {},
  };
  const iterator = prim ? `Ljava/util/PrimitiveIterator$Of${P};` : "Ljava/util/Iterator;";
  const iterate = function (this: Stage) {
    if (!prim) return mkIter(this.a);
    rt.link(`java/util/PrimitiveIterator$Of${P}`);
    return Object.assign(new (primIterators.get(P)!)(), { a: this.a, box: k.box });
  };
  m[`iterator()${iterator}`] = iterate;
  m["iterator()Ljava/util/Iterator;"] = iterate;
  // BaseStream's erased signature answers too, as a bridge would
  m[`spliterator()Ljava/util/Spliterator${prim ? "$Of" + P : ""};`] = m["spliterator()Ljava/util/Spliterator;"] = function (this: Stage) {
    rt.link(`java/util/Spliterator${prim ? "$Of" + P : ""}`);
    return Object.assign(new (spliterators.get(P)!)(), { a: this.a.slice() });
  };
  const same = function (this: Stage) { return this; };
  // only the primitive streams redeclare parallel() and sequential() with their own type
  for (const name of ["parallel", "sequential", "unordered"]) m[`${name}()L${S}BaseStream;`] = same;
  if (prim) m[`parallel()${self}`] = m[`sequential()${self}`] = same;
  m[`onClose(Ljava/lang/Runnable;)L${S}BaseStream;`] = same;
  // conversions into the other element kinds
  for (const t of KINDS) {
    if (t === k || !t.P) continue;
    const via = prim ? `${P}To${t.P}Function` : `To${t.P}Function`;
    m[`mapTo${t.P}(${fnDesc(via)})${streamDesc(t)}`] = function (this: Stage, f: unknown) {
      return mapInto(t, this.a, (x, out) => after(invoke(via, f, x), (y) => { out.push(t.norm(y)); }));
    };
    if (!prim) m[`flatMapTo${t.P}(${fnDesc("Function")})${streamDesc(t)}`] = function (this: Stage, f: unknown) {
      return mapInto(t, this.a, (x, out) => after(invoke("Function", f, x), (s: Stage | null) => { if (s) out.push(...s.a); }));
    };
  }
  if (!prim) return m;
  const toObj = P + "Function";
  Object.assign(m, {
    [`mapToObj(${fnDesc(toObj)})L${S}Stream;`]: function (this: Stage, f: unknown) {
      return mapInto(OBJ_KIND, this.a, (x, out) => after(invoke(toObj, f, x), (y) => { out.push(y); }));
    },
    [`boxed()L${S}Stream;`]: function (this: Stage) { return mkStream(this.a.map(k.box)); },
    [`toArray()[${d}`]: function (this: Stage) { return P === "Int" ? Int32Array.from(this.a as number[]) : P === "Long" ? BigInt64Array.from(this.a as bigint[]) : Float64Array.from(this.a as number[]); },
    [`sum()${d}`]: function (this: Stage) { return sumOf(k, this.a); },
    [`min()${opt}`]: function (this: Stage) { return this.a.length ? mkOptional(this.a.reduce((a: any, b: any) => (P === "Double" ? Math.min(a, b) : b < a ? b : a))) : mkOptional(); },
    [`max()${opt}`]: function (this: Stage) { return this.a.length ? mkOptional(this.a.reduce((a: any, b: any) => (P === "Double" ? Math.max(a, b) : b > a ? b : a))) : mkOptional(); },
    "average()Ljava/util/OptionalDouble;": function (this: Stage) {
      return this.a.length ? mkOptOf("Double", Number(sumOf(P === "Long" ? k : kindOf("Double"), this.a)) / this.a.length) : mkOptOf("Double");
    },
    [`summaryStatistics()Ljava/util/${P}SummaryStatistics;`]: function (this: Stage) { return mkStats(P, this.a as (number | bigint)[]); },
  });
  if (P !== "Double") {
    const step = (v: number | bigint) => (P === "Long" ? BigInt.asIntN(64, (v as bigint) + 1n) : (v as number) + 1);
    const range = (closed: boolean) => (a: number | bigint, b: number | bigint) => {
      const out: (number | bigint)[] = [];
      for (let v = a; closed ? v <= b : v < b; v = step(v)) out.push(v);
      return k.mk(out);
    };
    m[`static range(${d}${d})${self}`] = range(false);
    m[`static rangeClosed(${d}${d})${self}`] = range(true);
    m[`asDoubleStream()L${S}DoubleStream;`] = function (this: Stage) { return mkDoubleStream(this.a.map(Number)); };
  }
  if (P === "Int") m[`asLongStream()L${S}LongStream;`] = function (this: Stage) { return mkLongStream((this.a as number[]).map(BigInt)); };
  return m;
}
const spliterators = new Map<string, new () => JSpliterator>([["", JSpliterator]]);
const primIterators = new Map<string, new () => JPrimIterator>();
rt.register({ name: "java/util/Spliterator", ctor: JSpliterator });
rt.register({ name: "java/util/PrimitiveIterator", ctor: class extends JObj {}, ifaces: ["java/util/Iterator"] });
for (const [P, d] of PRIMS) {
  const Sp = class extends JSpliterator {}, It = class extends JPrimIterator {};
  spliterators.set(P, Sp);
  primIterators.set(P, It);
  rt.register({ name: `java/util/Spliterator$Of${P}`, ctor: Sp, ifaces: ["java/util/Spliterator"] });
  const nextValue = function (this: JPrimIterator) {
    if (this.i >= this.a.length) throw rt.mkThrowable("java/util/NoSuchElementException", null);
    return this.a[this.i++];
  };
  rt.register({
    name: `java/util/PrimitiveIterator$Of${P}`, ctor: It, ifaces: ["java/util/PrimitiveIterator"],
    methods: {
      "hasNext()Z": function (this: JPrimIterator) { return +(this.i < this.a.length); },
      [`next${P}()${d}`]: nextValue,
      [`next()${O}`]: function (this: JPrimIterator) { return this.box(nextValue.call(this)); },
      [`forEachRemaining(${fnDesc(P + "Consumer")})V`]: driven(function* (this: JPrimIterator, c: unknown): Gen {
        while (this.i < this.a.length) yield invoke(P + "Consumer", c, this.a[this.i++]);
      }),
    },
  });
}
rt.register({ name: S + "BaseStream", ctor: class extends JObj {}, ifaces: ["java/lang/AutoCloseable"] });
const streamCtors = [JStream, JIntStream, JLongStream, JDoubleStream];
KINDS.forEach((k, i) => { if (k.P) rt.register({ name: `${S}${k.P}Stream`, ctor: streamCtors[i], ifaces: [S + "BaseStream"], methods: streamMethods(k) }); });

async function collect(stream: JStream, c: unknown): Promise<unknown> {
  const supplier = await vcall(c, "supplier", `()${fnDesc("Supplier")}`);
  const accumulator = await vcall(c, "accumulator", `()${fnDesc("BiConsumer")}`);
  const finisher = await vcall(c, "finisher", `()${fnDesc("Function")}`);
  const box = await invoke("Supplier", supplier);
  for (const value of stream.a) await invoke("BiConsumer", accumulator, box, value);
  return invoke("Function", finisher, box);
}
/** min (sign -1) or max (sign 1) by a comparator; the first of equal elements wins */
const extremeBy = (sign: number) => driven(function* (this: JStream, c: unknown): Gen {
  let best = this.a[0];
  for (let i = 1; i < this.a.length; i++) if ((yield compareWith(c, this.a[i], best)) * sign > 0) best = this.a[i];
  return mkOpt(this.a.length ? best ?? rt.npe() : null);
});
rt.register({
  name: S + "Stream", ctor: JStream, ifaces: [S + "BaseStream"],
  methods: {
    ...streamMethods(OBJ_KIND),
    [`static ofNullable(${O})L${S}Stream;`]: (v: unknown) => mkStream(v == null ? [] : [v]),
    [`sorted(Ljava/util/Comparator;)L${S}Stream;`]: function (this: JStream, cmp: unknown) {
      const out = this.a.slice();
      return after(sortInPlace(out, cmp), () => mkStream(out));
    },
    [`min(Ljava/util/Comparator;)Ljava/util/Optional;`]: extremeBy(-1),
    [`max(Ljava/util/Comparator;)Ljava/util/Optional;`]: extremeBy(1),
    [`reduce(${O}${fnDesc("BiFunction")}${fnDesc("BinaryOperator")})${O}`]: driven(function* (this: JStream, identity: unknown, acc: unknown): Gen {
      let r = identity;
      for (const x of this.a) r = yield invoke("BiFunction", acc, r, x);
      return r;
    }),
    "toList()Ljava/util/List;": function (this: JStream) { return newArrayList(this.a.slice()); },
    [`toArray()[${O}`]: function (this: JStream) { return jarray(this.a.slice()); },
    [`toArray(${fnDesc("IntFunction")})[${O}`]: driven(function* (this: JStream, generator: unknown): Gen {
      const out = (yield invoke("IntFunction", generator, this.a.length)) as unknown[];
      if (!Array.isArray(out) || out.length < this.a.length) throw rt.mkThrowable("java/lang/IllegalStateException", "Invalid stream array generator");
      for (let i = 0; i < this.a.length; i++) out[i] = this.a[i];
      return out;
    }),
    [`collect(L${S}Collector;)${O}`]: function (this: JStream, c: unknown) { return collect(this, c); },
  },
});
rt.register({
  name: "java/util/Spliterators", ctor: class extends JObj {},
  methods: {
    "static spliteratorUnknownSize(Ljava/util/Iterator;I)Ljava/util/Spliterator;": driven(function* (it: unknown): Gen {
      const s = new JSpliterator();
      while (yield vcall(it, "hasNext", "()Z")) s.a.push(yield vcall(it, "next", `()${O}`));
      return s;
    }),
    "static spliterator(Ljava/util/Collection;I)Ljava/util/Spliterator;": driven(function* (c: unknown): Gen {
      const s = new JSpliterator(); s.a = yield toJsArray(c); return s;
    }),
  },
});
rt.register({
  name: S + "StreamSupport", ctor: class extends JObj {},
  methods: {
    [`static stream(Ljava/util/Spliterator;Z)L${S}Stream;`]: (sp: JSpliterator) => mkStream(sp.a.slice()),
    [`static stream(${fnDesc("Supplier")}IZ)L${S}Stream;`]: (s: unknown) => after(invoke("Supplier", s), (sp: JSpliterator) => mkStream(sp.a.slice())),
    ...Object.fromEntries(PRIMS.map(([P]) => [`static ${P.toLowerCase()}Stream(Ljava/util/Spliterator$Of${P};Z)L${S}${P}Stream;`,
      (sp: JSpliterator) => kindOf(P).mk(sp.a.slice())])),
  },
});

