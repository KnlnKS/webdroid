// Suspended activations share one Promise per pending operation. Every frame on the stack that
// is waiting for it (compiled, cold or a generator native) joins the same continuation list, and
// when the operation settles the list resumes innermost to outermost in a single microtask:
// resuming an N-deep stack costs one Promise hop, not N.

/** Continues a suspended activation with its callee's result or exception. */
type Continuation = (value: unknown, threw: boolean) => unknown;
const FRAMES = Symbol("continuations");
type Suspension = Promise<unknown> & { [FRAMES]?: Continuation[] };

/** The call chain running now, across its suspensions: the frames a chain suspends resume as that
 *  chain, so class initialization tells its own chain's re-entry from another job interleaved on
 *  the same Java thread. 0 is a host turn's chain that has not suspended yet. */
let strand = 0, strands = 0;
export const currentStrand = (): number => strand;
/** how often each chain a class-init wait watches has been entered since the wait began */
const runs = new Map<number, { n: number; watchers: number }>();
/** continue as chain `s`; returns the chain to restore */
export function enterStrand(s: number): number {
  const was = strand;
  strand = s;
  if (runs.size !== 0) { const r = runs.get(s); if (r) r.n++; }
  return was;
}
/** chains suspended on a yield to the event loop, which will run again however long a busy page
 *  makes them wait */
const yielding = new Map<number, number>();
/** `pending`, a yield to the event loop, as the running chain's */
export function yieldAs(pending: Promise<void>): Promise<void> {
  const s = strand;
  if (!s) return pending;
  yielding.set(s, (yielding.get(s) ?? 0) + 1);
  const end = () => { const n = yielding.get(s)! - 1; if (n) yielding.set(s, n); else yielding.delete(s); };
  pending.then(end, end);
  return pending;
}
/** watch chain `s` make progress: `ran()` says whether it has run since the last ask or is
 *  waiting only for its turn */
export function watchStrand(s: number): { ran(): boolean; stop(): void } {
  let r = runs.get(s);
  if (!r) runs.set(s, r = { n: 0, watchers: 0 });
  const w = r;
  w.watchers++;
  let seen = w.n;
  return {
    ran: () => { const moved = w.n !== seen || yielding.has(s); seen = w.n; return moved; },
    stop: () => { if (--w.watchers === 0) runs.delete(s); },
  };
}
/** `f` as chain `s`: host code continuing a chain from a later turn */
export function inStrand<T>(s: number, f: () => T): T {
  const was = enterStrand(s);
  try { return f(); } finally { strand = was; }
}
/** a chain apart from every other: an entry, or a call no frame of the running chain waits on,
 *  which that chain may run on past while the call is suspended */
export const newStrand = (): number => ++strands;
/** the current chain, given an identity apart from other host turns' if it has none yet */
export const ownStrand = (): number => strand || newStrand();

/** Wait on `pending` with `k`: the returned Promise settles with the outermost frame's result. */
export function suspendWith(pending: Promise<unknown>, k: Continuation): Promise<unknown> {
  const frames = (pending as Suspension)[FRAMES];
  if (frames) { frames.push(k); return pending; }
  const list = [k], s = ownStrand();
  const suspension: Suspension = pending.then((value) => unwind(list, s, value, false), (error) => unwind(list, s, error, true));
  suspension[FRAMES] = list;
  return suspension;
}

function unwind(list: Continuation[], s: number, value: unknown, threw: boolean): unknown {
  const was = enterStrand(s);
  try { return resume(list, value, threw); } finally { strand = was; }
}

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
