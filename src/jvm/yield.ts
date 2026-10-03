import { clearGuestTimeout, setGuestTimeout, type GuestTimer } from "../guest-clock";
import { never, processExited } from "../process-exit";

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
    posted = false; yieldStats.fires++;
    for (const f of woken.splice(0)) f();
    waiters.shift()?.();
    if (waiters.length) post();
  };
  // an open port keeps a bun/node process alive after its work is done (tests, scripts)
  (chan.port1 as unknown as { unref?: () => void }).unref?.();
}
/** Input the page is answering: background work (native budget slices, compiled-code imports)
 *  stands aside until this long after the latest event. */
const RESPONSIVE_MS = 250;
let responsiveUntil = 0;
export function noteInput(): void { responsiveUntil = Math.max(responsiveUntil, performance.now() + RESPONSIVE_MS); }
export const answeringInput = (now = performance.now()): boolean => now < responsiveUntil;
/** resolves once no input has arrived for the responsive window */
export async function inputSettled(): Promise<void> {
  for (let wait; (wait = responsiveUntil - performance.now()) > 0;) await new Promise((r) => setTimeout(r, wait));
}
/** A realm the user is not looking at, and that no presented process is waiting on: its yields wait
 *  for the page's own work to finish, since every realm shares the page's one main thread and input
 *  goes to the presented one. */
let background = (): boolean => false;
export function setBackgroundRealm(isBackground: () => boolean): void { background = isBackground; }
const scheduler = (globalThis as { scheduler?: { postTask(task: () => void, options: { priority: string }): Promise<void> } }).scheduler;
export function yieldToLoop(): Promise<void> {
  if (processExited()) return never();
  if (scheduler && background()) return scheduler.postTask(() => {}, { priority: "background" });
  if (!chan) return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => { yieldStats.pushes++; waiters.push(r); post(); });
}
/** A parked thread's wake: a macrotask, so its waker runs on to its next await first, ahead of
 *  the threads that only yielded. */
export function wakeSoon(): Promise<void> {
  if (processExited()) return never();
  if (!chan) return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => { woken.push(r); post(); });
}
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
