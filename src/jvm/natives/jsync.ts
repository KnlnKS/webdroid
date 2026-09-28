import { rt, JObj, type NativeSpec, driven, type Gen } from "../runtime";
import { parkTimeout, unparkTimeout } from "../yield";
import { vcall, JThread, curThread, park, defineException } from "./jlang";
import type { JTimeUnit } from "./jconc";
import { guestNow, setGuestTimeout } from "../../guest-clock";

/** an interruptible wait's entry check: a pending interrupt is consumed and thrown */
function throwIfInterrupted(thread: JThread): void {
  if (thread.interrupted) { thread.interrupted = 0; throw rt.mkThrowable("java/lang/InterruptedException", null); }
}

// ── locks
class JLock extends JObj {
  owner: JThread | null = null;
  held = 0;
  fair = false;
  queue: { thread: JThread; wake: () => void }[] = [];
  acquire(thread: JThread, barge = false): boolean {
    if (this.owner === thread) { this.held++; return true; }
    if (this.owner || !barge && this.fair && this.queue.length) return false;
    this.owner = thread; this.held = 1; return true;
  }
  check(thread: JThread): void {
    if (this.owner !== thread) throw rt.mkThrowable("java/lang/IllegalMonitorStateException", "Lock not held by current thread");
  }
  release(thread: JThread): void {
    this.check(thread);
    if (--this.held) return;
    this.owner = null;
    const next = this.queue.shift();
    if (next) { this.acquire(next.thread, true); next.wake(); }
  }
  lock(thread: JThread, interruptible: boolean, timeout?: number): boolean | Promise<boolean> {
    if (interruptible) throwIfInterrupted(thread);
    if (this.acquire(thread)) return true;
    if (timeout !== undefined && timeout <= 0) return false;
    const arm = (wake: () => void) => {
      const waiter = { thread, wake }; this.queue.push(waiter);
      return () => { const index = this.queue.indexOf(waiter); if (index >= 0) this.queue.splice(index, 1); };
    };
    return interruptible ? park(thread, arm, timeout) : new Promise<boolean>((resolve) => arm(() => resolve(true)));
  }
}
rt.register({
  name: "java/util/concurrent/locks/ReentrantLock", ctor: JLock,
  ifaces: ["java/util/concurrent/locks/Lock"],
  methods: {
    "<init>()V": function () {},
    "<init>(Z)V": function (this: JLock, fair: number) { this.fair = !!fair; },
    "lock()V": function (this: JLock) { return this.lock(curThread, false); },
    "unlock()V": function (this: JLock) { this.release(curThread); },
    "tryLock()Z": function (this: JLock) { return this.acquire(curThread, true) ? 1 : 0; },
    "tryLock(JLjava/util/concurrent/TimeUnit;)Z": driven(function* (this: JLock, duration: bigint, unit: JTimeUnit): Gen {
      return (yield this.lock(curThread, true, Number(duration) * unit.ms)) ? 1 : 0;
    }),
    "lockInterruptibly()V": function (this: JLock) { return this.lock(curThread, true); },
    "getHoldCount()I": function (this: JLock) { return this.owner === curThread ? this.held : 0; },
    "isHeldByCurrentThread()Z": function (this: JLock) { return this.owner === curThread ? 1 : 0; },
    "isLocked()Z": function (this: JLock) { return this.held > 0 ? 1 : 0; },
    "isFair()Z": function (this: JLock) { return this.fair ? 1 : 0; },
    "hasQueuedThreads()Z": function (this: JLock) { return this.queue.length ? 1 : 0; },
    "getQueueLength()I": function (this: JLock) { return this.queue.length; },
    "newCondition()Ljava/util/concurrent/locks/Condition;": function (this: JLock) {
      const condition: JCondition = rt.make("webdroid/Condition"); condition.lock = this; return condition;
    },
  },
});
class JCondition extends JObj {
  lock!: JLock;
  q: (() => void)[] = [];
  async await(interruptible: boolean, ms?: number): Promise<boolean> {
    const thread = curThread;
    if (interruptible) throwIfInterrupted(thread);
    this.lock.check(thread);
    const holds = this.lock.held;
    this.lock.held = 1; this.lock.release(thread);
    let acquisition: boolean | Promise<boolean> | undefined;
    const arm = (wake: () => void) => {
      const transfer = () => { acquisition = this.lock.lock(thread, false); };
      const signal = () => { transfer(); wake(); };
      this.q.push(signal);
      return () => { const index = this.q.indexOf(signal); if (index >= 0) this.q.splice(index, 1); transfer(); };
    };
    try {
      return await (interruptible ? park(thread, arm, ms) : new Promise<boolean>((resolve) => arm(() => resolve(true))));
    } finally {
      await (acquisition ?? this.lock.lock(thread, false));
      this.lock.held = holds;
    }
  }
}
rt.register({
  name: "webdroid/Condition", ctor: JCondition, ifaces: ["java/util/concurrent/locks/Condition"],
  methods: {
    "await()V": function (this: JCondition) { return this.await(true); },
    "awaitUninterruptibly()V": function (this: JCondition) { return this.await(false); },
    "await(JLjava/util/concurrent/TimeUnit;)Z": driven(function* (this: JCondition, d: bigint, u: JTimeUnit): Gen {
      return (yield this.await(true, Number(d) * u.ms)) ? 1 : 0;
    }),
    "awaitNanos(J)J": driven(function* (this: JCondition, n: bigint): Gen {
      const start = guestNow(); yield this.await(true, Number(n) / 1e6);
      return n - BigInt(Math.round((guestNow() - start) * 1e6));
    }),
    "signal()V": function (this: JCondition) { this.lock.check(curThread); this.q.shift()?.(); },
    "signalAll()V": function (this: JCondition) { this.lock.check(curThread); for (const wake of this.q.splice(0)) wake(); },
  },
});

