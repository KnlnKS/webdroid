import { JObj, rt, driven, type Gen } from "../runtime";
import { JList, mkIter, newArrayList, toJsArray, sortInPlace } from "./jutil";
import { vcall } from "./jlang";
import { csText } from "./jchars";
import { jarray } from "../abi";
import { JIntStream, mkIntStream } from "./jstream-values";

// ── java.util.stream, the sequential subset. Every stage runs eagerly over a JS array: a lambda
// here is an async compiled method on one thread, so laziness would buy nothing and cost the
// whole Spliterator machinery. Stream sources arrive as an already-drained array.
class JSpliterator extends JObj { a: unknown[] = []; }
class JStream extends JObj { a: unknown[] = []; }
const mkStream = (a: unknown[]) => { const s = new JStream(); s.a = a; return s; };
class JLongStream extends JObj { a: bigint[] = []; }
const mkLongStream = (a: bigint[]) => { const s = new JLongStream(); s.a = a; return s; };
class JOptional extends JObj { v: unknown = null; }
const mkOpt = (v: unknown) => { rt.link("java/util/Optional"); const o = new JOptional(); o.v = v ?? null; return o; };
class JOptionalInt extends JObj { present = false; v = 0; }
const mkOptInt = (v?: number) => {
  const o = new JOptionalInt();
  if (v !== undefined) { o.present = true; o.v = v | 0; }
  return o;
};
class JCollector extends JObj {
  supplier: unknown = null;
  accumulator: unknown = null;
  combiner: unknown = null;
  finisher: unknown = null;
}
type HostCall = (...args: unknown[]) => unknown;
class JHostSupplier extends JObj { call: HostCall = () => null; }
class JHostBiFunction extends JObj { call: HostCall = () => null; }
class JHostFunction extends JObj { call: HostCall = () => null; }
const hostSupplier = (call: HostCall) => Object.assign(new JHostSupplier(), { call });
const hostBiFunction = (call: HostCall) => Object.assign(new JHostBiFunction(), { call });
const hostFunction = (call: HostCall) => Object.assign(new JHostFunction(), { call });
function listBox(value: unknown): JList {
  if (!(value instanceof JList)) throw new Error("collector expected a list accumulator");
  return value;
}
function stringBox(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("collector expected a string accumulator");
  return value;
}
function collector(supplier: unknown, accumulator: unknown, combiner: unknown, finisher: unknown): JCollector {
  return Object.assign(new JCollector(), { supplier, accumulator, combiner, finisher });
}
function mkCollector(make: HostCall, add: HostCall, combine: HostCall, finish: HostCall = (value) => value): JCollector {
  return collector(hostSupplier(make), hostBiFunction(add), hostBiFunction(combine), hostFunction(finish));
}
const apply1 = (f: unknown, x: unknown) => vcall(f, "apply", "(Ljava/lang/Object;)Ljava/lang/Object;", x);
async function collect(stream: JStream, value: unknown): Promise<unknown> {
  const supplier = await vcall(value, "supplier", "()Ljava/util/function/Supplier;");
  const accumulator = await vcall(value, "accumulator", "()Ljava/util/function/BiConsumer;");
  const finisher = await vcall(value, "finisher", "()Ljava/util/function/Function;");
  const box = await vcall(supplier, "get", "()Ljava/lang/Object;");
  for (const value of stream.a) {
    await vcall(accumulator, "accept", "(Ljava/lang/Object;Ljava/lang/Object;)V", box, value);
  }
  return vcall(finisher, "apply", "(Ljava/lang/Object;)Ljava/lang/Object;", box);
}
rt.register({ name: "webdroid/CollectorSupplier", ctor: JHostSupplier, ifaces: ["java/util/function/Supplier"], methods: {
  "get()Ljava/lang/Object;": function (this: JHostSupplier) { return this.call(); },
} });
rt.register({ name: "webdroid/CollectorBiFunction", ctor: JHostBiFunction, ifaces: ["java/util/function/BiConsumer", "java/util/function/BinaryOperator"], methods: {
  "accept(Ljava/lang/Object;Ljava/lang/Object;)V": function (this: JHostBiFunction, left: unknown, right: unknown) { return this.call(left, right); },
  "apply(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": function (this: JHostBiFunction, left: unknown, right: unknown) { return this.call(left, right); },
} });
rt.register({ name: "webdroid/CollectorFunction", ctor: JHostFunction, ifaces: ["java/util/function/Function"], methods: {
  "apply(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JHostFunction, value: unknown) { return this.call(value); },
} });
rt.register({ name: "java/util/Spliterator", ctor: JSpliterator });
rt.register({
  name: "java/util/Spliterators", ctor: class extends JObj {},
  methods: {
    "static spliteratorUnknownSize(Ljava/util/Iterator;I)Ljava/util/Spliterator;": driven(function* (it: unknown): Gen {
      const s = new JSpliterator();
      while (yield vcall(it, "hasNext", "()Z")) s.a.push(yield vcall(it, "next", "()Ljava/lang/Object;"));
      return s;
    }),
    "static spliterator(Ljava/util/Collection;I)Ljava/util/Spliterator;": driven(function* (c: unknown): Gen {
      const s = new JSpliterator(); s.a = yield toJsArray(c); return s;
    }),
  },
});
rt.register({
  name: "java/util/stream/StreamSupport", ctor: class extends JObj {},
  methods: { "static stream(Ljava/util/Spliterator;Z)Ljava/util/stream/Stream;": (sp: JSpliterator) => mkStream(sp.a.slice()) },
});
rt.register({
  name: "java/util/stream/Stream", ctor: JStream,
  ifaces: ["java/util/stream/BaseStream"],
  methods: {
    "static empty()Ljava/util/stream/Stream;": () => mkStream([]),
    "static of(Ljava/lang/Object;)Ljava/util/stream/Stream;": (value: unknown) => mkStream([value]),
    "static of([Ljava/lang/Object;)Ljava/util/stream/Stream;": (values: unknown[]) => mkStream(values.slice()),
    "static concat(Ljava/util/stream/Stream;Ljava/util/stream/Stream;)Ljava/util/stream/Stream;": (a: JStream, b: JStream) => mkStream([...a.a, ...b.a]),
    "filter(Ljava/util/function/Predicate;)Ljava/util/stream/Stream;": driven(function* (this: JStream, p: unknown): Gen {
      const out: unknown[] = [];
      for (const x of this.a) if (yield vcall(p, "test", "(Ljava/lang/Object;)Z", x)) out.push(x);
      return mkStream(out);
    }),
    "map(Ljava/util/function/Function;)Ljava/util/stream/Stream;": driven(function* (this: JStream, f: unknown): Gen {
      const out: unknown[] = [];
      for (const x of this.a) out.push(yield apply1(f, x));
      return mkStream(out);
    }),
    "flatMap(Ljava/util/function/Function;)Ljava/util/stream/Stream;": driven(function* (this: JStream, f: unknown): Gen {
      const out: unknown[] = [];
      for (const x of this.a) {
        const nested = (yield apply1(f, x)) as JStream | null;
        if (nested === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
        out.push(...nested.a);
      }
      return mkStream(out);
    }),
    "mapToInt(Ljava/util/function/ToIntFunction;)Ljava/util/stream/IntStream;": driven(function* (this: JStream, f: unknown): Gen {
      const out: number[] = [];
      for (const x of this.a) out.push(((yield vcall(f, "applyAsInt", "(Ljava/lang/Object;)I", x)) as number) | 0);
      return mkIntStream(out);
    }),
    "mapToLong(Ljava/util/function/ToLongFunction;)Ljava/util/stream/LongStream;": driven(function* (this: JStream, f: unknown): Gen {
      const out: bigint[] = [];
      for (const x of this.a) out.push((yield vcall(f, "applyAsLong", "(Ljava/lang/Object;)J", x)) as bigint);
      return mkLongStream(out);
    }),
    "forEach(Ljava/util/function/Consumer;)V": driven(function* (this: JStream, c: unknown): Gen {
      for (const x of this.a) yield vcall(c, "accept", "(Ljava/lang/Object;)V", x);
    }),
    "sorted(Ljava/util/Comparator;)Ljava/util/stream/Stream;": driven(function* (this: JStream, cmp: unknown): Gen {
      const out = this.a.slice();
      yield sortInPlace(out, cmp);
      return mkStream(out);
    }),
    "limit(J)Ljava/util/stream/Stream;": function (this: JStream, n: bigint) { return mkStream(this.a.slice(0, Number(n))); },
    "count()J": function (this: JStream) { return BigInt(this.a.length); },
    "findFirst()Ljava/util/Optional;": function (this: JStream) { return mkOpt(this.a[0]); },
    "anyMatch(Ljava/util/function/Predicate;)Z": driven(function* (this: JStream, p: unknown): Gen {
      for (const x of this.a) if (yield vcall(p, "test", "(Ljava/lang/Object;)Z", x)) return 1;
      return 0;
    }),
    "allMatch(Ljava/util/function/Predicate;)Z": driven(function* (this: JStream, p: unknown): Gen {
      for (const x of this.a) if (!(yield vcall(p, "test", "(Ljava/lang/Object;)Z", x))) return 0;
      return 1;
    }),
    "noneMatch(Ljava/util/function/Predicate;)Z": driven(function* (this: JStream, p: unknown): Gen {
      for (const x of this.a) if (yield vcall(p, "test", "(Ljava/lang/Object;)Z", x)) return 0;
      return 1;
    }),
    "toList()Ljava/util/List;": function (this: JStream) { return newArrayList(this.a.slice()); },
    "toArray()[Ljava/lang/Object;": function (this: JStream) { return jarray(this.a.slice()); },
    "toArray(Ljava/util/function/IntFunction;)[Ljava/lang/Object;": driven(function* (this: JStream, generator: unknown): Gen {
      const out = (yield vcall(generator, "apply", "(I)Ljava/lang/Object;", this.a.length)) as unknown[];
      if (!Array.isArray(out) || out.length < this.a.length) throw rt.mkThrowable("java/lang/IllegalStateException", "Invalid stream array generator");
      for (let i = 0; i < this.a.length; i++) out[i] = this.a[i];
      return out;
    }),
    "iterator()Ljava/util/Iterator;": function (this: JStream) { return mkIter(this.a); },
    "collect(Ljava/util/stream/Collector;)Ljava/lang/Object;": function (this: JStream, c: unknown) { return collect(this, c); },
  },
});
rt.register({ name: "java/util/stream/LongStream", ctor: JLongStream, ifaces: ["java/util/stream/BaseStream"], methods: {
  "mapToObj(Ljava/util/function/LongFunction;)Ljava/util/stream/Stream;": driven(function* (this: JLongStream, f: unknown): Gen {
    const out: unknown[] = [];
    for (const value of this.a) out.push(yield vcall(f, "apply", "(J)Ljava/lang/Object;", value));
    return mkStream(out);
  }),
  "sum()J": function (this: JLongStream) { return this.a.reduce((sum, value) => BigInt.asIntN(64, sum + value), 0n); },
  "count()J": function (this: JLongStream) { return BigInt(this.a.length); },
  "toArray()[J": function (this: JLongStream) { return BigInt64Array.from(this.a); },
  "boxed()Ljava/util/stream/Stream;": function (this: JLongStream) { return mkStream(this.a.slice()); },
} });

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
    "map(Ljava/util/function/IntUnaryOperator;)Ljava/util/stream/IntStream;": driven(function* (this: JIntStream, f: unknown): Gen {
      const out: number[] = [];
      for (const value of this.a) out.push(((yield vcall(f, "applyAsInt", "(I)I", value)) as number) | 0);
      return mkIntStream(out);
    }),
    "mapToObj(Ljava/util/function/IntFunction;)Ljava/util/stream/Stream;": driven(function* (this: JIntStream, f: unknown): Gen {
      const out: unknown[] = [];
      for (const value of this.a) out.push(yield vcall(f, "apply", "(I)Ljava/lang/Object;", value));
      return mkStream(out);
    }),
    "filter(Ljava/util/function/IntPredicate;)Ljava/util/stream/IntStream;": driven(function* (this: JIntStream, p: unknown): Gen {
      const out: number[] = [];
      for (const value of this.a) if (yield vcall(p, "test", "(I)Z", value)) out.push(value);
      return mkIntStream(out);
    }),
    "forEach(Ljava/util/function/IntConsumer;)V": driven(function* (this: JIntStream, c: unknown): Gen {
      for (const value of this.a) yield vcall(c, "accept", "(I)V", value);
    }),
    "findFirst()Ljava/util/OptionalInt;": function (this: JIntStream) { return mkOptInt(this.a[0]); },
    "anyMatch(Ljava/util/function/IntPredicate;)Z": driven(function* (this: JIntStream, p: unknown): Gen {
      for (const value of this.a) if (yield vcall(p, "test", "(I)Z", value)) return 1;
      return 0;
    }),
    "allMatch(Ljava/util/function/IntPredicate;)Z": driven(function* (this: JIntStream, p: unknown): Gen {
      for (const value of this.a) if (!(yield vcall(p, "test", "(I)Z", value))) return 0;
      return 1;
    }),
    "noneMatch(Ljava/util/function/IntPredicate;)Z": driven(function* (this: JIntStream, p: unknown): Gen {
      for (const value of this.a) if (yield vcall(p, "test", "(I)Z", value)) return 0;
      return 1;
    }),
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
rt.register({ name: "java/util/stream/BaseStream", ctor: class extends JObj {}, ifaces: ["java/lang/AutoCloseable"] });
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
    "orElseGet(Ljava/util/function/IntSupplier;)I": function (this: JOptionalInt, supplier: unknown) {
      return this.present ? this.v : vcall(supplier, "getAsInt", "()I");
    },
    "ifPresent(Ljava/util/function/IntConsumer;)V": function (this: JOptionalInt, consumer: unknown) {
      return this.present ? vcall(consumer, "accept", "(I)V", this.v) : undefined;
    },
  },
});

