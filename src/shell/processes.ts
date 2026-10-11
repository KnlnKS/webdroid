import type { ProcessLifeCalls } from "./process-life";
import { readCounterReceipt, type CounterReceipt } from "./perf-receipts";
// The broker: system_server's part across process realms, kept in the page's top realm, which
// outlives them all. It registers each process and its frame, routes binder transactions, service,
// provider and broadcast requests and process deaths between them, and holds the stores every
// process shares. Each realm reaches it through shell/process-endpoint.ts.
import type { PendingAccess } from "../android/pendingintent";
import { PendingIntents, type PendingOperation } from "./pendingintents";
import { Alarms } from "./alarms";
import { AccountStore, canonicalAccountCommands, type AccountCalls } from "./accounts";
import { accountAuthority } from "../android/accounts";
import { encodeIntent, intentCodec } from "../android/intentipc";
import type { IntentCodec } from "./pendingintents";
import { packages } from "../android/packages";
import { appHost } from "../android/apphost";
import { ownedSystemService, asSystem, SYSTEM_CALLER, INTERFACE_TRANSACTION, exportParcel, type Caller, type ParcelData, type Transaction, type TransactionReply, type BinderHandle } from "../android/binder";
import { NativeParcel, writeString } from "../android/parcel";
import { newIntent, type ComponentRef } from "../android/intent";
import { NOT_CRASHED, REASON_EXIT_SELF, REASON_USER_REQUESTED, recordRemoteExit, copyExitRecord, exitRecords, deathOf, type ExitRecord, type Death, type KillNote } from "../android/server/appexitinfo";
import type { PackageDataChange } from "./packagedata";
import { logUncaught } from "../jvm/natives/jthrowable";
import { uptimeMillis } from "../guest-clock";
import { ServiceRecords, type ServiceRequest, type ServiceStarts, type ServiceStartCalls } from "./servicerecords";
import { ActivityStack } from "./activitystack";
import type { FileSource } from "./lazyfile";
import { apkPath, vfs } from "./vfs";
import { device, formatScreen } from "./config";
import type { Sender } from "../android/server/broadcastqueue";
import { queryReceivers, exported, componentPermission, componentProcess, resolveProvider, installedPath } from "../android/pm";
import { checkPermission, PermissionStore, canonicalPermissionCommands, holdsPlatformPermission, type PermissionCalls } from "../android/permissions";
import { attrStr } from "../android/axml";
import { sqliteStore, createSQLiteSession, type SQLiteRequest, type SQLiteReply } from "../android/sqlite";
import { preferenceStore, canonicalPreferenceCommands, createAppData, type PreferenceCalls } from "../android/sharedprefs";
import { notificationStore, receiveForegroundNotification, type ForegroundNotificationRequest } from "../android/notification";
import { PROCESS_PID } from "../android/os";
import { settingsStore } from "../android/settings";
import { awaited, rt, type Gen, type JObj } from "../jvm/runtime";
import type { WebCookies } from "./webcookies";
import { cookieCalls, type CookieCalls } from "./cookie-access";
import type { LocationCalls } from "./location-access";
import { BrowserLocation, type LocationEvent } from "./geolocation";
import { canonicalFilePaths, isMutablePath, type FilePathCalls } from "./file-path";
import { FileDescriptors, type DescriptorCalls } from "./file-descriptors";
import type { WorkerControl } from "./worker-control";
import { StoredParcel, StoredParcelError } from "./stored-parcel";
import { spawnProcessWorker, startProcessWorker, type SpareWorker } from "./process-worker-client";
import { PrivateFiles } from "./privatefiles";
import { packedArchives } from "./packedarchive";
import { serveFile } from "./remote-file";
import { canonicalWebStorage, type WebStorageCalls } from "../android/webstorage";
import { receiveWebSurfaces } from "./web-surface-port";
import { receiveIme } from "./ime-port";
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
  processDied: (token: number) => Promise<void>;
  activity: (request: ActivityRequest) => Promise<void>;
  transact: (request: Transaction, caller: Caller) => Promise<TransactionReply>;
  service: (request: ServiceRequest) => Promise<BinderHandle | null>;
  /** IServiceConnection.connected for a binding this process holds by its key */
  serviceConnected: (key: string, binder: BinderHandle | null, dead: boolean) => Promise<void>;
  contentProvider: (authority: string) => Promise<BinderHandle | null>;
  broadcast: (intent: ParcelData, component: string | null, ordered: boolean, result: BroadcastData, sender: Sender | null) => Promise<BroadcastData>;
  clipboardChanged: () => Promise<void>;
  locationChanged: (id: number, token: number, event: LocationEvent) => Promise<void>;
  accountsChanged: () => Promise<void>;
  settingsChanged: (table: SettingsTable, name: string) => Promise<void>;
  /** a package was removed: this process's package manager forgets it */
  packageRemoved: (pkg: string) => Promise<void>;
  /** the kernel's SIGKILL: the process ends where it stands, with the reason the kill noted */
  kill: (signal: number, note?: KillNote) => void;
};
/** Caller identity is bound to the port, never supplied in a request's arguments. */
type PendingCalls = { [K in keyof PendingAccess as `pending${Capitalize<K>}`]:
  (...args: Parameters<PendingAccess[K]>) => Promise<Awaited<ReturnType<PendingAccess[K]>>> };