type BarrierGeneration = { broken: boolean; waiters: Set<() => void> };
class JCyclicBarrier extends JObj {
  parties = 0; remaining = 0; action: unknown = null;
  generation: BarrierGeneration = { broken: false, waiters: new Set() };
  tripping: Promise<void> | null = null;
  tripThread: JThread | null = null;
  breakGeneration(): void {
    this.generation.broken = true; this.remaining = this.parties;
    for (const wake of this.generation.waiters) wake(); this.generation.waiters.clear();
  }
  advance(): void {
    const previous = this.generation;
    this.generation = { broken: false, waiters: new Set() }; this.remaining = this.parties;
    for (const wake of previous.waiters) wake(); previous.waiters.clear();
  }
  async await(thread: JThread, timeout?: number): Promise<number> {
    if (this.tripping && this.tripThread !== thread) await this.tripping.catch(() => {});
    const generation = this.generation;
    if (generation.broken) throw rt.mkThrowable("java/util/concurrent/BrokenBarrierException", null);
    if (thread.interrupted) { thread.interrupted = 0; this.breakGeneration(); throw rt.mkThrowable("java/lang/InterruptedException", null); }
    const index = --this.remaining;
    if (index === 0) {
      try {
        if (this.action) { this.tripThread = thread; this.tripping = vcall(this.action, "run", "()V"); await this.tripping; }
        this.advance(); return 0;
      } catch (error) { this.breakGeneration(); throw error; }
      finally { this.tripping = null; this.tripThread = null; }
    }
    if (timeout !== undefined && timeout <= 0) { this.breakGeneration(); throw rt.mkThrowable("java/util/concurrent/TimeoutException", null); }
    let signalled: boolean;
    try {
      signalled = await park(thread, wake => { generation.waiters.add(wake); return () => { generation.waiters.delete(wake); }; }, timeout);
    } catch (error) {
      if (this.tripping) await this.tripping.catch(() => {});
      if (generation === this.generation && !generation.broken) { this.breakGeneration(); throw error; }
      thread.interrupted = 1;
      if (generation.broken) throw rt.mkThrowable("java/util/concurrent/BrokenBarrierException", null);
      return index;
    }
    if (this.tripping) await this.tripping.catch(() => {});
    if (generation.broken) throw rt.mkThrowable("java/util/concurrent/BrokenBarrierException", null);
    if (generation !== this.generation) return index;
    if (!signalled) { this.breakGeneration(); throw rt.mkThrowable("java/util/concurrent/TimeoutException", null); }
    throw rt.mkThrowable("java/lang/IllegalStateException", "Barrier woke without advancing");
  }
}
function initBarrier(this: JCyclicBarrier, parties: number, action: unknown = null): void {
  if (parties <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "parties <= 0");
  this.parties = this.remaining = parties; this.action = action;
}
rt.register({ name: "java/util/concurrent/CyclicBarrier", ctor: JCyclicBarrier, methods: {
  "<init>(I)V": initBarrier,
  "<init>(ILjava/lang/Runnable;)V": initBarrier,
  "getParties()I": function (this: JCyclicBarrier) { return this.parties; },
  "getNumberWaiting()I": function (this: JCyclicBarrier) { return this.parties - this.remaining; },
  "isBroken()Z": function (this: JCyclicBarrier) { return +this.generation.broken; },
  "await()I": function (this: JCyclicBarrier) { return this.await(curThread); },
  "await(JLjava/util/concurrent/TimeUnit;)I": function (this: JCyclicBarrier, duration: bigint, unit: JTimeUnit) { return this.await(curThread, Math.max(0, Number(duration) * unit.ms)); },
  "reset()V": driven(function* (this: JCyclicBarrier): Gen { if (this.tripping && this.tripThread !== curThread) yield this.tripping.catch(() => {}); this.breakGeneration(); this.advance(); }),
} });
defineException("java/util/concurrent/BrokenBarrierException", "java/lang/Exception");

