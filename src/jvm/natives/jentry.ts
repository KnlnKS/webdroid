// Entering Java from host code: which Java thread owns the turn (JThread, curThread, setCurThread)
// and the calls native code makes into Java on it (vcall, scall, newObj, callOn, after).

import { rt, JObj, type ClassInfo } from "../runtime";
import { mangleMethod, mangleStaticField, lateMethod, idHash } from "../abi";
import { currentStrand, enterStrand, newStrand } from "../suspend";
import { never, processExited } from "../../process-exit";

/** Does a Java thread own this event-loop turn? A resumed activation takes its thread (rt.st) and
 *  releases it (rt.su); host code enters with onMain or callOn. Java entered from a turn nothing owns
 *  (an async function or timer resuming) would run as whichever thread ran last, so the entry
 *  helpers refuse it in a page's realms; Bun's host tools and tests own every turn. */
let owned = true, strictOwnership = false;
export function strictThreadOwnership(): void { strictOwnership = true; owned = false; }
/** no Java thread owns the turn from here (a frame suspended, a native thread parked): the main
 *  thread's identity is left for code that reads it */
export function releaseThread(): void { setCurThread(mainThread); owned = !strictOwnership; }
function unowned(what: string): never {
  throw new Error(`[webdroid unowned] ${what} from a turn no Java thread owns: enter with onMain, callOn or a driven generator`);
}
function findMethod(obj: any, name: string, desc: string): (...a: unknown[]) => unknown {
  const fn = obj[mangleMethod(name, desc)] ?? lateMethod.find?.(obj, name, desc);
  if (typeof fn !== "function") throw rt.unimplemented(`vcall ${describe(obj)}.${name}${desc}`);
  return fn;
}
/** Dynamic virtual call from native code: the result, or a Promise when the callee suspends. */
export function vcall(obj: any, name: string, desc: string, ...args: unknown[]): any {
  if (!owned) unowned(`vcall ${name}${desc}`);
  return findMethod(obj, name, desc).apply(obj, args);
}
/** A Java call as a Promise, for callers that chain on its completion. */
export function vcallAsync(obj: unknown, name: string, desc: string, ...args: unknown[]): Promise<any> {
  try { return Promise.resolve(vcall(obj, name, desc, ...args)); } catch (e) { return Promise.reject(e); }
}
export function vcallOn(thread: JThread, obj: unknown, name: string, desc: string, ...args: unknown[]): unknown {
  return callOn(thread, () => vcall(obj, name, desc, ...args));
}
/** `call` on `thread`, which owns the turn while it runs, as chain `chain` or else a new one: the
 *  running chain need not wait for an entry, and must not run on as it while the entry suspends */
export function callOn<T>(thread: JThread, call: () => T, chain = 0): T {
  if (processExited()) return never() as T;
  const previous = curThread, was = owned, outer = enterStrand(chain || newStrand());
  setCurThread(thread);
  try { return call(); } finally { setCurThread(previous); owned = was; enterStrand(outer); }
}
/** runs calls on `thread` as the call chain running now: host code continuing that chain from a
 *  later turn */
export function caller(thread = curThread): <T>(call: () => T) => T {
  const chain = currentStrand();
  return (call) => callOn(thread, call, chain);
}
/** `f` of `r`, now or once it settles; settled later, `f` runs on the thread and chain that asked
 *  (if a thread owned the turn that asked) */
export function after<R, T>(r: R | Promise<R>, f: (v: R) => T | Promise<T>): T | Promise<T> {
  if (!(r instanceof Promise)) return f(r);
  if (!owned) return r.then(f);
  const resume = caller();
  return r.then((v) => resume(() => f(v)));
}
function describe(o: unknown): string {
  return typeof o === "string" ? "String" : ((o as any)?.constructor?.$i?.name ?? String(o));
}
/** link + run <clinit>: the class is ready to be instantiated or have its statics read */
export function linkInit(cls: string): ClassInfo | Promise<ClassInfo> {
  if (!owned) unowned(`initialize ${cls}`);
  const info = rt.link(cls);
  return after(rt.initClass(info), () => info);
}
/** a static field's value, once the class has initialized */
export const staticField = <T = unknown>(cls: string, field: string): T | Promise<T> =>
  after(linkInit(cls), (info) => (info.ctor as Record<string, T>)[mangleStaticField(field)]);
/** A static Java call from native code, once the class has initialized, on the calling thread */
export function scall(cls: string, name: string, desc: string, ...args: unknown[]): any {
  return after(linkInit(cls), (info) => vcall(info.ctor, name, desc, ...args));
}
/** `new cls(args)` from native code: initialize the class, then run the Java constructor `desc`;
 *  synchronous unless initialization or the constructor suspends */
export function newObj(cls: string, desc = "()V", ...args: unknown[]): JObj | Promise<any> {
  return after(linkInit(cls), (info) => {
    const o = new info.ctor() as JObj;
    return after(vcall(o, "<init>", desc, ...args), () => o);
  });
}

/** the threads started and not yet ended */
export const liveThreads = new Set<JThread>();
export class JThread extends JObj {
  jname = "Thread";
  /** the fields libcore reaches in a Thread, by name or Unsafe offset: ThreadLocalRandom's state and
   *  ThreadLocal's maps */
  threadLocalRandomSeed = 0n; threadLocalRandomProbe = 0; threadLocalRandomSecondarySeed = 0;
  threadLocals: unknown = null; inheritableThreadLocals: unknown = null; inheritedAccessControlContext: unknown = null;
  /** LockSupport's blocker, and the id it reads through Unsafe as getId reports it */
  parkBlocker: unknown = null;
  /** the Interruptible of the channel operation blocking this thread (Thread.blockedOn) */
  blocker: unknown = null;
  get tid(): bigint { return BigInt(idHash(this)); }
  daemon = 0;
  private live = 0;
  /** Thread.started, which Runtime.addShutdownHook reads */
  started = 0;
  parked = 0;
  get alive() { return this.live; }
  set alive(value: number) { this.live = value; if (value) { this.started = 1; liveThreads.add(this); } else liveThreads.delete(this); }
  prio = 5;
  target: unknown = null;   // Runnable
  ueh: unknown = null;      // Thread.UncaughtExceptionHandler
  interrupted = 0;
  wake: (() => void) | null = null;
  /** LockSupport: a permit delivered while not parked, or the wake of a park in progress */
  permit = false;
  unpark: (() => void) | null = null;
  done: Promise<void> | null = null;
  /** the thread's native Looper (android/mainloop), once it has prepared one */
  looper: unknown = null;
  /** the ThreadGroup a Java constructor named; null is the main group */
  group: unknown = null;
}
export let curThread: JThread = null as never;
export const mainThread = curThread = new JThread();
mainThread.jname = "main";
mainThread.alive = 1;
rt.cur = mainThread;
rt.st = (t) => setCurThread(t as JThread);
rt.su = releaseThread;
export const threadSwitch = { hook: null as ((t: JThread) => void) | null };
/** run as `t` from here: the code that follows owns the turn as that thread */
export function setCurThread(t: JThread) {
  owned = true;
  if (t === curThread) return;
  curThread = rt.cur = t;
  threadSwitch.hook?.(t);
}
