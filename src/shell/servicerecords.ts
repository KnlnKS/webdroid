// ActiveServices' ServiceRecords as the broker keeps them: each service's start state, which the
// hosting process's ActiveServices changes as it starts, delivers and finishes, and every
// cross-process binding. They outlive the hosting process, so when it dies killServicesLocked's rules
// restart what is still wanted (a sticky start, an unfinished or redelivered start, a
// BIND_AUTO_CREATE binding) with scheduleServiceRestartLocked's backoff, and bring the rest down. A
// process crashing counts against its services as AppErrors.handleAppCrashLocked counts it.
import type { BinderHandle, ParcelData } from "../android/binder.ts";
import type { PendingOperation } from "./pendingintents.ts";
import type { Death } from "../android/server/appexitinfo.ts";
import { clearGuestTimeout, setSystemTimeout, uptimeMillis, type GuestTimer } from "../guest-clock.ts";

/** ActivityManagerConstants' restart timing and ServiceRecord's redelivery limits */
const RESTART_MS = 1000, RESET_RUN_MS = 60_000, RESTART_FACTOR = 4, MIN_RESTART_SPACING_MS = 10_000;
const MAX_DELIVERY_COUNT = 3, MAX_DONE_EXECUTING_COUNT = 6;
const BIND_AUTO_CREATE = 1;
/** MIN_CRASH_INTERVAL, BOUND_SERVICE_CRASH_RESTART_DURATION and BOUND_SERVICE_MAX_CRASH_RETRY */
const MIN_CRASH_INTERVAL_MS = 2 * 60_000, CRASH_RESTART_MS = 30 * 60_000, MAX_CRASH_RETRY = 16;
/** Service's START_* results */
const START_STICKY_COMPATIBILITY = 0, START_STICKY = 1, START_NOT_STICKY = 2, START_REDELIVER_INTENT = 3, START_TASK_REMOVED_COMPLETE = 1000;

/** ServiceRecord.StartItem: `delivered` is the uptime its onStartCommand was called, null while pending */
export type StartItem = { id: number; intent: ParcelData | null; deliveries: number; done: number; delivered: number | null };
/** a client's binding; `key` is the broker's, unique across clients */
export type ServiceBinding = { client: number; key: string; intent: ParcelData; flags: number };
/** what a process's ActiveServices is asked to do; a binding's key is its client's own */
export type ServiceRequest = { kind: "bind"; cls: string; intent: ParcelData; key: string; flags: number } | { kind: "unbind"; key: string }
  | { kind: "stop"; cls: string; intent: ParcelData } | { kind: "peek"; intent: ParcelData } | { kind: "restart"; intent: ParcelData; binds: ServiceBinding[] }
  | { kind: "start"; intent: ParcelData; foreground: boolean }
  | { kind: "pending"; operation: PendingOperation; fill: ParcelData | null; alarmCount: number };
/** how the records reach processes: `send` a request from `client` (null for the system) to
 *  `process`, starting it when `start` and otherwise only while it runs (null when it does not);
 *  `connected` tells a client's binding of its binder; `persistent` is ApplicationInfo.FLAG_PERSISTENT */
type ServicePort = {
  send(client: number | null, pkg: string, process: string, request: ServiceRequest, start: boolean): Promise<BinderHandle | null> | null;
  connected(client: number, key: string, binder: BinderHandle | null, dead: boolean): void;
  persistent(pkg: string): boolean;
};
type Record = { pkg: string; process: string; cls: string; intent: ParcelData; running: boolean;
  startRequested: boolean; stopIfKilled: boolean; lastStartId: number; starts: StartItem[]; foreground: boolean;
  bindings: Map<string, ServiceBinding>; restartDelay: number; restartTime: number; nextRestart: number; timer: GuestTimer | null; crashCount: number };
const unawaited = (work: Promise<unknown> | null) => void work?.catch((error) => console.error("[services]", error));

export class ServiceRecords {
  private port: ServicePort;
  private records = new Map<string, Record>();
  private byKey = new Map<string, Record>();
  constructor(port: ServicePort) { this.port = port; }

