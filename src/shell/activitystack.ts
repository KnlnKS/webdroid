// ActivityTaskManager's part the broker plays across processes: the activities each launch stacks
// on its caller's, which process is in front, which are shown beneath a translucent one, and their
// visibility changes, made one at a time. The shown processes' canvases are layered to match.
import type { ParcelData } from "../android/binder";
import { guestSleep } from "../guest-clock";
import type { ActivityRequest, Entry } from "./processes";

/** AOSP ActivityRecord: how long the previous activity may take to pause, then to stop */
const PAUSE_TIMEOUT_MS = 500, STOP_TIMEOUT_MS = 11_000;
/** an activity a process launched in another: `previous` was in front, `request` is the caller's */
type Activity = { id: number; pid: number; caller: number; previous: number; request: number };
/** the broker's processes: `entry` throws for a dead one; `activity` sends one a request */
export type StackPort = {
  entry(pid: number): Entry;
  alive(pid: number): boolean;
  entries(): Iterable<Entry>;
  connect(pkg: string, process: string): Entry;
  activity(entry: Entry, request: ActivityRequest): Promise<void>;
  /** turns the display to the orientation of the process whose activity sets it; the page's own
   *  process turns the display itself */
  rotate(entry: Entry): Promise<void>;
};

export class ActivityStack {
  private activities: Activity[] = [];
  private queue: Promise<void> = Promise.resolve();
  private nextId = 1;
  private top = 0;
  private shownPids = new Set<number>();
  /** the shown processes as show() last layered them, bottom to top */
  private layers: number[] = [];
  /** the display turning for the last orientation the process that fills it reported */
  private following: Promise<void> = Promise.resolve();
  /** `sensor`: the physical rotation, landscape or not. Like the proposed rotation DisplayRotation
   *  reads from the orientation sensor, it is device-wide state, not an event: it starts as the
   *  screen is configured, and each rotation sets it. */
  constructor(private port: StackPort, private sensor: boolean) {}