export type BrokerCalls = ProcessLifeCalls & WebStorageCalls & LocationCalls & ServiceStartCalls & PendingCalls & CookieCalls & SettingsCalls & AccountCalls & PermissionCalls & PreferenceCalls & FilePathCalls & DescriptorCalls & {
  serviceConnected: (key: string, binder: BinderHandle | null, dead: boolean) => Promise<void>;
  alarmSchedule: (id: number, type: number, at: number, interval: number) => Promise<void>;
  alarmCancel: (id: number) => Promise<void>;
  systemService: (name: string) => Promise<BinderHandle | null>;
  notificationForeground: (request: ForegroundNotificationRequest) => Promise<void>;
  exitRecords: (pkg: string) => Promise<ExitRecord[]>;
  processExited: (record: ExitRecord) => void;
  activityLaunch: (pkg: string, process: string, component: string, intent: ParcelData, request: number, callingClass: string | null) => Promise<void>;
  activityFinish: (id: number, code: number, data: ParcelData | null) => Promise<void>;
  activityPresentation: (translucent: boolean) => Promise<void>;
  clipboardSet: (data: ParcelData | null) => Promise<void>;
  clipboardGet: () => Promise<ParcelData | null>;
  clipboardHas: () => Promise<boolean>;
  clipboardListen: (active: boolean) => Promise<void>;
  sqlite: (request: SQLiteRequest) => Promise<SQLiteReply>;
  transact: (request: Transaction) => Promise<TransactionReply>;
  service: (pkg: string, process: string, request: ServiceRequest) => Promise<BinderHandle | null>;
  contentProvider: (pkg: string, process: string, authority: string) => Promise<BinderHandle | null>;
  broadcast: (data: ParcelData, manifest: Receiver[], permissions: string[], ordered: boolean, initial?: BroadcastData) => Promise<BroadcastData>;
};
export const brokerMethods = ["processAlive", "processSignal", "processWatch", "processUnwatch", "webRenderer", "webStorage", "locationAvailable", "locationEnabled", "locationLast", "locationSubscribe", "locationRemove", "serviceCreated", "serviceDestroyed", "serviceStart", "serviceDeliver", "serviceRequested", "serviceStop", "serviceStopSelf", "serviceDone", "serviceForeground", "serviceConnected", "pendingCreate", "pendingCancel", "pendingSend", "pendingOperation", "pendingKind", "pendingFlags", "pendingCreator", "alarmSchedule", "alarmCancel", "systemService", "notificationForeground", "preferenceRead", "preferenceKeys", "preferenceChange", "preferenceFiles", "fileRename", "fileRemove", "fileCreate", "fileSetAttributes", "fileDescriptor", "filePrepare", "fileStat", "fileMkdir", "fileAccess", "fileList", "permissionCheck", "permissionGrant", "accountList", "accountRead", "accountExists", "accountCached", "accountChange", "exitRecords", "processExited", "activityLaunch", "activityFinish", "activityPresentation", "transact", "service", "contentProvider", "broadcast", "sqlite", "cookieGet", "cookieSet", "cookieAccept", "cookieHas", "cookieRemove", "cookieFlush", "clipboardSet", "clipboardGet", "clipboardHas", "clipboardListen", "settingsGet", "settingsEntries", "settingsPut", "settingsSsaid"] as const;
export type WorkerTerminal = {expected:boolean;cause:string;record:ExitRecord|null};
type WorkerIdentity = {pid:number;pkg:string;process:string;url:string};
export type WorkerDiagnosticRow = WorkerIdentity & (
  {snapshot:Awaited<ReturnType<WorkerControl["snapshot"]>>;terminal?:never;error?:never} |
  {error:string;terminal?:WorkerTerminal} | {terminal:WorkerTerminal;error?:never});
const workerMode = () => new URLSearchParams(location.search).get("processMode") === "worker";
export type Entry = { worker?: ReturnType<typeof startProcessWorker>; presented?: ReturnType<typeof Promise.withResolvers<void>>; workerDiagnostic?: {url:string;error?:string;terminal?:WorkerTerminal}; canvas?: HTMLCanvasElement; ime?: ReturnType<typeof receiveIme>; pkg: string; process: string; uid: number; pid: number; frame: HTMLIFrameElement | null;
  translucent: boolean;
  ready: Promise<ProcessEndpoint>; resolve: (endpoint: ProcessEndpoint) => void; reject: (error: unknown) => void; dead: boolean;
  /** requests in flight from foreground processes, which this one runs at their priority */
  foregroundClients: number;
  /** the home screen started it, so it starts its launcher activity as the user's app does */
  launcher: { assetKey: string } | null;
  /** what hears how it ended */
  watchers: Set<(death: Death) => void>; pending: Set<(error: unknown) => void> };