  private record(pkg: string, process: string, cls: string, intent: ParcelData): Record {
    const name = pkg + "/" + cls;
    let r = this.records.get(name);
    if (!r) this.records.set(name, r = { pkg, process, cls, intent, running: false, startRequested: false, stopIfKilled: false, lastStartId: 0, starts: [], foreground: false,
      bindings: new Map(), restartDelay: 0, restartTime: 0, nextRestart: 0, timer: null, crashCount: 0 });
    return r;
  }
  /** a request for a service `process` runs. Only a start, an auto-create bind or a pending
   *  operation brings up the process; a binding without BIND_AUTO_CREATE waits for it
   *  (bindServiceLocked, attachApplicationLocked) */
  async request(client: number | null, pkg: string, process: string, request: ServiceRequest): Promise<BinderHandle | null> {
    if (request.kind === "bind" || request.kind === "unbind") request = { ...request, key: client + "/" + request.key };
    if (request.kind === "unbind") this.unbind(request.key);
    if (request.kind === "stop") this.stop(pkg, request.cls);
    const waits = request.kind === "unbind" || request.kind === "stop" || request.kind === "peek" || request.kind === "bind" && !(request.flags & BIND_AUTO_CREATE);
    // the process is up (attaching the bindings that wait on it) before this binding waits too
    const sent = this.port.send(client, pkg, process, request, !waits);
    if (request.kind === "bind") this.bind(pkg, process, request.cls, { client: client ?? 0, key: request.key, intent: request.intent, flags: request.flags });
    try { return await sent; } catch (error) {
      if (request.kind === "bind") this.unbind(request.key);
      throw error;
    }
  }
  private bind(pkg: string, process: string, cls: string, binding: ServiceBinding): void {
    const r = this.record(pkg, process, cls, binding.intent);
    r.bindings.set(binding.key, binding); this.byKey.set(binding.key, r);
  }
  private unbind(key: string): void {
    const r = this.byKey.get(key);
    if (!r) return;
    this.byKey.delete(key); r.bindings.delete(key);
    this.settle(r);
  }
  /** a service of `process` published its binder for a binding, or went away */
  connected(pkg: string, process: string, key: string, binder: BinderHandle | null, dead: boolean): void {
    const r = this.byKey.get(key), binding = r?.bindings.get(key);
    if (!binding || r!.pkg !== pkg || r!.process !== process) return;
    if (dead) this.unbind(key);
    this.tell(binding, binder, dead);
  }
  private tell(binding: ServiceBinding, binder: BinderHandle | null, dead: boolean): void {
    this.port.connected(binding.client, binding.key.slice(binding.key.indexOf("/") + 1), binder, dead);
  }
  /** a client's bindings go with it */
  clientDied(client: number): void {
    for (const [key, r] of [...this.byKey]) {
      if (r.bindings.get(key)!.client !== client) continue;
      this.unbind(key);
      unawaited(this.port.send(null, r.pkg, r.process, { kind: "unbind", key }, false));
    }
  }
  /** the bindings to services `process` runs */
  clients(pkg: string, process: string): ServiceBinding[] {
    return [...this.records.values()].filter((r) => r.running && r.pkg === pkg && r.process === process).flatMap((r) => [...r.bindings.values()]);
  }
  /** stopService of a service waiting to restart: its explicit start is gone */
  private stop(pkg: string, cls: string): void {
    const r = this.records.get(pkg + "/" + cls);
    if (!r?.timer) return;
    r.startRequested = false; r.starts = [];
    this.settle(r);
  }
  /** the start state of the services `process` runs, as its ActiveServices changes it */
  starts(pkg: string, process: string) {
    // delivered starts precede pending ones
    const at = (cls: string) => this.records.get(pkg + "/" + cls);
    const delivered = (r: Record | undefined, id: number) => r ? r.starts.findIndex((si) => si.id === id && si.delivered !== null) : -1;
    return {
      /** realStartServiceLocked; bringUpServiceLocked takes it off the restart list */
      created: (cls: string, intent: ParcelData): void => {
        const r = this.record(pkg, process, cls, intent);
        // the restartTime a crash is measured from
        if (!r.running) r.restartTime = uptimeMillis();
        r.running = true;
        if (r.timer !== null) { clearGuestTimeout(r.timer); r.timer = null; }
      },
      /** bringDownServiceLocked: its connections were told it is gone, which unbound them */
      destroyed: (cls: string): void => {
        const r = at(cls);
        if (!r) return;
        Object.assign(r, { running: false, startRequested: false, stopIfKilled: false, lastStartId: 0, starts: [], foreground: false });
        this.settle(r);
      },
      /** startServiceLocked: a start queued for delivery, by its id */
      start: (cls: string, intent: ParcelData): number => {
        const r = this.record(pkg, process, cls, intent);
        r.startRequested = true;
        r.starts.push({ id: ++r.lastStartId, intent, deliveries: 0, done: 0, delivered: null });
        return r.lastStartId;
      },
      /** sendServiceArgsLocked: the pending starts, delivered now and until they finish */
      deliver: (cls: string): StartItem[] => {
        const now = uptimeMillis(), pending = at(cls)?.starts.filter((si) => si.delivered === null) ?? [];
        for (const si of pending) { si.deliveries++; si.delivered = now; }
        return pending;
      },
      requested: (cls: string): boolean => !!at(cls)?.startRequested,
      /** stopServiceLocked: whether there was an explicit start to stop */
      stop: (cls: string): boolean => {
        const r = at(cls);
        if (!r?.startRequested) return false;
        r.startRequested = false;
        return true;
      },
      /** stopServiceTokenLocked: stopSelf(startId) drops the starts delivered up to it, and stops
       *  only at the last one */
      stopSelf: (cls: string, id: number): boolean => {
        const r = at(cls);
        if (id >= 0) {
          const i = delivered(r, id);
          if (i >= 0) r!.starts.splice(0, i + 1);
          if (id !== (r?.lastStartId ?? 0)) return false;
        }
        if (r) r.startRequested = false;
        return true;
      },
      /** serviceDoneExecutingLocked: onStartCommand's result decides what a restart after the process
       *  dies delivers; false for a result Service does not define */
      done: (cls: string, id: number, res: number): boolean => {
        const r = at(cls), i = delivered(r, id);
        if (res === START_STICKY_COMPATIBILITY || res === START_STICKY) { if (r) r.stopIfKilled = false; }
        else if (res === START_NOT_STICKY) { if (r?.lastStartId === id) r.stopIfKilled = true; }
        else if (res === START_REDELIVER_INTENT) {
          if (i >= 0) { r!.starts[i].deliveries = 0; r!.starts[i].done++; r!.stopIfKilled = true; }
          return true;
        } else if (res !== START_TASK_REMOVED_COMPLETE) return false;
        if (i >= 0) r!.starts.splice(i, 1);
        return true;
      },
      /** startForeground and stopForeground */
      foreground: (cls: string, on: boolean): void => { const r = at(cls); if (r) r.foreground = on; },
    };
  }
  /** killServicesLocked: each service the process ran restarts or is brought down. A crash first
   *  counts against them; a process that crashed again within MIN_CRASH_INTERVAL is removed without
   *  restarting its services, unless it is persistent or one is a started foreground service. */
  processDied(pkg: string, process: string, death: Death): void {
    const now = uptimeMillis(), persistent = this.port.persistent(pkg);
    const ran = [...this.records.values()].filter((r) => r.pkg === pkg && r.process === process && r.running);
    let tryAgain = false;
    if (death.crashed) for (const r of ran) {
      r.crashCount = now > r.restartTime + MIN_CRASH_INTERVAL_MS ? 1 : r.crashCount + 1;
      if (r.startRequested && r.foreground) tryAgain = true;
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
      else if (!r.running) for (const b of r.bindings.values()) unawaited(this.port.send(null, pkg, process, { kind: "bind", cls: r.cls, intent: b.intent, key: b.key, flags: b.flags }, false));
    }
  }

