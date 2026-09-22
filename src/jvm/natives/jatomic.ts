import { rt, JObj, type NativeSpec, type ClassInfo } from "../runtime";
import { vcall } from "./jlang";

// ── atomics (single-threaded: trivial)
const atomicCore = (d: string): NativeSpec["methods"] => ({
  "<init>()V": function () {},
  [`<init>(${d})V`]: function (this: { v: unknown }, v: unknown) { this.v = v; },
  [`get()${d}`]: function (this: { v: unknown }) { return this.v; },
  [`set(${d})V`]: function (this: { v: unknown }, v: unknown) { this.v = v; },
  [`lazySet(${d})V`]: function (this: { v: unknown }, v: unknown) { this.v = v; },
  [`getAndSet(${d})${d}`]: function (this: { v: unknown }, v: unknown) { const o = this.v; this.v = v; return o; },
});
class JAtomicInt extends JObj { v = 0; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicInteger", ctor: JAtomicInt, sup: "java/lang/Number",
  methods: {
    ...atomicCore("I"),
    "incrementAndGet()I": function (this: JAtomicInt) { return (this.v = (this.v + 1) | 0); },
    "decrementAndGet()I": function (this: JAtomicInt) { return (this.v = (this.v - 1) | 0); },
    "getAndIncrement()I": function (this: JAtomicInt) { const o = this.v; this.v = (o + 1) | 0; return o; },
    "getAndDecrement()I": function (this: JAtomicInt) { const o = this.v; this.v = (o - 1) | 0; return o; },
    "addAndGet(I)I": function (this: JAtomicInt, d: number) { return (this.v = (this.v + d) | 0); },
    "getAndAdd(I)I": function (this: JAtomicInt, d: number) { const o = this.v; this.v = (o + d) | 0; return o; },
    "compareAndSet(II)Z": function (this: JAtomicInt, e: number, v: number) {
      if (this.v !== e) return 0;
      this.v = v; return 1;
    },
    "intValue()I": function (this: JAtomicInt) { return this.v; },
    "longValue()J": function (this: JAtomicInt) { return BigInt(this.v); },
    "toString()Ljava/lang/String;": function (this: JAtomicInt) { return String(this.v); },
  },
});
class JAtomicLong extends JObj { v = 0n; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicLong", ctor: JAtomicLong, sup: "java/lang/Number",
  methods: {
    ...atomicCore("J"),
    "incrementAndGet()J": function (this: JAtomicLong) { return (this.v = BigInt.asIntN(64, this.v + 1n)); },
    "decrementAndGet()J": function (this: JAtomicLong) { return (this.v = BigInt.asIntN(64, this.v - 1n)); },
    "getAndDecrement()J": function (this: JAtomicLong) { const o = this.v; this.v = BigInt.asIntN(64, o - 1n); return o; },
    "getAndAdd(J)J": function (this: JAtomicLong, d: bigint) { const o = this.v; this.v = BigInt.asIntN(64, o + d); return o; },
    "intValue()I": function (this: JAtomicLong) { return Number(BigInt.asIntN(32, this.v)); },
    "longValue()J": function (this: JAtomicLong) { return this.v; },
    "toString()Ljava/lang/String;": function (this: JAtomicLong) { return String(this.v); },
    "getAndIncrement()J": function (this: JAtomicLong) { const o = this.v; this.v = BigInt.asIntN(64, o + 1n); return o; },
    "addAndGet(J)J": function (this: JAtomicLong, d: bigint) { return (this.v = BigInt.asIntN(64, this.v + d)); },
    "compareAndSet(JJ)Z": function (this: JAtomicLong, e: bigint, v: bigint) {
      if (this.v !== e) return 0;
      this.v = v; return 1;
    },
    "getAndUpdate(Ljava/util/function/LongUnaryOperator;)J": async function (this: JAtomicLong, f: unknown) { const o = this.v; this.v = await vcall(f, "applyAsLong", "(J)J", o); return o; },
    "updateAndGet(Ljava/util/function/LongUnaryOperator;)J": async function (this: JAtomicLong, f: unknown) { return (this.v = await vcall(f, "applyAsLong", "(J)J", this.v)); },
    "accumulateAndGet(JLjava/util/function/LongBinaryOperator;)J": async function (this: JAtomicLong, x: bigint, f: unknown) { return (this.v = await vcall(f, "applyAsLong", "(JJ)J", this.v, x)); },
  },
});
class JAtomicMarkable extends JObj { v: unknown = null; mark = 0; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicMarkableReference", ctor: JAtomicMarkable,
  methods: {
    "<init>(Ljava/lang/Object;Z)V": function (this: JAtomicMarkable, v: unknown, m: number) { this.v = v; this.mark = m; },
    "getReference()Ljava/lang/Object;": function (this: JAtomicMarkable) { return this.v; },
    "isMarked()Z": function (this: JAtomicMarkable) { return this.mark; },
    "get([Z)Ljava/lang/Object;": function (this: JAtomicMarkable, out: Uint8Array) { out[0] = this.mark; return this.v; },
    "set(Ljava/lang/Object;Z)V": function (this: JAtomicMarkable, v: unknown, m: number) { this.v = v; this.mark = m; },
    "compareAndSet(Ljava/lang/Object;Ljava/lang/Object;ZZ)Z": function (this: JAtomicMarkable, e: unknown, v: unknown, em: number, m: number) {
      if (this.v !== e || this.mark !== em) return 0;
      this.v = v; this.mark = m; return 1;
    },
    "attemptMark(Ljava/lang/Object;Z)Z": function (this: JAtomicMarkable, e: unknown, m: number) { if (this.v !== e) return 0; this.mark = m; return 1; },
  },
});
class JAtomicBool extends JObj { v = 0; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicBoolean", ctor: JAtomicBool,
  methods: {
    ...atomicCore("Z"),
    "compareAndSet(ZZ)Z": function (this: JAtomicBool, e: number, v: number) {
      if (this.v !== e) return 0;
      this.v = v; return 1;
    },
  },
});
class JAtomicRef extends JObj { v: unknown = null; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicReference", ctor: JAtomicRef,
  methods: {
    ...atomicCore("Ljava/lang/Object;"),
    "compareAndSet(Ljava/lang/Object;Ljava/lang/Object;)Z": function (this: JAtomicRef, e: unknown, v: unknown) {
      if (this.v !== e) return 0;
      this.v = v;
      return 1;
    },
    "getAndUpdate(Ljava/util/function/UnaryOperator;)Ljava/lang/Object;": async function (this: JAtomicRef, f: unknown) { const o = this.v; this.v = await vcall(f, "apply", "(Ljava/lang/Object;)Ljava/lang/Object;", o); return o; },
    "updateAndGet(Ljava/util/function/UnaryOperator;)Ljava/lang/Object;": async function (this: JAtomicRef, f: unknown) { return (this.v = await vcall(f, "apply", "(Ljava/lang/Object;)Ljava/lang/Object;", this.v)); },
  },
});

