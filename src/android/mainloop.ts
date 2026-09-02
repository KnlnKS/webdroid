// Android's main looper is a single serialized queue; our async chains must not
// interleave (Handler posts vs layout passes vs input) or androidx internals race
// (e.g. ViewPager fragment double-add). Every main-thread entry point routes here.
// Each job runs with curThread pinned to the main thread so Looper/Thread identity
// checks (androidx enforceMainThread, fragment host asserts) see the main thread.
import { curThread, setCurThread, mainThread } from "../jvm/natives/jlang";

let q: Promise<unknown> = Promise.resolve();

/** Debug: set true to record where the job that is currently hogging the queue came from. */
export const mainDbg = { trace: false, running: "", started: 0, depth: 0 };

/**
 * Are we running inside a main-looper job right now? Thread identity is NOT the same
 * question: curThread is pinned to the main thread by every job AND by boot, so a chain
 * that only set it would run "inline" while the queue is free to interleave with it at
 * every await. Callers that must not re-enter the queue (they already hold it) test this.
 */
export function inMainJob(): boolean { return mainDbg.depth > 0; }

export function onMain<T>(job: () => Promise<T> | T): Promise<T> {
  const site = mainDbg.trace ? new Error().stack ?? "" : "";
  const p = q.then(async () => {
    const prev = curThread;
    setCurThread(mainThread);
    mainDbg.depth++;
    if (mainDbg.trace) { mainDbg.running = site; mainDbg.started = Date.now(); }
    try {
      return await job();
    } finally {
      mainDbg.depth--;
      setCurThread(prev);
    }
  });
  q = p.catch(() => { /* a failed job must not poison the queue */ });
  return p;
}
