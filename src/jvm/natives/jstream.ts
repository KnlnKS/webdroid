import { JObj, rt } from "../runtime";
import { newArrayList, toJsArray, sortInPlace, type JList } from "./jutil";
import { vcall } from "./jlang";

// ── java.util.stream, the sequential subset. Every stage runs eagerly over a JS array: a lambda
// here is an async compiled method on one thread, so laziness would buy nothing and cost the
// whole Spliterator machinery. Stream sources arrive as an already-drained array.
class JSpliterator extends JObj { a: unknown[] = []; }
class JStream extends JObj { a: unknown[] = []; }
const mkStream = (a: unknown[]) => { const s = new JStream(); s.a = a; return s; };
class JOptional extends JObj { v: unknown = null; }
const mkOpt = (v: unknown) => { rt.link("java/util/Optional"); const o = new JOptional(); o.v = v ?? null; return o; };
class JCollector extends JObj {
  make: () => unknown = () => newArrayList([]);
  add: (c: unknown, x: unknown) => unknown = () => {};
  fin: ((c: unknown) => unknown) | null = null;
}
const mkCollector = (make: JCollector["make"], add: JCollector["add"], fin: JCollector["fin"] = null) => {
  const c = new JCollector(); c.make = make; c.add = add; c.fin = fin; return c;
};
const apply1 = (f: unknown, x: unknown) => vcall(f, "apply", "(Ljava/lang/Object;)Ljava/lang/Object;", x);
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
    "collect(Ljava/util/stream/Collector;)Ljava/lang/Object;": async function (this: JStream, c: JCollector) {
      const box = await c.make();
      for (const x of this.a) await c.add(box, x);
      return c.fin ? await c.fin(box) : box;
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
    "static toCollection(Ljava/util/function/Supplier;)Ljava/util/stream/Collector;": (sup: unknown) => mkCollector(
      () => vcall(sup, "get", "()Ljava/lang/Object;"),
      (box, x) => vcall(box, "add", "(Ljava/lang/Object;)Z", x)),
    "static collectingAndThen(Ljava/util/stream/Collector;Ljava/util/function/Function;)Ljava/util/stream/Collector;":
      (c: JCollector, fin: unknown) => mkCollector(c.make, c.add, async (box) => apply1(fin, c.fin ? await c.fin(box) : box)),
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
    "map(Ljava/util/function/Function;)Ljava/util/Optional;": async function (this: JOptional, f: unknown) {
      return this.v === null ? this : mkOpt(await apply1(f, this.v));
    },
    "ifPresent(Ljava/util/function/Consumer;)V": function (this: JOptional, c: unknown) {
      return this.v === null ? undefined : vcall(c, "accept", "(Ljava/lang/Object;)V", this.v);
    },
  },
});
