import { processExited } from "./process-exit.ts";
import { connectClock, serveClock, type ClockBootstrap, type ClockClient } from "./shell/clock-port.ts";
import { switchValue } from "./switches.ts";

export type GuestTimer = ReturnType<typeof setTimeout> | number;

type Scheduled = {
  id: number;
  at: number;
  realm: number;
  sequence: number;
  callback: () => unknown;
  acknowledged: boolean;
};

const before = (a: Scheduled, b: Scheduled): boolean =>
  a.at < b.at || (a.at === b.at && (a.realm < b.realm || (a.realm === b.realm && a.sequence < b.sequence)));

export class ControlledGuestClock {
  nowMs: number;
  private heap: Scheduled[] = [];
  private live = new Map<number, number>();
  private nextId = 1;
  private sequence = 0;
  private advancing = Promise.resolve();
  private asynchronousAdvances = 0;

  constructor(nowMs: number) { this.nowMs = nowMs; }

  schedule(callback: () => void, delayMs: number, realm = 0): number {
    return this.enqueue(callback, delayMs, realm, false);
  }

  scheduleAcknowledged(callback: () => Promise<void>, delayMs: number, realm: number): number {
    return this.enqueue(callback, delayMs, realm, true);
  }

  private enqueue(callback: () => unknown, delayMs: number, realm: number, acknowledged: boolean): number {
    const task: Scheduled = {
      id: this.nextId++,
      at: this.nowMs + Math.max(0, delayMs),
      realm,
      sequence: this.sequence++,
      callback,
      acknowledged,
    };
    this.live.set(task.id, realm);
    this.push(task);
    return task.id;
  }

  cancel(id: number): void {
    this.live.delete(id);
  }

  pending(): number {
    return this.live.size;
  }

  nextDeadline(): number | null {
    this.discardCancelled();
    return this.heap[0]?.at ?? null;
  }

  advanceTo(targetMs: number): number {
    if (this.asynchronousAdvances) throw new Error("guest clock is advancing asynchronously");
    if (targetMs < this.nowMs) throw new RangeError("guest time cannot move backwards");
    let ran = 0;
    for (let task = this.takeDue(targetMs, false); task; task = this.takeDue(targetMs, false)) {
      task.callback();
      ran++;
    }
    this.nowMs = targetMs;
    return ran;
  }

  advanceToAsync(targetMs: number, synchronize: (now: number) => Promise<void>): Promise<number> {
    if (targetMs < this.nowMs) return Promise.reject(new RangeError("guest time cannot move backwards"));
    this.asynchronousAdvances++;
    const result = this.advancing.then(() => this.advanceAsync(Math.max(targetMs, this.nowMs), synchronize))
      .finally(() => { this.asynchronousAdvances--; });
    this.advancing = result.then(() => {}, () => {});
    return result;
  }

  private async advanceAsync(targetMs: number, synchronize: (now: number) => Promise<void>): Promise<number> {
    let ran = 0;
    for (;;) {
      await synchronize(this.nowMs);
      const task = this.takeDue(targetMs, true);
      if (!task) break;
      await synchronize(this.nowMs);
      const completion = task.callback();
      if (task.acknowledged) await completion;
      ran++;
    }
    this.nowMs = targetMs;
    await synchronize(this.nowMs);
    return ran;
  }

  private takeDue(target: number, asynchronous: boolean): Scheduled | undefined {
    this.discardCancelled();
    const task = this.heap[0];
    if (!task || task.at > target) return;
    if (task.acknowledged && !asynchronous) throw new Error("remote clock callbacks require asynchronous advancement");
    this.pop(); this.live.delete(task.id); this.nowMs = task.at;
    return task;
  }

  private discardCancelled(): void {
    while (this.heap[0] && !this.live.has(this.heap[0].id)) this.pop();
  }

  private push(task: Scheduled): void {
    let index = this.heap.push(task) - 1;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (!before(task, this.heap[parent])) break;
      this.heap[index] = this.heap[parent];
      index = parent;
    }
    this.heap[index] = task;
  }

  private pop(): Scheduled | undefined {
    const root = this.heap[0];
    const tail = this.heap.pop();
    if (!root || !this.heap.length || !tail) return root;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.heap.length) break;
      const right = left + 1;
      const child = right < this.heap.length && before(this.heap[right], this.heap[left]) ? right : left;
      if (!before(this.heap[child], tail)) break;
      this.heap[index] = this.heap[child];
      index = child;
    }
    this.heap[index] = tail;
    return root;
  }
}

const browser = typeof location !== "undefined" && typeof window !== "undefined";
const controlledGuestTime = browser && switchValue("testClock") === "controlled";
const clock = controlledGuestTime
  ? new ControlledGuestClock(performance.now())
  : null;

const realNow = browser ? performance.now.bind(performance) : () => performance.now();
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
let remoteClock: ClockClient | null = null;
let remoteAttached = false;
const clockPorts = new Set<ReturnType<typeof serveClock>>();
let remoteAdvancement = false;

// HTML timers take a signed 32-bit delay: a longer one (a 30-day retry, a Long.MAX_VALUE wait)
// would wrap and fire at once, so it waits the longest a timer can instead (~24.8 days)
export const MAX_TIMER_DELAY = 0x7fffffff;
/** where a realm's guest time and timers come from: the host's clock, the page's controlled one, or a
 *  Worker's view of the page's over its port */
