import { never, processExited } from "../process-exit";

// Suspended activations share one Promise per pending operation. Every frame on the stack that
// is waiting for it (compiled code or a generator native) joins the same continuation list, and
// when the operation settles the list resumes innermost to outermost in a single microtask:
// resuming an N-deep stack costs one Promise hop, not N.

/** Continues a suspended activation with its callee's result or exception. */
type Continuation = (value: unknown, threw: boolean) => unknown;
const FRAMES = Symbol("continuations");
type Suspension = Promise<unknown> & { [FRAMES]?: Continuation[] };

/** An execution that can block: a Java thread as one of its call chains. Chains interleave on a
 *  thread while another is suspended, so class initialization and monitors tell a chain's own
 *  re-entry from another job's. Each entry from host code runs as a strand of its own (callOn),
 *  and every frame resumes as the strand it captured (Runtime.cur). A thread's root strand is Java
 *  that no entry gave a chain (host tools, tests): it shares its thread's locks and class
 *  initializations with every chain of that thread, and its waits are not recorded. */
export class Strand {
  /** the strand this one waits for: the one initializing a class or holding a lock it needs */
  waitsOn: Strand | null = null;
  constructor(readonly thread: unknown, readonly root = false) {}
}
/** whether `holder` waits, through the strands it waits for, on `waiter` */
export function waitsFor(holder: Strand, waiter: Strand): boolean {
  if (waiter.root) return false;
  for (let c: Strand | null = holder, n = 0; c && !c.root; c = c.waitsOn) if (c === waiter || ++n > 64) return true;
  return false;
}
/** `waiter` waits for `holder` until `until` settles */
export function waitFor<T>(waiter: Strand, holder: Strand, until: Promise<T>): Promise<T> {
  if (waiter.root || holder.root || waiter === holder) return until;
  waiter.waitsOn = holder;
  const done = () => { if (waiter.waitsOn === holder) waiter.waitsOn = null; };
  until.then(done, done);
  return until;
}

/** Wait on `pending` with `k`: the returned Promise settles with the outermost frame's result. */
export function suspendWith(pending: Promise<unknown>, k: Continuation): Promise<unknown> {
  const frames = (pending as Suspension)[FRAMES];
  if (frames) { frames.push(k); return pending; }
  const list = [k];
  const suspension: Suspension = pending.then((value) => unwind(list, value, false), (error) => unwind(list, error, true));
  suspension[FRAMES] = list;
  return suspension;
}

/** each frame resumes as the strand it captured, so the list carries none */
const unwind = (list: Continuation[], value: unknown, threw: boolean): unknown => processExited() ? never() : resume(list, value, threw);

function resume(list: Continuation[], value: unknown, threw: boolean): unknown {
  for (let i = 0; i < list.length; i++) {
    let result: unknown;
    try { result = list[i](value, threw); }
    catch (error) { value = error; threw = true; continue; }
    if (result instanceof Promise) {
      // That frame suspended again: the frames above it wait on its new suspension.
      let next = result;
      for (let j = i + 1; j < list.length; j++) next = suspendWith(next, list[j]);
      return next;
    }
    value = result; threw = false;
  }
  if (threw) throw value;
  return value;
}

/** `v` as a promise any number of frames may await: a pending Java result is a suspension, which
 *  every frame awaiting it joins, so a second waiter would resume inside the first one's stack */
export async function shareable<T>(v: T | Promise<T>): Promise<T> { return v; }

/** a value computed by its first asker and kept. Askers meanwhile wait on a promise of their own
 *  (the first asker's carries its frames, suspendWith); a failure is not kept, so the next asker
 *  computes again. */
export function once<T>(make: () => T | Promise<T>): () => T | Promise<T> {
  let value: { v: T } | null = null, pending: Promise<T> | null = null;
  return () => {
    if (value) return value.v;
    if (pending) return pending;
    const v = make();
    if (!(v instanceof Promise)) { value = { v }; return v; }
    const shared = Promise.withResolvers<T>();
    shared.promise.catch(() => {});
    pending = shared.promise;
    return suspendWith(v, (done, threw) => {
      pending = null;
      if (threw) { shared.reject(done); throw done; }
      value = { v: done as T };
      shared.resolve(value.v);
      return done;
    }) as Promise<T>;
  };
}

// ── calling conventions
// Compiled code calls a method under its Java-ABI name (`x` + the mangled name), whose function
// suspends by throwing SUSPENDED with the Promise of its result: call sites test nothing, and the
// frame's own catch saves it (MethodEmitter). Host code calls the mangled name, whose function
// returns that Promise instead, as every native and vcall expects. Whatever installs one name
// installs the other (setJava, setPublic).

/** the token a Java-ABI function throws when it suspends; `p` is the Promise of its result */
export const SUSPENDED: { p: Promise<unknown> } = { p: Promise.resolve() };
const xnames = new Map<string, string>();
/** the Java-ABI name of a method's mangled name */
export function xname(mangled: string): string {
  let x = xnames.get(mangled);
  if (x === undefined) xnames.set(mangled, x = "x" + mangled);
  return x;
}
type Fn = (this: unknown, ...args: never[]) => unknown;
const params = (n: number) => Array.from({ length: n }, (_, i) => "a" + i).join(",");
// every linked method gets an adapter at link time, so making one is a bare closure
const makers = (body: (args: string) => string) => {
  const made: ((f: Fn, S: typeof SUSPENDED) => Fn)[] = [];
  // strict, as the natives are: a sloppy function would box a string receiver
  return (n: number) => made[n] ??= new Function("f", "S", `"use strict";return function(${params(n)}){${body(params(n))}}`) as (f: Fn, S: typeof SUSPENDED) => Fn;
};
const toPublic = makers((a) => `try{return f.call(this${a && "," + a})}catch(e){if(e===S)return S.p;throw e}`);
const toJava = makers((a) => `const r=f.call(this${a && "," + a});if(r instanceof Promise){S.p=r;throw S}return r`);
/** a Java-ABI function as host code calls it: a suspension becomes its returned Promise */
export const publicFace = <F>(fn: F, arity: number): F => toPublic(arity)(fn as Fn, SUSPENDED) as F;
/** a host function (a native) as compiled code calls it: a returned Promise becomes a suspension */
export const javaFace = <F>(fn: F, arity: number): F => toJava(arity)(fn as Fn, SUSPENDED) as F;
type Holder = Record<string, unknown>;
/** install a Java-ABI function: compiled code calls it, host code its public face */
export function setJava(target: Holder, mangled: string, fn: unknown, arity: number): void {
  target[xname(mangled)] = fn;
  target[mangled] = publicFace(fn, arity);
}
/** install a host function: host code calls it, compiled code its Java-ABI face */
export function setPublic(target: Holder, mangled: string, fn: unknown, arity: number): void {
  target[mangled] = fn;
  target[xname(mangled)] = javaFace(fn, arity);
}
/** setPublic as properties no enumeration sees: methods on a shared prototype (Object, String, arrays) */
export function definePublic(target: object, mangled: string, fn: unknown, arity: number): void {
  for (const [key, value] of [[mangled, fn], [xname(mangled), javaFace(fn, arity)]] as const)
    Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: false });
}
