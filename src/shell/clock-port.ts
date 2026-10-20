import type { ControlledGuestClock } from "../guest-clock.ts";
import { duplex, methodsOf } from "./process-port.ts";

export type ClockBootstrap = { controlled: boolean; now: number; bootTime: number; wallAtStart: number; port?: MessagePort };
export interface ClockClient {
  readonly now: number;
  schedule(callback: () => void, delay: number): number;
  cancel(id: number): void;
  close(): number;
}
/** the page's clock as a Worker realm asks it, by the realm's timer ids */
type ClockCalls = { schedule(id: number, at: number): void; cancel(id: number): void };
const clockMethods = methodsOf<ClockCalls>()(["schedule", "cancel"]);
/** a Worker realm's clock as the page drives it: the guest time, then the timer due at it (0: none) */
type ClockTicks = { tick(now: number, timer: number): Promise<void> };

/** Scheduling and completion use the same port: timers posted by a callback precede its acknowledgment.
 *  A timer due when it arrives, posted before the realm saw an advance past its time, calls `due`:
 *  that advance has finished, and the next may wait on the timer (a looper's wake-up). */
export function serveClock(port: MessagePort, clock: ControlledGuestClock, realm: number, onClose: () => void, due: () => void) {
  const timers = new Map<number, number>();
  // a realm that has gone acknowledges nothing more
  const tick = (now: number, timer = 0) => worker.endpoint.tick(now, timer).catch(() => {});
  const worker = duplex<ClockCalls, ClockTicks>(port, {
    schedule(id, at) {
      if (!Number.isSafeInteger(id) || id < 1 || typeof at !== "number" || Number.isNaN(at) || at === -Infinity || timers.has(id)) throw new Error("invalid clock timer");
      timers.set(id, clock.scheduleAcknowledged(() => { timers.delete(id); return tick(clock.nowMs, id); }, Math.max(0, at - clock.nowMs), realm));
      if (at <= clock.nowMs) due();
    },
    cancel(id) { const timer = timers.get(id); if (timer !== undefined) clock.cancel(timer); timers.delete(id); },
  }, ["tick"], [], () => { for (const timer of timers.values()) clock.cancel(timer); timers.clear(); onClose(); });
  return { close: worker.close, synchronize: (now: number) => tick(now) };
}

export function connectClock(data: ClockBootstrap): ClockClient | null {
  if (!data.controlled) { data.port?.close(); return null; }
  if (!data.port) throw new Error("controlled clock has no broker port");
  const timers = new Map<number, () => void>();
  let now = data.now, nextTimer = 1, closed = false;
  const page = duplex<ClockTicks, ClockCalls>(data.port, { tick: async (next, timer) => {
    now = next;
    const callback = timers.get(timer); timers.delete(timer);
    // a throwing callback is the realm's unhandled error, as a timer's is
    try { callback?.(); } catch (error) { void Promise.reject(error); }
    await Promise.resolve();
  } }, clockMethods, clockMethods, () => { closed = true; timers.clear(); });
  return {
    get now() { return now; },
    close() { const count = timers.size; page.close(); return count; },
    schedule(callback, delay) {
      if (closed) throw new Error("clock endpoint closed");
      const id = nextTimer++; timers.set(id, callback);
      page.endpoint.schedule(id, now + Math.max(0, delay));
      return id;
    },
    cancel(id) { if (closed) return; timers.delete(id); page.endpoint.cancel(id); },
  };
}
