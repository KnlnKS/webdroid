// Threads. A Java thread is a strand: a JSPI stack (a `promising` entry) that runs until it blocks. The blocking operations are Suspending
// imports (`host.block`), so a strand that waits costs nothing and the one that resumes is whichever promise the waker resolved. The globals
// `sid` (strand id) and `thr` (the Thread) name the running strand; compiled code keeps them in locals across a blocking call and sets them
// again after it, because who ran in between is not up to the strand (compiler/hostcalls.ts emits those calls).
//
// This file has the runtime functions and intrinsics compiled code uses (Thread, Object.wait/notify, park, monitors, class
// initialization waits, the fuel yield) and the Sched that answers `host.sync` and `host.block`.
import type { Code } from "../compiler/code.ts";
import type { Compiler, Intrinsic } from "../compiler/j2w.ts";
import type { Kind } from "../compiler/program.ts";
import { rt } from "../compiler/rtfns.ts";
import { OP } from "../compiler/code.ts";
import { T } from "../compiler/wasmbin.ts";
import { Monitors, type Header } from "./monitor.ts";
import { Block, ROOT, St, Sync, emitBlock, emitSync, sidOf, thrOf } from "../compiler/hostcalls.ts";
import { promising, suspending, waitsEnded } from "./module.ts";
import type { World } from "./world.ts";

const THREAD = "java/lang/Thread", LOADER = "java/lang/ClassLoader", GROUP = "java/lang/ThreadGroup", OBJECT = "java/lang/Object", NORM_PRIORITY = 5;
export const SYSTEM_LOADER = "java/lang/ClassLoader$SystemClassLoader";
const MILLION = 0x412e848000000000n;
/** what a wait of a closed World resumes with: thrown into Wasm, which catches only Java's tag, it unwinds the strand's Java frames */
const CLOSED = new Error("the World was closed");
const threadField = (cx: Compiler, name: string, desc: string) => cx.fieldIndex(THREAD, { owner: THREAD, name, desc });
/** stores the long `value` in the Thread on the stack's nativePeer, which Thread.isAlive reads */
const setPeer = (cx: Compiler, c: Code, value: bigint) => { const st = cx.structFor(THREAD); c.refCast(st).i64(value).structSet(st, threadField(cx, "nativePeer", "J")); };
/** with a Thread (cast) and a ClassLoader on the stack: the loader becomes the thread's context loader */
const setContextLoader = (cx: Compiler, c: Code) => c.structSet(cx.structFor(THREAD), threadField(cx, "contextClassLoader", `L${LOADER};`));
/** milliseconds and nanoseconds in locals `ms` (i64) and `ns` (i32), as one number of milliseconds */
const millis = (c: Code, ms: number, ns: number) => c.lget(ms).raw(OP.f64_convert_i64_s).lget(ns).raw(OP.f64_convert_i32_s).f64const(MILLION).raw(OP.f64_div, OP.f64_add);

// blockStatus(status): the exception a non-zero status stands for
rt("blockStatus", ["I"], "V", (cx, c) => {
  for (const [st, thrower] of [[St.Interrupted, "ie"], [St.Imse, "imse"], [St.Nbs, "nbs"]] as const) { c.lget(0).i32(st).raw(OP.i32_eq).if_(); cx.callThrower(c, thrower); c.end(); }
  for (const [st, code] of [[St.Neg, 0], [St.Nanos, 1]] as const) { c.lget(0).i32(st).raw(OP.i32_eq).if_().i32(code); cx.callThrower(c, "iaet"); c.end(); }
}, true);
/** throws what the status on the stack stands for, if it is not Ok */
const check = (cx: Compiler, c: Code) => { const st = c.newLocal(T.i32); c.lset(st).lget(st).if_().lget(st); cx.callRt(c, "blockStatus"); c.end(); };

