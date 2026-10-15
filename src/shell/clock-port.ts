import type { ControlledGuestClock } from "../guest-clock";

export type ClockBootstrap = { controlled: boolean; now: number; bootTime: number; wallAtStart: number; port?: MessagePort };
export interface ClockClient {
  readonly now: number;
  schedule(callback: () => void, delay: number): number;
  cancel(id: number): void;
  close(): number;
}
type Request = { kind: "schedule"; id: number; at: number } | { kind: "cancel" | "ack"; id: number } | { kind: "close" };
type Tick = { kind: "sync" | "fire"; id: number; now: number; timer?: number } | { kind: "close" };

/** Scheduling and completion use the same port: timers posted by a callback precede its acknowledgment.
 *  A timer due when it arrives, posted before the realm saw an advance past its time, calls `due`:
 *  that advance has finished, and the next may wait on the timer (a looper's wake-up). */
export function serveClock(port: MessagePort, clock: ControlledGuestClock, realm: number, onClose: () => void, due: () => void) {
  const timers = new Map<number, number>(), pending = new Map<number, () => void>();
  let nextRequest = 1, closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    for (const timer of timers.values()) clock.cancel(timer);
    timers.clear();
    for (const finish of pending.values()) finish();
    pending.clear();
    port.postMessage({ kind: "close" } satisfies Tick); port.close(); onClose();
  };
  const send = (kind: "sync" | "fire", now: number, timer?: number): Promise<void> => {
    if (closed) return Promise.resolve();
    return new Promise(resolve => {
      const id = nextRequest++; pending.set(id, resolve);
      port.postMessage({ kind, id, now, timer } satisfies Tick);
    });
  };
  port.onmessageerror = close;
  port.onmessage = ({ data }: MessageEvent<Request>) => {
    if (closed) return;
    if (data.kind === "close") { close(); return; }
    if (data.kind === "ack") { const finish = pending.get(data.id); pending.delete(data.id); finish?.(); return; }
    if (data.kind === "cancel") { const timer = timers.get(data.id); if (timer !== undefined) clock.cancel(timer); timers.delete(data.id); return; }
    if (data.kind !== "schedule") return;
    if (!Number.isSafeInteger(data.id) || data.id < 1 || typeof data.at !== "number" || Number.isNaN(data.at) || data.at === -Infinity || timers.has(data.id)) { close(); return; }
    timers.set(data.id, clock.scheduleAcknowledged(() => {
      timers.delete(data.id);
      return send("fire", clock.nowMs, data.id);
    }, Math.max(0, data.at - clock.nowMs), realm));
    if (data.at <= clock.nowMs) due();
  };
  return { close, synchronize: (now: number) => send("sync", now) };
}

export function connectClock(data: ClockBootstrap): ClockClient | null {
  if (!data.controlled) { data.port?.close(); return null; }
  if (!data.port) throw new Error("controlled clock has no broker port");
  const port = data.port, timers = new Map<number, () => void>();
  let now = data.now, nextTimer = 1, closed = false;
  const close = () => {
    if (closed) return 0;
    closed = true;
    const count = timers.size; timers.clear();
    port.postMessage({ kind: "close" } satisfies Request); port.close(); return count;
  };
  port.onmessageerror = close;
  port.onmessage = async ({ data }: MessageEvent<Tick>) => {
    if (closed) return;
    if (data.kind === "close") { close(); return; }
    now = data.now;
    try {
      if (data.kind === "fire") { const callback = timers.get(data.timer!); timers.delete(data.timer!); callback?.(); }
      await Promise.resolve();
    } finally { if (!closed) port.postMessage({ kind: "ack", id: data.id } satisfies Request); }
  };
  return {
    get now() { return now; }, close,
    schedule(callback, delay) {
      if (closed) throw new Error("clock endpoint closed");
      const id = nextTimer++; timers.set(id, callback);
      port.postMessage({ kind: "schedule", id, at: now + Math.max(0, delay) } satisfies Request);
      return id;
    },
    cancel(id) { if (closed) return; timers.delete(id); port.postMessage({ kind: "cancel", id } satisfies Request); },
  };
}