  private autoCreate(r: Record): boolean { return [...r.bindings.values()].some((b) => b.flags & BIND_AUTO_CREATE); }
  /** isServiceNeededLocked */
  private needed(r: Record): boolean { return r.startRequested || this.autoCreate(r); }
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
    for (const binding of bindings) this.tell(binding, null, true);
  }
  private remove(r: Record): void {
    if (r.timer !== null) clearGuestTimeout(r.timer);
    for (const key of r.bindings.keys()) this.byKey.delete(key);
    this.records.delete(r.pkg + "/" + r.cls);
  }
  /** scheduleServiceRestartLocked(r, allowCancel = true); a persistent package's services restart at once */
  private schedule(r: Record, persistent: boolean): boolean {
    const now = uptimeMillis();
    let min = RESTART_MS, reset = RESET_RUN_MS, canceled = false;
    // delivered but unfinished starts go back ahead of the pending ones
    const redeliver: StartItem[] = [];
    for (const si of r.starts) {
      if (si.delivered === null || !si.intent) continue;
      if (si.deliveries < MAX_DELIVERY_COUNT && si.done < MAX_DONE_EXECUTING_COUNT) {
        redeliver.push({ ...si, delivered: null });
        const ran = (now - si.delivered) * 2;
        min = Math.max(min, ran); reset = Math.max(reset, ran);
      } else canceled = true;
    }
    r.starts = [...redeliver, ...r.starts.filter((si) => si.delivered === null)];
    // canStopIfKilled: the explicit start is gone
    if (r.startRequested && (r.stopIfKilled || canceled) && !r.starts.length) r.startRequested = false;
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
  /** performServiceRestartLocked: the process takes the service's bindings and its starts, or for a
   *  sticky start with none a null intent, as bringUpServiceLocked adds */
  private perform(r: Record): void {
    if (r.timer !== null) { clearGuestTimeout(r.timer); r.timer = null; }
    if (!this.needed(r)) { this.bringDown(r); return; }
    r.restartTime = uptimeMillis(); r.running = true;
    if (r.startRequested && !r.starts.length) r.starts.push({ id: ++r.lastStartId, intent: null, deliveries: 0, done: 0, delivered: null });
    unawaited(this.port.send(null, r.pkg, r.process, { kind: "restart", intent: r.intent, binds: [...r.bindings.values()] }, true));
  }
}
export type ServiceStarts = ReturnType<ServiceRecords["starts"]>;

