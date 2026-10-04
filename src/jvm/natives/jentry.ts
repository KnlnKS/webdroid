// Entering Java from host code: which Java thread owns the turn, as which of its call chains (a
// Strand: rt.cur, curThread its thread), and the calls native code makes into Java on it (vcall,
// scall, newObj, callOn, after).

import { rt, JObj, type ClassInfo } from "../runtime";
import { mangleMethod, lateMethod, idHash, parseMethodDesc } from "../abi";
import { jsClass, type JavaClass } from "../tier";
import { Strand, setPublic, suspendWith } from "../suspend";
import { never, processExited } from "../../process-exit";

/** Does a Java thread own this event-loop turn? A resumed activation takes its thread (rt.st) and
 *  releases it (rt.su); host code enters with onMain or callOn. Java entered from a turn nothing owns
 *  (an async function or timer resuming) would run as whichever thread ran last, so the entry
 *  helpers refuse it in a page's realms; Bun's host tools and tests own every turn. */
let owned = true, strictOwnership = false;
export function strictThreadOwnership(): void { strictOwnership = true; owned = false; }
/** no Java thread owns the turn from here (a frame suspended, a native thread parked): the main
 *  thread's identity is left for code that reads it */
export function releaseThread(): void { resumeAs(mainThread.root); owned = !strictOwnership; }
function unowned(what: string): never {
  throw new Error(`[webdroid unowned] ${what} from a turn no Java thread owns: enter with onMain, callOn or a driven generator`);
}
function findMethod(obj: any, name: string, desc: string): (...a: unknown[]) => unknown {
  const fn = obj[mangleMethod(name, desc)] ?? lateMethod.find?.(obj, name, desc);
  if (typeof fn !== "function") throw rt.unimplemented(`vcall ${describe(obj)}.${name}${desc}`);
  return fn;
}
/** `obj` answering Java method `name``desc` with host function `fn` (both calling conventions) */
export function implement<T extends object>(obj: T, name: string, desc: string, fn: (...a: any[]) => unknown): T {
  setPublic(obj as Record<string, unknown>, mangleMethod(name, desc), fn, parseMethodDesc(desc).params.length);
  return obj;
}
/** Dynamic virtual call from native code: the result, or a Promise when the callee suspends. */
function jsVcall(obj: any, name: string, desc: string, ...args: unknown[]): any {
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
/** `call` on `thread`, which owns the turn while it runs, as a chain of its own: the running chain
 *  need not wait for an entry, and must not run on as it while the entry suspends */
function jsCallOn<T>(thread: JThread, call: () => T): T {
  if (processExited()) return never() as T;
  const previous = rt.cur, was = owned;
  resumeAs(new Strand(thread));
  try { return call(); } finally { resumeAs(previous); owned = was; }
}
/** `f` of `r`, now or once it settles; settled later, `f` continues the thread and chain that
 *  asked as a suspended frame does (if a thread owned the turn that asked) */
function jsAfter<R, T>(r: R | Promise<R>, f: (v: R) => T | Promise<T>): T | Promise<T> {
  if (!(r instanceof Promise)) return f(r);
  if (!owned) return r.then(f);
  const strand = rt.cur;
  return suspendWith(r, (v, threw) => {
    if (threw) throw v;
    resumeAs(strand);
    try { return f(v as R); } finally { releaseThread(); }
  }) as Promise<T>;
}
function describe(o: unknown): string {
  return typeof o === "string" ? "String" : (classNameOf(o) ?? String(o));
}
const jsLinkClass = (cls: string): JavaClass => jsClass(rt.link(cls));
const jsInitClass = (cls: string): Promise<void> | null => rt.initClass(rt.link(cls));
const jsIof = (o: unknown, cls: string): boolean => !!rt.iof(o, cls);
function jsClassNameOf(o: unknown): string | undefined {
  return (o as { constructor?: { $i?: ClassInfo } } | null | undefined)?.constructor?.$i?.name;
}
function initialized(cls: string): ClassInfo | Promise<ClassInfo> {
  if (!owned) unowned(`initialize ${cls}`);
  const info = rt.link(cls);
  return jsAfter(rt.initClass(info), () => info);
}
const jsLinkInit = (cls: string): JavaClass | Promise<JavaClass> => jsAfter(initialized(cls), jsClass);
const jsStaticField = <T = unknown>(cls: string, field: string): T | Promise<T> =>
  jsAfter(initialized(cls), (info) => jsClass(info).static(field) as T);
function jsScall(cls: string, name: string, desc: string, ...args: unknown[]): any {
  return jsAfter(initialized(cls), (info) => vcall(info.ctor, name, desc, ...args));
}
function jsNewObj(cls: string, desc = "()V", ...args: unknown[]): JObj | Promise<any> {
  return jsAfter(initialized(cls), (info) => {
    const o = jsClass(info).new() as JObj;
    return jsAfter(vcall(o, "<init>", desc, ...args), () => o);
  });
}

/** How host code enters Java, for the tier that runs it: the JS tier's below, the Wasm tier's in src/wasm/host/entry.ts, selected by `useEntry`
 *  (the names this module exports are bindings that follow it). */
export interface Entry {
  /** Dynamic virtual call from native code: the result, or a Promise when the callee suspends. */
  vcall(obj: any, name: string, desc: string, ...args: unknown[]): any;
  /** A static Java call from native code, once the class has initialized, on the calling thread */
  scall(cls: string, name: string, desc: string, ...args: unknown[]): any;
  /** `new cls(args)` from native code: initialize the class, then run the Java constructor `desc`; synchronous unless initialization or the constructor suspends */
  newObj(cls: string, desc?: string, ...args: unknown[]): any;
  /** a static field's value, once the class has initialized */
  staticField<T = unknown>(cls: string, field: string): T | Promise<T>;
  /** link + run <clinit>: the class is ready to be instantiated or have its statics read */
  linkInit(cls: string): JavaClass | Promise<JavaClass>;
  /** the class named `cls`, linked only: its fields and methods exist, `<clinit>` has not run */
  linkClass(cls: string): JavaClass;
  /** run `cls`'s <clinit> if it has not, linking it first; null when it was ready */
  initClass(cls: string): Promise<void> | null;
  /** is `o` an instance of the class named `cls` */
  iof(o: unknown, cls: string): boolean;
  /** the name of the class of the Java object `o` */
  classNameOf(o: unknown): string | undefined;
  /** `call` on `thread`, which owns the turn while it runs, as a chain of its own */
  callOn<T>(thread: JThread, call: () => T): T;
  /** `f` of `r`, now or once it settles */
  after<R, T>(r: R | Promise<R>, f: (v: R) => T | Promise<T>): T | Promise<T>;
}
export const jsEntry: Entry = {
  vcall: jsVcall, scall: jsScall, newObj: jsNewObj, staticField: jsStaticField, linkInit: jsLinkInit, linkClass: jsLinkClass, initClass: jsInitClass,
  iof: jsIof, classNameOf: jsClassNameOf, callOn: jsCallOn, after: jsAfter,
};
export let { vcall, scall, newObj, staticField, linkInit, linkClass, initClass, iof, classNameOf, callOn, after } = jsEntry;
/** from here host code enters Java through `entry` */
export function useEntry(entry: Entry): void {
  ({ vcall, scall, newObj, staticField, linkInit, linkClass, initClass, iof, classNameOf, callOn, after } = entry);
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
  /** the thread as Java no entry gave a chain (suspend.ts) */
  readonly root: Strand = new Strand(this, true);
}
export let curThread: JThread = null as never;
export const mainThread = curThread = new JThread();
mainThread.jname = "main";
mainThread.alive = 1;
rt.cur = mainThread.root;
rt.main = mainThread;
rt.st = resumeAs;
rt.su = releaseThread;
export const threadSwitch = { hook: null as ((t: JThread) => void) | null };
/** run as strand `s` from here: the code that follows owns the turn as its thread and chain */
export function resumeAs(s: Strand): void {
  owned = true;
  rt.cur = s;
  const t = s.thread as JThread;
  if (t === curThread) return;
  curThread = t;
  threadSwitch.hook?.(t);
}
/** run as `t` from here, as Java no entry gave a chain of its own */
export const setCurThread = (t: JThread): void => resumeAs(t.root);