// menterSlow(obj), mexitSlow(obj): the monitor-enter and monitor-exit the header fast path (j2w.ts) could not do
rt("menterSlow", ["L"], "V", (cx, c) => {
  const st = c.newLocal(T.i32);
  emitSync(cx, c, Sync.Try, () => c.lget(0)); c.lset(st);
  c.lget(st).i32(St.Block).raw(OP.i32_eq).if_();
  emitBlock(cx, c, Block.Enter, () => c.lget(0)); c.lset(st);
  c.end();
  c.lget(st).if_().lget(st); cx.callRt(c, "blockStatus"); c.end();
}, true);
rt("mexitSlow", ["L"], "V", (cx, c) => { emitSync(cx, c, Sync.Exit, () => c.lget(0)); check(cx, c); }, true);
// yieldNow(): a chance for other strands and the event loop. A stack with JS frames on it cannot suspend (the engine says so by throwing), and
// a yield that cannot happen is not an error, unless the realm has ended its waits (endWaits), which must unwind a loop that only yields
rt("yieldNow", [], "V", (cx, c) => {
  const thrown = c.newLocal(T.exnref);
  c.gget(sidOf(cx)).i32(ROOT).raw(OP.i32_ne).if_();
  c.block().block(T.exnref).tryTable(null, [[3, 0, 0]]);
  emitBlock(cx, c, Block.Yield); c.drop();
  c.end().br(1).end();
  c.lset(thrown); emitSync(cx, c, Sync.Ended); c.if_().lget(thrown).throwRef().end();
  c.end().end();
}, true);
// initWait(class id): 1 when the request proceeds with the statics as they are (a cycle), 0 once the initialization it waited for is over
rt("initWait", ["I"], "I", (cx, c) => {
  const st = c.newLocal(T.i32);
  emitBlock(cx, c, Block.Init, null, () => c.lget(0).raw(OP.f64_convert_i32_s)); c.lset(st);
  c.lget(st).i32(St.Proceed).raw(OP.i32_eq).if_().i32(1).ret().end();
  c.lget(st).if_().lget(st); cx.callRt(c, "blockStatus"); c.end();
  c.i32(0);
});
rt("initWake", ["I"], "V", (cx, c) => { emitSync(cx, c, Sync.InitDone, null, () => c.lget(0).raw(OP.f64_convert_i32_s)); c.drop(); });

// curThread(): the running thread, made on first use as ART's Thread::CreatePeer does for the main thread
rt("curThread", [], "L", (cx, c) => {
  const g = thrOf(cx), ctor = cx.prog.resolve(THREAD, "<init>", `(L${GROUP};Ljava/lang/String;IZ)V`);
  if (!ctor) { cx.gap(c, "Thread.<init>(ThreadGroup, String, int, boolean)"); return; }
  c.gget(g).refIsNull().if_();
  cx.emitEnsure(c, THREAD); cx.emitNew(c, THREAD); c.gset(g);
  // a thread the host made (a binder thread, a native thread that attached) is named for what it is
  emitSync(cx, c, Sync.IsMain); c.if_();
  for (const name of ["main", "Thread-host"]) {
    c.gget(g); cx.emitEnsure(c, GROUP); c.gget(cx.staticGlobal(GROUP, "mainThreadGroup")); cx.str.literal(c, name); c.i32(NORM_PRIORITY).i32(0);
    cx.callMethod(c, ctor);
    if (name === "main") c.else_();
  }
  c.end();
  // ART records the native thread in the peer
  c.gget(g); setPeer(cx, c, 1n);
  emitSync(cx, c, Sync.Bind, () => c.gget(g)); c.drop();
  // and the runtime gives the main thread the system class loader as its context loader, which threads started from it inherit
  const system = cx.prog.resolve(LOADER, "getSystemClassLoader", `()L${LOADER};`);
  if (system) {
    // The loader's constructor can itself ask for the main Thread. Register the
    // pending assignment before entering it, so its completed initializer repairs
    // that peer; an explicit Java setter cancels the runtime assignment.
    emitSync(cx, c, Sync.ContextDeferred, () => c.gget(g)); c.drop();
    cx.emitEnsure(c, LOADER);
    const loader = c.newLocal(T.anyref);
    cx.callMethod(c, system); c.lset(loader);
    emitSync(cx, c, Sync.SystemLoaderReady, () => c.lget(loader)); c.drop();
  }
  c.end().gget(g);
});
// Called only after the system loader's initializer succeeds, before waking its
// waiters. Same-thread re-entry still observes the real, partially initialized class.
rt("threadLoaderReady", [], "V", (cx, c) => {
  emitSync(cx, c, Sync.SystemLoaderReady, () => c.gget(cx.staticGlobal(SYSTEM_LOADER, "loader"))); c.drop();
});

