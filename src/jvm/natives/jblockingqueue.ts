import { rt, JObj, type NativeSpec, driven, type Gen } from "../runtime";
import { vcall } from "./jlang";
import { JList, mkIter, listMethods, JPriorityQueue, pqInsert, priorityQueueMethods, toJsArray } from "./jutil";
import type { JTimeUnit } from "./jconc";
import { clearGuestTimeout, setGuestTimeout, type GuestTimer } from "../../guest-clock";

type WaitingQueue = { a: unknown[]; takers: ((value: unknown) => void)[] };

async function drainQueue(this: WaitingQueue, c: unknown, max = 0x7fffffff): Promise<number> {
  if (c == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
  if (c === this) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Cannot drain a queue to itself");
  const batch = this.a.splice(0, Math.max(0, max));
  for (const value of batch) await vcall(c, "add", "(Ljava/lang/Object;)Z", value);
  return batch.length;
}
const takeFirst = function (this: WaitingQueue): unknown {
  return this.a.length ? this.a.shift() : new Promise((resolve) => this.takers.push(resolve));
};

const timedPoll = function (this: WaitingQueue, d: bigint, u: JTimeUnit): unknown {
  if (this.a.length) return this.a.shift();
  return new Promise((resolve) => {
    const taker = (v: unknown) => resolve(v);
    this.takers.push(taker);
    setTimeout(() => {
      const i = this.takers.indexOf(taker);
      if (i >= 0) { this.takers.splice(i, 1); resolve(null); }
    }, Number(d) * u.ms);
  });
};

class JBlockingQueue extends JList {
  capacity = 0x7fffffff;
  reserved = 0;
  takers: ((v: unknown) => void)[] = [];
  putters: { value: unknown; front: boolean; done: (accepted: number) => void }[] = [];
  enqueue(value: unknown, front = false): number {
    if (value == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    const taker = this.takers.shift();
    if (taker) { taker(value); return 1; }
    if (this.a.length + this.reserved >= this.capacity) return 0;
    if (front) this.a.unshift(value); else this.a.push(value);
    return 1;
  }
  refill(): void {
    while (this.putters.length && (this.takers.length || this.a.length + this.reserved < this.capacity)) {
      const pending = this.putters.shift()!;
      this.enqueue(pending.value, pending.front); pending.done(1);
    }
  }
  put(value: unknown, front = false, timeout?: number): number | Promise<number> {
    if (this.enqueue(value, front)) return 1;
    if (timeout !== undefined && timeout <= 0) return 0;
    return new Promise(resolve => {
      let timer: GuestTimer | undefined;
      const pending = { value, front, done: (accepted: number) => { if (timer) clearGuestTimeout(timer); resolve(accepted); } };
      this.putters.push(pending);
      if (timeout !== undefined) timer = setGuestTimeout(() => {
        this.putters.splice(this.putters.indexOf(pending), 1); pending.done(0);
      }, timeout);
    });
  }
  poll(last = false): unknown {
    if (this.a.length) {
      const value = last ? this.a.pop() : this.a.shift(); this.refill(); return value;
    }
    const pending = this.putters.shift();
    if (!pending) return null;
    pending.done(1); return pending.value;
  }
  take(last = false, timeout?: number): unknown {
    const value = this.poll(last);
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
  removeAt(index: number): void { this.a.splice(index, 1); this.refill(); }
}
const queueAdd = function (this: JBlockingQueue, value: unknown, front = false): number {
  if (!this.enqueue(value, front)) throw rt.mkThrowable("java/lang/IllegalStateException", "Queue full");
  return 1;
};
const queueCapacity = function (this: JBlockingQueue, capacity: number): void {
  if (capacity <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
  this.capacity = capacity;
};
async function drainTo(this: JBlockingQueue, collection: unknown, max = 0x7fffffff) {
  if (collection == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
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
async function removeOccurrence(this: JBlockingQueue, value: unknown, last = false): Promise<number> {
  const index = await vcall(this, last ? "lastIndexOf" : "indexOf", "(Ljava/lang/Object;)I", value);
  if (index < 0) return 0;
  this.removeAt(index); return 1;
}
const queueMethods: NonNullable<NativeSpec["methods"]> = {
  ...Object.fromEntries(Object.entries(listMethods()).filter(([k]) => !k.startsWith("<init>"))),
  "<init>()V": function () {},
  "<init>(I)V": queueCapacity,
  "<init>(IZ)V": queueCapacity,
  "<init>(Z)V": function () {},
  "<init>(Ljava/util/Collection;)V": driven(function* (this: JBlockingQueue, c: unknown): Gen {
    for (const v of (yield toJsArray(c))) this.enqueue(v);
  }),
  "put(Ljava/lang/Object;)V": function (this: JBlockingQueue, value: unknown) { return this.put(value); },
  "offer(Ljava/lang/Object;)Z": function (this: JBlockingQueue, value: unknown) { return this.enqueue(value); },
  "offer(Ljava/lang/Object;JLjava/util/concurrent/TimeUnit;)Z": function (this: JBlockingQueue, value: unknown, duration: bigint, unit: JTimeUnit) { return this.put(value, false, Number(duration) * unit.ms); },
  "add(Ljava/lang/Object;)Z": queueAdd,
  "addAll(Ljava/util/Collection;)Z": driven(function* (this: JBlockingQueue, collection: unknown): Gen {
    if (collection === this) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    const values = (yield toJsArray(collection));
    for (const value of values) queueAdd.call(this, value);
    return values.length ? 1 : 0;
  }),
  "remainingCapacity()I": function (this: JBlockingQueue) { return this.capacity - this.a.length - this.reserved; },
  "take()Ljava/lang/Object;": function (this: JBlockingQueue) { return this.take(); },
  "poll()Ljava/lang/Object;": function (this: JBlockingQueue) { return this.poll(); },
  "poll(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;": function (this: JBlockingQueue, duration: bigint, unit: JTimeUnit) { return this.take(false, Number(duration) * unit.ms); },
  "remove()Ljava/lang/Object;": function (this: JBlockingQueue) {
    const value = this.poll(); if (value === null) throw rt.mkThrowable("java/util/NoSuchElementException", null); return value;
  },
  "remove(Ljava/lang/Object;)Z": removeOccurrence,
  "iterator()Ljava/util/Iterator;": function (this: JBlockingQueue) { return mkIter(this.a, this); },
  "clear()V": function (this: JBlockingQueue) { this.a.length = 0; this.refill(); },
  "drainTo(Ljava/util/Collection;)I": drainTo,
  "drainTo(Ljava/util/Collection;I)I": drainTo,
};

const dequeMethods: NonNullable<NativeSpec["methods"]> = {
  "putLast(Ljava/lang/Object;)V": queueMethods["put(Ljava/lang/Object;)V"],
  "offerLast(Ljava/lang/Object;)Z": queueMethods["offer(Ljava/lang/Object;)Z"],
  "addLast(Ljava/lang/Object;)V": function (this: JBlockingQueue, value: unknown) { queueAdd.call(this, value); },
  "takeFirst()Ljava/lang/Object;": queueMethods["take()Ljava/lang/Object;"],
  "pollFirst()Ljava/lang/Object;": queueMethods["poll()Ljava/lang/Object;"],
  "peekFirst()Ljava/lang/Object;": queueMethods["peek()Ljava/lang/Object;"],
  "removeFirstOccurrence(Ljava/lang/Object;)Z": removeOccurrence,
  "putFirst(Ljava/lang/Object;)V": function (this: JBlockingQueue, value: unknown) { return this.put(value, true); },
  "offerFirst(Ljava/lang/Object;)Z": function (this: JBlockingQueue, value: unknown) { return this.enqueue(value, true); },
  "addFirst(Ljava/lang/Object;)V": function (this: JBlockingQueue, value: unknown) { queueAdd.call(this, value, true); },
  "takeLast()Ljava/lang/Object;": function (this: JBlockingQueue) { return this.take(true); },
  "pollLast()Ljava/lang/Object;": function (this: JBlockingQueue) { return this.poll(true); },
  "peekLast()Ljava/lang/Object;": function (this: JBlockingQueue) { return this.a[this.a.length - 1] ?? null; },
  "removeLastOccurrence(Ljava/lang/Object;)Z": function (this: JBlockingQueue, value: unknown) { return removeOccurrence.call(this, value, true); },
};
for (const name of ["LinkedBlockingQueue", "SynchronousQueue", "ArrayBlockingQueue", "LinkedTransferQueue", "LinkedBlockingDeque"]) {
  rt.register({
    name: "java/util/concurrent/" + name,
    ctor: class extends JBlockingQueue { override capacity = name === "SynchronousQueue" ? 0 : 0x7fffffff; },
    ifaces: [...(name === "LinkedBlockingDeque" ? ["java/util/concurrent/BlockingDeque", "java/util/Deque"] : []),
      "java/util/concurrent/BlockingQueue", "java/util/Queue", "java/util/Collection", "java/lang/Iterable"],
    methods: name === "LinkedBlockingDeque" ? { ...queueMethods, ...dequeMethods } : queueMethods,
  });
}
// PriorityBlockingQueue: the sorted queue with a parking take(); a parked taker receives the
// element that would have become the head
class JPriorityBlockingQueue extends JPriorityQueue {
  takers: ((v: unknown) => void)[] = [];
  // A comparator can suspend, so all queue mutations must wait for its insertion to finish.
  private pending: Promise<unknown> = Promise.resolve();
  locked<T>(operation: () => T | Promise<T>): Promise<T> {
    const next = this.pending.then(operation);
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }
}
const priorityMethods = priorityQueueMethods();
const priorityRemove = priorityMethods["remove(Ljava/lang/Object;)Z"] as (this: JPriorityQueue, v: unknown) => unknown;
function pbqPut(this: JPriorityBlockingQueue, v: unknown) {
  return this.locked(async () => {
    if (v == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    const taker = this.takers.shift();
    if (taker) { taker(v); return 1; }
    await pqInsert(this, v);
    return 1;
  });
}
rt.register({
  name: "java/util/concurrent/PriorityBlockingQueue", ctor: JPriorityBlockingQueue,
  ifaces: ["java/util/concurrent/BlockingQueue", "java/util/Queue", "java/util/Collection", "java/lang/Iterable", "java/io/Serializable"],
  methods: {
    ...priorityMethods,
    "put(Ljava/lang/Object;)V": pbqPut,
    "offer(Ljava/lang/Object;)Z": pbqPut,
    "add(Ljava/lang/Object;)Z": pbqPut,
    "offer(Ljava/lang/Object;JLjava/util/concurrent/TimeUnit;)Z": pbqPut,
    "addAll(Ljava/util/Collection;)Z": driven(function* (this: JPriorityBlockingQueue, c: unknown): Gen {
      if (c === this) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
      const values = (yield toJsArray(c));
      for (const value of values) (yield pbqPut.call(this, value));
      return values.length ? 1 : 0;
    }),
    "remove(Ljava/lang/Object;)Z": function (this: JPriorityBlockingQueue, v: unknown) {
      return this.locked(() => priorityRemove.call(this, v));
    },
    "remove()Ljava/lang/Object;": function (this: JPriorityBlockingQueue) {
      return this.locked(() => {
        if (!this.a.length) throw rt.mkThrowable("java/util/NoSuchElementException", null);
        return this.a.shift();
      });
    },
    "clear()V": function (this: JPriorityBlockingQueue) { return this.locked(() => { this.a.length = 0; }); },
    "poll()Ljava/lang/Object;": function (this: JPriorityBlockingQueue) { return this.locked(() => this.a.shift() ?? null); },
    "take()Ljava/lang/Object;": function (this: JPriorityBlockingQueue) {
      return this.locked(() => ({ value: takeFirst.call(this) })).then(({ value }) => value);
    },
    "poll(JLjava/util/concurrent/TimeUnit;)Ljava/lang/Object;": function (this: JPriorityBlockingQueue, d: bigint, u: JTimeUnit) {
      return this.locked(() => ({ value: timedPoll.call(this, d, u) })).then(({ value }) => value);
    },
    "remainingCapacity()I": () => 0x7fffffff,
    "drainTo(Ljava/util/Collection;)I": function (this: JPriorityBlockingQueue, c: unknown) {
      return this.locked(() => drainQueue.call(this, c));
    },
    "drainTo(Ljava/util/Collection;I)I": function (this: JPriorityBlockingQueue, c: unknown, max: number) {
      return this.locked(() => drainQueue.call(this, c, max));
    },
  },
});

rt.register({
  name: "java/util/concurrent/ConcurrentLinkedQueue", ctor: class extends JList {}, sup: "java/util/AbstractQueue",
  ifaces: ["java/util/Queue", "java/util/Collection", "java/lang/Iterable"], methods: listMethods(),
});
rt.register({ name: "java/util/concurrent/BlockingQueue", ctor: class extends JObj {}, ifaces: ["java/util/Queue"] });
rt.register({ name: "java/util/concurrent/BlockingDeque", ctor: class extends JObj {}, ifaces: ["java/util/concurrent/BlockingQueue", "java/util/Deque"] });