class JCountDownLatch extends JObj {
  n = 0;
  waiters: (() => void)[] = [];
}
rt.register({
  name: "java/util/concurrent/CountDownLatch", ctor: JCountDownLatch,
  methods: {
    "<init>(I)V": function (this: JCountDownLatch, n: number) { this.n = n; },
    "countDown()V": function (this: JCountDownLatch) {
      if (this.n > 0 && --this.n === 0) for (const w of this.waiters.splice(0)) queueMicrotask(w);
    },
    "getCount()J": function (this: JCountDownLatch) { return BigInt(this.n); },
    "await()V": function (this: JCountDownLatch) {
      if (this.n === 0) return;
      return new Promise<void>((r) => this.waiters.push(r));
    },
    "await(JLjava/util/concurrent/TimeUnit;)Z": function (this: JCountDownLatch, d: bigint, u: JTimeUnit) {
      if (this.n === 0) return 1;
      return new Promise<number>((resolve) => {
        const done = () => resolve(1);
        this.waiters.push(done);
        setGuestTimeout(() => {
          const i = this.waiters.indexOf(done);
          if (i >= 0) { this.waiters.splice(i, 1); resolve(0); }
        }, Number(d) * u.ms);
      });
    },
  },
});

class JSemaphore extends JObj {
  permits = 0;
  q: { n: number; wake: () => void }[] = [];
  acquire(n: number, ms?: number): number | Promise<number> {
    if (this.permits >= n) { this.permits -= n; return 1; }
    if (ms !== undefined && ms <= 0) return 0;
    return new Promise<number>((r) => {
      const w = { n, wake: () => { unparkTimeout(id); r(1); } };
      this.q.push(w);
      const id = ms === undefined ? undefined : parkTimeout(() => { this.q.splice(this.q.indexOf(w), 1); r(0); }, ms);
    });
  }
  release(n: number): void {
    this.permits += n;
    while (this.q.length && this.q[0].n <= this.permits) { const w = this.q.shift()!; this.permits -= w.n; queueMicrotask(w.wake); }
  }
}
const TU = "Ljava/util/concurrent/TimeUnit;";
function initSemaphore(this: JSemaphore, n: number) { this.permits = n; }
function acquireOne(this: JSemaphore) { return this.acquire(1); }
rt.register({
  name: "java/util/concurrent/Semaphore", ctor: JSemaphore,
  methods: {
    "<init>(I)V": initSemaphore,
    "<init>(IZ)V": initSemaphore,
    "acquire()V": acquireOne,
    "acquire(I)V": function (this: JSemaphore, n: number) { return this.acquire(n); },
    "acquireUninterruptibly()V": acquireOne,
    "release()V": function (this: JSemaphore) { this.release(1); },
    "release(I)V": function (this: JSemaphore, n: number) { this.release(n); },
    "tryAcquire()Z": function (this: JSemaphore) { return this.acquire(1, 0); },
    "tryAcquire(I)Z": function (this: JSemaphore, n: number) { return this.acquire(n, 0); },
    [`tryAcquire(J${TU})Z`]: function (this: JSemaphore, t: bigint, u: JTimeUnit) { return this.acquire(1, Number(t) * u.ms); },
    [`tryAcquire(IJ${TU})Z`]: function (this: JSemaphore, n: number, t: bigint, u: JTimeUnit) { return this.acquire(n, Number(t) * u.ms); },
    "availablePermits()I": function (this: JSemaphore) { return this.permits; },
    "drainPermits()I": function (this: JSemaphore) { const permits = this.permits; this.permits = 0; return permits; },
  },
});

