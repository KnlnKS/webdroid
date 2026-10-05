// The broker: system_server's part across process realms, kept in the page's top realm, which
// outlives them all. It registers each process and its frame, routes binder transactions, service,
// provider and broadcast requests and process deaths between them, and holds the stores every
// process shares. Each realm reaches it through shell/process-endpoint.ts.
import { PendingIntents, type PendingOperation } from "./pendingintents";
import { Alarms } from "./alarms";
import { AccountStore } from "./accounts";
import { encodeIntent, intentCodec } from "../android/intentipc";
import type { IntentCodec } from "./pendingintents";
import { packages } from "../android/packages";
import { appHost } from "../android/apphost";
import { asSystem, SYSTEM_CALLER, INTERFACE_TRANSACTION, exportParcel, type Caller, type ParcelData, type Transaction, type TransactionReply, type BinderHandle } from "../android/binder";
import { NativeParcel, writeString } from "../android/parcel";
import { newIntent, type ComponentRef } from "../android/intent";
import { NOT_CRASHED, REASON_EXIT_SELF, recordRemoteExit, exitRecords, deathOf, type ExitRecord, type Death, type KillNote } from "../android/server/appexitinfo";
import type { PackageDataChange } from "./packagedata";
import { logUncaught } from "../jvm/natives/jthrowable";
import { createGuestClockPort, uptimeMillis } from "../guest-clock";
import { ServiceRecords, type ServiceRequest, type ServiceStarts } from "./servicerecords";
import { ActivityStack } from "./activitystack";
import { apkPath, vfs } from "./vfs";
import { device, formatScreen } from "./config";
import type { Sender } from "../android/server/broadcastqueue";
import { queryReceivers, exported, componentPermission, componentProcess, resolveProvider, installedPath } from "../android/pm";
import { checkPermission, PermissionStore } from "../android/permissions";
import { attrStr } from "../android/axml";
import { sqliteStore, createSQLiteSession, type SQLiteRequest, type SQLiteReply } from "../android/sqlite";
import { preferenceStore } from "../android/sharedprefs";
import { notificationStore } from "../android/notification";
import { settingsStore } from "../android/settings";
import { awaited, rt, type Gen, type JObj } from "../jvm/runtime";
import type { WebCookies } from "./webcookies";
import { cookieCalls, type CookieCalls } from "./cookie-access";
import { BrowserLocation } from "./geolocation";
import { PrivateFiles } from "./privatefiles";
import { packedArchives } from "./packedarchive";
import { serveFile } from "./remote-file";
import { receiveFrames, canvasFrameSink } from "./frame-port";
import { bootstrapTransfers, type ProcessBootstrap } from "./process-bootstrap-data";
import type { SettingsCalls, SettingsTable } from "./settings";
import { serveProcess, processProxy, processError, serveCalls } from "./process-port";

export type { ProcessBootstrap } from "./process-bootstrap-data";

const permissionDenied = async (permission: string, pkg: string) =>
  await checkPermission(permission, pkg) !== 0;
async function someDenied(permissions: string[], pkg: string): Promise<boolean> {
  for (const permission of permissions) if (await permissionDenied(permission, pkg)) return true;
  return false;
}
/** a process's Java work on the broker's requests, or for the broker on its own behalf, as
 *  system_server does it. The broker runs none itself (a caller's realm rebuilds its errors), so
 *  it answers whichever process's JVM has ended, the page's included. */
export const asBroker = <T>(work: Gen<T>): Promise<T> => asSystem(() => rt.drive(work));
const unawaited = (work: Promise<unknown>) => void work.catch((error) => console.error("[broker]", error));
export type Receiver = { pkg: string; cls: string; priority: number };
/** the manifest receivers an intent reaches, as the sending process's package manager resolves them */
export function* receivers(intent: JObj): Gen<Receiver[]> {
  return (yield* awaited(queryReceivers(intent))).map((r) => ({ pkg: r.owner.pkg, cls: r.name, priority: r.priority }));
}
export type BroadcastData = { code: number; data: string | null; extras: ParcelData | null; aborted: boolean };
export type ActivityRequest = { kind: "launch"; id: number; component: string; intent: ParcelData; caller: ComponentRef | null }
  | { kind: "visibility"; phase: "pause" | "stop" | "resume" | "visible" }
  | { kind: "result"; request: number; code: number; data: ParcelData | null } | { kind: "back" };
