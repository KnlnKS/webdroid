// ActiveServices' ServiceRecords as the broker keeps them: each process reports the start state of
// the services it creates, and the broker holds every cross-process binding. They outlive the
// hosting process, so when it dies killServicesLocked's rules restart what is still wanted (a
// sticky start, an unfinished or redelivered start, a BIND_AUTO_CREATE binding) with
// scheduleServiceRestartLocked's backoff, and bring the rest down. A process crashing counts
// against its services as AppErrors.handleAppCrashLocked counts it.
import type { ParcelData } from "../android/binder";
import { clearGuestTimeout, setSystemTimeout, uptimeMillis, type GuestTimer } from "../guest-clock";

/** ActivityManagerConstants' restart timing and ServiceRecord's redelivery limits */
const RESTART_MS = 1000, RESET_RUN_MS = 60_000, RESTART_FACTOR = 4, MIN_RESTART_SPACING_MS = 10_000;
const MAX_DELIVERY_COUNT = 3, MAX_DONE_EXECUTING_COUNT = 6;
export const BIND_AUTO_CREATE = 1;
/** MIN_CRASH_INTERVAL, BOUND_SERVICE_CRASH_RESTART_DURATION and BOUND_SERVICE_MAX_CRASH_RETRY */
const MIN_CRASH_INTERVAL_MS = 2 * 60_000, CRASH_RESTART_MS = 30 * 60_000, MAX_CRASH_RETRY = 16;

/** ServiceRecord.StartItem: `delivered` is the uptime its onStartCommand was called, null while pending */
export type StartItem = { id: number; intent: ParcelData | null; deliveries: number; done: number; delivered: number | null };
/** `foreground`: the service called startForeground */
export type ServiceState = { intent: ParcelData; startRequested: boolean; stopIfKilled: boolean; lastStartId: number; starts: StartItem[]; foreground: boolean };
/** a client's binding; `key` is the broker's, unique across clients */
export type ServiceBinding = { client: number; key: string; intent: ParcelData; flags: number };
export type ServiceRestart = { intent: ParcelData; state: ServiceState | null; binds: ServiceBinding[] };
/** how a process ended: whether it crashed, and whether AppErrors found it crashed within
 *  MIN_CRASH_INTERVAL of its last crash */
export type Death = { crashed: boolean; repeated: boolean };
type Record = { pkg: string; process: string; cls: string; intent: ParcelData; state: ServiceState | null; running: boolean;
  bindings: Map<string, ServiceBinding>; restartDelay: number; restartTime: number; nextRestart: number; timer: GuestTimer | null; crashCount: number };

export class ServiceRecords {
  private records = new Map<string, Record>();
  private byKey = new Map<string, Record>();
  /** `attach` hands a starting process a binding that waits on one of its services; `persistent`
   *  is a package's ApplicationInfo.FLAG_PERSISTENT */
  constructor(private restart: (pkg: string, process: string, restart: ServiceRestart) => void,
    private disconnect: (binding: ServiceBinding) => void,
    private attach: (pkg: string, process: string, cls: string, binding: ServiceBinding) => void = () => {},
    private persistent: (pkg: string) => boolean = () => false) {}

  private record(pkg: string, process: string, cls: string, intent: ParcelData): Record {
    const name = pkg + "/" + cls;
    let r = this.records.get(name);
    if (!r) this.records.set(name, r = { pkg, process, cls, intent, state: null, running: false, bindings: new Map(), restartDelay: 0, restartTime: 0, nextRestart: 0, timer: null, crashCount: 0 });
    return r;
  }
  bind(pkg: string, process: string, cls: string, binding: ServiceBinding): void {
    const r = this.record(pkg, process, cls, binding.intent);
    r.bindings.set(binding.key, binding); this.byKey.set(binding.key, r);
  }
  binding(key: string): (ServiceBinding & { pkg: string; process: string }) | null {
    const r = this.byKey.get(key), binding = r?.bindings.get(key);
    return r && binding ? { ...binding, pkg: r.pkg, process: r.process } : null;
  }
  unbind(key: string): void {
    const r = this.byKey.get(key);
    if (!r) return;
    this.byKey.delete(key); r.bindings.delete(key);
    this.settle(r);
  }
  /** a client's bindings, which go with it */
  bindingsOf(client: number): (ServiceBinding & { pkg: string; process: string })[] {
    return [...this.byKey.keys()].map((key) => this.binding(key)!).filter((b) => b.client === client);
  }
  /** stopService of a service waiting to restart: its explicit start is gone */
  stop(pkg: string, cls: string): void {
    const r = this.records.get(pkg + "/" + cls);
    if (!r?.timer || !r.state) return;
    r.state.startRequested = false; r.state.starts = [];
    this.settle(r);
  }
  /** what the hosting process reports: the service's start state, or null once it is destroyed */
  report(pkg: string, process: string, cls: string, state: ServiceState | null): void {
    if (!state) {
      // its connections were told it is gone, which unbound them
      const r = this.records.get(pkg + "/" + cls);
      if (r) { r.state = null; r.running = false; this.settle(r); }
      return;
    }
    const r = this.record(pkg, process, cls, state.intent);
    // realStartServiceLocked's restartTime, which a crash is measured from
    if (!r.running) r.restartTime = uptimeMillis();
    r.state = state; r.running = true;
    // bringUpServiceLocked takes it off the restart list
    if (r.timer !== null) { clearGuestTimeout(r.timer); r.timer = null; }
  }
  /** killServicesLocked: each service the process ran restarts or is brought down. A crash first
   *  counts against them; a process that crashed again within MIN_CRASH_INTERVAL is removed without
   *  restarting its services, unless it is persistent or one is a started foreground service. */
  processDied(pkg: string, process: string, death: Death = { crashed: false, repeated: false }): void {
    const now = uptimeMillis(), persistent = this.persistent(pkg);
    const ran = [...this.records.values()].filter((r) => r.pkg === pkg && r.process === process && r.running);
    let tryAgain = false;
    if (death.crashed) for (const r of ran) {
      r.crashCount = now > r.restartTime + MIN_CRASH_INTERVAL_MS ? 1 : r.crashCount + 1;
      if (r.state?.startRequested && r.state.foreground) tryAgain = true;
    }
    const allowRestart = !death.repeated || persistent || tryAgain;
    for (const r of ran) {
      r.running = false;
      if (allowRestart && r.crashCount >= MAX_CRASH_RETRY && !persistent) {
        console.warn(`[services] Service crashed ${r.crashCount} times, stopping: ${r.pkg}/${r.cls}`);
        this.bringDown(r);
      } else if (!allowRestart || !this.schedule(r, persistent)) this.bringDown(r);
    }
  }
  /** ActiveServices.forceStopPackageLocked: the package's services go down without restarting */
  forceStop(pkg: string): void {
    for (const r of [...this.records.values()]) if (r.pkg === pkg) this.bringDown(r);
  }
  /** attachApplicationLocked: a process starting runs its services waiting to restart now, and
   *  takes the bindings waiting on its services that are not running, which bind when they start */
  processStarted(pkg: string, process: string): void {
    for (const r of [...this.records.values()]) {
      if (r.pkg !== pkg || r.process !== process) continue;
      if (r.timer !== null) this.perform(r);
      else if (!r.running) for (const binding of r.bindings.values()) this.attach(pkg, process, r.cls, binding);
    }
  }

