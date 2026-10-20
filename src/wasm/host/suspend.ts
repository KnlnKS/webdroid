// Which natives wait, and how they are imported. A native written as a generator that yields Java results (`driven`), an async function
// or one marked where it is registered (`waits`) is a Suspending import: the Wasm stack that called it waits for the Promise and other strands run
// meanwhile. Every other native is a plain import, since a Suspending import suspends even when its function answers a value (about 50 ns against 4).
// A plain native that answers a Promise anyway parks its strand (natives.ts `parkable`), and is reported; its arrays are views of linear memory, which may grow
// (detaching them) while it waits, so a native with arrays that may wait has to be declared.
// The rule JSPI imposes is that no JS frame may sit between the `promising` entry of a strand and the import that suspends: a native on the
// Wasm side of an import must not call Java through a plain call and expect that Java to block.
import type { HostContext, HostFn } from "../link/hostapi.ts";
import { count } from "./stats.ts";
import { isWaiting } from "../../jvm/runtime.ts";

const AsyncFunction = (async () => {}).constructor;
type Native = HostFn & { $g?: (...a: unknown[]) => Generator<unknown, unknown, unknown> };

/** whether native `fn` is declared to wait, which makes it a Suspending import */
export const mayWait = (fn: HostFn): boolean => (fn as Native).$g !== undefined || fn.constructor === AsyncFunction || isWaiting(fn);
/** natives found answering a Promise from a plain import: the report in run.json (`nativeSuspended`) */
export const suspendedNatives = new Set<string>();

/** the context of the Suspending import being called, for the generator driver that starts inside it */
let calling: HostContext | null = null;

/** whether native `fn` answers a Promise on every call, which only a Suspending import can take */
export const waitsAlways = (fn: HostFn): boolean => fn.constructor === AsyncFunction;

/** the Wasm tier's form of a registered native: a generator native runs under an async driver of its own, not Runtime.drive */
export function hostForm(fn: HostFn): HostFn {
  const g = (fn as Native).$g;
  if (!g) return fn;
  return function (this: unknown, ...a: unknown[]) { return drive(g.apply(this, a), calling); };
}
/** runs a generator native: each value it yields is awaited, an exception of a rejected one is thrown into it; the strand is the running one again after each wait,
 *  until the native waits again (other turns run at the top level then), as Runtime.drive keeps it. A step that follows a value yielded at once is still
 *  the strand's: without it, Java the native enters there runs as the host's current thread */
async function drive(it: Generator<unknown, unknown, unknown>, ctx: HostContext | null): Promise<unknown> {
  const strand = ctx?.sched.running ?? null;
  let resumed = false;
  try {
    let step = it.next();
    while (!step.done) {
      let v = step.value, threw = false;
      if (v instanceof Promise) {
        if (resumed) ctx!.sched.running = null;
        try { v = await v; } catch (e) { v = e; threw = true; }
        resumed = ctx !== null;
      }
      if (resumed) ctx!.sched.running = strand;
      step = threw ? it.throw(v) : it.next(v);
    }
    return step.value;
  } finally { if (resumed) ctx!.sched.running = null; }
}

/** a plain import answered a Promise: it is reported, as a native that waits is declared */
export function reportSuspended(id: string): void {
  if (!suspendedNatives.has(id)) count("wasmNativeSuspended");
  suspendedNatives.add(id);
}

/** a call the engine refused to suspend because a JS frame sits between the strand's entry and the import: counted, and the error goes on */
export function reportSuspendError(e: unknown): void {
  if (e instanceof Error && e.name === "SuspendError") count("wasmSuspendErrors");
}

/** installs a native as a Wasm import: `build(false)` is the plain form, `build(true)` the one that may wait, wrapped for the engine so the strand that
 *  called it waits for the Promise it answers (the globals that name the strand are restored by the generated call, natives.ts) */
export function adaptImport(build: (suspending: boolean) => HostFn, ctx: HostContext, suspending: boolean): HostFn {
  if (!suspending) return build(false);
  const f = build(true);
  return ctx.sched.suspending((...a: unknown[]) => {
    calling = ctx;
    try { return f(...a); } finally { calling = null; }
  }) as HostFn;
}