const BIND_NOT_FOREGROUND = 4, BIND_WAIVE_PRIORITY = 0x20;
export type ProcessEndpoint = {
  activity: (request: ActivityRequest) => Promise<void>;
  transact: (request: Transaction, caller: Caller) => Promise<TransactionReply>;
  service: (request: ServiceRequest) => Promise<BinderHandle | null>;
  /** IServiceConnection.connected for a binding this process holds by its key */
  serviceConnected: (key: string, binder: BinderHandle | null, dead: boolean) => Promise<void>;
  contentProvider: (authority: string) => Promise<BinderHandle | null>;
  broadcast: (intent: ParcelData, component: string | null, ordered: boolean, result: BroadcastData, sender: Sender | null) => Promise<BroadcastData>;
  clipboardChanged: () => Promise<void>;
  settingsChanged: (table: SettingsTable, name: string) => Promise<void>;
  /** a package was removed: this process's package manager forgets it */
  packageRemoved: (pkg: string) => Promise<void>;
  /** the kernel's SIGKILL: the process ends where it stands, with the reason the kill noted */
  kill: (signal: number, note?: KillNote) => void;
};
/** Caller identity is bound to the port, never supplied in a request's arguments. */
export type BrokerCalls = CookieCalls & SettingsCalls & {
  exitRecords: (pkg: string) => Promise<ExitRecord[]>;
  processExited: (record: ExitRecord) => void;
  activityLaunch: (pkg: string, process: string, component: string, intent: ParcelData, request: number, callingClass: string | null) => Promise<void>;
  activityFinish: (id: number, code: number, data: ParcelData | null) => Promise<void>;
  activityPresentation: (translucent: boolean) => Promise<void>;
  clipboardSet: (data: ParcelData | null) => Promise<void>;
  clipboardGet: () => Promise<ParcelData | null>;
  clipboardListen: (active: boolean) => Promise<void>;
  sqlite: (request: SQLiteRequest) => Promise<SQLiteReply>;
  transact: (request: Transaction) => Promise<TransactionReply>;
  service: (pkg: string, process: string, request: ServiceRequest) => Promise<BinderHandle | null>;
  contentProvider: (pkg: string, process: string, authority: string) => Promise<BinderHandle | null>;
  broadcast: (data: ParcelData, manifest: Receiver[], permissions: string[], ordered: boolean, initial?: BroadcastData) => Promise<BroadcastData>;
};
export const brokerMethods = ["exitRecords", "processExited", "activityLaunch", "activityFinish", "activityPresentation", "transact", "service", "contentProvider", "broadcast", "sqlite", "cookieGet", "cookieSet", "cookieAccept", "cookieHas", "cookieRemove", "cookieFlush", "clipboardSet", "clipboardGet", "clipboardListen", "settingsGet", "settingsEntries", "settingsPut", "settingsSsaid"] as const;
export type Entry = { canvas?: HTMLCanvasElement; pkg: string; process: string; uid: number; pid: number; frame: HTMLIFrameElement | null;
  translucent: boolean;
  ready: Promise<ProcessEndpoint>; resolve: (endpoint: ProcessEndpoint) => void; reject: (error: unknown) => void; dead: boolean;
  /** requests in flight from foreground processes, which this one runs at their priority */
  foregroundClients: number;
  /** the home screen started it, so it starts its launcher activity as the user's app does */
  launcher: { assetKey: string } | null;
  /** what hears how it ended */
  watchers: Set<(death: Death) => void>; pending: Set<(error: unknown) => void> };