  private autoCreate(r: Record): boolean { return [...r.bindings.values()].some((b) => b.flags & BIND_AUTO_CREATE); }
  /** isServiceNeededLocked */
  private needed(r: Record): boolean { return !!r.state?.startRequested || this.autoCreate(r); }
  /** a record no process runs is kept while a restart or a binding waits on it */
  private settle(r: Record): void {
    if (r.running) return;
    if (r.timer !== null && !this.needed(r)) this.bringDown(r);
    else if (r.timer === null && !r.bindings.size) this.remove(r);
  }
  /** bringDownServiceLocked: its connections hear the service is gone */
  private bringDown(r: Record): void {
    const bindings = [...r.bindings.values()];
    this.remove(r);
    for (const binding of bindings) this.disconnect(binding);
  }
  private remove(r: Record): void {
    if (r.timer !== null) clearGuestTimeout(r.timer);
    for (const key of r.bindings.keys()) this.byKey.delete(key);
    this.records.delete(r.pkg + "/" + r.cls);
  }
  /** scheduleServiceRestartLocked(r, allowCancel = true); a persistent package's services restart at once */
  private schedule(r: Record, persistent: boolean): boolean {
    const now = uptimeMillis(), state = r.state;
    let min = RESTART_MS, reset = RESET_RUN_MS, canceled = false;
    if (state) {
      // delivered but unfinished starts go back ahead of the pending ones
      const redeliver: StartItem[] = [];
      for (const si of state.starts) {
        if (si.delivered === null || !si.intent) continue;
        if (si.deliveries < MAX_DELIVERY_COUNT && si.done < MAX_DONE_EXECUTING_COUNT) {
          redeliver.push({ ...si, delivered: null });
          const ran = (now - si.delivered) * 2;
          min = Math.max(min, ran); reset = Math.max(reset, ran);
        } else canceled = true;
      }
      state.starts = [...redeliver, ...state.starts.filter((si) => si.delivered === null)];
      // canStopIfKilled: the explicit start is gone
      if (state.startRequested && (state.stopIfKilled || canceled) && !state.starts.length) state.startRequested = false;
    }
    if (!this.needed(r)) return false;
    if (persistent) r.restartDelay = 0;
    else if (r.restartDelay === 0 || r.crashCount <= 1 && now > r.restartTime + reset) r.restartDelay = min;
    else if (r.crashCount > 1) r.restartDelay = CRASH_RESTART_MS * (r.crashCount - 1);
    else r.restartDelay = Math.max(r.restartDelay * RESTART_FACTOR, min);
    r.nextRestart = now + r.restartDelay;
    // restarts of different services are spaced apart
    for (let moved = !persistent; moved;) {
      moved = false;
      for (const other of this.records.values()) {
        if (other === r || other.timer === null || Math.abs(r.nextRestart - other.nextRestart) >= MIN_RESTART_SPACING_MS) continue;
        r.nextRestart = other.nextRestart + MIN_RESTART_SPACING_MS; r.restartDelay = r.nextRestart - now; moved = true;
      }
    }
    console.warn(`[services] scheduling restart of crashed service ${r.pkg}/${r.cls} in ${Math.round(r.nextRestart - now)}ms`);
    r.timer = setSystemTimeout(() => this.perform(r), r.nextRestart - now);
    return true;
  }
  /** performServiceRestartLocked */
  private perform(r: Record): void {
    if (r.timer !== null) { clearGuestTimeout(r.timer); r.timer = null; }
    if (!this.needed(r)) { this.bringDown(r); return; }
    r.restartTime = uptimeMillis(); r.running = true;
    this.restart(r.pkg, r.process, { intent: r.intent, state: r.state, binds: [...r.bindings.values()] });
  }
}