export const threadIntrinsics = new Map<string, Intrinsic>();
const def = (key: string, f: (cx: Compiler, c: Code) => void) => threadIntrinsics.set(key, (cx, m, c) => f(cx, c));
const thread = (name: string) => `${THREAD}.${name}`;
def(thread("currentThread()Ljava/lang/Thread;"), (cx, c) => { cx.callRt(c, "curThread"); });
def(thread("setContextClassLoader(Ljava/lang/ClassLoader;)V"), (cx, c) => {
  // Android's setter only writes this field (SecurityManager is removed).
  c.lget(0).refIsNull().if_(); cx.callThrower(c, "npe"); c.end();
  c.lget(0).refCast(cx.structFor(THREAD)).lget(1); setContextLoader(cx, c);
  emitSync(cx, c, Sync.ContextSet, () => c.lget(0)); c.drop();
});
def(thread("nativeGetStatus(Z)I"), (cx, c) => { emitSync(cx, c, Sync.Status, () => c.lget(0), () => c.lget(1).raw(OP.f64_convert_i32_s)); });
def(thread("isInterrupted()Z"), (cx, c) => { emitSync(cx, c, Sync.IsInterrupted, () => c.lget(0)); });
def(thread("interrupted()Z"), (cx, c) => { emitSync(cx, c, Sync.Interrupted); });
def(thread("interrupt0()V"), (cx, c) => { emitSync(cx, c, Sync.Interrupt, () => c.lget(0)); c.drop(); });
def(thread("holdsLock(Ljava/lang/Object;)Z"), (cx, c) => { emitSync(cx, c, Sync.Holds, () => c.lget(0)); });
def(thread("yield()V"), (cx, c) => { cx.callRt(c, "yieldNow"); });
def(thread("setPriority0(I)V"), () => {});
def(thread("setNativeName(Ljava/lang/String;)V"), (cx, c) => { emitSync(cx, c, Sync.Rename, () => c.lget(0)); c.drop(); });
def(thread("nativeCreate(Ljava/lang/Thread;JZ)V"), (cx, c) => {
  c.lget(0); setPeer(cx, c, 1n);
  emitSync(cx, c, Sync.Create, () => c.lget(0)); c.drop();
});
// Thread.sleep(lock, millis, nanos): a timed wait on the thread's own lock, which Thread.sleep(long, int) holds and nothing notifies
def(thread("sleep(Ljava/lang/Object;JI)V"), (cx, c) => { emitBlock(cx, c, Block.Sleep, () => c.lget(0), () => millis(c, 1, 2)); check(cx, c); });
def(`${OBJECT}.wait(JI)V`, (cx, c) => { emitBlock(cx, c, Block.Wait, () => c.lget(0), () => millis(c, 1, 2), () => c.lget(2)); check(cx, c); });
for (const [name, op] of [["notify", Sync.Notify], ["notifyAll", Sync.NotifyAll]] as const) def(`${OBJECT}.${name}()V`, (cx, c) => { emitSync(cx, c, op, () => c.lget(0)); check(cx, c); });
// LockSupport.park/unpark go through Unsafe: park(isAbsolute, time) waits for a permit, the time (nanoseconds, or epoch milliseconds when absolute; 0 is none) or an interrupt
for (const cls of ["jdk/internal/misc/Unsafe", "sun/misc/Unsafe"]) {
  def(`${cls}.park(ZJ)V`, (cx, c) => { emitBlock(cx, c, Block.Park, null, () => c.lget(2).raw(OP.f64_convert_i64_s), () => c.lget(1)); c.drop(); });
  def(`${cls}.unpark(Ljava/lang/Object;)V`, (cx, c) => { emitSync(cx, c, Sync.Unpark, () => c.lget(1)); c.drop(); });
}

// ---------- the host half

/** timers and turns of the event loop; the host's own (guest-clock timers, the yield channel) where there is one */
export interface HostLoop {
  /** the next turn of the event loop; `soon` ahead of strands that only yielded */
  yield(soon: boolean): Promise<void>;
  /** whether the current turn has held the thread for TURN_MS, when a yield is due */
  due(): boolean;
  /** runs `fn` after `ms`; the function cancels */
  after(ms: number, fn: () => void): () => void;
  /** the wall clock Java reads (System.currentTimeMillis), which `after` keeps time by */
  now(): number;
}
/** how long a strand runs before it gives other strands and the event loop their turn (ms) */
export const TURN_MS = 8;
let turnStart = 0;
/** the loop of a World given none, which only compiles: timers alone. The hosts that run Java pass their own (boot.ts) */
export const defaultLoop: HostLoop = {
  yield: () => new Promise<void>((r) => setTimeout(() => { turnStart = performance.now(); r(); }, 0)),
  due: () => performance.now() - turnStart >= TURN_MS,
  after: (ms, fn) => { const id = setTimeout(fn, ms); return () => clearTimeout(id); },
  now: Date.now,
};