type RWWaiter = { thread: JThread; write: boolean; wake: () => void };
class JRWLock extends JObj {
  readers = new Map<JThread, number>();
  writer: JThread | null = null;
  writes = 0;
  fair = false;
  queue: RWWaiter[] = [];
  read: JRWInner | null = null;
  write: JRWInner | null = null;
  acquire(thread: JThread, write: boolean, barge = false): boolean {
    const reentrant = this.writer === thread || (!write && this.readers.has(thread));
    if (this.writer && this.writer !== thread || write && !this.writer && this.readers.size) return false;
    if (!barge && !reentrant && this.queue.length && (this.fair || !write && this.queue[0].write)) return false;
    if (write) { this.writer = thread; this.writes++; }
    else this.readers.set(thread, (this.readers.get(thread) ?? 0) + 1);
    return true;
  }
  drain() {
    while (this.queue.length) {
      const first = this.queue[0];
      if (!this.acquire(first.thread, first.write, true)) break;
      this.queue.shift(); first.wake();
    }
  }
  arm(thread: JThread, write: boolean, wake: () => void) {
    const waiter = { thread, write, wake };
    this.queue.push(waiter);
    return () => { const i = this.queue.indexOf(waiter); if (i >= 0) this.queue.splice(i, 1); this.drain(); };
  }
}
class JRWInner extends JObj {
  owner!: JRWLock;
  write = false;
  lock(interruptible: boolean, timeout?: number): void | boolean | Promise<boolean> {
    const thread = curThread;
    if (interruptible) throwIfInterrupted(thread);
    if (this.owner.acquire(thread, this.write)) return true;
    if (timeout !== undefined && timeout <= 0) return false;
    return interruptible ? park(thread, (wake) => this.owner.arm(thread, this.write, wake), timeout)
      : new Promise<boolean>((resolve) => this.owner.arm(thread, this.write, () => resolve(true)));
  }
}
const rwMethods: NativeSpec["methods"] = {
  "<init>(Ljava/util/concurrent/locks/ReentrantReadWriteLock;)V": function (this: JRWInner, owner: JRWLock) { this.owner = owner; },
  "lock()V": function (this: JRWInner) { return this.lock(false); },
  "lockInterruptibly()V": function (this: JRWInner) { return this.lock(true); },
  "tryLock()Z": function (this: JRWInner) { return this.owner.acquire(curThread, this.write, true) ? 1 : 0; },
  "tryLock(JLjava/util/concurrent/TimeUnit;)Z": driven(function* (this: JRWInner, duration: bigint, unit: JTimeUnit): Gen { return (yield this.lock(true, Number(duration) * unit.ms)) ? 1 : 0; }),
  "unlock()V": function (this: JRWInner) {
    const lock = this.owner, thread = curThread;
    if (this.write) {
      if (lock.writer !== thread) throw rt.mkThrowable("java/lang/IllegalMonitorStateException", "Write lock not held by current thread");
      if (!--lock.writes) lock.writer = null;
    } else {
      const count = lock.readers.get(thread) ?? 0;
      if (!count) throw rt.mkThrowable("java/lang/IllegalMonitorStateException", "Read lock not held by current thread");
      if (count === 1) lock.readers.delete(thread); else lock.readers.set(thread, count - 1);
    }
    lock.drain();
  },
  "newCondition()Ljava/util/concurrent/locks/Condition;": function (this: JRWInner) {
    if (!this.write) throw rt.mkThrowable("java/lang/UnsupportedOperationException", null);
    throw rt.unimplemented("ReentrantReadWriteLock.WriteLock.newCondition");
  },
};
function rwHandle(lock: JRWLock, write: boolean): JRWInner {
  const existing = write ? lock.write : lock.read;
  if (existing) return existing;
  const inner: JRWInner = rt.make("java/util/concurrent/locks/ReentrantReadWriteLock$" + (write ? "WriteLock" : "ReadLock"));
  inner.owner = lock;
  if (write) lock.write = inner; else lock.read = inner;
  return inner;
}
const readLock = function (this: JRWLock) { return rwHandle(this, false); };
const writeLock = function (this: JRWLock) { return rwHandle(this, true); };
rt.register({
  name: "java/util/concurrent/locks/ReentrantReadWriteLock", ctor: JRWLock,
  ifaces: ["java/util/concurrent/locks/ReadWriteLock", "java/io/Serializable"],
  methods: {
    "<init>()V": function () {},
    "<init>(Z)V": function (this: JRWLock, fair: number) { this.fair = !!fair; },
    "readLock()Ljava/util/concurrent/locks/ReentrantReadWriteLock$ReadLock;": readLock,
    "writeLock()Ljava/util/concurrent/locks/ReentrantReadWriteLock$WriteLock;": writeLock,
    "readLock()Ljava/util/concurrent/locks/Lock;": readLock,
    "writeLock()Ljava/util/concurrent/locks/Lock;": writeLock,
    "getReadHoldCount()I": function (this: JRWLock) { return this.readers.get(curThread) ?? 0; },
    "getWriteHoldCount()I": function (this: JRWLock) { return this.writer === curThread ? this.writes : 0; },
    "getReadLockCount()I": function (this: JRWLock) { let count = 0; for (const holds of this.readers.values()) count += holds; return count; },
    "isWriteLocked()Z": function (this: JRWLock) { return this.writes ? 1 : 0; },
    "isWriteLockedByCurrentThread()Z": function (this: JRWLock) { return this.writer === curThread ? 1 : 0; },
    "isFair()Z": function (this: JRWLock) { return this.fair ? 1 : 0; },
  },
});
rt.register({ name: "java/util/concurrent/locks/ReentrantReadWriteLock$ReadLock", ctor: class extends JRWInner {}, ifaces: ["java/util/concurrent/locks/Lock", "java/io/Serializable"], methods: rwMethods });
rt.register({ name: "java/util/concurrent/locks/ReentrantReadWriteLock$WriteLock", ctor: class extends JRWInner { write = true; }, ifaces: ["java/util/concurrent/locks/Lock", "java/io/Serializable"], methods: rwMethods });
rt.markers("java/util/concurrent/locks/ReadWriteLock", "java/util/concurrent/locks/Lock", "java/util/concurrent/locks/Condition");