class ProcessBroker {
  readonly files = new PrivateFiles();
  readonly accounts = new AccountStore();
  readonly intents = new PendingIntents(intentCodec, async (operation, fill, alarmCount) => {
    if (packages.get(operation.pkg)?.uid !== operation.uid)
      throw rt.mkThrowable("android/app/PendingIntent$CanceledException", "Creator package is unavailable");
    await this.service(null, operation.pkg, operation.process, { kind: "pending", operation, fill, alarmCount });
  });
  readonly alarms = new Alarms(this.intents, uptimeMillis, logUncaught);
  /** `codec` is the creator's: its JVM compares and merges the intents */
  async createPending(pid: number, pkg: string, kind: PendingOperation["kind"], code: number, flags: number, intent: ParcelData, intents: ParcelData[] | undefined, codec: IntentCodec): Promise<number | null> {
    const caller = this.entry(pid), owner = packages.get(pkg);
    if (!owner || owner.uid !== caller.uid) throw rt.mkThrowable("java/lang/SecurityException", "PendingIntent creator does not match caller");
    return this.intents.create({ pkg, kind, code, flags, intent, intents, uid: caller.uid, process: caller.process }, {
      filterEquals: (a, b) => this.whileAlive(caller, () => codec.filterEquals(a, b)),
      replaceExtras: (target, source) => this.whileAlive(caller, () => codec.replaceExtras(target, source)) });
  }
  /** the operation behind a sender handle a process holds, taken for a start on the creator's behalf */
  takePending(pid: number, id: number): PendingOperation | null {
    this.entry(pid);
    return this.intents.take(id);
  }
  cancelPending(pid: number, id: number): void {
    const operation = this.intents.get(id);
    if (operation && operation.uid !== this.entry(pid).uid) throw rt.mkThrowable("java/lang/SecurityException", "Only the creator may cancel a PendingIntent");
    this.intents.cancel(id);
  }
  readonly location = new BrowserLocation();
  readonly settings = settingsStore();
  constructor() { this.location.enabledChanged = () => this.settings.changed("secure", "location_mode"); }
  readonly permissions = new PermissionStore();
  private cookieStores = new Map<string, Promise<WebCookies>>();
  cookies(pkg: string): Promise<WebCookies> {
    let store = this.cookieStores.get(pkg);
    if (!store) { store = import("./webcookies").then(({ WebCookies }) => new WebCookies(pkg)); this.cookieStores.set(pkg, store); }
    return store;
  }
  readonly databases = sqliteStore;
  readonly preferences = preferenceStore;
  readonly notifications = notificationStore;
  private entries = new Map<number, Entry>();
  private byName = new Map<string, Entry>();
  private nextPid = 1001;
  private clipboard: ParcelData | null = null;
  private clipboardWatchers = new Set<number>();
  private booted = false;
  private bootstrapPorts = new Map<number, (() => void)[]>();
  private endpointPorts = new Map<number, () => void>();
  private sqliteSessions = new Map<number, ReturnType<typeof createSQLiteSession>>();
  private settingsClients = new Map<number, () => void>();
  private callerPorts = new Map<number, Set<() => void>>();
  readonly activities: ActivityStack = new ActivityStack({
    entry: (pid) => this.entry(pid), alive: (pid) => this.alive(pid), entries: () => this.entries.values(), connect: (pkg, process) => this.connect(pkg, process),
    activity: (entry, request) => this.request(entry, (endpoint) => endpoint.activity(request)),
  });
  private services = new ServiceRecords({
    send: (client, pkg, process, request, start) => {
      const live = this.byName.get(pkg + "/" + process), entry = start ? this.connect(pkg, process) : live && !live.dead ? live : null;
      if (!entry) return null;
      const caller = client === null ? null : this.entries.get(client) ?? null;
      return this.inherit(caller, entry, () => this.request(entry, (endpoint) => endpoint.service(request))).then((result) => {
        if (caller?.dead) throw rt.mkThrowable("android/os/DeadObjectException", "Service caller died");
        return result;
      });
    },
    connected: (client, key, binder, dead) => {
      if (this.alive(client)) unawaited(this.request(this.entry(client), (endpoint) => endpoint.serviceConnected(key, binder, dead)));
    },
    persistent: (pkg) => { const owner = packages.get(pkg); return !!owner?.system && owner.flag(owner.application, "persistent", false); },
  });

