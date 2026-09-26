// Suspended activations share one Promise per pending operation. Every frame on the stack that
// is waiting for it (compiled, cold or a generator native) joins the same continuation list, and
// when the operation settles the list resumes innermost to outermost in a single microtask:
// resuming an N-deep stack costs one Promise hop, not N.

/** Continues a suspended activation with its callee's result or exception. */
export type Continuation = (value: unknown, threw: boolean) => unknown;
const FRAMES = Symbol("continuations");
type Suspension = Promise<unknown> & { [FRAMES]?: Continuation[] };

/** Wait on `pending` with `k`: the returned Promise settles with the outermost frame's result. */
export function suspendWith(pending: Promise<unknown>, k: Continuation): Promise<unknown> {
  const frames = (pending as Suspension)[FRAMES];
  if (frames) { frames.push(k); return pending; }
  const list = [k];
  const suspension: Suspension = pending.then((value) => unwind(list, 0, value, false), (error) => unwind(list, 0, error, true));
  suspension[FRAMES] = list;
  return suspension;
}

function unwind(list: Continuation[], from: number, value: unknown, threw: boolean): unknown {
  for (let i = from; i < list.length; i++) {
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