export class ProcessBroker {
  private counterEvents: { sequence: number; kind: "created" | "retired"; at: number; pid: number; pkg: string; process: string; url: string }[] = [];
  private counterSequence = 0;
  private counterDropped = 0;
  private counterTerminals = new Map<number, { receipt: Readonly<CounterReceipt> | null; error: string | null; url: string }>();
  private counterEvent(entry: Entry, kind: "created" | "retired", url?: string): void {
    if (typeof window === "undefined" || !window.__wdCounterReceipt) return;
    const sequence = ++this.counterSequence;
    if (this.counterEvents.length === 128) { this.counterDropped++; return; }
    this.counterEvents.push({ sequence, kind, at: performance.timeOrigin + performance.now(), pid: entry.pid, pkg: entry.pkg, process: entry.process, url: url ?? entry.frame?.src ?? entry.worker?.url ?? location.href });
  }
  counterReceipts() {
    if (typeof window === "undefined" || !window.__wdCounterReceipt) return null;
    const rows = [];
    for (const entry of this.entries.values()) {
      if (rows.length === 128) break;
      const terminal = this.counterTerminals.get(entry.pid), rootRealm = entry.pid === PROCESS_PID, win = entry.frame?.contentWindow ?? (rootRealm ? window : null);
      const url = terminal?.url ?? entry.frame?.src ?? entry.worker?.url ?? entry.workerDiagnostic?.url ?? location.href;
      let receipt = terminal?.receipt ?? null, error = terminal?.error ?? null;
      if ((!entry.dead || rootRealm) && win) try { receipt = readCounterReceipt(win); } catch (e) { error = String(e); }
      if (!win && !entry.dead) error ??= "Process Worker counters require a separate protocol";
      rows.push(Object.freeze({ owner: Object.freeze({ pid: entry.pid, pkg: entry.pkg, process: entry.process, url }),
        dead: entry.dead && !rootRealm, processDead: entry.dead, receipt, error }));
    }
    return Object.freeze({ schema: 1, source: import.meta.url, at: performance.timeOrigin + performance.now(), sequence: this.counterSequence,
      dropped: this.counterDropped + Math.max(0, this.entries.size - rows.length), events: Object.freeze(this.counterEvents.map(e => Object.freeze({ ...e }))), rows: Object.freeze(rows) });
  }
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
    const supplied=[intent,...(intents ?? [])];
    // ActivityManagerService.getIntentSenderWithFeature refuses descriptor-bearing Intents.
    if(supplied.some(data=>data.objects.some(([,object])=>object && ("descriptor" in object || "bytes" in object)))) {
      await Promise.all(supplied.map(data=>this.discardDescriptors(pid,data,true)));
      throw rt.mkThrowable("java/lang/IllegalArgumentException","File descriptors passed in Intent");
    }
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
  private locationTokens = new Map<string, number>();
  readonly settings = settingsStore();
  constructor() {
    this.location.enabledChanged = () => this.settings.changed("secure", "location_mode");
    this.notifications.bindDescriptors(this.fileDescriptors);
  }
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
  private clipboard: StoredParcel | null = null;
  private clipboardQueue:Promise<void>=Promise.resolve();
  private clipboardWatchers = new Set<number>();
  private booted = false;
  private bootstrapPorts = new Map<number, (() => void)[]>();
  private endpointPorts = new Map<number, () => void>();
  private sqliteSessions = new Map<number, ReturnType<typeof createSQLiteSession>>();
  private fileDescriptors = new FileDescriptors();
  private accountClients = new Map<number, () => void>();
  private settingsClients = new Map<number, () => void>();
  private callerPorts = new Map<number, Set<() => void>>();
  readonly activities: ActivityStack = new ActivityStack({
    entry: (pid) => this.entry(pid), alive: (pid) => this.alive(pid), entries: () => this.entries.values(), connect: (pkg, process) => this.connect(pkg, process),
    activity: (entry, request) => this.request(entry, (endpoint) => endpoint.activity(request)),
  });
  private services = new ServiceRecords({
    send: (client, pkg, process, request, start) => {
      const live = this.byName.get(pkg + "/" + process), entry = start ? this.connect(pkg, process, undefined, true) : live && !live.dead ? live : null;
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

  private clipboardWork<T>(run:()=>Promise<T>):Promise<T> {
    const pending=this.clipboardQueue.then(run);
    this.clipboardQueue=pending.then(()=>{},()=>{});return pending;
  }
  setClipboard(pid: number, data: ParcelData | null): Promise<void> {
    const copied=data && structuredClone(data);
    return this.clipboardWork(async()=>{
      this.entry(pid);
      let next:StoredParcel|null=null;
      try {next=copied && await StoredParcel.retain(this.fileDescriptors,pid,copied);}
      catch(error) {
        if(error instanceof StoredParcelError)throw rt.mkThrowable("android/os/BadParcelableException",error.message);
        throw error;
      }
      try {this.entry(pid);} catch (error) {await next?.close();throw error;}
      const previous=this.clipboard;this.clipboard=next;await previous?.close();
      for (const watcher of this.clipboardWatchers) {
        if (this.alive(watcher)) unawaited(this.request(this.entry(watcher), (endpoint) => endpoint.clipboardChanged()));
      }
    });
  }
  hasClipboard(pid:number):boolean {
    const caller = this.entry(pid), foreground = this.entries.get(this.activities.foreground);
    return caller.uid === foreground?.uid && this.clipboard !== null;
  }
  getClipboard(pid: number): Promise<ParcelData | null> {
    return this.clipboardWork(async()=>this.hasClipboard(pid) ? this.clipboard!.replay(pid) : null);
  }
  watchClipboard(pid: number, active: boolean): void {
    this.entry(pid);
    if (active) this.clipboardWatchers.add(pid); else this.clipboardWatchers.delete(pid);
  }
  /** `background`: started for a service, provider or broadcast rather than an activity, it runs in a Worker off the page's thread */
  connect(pkg: string, process: string, pid?: number, background = false): Entry {
    const key = pkg + "/" + process, previous = this.byName.get(key);
    if (previous && !previous.dead) return previous;
    const owner = packages.get(pkg);
    if (!owner) throw new Error("Package not installed: " + pkg);
    let resolve!: Entry["resolve"], reject!: Entry["reject"];
    const worker = pid === undefined && (background || workerMode());
    let spare = worker ? this.spare : undefined;
    if (spare) {
      this.spare = undefined;
      if (spare.url !== new URL(this.workerUrl(spare.pid), location.href).href) { spare.worker.terminate(); spare.release(); spare = undefined; }
    }
    const entry: Entry = { pkg, process, uid: owner.uid, pid: pid ?? spare?.pid ?? this.nextPid++, frame: null, translucent: false, dead: false, foregroundClients: 0, launcher: null, watchers: new Set(), pending: new Set(),
      ready: new Promise((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
    void entry.ready.catch(() => {});
    this.entries.set(entry.pid, entry); this.byName.set(key, entry);
    if (worker) {
      entry.presented = Promise.withResolvers();
      const canvas = document.createElement("canvas"); entry.canvas = canvas;
      canvas.hidden = true;
      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border-radius:16px;z-index:1";
      (document.getElementById("screen")?.parentElement ?? document.body).appendChild(canvas);
      try {
        spare ??= spawnProcessWorker(this.workerUrl(entry.pid), entry.pid);
        entry.workerDiagnostic = {url:spare.url};
        entry.worker = startProcessWorker(spare, canvas, () => device,
          () => this.bootstrap(entry.pid, true), port => this.readyPort(entry.pid, port),
          message => this.fail(entry.pid, message, NOT_CRASHED), () => entry.ime?.focus());
      } catch (error) { this.fail(entry.pid,String(error),NOT_CRASHED); throw error; }
    } else if (pid === undefined) {
      const frame = document.createElement("iframe"); entry.frame = frame;
      frame.hidden = true;
      frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:16px;z-index:1";
      frame.src = "/process?pid=" + entry.pid + `&screen=${formatScreen(device)}&statusBarDp=${device.statusBarDp}&hz=${device.refreshRate}`;
      const params = new URLSearchParams(location.search);
      for (const key of ["bytecode", "jit", "fuzzCoverage", "testClock", "tier", "cold", "processMode", "perfProbe", "compileProbe"]) {
        const value = params.get(key); if (value !== null) frame.src += "&" + key + "=" + encodeURIComponent(value);
      }
      frame.addEventListener("error", () => this.fail(entry.pid, "Process frame failed", NOT_CRASHED));
      (document.getElementById("screen")?.parentElement ?? document.body).appendChild(frame);
    }
    this.counterEvent(entry, "created");
    this.services.processStarted(pkg, process);
    return entry;
  }
  private spare: SpareWorker | undefined;
  /** a Worker for the next process, loading its runtime while the page boots, as the zygote's unspecialized app processes do */
  prestartWorker(): void { if (!this.spare) { const pid = this.nextPid++; this.spare = spawnProcessWorker(this.workerUrl(pid), pid); } }
  private workerUrl(pid: number): string {
    const params = new URLSearchParams(location.search);
    params.set("pid", String(pid)); params.set("screen", formatScreen(device)); params.set("statusBarDp", String(device.statusBarDp));
    return "/process-worker.js?" + params;
  }
  /** the home screen opening `pkg` while no process of its runs: a new process, which starts the
   *  launcher activity and is shown, at the top app's priority while it starts */
  launch(pkg: string, assetKey: string): { pid: number; shown: Promise<void> } {
    const entry = this.connect(pkg, pkg);
    entry.launcher = { assetKey }; entry.foregroundClients++;
    const shown = entry.ready.then(() => this.activities.bringToFront(entry.pid)).finally(() => { entry.foregroundClients--; });
    return { pid: entry.pid, shown };
  }
  private packageSplits = new Map<string, readonly FileSource[]>();
  setPackageSplits(pkg: string, sources: readonly FileSource[]): void {
    if (!packages.has(pkg)) throw new Error("Package not installed: " + pkg);
    this.packageSplits.set(pkg, [...sources]);
  }
  async bootstrap(pid: number, worker = false): Promise<ProcessBootstrap> {
    const entry = this.entry(pid), owner = packages.get(entry.pkg)!;
    this.watchSettings(pid);
    this.watchAccounts(pid);
    const registry = [...packages.values()].filter((record) => !(record.system && record.pkg === "android")).map((record) => {
      const packed = packedArchives.get(record.path);
      const source = packed ? { index: packed.index, base: packed.base } : null, file = packed ? null : vfs.source(record.path);
      if (!source && !file) throw new Error("Package bytes unavailable: " + record.pkg);
      const splits = this.packageSplits.get(record.pkg) ?? (record.pkg === appHost?.pkg ? appHost.splits.map((name) => vfs.source(apkPath(name))!) : []);
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
      const broker = worker ? this.serveBrokerPort(pid) : undefined;
      if (broker) ports.push(broker.close);
      let display: MessagePort | undefined, ime: MessagePort | undefined, web: MessagePort | undefined;
      let imeOwner: ReturnType<typeof receiveIme> | undefined;
      if (worker && entry.canvas) {
        const sink = canvasFrameSink(entry.canvas);
        const {port1,port2} = new MessageChannel();
        ports.push(receiveFrames(port1,bitmap => { sink(bitmap); entry.presented?.resolve(); }));display=port2;
        const input = new MessageChannel();
        const inputOwner = receiveIme(input.port1, entry.canvas); imeOwner = inputOwner;
        ports.push(() => { inputOwner.close(); if (entry.ime === inputOwner) entry.ime = undefined; }); ime=input.port2;
        const frames = new MessageChannel();
        ports.push(receiveWebSurfaces(frames.port1,entry.canvas,()=>device)); web=frames.port2;
      }
      const payload: ProcessBootstrap = { pid: entry.pid, pkg: owner.pkg, process: entry.process, uid: entry.uid,
        registry: snapshots, launcher: entry.launcher, refreshRate: device.refreshRate, broker: broker?.port, display, ime, web };
      const data = structuredClone(payload, { transfer: bootstrapTransfers(payload) });
      if (imeOwner) entry.ime = imeOwner;
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
    const accountCommands = canonicalAccountCommands(this.accounts, () => {
      const caller = this.entry(pid);
      return accountAuthority(caller.pkg, caller.uid);
    });
    const accounts = () => { this.watchAccounts(pid); return accountCommands; };
    const permissions = canonicalPermissionCommands(this.permissions, pkg => {
      const caller = this.entry(pid), target = packages.get(pkg);
      if (caller.uid === 0 || caller.uid === 1000 || target?.uid === caller.uid ||
        holdsPlatformPermission(caller.pkg, "android.permission.GRANT_RUNTIME_PERMISSIONS")) return;
      throw rt.mkThrowable("java/lang/SecurityException", "Permission grants belong to another UID");
    });
    const authorizePreference = (name: string, write: boolean) => {
      const caller = this.entry(pid);
      const notification = name.startsWith("android:notification-policy:");
      const pkg = notification ? name.slice("android:notification-policy:".length) : name.split(":", 1)[0];
      const publicRead = notification || name === `${pkg}:__system_power`;
      if (caller.uid === 0 || caller.uid === 1000 || packages.get(pkg)?.uid === caller.uid || !write && publicRead) return;
      throw rt.mkThrowable("java/lang/SecurityException", "Preferences belong to another UID");
    };
    const webStorage = canonicalWebStorage(this.entry(pid).pkg);
    const preferences = canonicalPreferenceCommands(this.preferences, authorizePreference);
    const authorizePath = (path: string): number => {
      const caller = this.entry(pid);
      const privatePath = /^\/data\/(?:data|user\/0|user_de\/0)\/([^/]+)(?:\/|$)/.exec(path);
      const external = /^\/sdcard\/Android\/data\/([^/]+)(?:\/|$)/.exec(path);
      const owner = privatePath?.[1] ?? external?.[1];
      return owner && packages.get(owner)?.uid !== caller.uid && caller.uid !== 0 && caller.uid !== 1000 ? 13 : 0;
    };
    const paths = canonicalFilePaths(authorizePath,this.entry(pid).uid);
    const descriptors = this.fileDescriptors.session(pid, path => isMutablePath(path) ? authorizePath(path) : 13,this.entry(pid).uid);
    const locationAllowed = async () => {
      const caller = this.entry(pid);
      const granted = await permissions.permissionCheck(caller.pkg,["android.permission.ACCESS_FINE_LOCATION","android.permission.ACCESS_COARSE_LOCATION"]);
      this.entry(pid);
      return granted.some(Boolean);
    };
    const requireLocation = async () => {
      if (!await locationAllowed()) throw rt.mkThrowable("java/lang/SecurityException", "Location permission denied");
    };
    const starts = (cls: string) => {
      const caller = this.entry(pid), owner = packages.get(caller.pkg), node = owner?.components.service.get(cls);
      if (!node || owner!.process(node) !== caller.process)
        throw rt.mkThrowable("java/lang/SecurityException", "Service start state belongs to another process");
      return this.serviceStarts(pid);
    };
    const watches = new Map<number, () => void>();
    const stop = serveCalls<BrokerCalls>(port1, {
      processAlive: async target => { this.entry(pid); return target === 0 || this.alive(target); },
      processSignal: async (target, signal) => this.signal(pid, target, signal),
      processWatch: async (target, token) => {
        this.entry(pid);
        watches.get(token)?.(); watches.delete(token);
        if (target === 0) return;
        const entry = this.entry(target);
        watches.set(token, this.watch(entry.pid, () => {
          watches.delete(token);
          if (this.alive(pid)) unawaited(this.request(this.entry(pid), endpoint => endpoint.processDied(token)));
        }));
      },
      processUnwatch: async token => { this.entry(pid); watches.get(token)?.(); watches.delete(token); },
      locationAvailable: async () => { this.entry(pid); return this.location.available; },
      locationEnabled: async () => { this.entry(pid); return this.location.enabled; },
      locationLast: async () => { await requireLocation(); return this.location.last; },
      locationSubscribe: async (id, token, high, active) => {
        await requireLocation();
        const key = pid + ":" + id;
        this.locationTokens.set(key, token);
        try {
          this.location.subscribe(pid,id,high,active,event => { unawaited((async () => {
            try {
              if (!this.alive(pid) || this.locationTokens.get(key) !== token) return;
              const allowed = await locationAllowed();
              if (!this.alive(pid) || this.locationTokens.get(key) !== token) return;
              if (!allowed) { this.locationTokens.delete(key); this.location.remove(pid,id); return; }
              await this.request(this.entry(pid), endpoint => endpoint.locationChanged(id,token,event));
            } catch (error) { if (this.alive(pid)) throw error; }
          })()); });
        } catch (error) {
          if (this.locationTokens.get(key) === token) { this.locationTokens.delete(key); this.location.remove(pid,id); }
          throw error;
        }
      },
      locationRemove: async (id, token) => {
        this.entry(pid); const key = pid + ":" + id;
        if (this.locationTokens.get(key) === token) { this.locationTokens.delete(key); this.location.remove(pid,id); }
      },
      serviceCreated: async (cls, intent) => starts(cls).created(cls, intent),
      serviceDestroyed: async cls => starts(cls).destroyed(cls),
      serviceStart: async (cls, intent) => starts(cls).start(cls, intent),
      serviceDeliver: async cls => starts(cls).deliver(cls),
      serviceRequested: async cls => starts(cls).requested(cls),
      serviceStop: async cls => starts(cls).stop(cls),
      serviceStopSelf: async (cls, id) => starts(cls).stopSelf(cls, id),
      serviceDone: async (cls, id, result) => starts(cls).done(cls, id, result),
      serviceForeground: async (cls, on) => starts(cls).foreground(cls, on),
      serviceConnected: async (key, binder, dead) => this.serviceConnected(pid, key, binder, dead),
      // Intent.filterEquals and replaceExtras are Android framework operations on serialized
      // Intents; the canonical Java owner keeps extras parcelled instead of borrowing a VM.
      pendingCreate: (pkg, kind, code, flags, intent, intents) => this.createPending(pid, pkg, kind, code, flags, intent, intents, intentCodec),
      pendingCancel: async id => { this.entry(pid); this.cancelPending(pid, id); },
      pendingSend: async (id, fill) => { this.entry(pid); return this.intents.send(id, fill); },
      pendingOperation: async id => this.takePending(pid, id),
      pendingKind: async id => { this.entry(pid); return this.intents.get(id)?.kind ?? null; },
      pendingFlags: async id => { this.entry(pid); return this.intents.get(id)?.flags ?? 0; },
      pendingCreator: async id => {
        this.entry(pid); const operation = this.intents.get(id);
        return operation ? {pkg:operation.pkg,uid:operation.uid} : null;
      },
      alarmSchedule: async (id, type, at, interval) => { this.entry(pid); this.alarms.schedule(id, type, at, interval); },
      alarmCancel: async id => { this.entry(pid); this.alarms.cancel(id); },
      systemService: async name => {
        this.entry(pid);
        if (name !== "notification" && name !== "mount") throw rt.mkThrowable("java/lang/SecurityException", "Unsupported canonical service lookup");
        const handle = await asSystem(() => ownedSystemService(name));
        this.entry(pid);
        return handle;
      },
      notificationForeground: async request => {
        const caller = this.entry(pid);
        if (request.kind === "stop" || !request.data) return receiveForegroundNotification(caller.pkg, {pid:caller.pid,uid:caller.uid}, request);
        let received: ParcelData | undefined;
        try {
          received = await this.transferDescriptors(pid, PROCESS_PID, request.data, true);
          this.entry(pid);
          await receiveForegroundNotification(caller.pkg, {pid:caller.pid,uid:caller.uid}, {...request,data:received});
        } finally {
          if (received) await this.discardDescriptors(PROCESS_PID, received, false);
          await this.discardDescriptors(pid, request.data, true);
        }
      },
      filePrepare: async pkg => {
        const caller = this.entry(pid);
        if (packages.get(pkg)?.uid !== caller.uid) throw rt.mkThrowable("java/lang/SecurityException", "File preparation belongs to another UID");
        await this.files.prepare(pkg); this.entry(pid);
        await createAppData(pkg);
      },
      fileSetAttributes: async (path,change) => paths.fileSetAttributes(path,change),
      fileStat: async path => paths.fileStat(path), fileMkdir: async path => paths.fileMkdir(path),
      fileAccess: async (path, mode) => paths.fileAccess(path, mode), fileList: async path => paths.fileList(path),
      fileRename: async (from,to) => paths.fileRename(from,to), fileRemove: async (path,directory) => paths.fileRemove(path,directory), fileCreate: async path => paths.fileCreate(path),
      fileDescriptor: request => { this.entry(pid); return descriptors.fileDescriptor(request); },
      webRenderer: async origin => { this.entry(pid); return webStorage.webRenderer(origin); },
      webStorage: async (op, origin) => { this.entry(pid); return webStorage.webStorage(op,origin); },
      preferenceRead: async (name, key) => preferences.preferenceRead(name, key),
      preferenceKeys: async name => preferences.preferenceKeys(name),
      preferenceChange: async (name, changes) => preferences.preferenceChange(name, changes),
      preferenceFiles: async pkg => { authorizePreference(pkg + ":", false); return preferences.preferenceFiles(pkg); },
      permissionCheck: async (pkg, names) => { this.entry(pid); return permissions.permissionCheck(pkg, names); },
      permissionGrant: async (pkg, names) => permissions.permissionGrant(pkg, names),
      accountList: async query => accounts().accountList(query),
      accountRead: async key => accounts().accountRead(key),
      accountExists: async key => accounts().accountExists(key),
      accountCached: async (key, type) => accounts().accountCached(key, type),
      accountChange: async change => accounts().accountChange(change),
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
        this.fail(pid,`Process has died: ${canonical.reason === REASON_EXIT_SELF ? "exit " : "status "}${canonical.status}`,deathOf(canonical),canonical);
      },
      // Acknowledgment means queued in ActivityStack; waiting for its lifecycle work here
      // would hold the launching main job while that same process is asked to pause.
      activityLaunch: async (pkg, process, component, intent, request, callingClass) => { this.entry(pid); unawaited(this.activities.launch(pid,pkg,process,component,intent,request,callingClass)); },
      activityFinish: async (id, code, data) => { this.entry(pid); unawaited(this.activities.finish(pid,id,code,data)); },
      activityPresentation: async translucent => { this.entry(pid); this.activities.presentation(pid,translucent); },
      clipboardSet: async data => this.setClipboard(pid, data),
      clipboardGet: async () => this.getClipboard(pid),
      clipboardHas: async () => this.clipboardWork(async()=>this.hasClipboard(pid)),
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
    }, () => { for (const cancel of watches.values()) cancel(); watches.clear(); owned.delete(stop); if (!owned.size) this.callerPorts.delete(pid); }, async (method,value) => {
      if (method === "transact") await this.discardDescriptors(pid,(value as TransactionReply).data,false);
      if (method === "clipboardGet" && value) await this.discardDescriptors(pid,value as ParcelData,false);
    });
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
  /** Root uses its local Java watcher; remote processes keep only this owner-side notifier. */
  watchAccounts(pid: number, local?: () => void): void {
    const entry = this.entry(pid);
    if (local) { this.accountClients.get(pid)?.(); this.accountClients.set(pid, local); return; }
    if (this.accountClients.has(pid)) return;
    this.accountClients.set(pid, this.accounts.watch(() => {
      if (!entry.dead) unawaited(this.request(entry, endpoint => endpoint.accountsChanged()));
    }));
  }
  private watchSettings(pid: number): void {
    const entry = this.entry(pid);
    if (this.settingsClients.has(pid)) return;
    this.settingsClients.set(pid, this.settings.watch((table, name) => {
      if (!entry.dead) unawaited(this.request(entry, endpoint => endpoint.settingsChanged(table, name)));
    }));
  }
  /** a process ended, or its frame failed: ActivityManagerService.appDiedLocked */
  fail(pid: number, message: string, death: Death, record: ExitRecord | null = null): void {
    const entry = this.entries.get(pid);
    if (!entry || entry.dead) return;
    if (typeof window !== "undefined" && window.__wdCounterReceipt) {
      const win = entry.frame?.contentWindow ?? (entry.pid === PROCESS_PID ? window : null), url = entry.frame?.src ?? entry.worker?.url ?? location.href;
      let receipt: Readonly<CounterReceipt> | null = null, error: string | null = null;
      try { if (win) receipt = readCounterReceipt(win); } catch (e) { error = String(e); }
      if (pid !== PROCESS_PID) {
        if (this.counterTerminals.size < 128) this.counterTerminals.set(pid, { receipt, error, url }); else this.counterDropped++;
      }
      this.counterEvent(entry, "retired", url);
    }
    console.warn(`[process] ${entry.process} (pid ${pid}): ${message}`);
    const error = rt.mkThrowable("android/os/DeadObjectException", message);
    if (entry.worker || entry.workerDiagnostic) entry.workerDiagnostic = {
      url:entry.worker?.url ?? entry.workerDiagnostic!.url,error:message,
      terminal:{cause:message,record:record && copyExitRecord(record),expected:!!record && !death.crashed &&
        (record.reason === REASON_EXIT_SELF && record.status === 0 || record.reason === REASON_USER_REQUESTED)},
    };
    entry.dead = true; entry.reject(error);
    this.sqliteSessions.get(pid)?.close(); this.sqliteSessions.delete(pid);
    this.fileDescriptors.close(pid);
    this.settingsClients.get(pid)?.(); this.settingsClients.delete(pid);
    this.accountClients.get(pid)?.(); this.accountClients.delete(pid);
    this.endpointPorts.get(pid)?.(); this.endpointPorts.delete(pid);
    for (const close of this.callerPorts.get(pid) ?? []) close();
    this.callerPorts.delete(pid);
    for (const close of this.bootstrapPorts.get(pid) ?? []) close();
    this.bootstrapPorts.delete(pid);
    for (const reject of entry.pending) reject(error);
    entry.pending.clear();
    this.services.clientDied(pid);
    this.services.processDied(entry.pkg, entry.process, death);
    entry.presented?.resolve();
    for (const watcher of entry.watchers) { try { watcher(death); } catch (error) { console.error("[process death]", error); } }
    for (const key of this.locationTokens.keys()) if (key.startsWith(pid + ":")) this.locationTokens.delete(key);
    this.workerReads.delete(pid); this.workerLiveness.delete(pid);
    entry.watchers.clear(); entry.worker?.close(); entry.worker=undefined; entry.frame?.remove(); entry.canvas?.remove(); entry.canvas=undefined; this.files.detach(pid); this.location.remove(pid); this.clipboardWatchers.delete(pid);
    this.activities.processDied(pid);
  }
  private workerReads = new Map<number, Promise<Awaited<ReturnType<WorkerControl["snapshot"]>>>>();
  workerAotProfiles() {
    return Promise.all([...this.entries.values()].flatMap(entry => {
      const worker = entry.worker, url = worker?.url ?? entry.workerDiagnostic?.url;
      if (!url) return [];
      return [(async () => {
        const identity = {pid:entry.pid,pkg:entry.pkg,process:entry.process,url};
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          if (!worker || entry.dead) throw new Error("Worker has exited");
          const result = await Promise.race([worker.control.aotProfile(),new Promise<never>((_,reject) => {
            timer = setTimeout(() => reject(new Error("Worker AOT profile timeout")),5000);
          })]);
          if (entry.dead || result.dead) throw new Error("Worker has exited");
          if (result.phase !== "ready") throw new Error("Worker is not ready: " + result.phase);
          if (result.identity.pid !== entry.pid || result.identity.pkg !== entry.pkg || result.identity.process !== entry.process)
            throw new Error("Worker AOT profile identity mismatch");
          return {...identity,result};
        } catch (error) {
          return {...identity,error:error instanceof Error ? error.message : String(error)};
        } finally {clearTimeout(timer);}
      })()];
    }));
  }
  workerSnapshots(entries = [...this.entries.values()]): Promise<WorkerDiagnosticRow[]> {
    return Promise.all(entries.flatMap<Promise<WorkerDiagnosticRow>>(entry => {
      const worker = entry.worker;
      const url = worker?.url ?? entry.workerDiagnostic?.url;
      if (!url) return [];
      const identity = {pid:entry.pid,pkg:entry.pkg,process:entry.process,url};
      if (!worker) return [Promise.resolve(this.terminalWorker(entry,identity))];
      let read = this.workerReads.get(entry.pid);
      if (!read) {
        read = Promise.resolve().then(() => worker.control.snapshot());
        this.workerReads.set(entry.pid, read);
        const pending = read;
        const clear = () => { if (this.workerReads.get(entry.pid) === pending) this.workerReads.delete(entry.pid); };
        void read.then(clear, clear);
      }
      return [(async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const snapshot = await Promise.race([read, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Worker diagnostic timeout")), 5000);
          })]);
          if (entry.dead) return this.terminalWorker(entry,identity);
          if (snapshot.dead || snapshot.phase !== "ready")
            throw new Error(`Worker is ${snapshot.dead || entry.dead ? "dead" : "not ready: " + snapshot.phase}`);
          return {...identity,snapshot};
        } catch (error) {
          if (entry.dead) return this.terminalWorker(entry,identity);
          return {...identity,error: error instanceof Error ? error.message : String(error)};
        } finally { clearTimeout(timer); }
      })()];
    }));
  }
  private terminalWorker(entry: Entry, identity: WorkerIdentity): WorkerDiagnosticRow {
    const owned = entry.workerDiagnostic?.terminal;
    const terminal = owned && {...owned,record:owned.record && copyExitRecord(owned.record)};
    return terminal?.expected ? {...identity,terminal} :
      {...identity,terminal,error:entry.workerDiagnostic?.error ?? "Worker owner unavailable"};
  }
  private workerLiveness = new Map<number, Promise<boolean>>();
  private async workerAlive(entry: Entry, ms: number): Promise<boolean> {
    const worker = entry.worker;
    if (!worker || entry.dead) return false;
    let read = this.workerLiveness.get(entry.pid);
    if (!read) {
      read = Promise.resolve().then(() => worker.control.alive());
      this.workerLiveness.set(entry.pid, read);
      const pending = read;
      const clear = () => { if (this.workerLiveness.get(entry.pid) === pending) this.workerLiveness.delete(entry.pid); };
      void read.then(clear, clear);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([read, new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), ms);
      })]) && !entry.dead && entry.worker === worker;
    } catch { return false; }
    finally { clearTimeout(timer); }
  }
  /** A control reply is not evidence that the Java main queue can dispatch a job. */
  async visibleWorkersAlive(ms = 1500): Promise<boolean | null> {
    const entries = this.activities.shownEntries().filter(entry => entry.worker && !entry.dead);
    return entries.length ? (await Promise.all(entries.map(entry => this.workerAlive(entry, ms)))).every(Boolean) : null;
  }
  async visibleWorkerProcesses(ms = 1500) {
    const entries = this.activities.shownEntries().filter(entry => entry.worker && !entry.dead);
    const [rows, alive] = await Promise.all([this.workerSnapshots(entries), Promise.all(entries.map(entry => this.workerAlive(entry, ms)))]);
    return rows.map((row, i) => ({...row, alive: alive[i]}));
  }
  async foregroundWorkerSnapshot() {
    const entry = this.entries.get(this.activities.foreground);
    if (!entry?.worker && !entry?.workerDiagnostic) return null;
    return (await this.workerSnapshots([entry]))[0] ?? null;
  }
  /** settles once the process has presented a frame, or has died */
  presented(pid: number): Promise<void> { return this.entries.get(pid)?.presented?.promise ?? Promise.resolve(); }
  foregroundWorker(): Entry["worker"] {
    const entry = this.entries.get(this.activities.foreground);
    return entry && !entry.dead ? entry.worker : undefined;
  }
  displayCanvases(root: HTMLCanvasElement): HTMLCanvasElement[] {
    const layers = this.activities.shownEntries().flatMap(entry => {
      const canvas = entry.canvas ?? entry.frame?.contentDocument?.querySelector<HTMLCanvasElement>("#screen");
      return canvas && !(entry.canvas ?? entry.frame)?.hidden ? [canvas] : [];
    });
    const apps = layers.filter(canvas => canvas !== root);
    return workerMode() ? [...apps, root] : [root, ...apps];
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
  async forceStop(pkg: string, note: KillNote = {reason:REASON_USER_REQUESTED,description:`force stop ${pkg}`}): Promise<void> {
    this.services.forceStop(pkg);
    const uid = packages.get(pkg)?.uid;
    await this.each((e) => e.pkg === pkg || e.uid === uid, (endpoint, entry) => this.kill(entry, endpoint, 9, note));
  }
  /** a removed package leaves every process's package manager, this one's too */
  async packageRemoved(pkg: string): Promise<void> {
    this.packageSplits.delete(pkg);
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
    let delivered: ParcelData | null = null;
    try {
      if (request.handle.pid === 0) {
        if (!this.intents.known(request.handle.id)) throw rt.mkThrowable("android/os/DeadObjectException", "Unknown system Binder");
        const reply = new NativeParcel(), handled = +(request.code === INTERFACE_TRANSACTION);
        if (handled) writeString(reply, "android.content.IIntentSender");
        return { handled, data: await exportParcel(reply) };
      }
      const target = this.entry(request.handle.pid);
      delivered = await this.transferDescriptors(caller.pid,target.pid,request.data);
      return await this.inherit(caller, target, () => this.request(target, async endpoint => {
        const reply = await endpoint.transact({...request,data:delivered!},request.system ? SYSTEM_CALLER : {pid:caller.pid,uid:caller.uid});
        try { return {...reply,data:await this.transferDescriptors(target.pid,caller.pid,reply.data)}; }
        finally { await this.discardDescriptors(target.pid,reply.data,true); }
      }));
    } catch (error) {
      if (delivered) await this.discardDescriptors(request.handle.pid,delivered,false);
      throw error;
    } finally { await this.discardDescriptors(callerPid,request.data,true); }
  }
  stageDescriptor(pid: number, fd: number): number {
    this.entry(pid);this.fileDescriptors.ensureReceiver(pid);
    return this.fileDescriptors.stageLocal(pid,fd);
  }
  takeDescriptor(pid: number, token: number): number {
    this.entry(pid);return this.fileDescriptors.takeLocal(pid,token);
  }
  unstageDescriptor(pid: number, token: number): Promise<number> { return this.fileDescriptors.discard(pid,token,true); }
  discardDescriptor(pid: number, token: number): Promise<number> { return this.fileDescriptors.discard(pid,token,false); }
  private async discardDescriptors(pid: number, data: ParcelData, staged: boolean): Promise<void> {
    await Promise.all(data.objects.map(([,object]) => object && "descriptor" in object ? this.fileDescriptors.discard(pid,object.descriptor,staged) : undefined));
  }
  private async transferDescriptors(from: number, to: number, data: ParcelData, broker = false): Promise<ParcelData> {
    this.entry(from);if (!broker) this.entry(to);this.fileDescriptors.ensureReceiver(to);
    const transferred: ParcelData = {bytes:data.bytes.slice(),objects:[]};
    try {
      for (const [at,object] of data.objects) {
        if (!object || !("descriptor" in object)) { transferred.objects.push([at,object]);continue; }
        const token = await this.fileDescriptors.receive(from,object.descriptor,to);
        if (token < 0) throw rt.mkThrowable("android/os/BadParcelableException","Invalid Binder descriptor right: " + token);
        transferred.objects.push([at,{descriptor:token}]);
      }
      return transferred;
    } catch (error) { await this.discardDescriptors(to,transferred,false);throw error; }
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
    const target = this.connect(pkg, process, undefined, true);
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
      targets.push({ entry: this.connect(pkg, componentProcess(receiver), undefined, true), component: cls, priority });
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