type ClockSource = {
  now(): number; uptime(): number; wall(): number;
  /** `system`: a timer of the broker's, which plays system_server */
  schedule(callback: () => void, delayMs: number, system: boolean): GuestTimer;
  cancel(timer: GuestTimer): void;
};
/** the page's start: every realm's CLOCK_MONOTONIC (SystemClock.uptimeMillis, System.nanoTime) counts from it */
export let bootTime = performance.timeOrigin;
const hostClock: ClockSource = {
  now: realNow, uptime: () => performance.timeOrigin - bootTime + realNow(), wall: () => Date.now(),
  schedule: (callback, delayMs) => realSetTimeout(callback, Math.min(delayMs, MAX_TIMER_DELAY)),
  cancel: (timer) => realClearTimeout(timer as ReturnType<typeof setTimeout>),
};
export let guestNow: () => number;
/** CLOCK_MONOTONIC in milliseconds, one clock for every realm of the page */
export let uptimeMillis: () => number;
/** CLOCK_REALTIME in milliseconds: the host's, or under a controlled clock the host's at the
 *  clock's start advancing with guest time, as a device's wall clock advances with its uptime */
export let wallMillis: () => number;
export let setGuestTimeout: (callback: () => void, delayMs?: number) => GuestTimer;
/** a timer of the broker's, which plays system_server: no app process's death stops it */
export let setSystemTimeout: (callback: () => void, delayMs?: number) => GuestTimer;
export let clearGuestTimeout: (timer: GuestTimer | null | undefined) => void;
// a dead process's timers never fire
const live = (callback: () => void) => () => { if (!processExited()) callback(); };
/** the realm's clock from now on: the exports are the source's own functions, so reading the time costs no more */
function use(source: ClockSource): void {
  ({ now: guestNow, uptime: uptimeMillis, wall: wallMillis } = source);
  setGuestTimeout = (callback, delayMs = 0) => source.schedule(live(callback), delayMs, false);
  setSystemTimeout = (callback, delayMs = 0) => source.schedule(callback, delayMs, true);
  clearGuestTimeout = (timer) => { if (timer != null) source.cancel(timer); };
}
const wallAtStart = clock ? Date.now() - clock.nowMs : 0;
use(clock ? { now: () => clock.nowMs, uptime: () => clock.nowMs, wall: () => wallAtStart + clock.nowMs,
  schedule: (callback, delayMs, system) => clock.schedule(callback, delayMs, system ? -1 : 0), cancel: (timer) => clock.cancel(Number(timer)) } : hostClock);
export const guestSleep = (ms: number): Promise<void> => new Promise((resolve) => setGuestTimeout(resolve, ms));

/** The broker transfers data.port with a process bootstrap; process death calls close. */
export function createGuestClockPort(pid: number): { data: ClockBootstrap; close(): void } {
  const data: ClockBootstrap = { controlled: !!clock, now: guestNow(), bootTime, wallAtStart };
  if (!clock) return { data, close() {} };
  const { port1, port2 } = new MessageChannel();
  const served = serveClock(port1, clock, pid, () => clockPorts.delete(served), () => void advanceTo(clock.nowMs));
  remoteAdvancement = true;
  clockPorts.add(served); data.port = port2;
  return { data, close: served.close };
}

/** Install before boot creates a timer or reads Android's clocks. */
export function attachGuestClockPort(data: ClockBootstrap): void {
  if (clock || remoteAttached) throw new Error("guest clock is already attached");
  remoteAttached = true;
  bootTime = data.bootTime;
  remoteClock = connectClock(data);
  const client = remoteClock;
  if (client) use({ now: () => client.now, uptime: () => client.now, wall: () => data.wallAtStart + client.now,
    schedule: (callback, delayMs) => client.schedule(callback, delayMs), cancel: (timer) => client.cancel(Number(timer)) });
}

const hostYield = (): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, 0));
const advanceTo = async (targetMs: number): Promise<number> => {
  if (!clock) return 0;
  const target = Math.max(targetMs, clock.nowMs);
  const ran = remoteAdvancement ? await clock.advanceToAsync(target, async now => {
    await Promise.all([...clockPorts].map(port => port.synchronize(now)));
  }) : clock.advanceTo(target);
  await hostYield();
  return ran;
};
export const guestClockControl = {
  get controlled() { return controlledGuestTime || remoteClock !== null; },
  now: () => guestNow(),
  pending: () => clock?.pending() ?? 0,
  nextDeadline: () => clock?.nextDeadline() ?? null,
  advanceTo,
  advanceBy: async (durationMs: number): Promise<number> => {
    if (!clock) return 0;
    const end = clock.nowMs + Math.max(0, durationMs);
    let ran = 0;
    for (let next = clock.nextDeadline(); next !== null && next <= end; next = clock.nextDeadline())
      ran += await advanceTo(next);
    ran += await advanceTo(end);
    return ran;
  },
  drive: async <T>(operation: Promise<T>, maxVirtualMs: number): Promise<T> => {
    if (!clock) return operation;
    const end = clock.nowMs + Math.max(0, maxVirtualMs);
    let finished = false;
    void operation.then(() => { finished = true; }, () => { finished = true; });
    while (!finished) {
      const next = clock.nextDeadline();
      if (next !== null && next <= end) await advanceTo(next);
      else await hostYield();
    }
    return operation;
  },
  dispose: (): number => remoteClock?.close() ?? 0,
};
