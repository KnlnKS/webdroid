import { rt, JObj, type NativeSpec, driven, without, type Gen } from "../runtime";
import { vcall } from "./jlang";
import { JList, mkIter, listMethods, toJsArray, LIST_ONLY, INDEX_OF, DEQUE_ONLY, SEQUENCED, CAPACITY } from "./jutil";
import type { JTimeUnit } from "./jconc";
import { clearGuestTimeout, setGuestTimeout, type GuestTimer } from "../../guest-clock";

class JBlockingQueue extends JList {
  capacity = 0x7fffffff;
  reserved = 0;
  takers: ((v: unknown) => void)[] = [];
  putters: { value: unknown; done: (accepted: number) => void }[] = [];
  enqueue(value: unknown): number {
    if (value == null) rt.npe();
    const taker = this.takers.shift();
    if (taker) { taker(value); return 1; }
    if (this.a.length + this.reserved >= this.capacity) return 0;
    this.a.push(value);
    return 1;
  }
  refill(): void {
    while (this.putters.length && (this.takers.length || this.a.length + this.reserved < this.capacity)) {
      const pending = this.putters.shift()!;
      this.enqueue(pending.value); pending.done(1);
    }
  }
  put(value: unknown, timeout?: number): number | Promise<number> {
    if (this.enqueue(value)) return 1;
    if (timeout !== undefined && timeout <= 0) return 0;
    return new Promise(resolve => {
      let timer: GuestTimer | undefined;
      const pending = { value, done: (accepted: number) => { if (timer) clearGuestTimeout(timer); resolve(accepted); } };
      this.putters.push(pending);
      if (timeout !== undefined) timer = setGuestTimeout(() => {
        this.putters.splice(this.putters.indexOf(pending), 1); pending.done(0);
      }, timeout);
    });
  }
  poll(): unknown {
    if (this.a.length) { const value = this.a.shift(); this.refill(); return value; }
    const pending = this.putters.shift();
    if (!pending) return null;
    pending.done(1); return pending.value;
  }
  take(timeout?: number): unknown {
    const value = this.poll();
    if (value !== null) return value;
    if (timeout !== undefined && timeout <= 0) return null;
    return new Promise(resolve => {
      let timer: GuestTimer | undefined;
      const taker = (value: unknown) => { if (timer) clearGuestTimeout(timer); resolve(value); };
      this.takers.push(taker);
      if (timeout !== undefined) timer = setGuestTimeout(() => {
        this.takers.splice(this.takers.indexOf(taker), 1); taker(null);
      }, timeout);
    });
  }
}
const queueAdd = function (this: JBlockingQueue, value: unknown): number {
  if (!this.enqueue(value)) throw rt.mkThrowable("java/lang/IllegalStateException", "Queue full");
  return 1;
};
const queueCapacity = function (this: JBlockingQueue, capacity: number): void {
  if (capacity <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
  this.capacity = capacity;
};
async function drainTo(this: JBlockingQueue, collection: unknown, max = 0x7fffffff) {
  if (collection == null) rt.npe();
  if (collection === this) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
  if (max <= 0) return 0;
  const batch = this.a.splice(0, max);
  this.reserved += batch.length;
  let count = 0;
  try {
    for (const value of batch) { await vcall(collection, "add", "(Ljava/lang/Object;)Z", value); count++; }
  } finally {
    if (count < batch.length) this.a.unshift(...batch.slice(count));
    this.reserved -= batch.length; this.refill();
  }
  return count;
}
async function removeOccurrence(this: JBlockingQueue, value: unknown): Promise<number> {
  const index = await vcall(this, "indexOf", "(Ljava/lang/Object;)I", value);
  if (index < 0) return 0;
  this.a.splice(index, 1); this.refill(); return 1;
}
const queueMethods: NonNullable<NativeSpec["methods"]> = {
  ...Object.fromEntries(Object.entries(without(listMethods(), LIST_ONLY, INDEX_OF, CAPACITY, DEQUE_ONLY, SEQUENCED)).filter(([k]) => !k.startsWith("<init>"))),
  "<init>()V": function () {},
  "<init>(I)V": queueCapacity,
  "<init>(Ljava/util/Collection;)V": driven(function* (this: JBlockingQueue, c: unknown): Gen {
    for (const v of yield toJsArray(c)) this.enqueue(v);
  }),
  "put(Ljava/lang/Object;)V": function (this: JBlockingQueue, value: unknown) { return this.put(value); },
  "offer(Ljava/lang/Object;)Z": function (this: JBlockingQueue, value: unknown) { return this.enqueue(value); },
  "offer(Ljava/lang/Object;JLjava/util/concurrent/TimeUnit;)Z": function (this: JBlockingQueue, value: unknown, duration: bigint, unit: JTimeUnit) { return this.put(value, Number(duration) * unit.ms); },
  "add(Ljava/lang/Object;)Z": queueAdd,
  "addAll(Ljava/util/Collection;)Z": driven(function* (this: JBlockingQueue, collection: unknown): Gen {
    if (collection === this) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    const values = yield toJsArray(collection);
    for (const value of values) queueAdd.call(this, value);
    return values.length ? 1 : 0;
  }),
  "remainingCapacity()I": function (this: JBlockingQueue) { return this.capacity - this.a.length - this.reserved; },
  "take()Ljava/lang/Object;": function (this: JBlockingQueue) { return this.take(); },
  "poll()Ljava/lang/Object;": function (this: JBlockingQueue) { return this.poll(); },
  "poll(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;": function (this: JBlockingQueue, duration: bigint, unit: JTimeUnit) { return this.take(Number(duration) * unit.ms); },
  "remove()Ljava/lang/Object;": function (this: JBlockingQueue) {
    const value = this.poll(); if (value === null) throw rt.mkThrowable("java/util/NoSuchElementException", null); return value;
  },
  "remove(Ljava/lang/Object;)Z": removeOccurrence,
  "iterator()Ljava/util/Iterator;": function (this: JBlockingQueue) { return mkIter(this.a, this); },
  "clear()V": function (this: JBlockingQueue) { this.a.length = 0; this.refill(); },
  "drainTo(Ljava/util/Collection;)I": drainTo,
  "drainTo(Ljava/util/Collection;I)I": drainTo,
};

rt.register({
  name: "java/util/concurrent/LinkedBlockingQueue", ctor: JBlockingQueue,
  ifaces: ["java/util/concurrent/BlockingQueue", "java/util/Queue", "java/util/Collection", "java/lang/Iterable"],
  methods: queueMethods,
});

rt.register({
  name: "java/util/concurrent/ConcurrentLinkedQueue", ctor: class extends JList {}, sup: "java/util/AbstractQueue",
  ifaces: ["java/util/Queue", "java/util/Collection", "java/lang/Iterable"],
  methods: without(listMethods(), ["<init>(I)V"], LIST_ONLY, INDEX_OF, CAPACITY, DEQUE_ONLY, SEQUENCED),
});
rt.register({ name: "java/util/concurrent/BlockingQueue", ctor: class extends JObj {}, ifaces: ["java/util/Queue"] });