  /** sent from the page's realm, which is up at boot */
  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    const { data, targets } = await asBroker(function* () {
      const intent = yield* awaited(newIntent("android.intent.action.BOOT_COMPLETED"));
      return { data: yield* awaited(encodeIntent(intent)), targets: yield* receivers(intent) };
    }());
    await this.broadcast(null, data, targets, ["android.permission.RECEIVE_BOOT_COMPLETED"], false);
  }

  private copyClipboard(data: ParcelData): ParcelData {
    return { bytes: data.bytes.slice(), objects: data.objects.map(([at, handle]) => [at, handle && { ...handle }]) };
  }
  setClipboard(pid: number, data: ParcelData | null): void {
    this.entry(pid);
    this.clipboard = data ? this.copyClipboard(data) : null;
    for (const watcher of this.clipboardWatchers) {
      if (this.alive(watcher)) unawaited(this.request(this.entry(watcher), (endpoint) => endpoint.clipboardChanged()));
    }
  }
  getClipboard(pid: number): ParcelData | null {
    const caller = this.entry(pid), foreground = this.entries.get(this.activities.foreground);
    if (caller.uid !== foreground?.uid || !this.clipboard) return null;
    return this.copyClipboard(this.clipboard);
  }
  watchClipboard(pid: number, active: boolean): void {
    this.entry(pid);
    if (active) this.clipboardWatchers.add(pid); else this.clipboardWatchers.delete(pid);
  }
  connect(pkg: string, process: string, pid?: number): Entry {
    const key = pkg + "/" + process, previous = this.byName.get(key);
    if (previous && !previous.dead) return previous;
    const owner = packages.get(pkg);
    if (!owner) throw new Error("Package not installed: " + pkg);
    let resolve!: Entry["resolve"], reject!: Entry["reject"];
    const entry: Entry = { pkg, process, uid: owner.uid, pid: pid ?? this.nextPid++, frame: null, translucent: false, dead: false, foregroundClients: 0, launcher: null, watchers: new Set(), pending: new Set(),
      ready: new Promise((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
    void entry.ready.catch(() => {});
    this.entries.set(entry.pid, entry); this.byName.set(key, entry);
    if (pid === undefined) {
      const frame = document.createElement("iframe"); entry.frame = frame;
      frame.hidden = true;
      frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:16px;z-index:1";
      frame.src = "/process?pid=" + entry.pid + `&screen=${formatScreen(device)}&statusBarDp=${device.statusBarDp}&hz=${device.refreshRate}`;
      const params = new URLSearchParams(location.search);
      for (const key of ["bytecode", "jit", "fuzzCoverage", "testClock", "tier"]) {
        const value = params.get(key); if (value !== null) frame.src += "&" + key + "=" + encodeURIComponent(value);
      }
      frame.addEventListener("error", () => this.fail(entry.pid, "Process frame failed", NOT_CRASHED));
      (document.getElementById("screen")?.parentElement ?? document.body).appendChild(frame);
    }
    this.services.processStarted(pkg, process);
    return entry;
  }
  /** the home screen opening `pkg` while no process of its runs: a new process, which starts the
   *  launcher activity and is shown, at the top app's priority while it starts */
  launch(pkg: string, assetKey: string): { pid: number; shown: Promise<void> } {
    const entry = this.connect(pkg, pkg);
    entry.launcher = { assetKey }; entry.foregroundClients++;
    const shown = entry.ready.then(() => this.activities.bringToFront(entry.pid)).finally(() => { entry.foregroundClients--; });
    return { pid: entry.pid, shown };
  }
  async bootstrap(pid: number, worker = false): Promise<ProcessBootstrap> {
    const entry = this.entry(pid), owner = packages.get(entry.pkg)!;
    this.watchSettings(pid);
    const registry = [...packages.values()].filter((record) => !(record.system && record.pkg === "android")).map((record) => {
      const packed = packedArchives.get(record.path);
      const source = packed ? { index: packed.index, base: packed.base } : null, file = packed ? null : vfs.source(record.path);
      if (!source && !file) throw new Error("Package bytes unavailable: " + record.pkg);
      const splits = record.pkg === appHost?.pkg ? appHost.splits.map((name) => vfs.source(apkPath(name))!) : [];
      return { certificates: record.certificates(), pkg: record.pkg, source, file, splits, uid: record.uid, system: record.system, grants: [...record.grants], signatures: record.compatibilityCertificates };
    });
    const ports: (() => void)[] = [];
    try {
      const publish = (source: NonNullable<ReturnType<typeof vfs.source>>) => {
        const served = serveFile(source); ports.push(served.close); return served.data;
      };
      const certificates = await Promise.all(registry.map(record => record.certificates));
      this.entry(pid);
      const snapshots = registry.map(({ file, ...record }, i) => ({ ...record, certificates: certificates[i],
        source: record.source ?? publish(file!), splits: record.splits.map(publish) }));
      const clock = worker ? createGuestClockPort(pid) : undefined;
      if (clock) ports.push(clock.close);
      const broker = worker ? this.serveBrokerPort(pid) : undefined;
      if (broker) ports.push(broker.close);
      let display: MessagePort | undefined;
      if (worker && entry.canvas) {
        const sink = canvasFrameSink(entry.canvas);
        const {port1,port2} = new MessageChannel();
        ports.push(receiveFrames(port1,sink));display=port2;
      }
      const payload: ProcessBootstrap = { pid: entry.pid, pkg: owner.pkg, process: entry.process, uid: entry.uid,
        registry: snapshots, launcher: entry.launcher, clock: clock?.data, broker: broker?.port, display };
      const data = structuredClone(payload, { transfer: bootstrapTransfers(payload) });
      // A replacement bootstrap owns a new set; a failed replacement leaves the old one live.
      for (const close of this.bootstrapPorts.get(pid) ?? []) close();
      this.bootstrapPorts.set(pid, ports);
      return data;
    } catch (error) { for (const close of ports) close(); throw error; }
  }
  /** A process's reverse Binder/service channel. Only these serialized operations are exported. */
  brokerPort(pid: number): MessagePort { return this.serveBrokerPort(pid).port; }
  private serveBrokerPort(pid: number): { port: MessagePort; close(): void } {
    this.entry(pid);
    const { port1, port2 } = new MessageChannel();
    let owned = this.callerPorts.get(pid);
    if (!owned) this.callerPorts.set(pid, owned = new Set());
    const stop = serveCalls<BrokerCalls>(port1, {
      ...cookieCalls(() => this.cookies(this.entry(pid).pkg), () => { this.entry(pid); }),
      exitRecords: async pkg => {
        const caller = this.entry(pid), owner = packages.get(pkg);
        if (owner?.uid !== caller.uid && await permissionDenied("android.permission.DUMP", caller.pkg))
          throw rt.mkThrowable("java/lang/SecurityException", "Exit records belong to another UID");
        this.entry(pid);
        return exitRecords(pkg);
      },
      processExited: record => {
        const caller = this.entry(pid);
        const canonical = recordRemoteExit({...record,pid:caller.pid,uid:caller.uid,pkg:caller.pkg,process:caller.process});
        this.fail(pid,`Process has died: ${canonical.reason === REASON_EXIT_SELF ? "exit " : "status "}${canonical.status}`,deathOf(canonical));
      },
      // Acknowledgment means queued in ActivityStack; waiting for its lifecycle work here
      // would hold the launching main job while that same process is asked to pause.
      activityLaunch: async (pkg, process, component, intent, request, callingClass) => { this.entry(pid); unawaited(this.activities.launch(pid,pkg,process,component,intent,request,callingClass)); },
      activityFinish: async (id, code, data) => { this.entry(pid); unawaited(this.activities.finish(pid,id,code,data)); },
      activityPresentation: async translucent => { this.entry(pid); this.activities.presentation(pid,translucent); },
      clipboardSet: async data => this.setClipboard(pid, data),
      clipboardGet: async () => this.getClipboard(pid),
      clipboardListen: async active => this.watchClipboard(pid, active),
      settingsGet: async (table, name) => { this.watchSettings(pid); return this.settings.get(table, name); },
      settingsEntries: async table => { this.watchSettings(pid); return this.settings.entries(table); },
      settingsPut: async (table, name, value) => { this.watchSettings(pid); return this.settings.put(table, name, value); },
      settingsSsaid: async () => { this.watchSettings(pid); return this.settings.ssaidKey(); },
      sqlite: request => {
        this.entry(pid);
        let session = this.sqliteSessions.get(pid);
        if (!session) this.sqliteSessions.set(pid, session = createSQLiteSession());
        return session.call(request);
      },
      transact: request => this.transact(pid, request),
      service: (pkg, process, request) => this.service(pid, pkg, process, request),
      contentProvider: (pkg, process, authority) => this.contentProvider(pid, pkg, process, authority),
      broadcast: (data, manifest, permissions, ordered, initial) => this.broadcast(pid, data, manifest, permissions, ordered, initial),
    }, () => { owned.delete(stop); if (!owned.size) this.callerPorts.delete(pid); });
    owned.add(stop);
    return { port: port2, close: stop };
  }
  ready(pid: number, endpoint: ProcessEndpoint): void {
    this.entry(pid);
    if (this.endpointPorts.has(pid)) return;
    const { port1, port2 } = new MessageChannel();
    this.publishEndpoint(pid, port2, serveProcess(port1, endpoint));
  }
  /** A Worker transfers its serving port here; the broker owns it until process death. */
  readyPort(pid: number, port: MessagePort): void { this.publishEndpoint(pid, port); }
  private publishEndpoint(pid: number, port: MessagePort, stop = () => {}): void {
    try {
      const entry = this.entry(pid);
      if (this.endpointPorts.has(pid)) { port.postMessage({ kind: "close" }); port.close(); stop(); return; }
      const proxy = processProxy(port, error => error.javaClass ? rt.mkThrowable(error.javaClass, error.message) : processError(error),
        error => { if (!entry.dead) this.fail(pid, error.message ?? "Process endpoint closed", NOT_CRASHED); });
      this.endpointPorts.set(pid, () => { stop(); proxy.close(); });
      entry.resolve(proxy.endpoint);
    } catch (error) { port.postMessage({ kind: "close" }); port.close(); stop(); throw error; }
  }
  private watchSettings(pid: number): void {
    const entry = this.entry(pid);
    if (this.settingsClients.has(pid)) return;
    this.settingsClients.set(pid, this.settings.watch((table, name) => {
      if (!entry.dead) unawaited(this.request(entry, endpoint => endpoint.settingsChanged(table, name)));
    }));
  }
  /** a process ended, or its frame failed: ActivityManagerService.appDiedLocked */
  fail(pid: number, message: string, death: Death): void {
    const entry = this.entries.get(pid);
    if (!entry || entry.dead) return;
    console.warn(`[process] ${entry.process} (pid ${pid}): ${message}`);
    const error = rt.mkThrowable("android/os/DeadObjectException", message);
    entry.dead = true; entry.reject(error);
    this.sqliteSessions.get(pid)?.close(); this.sqliteSessions.delete(pid);
    this.settingsClients.get(pid)?.(); this.settingsClients.delete(pid);
    this.endpointPorts.get(pid)?.(); this.endpointPorts.delete(pid);
    for (const close of this.callerPorts.get(pid) ?? []) close();
    this.callerPorts.delete(pid);
    for (const close of this.bootstrapPorts.get(pid) ?? []) close();
    this.bootstrapPorts.delete(pid);
    for (const reject of entry.pending) reject(error);
    entry.pending.clear();
    this.services.clientDied(pid);
    this.services.processDied(entry.pkg, entry.process, death);
    for (const watcher of entry.watchers) { try { watcher(death); } catch (error) { console.error("[process death]", error); } }
    entry.watchers.clear(); entry.frame?.remove(); entry.canvas?.remove(); entry.canvas=undefined; this.files.detach(pid); this.location.remove(pid); this.clipboardWatchers.delete(pid);
    this.activities.processDied(pid);
  }
  alive(pid: number): boolean { const entry = this.entries.get(pid); return !!entry && !entry.dead; }
  /** kill(2) from a process: SIGKILL of a process of the caller's uid (Process.killProcess of
   *  its other processes); other signals are ART's to handle in the target and are not modelled */
  signal(callerPid: number, pid: number, signal: number): void {
    const caller = this.entry(callerPid);
    if (signal === 9) unawaited(this.each((e) => e.pid === pid && e.uid === caller.uid, (endpoint, entry) => this.kill(entry, endpoint, signal)));
  }
  /** forceStopPackageLocked: the package's services go without restarting, and every process of its
   *  uid dies */
  async forceStop(pkg: string, note?: KillNote): Promise<void> {
    this.services.forceStop(pkg);
    const uid = packages.get(pkg)?.uid;
    await this.each((e) => e.pkg === pkg || e.uid === uid, (endpoint, entry) => this.kill(entry, endpoint, 9, note));
  }
  /** a removed package leaves every process's package manager, this one's too */
  async packageRemoved(pkg: string): Promise<void> {
    forgetRemoved(pkg);
    await this.each(() => true, (endpoint) => endpoint.packageRemoved(pkg));
  }
  /** `f` on each live process `which` picks, once it is ready */
  private each(which: (entry: Entry) => boolean, f: (endpoint: ProcessEndpoint, entry: Entry) => unknown): Promise<unknown> {
    return Promise.all([...this.entries.values()].filter((e) => !e.dead && which(e)).map((e) => e.ready.then(endpoint => f(endpoint, e), () => {})));
  }
  private kill(entry: Entry, endpoint: ProcessEndpoint, signal: number, note?: KillNote): Promise<void> {
    if (entry.dead) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const died = () => resolve();
      entry.watchers.add(died);
      try { endpoint.kill(signal, note); }
      catch (error) { entry.watchers.delete(died); reject(error); }
    });
  }
  /** system_server's part in a package's data change, run in this realm: it outlives its caller,
   *  which may be the package */
  async changePackageData(pkg: string, change: PackageDataChange, broadcasts: { data: ParcelData; targets: Receiver[] }[]): Promise<void> {
    await (await import("./packagedata")).changePackageData(this, pkg, change, broadcasts);
  }
  /** whether a process shown on screen, or one serving such a process, waits on `pid` (process
   *  start included) or binds a service it runs: as binder calls inherit their caller's priority,
   *  and OomAdjuster gives a service its clients' scheduling group unless they bind it
   *  BIND_NOT_FOREGROUND or BIND_WAIVE_PRIORITY */
  servesForeground(pid: number, seen = new Set<number>()): boolean {
    const entry = this.entries.get(pid);
    if (!entry || entry.dead || seen.has(pid)) return false;
    if (entry.foregroundClients > 0) return true;
    seen.add(pid);
    return this.services.clients(entry.pkg, entry.process).some((b) => !(b.flags & (BIND_NOT_FOREGROUND | BIND_WAIVE_PRIORITY))
      && (this.activities.shown(b.client) && this.alive(b.client) || this.servesForeground(b.client, seen)));
  }
  /** `work` for `caller` on `target`, at the caller's priority */
  private inherit<T>(caller: Entry | null, target: Entry, work: () => Promise<T>): Promise<T> {
    if (!caller || !(this.activities.shown(caller.pid) || caller.foregroundClients > 0)) return work();
    target.foregroundClients++;
    return work().finally(() => { target.foregroundClients--; });
  }
  watch(pid: number, died: (death: Death) => void): () => void {
    const entry = this.entry(pid); entry.watchers.add(died); return () => { entry.watchers.delete(died); };
  }
  async transact(callerPid: number, request: Transaction): Promise<TransactionReply> {
    const caller = this.entry(callerPid);
    if (request.handle.pid === 0) {
      if (!this.intents.known(request.handle.id)) throw rt.mkThrowable("android/os/DeadObjectException", "Unknown system Binder");
      const reply = new NativeParcel(), handled = +(request.code === INTERFACE_TRANSACTION);
      if (handled) writeString(reply, "android.content.IIntentSender");
      return { handled, data: await exportParcel(reply) };
    }
    const target = this.entry(request.handle.pid);
    return this.inherit(caller, target, () => this.request(target, (endpoint) => endpoint.transact(request, request.system ? SYSTEM_CALLER : { pid: caller.pid, uid: caller.uid })));
  }
  async service(pid: number | null, pkg: string, process: string, request: ServiceRequest): Promise<BinderHandle | null> {
    if (pid !== null) this.entry(pid);
    return this.services.request(pid, pkg, process, request);
  }
  /** the start state of the services a process runs, which its ActiveServices changes */
  serviceStarts(pid: number): ServiceStarts { const host = this.entry(pid); return this.services.starts(host.pkg, host.process); }
  /** a service published its binder for another process's binding, or went away */
  serviceConnected(pid: number, key: string, binder: BinderHandle | null, dead: boolean): void {
    const host = this.entry(pid);
    this.services.connected(host.pkg, host.process, key, binder, dead);
  }
  /** getContentProviderImpl for a provider in another process: checkContentProviderPermission,
   *  then the binder its process publishes, starting it. The provider enforces each call's
   *  read or write permission itself. */
  async contentProvider(pid: number, pkg: string, process: string, authority: string): Promise<BinderHandle | null> {
    const caller = this.entry(pid), provider = resolveProvider(authority);
    if (provider?.owner.pkg !== pkg) return null;
    if (caller.uid !== provider.owner.uid) {
      const permission = componentPermission(provider);
      const allowed = async (name: string) => { const p = attrStr(provider.node, name) ?? permission; return !p || !await permissionDenied(p, caller.pkg); };
      if (!exported(provider) || !await allowed("readPermission") && !await allowed("writePermission"))
        throw rt.mkThrowable("java/lang/SecurityException", `Permission Denial: opening provider ${provider.name} from pid=${pid}, uid=${caller.uid}`);
    }
    const target = this.connect(pkg, process);
    return this.inherit(caller, target, () => this.request(target, (endpoint) => endpoint.contentProvider(authority)));
  }
  /** `manifest` is the sender's resolution of the intent's manifest receivers */
  async broadcast(pid: number | null, data: ParcelData, manifest: Receiver[], permissions: string[], ordered: boolean,
    initial: BroadcastData = { code: 0, data: null, extras: null, aborted: false }): Promise<BroadcastData> {
    const caller = pid === null ? null : this.entry(pid), sender = caller && { uid: caller.uid, pkg: caller.pkg };
    const targets: { entry: Entry; component: string | null; priority: number }[] = [...this.entries.values()].filter((e) => !e.dead).map((entry) => ({ entry, component: null, priority: 0 }));
    for (const { pkg, cls, priority } of manifest) {
      const owner = packages.get(pkg), node = owner?.components.receiver.get(cls);
      // the platform package's receivers are system_server's, whose part the shell plays itself
      if (!owner || !node || pkg === "android") continue;
      const receiver = { owner, kind: "receiver" as const, name: cls, node }, permission = componentPermission(receiver);
      if (caller && !exported(receiver) && pkg !== caller.pkg) continue;
      if (caller && permission && await permissionDenied(permission, caller.pkg)) continue;
      targets.push({ entry: this.connect(pkg, componentProcess(receiver)), component: cls, priority });
    }
    targets.sort((a, b) => b.priority - a.priority);
    let result = initial;
    for (const target of targets) {
      if (await someDenied(permissions, target.entry.pkg)) continue;
      const sent = result;
      result = await this.request(target.entry, (endpoint) => endpoint.broadcast(data, target.component, ordered, sent, sender));
      if (ordered && result.aborted) break;
    }
    return result;
  }
  private entry(pid: number): Entry {
    const entry = this.entries.get(pid);
    if (!entry || entry.dead) throw rt.mkThrowable("android/os/DeadObjectException", "Process is dead: " + pid);
    return entry;
  }
  private request<T>(entry: Entry, call: (endpoint: ProcessEndpoint) => Promise<T>): Promise<T> {
    return this.whileAlive(entry, () => entry.ready.then((endpoint) => {
      if (entry.dead) throw rt.mkThrowable("android/os/DeadObjectException", "Process is dead: " + entry.pid);
      return call(endpoint);
    }));
  }
  /** work of `entry`'s, which fails when the process dies */
  private whileAlive<T>(entry: Entry, work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      entry.pending.add(reject);
      void work().then(resolve, reject).finally(() => entry.pending.delete(reject));
    });
  }
}

/** a removed package leaves this process's package manager, with the archive it would register again from */
export function forgetRemoved(pkg: string): void {
  packages.delete(pkg);
  packedArchives.delete(installedPath(pkg));
  vfs.delete(installedPath(pkg));
}
declare global { interface Window { __wdProcesses?: ProcessBroker; } }
export function processBroker(): ProcessBroker {
  const root = window.parent;
  if (!root.__wdProcesses) {
    const broker = root.__wdProcesses = new ProcessBroker();
    root.addEventListener("pagehide", () => { void broker.files.flush().catch((error) => console.error("[private files]", error)); });
  }
  return root.__wdProcesses;
}
