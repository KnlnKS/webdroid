import { never, processExited } from "../process-exit.ts";

// Suspended activations share one Promise per pending operation. Every driven generator waiting
// for it joins the same continuation list, and when the operation settles the list resumes
// innermost to outermost in a single microtask: resuming an N-deep stack costs one Promise hop, not N.

/** Continues a suspended activation with its callee's result or exception. */
type Continuation = (value: unknown, threw: boolean) => unknown;
const FRAMES = Symbol("continuations");
type Suspension = Promise<unknown> & { [FRAMES]?: Continuation[] };

/** An execution that can block: a Java thread as one of its call chains. Chains interleave on a
 *  thread while another is suspended, so class initialization and monitors tell a chain's own
 *  re-entry from another job's. Each entry from host code runs as a strand of its own (callOn),
 *  and every frame resumes as the strand it captured (Runtime.cur). A thread's root strand is Java
 *  that no entry gave a chain (host tools, tests): it shares its thread's locks and class
 *  initializations with every chain of that thread. */
export class Strand {
  readonly thread: unknown; readonly root: boolean;
  constructor(thread: unknown, root = false) { this.thread = thread; this.root = root; }
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
