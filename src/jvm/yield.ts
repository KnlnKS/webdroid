import { clearGuestTimeout, setGuestTimeout, type GuestTimer } from "../guest-clock";

// A macrotask boundary so the main looper, rAF and other cooperative threads get the JS thread.
// MessageChannel is not subject to the nested-setTimeout clamp (4 ms once the chain is nested),
// which is what a computation that yields every few milliseconds would otherwise spend idle in.
const chan = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
const waiters: (() => void)[] = [];
if (chan) {
  chan.port1.onmessage = () => { yieldStats.fires++; const w = waiters.splice(0); for (const f of w) f(); };
  // an open port keeps a bun/node process alive after its work is done (tests, scripts)
  (chan.port1 as unknown as { unref?: () => void }).unref?.();
}
export function yieldToLoop(): Promise<void> {
  if (!chan) return new Promise((r) => setTimeout(r, 0));
  return new Promise((r) => { yieldStats.pushes++; if (waiters.push(r) === 1) chan.port2.postMessage(0); });
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
export const yieldStats = { pushes: 0, fires: 0, pending: () => waiters.length };
