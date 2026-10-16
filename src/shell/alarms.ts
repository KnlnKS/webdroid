import type { PendingIntents } from "./pendingintents.ts";
import { clearGuestTimeout, setSystemTimeout, wallMillis, type GuestTimer } from "../guest-clock.ts";

type Alarm = { type: number; at: number; interval: number; unwatch: () => void };
export class Alarms {
  private intents: PendingIntents; private elapsed: () => number; private report: (error: unknown) => void;
  private entries = new Map<number, Alarm>();
  private timer: GuestTimer | null = null;
  constructor(intents: PendingIntents, elapsed: () => number, report: (error: unknown) => void) { this.intents = intents; this.elapsed = elapsed; this.report = report; }
  cancel(id: number): void {
    const alarm = this.entries.get(id);
    if (!alarm) return;
    this.entries.delete(id); alarm.unwatch(); this.arm();
  }
  /** a package's data clear: AlarmManagerInternal.removeAlarmsForUid */
  clear(_pkg: string, uid: number | undefined): void {
    for (const id of [...this.entries.keys()]) if (uid !== undefined && this.intents.get(id)?.uid === uid) this.cancel(id);
  }
  schedule(id: number, type: number, at: number, interval: number): void {
    this.cancel(id);
    const unwatch = this.intents.watch(id, () => this.cancel(id));
    if (!unwatch) return;
    this.entries.set(id, { type, at, interval, unwatch }); this.arm();
  }
  private arm(): void {
    if (this.timer !== null) { clearGuestTimeout(this.timer); this.timer = null; }
    let delay = Infinity;
    const wall = wallMillis(), elapsed = this.elapsed();
    for (const alarm of this.entries.values()) delay = Math.min(delay, alarm.at - (alarm.type < 2 ? wall : elapsed));
    if (delay !== Infinity) this.timer = setSystemTimeout(() => this.fire(), Math.max(0, Math.min(delay, 0x7fffffff)));
  }
  private fire(): void {
    this.timer = null;
    const wall = wallMillis(), elapsed = this.elapsed();
    for (const [id, alarm] of this.entries) {
      const now = alarm.type < 2 ? wall : elapsed;
      if (alarm.at > now) continue;
      const count = alarm.interval ? 1 + Math.floor((now - alarm.at) / alarm.interval) : 1;
      if (alarm.interval) alarm.at += count * alarm.interval;
      else { this.entries.delete(id); alarm.unwatch(); }
      void this.intents.send(id, null, Math.min(count, 0x7fffffff)).catch(error => {
        if (this.entries.get(id) === alarm) this.cancel(id);
        this.report(error);
      });
    }
    this.arm();
  }
}