// A parked thread wakes on its permit, its deadline, or an interrupt. The wake is a macrotask
// so the unparker's own chain runs to its next await first, and an untimed park still polls,
// as Java's spurious wakeups allow, so a permit lost to a stale thread identity cannot hang it.
function parkThread(t: JThread, timeoutMs = 1000): void | Promise<void> {
  if (t.permit) { t.permit = false; return; }
  return park(t, (wake) => { t.unpark = () => setTimeout(wake, 0); return () => { t.unpark = null; }; }, timeoutMs).then(() => { t.permit = false; });
}
rt.register({
  name: "java/util/concurrent/locks/LockSupport", ctor: class extends JObj {},
  methods: {
    "static park()V": () => parkThread(curThread),
    "static park(Ljava/lang/Object;)V": () => parkThread(curThread),
    "static parkNanos(J)V": (n: bigint) => parkThread(curThread, Number(n) / 1e6),
    "static parkNanos(Ljava/lang/Object;J)V": (_b: unknown, n: bigint) => parkThread(curThread, Number(n) / 1e6),
    "static unpark(Ljava/lang/Thread;)V": (t: JThread | null) => { if (!t) return; if (t.unpark) { t.unpark(); t.unpark = null; } else t.permit = true; },
  },
});
// ── AbstractQueuedSynchronizer: the state word, its CAS, and FIFO waiting in exclusive and shared
// modes; a subclass supplies tryAcquire/tryRelease (and the shared pair) as the JDK's does
class JAQS extends JObj { state = 0; q: (() => void)[] = []; owner: unknown = null; }
const D_TA = "(I)Z", D_TAS = "(I)I";
function aqsAcquireExclusive(this: JAQS, arg: number) { return aqsAcquire(this, arg, false); }
function aqsAcquireShared(this: JAQS, arg: number) { return aqsAcquire(this, arg, true); }
async function aqsAcquire(self: JAQS, arg: number, shared: boolean): Promise<void> {
  for (;;) {
    const ok = shared ? ((await vcall(self, "tryAcquireShared", D_TAS, arg)) as number) >= 0 : !!(await vcall(self, "tryAcquire", D_TA, arg));
    if (ok) { if (shared) for (const w of self.q.splice(0)) w(); return; }   // a shared acquire propagates
    await new Promise<void>((r) => self.q.push(r));
  }
}
async function aqsAcquireTimed(self: JAQS, arg: number, shared: boolean, ns: bigint): Promise<number> {
  let done = false;
  const t = parkTimeout(() => { done = true; for (const w of self.q.splice(0)) w(); }, Number(ns) / 1e6);
  for (;;) {
    if (shared ? ((await vcall(self, "tryAcquireShared", D_TAS, arg)) as number) >= 0 : await vcall(self, "tryAcquire", D_TA, arg)) {
      unparkTimeout(t);
      if (shared) for (const w of self.q.splice(0)) w();
      return 1;
    }
    if (done) return 0;
    await new Promise<void>((r) => self.q.push(r));
  }
}
async function aqsRelease(self: JAQS, arg: number, shared: boolean): Promise<number> {
  const ok = await vcall(self, shared ? "tryReleaseShared" : "tryRelease", D_TA, arg);
  if (ok) for (const w of self.q.splice(0)) w();
  return ok ? 1 : 0;
}
rt.register({
  name: "java/util/concurrent/locks/AbstractQueuedSynchronizer", ctor: JAQS, sup: "java/util/concurrent/locks/AbstractOwnableSynchronizer",
  methods: {
    "<init>()V": function () {},
    "getState()I": function (this: JAQS) { return this.state; },
    "setState(I)V": function (this: JAQS, v: number) { this.state = v; },
    "compareAndSetState(II)Z": function (this: JAQS, e: number, v: number) { if (this.state !== e) return 0; this.state = v; return 1; },
    "acquire(I)V": aqsAcquireExclusive,
    "acquireInterruptibly(I)V": aqsAcquireExclusive,
    "acquireShared(I)V": aqsAcquireShared,
    "acquireSharedInterruptibly(I)V": aqsAcquireShared,
    "tryAcquireNanos(IJ)Z": function (this: JAQS, a: number, ns: bigint) { return aqsAcquireTimed(this, a, false, ns); },
    "tryAcquireSharedNanos(IJ)Z": function (this: JAQS, a: number, ns: bigint) { return aqsAcquireTimed(this, a, true, ns); },
    "release(I)Z": function (this: JAQS, a: number) { return aqsRelease(this, a, false); },
    "releaseShared(I)Z": function (this: JAQS, a: number) { return aqsRelease(this, a, true); },
    "hasQueuedThreads()Z": function (this: JAQS) { return this.q.length ? 1 : 0; },
    "hasQueuedPredecessors()Z": function (this: JAQS) { return this.q.length ? 1 : 0; },
    "getQueueLength()I": function (this: JAQS) { return this.q.length; },
    "isQueued(Ljava/lang/Thread;)Z": () => 0,
    "getExclusiveOwnerThread()Ljava/lang/Thread;": function (this: JAQS) { return this.owner; },
    "setExclusiveOwnerThread(Ljava/lang/Thread;)V": function (this: JAQS, t: unknown) { this.owner = t; },
    "isHeldExclusively()Z": function (this: JAQS) { return this.owner === curThread ? 1 : 0; },
  },
});
rt.register({
  name: "java/util/concurrent/locks/AbstractOwnableSynchronizer", ctor: class extends JObj { owner: unknown = null; },
  methods: {
    "<init>()V": function () {},
    "getExclusiveOwnerThread()Ljava/lang/Thread;": function (this: { owner: unknown }) { return this.owner; },
    "setExclusiveOwnerThread(Ljava/lang/Thread;)V": function (this: { owner: unknown }, t: unknown) { this.owner = t; },
  },
});