/** what the host knows of a Java Thread */
export class ThreadRec {
  obj: object | null;
  interrupted = false;
  permit = false;
  /** wakes the thread out of a wait or sleep, for an interrupt */
  wake: (() => void) | null = null;
  /** wakes it out of a park, for an unpark or an interrupt */
  parked: (() => void) | null = null;
  /** 0 running, else the Thread.State ordinal of its wait: 3 WAITING, 4 TIMED_WAITING */
  waiting = 0;
  blocked = false;
  alive = true;
  /** the strand native code's monitors are held by (JNI MonitorEnter): the thread's, which does not end with a call */
  root: Strand | null = null;
  /** the host's own thread for this one (host/entry.ts) */
  host: unknown = null;
  constructor(obj: object | null) { this.obj = obj; }
}

/** what the host hears of Java threads (host/entry.ts) */
interface ThreadHooks {
  /** the thread whose code runs changed; `idle`: no strand runs, the host's top level does */
  switched(t: ThreadRec, idle: boolean): void;
  /** a Java thread's body has run and it has exited */
  ended(t: ThreadRec): void;
  /** a Java thread started, or was renamed while it runs (Thread.setNativeName): its native name is its Thread's name again, as ART sets it */
  named(t: ThreadRec): void;
}
const NO_HOOKS: ThreadHooks = { switched() {}, ended() {}, named() {} };

/** entries a strand may make before it waits; the engine's stacks run out at about 1,400 */
const NESTED_LIMIT = 200;

export class Strand {
  readonly id: number; readonly thread: ThreadRec; readonly root: boolean; readonly sched: Sched;
  /** the strand this one waits for: the one initializing a class or holding a lock it needs */
  waitsOn: Strand | null = null;
  /** the strand whose native entered Java on this one: the same thread, so it holds what that strand holds */
  parent: Strand | null = null;
  /** how many stacks the entries made from this strand's natives have taken since this strand last waited */
  nested = 0;
  /** the host's own strand for this one (host/entry.ts) */
  host: unknown = null;
  constructor(id: number, thread: ThreadRec, root: boolean, sched: Sched) { this.id = id; this.thread = thread; this.root = root; this.sched = sched; }
  /** runs the Wasm function `f` on a stack of this strand; a Java exception rejects the promise */
  call<R = unknown>(f: Function, ...args: unknown[]): Promise<R> { return this.sched.enter(this, f, args) as Promise<R>; }
  /** the strand is over */
  end(): void { this.sched.end(this); }
}

interface Globals { sid: WebAssembly.Global; thr: WebAssembly.Global; depth: WebAssembly.Global; iw: WebAssembly.Global; wait: WebAssembly.Global }

