// Which natives wait, and how they are imported. A native that answers a Promise, is written as a generator that yields
// Java results (`driven`), is an async function or is marked where it is registered (`waits`) is a Suspending import: the Wasm stack that called it waits for the Promise and other strands run
// meanwhile. Every other native is a plain import, since a Suspending import suspends even when its function answers a value (about 50 ns against 4).
// The rule JSPI imposes is that no JS frame may sit between the `promising` entry of a strand and the import that suspends: a native on the
// Wasm side of an import must not call Java through a plain call and expect that Java to block.
import type { HostContext, HostFn } from "../link/hostapi.ts";
import { count } from "./stats.ts";
import { isWaiting } from "../../jvm/runtime.ts";

const AsyncFunction = (async () => {}).constructor;
type Native = HostFn & { $g?: (...a: unknown[]) => Generator<unknown, unknown, unknown> };

/** what a native that can answer a Promise has in its body: it waits for something (`await`, a Promise, `after`, `awaited`), reads memory that pages in (`external`, `pagesIn`, `memoryAt`,
 *  `guestAddress`), or hands on the result of a call into Java, which is a Promise when that call waits. The build lists the natives this holds for (`waitingNatives`), as the page
 *  cannot read it from minified code. A native with arrays needs it: it cannot be settled where it was called (natives.ts `parkable`). */
const WAITS = /\b(after|awaited|pagesIn|external|externalRead|memoryAt|guestAddress|Promise|await)\b|\breturn\s+(vcall|scall|newObj|callOn)\b|=>\s*(vcall|scall|newObj|callOn)\(/;
/** a generator native (`driven`) or an async function, which always runs as Suspending */
const declaredAsync = (fn: HostFn): boolean => (fn as Native).$g !== undefined || fn.constructor === AsyncFunction;
export const mayWait = (fn: HostFn): boolean => declaredAsync(fn) || isWaiting(fn) || WAITS.test(Function.prototype.toString.call(fn));
/** the natives the platform build was made for as Suspending, when the page has it */
let declared: Set<string> | null = null;
export const declareWaiting = (ids: string[]): void => { declared = new Set(ids); };
/** natives found answering a Promise from a plain import: the report in run.json (`nativeSuspended`), and imported as Suspending in modules built afterwards */
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

/** the services the host implements behind binder: what they call may wait, and they take arrays (out parameters) */
export const SERVICES = "webdroid/";
/** whether native `id` is imported as Suspending */
export function suspends(id: string, fn: HostFn, arrays: boolean): boolean {
  return declaredAsync(fn) || isWaiting(fn) || suspendedNatives.has(id) || (arrays && (id.startsWith(SERVICES) || (declared ? declared.has(id) : mayWait(fn))));
}

/** a plain import answered a Promise: nothing can wait there. It is reported, and the next module that imports it gets it as Suspending */
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
