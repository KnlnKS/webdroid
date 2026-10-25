// How natives that wait are imported. A native whose registration says it may wait (NativeImpl.wait: `driven`, an async function
// or `waits`) is a Suspending import: the Wasm stack that called it waits for the Promise and other strands run
// meanwhile. Every other native is a plain import, since a Suspending import suspends even when its function answers a value (about 50 ns against 4).
// A plain native that answers a Promise anyway parks its strand (natives.ts `parkable`), and is reported; its arrays are views of linear memory, which may grow
// (detaching them) while it waits, so a native with arrays that may wait has to be declared: `waits`, or `retries` when it can simply be called again.
// The rule JSPI imposes is that no JS frame may sit between the `promising` entry of a strand and the import that suspends: a native on the
// Wasm side of an import must not call Java through a plain call and expect that Java to block.
import type { HostContext, HostFn } from "../link/hostapi.ts";
import { count } from "./stats.ts";

/** natives found answering a Promise from a plain import: the report in run.json (`nativeSuspended`) */
export const suspendedNatives = new Set<string>();

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
  return suspending ? ctx.sched.suspending(build(true)) as HostFn : build(false);
}