export class Sched {
  private w: World; private g: Globals; private loop: HostLoop;
  readonly strands: (Strand | undefined)[] = [];
  readonly root: Strand;
  readonly monitors: Monitors;
  /** blocking attempts on a stack that cannot suspend */
  blockedPlain = 0;
  /** calls of Suspending imports that switched stacks */
  suspensions = 0;
  hooks: ThreadHooks = NO_HOOKS;
  /** the threads Thread.start made that have not ended */
  readonly started = new Set<ThreadRec>();
  /** The engine frees the stacks of calls made on a stack of its own only when that stack waits, and refuses a new one after about 1,400 are held (`File.list()` makes an entry for
   *  each call, and a thousand of them in one entry would end in StackOverflowError): whether the strand running has made enough entries that a native should return by waiting once */
  owes(): boolean { const s = this.current(); return !s.root && s.nested >= NESTED_LIMIT; }
  /** whether this turn has used its cooperative time slice */
  turnDue(): boolean { return this.loop.due(); }
  /** how many plain calls from the host into Java (`synchronous`) are on the running stack, which none of its Java frames can suspend through */
  private synchronousEntries = 0;
  /** whether code of strand `s` (the running one by default) can wait for a Promise: it runs on a stack of its own (the host's top level does not) and no plain call from the host is under it */
  canWait(s: Strand = this.current()): boolean { return this.synchronousEntries === 0 && !s.root; }
  /** whether Java frames are on the running stack: a strand's, or under a plain call from the host */
  inJava(): boolean { return this.synchronousEntries > 0 || !this.current().root; }
  /** runs `run`, a plain call from the host into Java */
  synchronous<T>(run: () => T): T {
    this.synchronousEntries++;
    try { return run(); } finally { this.synchronousEntries--; }
  }
  /** `fn`, a Wasm export or a host import, as a plain call from the host into Java */
  plain<A extends unknown[], R>(fn: (...a: A) => R): (...a: A) => R {
    return (...a) => { this.synchronousEntries++; try { return fn(...a); } finally { this.synchronousEntries--; } };
  }
  /** `fn` as the two imports a call site chooses between by whether it can wait: plain, and Suspending */
  importPair<A extends unknown[], R>(fn: (...a: A) => PromiseOrVal<R>): [plain: (...a: A) => PromiseOrVal<R>, wait: (...a: A) => R] {
    return [this.plain(fn), this.suspending(fn)];
  }
  /** a native answered a Promise: the call site that called it settles it, waiting on this strand's stack */
  parkNative(p: Promise<unknown>): void { this.pending = p; this.g.wait.value = 1; }
  /** gives up the turn for `reason`. A collection waits for a turn of the timer queue, between which the engine runs its finalizers; a yield (a loop's fuel,
   *  Thread.yield) and a lazy link wait for the event loop once the turn is due. Before then the main thread runs on, and another thread's yield lets the strands
   *  that became ready run first */
  turn(reason: "yield" | "collect" | "link"): PromiseOrVal<St> {
    if (reason === "collect") return new Promise<St>((r) => { this.loop.after(0, () => r(St.Ok)); });
    const main = this.current().thread === this.main;
    if (this.loop.due()) return this.loop.yield(main).then(() => St.Ok);
    return main || reason === "link" ? St.Ok : Promise.resolve(St.Ok);
  }
  /** Lazy links share the turn budget: many short methods can compile without reaching a loop fuel check.
   * Delivery preparation may wait before the turn expires. Restore the caller before compilation and again in the resumed stub. */
  admitLink(run: () => void, prepare?: () => Promise<void> | undefined): PromiseOrVal<void> {
    const s = this.current();
    if (!this.canWait(s)) return run();
    const thr = this.g.thr.value, depth = this.g.depth.value;
    const delivery = prepare?.(), turn = this.turn("link");
    if (!delivery && turn === St.Ok) return run();
    const pending = turn === St.Ok ? delivery! : Promise.all([delivery, turn]);
    this.suspensions++; s.nested = 0;
    this.idle();
    return pending.then(() => { this.become(s, depth, thr); run(); }, error => { this.become(s, depth, thr); throw error; });
  }
  private resumed = <R>(v: R): R => { if (this.w.closed) throw CLOSED; return v; };
  /** ends every wait nothing else would (World.close): the engine holds a suspended stack, and all it reaches, until it resumes */
  close(): void {
    for (const s of this.strands) s?.thread.parked?.();
    this.monitors.wakeAll();
    for (const id of [...this.initWaiters.keys()]) this.initDone(id);
  }
  /** the Promise a native answered where it could not wait, which the call site settles next (natives.ts park) */
  pending: Promise<unknown> | null = null;
  private main = new ThreadRec(null);
  private next = ROOT + 1;
  private threads = new WeakMap<object, ThreadRec>();
  private pendingContext = new Set<object>();
  private initWaiters = new Map<number, { go: () => void }[]>();
  private promised = new WeakMap<Function, Function>();
  private synchronousExports = new WeakMap<Function, Function>();

  constructor(w: World, g: Globals, loop: HostLoop) {
    this.w = w; this.g = g; this.loop = loop;
    this.root = this.strands[ROOT] = new Strand(ROOT, this.main, true, this);
    let get: Function | undefined, set: Function | undefined;
    const header: Header = {
      lock: (o) => (get ??= w.helpers.hostFn("lock:get", ["L"], "I", (cx, c) => { c.lget(0).refCast(cx.tObj).structGet(cx.tObj, 1).raw(OP.i32_wrap_i64); }))(o),
      setLock: (o, l) => (set ??= w.helpers.hostFn("lock:set", ["L", "I"], "V", (cx, c) => {
        c.lget(0).refCast(cx.tObj).lget(0).refCast(cx.tObj).structGet(cx.tObj, 1).i64(0xffffffff00000000n).raw(OP.i64_and).lget(1).raw(OP.i64_extend_i32_u, OP.i64_or).structSet(cx.tObj, 1);
      }))(o, l),
    };
    this.monitors = new Monitors(header, this.strands, (ms, fn) => loop.after(ms, fn));
  }

