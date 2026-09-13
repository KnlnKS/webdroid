import { JObj, rt } from "../runtime";
import { newArrayList, toJsArray, sortInPlace, type JList } from "./jutil";
import { vcall } from "./jlang";

// ── java.util.stream, the sequential subset. Every stage runs eagerly over a JS array: a lambda
// here is an async compiled method on one thread, so laziness would buy nothing and cost the
// whole Spliterator machinery. Stream sources arrive as an already-drained array.
class JSpliterator extends JObj { a: unknown[] = []; }
class JStream extends JObj { a: unknown[] = []; }
const mkStream = (a: unknown[]) => { const s = new JStream(); s.a = a; return s; };
class JIntStream extends JObj { a: number[] = []; }
const mkIntStream = (a: number[]) => { const s = new JIntStream(); s.a = a; return s; };
class JOptional extends JObj { v: unknown = null; }
const mkOpt = (v: unknown) => { rt.link("java/util/Optional"); const o = new JOptional(); o.v = v ?? null; return o; };
class JOptionalInt extends JObj { present = false; v = 0; }
const mkOptInt = (v?: number) => {
  const o = new JOptionalInt();
  if (v !== undefined) { o.present = true; o.v = v | 0; }
  return o;
};
class JCollector extends JObj {
  make: () => unknown = () => newArrayList([]);
  add: (c: unknown, x: unknown) => unknown = () => {};
  fin: ((c: unknown) => unknown) | null = null;
}
const mkCollector = (make: JCollector["make"], add: JCollector["add"], fin: JCollector["fin"] = null) => {
  const c = new JCollector(); c.make = make; c.add = add; c.fin = fin; return c;
};
const apply1 = (f: unknown, x: unknown) => vcall(f, "apply", "(Ljava/lang/Object;)Ljava/lang/Object;", x);
async function collect(stream: JStream, collector: JCollector): Promise<unknown> {
  if (typeof collector.make === "function") {
    const box = await collector.make();
    for (const value of stream.a) await collector.add(box, value);
    return collector.fin ? collector.fin(box) : box;
  }
  const supplier = await vcall(collector, "supplier", "()Ljava/util/function/Supplier;");
  const accumulator = await vcall(collector, "accumulator", "()Ljava/util/function/BiConsumer;");
  const finisher = await vcall(collector, "finisher", "()Ljava/util/function/Function;");
  const box = await vcall(supplier, "get", "()Ljava/lang/Object;");
  for (const value of stream.a) {
    await vcall(accumulator, "accept", "(Ljava/lang/Object;Ljava/lang/Object;)V", box, value);
  }
  return vcall(finisher, "apply", "(Ljava/lang/Object;)Ljava/lang/Object;", box);
}
rt.register({ name: "java/util/Spliterator", ctor: JSpliterator });
rt.register({
  name: "java/util/Spliterators", ctor: class extends JObj {},
  methods: {
    "static spliteratorUnknownSize(Ljava/util/Iterator;I)Ljava/util/Spliterator;": async (it: unknown) => {
      const s = new JSpliterator();
      while (await vcall(it, "hasNext", "()Z")) s.a.push(await vcall(it, "next", "()Ljava/lang/Object;"));
      return s;
    },
    "static spliterator(Ljava/util/Collection;I)Ljava/util/Spliterator;": async (c: unknown) => {
      const s = new JSpliterator(); s.a = await toJsArray(c); return s;
    },
  },
});
rt.register({
  name: "java/util/stream/StreamSupport", ctor: class extends JObj {},
  methods: { "static stream(Ljava/util/Spliterator;Z)Ljava/util/stream/Stream;": (sp: JSpliterator) => mkStream(sp.a.slice()) },
});
rt.register({
  name: "java/util/stream/Stream", ctor: JStream,
  methods: {
    "static empty()Ljava/util/stream/Stream;": () => mkStream([]),
    "static of(Ljava/lang/Object;)Ljava/util/stream/Stream;": (value: unknown) => mkStream([value]),
    "static of([Ljava/lang/Object;)Ljava/util/stream/Stream;": (values: unknown[]) => mkStream(values.slice()),
    "static concat(Ljava/util/stream/Stream;Ljava/util/stream/Stream;)Ljava/util/stream/Stream;": (a: JStream, b: JStream) => mkStream([...a.a, ...b.a]),
    "filter(Ljava/util/function/Predicate;)Ljava/util/stream/Stream;": async function (this: JStream, p: unknown) {
      const out: unknown[] = [];
      for (const x of this.a) if (await vcall(p, "test", "(Ljava/lang/Object;)Z", x)) out.push(x);
      return mkStream(out);
    },
    "map(Ljava/util/function/Function;)Ljava/util/stream/Stream;": async function (this: JStream, f: unknown) {
      const out: unknown[] = [];
      for (const x of this.a) out.push(await apply1(f, x));
      return mkStream(out);
    },
    "flatMap(Ljava/util/function/Function;)Ljava/util/stream/Stream;": async function (this: JStream, f: unknown) {
      const out: unknown[] = [];
      for (const x of this.a) {
        const nested = await apply1(f, x) as JStream | null;
        if (nested === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
        out.push(...nested.a);
      }
      return mkStream(out);
    },
    "mapToInt(Ljava/util/function/ToIntFunction;)Ljava/util/stream/IntStream;": async function (this: JStream, f: unknown) {
      const out: number[] = [];
      for (const x of this.a) out.push((await vcall(f, "applyAsInt", "(Ljava/lang/Object;)I", x) as number) | 0);
      return mkIntStream(out);
    },
    "forEach(Ljava/util/function/Consumer;)V": async function (this: JStream, c: unknown) {
      for (const x of this.a) await vcall(c, "accept", "(Ljava/lang/Object;)V", x);
    },
    "sorted(Ljava/util/Comparator;)Ljava/util/stream/Stream;": async function (this: JStream, cmp: unknown) {
      const out = this.a.slice();
      await sortInPlace(out, cmp);
      return mkStream(out);
    },
    "limit(J)Ljava/util/stream/Stream;": function (this: JStream, n: bigint) { return mkStream(this.a.slice(0, Number(n))); },
    "count()J": function (this: JStream) { return BigInt(this.a.length); },
    "findFirst()Ljava/util/Optional;": function (this: JStream) { return mkOpt(this.a[0]); },
    "anyMatch(Ljava/util/function/Predicate;)Z": async function (this: JStream, p: unknown) {
      for (const x of this.a) if (await vcall(p, "test", "(Ljava/lang/Object;)Z", x)) return 1;
      return 0;
    },
    "toList()Ljava/util/List;": function (this: JStream) { return newArrayList(this.a.slice()); },
    "collect(Ljava/util/stream/Collector;)Ljava/lang/Object;": function (this: JStream, c: JCollector) { return collect(this, c); },
  },
});

rt.register({
  name: "java/util/stream/IntStream", ctor: JIntStream,
  methods: {
    "static empty()Ljava/util/stream/IntStream;": () => mkIntStream([]),
    "static of(I)Ljava/util/stream/IntStream;": (value: number) => mkIntStream([value | 0]),
    "static of([I)Ljava/util/stream/IntStream;": (values: Int32Array) => mkIntStream(Array.from(values)),
    "static range(II)Ljava/util/stream/IntStream;": (start: number, end: number) => {
      const out: number[] = [];
      for (let value = start | 0; value < (end | 0); value++) out.push(value);
      return mkIntStream(out);
    },
    "static rangeClosed(II)Ljava/util/stream/IntStream;": (start: number, end: number) => {
      const out: number[] = [];
      for (let value = start | 0; value <= (end | 0); value++) out.push(value);
      return mkIntStream(out);
    },
    "boxed()Ljava/util/stream/Stream;": function (this: JIntStream) { return mkStream(this.a.slice()); },
    "map(Ljava/util/function/IntUnaryOperator;)Ljava/util/stream/IntStream;": async function (this: JIntStream, f: unknown) {
      const out: number[] = [];
      for (const value of this.a) out.push((await vcall(f, "applyAsInt", "(I)I", value) as number) | 0);
      return mkIntStream(out);
    },
    "mapToObj(Ljava/util/function/IntFunction;)Ljava/util/stream/Stream;": async function (this: JIntStream, f: unknown) {
      const out: unknown[] = [];
      for (const value of this.a) out.push(await vcall(f, "apply", "(I)Ljava/lang/Object;", value));
      return mkStream(out);
    },
    "filter(Ljava/util/function/IntPredicate;)Ljava/util/stream/IntStream;": async function (this: JIntStream, p: unknown) {
      const out: number[] = [];
      for (const value of this.a) if (await vcall(p, "test", "(I)Z", value)) out.push(value);
      return mkIntStream(out);
    },
    "forEach(Ljava/util/function/IntConsumer;)V": async function (this: JIntStream, c: unknown) {
      for (const value of this.a) await vcall(c, "accept", "(I)V", value);
    },
    "findFirst()Ljava/util/OptionalInt;": function (this: JIntStream) { return mkOptInt(this.a[0]); },
    "anyMatch(Ljava/util/function/IntPredicate;)Z": async function (this: JIntStream, p: unknown) {
      for (const value of this.a) if (await vcall(p, "test", "(I)Z", value)) return 1;
      return 0;
    },
    "allMatch(Ljava/util/function/IntPredicate;)Z": async function (this: JIntStream, p: unknown) {
      for (const value of this.a) if (!(await vcall(p, "test", "(I)Z", value))) return 0;
      return 1;
    },
    "noneMatch(Ljava/util/function/IntPredicate;)Z": async function (this: JIntStream, p: unknown) {
      for (const value of this.a) if (await vcall(p, "test", "(I)Z", value)) return 0;
      return 1;
    },
    "limit(J)Ljava/util/stream/IntStream;": function (this: JIntStream, n: bigint) { return mkIntStream(this.a.slice(0, Number(n))); },
    "skip(J)Ljava/util/stream/IntStream;": function (this: JIntStream, n: bigint) { return mkIntStream(this.a.slice(Number(n))); },
    "sorted()Ljava/util/stream/IntStream;": function (this: JIntStream) { return mkIntStream(this.a.slice().sort((a, b) => a - b)); },
    "distinct()Ljava/util/stream/IntStream;": function (this: JIntStream) { return mkIntStream([...new Set(this.a)]); },
    "count()J": function (this: JIntStream) { return BigInt(this.a.length); },
    "sum()I": function (this: JIntStream) { return this.a.reduce((sum, value) => (sum + value) | 0, 0); },
    "min()Ljava/util/OptionalInt;": function (this: JIntStream) { return mkOptInt(this.a.length ? Math.min(...this.a) : undefined); },
    "max()Ljava/util/OptionalInt;": function (this: JIntStream) { return mkOptInt(this.a.length ? Math.max(...this.a) : undefined); },
    "toArray()[I": function (this: JIntStream) { return Int32Array.from(this.a); },
    "spliterator()Ljava/util/Spliterator$OfInt;": function (this: JIntStream) {
      const spliterator = new JIntSpliterator(); spliterator.a = this.a.slice(); return spliterator;
    },
  },
});

class JIntSpliterator extends JSpliterator {}
rt.register({ name: "java/util/Spliterator$OfInt", ctor: JIntSpliterator, ifaces: ["java/util/Spliterator"] });
rt.register({
  name: "java/util/OptionalInt", ctor: JOptionalInt,
  methods: {
    "static empty()Ljava/util/OptionalInt;": () => mkOptInt(),
    "static of(I)Ljava/util/OptionalInt;": (value: number) => mkOptInt(value),
    "isPresent()Z": function (this: JOptionalInt) { return this.present ? 1 : 0; },
    "isEmpty()Z": function (this: JOptionalInt) { return this.present ? 0 : 1; },
    "getAsInt()I": function (this: JOptionalInt) {
      if (!this.present) throw rt.mkThrowable("java/util/NoSuchElementException", "No value present");
      return this.v;
    },
    "orElse(I)I": function (this: JOptionalInt, fallback: number) { return this.present ? this.v : fallback; },
    "orElseGet(Ljava/util/function/IntSupplier;)I": async function (this: JOptionalInt, supplier: unknown) {
      return this.present ? this.v : vcall(supplier, "getAsInt", "()I");
    },
    "ifPresent(Ljava/util/function/IntConsumer;)V": function (this: JOptionalInt, consumer: unknown) {
      return this.present ? vcall(consumer, "accept", "(I)V", this.v) : undefined;
    },
  },
});

rt.register({ name: "java/util/stream/Collector", ctor: JCollector,
  methods: {
    "static of(Ljava/util/function/Supplier;Ljava/util/function/BiConsumer;Ljava/util/function/BinaryOperator;Ljava/util/function/Function;[Ljava/util/stream/Collector$Characteristics;)Ljava/util/stream/Collector;":
      (sup: unknown, acc: unknown, _comb: unknown, fin: unknown) => mkCollector(
        () => vcall(sup, "get", "()Ljava/lang/Object;"),
        (box, x) => vcall(acc, "accept", "(Ljava/lang/Object;Ljava/lang/Object;)V", box, x),
        fin ? (box) => apply1(fin, box) : null),
  },
});
rt.register({
  name: "java/util/stream/Collector$Characteristics", ctor: class extends JObj {}, sup: "java/lang/Enum",
});
rt.register({
  name: "java/util/stream/Collectors", ctor: class extends JObj {},
  methods: {
    "static toList()Ljava/util/stream/Collector;": () => mkCollector(() => newArrayList([]), (box, x) => { (box as JList).a.push(x); }),
    "static toSet()Ljava/util/stream/Collector;": () => mkCollector(
      () => rt.make("java/util/HashSet"),
      (box, x) => vcall(box, "add", "(Ljava/lang/Object;)Z", x)),
    "static toCollection(Ljava/util/function/Supplier;)Ljava/util/stream/Collector;": (sup: unknown) => mkCollector(
      () => vcall(sup, "get", "()Ljava/lang/Object;"),
      (box, x) => vcall(box, "add", "(Ljava/lang/Object;)Z", x)),
    "static collectingAndThen(Ljava/util/stream/Collector;Ljava/util/function/Function;)Ljava/util/stream/Collector;":
      (c: JCollector, fin: unknown) => mkCollector(c.make, c.add, async (box) => apply1(fin, c.fin ? await c.fin(box) : box)),
    "static joining(Ljava/lang/CharSequence;)Ljava/util/stream/Collector;": (delimiter: unknown) => mkCollector(
      () => [] as string[], (box, x) => { (box as string[]).push(String(x)); }, (box) => (box as string[]).join(String(delimiter))),
    "static joining(Ljava/lang/CharSequence;Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Ljava/util/stream/Collector;":
      (delimiter: unknown, prefix: unknown, suffix: unknown) => mkCollector(
        () => [] as string[], (box, x) => { (box as string[]).push(String(x)); },
        (box) => String(prefix) + (box as string[]).join(String(delimiter)) + String(suffix)),
  },
});
rt.register({
  name: "java/util/Optional", ctor: JOptional,
  methods: {
    "static of(Ljava/lang/Object;)Ljava/util/Optional;": (v: unknown) => mkOpt(v),
    "static ofNullable(Ljava/lang/Object;)Ljava/util/Optional;": (v: unknown) => mkOpt(v),
    "static empty()Ljava/util/Optional;": () => mkOpt(null),
    "isPresent()Z": function (this: JOptional) { return this.v === null ? 0 : 1; },
    "isEmpty()Z": function (this: JOptional) { return this.v === null ? 1 : 0; },
    "get()Ljava/lang/Object;": function (this: JOptional) {
      if (this.v === null) throw rt.mkThrowable("java/util/NoSuchElementException", "No value present");
      return this.v;
    },
    "orElse(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JOptional, d: unknown) { return this.v ?? d; },
    "orElseGet(Ljava/util/function/Supplier;)Ljava/lang/Object;": function (this: JOptional, s: unknown) { return this.v ?? vcall(s, "get", "()Ljava/lang/Object;"); },
    "orElseThrow()Ljava/lang/Object;": function (this: JOptional) {
      if (this.v === null) throw rt.mkThrowable("java/util/NoSuchElementException", "No value present");
      return this.v;
    },
    "orElseThrow(Ljava/util/function/Supplier;)Ljava/lang/Object;": async function (this: JOptional, s: unknown) {
      if (this.v === null) throw await vcall(s, "get", "()Ljava/lang/Object;");
      return this.v;
    },
    "filter(Ljava/util/function/Predicate;)Ljava/util/Optional;": async function (this: JOptional, p: unknown) {
      return this.v === null || await vcall(p, "test", "(Ljava/lang/Object;)Z", this.v) ? this : mkOpt(null);
    },
    "flatMap(Ljava/util/function/Function;)Ljava/util/Optional;": async function (this: JOptional, f: unknown) {
      return this.v === null ? this : apply1(f, this.v);
    },
    "ifPresentOrElse(Ljava/util/function/Consumer;Ljava/lang/Runnable;)V": function (this: JOptional, c: unknown, r: unknown) {
      return this.v === null ? vcall(r, "run", "()V") : vcall(c, "accept", "(Ljava/lang/Object;)V", this.v);
    },
    "equals(Ljava/lang/Object;)Z": async function (this: JOptional, o: unknown) {
      return o instanceof JOptional && (o.v === this.v || o.v !== null && this.v !== null && !!await vcall(this.v, "equals", "(Ljava/lang/Object;)Z", o.v)) ? 1 : 0;
    },
    "map(Ljava/util/function/Function;)Ljava/util/Optional;": async function (this: JOptional, f: unknown) {
      return this.v === null ? this : mkOpt(await apply1(f, this.v));
    },
    "ifPresent(Ljava/util/function/Consumer;)V": function (this: JOptional, c: unknown) {
      return this.v === null ? undefined : vcall(c, "accept", "(Ljava/lang/Object;)V", this.v);
    },
  },
});
