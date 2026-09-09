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
export const yieldStats = { pushes: 0, fires: 0, pending: () => waiters.length, kick: () => { const w = waiters.splice(0); for (const f of w) f(); return w.length; } };
