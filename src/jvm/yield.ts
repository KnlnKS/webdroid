import { clearGuestTimeout, setGuestTimeout, type GuestTimer } from "../guest-clock.ts";
import { never, processExited } from "../process-exit.ts";
import { note, Ev } from "../timeline.ts";

// A macrotask boundary so the main looper, rAF and other cooperative threads get the JS thread.
// MessageChannel is not subject to the nested-setTimeout clamp (4 ms once the chain is nested),
// which is what a computation that yields every few milliseconds would otherwise spend idle in.
// Each turn resumes one yielded thread, after every thread woken since the last turn, so a wake
// waits out one thread's slice rather than a round of every runnable thread's.
const chan = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
const waiters: (() => void)[] = [], woken: (() => void)[] = [];
let posted = false;
const post = (): void => { if (!posted) { posted = true; chan!.port2.postMessage(0); } };
if (chan) {
  chan.port1.onmessage = () => {
    posted = false; yieldStats.fires++; turnArmed = false; note(Ev.Turn);
    for (const f of woken.splice(0)) f();
    waiters.shift()?.();
    if (waiters.length) post();
  };
  // an open port keeps a bun/node process alive after its work is done (tests, scripts)
  (chan.port1 as unknown as { unref?: () => void }).unref?.();
}
/** How long the current macrotask has held the JS thread, from the first time this turn asked: a
 *  turn ends at its own message, or when the yield channel starts the next. */
let turnStart = 0, turnArmed = false;
const turnChannel = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
if (turnChannel) {
  turnChannel.port1.onmessage = () => { turnArmed = false; };
  (turnChannel.port1 as unknown as { unref?: () => void }).unref?.();
}
export function turnElapsed(): number {
  const now = performance.now();
  if (!turnArmed && turnChannel) { turnArmed = true; turnStart = now; turnChannel.port2.postMessage(0); }
  return now - turnStart;
}
/** Input the page is answering: background work (native budget slices, compiled-code imports)
 *  stands aside until this long after the latest event. */
const RESPONSIVE_MS = 250;
let responsiveUntil = 0, lastInput = -Infinity;
export function noteInput(): void { lastInput = performance.now(); responsiveUntil = lastInput + RESPONSIVE_MS; }
/** how long ago the latest input arrived */
export const sinceInput = (now = performance.now()): number => now - lastInput;
/** how much longer input is being answered, 0 once it is not */
export const answeringFor = (now = performance.now()): number => Math.max(0, responsiveUntil - now);
/** a later turn, after what `queue` already holds */
function turn(queue: (() => void)[]): Promise<void> {
  if (processExited()) return never();
  if (!chan) return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => { yieldStats.pushes++; queue.push(r); post(); });
}
export const yieldToLoop = (): Promise<void> => turn(waiters);
/** A macrotask ahead of the threads that only yielded: a parked thread's wake (so its waker runs
 *  on to its next await first), the main looper's turn. */
export const wakeSoon = (): Promise<void> => turn(woken);
/** Timers that are a thread waiting with a deadline rather than scheduled work: a park, a timed
 *  monitor wait, a futex or semaphore timeout. An idle observer ignores them; everything else it
 *  must wait for. */
export const timedParks = new Set<GuestTimer>();
export function parkTimeout(fn: () => void, ms: number): GuestTimer {
  const id = setGuestTimeout(() => { timedParks.delete(id); fn(); }, ms);
  timedParks.add(id);
  return id;
}
export function unparkTimeout(id: GuestTimer | undefined): void {
  if (id === undefined) return;
  timedParks.delete(id);
  clearGuestTimeout(id);
}
export const yieldStats = { pushes: 0, fires: 0, pending: () => waiters.length + woken.length };
