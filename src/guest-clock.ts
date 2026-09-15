export type GuestTimer = ReturnType<typeof setTimeout> | number;

type Scheduled = {
  id: number;
  at: number;
  realm: number;
  sequence: number;
  interval: number;
  callback: () => void;
};

const before = (a: Scheduled, b: Scheduled): boolean =>
  a.at < b.at || (a.at === b.at && (a.realm < b.realm || (a.realm === b.realm && a.sequence < b.sequence)));

export class ControlledGuestClock {
  private heap: Scheduled[] = [];
  private live = new Set<number>();
  private nextId = 1;
  private sequence = 0;

  constructor(public nowMs: number) {}

  schedule(callback: () => void, delayMs: number, realm = 0, intervalMs = 0): number {
    const task: Scheduled = {
      id: this.nextId++,
      at: this.nowMs + Math.max(0, delayMs),
      realm,
      sequence: this.sequence++,
      interval: Math.max(0, intervalMs),
      callback,
    };
    this.live.add(task.id);
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
    if (targetMs < this.nowMs) throw new RangeError("guest time cannot move backwards");
    let ran = 0;
    for (;;) {
      this.discardCancelled();
      const task = this.heap[0];
      if (!task || task.at > targetMs) break;
      this.pop();
      if (!this.live.has(task.id)) continue;
      this.nowMs = task.at;
      if (!task.interval) this.live.delete(task.id);
      task.callback();
      ran++;
      if (task.interval && this.live.has(task.id)) {
        task.at += task.interval;
        task.sequence = this.sequence++;
        this.push(task);
      }
    }
    this.nowMs = targetMs;
    return ran;
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

type ClockHost = typeof globalThis & { __wdGuestClock?: ControlledGuestClock };
const browser = typeof location !== "undefined" && typeof window !== "undefined";
export const controlledGuestTime = browser && new URLSearchParams(location.search).get("testClock") === "controlled";
const realm = browser ? Number(new URLSearchParams(location.search).get("pid") ?? 0) : 0;
const clock = controlledGuestTime
  ? (((window.top as unknown as ClockHost).__wdGuestClock ??= new ControlledGuestClock(performance.now())))
  : null;

const realNow = browser ? performance.now.bind(performance) : () => performance.now();
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
const realSetInterval = globalThis.setInterval.bind(globalThis);
const realClearInterval = globalThis.clearInterval.bind(globalThis);

export const guestNow = clock ? () => clock.nowMs : realNow;
export const setGuestTimeout = clock
  ? (callback: () => void, delayMs = 0): GuestTimer => clock.schedule(callback, delayMs, realm)
  : (callback: () => void, delayMs = 0): GuestTimer => realSetTimeout(callback, delayMs);
export const clearGuestTimeout = clock
  ? (timer: GuestTimer | null | undefined): void => { if (timer != null) clock.cancel(Number(timer)); }
  : (timer: GuestTimer | null | undefined): void => { if (timer != null) realClearTimeout(timer as ReturnType<typeof setTimeout>); };
export const setGuestInterval = clock
  ? (callback: () => void, intervalMs: number): GuestTimer => clock.schedule(callback, intervalMs, realm, intervalMs)
  : (callback: () => void, intervalMs: number): GuestTimer => realSetInterval(callback, intervalMs);
export const clearGuestInterval = clock
  ? (timer: GuestTimer | null | undefined): void => { if (timer != null) clock.cancel(Number(timer)); }
  : (timer: GuestTimer | null | undefined): void => { if (timer != null) realClearInterval(timer as ReturnType<typeof setInterval>); };
export const guestSleep = (ms: number): Promise<void> => new Promise((resolve) => setGuestTimeout(resolve, ms));

const hostYield = (): Promise<void> => new Promise((resolve) => realSetTimeout(resolve, 0));
export const guestClockControl = {
  controlled: controlledGuestTime,
  now: guestNow,
  pending: () => clock?.pending() ?? 0,
  nextDeadline: () => clock?.nextDeadline() ?? null,
  advanceTo: async (targetMs: number): Promise<number> => {
    if (!clock) return 0;
    const ran = clock.advanceTo(Math.max(targetMs, clock.nowMs));
    await hostYield();
    return ran;
  },
};