class JAtomicIntArray extends JObj { a!: Int32Array; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicIntegerArray", ctor: JAtomicIntArray,
  methods: {
    "<init>(I)V": function (this: JAtomicIntArray, n: number) { this.a = new Int32Array(n); },
    "get(I)I": function (this: JAtomicIntArray, i: number) { return this.a[i]; },
    "set(II)V": function (this: JAtomicIntArray, i: number, v: number) { this.a[i] = v; },
    "lazySet(II)V": function (this: JAtomicIntArray, i: number, v: number) { this.a[i] = v; },
    "getAndSet(II)I": function (this: JAtomicIntArray, i: number, v: number) { const o = this.a[i]; this.a[i] = v; return o; },
    "compareAndSet(III)Z": function (this: JAtomicIntArray, i: number, e: number, v: number) { if (this.a[i] !== e) return 0; this.a[i] = v; return 1; },
    "incrementAndGet(I)I": function (this: JAtomicIntArray, i: number) { return ++this.a[i]; },
    "getAndIncrement(I)I": function (this: JAtomicIntArray, i: number) { return this.a[i]++; },
    "addAndGet(II)I": function (this: JAtomicIntArray, i: number, d: number) { return (this.a[i] += d); },
    "getAndAdd(II)I": function (this: JAtomicIntArray, i: number, d: number) { const o = this.a[i]; this.a[i] += d; return o; },
    "length()I": function (this: JAtomicIntArray) { return this.a.length; },
  },
});
class JAtomicLongArray extends JObj { a!: BigInt64Array; }
function atomicLongSet(this: JAtomicLongArray, i: number, value: bigint) {
  if (i < 0 || i >= this.a.length) throw rt.mkThrowable("java/lang/IndexOutOfBoundsException", String(i));
  this.a[i] = value;
}
rt.register({
  name: "java/util/concurrent/atomic/AtomicLongArray", ctor: JAtomicLongArray,
  methods: {
    "<init>(I)V": function (this: JAtomicLongArray, n: number) { this.a = new BigInt64Array(n); },
    "get(I)J": function (this: JAtomicLongArray, i: number) { return this.a[i]; },
    "set(IJ)V": atomicLongSet,
    "lazySet(IJ)V": atomicLongSet,
    "getAndSet(IJ)J": function (this: JAtomicLongArray, i: number, v: bigint) { const o = this.a[i]; this.a[i] = v; return o; },
    "compareAndSet(IJJ)Z": function (this: JAtomicLongArray, i: number, e: bigint, v: bigint) { if (this.a[i] !== e) return 0; this.a[i] = v; return 1; },
    "incrementAndGet(I)J": function (this: JAtomicLongArray, i: number) { return (this.a[i] += 1n); },
    "addAndGet(IJ)J": function (this: JAtomicLongArray, i: number, d: bigint) { return (this.a[i] += d); },
    "length()I": function (this: JAtomicLongArray) { return this.a.length; },
  },
});