  get foreground(): number { return this.top; }
  shownEntries(): Entry[] { return this.layers.filter(pid => this.port.alive(pid)).map(pid => this.port.entry(pid)); }
  /** `pid` alone in front */
  setForeground(pid: number): void { this.top = pid; this.shownPids = new Set([pid]); this.layers = [pid]; }
  presentation(pid: number, translucent: boolean): void {
    const entry = this.port.entry(pid);
    if (entry.translucent === translucent) return;
    entry.translucent = translucent;
    if (pid === this.top) void this.enqueue(() => pid === this.top ? this.show(pid) : Promise.resolve());
  }
  /** a process reports the orientation its display turned to */
  orientation(pid: number, landscape: boolean): void {
    const entry = this.port.entry(pid);
    entry.landscape = landscape;
    if (pid === this.layers[0]) this.following = this.port.rotate(entry);
  }
  /**
   * A physical rotation sets the sensor's state and goes to the process whose activity fills the
   * display, as DisplayRotation resolves the sensor's rotation against the orientation that
   * activity requested; null when that is the caller's own. Its process turns or keeps its display,
   * and the display follows the turn it reports. Like DisplayRotation, which defers a rotation while
   * a transition runs, it waits for the activity changes before it, and then sends the state as it
   * is: a process that came to fill the display meanwhile resolved it as it did (show).
   */
  rotate(caller: number, landscape: boolean): Promise<void> | null {
    this.sensor = landscape;
    const owner = this.layers[0];
    if (!owner || owner === caller || !this.port.alive(owner)) return null;
    return this.enqueue(async () => {
      const owner = this.layers[0];
      if (owner === caller || !this.port.alive(owner)) return;
      await this.port.activity(this.port.entry(owner), { kind: "rotate", landscape: this.sensor });
      await this.following;
    });
  }
  launch(caller: number, pkg: string, process: string, component: string, intent: ParcelData, request: number, callingClass: string | null = null): Promise<void> {
    const source = this.port.entry(caller);
    const target = this.port.connect(pkg, process), activity = { id: this.nextId++, pid: target.pid, caller, previous: 0, request };
    return this.enqueue(async () => {
      const previous = this.port.entry(this.top || caller); activity.previous = previous.pid;
      await this.visibility(previous, "pause", PAUSE_TIMEOUT_MS);
      this.activities.push(activity);
      try {
        await this.port.activity(target, { kind: "launch", id: activity.id, component, intent, caller: callingClass ? { pkg: source.pkg, cls: callingClass } : null });
        await this.show(target.pid);
      } catch (error) {
        this.activities.splice(this.activities.indexOf(activity), 1);
        await this.restore(activity, 0, null);
        throw error;
      }
    });
  }
  finish(pid: number, id: number, code: number, data: ParcelData | null): Promise<void> {
    return this.enqueue(async () => {
      const index = this.activities.findIndex((a) => a.pid === pid && a.id === id);
      if (index < 0) return;
      const [activity] = this.activities.splice(index, 1);
      if (index === this.activities.length) await this.restore(activity, code, data);
      else if (this.port.alive(activity.caller)) await this.result(activity, code, data);
    });
  }
  /** a dead process's activities finish */
  processDied(pid: number): void {
    for (const activity of this.activities.filter((a) => a.pid === pid)) void this.finish(pid, activity.id, 0, null);
  }
  back(caller: number): Promise<void> | null {
    if (!this.top || this.top === caller) return null;
    return this.enqueue(() => this.port.activity(this.port.entry(this.top), { kind: "back" }));
  }
  background(ms: number): Promise<void> {
    const pid = this.top;
    if (!pid) return Promise.resolve();
    return this.enqueue(async () => {
      const entry = this.port.entry(pid);
      await this.visibility(entry, "pause", PAUSE_TIMEOUT_MS);
      for (const shown of this.shownPids) if (this.port.alive(shown)) await this.visibility(this.port.entry(shown), "stop", STOP_TIMEOUT_MS);
      this.shownPids.clear();
      await guestSleep(ms);
      await this.port.activity(entry, { kind: "visibility", phase: "resume" });
      await this.show(pid);
    });
  }
  /** a process the home screen started, in front once the one there has paused */
  bringToFront(pid: number): Promise<void> {
    return this.enqueue(async () => {
      if (this.port.alive(this.top) && this.top !== pid) await this.visibility(this.port.entry(this.top), "pause", PAUSE_TIMEOUT_MS);
      await this.show(pid);
    });
  }
  /**
   * The previous activity gets PAUSE_TIMEOUT / STOP_TIMEOUT to answer, as on AOSP, and the
   * launch goes ahead without it: a process whose main thread is blocked in a binder call —
   * one the new activity exists to answer, as when a service asks the user for a permission —
   * would otherwise hold the launch forever. Its late answer still lands, and a dead process
   * answers nothing.
   */
  private visibility(entry: Entry, phase: "pause" | "stop" | "visible", timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.port.activity(entry, { kind: "visibility", phase })
        .catch((error) => { if (!entry.dead) console.error("[activity process]", error); })
        .finally(() => { clearTimeout(timer); resolve(); });
    });
  }
  private enqueue(run: () => Promise<void>): Promise<void> {
    const pending = this.queue.then(run);
    this.queue = pending.catch((error) => console.error("[activity process]", error));
    return pending;
  }
  private async restore(activity: Activity, code: number, data: ParcelData | null): Promise<void> {
    const target = this.port.alive(activity.previous) ? activity.previous : activity.caller;
    if (this.port.alive(target)) {
      await this.port.activity(this.port.entry(target), { kind: "visibility", phase: "resume" });
      await this.show(target);
    }
    if (this.port.alive(activity.caller)) await this.result(activity, code, data);
  }
  private result(activity: Activity, code: number, data: ParcelData | null): Promise<void> {
    return this.port.activity(this.port.entry(activity.caller), { kind: "result", request: activity.request, code, data });
  }
  private async show(pid: number): Promise<void> {
    this.top = pid;
    const owner = this.layers[0];
    const visible = new Set<number>();
    let current = pid, index = this.activities.length;
    while (this.port.alive(current) && !visible.has(current)) {
      visible.add(current);
      if (!this.port.entry(current).translucent) break;
      do { index--; } while (index >= 0 && this.activities[index].pid !== current);
      if (index < 0) break;
      current = this.activities[index].previous;
    }
    for (const covered of this.shownPids) {
      if (!visible.has(covered) && this.port.alive(covered)) await this.visibility(this.port.entry(covered), "stop", STOP_TIMEOUT_MS);
    }
    for (const shown of visible) {
      if (!this.shownPids.has(shown)) await this.visibility(this.port.entry(shown), "visible", STOP_TIMEOUT_MS);
    }
    this.shownPids = visible;
    const layers = this.layers = [...visible].reverse();
    for (const entry of this.port.entries()) {
      const surface = entry.canvas;
      if (!surface) continue;
      surface.hidden = !visible.has(entry.pid);
      surface.style.zIndex = String(layers.indexOf(entry.pid) + 1);
      surface.style.pointerEvents = entry.pid === pid ? "auto" : "none";
    }
    // DisplayRotation takes the orientation from the top activity that fills the display: a
    // translucent one leaves it to the one beneath, the bottom of the shown layers. The display
    // follows the orientation that process has; one that comes to fill it resolves the sensor's
    // rotation against its own request, as updateOrientation does when the orientation source
    // changes, and the display follows the turn it reports. That is not awaited, so the queue never
    // waits on the page's main loop, which may itself be waiting on a Worker.
    if (!layers.length) return;
    const entry = this.port.entry(layers[0]);
    void this.port.rotate(entry);
    if (layers[0] !== owner) {
      this.port.activity(entry, { kind: "rotate", landscape: this.sensor })
        .catch((error) => { if (!entry.dead) console.error("[activity process]", error); });
    }
  }
}
