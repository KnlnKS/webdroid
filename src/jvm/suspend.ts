/** An execution that can block: a Java thread as one of its call chains. Chains interleave on a
 *  thread while another is suspended, so class initialization and monitors tell a chain's own
 *  re-entry from another job's. Each entry from host code runs as a strand of its own (callOn),
 *  and every frame resumes as the strand it captured (Runtime.cur). A thread's root strand is Java
 *  that no entry gave a chain (host tools, tests): it shares its thread's locks and class
 *  initializations with every chain of that thread. */
export class Strand {
  readonly thread: unknown; readonly root: boolean;
  /** the tier's strand this one is the host's side of (host/entry.ts), which no other strand has */
  tier: unknown = null;
  constructor(thread: unknown, root = false) { this.thread = thread; this.root = root; }
}

/** a value computed by its first asker and kept. Askers meanwhile wait for the same computation; a
 *  failure is not kept, so the next asker computes again. */
export function once<T>(make: () => PromiseOrVal<T>): () => PromiseOrVal<T> {
  let value: { v: T } | null = null, pending: Promise<T> | null = null;
  return () => {
    if (value) return value.v;
    if (pending) return pending;
    const v = make();
    if (!(v instanceof Promise)) { value = { v }; return v; }
    return pending = v.then((done) => { value = { v: done }; pending = null; return done; }, (e) => { pending = null; throw e; });
  };
}