class JAtomicArr extends JObj { a: unknown[] = []; }
rt.register({
  name: "java/util/concurrent/atomic/AtomicReferenceArray", ctor: JAtomicArr,
  methods: {
    "<init>(I)V": function (this: JAtomicArr, n: number) { this.a = new Array(n).fill(null); },
    "<init>([Ljava/lang/Object;)V": function (this: JAtomicArr, src: unknown[]) { this.a = (src ?? []).slice(); },
    "length()I": function (this: JAtomicArr) { return this.a.length; },
    "get(I)Ljava/lang/Object;": function (this: JAtomicArr, i: number) { return this.a[i] ?? null; },
    "set(ILjava/lang/Object;)V": function (this: JAtomicArr, i: number, v: unknown) { this.a[i] = v; },
    "lazySet(ILjava/lang/Object;)V": function (this: JAtomicArr, i: number, v: unknown) { this.a[i] = v; },
    "getAndSet(ILjava/lang/Object;)Ljava/lang/Object;": function (this: JAtomicArr, i: number, v: unknown) { const o = this.a[i] ?? null; this.a[i] = v; return o; },
    "compareAndSet(ILjava/lang/Object;Ljava/lang/Object;)Z": function (this: JAtomicArr, i: number, e: unknown, v: unknown) {
      if ((this.a[i] ?? null) !== e) return 0;
      this.a[i] = v; return 1;
    },
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
function mkUpdater(cls: string, target: { ci?: ClassInfo | null } | null, field: string): JFieldUpdater {
  const u = rt.make(cls) as JFieldUpdater;
  u.prop = fieldProp(target, field);
  return u;
}
const updaterCommon = (zero: unknown) => ({
  "get(Ljava/lang/Object;)Ljava/lang/Object;": function (this: JFieldUpdater, o: any) { return o[this.prop] ?? zero; },
  "set(Ljava/lang/Object;Ljava/lang/Object;)V": function (this: JFieldUpdater, o: any, v: unknown) { o[this.prop] = v; },
  "lazySet(Ljava/lang/Object;Ljava/lang/Object;)V": function (this: JFieldUpdater, o: any, v: unknown) { o[this.prop] = v; },
  "compareAndSet(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)Z": function (this: JFieldUpdater, o: any, e: unknown, v: unknown) {
    const cur = o[this.prop] ?? zero;
    if (cur !== e && !(cur === zero && e === null)) return 0;
    o[this.prop] = v; return 1;
  },
  "getAndSet(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;": function (this: JFieldUpdater, o: any, v: unknown) {
    const old = o[this.prop] ?? zero; o[this.prop] = v; return old;
  },
});
rt.register({
  name: "java/util/concurrent/atomic/AtomicReferenceFieldUpdater", ctor: class extends JFieldUpdater {},
  methods: {
    "static newUpdater(Ljava/lang/Class;Ljava/lang/Class;Ljava/lang/String;)Ljava/util/concurrent/atomic/AtomicReferenceFieldUpdater;":
      (cls: any, _vc: any, name: string) => mkUpdater("java/util/concurrent/atomic/AtomicReferenceFieldUpdater", cls, name),
    ...updaterCommon(null),
  },
});
rt.register({
  name: "java/util/concurrent/atomic/AtomicLongFieldUpdater", ctor: class extends JFieldUpdater {},
  methods: {
    "static newUpdater(Ljava/lang/Class;Ljava/lang/String;)Ljava/util/concurrent/atomic/AtomicLongFieldUpdater;":
      (cls: any, name: string) => mkUpdater("java/util/concurrent/atomic/AtomicLongFieldUpdater", cls, name),
    "get(Ljava/lang/Object;)J": function (this: JFieldUpdater, o: any) { return o[this.prop] ?? 0n; },
    "set(Ljava/lang/Object;J)V": function (this: JFieldUpdater, o: any, v: bigint) { o[this.prop] = v; },
    "lazySet(Ljava/lang/Object;J)V": function (this: JFieldUpdater, o: any, v: bigint) { o[this.prop] = v; },
    "incrementAndGet(Ljava/lang/Object;)J": function (this: JFieldUpdater, o: any) { return (o[this.prop] = BigInt.asIntN(64, (o[this.prop] ?? 0n) + 1n)); },
    "getAndIncrement(Ljava/lang/Object;)J": function (this: JFieldUpdater, o: any) { const old = o[this.prop] ?? 0n; o[this.prop] = BigInt.asIntN(64, old + 1n); return old; },
    "getAndDecrement(Ljava/lang/Object;)J": function (this: JFieldUpdater, o: any) { const old = o[this.prop] ?? 0n; o[this.prop] = BigInt.asIntN(64, old - 1n); return old; },
    "decrementAndGet(Ljava/lang/Object;)J": function (this: JFieldUpdater, o: any) { return (o[this.prop] = BigInt.asIntN(64, (o[this.prop] ?? 0n) - 1n)); },
    "getAndAdd(Ljava/lang/Object;J)J": function (this: JFieldUpdater, o: any, d: bigint) { const old = o[this.prop] ?? 0n; o[this.prop] = BigInt.asIntN(64, old + d); return old; },
    "addAndGet(Ljava/lang/Object;J)J": function (this: JFieldUpdater, o: any, d: bigint) { return (o[this.prop] = BigInt.asIntN(64, (o[this.prop] ?? 0n) + d)); },
    "compareAndSet(Ljava/lang/Object;JJ)Z": function (this: JFieldUpdater, o: any, e: bigint, v: bigint) {
      if ((o[this.prop] ?? 0n) !== e) return 0;
      o[this.prop] = v; return 1;
    },
    "getAndSet(Ljava/lang/Object;J)J": function (this: JFieldUpdater, o: any, v: bigint) { const old = o[this.prop] ?? 0n; o[this.prop] = v; return old; },
  },
});
rt.register({
  name: "java/util/concurrent/atomic/AtomicIntegerFieldUpdater", ctor: class extends JFieldUpdater {},
  methods: {
    "static newUpdater(Ljava/lang/Class;Ljava/lang/String;)Ljava/util/concurrent/atomic/AtomicIntegerFieldUpdater;":
      (cls: any, name: string) => mkUpdater("java/util/concurrent/atomic/AtomicIntegerFieldUpdater", cls, name),
    "get(Ljava/lang/Object;)I": function (this: JFieldUpdater, o: any) { return o[this.prop] ?? 0; },
    "set(Ljava/lang/Object;I)V": function (this: JFieldUpdater, o: any, v: number) { o[this.prop] = v; },
    "lazySet(Ljava/lang/Object;I)V": function (this: JFieldUpdater, o: any, v: number) { o[this.prop] = v; },
    "incrementAndGet(Ljava/lang/Object;)I": function (this: JFieldUpdater, o: any) { return (o[this.prop] = ((o[this.prop] ?? 0) + 1) | 0); },
    "getAndIncrement(Ljava/lang/Object;)I": function (this: JFieldUpdater, o: any) { const old = o[this.prop] ?? 0; o[this.prop] = (old + 1) | 0; return old; },
    "decrementAndGet(Ljava/lang/Object;)I": function (this: JFieldUpdater, o: any) { return (o[this.prop] = ((o[this.prop] ?? 0) - 1) | 0); },
    "getAndDecrement(Ljava/lang/Object;)I": function (this: JFieldUpdater, o: any) { const old = o[this.prop] ?? 0; o[this.prop] = (old - 1) | 0; return old; },
    "getAndAdd(Ljava/lang/Object;I)I": function (this: JFieldUpdater, o: any, d: number) { const old = o[this.prop] ?? 0; o[this.prop] = (old + d) | 0; return old; },
    "addAndGet(Ljava/lang/Object;I)I": function (this: JFieldUpdater, o: any, d: number) { return (o[this.prop] = ((o[this.prop] ?? 0) + d) | 0); },
    "compareAndSet(Ljava/lang/Object;II)Z": function (this: JFieldUpdater, o: any, e: number, v: number) {
      if ((o[this.prop] ?? 0) !== e) return 0;
      o[this.prop] = v; return 1;
    },
    "getAndSet(Ljava/lang/Object;I)I": function (this: JFieldUpdater, o: any, v: number) { const old = o[this.prop] ?? 0; o[this.prop] = v; return old; },
  },
});

