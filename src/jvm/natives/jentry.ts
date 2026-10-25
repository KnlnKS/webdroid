// Entering Java from host code: which Java thread owns the turn, as which of its call chains (a
// Strand: rt.cur, curThread its thread), and the calls native code makes into Java on it (vcall,
// scall, newObj, callOn, after).

import { rt, JObj } from "../runtime.ts";
import type { JavaClass } from "../tier.ts";
import { java } from "../javahost.ts";
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

/** the calls host code makes into Java, as the installed host (javahost.ts) makes them */
export const vcall = (obj: any, name: string, desc: string, ...args: unknown[]): any => java.vcall(obj, name, desc, ...args);
export const scall = (cls: string, name: string, desc: string, ...args: unknown[]): any => java.scall(cls, name, desc, ...args);
export const newObj = (cls: string, desc?: string, ...args: unknown[]): any => java.newObj(cls, desc, ...args);
export const staticField = <T = unknown>(cls: string, field: string): T | Promise<T> => java.staticField<T>(cls, field);
export const linkInit = (cls: string): JavaClass | Promise<JavaClass> => java.linkInit(cls);
export const linkClass = (cls: string): JavaClass => java.linkClass(cls);
export const initClass = (cls: string): Promise<void> | null => java.initClass(cls);
export const iof = (o: unknown, cls: string): boolean => java.iof(o, cls);
export const classNameOf = (o: unknown): string | undefined => java.classNameOf(o);
export const callOn = <T>(thread: JThread, call: () => T): T => java.callOn(thread, call);
export const after = <R, T>(r: R | Promise<R>, f: (v: R) => T | Promise<T>): T | Promise<T> => java.after(r, f);

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
/** run as strand `s` from here: the code that follows owns the turn as its thread and chain */
export function resumeAs(s: Strand): void {
  rt.cur = s;
  curThread = s.thread as JThread;
}
/** run as `t` from here, as Java no entry gave a chain of its own */
export const setCurThread = (t: JThread): void => resumeAs(t.root);
