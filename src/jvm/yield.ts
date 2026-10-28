import { clearGuestTimeout, setGuestTimeout, type GuestTimer } from "../guest-clock.ts";
import { never, processExited } from "../process-exit.ts";
import { note, Ev } from "../timeline.ts";

// A macrotask boundary so the main looper, rAF and other cooperative threads get the JS thread.
// MessageChannel is not subject to the nested-setTimeout clamp (4 ms once the chain is nested),
// which is what a computation that yields every few milliseconds would otherwise spend idle in.
// Each turn resumes one yielded thread, after every thread woken since the last turn, so a wake
// waits out one thread's slice rather than a round of every runnable thread's.
// Node delivers up to 1000 queued port messages before it runs a timer, so a thread yielding every
// turn would hold a sleeper's wake back 1000 turns: there a turn is a setImmediate, between which
// timers run, and which holds the process open only while one is posted.
type NodePort = MessagePort & { unref?(): void };
const chan = typeof setImmediate === "function" ? null : new MessageChannel();
const waiters: (() => void)[] = [], woken: (() => void)[] = [];
let posted = false;
const fire = (): void => {
  posted = false; yieldStats.fires++; turnArmed = false; note(Ev.Turn);
  for (const f of woken.splice(0)) f();
  waiters.shift()?.();
  if (waiters.length) post();
};
const post = (): void => {
  if (posted) return;
  posted = true;
  if (chan) chan.port2.postMessage(0); else setImmediate(fire);
};
if (chan) chan.port1.onmessage = fire;
/** How long the current macrotask has held the JS thread, from the first time this turn asked: a
 *  turn ends at its own message, or when the yield channel starts the next. */
let turnStart = 0, turnArmed = false;
const turnChannel = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
if (turnChannel) {
  turnChannel.port1.onmessage = () => { turnArmed = false; };
  (turnChannel.port1 as NodePort).unref?.();
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
/** Requests to a realm that answers them at once (the page kernel's file calls) still awaited: the
 *  thread that made one runs again only between other threads' slices, which stay short meanwhile. */
let promptWaits = 0;
export function awaitingPrompt<T>(p: Promise<T>): Promise<T> {
  promptWaits++;
  return p.finally(() => { promptWaits--; });
}
export const promptPending = (): boolean => promptWaits > 0;
/** a later turn, after what `queue` already holds */
function turn(queue: (() => void)[]): Promise<void> {
  if (processExited()) return never();
  return new Promise((r) => { yieldStats.pushes++; queue.push(r); post(); });
}
export const yieldToLoop = (): Promise<void> => turn(waiters);
/** A macrotask ahead of the threads that only yielded: a parked thread's wake (so its waker runs
 *  on to its next await first), the main looper's turn. */
export const wakeSoon = (): Promise<void> => turn(woken);
const host = (globalThis as { scheduler?: { postTask(f: () => void, o: { priority: "background" }): Promise<void> } }).scheduler;
/** A turn once no other task is queued (the host's background priority): frames, input, timers and yielded threads go first.
 *  Null in a host without task priorities. */
export const idleTurn = host ? (): Promise<void> => host.postTask(() => {}, { priority: "background" }) : null;
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