  /** the strand running now, as the globals name it */
  current(): Strand { return this.strands[this.g.sid.value as number] ?? this.root; }
  get mainRec(): ThreadRec { return this.main; }
  /** JNI MonitorEnter and MonitorExit of `obj` for the running thread: held by the thread (its root strand), not by the call that asked, and a contended enter answers the Promise of the hand-over */
  nativeMonitor(rec: ThreadRec, obj: object, enter: boolean): Promise<void> | St {
    const s = rec === this.main ? this.root : (rec.root ??= this.rootStrand(rec));
    if (!enter) return this.monitors.exit(obj, s);
    return this.monitors.tryEnter(obj, s) === St.Ok ? St.Ok : this.monitors.enter(obj, s);
  }
  private rootStrand(rec: ThreadRec): Strand {
    const id = this.freeId();
    return this.strands[id] = new Strand(id, rec, true, this);
  }
  /** the next unused strand id; ids wrap below 1 << 22 */
  private freeId(): number {
    let id = this.next;
    while (this.strands[id]) id = id + 1 < 1 << 22 ? id + 1 : ROOT + 1;
    this.next = id + 1 < 1 << 22 ? id + 1 : ROOT + 1;
    return id;
  }
  /** a thread the host made: it runs Java as a thread of its own, whose Thread object is made when it first asks for it */
  hostThread(): ThreadRec { return new ThreadRec(null); }
  /** who runs when no strand does: the host's top level, on the main thread */
  idle(): void { const g = this.g; g.sid.value = ROOT; g.thr.value = this.main.obj; g.depth.value = 0; this.hooks.switched(this.main, true); }
  /** `s` runs, at call depth `depth`; its Thread global is `thr`, which is its thread's object unless it is making that object (curThread) */
  become(s: Strand, depth: unknown = 0, thr: unknown = s.thread.obj): void {
    const g = this.g; g.sid.value = s.id; g.thr.value = thr; g.depth.value = depth; this.hooks.switched(s.thread, false);
  }
  /** wraps `fn` as a Suspending import. What `fn` does before it first waits is on the calling strand; when it returns the stack switches away,
   *  so the globals go back to the host's top level then, and the strand sets its own when it resumes (emitBlock) */
  suspending<A extends unknown[], R>(fn: (...a: A) => PromiseOrVal<R>): (...a: A) => R {
    return suspending((...a: A) => {
      const s = this.current(), depth = this.g.depth.value;
      let r: PromiseOrVal<R>;
      try { r = fn(...a); }
      // No stack switch occurred: Wasm may catch the import's throw on this strand.
      catch (e) { this.become(s, depth); throw e; }
      this.idle();
      if (!(r instanceof Promise)) return r;
      // an import that answers at once keeps its engine stacks: the quota clears only when it suspends
      s.nested = 0; this.suspensions++;
      // an exception after a wait reaches the strand's code through the call, which has not set the globals again
      return r.then(this.resumed, (e) => { this.become(s, depth); throw e; });
    }) as unknown as (...a: A) => R;
  }
  /** a new strand of `thread` (the main thread's when none), for a call into Java from the native `parent` runs, if any */
  strand(thread: ThreadRec = this.main, parent: Strand | null = null): Strand {
    const id = this.freeId(), s = this.strands[id] = new Strand(id, thread, false, this);
    s.parent = parent;
    return s;
  }
  /** the Suspending import a call site settles a native's Promise with: the strand waits for it and gets its value */
  settle(): () => unknown {
    return this.suspending(async () => { const p = this.pending!; this.pending = null; return await p; });
  }
  end(s: Strand): void { if (!s.root && this.strands[s.id] === s) this.strands[s.id] = undefined; }
  private rec(obj: object, create = false): ThreadRec | undefined {
    let r = this.threads.get(obj);
    if (!r && create) this.threads.set(obj, r = new ThreadRec(obj));
    return r;
  }
  /** Host calls are plain; a strand entry unwraps the same export before WebAssembly.promising. */
  synchronousExport(raw: Function): Function {
    const host = this.plain(raw as (...a: unknown[]) => unknown);
    this.synchronousExports.set(host, raw);
    return host;
  }
  private promising(f: Function): Function {
    f = this.synchronousExports.get(f) ?? f;
    let p = this.promised.get(f);
    if (!p) this.promised.set(f, p = promising(f));
    return p;
  }
  /** runs `f` on a new stack of `s`, which may suspend whatever called it */
  enter(s: Strand, f: Function, args: unknown[]): Promise<unknown> {
    const caller = this.current();
    if (!caller.root) caller.nested++;
    const { sid, thr, depth } = this.g, was = [sid.value, thr.value, depth.value, this.synchronousEntries] as const;
    this.become(s); this.synchronousEntries = 0;
    try {
      const p = this.promising(f)(...args) as Promise<unknown>, idle = () => this.idle();
      // a stack that ends after a resume leaves the globals as its own
      p.then(idle, idle);
      return p;
    } finally { sid.value = was[0]; thr.value = was[1]; depth.value = was[2]; this.synchronousEntries = was[3]; const c = this.current(); this.hooks.switched(c.thread, c.root); }
  }