rt.register({ name: "java/util/stream/Collector", ctor: JCollector,
  methods: {
    "supplier()Ljava/util/function/Supplier;": function (this: JCollector) { return this.supplier; },
    "accumulator()Ljava/util/function/BiConsumer;": function (this: JCollector) { return this.accumulator; },
    "combiner()Ljava/util/function/BinaryOperator;": function (this: JCollector) { return this.combiner; },
    "finisher()Ljava/util/function/Function;": function (this: JCollector) { return this.finisher; },
    "characteristics()Ljava/util/Set;": () => rt.make("java/util/HashSet"),
    "static of(Ljava/util/function/Supplier;Ljava/util/function/BiConsumer;Ljava/util/function/BinaryOperator;Ljava/util/function/Function;[Ljava/util/stream/Collector$Characteristics;)Ljava/util/stream/Collector;":
      (supplier: unknown, accumulator: unknown, combiner: unknown, finisher: unknown) =>
        collector(supplier, accumulator, combiner, finisher ?? hostFunction((value) => value)),
  },
});
rt.register({
  name: "java/util/stream/Collector$Characteristics", ctor: class extends JObj {}, sup: "java/lang/Enum",
});
rt.register({
  name: "java/util/stream/Collectors", ctor: class extends JObj {},
  methods: {
    "static toList()Ljava/util/stream/Collector;": () => mkCollector(
      () => newArrayList([]), (box, x) => { listBox(box).a.push(x); },
      (left, right) => { listBox(left).a.push(...listBox(right).a); return left; }),
    "static toSet()Ljava/util/stream/Collector;": () => mkCollector(
      () => rt.make("java/util/HashSet"),
      (box, x) => vcall(box, "add", "(Ljava/lang/Object;)Z", x),
      async (left, right) => { await vcall(left, "addAll", "(Ljava/util/Collection;)Z", right); return left; }),
    "static toCollection(Ljava/util/function/Supplier;)Ljava/util/stream/Collector;": (sup: unknown) => mkCollector(
      () => vcall(sup, "get", "()Ljava/lang/Object;"),
      (box, x) => vcall(box, "add", "(Ljava/lang/Object;)Z", x),
      async (left, right) => { await vcall(left, "addAll", "(Ljava/util/Collection;)Z", right); return left; }),
    "static collectingAndThen(Ljava/util/stream/Collector;Ljava/util/function/Function;)Ljava/util/stream/Collector;":
      driven(function* (downstream: unknown, finish: unknown): Gen { return collector(
        yield vcall(downstream, "supplier", "()Ljava/util/function/Supplier;"),
        yield vcall(downstream, "accumulator", "()Ljava/util/function/BiConsumer;"),
        yield vcall(downstream, "combiner", "()Ljava/util/function/BinaryOperator;"),
        hostFunction(async (box) => apply1(finish, await apply1(await vcall(downstream, "finisher", "()Ljava/util/function/Function;"), box)))); }),
    "static joining(Ljava/lang/CharSequence;)Ljava/util/stream/Collector;": driven(function* (delimiter: unknown): Gen {
      const separator = yield csText(delimiter);
      return mkCollector(() => [], async (box, x) => { stringBox(box).push(await csText(x)); },
        (left, right) => { stringBox(left).push(...stringBox(right)); return left; }, (box) => stringBox(box).join(separator));
    }),
    "static joining(Ljava/lang/CharSequence;Ljava/lang/CharSequence;Ljava/lang/CharSequence;)Ljava/util/stream/Collector;":
      driven(function* (delimiter: unknown, prefix: unknown, suffix: unknown): Gen {
        const [separator, before, after] = yield Promise.all([csText(delimiter), csText(prefix), csText(suffix)]);
        return mkCollector(() => [], async (box, x) => { stringBox(box).push(await csText(x)); },
          (left, right) => { stringBox(left).push(...stringBox(right)); return left; },
          (box) => before + stringBox(box).join(separator) + after);
      }),
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
    "orElseThrow(Ljava/util/function/Supplier;)Ljava/lang/Object;": driven(function* (this: JOptional, s: unknown): Gen {
      if (this.v === null) throw yield vcall(s, "get", "()Ljava/lang/Object;");
      return this.v;
    }),
    "filter(Ljava/util/function/Predicate;)Ljava/util/Optional;": driven(function* (this: JOptional, p: unknown): Gen {
      return this.v === null || (yield vcall(p, "test", "(Ljava/lang/Object;)Z", this.v)) ? this : mkOpt(null);
    }),
    "flatMap(Ljava/util/function/Function;)Ljava/util/Optional;": function (this: JOptional, f: unknown) {
      return this.v === null ? this : apply1(f, this.v);
    },
    "ifPresentOrElse(Ljava/util/function/Consumer;Ljava/lang/Runnable;)V": function (this: JOptional, c: unknown, r: unknown) {
      return this.v === null ? vcall(r, "run", "()V") : vcall(c, "accept", "(Ljava/lang/Object;)V", this.v);
    },
    "equals(Ljava/lang/Object;)Z": driven(function* (this: JOptional, o: unknown): Gen {
      return o instanceof JOptional && (o.v === this.v || o.v !== null && this.v !== null && !!(yield vcall(this.v, "equals", "(Ljava/lang/Object;)Z", o.v))) ? 1 : 0;
    }),
    "map(Ljava/util/function/Function;)Ljava/util/Optional;": driven(function* (this: JOptional, f: unknown): Gen {
      return this.v === null ? this : mkOpt(yield apply1(f, this.v));
    }),
    "ifPresent(Ljava/util/function/Consumer;)V": function (this: JOptional, c: unknown) {
      return this.v === null ? undefined : vcall(c, "accept", "(Ljava/lang/Object;)V", this.v);
    },
  },
});
