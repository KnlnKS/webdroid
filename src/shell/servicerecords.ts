// ActiveServices' ServiceRecords as the broker keeps them: each process reports the start state of
// the services it creates, and the broker holds every cross-process binding. They outlive the
// hosting process, so when it dies killServicesLocked's rules restart what is still wanted (a
// sticky start, an unfinished or redelivered start, a BIND_AUTO_CREATE binding) with
// scheduleServiceRestartLocked's backoff, and bring the rest down.
import type { ParcelData } from "../android/binder";
import { clearGuestTimeout, setSystemTimeout, uptimeMillis, type GuestTimer } from "../guest-clock";

/** ActivityManagerConstants' restart timing and ServiceRecord's redelivery limits */
const RESTART_MS = 1000, RESET_RUN_MS = 60_000, RESTART_FACTOR = 4, MIN_RESTART_SPACING_MS = 10_000;
const MAX_DELIVERY_COUNT = 3, MAX_DONE_EXECUTING_COUNT = 6, BIND_AUTO_CREATE = 1;

/** ServiceRecord.StartItem: `delivered` is the uptime its onStartCommand was called, null while pending */
export type StartItem = { id: number; intent: ParcelData | null; deliveries: number; done: number; delivered: number | null };
export type ServiceState = { intent: ParcelData; startRequested: boolean; stopIfKilled: boolean; lastStartId: number; starts: StartItem[] };
/** a client's binding; `key` is the broker's, unique across clients */
export type ServiceBinding = { client: number; key: string; intent: ParcelData; flags: number };
export type ServiceRestart = { intent: ParcelData; state: ServiceState | null; binds: ServiceBinding[] };
type Record = { pkg: string; process: string; cls: string; intent: ParcelData; state: ServiceState | null; running: boolean;
  bindings: Map<string, ServiceBinding>; restartDelay: number; restartTime: number; nextRestart: number; timer: GuestTimer | null };

export class ServiceRecords {
  private records = new Map<string, Record>();
  private byKey = new Map<string, Record>();
  constructor(private restart: (pkg: string, process: string, restart: ServiceRestart) => void,
    private disconnect: (binding: ServiceBinding) => void) {}

  private record(pkg: string, process: string, cls: string, intent: ParcelData): Record {
    const name = pkg + "/" + cls;
    let r = this.records.get(name);
    if (!r) this.records.set(name, r = { pkg, process, cls, intent, state: null, running: false, bindings: new Map(), restartDelay: 0, restartTime: 0, nextRestart: 0, timer: null });
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
    r.state = state; r.running = true;
    // bringUpServiceLocked takes it off the restart list
    if (r.timer !== null) { clearGuestTimeout(r.timer); r.timer = null; }
  }
  /** killServicesLocked: each service the process ran restarts or is brought down */
  processDied(pkg: string, process: string): void {
    for (const r of [...this.records.values()]) {
      if (r.pkg !== pkg || r.process !== process || !r.running) continue;
      r.running = false;
      if (!this.schedule(r)) this.bringDown(r);
    }
  }
  /** attachApplicationLocked: a process starting runs its services waiting to restart now */
  processStarted(pkg: string, process: string): void {
    for (const r of [...this.records.values()]) if (r.pkg === pkg && r.process === process && r.timer !== null) this.perform(r);
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
  /** scheduleServiceRestartLocked(r, allowCancel = true) */
  private schedule(r: Record): boolean {
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
    if (r.restartDelay === 0 || now > r.restartTime + reset) r.restartDelay = min;
    else r.restartDelay = Math.max(r.restartDelay * RESTART_FACTOR, min);
    r.nextRestart = now + r.restartDelay;
    // restarts of different services are spaced apart
    for (let moved = true; moved;) {
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