  // ---------- host.sync
  sync(op: number, obj: object | null, a: number): number {
    const s = this.current();
    switch (op as Sync) {
      case Sync.Try: return this.tried(this.monitors.tryEnter(obj!, s));
      case Sync.Exit: return this.monitors.exit(obj!, s);
      case Sync.Notify: case Sync.NotifyAll: return this.monitors.notify(obj!, s, op === Sync.NotifyAll);
      case Sync.Holds: return +this.monitors.holds(obj!, s);
      case Sync.Bind: s.thread.obj = obj; this.threads.set(obj!, s.thread); return 0;
      case Sync.ContextDeferred: this.pendingContext.add(obj!); return 0;
      case Sync.ContextSet: this.pendingContext.delete(obj!); return 0;
      case Sync.SystemLoaderReady: {
        if (obj && this.pendingContext.size) {
          const set = this.w.helpers.hostFn("thread:context", ["L", "L"], "V", (cx, c) => {
            c.lget(0).refCast(cx.structFor(THREAD)).lget(1); setContextLoader(cx, c);
          });
          for (const peer of this.pendingContext) set(peer, obj);
          this.pendingContext.clear();
        }
        return 0;
      }
      case Sync.IsMain: return +(s.thread === this.main);
      case Sync.Create: return this.create(obj!);
      case Sync.Interrupt: { const r = this.rec(obj!); if (r?.alive) { r.interrupted = true; r.wake?.(); r.parked?.(); } return 0; }
      case Sync.IsInterrupted: return +(this.rec(obj!)?.interrupted ?? false);
      case Sync.Interrupted: { const r = s.thread, was = r.interrupted; r.interrupted = false; return +was; }
      case Sync.Unpark: { const r = this.rec(obj!, true)!; if (r.parked) r.parked(); else r.permit = true; return 0; }
      case Sync.Status: return this.status(obj!, a !== 0);
      case Sync.Plain: this.blockedPlain++; return 0;
      case Sync.CanSuspend: return +this.canWait(s);
      case Sync.Resume: this.hooks.switched(s.thread, false); return 0;
      case Sync.InitDone: return this.initDone(a);
      case Sync.Rename: { const r = this.rec(obj!); if (r) this.hooks.named(r); return 0; }
      case Sync.Ended: return +waitsEnded();
    }
  }
  private tried(st: St): St { if (st === St.Nbs) this.blockedPlain++; return st; }
  /** the Thread.State ordinal of a Thread */
  private status(obj: object, started: boolean): number {
    const r = this.threads.get(obj);
    if (!r) return started ? 5 : 0;
    return !r.alive ? 5 : r.blocked ? 2 : r.waiting || 1;
  }

  // ---------- host.block
  block(op: number, obj: object | null, a: number, b: number): PromiseOrVal<number> {
    const s = this.current();
    switch (op as Block) {
      case Block.Enter: return this.monitors.enter(obj!, s).then(() => St.Ok);
      case Block.Wait: return a < 0 || b < 0 ? St.Neg : b > 999999 ? St.Nanos : this.monitors.wait(obj!, s, a, false);
      case Block.Sleep: return this.monitors.wait(obj!, s, a, true);
      case Block.Park: return this.park(s, a, b !== 0);
      case Block.Yield: return this.turn("yield");
      case Block.Collect: return this.turn("collect");
      case Block.Init: return this.initWait(s, a);
      case Block.Net: return (this.w.opts.net?.wait?.(this.w) ?? Promise.resolve()).then(() => St.Ok);
    }
  }
  /** LockSupport.park: returns on a permit, the deadline or an interrupt (which stays set) */
  private park(s: Strand, time: number, absolute: boolean): PromiseOrVal<St> {
    const th = s.thread;
    if (th.permit) { th.permit = false; return St.Ok; }
    if (th.interrupted) return St.Ok;
    const timed = absolute || time > 0;
    return new Promise<St>((resolve) => {
      let cancel: (() => void) | null = null;
      const done = () => { cancel?.(); th.parked = null; th.waiting = 0; th.permit = false; resolve(St.Ok); };
      if (timed) cancel = this.loop.after(absolute ? Math.max(0, time - this.loop.now()) : time / 1e6, done);
      th.parked = done; th.waiting = timed ? 4 : 3;
    });
  }

