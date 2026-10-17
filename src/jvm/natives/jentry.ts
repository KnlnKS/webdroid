// Entering Java from host code: which Java thread owns the turn, as which of its call chains (a
// Strand: rt.cur, curThread its thread), and the calls native code makes into Java on it (vcall,
// scall, newObj, callOn, after).

import { rt, JObj } from "../runtime.ts";
import type { JavaClass } from "../tier.ts";
import { Strand } from "../suspend.ts";

/** the main thread's identity from here, for code that reads it while no Java runs (a native thread parked) */
export function releaseThread(): void { resumeAs(mainThread.root); }
/** A Java call as a Promise, for callers that chain on its completion. */
export function vcallAsync(obj: unknown, name: string, desc: string, ...args: unknown[]): Promise<any> {
  try { return Promise.resolve(vcall(obj, name, desc, ...args)); } catch (e) { return Promise.reject(e); }
}
export function vcallOn(thread: JThread, obj: unknown, name: string, desc: string, ...args: unknown[]): unknown {
  return callOn(thread, () => vcall(obj, name, desc, ...args));
}

/** How host code enters Java: the World's entry (src/wasm/host/entry.ts), installed by `useEntry` (the names this module exports are bindings that follow it). */
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
  /** `f` of `r`, now or once it settles, as the thread and call chain that call `after`. A native that waits enters Java again through it
   *  or as a generator native: code after an `await` or in a `.then` runs as the host's current thread */
  after<R, T>(r: R | Promise<R>, f: (v: R) => T | Promise<T>): T | Promise<T>;
}
const unset = (): never => { throw new Error("no World runs Java yet: useWorld installs one"); };
export let { vcall, scall, newObj, staticField, linkInit, linkClass, initClass, iof, classNameOf, callOn, after }: Entry = {
  vcall: unset, scall: unset, newObj: unset, staticField: unset, linkInit: unset, linkClass: unset, initClass: unset, iof: unset, classNameOf: unset, callOn: unset, after: unset,
};
/** whether a World runs Java in this realm yet */
export const javaRuns = (): boolean => vcall !== unset;
/** from here host code enters Java through `entry` */
export function useEntry(entry: Entry): void {
  ({ vcall, scall, newObj, staticField, linkInit, linkClass, initClass, iof, classNameOf, callOn, after } = entry);
}

/** a thread as host code knows it: the identity natives key per-thread state by (EGL bindings, native Cpus, Loopers) */
export class JThread extends JObj {
  jname = "Thread";
  /** the thread's native Looper (android/mainloop), once it has prepared one */
  looper: unknown = null;
  /** the thread as Java no entry gave a chain (suspend.ts) */
  readonly root: Strand = new Strand(this, true);
}
export let curThread: JThread = null as never;
export const mainThread = curThread = new JThread();
mainThread.jname = "main";
rt.cur = mainThread.root;
rt.st = resumeAs;
rt.su = releaseThread;
/** the native tier releases a finished thread's Cpu and stack through this */
export const threadExit = { hook: null as ((t: JThread) => void) | null };
/** whether another thread is blocked on a lock or class initialization `t` holds */
export const threadContended = { hook: null as ((t: JThread) => boolean) | null };
export const threadSwitch = { hook: null as ((t: JThread) => void) | null };
/** run as strand `s` from here: the code that follows owns the turn as its thread and chain */
export function resumeAs(s: Strand): void {
  rt.cur = s;
  const t = s.thread as JThread;
  if (t === curThread) return;
  curThread = t;
  threadSwitch.hook?.(t);
}
/** run as `t` from here, as Java no entry gave a chain of its own */
export const setCurThread = (t: JThread): void => resumeAs(t.root);