  // ---------- threads
  /** Thread.nativeCreate: the thread's body is a strand of its own, which starts when its creator next waits or ends */
  private create(obj: object): number {
    const th = this.rec(obj, true)!;
    th.alive = true; this.started.add(th); this.hooks.named(th);
    const s = this.strand(th);
    queueMicrotask(() => void this.run(s, obj));
    return 0;
  }
  /** ART's thread start: `run`, then the thread's handler for an exception nothing caught, then `exit`, the peer cleared and the threads joined to it woken */
  private async run(s: Strand, obj: object): Promise<void> {
    const w = this.w, call = (name: string, params: Kind[], body: (cx: Compiler, c: Code, arg: (i: number) => void) => void, ...args: unknown[]) => w.helpers.callFn(name, params, "V", body)(s, ...args);
    const virtual = (name: string, desc: string, ...args: unknown[]) => {
      const m = w.prog.implFor(w.classNameOf(obj), name, desc)!;
      return call(`thr:${m.cls}.${name}${desc}`, ["L", ...m.params.map(() => "L" as const)], (cx, c, arg) => { arg(0); if (m.params.length) arg(1); cx.callMethod(c, m); }, obj, ...args);
    };
    /** the thread's `exit`, then its peer cleared and the threads joined to it woken */
    const exit = async () => {
      try { await call("thr:exit", ["L"], (cx, c, arg) => { arg(0); cx.callMethod(c, w.prog.resolve(THREAD, "exit", "()V")!); }, obj); } catch { /* a failing exit leaves the thread over all the same */ }
      // a thread that join wakes is TERMINATED when it asks: the flag goes before the peer is cleared and the joiners notified
      s.thread.alive = false; this.started.delete(s.thread);
      try {
        await call("thr:finish", ["L"], (cx, c, arg) => {
          const st = cx.structFor(THREAD), l = c.newLocal(T.anyref);
          arg(0); setPeer(cx, c, 0n);
          arg(0); c.refCast(st).structGet(st, threadField(cx, "lock", "Ljava/lang/Object;")).lset(l);
          c.lget(l).call(cx.helper("menter"));
          emitSync(cx, c, Sync.NotifyAll, () => c.lget(l)); c.drop();
          c.lget(l).call(cx.helper("mexit"));
        }, obj);
      } catch (e) { console.error("[wasm thread exit]", e); }
    };
    try { await virtual("run", "()V"); }
    catch (e) {
      const t = w.throwable(e);
      // a closed World's thread runs no more Java
      if (w.closed) return;
      if (!t) console.error("[wasm thread]", e);
      else try { await virtual("dispatchUncaughtException", "(Ljava/lang/Throwable;)V", t); } catch { /* the handler's own failure ends the thread, as in ART */ }
    } finally {
      if (!w.closed) await exit();
      s.end();
      this.hooks.ended(s.thread);
    }
  }

  // ---------- class initialization
  /** a strand waits for the initialization of class `id` that another strand runs; a request the initializer itself waits on (through classes and locks) proceeds
   *  with the statics as they are, as a cycle on one thread would */
  private initWait(s: Strand, id: number): PromiseOrVal<St> {
    const holder = this.strands[this.w.initWord(id) >>> 2];
    if (!holder || holder === s) return St.Ok;
    // a strand a native of the initializing thread entered Java on (JNI_OnLoad finding the class its library is loaded by) is that thread: it sees the statics as they are
    if (holder.thread === s.thread) return St.Proceed;
    if (this.waitsFor(holder, s)) return St.Proceed;
    s.waitsOn = holder; s.thread.blocked = true;
    return new Promise<St>((resolve) => {
      const list = this.initWaiters.get(id) ?? this.initWaiters.set(id, []).get(id)!;
      list.push({ go: () => { s.waitsOn = null; s.thread.blocked = false; resolve(St.Ok); } });
      this.g.iw.value = (this.g.iw.value as number) + 1;
    });
  }
  /** whether another thread is blocked on `thread`: on a lock it holds or a class it initializes */
  contended(thread: ThreadRec): boolean {
    if (this.monitors.contended(thread)) return true;
    for (const id of this.initWaiters.keys()) if (this.strands[this.w.initWord(id) >>> 2]?.thread === thread) return true;
    return false;
  }
  /** whether `holder` waits, through the strands it waits for, on `waiter`; a cycle that does not reach `waiter` is others' deadlock, which `waiter` waits behind */
  private waitsFor(holder: Strand, waiter: Strand): boolean {
    if (waiter.root) return false;
    const seen = new Set<Strand>();
    for (let c: Strand | null = holder; c && !c.root && !seen.has(c); c = c.waitsOn) { if (c === waiter) return true; seen.add(c); }
    return false;
  }
  private initDone(id: number): number {
    const list = this.initWaiters.get(id);
    if (!list) return 0;
    this.initWaiters.delete(id);
    this.g.iw.value = (this.g.iw.value as number) - list.length;
    for (const w of list) w.go();
    return 0;
  }
}
