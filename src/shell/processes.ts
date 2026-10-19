import type { ProcessLifeCalls } from "./process-life.ts";
// The broker: system_server's part across process realms, kept in the page's realm, which
// outlives them all. It registers each process and its Worker, routes binder transactions, service,
// provider and broadcast requests and process deaths between them, and holds the stores every
// process shares. Each realm reaches it through shell/process-endpoint.ts.
import type { PendingAccess } from "../android/pendingintent.ts";
import { PendingIntents, type PendingOperation } from "./pendingintents.ts";
import { Alarms } from "./alarms.ts";
import { AccountStore, type AccountCalls } from "./accounts.ts";
import { encodeIntent, intentCodec } from "../android/intentipc.ts";
import type { IntentCodec } from "./pendingintents.ts";
import { packages } from "../android/packages.ts";
import { asSystem, SYSTEM_CALLER, INTERFACE_TRANSACTION, exportParcel, type Caller, type ParcelData, type Transaction, type TransactionReply, type BinderHandle } from "../android/binder.ts";
import { NativeParcel, writeString } from "../android/parcel.ts";
import { newIntent, type ComponentRef } from "../android/intent.ts";
import { NOT_CRASHED, REASON_EXIT_SELF, REASON_USER_REQUESTED, copyExitRecord, type ExitRecord, type Death, type KillNote } from "../android/server/appexitinfo.ts";
import type { PackageDataChange } from "./packagedata.ts";
import { logUncaught } from "../jvm/natives/jthrowable.ts";
import { uptimeMillis } from "../guest-clock.ts";
import { ServiceRecords, type ServiceRequest, type ServiceStarts, type ServiceStartCalls } from "./servicerecords.ts";
import { ActivityStack } from "./activitystack.ts";
import type { FileSource } from "./lazyfile.ts";
import { vfs } from "./vfs.ts";
import { device, formatScreen, naturalLandscape } from "./config.ts";
import type { Sender } from "../android/server/broadcastqueue.ts";
import { queryReceivers, exported, componentPermission, componentProcess, resolveProvider, installedPath } from "../android/pm.ts";
import { checkPermission, PermissionStore, type PermissionCalls } from "../android/permissions.ts";
import { attrStr } from "../android/axml.ts";
import { sqliteStore, type createSQLiteSession, type SQLiteRequest, type SQLiteReply } from "../android/sqlite.ts";
import { preferenceStore, type PreferenceCalls } from "../android/sharedprefs.ts";
import { notificationStore, type ForegroundNotificationRequest } from "../android/notification.ts";
import { PROCESS_PID } from "../android/os.ts";
import { settingsStore } from "../android/settings.ts";
import { awaited, rt, type Gen, type JObj } from "../jvm/runtime.ts";
import type { WebCookies } from "./webcookies.ts";
import type { CookieCalls } from "./cookie-access.ts";
import type { LocationCalls } from "./location-access.ts";
import { BrowserLocation, type LocationEvent } from "./geolocation.ts";
import type { FilePathCalls } from "./file-path.ts";
import { FileDescriptors, type DescriptorCalls } from "./file-descriptors.ts";
import type { WorkerControl } from "./worker-control.ts";
import { Clipboard, type ClipboardCalls } from "./clipboard.ts";
import { spawnProcessWorker, startProcessWorker, type SpareWorker } from "./process-worker-client.ts";
import { PrivateFiles } from "./privatefiles.ts";
import { packedArchives } from "./packedarchive.ts";
import { is64BitPackage } from "../jvm/natives/jvmruntime.ts";
import { serveFile } from "./remote-file.ts";
import type { WebStorageCalls } from "../android/webstorage.ts";
import { receiveWebSurfaces } from "./web-surface-port.ts";
import { receiveMedia } from "./media-port.ts";
import { hostUiMethods, type HostUi } from "./host-ui.ts";
import { storageEntries } from "./device-storage.ts";
import { receiveIme } from "./ime-port.ts";
import { receiveFrames, type FrameReceiver, type Mirror } from "./frame-port.ts";
import { bootstrapTransfers, type ProcessBootstrap } from "./process-bootstrap-data.ts";
import type { SettingsCalls, SettingsTable } from "./settings.ts";
import { serveProcess, processProxy, processError, methodsOf } from "./process-port.ts";
import { serveBrokerPort } from "./broker-port.ts";
import { WORKER_SCRIPTS } from "../worker-scripts.ts";

export type { ProcessBootstrap } from "./process-bootstrap-data.ts";

export const permissionDenied = async (permission: string, pkg: string) =>
  await checkPermission(permission, pkg) !== 0;
async function someDenied(permissions: string[], pkg: string): Promise<boolean> {
  for (const permission of permissions) if (await permissionDenied(permission, pkg)) return true;
  return false;
}
/** a process's Java work on the broker's requests, or for the broker on its own behalf, as
 *  system_server does it. The broker runs none itself (a caller's realm rebuilds its errors), so
 *  it answers whichever process's JVM has ended, the page's included. */
export const asBroker = <T>(work: Gen<T>): Promise<T> => asSystem(() => rt.drive(work));
export const unawaited = (work: Promise<unknown>) => void work.catch((error) => console.error("[broker]", error));
export type Receiver = { pkg: string; cls: string; priority: number };
/** the manifest receivers an intent reaches, as the sending process's package manager resolves them */
export function* receivers(intent: JObj): Gen<Receiver[]> {
  return (yield* awaited(queryReceivers(intent))).map((r) => ({ pkg: r.owner.pkg, cls: r.name, priority: r.priority }));
}
export type BroadcastData = { code: number; data: string | null; extras: ParcelData | null; aborted: boolean };
export type ActivityRequest = { kind: "launch"; id: number; component: string; intent: ParcelData; caller: ComponentRef | null }
  | { kind: "visibility"; phase: "pause" | "stop" | "resume" | "visible" }
  | { kind: "result"; request: number; code: number; data: ParcelData | null } | { kind: "back" }
  | { kind: "rotate"; landscape: boolean };
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
  storageChanged: (key: string, value: string | null) => Promise<void>;
  /** a package was removed: this process's package manager forgets it */
  packageRemoved: (pkg: string) => Promise<void>;
  /** the kernel's SIGKILL: the process ends where it stands, with the reason the kill noted */
  kill: (signal: number, note?: KillNote) => void;
};
/** Caller identity is bound to the port, never supplied in a request's arguments. */
type PendingCalls = { [K in keyof PendingAccess as `pending${Capitalize<K>}`]:
  (...args: Parameters<PendingAccess[K]>) => Promise<Awaited<ReturnType<PendingAccess[K]>>> };
export type BrokerCalls = HostUi & ProcessLifeCalls & WebStorageCalls & LocationCalls & ServiceStartCalls & PendingCalls & CookieCalls & ClipboardCalls & SettingsCalls & AccountCalls & PermissionCalls & PreferenceCalls & FilePathCalls & DescriptorCalls & {
  serviceConnected: (key: string, binder: BinderHandle | null, dead: boolean) => Promise<void>;
  alarmSchedule: (id: number, type: number, at: number, interval: number) => Promise<void>;
  alarmCancel: (id: number) => Promise<void>;
  systemService: (name: string) => Promise<BinderHandle | null>;
  systemProvider: (authority: string) => Promise<BinderHandle | null>;
  notificationForeground: (request: ForegroundNotificationRequest) => Promise<void>;
  exitRecords: (pkg: string) => Promise<ExitRecord[]>;
  processExited: (record: ExitRecord) => void;
  storageWrite: (key: string, value: string | null) => void;
  /** a package's own clear, one the caller holds the permission for, or one the user agrees to */
  packageDataChange: (pkg: string, change: PackageDataChange, broadcasts: { data: ParcelData; targets: Receiver[] }[], prompt?: string) => Promise<boolean>;
  activityLaunch: (pkg: string, process: string, component: string, intent: ParcelData, request: number, callingClass: string | null) => Promise<void>;
  activityFinish: (id: number, code: number, data: ParcelData | null) => Promise<void>;
  activityPresentation: (translucent: boolean) => Promise<void>;
  displayOrientation: (landscape: boolean) => Promise<void>;
  sqlite: (request: SQLiteRequest) => Promise<SQLiteReply>;
  transact: (request: Transaction) => Promise<TransactionReply>;
  service: (pkg: string, process: string, request: ServiceRequest) => Promise<BinderHandle | null>;
  contentProvider: (pkg: string, process: string, authority: string) => Promise<BinderHandle | null>;
  broadcast: (data: ParcelData, manifest: Receiver[], permissions: string[], ordered: boolean, initial?: BroadcastData) => Promise<BroadcastData>;
};
/** in a fixed order: census decodes a timeline's call indexes by it */
export const brokerMethods = methodsOf<BrokerCalls>()(["processAlive", "processSignal", "processWatch", "processUnwatch", "webRenderer", "webStorage", "locationAvailable", "locationEnabled", "locationLast", "locationSubscribe", "locationRemove", "serviceCreated", "serviceDestroyed", "serviceStart", "serviceDeliver", "serviceRequested", "serviceStop", "serviceStopSelf", "serviceDone", "serviceForeground", "serviceConnected", "pendingCreate", "pendingCancel", "pendingSend", "pendingOperation", "pendingKind", "pendingFlags", "pendingCreator", "alarmSchedule", "alarmCancel", "systemService", "systemProvider", "notificationForeground", "preferenceRead", "preferenceKeys", "preferenceChange", "preferenceFiles", "fileRename", "fileRemove", "fileCreate", "fileFifo", "fileSetAttributes", "fileDescriptor", "filePrepare", "fileStat", "fileMkdir", "fileAccess", "fileList", "permissionCheck", "permissionGrant", "accountList", "accountRead", "accountExists", "accountCached", "accountChange", "exitRecords", "processExited", "activityLaunch", "activityFinish", "activityPresentation", "displayOrientation", "transact", "service", "contentProvider", "broadcast", "sqlite", "cookieGet", "cookieSet", "cookieAccept", "cookieHas", "cookieRemove", "cookieFlush", "clipboardSet", "clipboardGet", "clipboardHas", "clipboardListen", "settingsGet", "settingsEntries", "settingsPut", "settingsSsaid", "storageWrite", "packageDataChange", ...hostUiMethods]);
export type WorkerTerminal = {expected:boolean;cause:string;record:ExitRecord|null};
type WorkerIdentity = {pid:number;pkg:string;process:string;url:string};
export type WorkerDiagnosticRow = WorkerIdentity & (
  {snapshot:Awaited<ReturnType<WorkerControl["snapshot"]>>;terminal?:never;error?:never} |
  {error:string;terminal?:WorkerTerminal} | {terminal:WorkerTerminal;error?:never});
export type Entry = { worker?: ReturnType<typeof startProcessWorker>; presented?: ReturnType<typeof Promise.withResolvers<void>>; workerDiagnostic?: {url:string;error?:string;terminal?:WorkerTerminal}; canvas?: HTMLCanvasElement; display?: FrameReceiver; ime?: ReturnType<typeof receiveIme>; pkg: string; process: string; uid: number; pid: number;
  translucent: boolean;
  /** a Worker's display orientation: the screen it started on, then each turn it reports; the
   *  page's process has none, as its display is the page's own */
  landscape?: boolean;
  ready: Promise<ProcessEndpoint>; resolve: (endpoint: ProcessEndpoint) => void; reject: (error: unknown) => void; dead: boolean;
  /** the home screen started it, so it starts its launcher activity as the user's app does */
  launcher: { assetKey: string } | null;
  /** what hears how it ended */
  watchers: Set<(death: Death) => void>; pending: Set<(error: unknown) => void>;
  session: ProcessSession };
/** what the broker holds for a live process, which its death releases */
export class ProcessSession {
  /** what its bootstrap exported: its archives, broker port and the page's ends of its surfaces */
  bootstrap: (() => void)[] = [];
  /** the endpoint it serves, once it is ready */
  endpoint: (() => void) | null = null;
  /** the command ports it holds */
  readonly callers = new Set<() => void>();
  sqlite: ReturnType<typeof createSQLiteSession> | null = null;
  /** what tells it of account and settings changes */
  accounts: (() => void) | null = null;
  settings: (() => void) | null = null;
  /** its location subscriptions' tokens, by id */
  readonly locations = new Map<number, number>();
  dispose(): void {
    this.sqlite?.close(); this.settings?.(); this.accounts?.(); this.endpoint?.();
    for (const close of [...this.callers, ...this.bootstrap]) close();
    this.sqlite = this.settings = this.accounts = this.endpoint = null;
    this.bootstrap = []; this.callers.clear(); this.locations.clear();
  }
}
/** p, or late()'s result once `ms` pass first */
function within<T>(p: Promise<T>, ms: number, late: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }).then(late)]).finally(() => clearTimeout(timer));
}
/** one in-flight read per process, shared by concurrent callers */
function shared<T>(reads: Map<number, Promise<T>>, pid: number, start: () => Promise<T>): Promise<T> {
  let read = reads.get(pid);
  if (!read) {
    const pending = read = Promise.resolve().then(start);
    reads.set(pid, pending);
    const clear = () => { if (reads.get(pid) === pending) reads.delete(pid); };
    void pending.then(clear, clear);
  }
  return read;
}
export class ProcessBroker {
  /** the page realm's lifecycle, under ?perfProbe=1 (scripts/lat): a process Worker reports its
   *  counters in its snapshot instead */
  private counterEvents: { sequence: number; kind: "created" | "retired"; at: number; pid: number; pkg: string; process: string; url: string }[] = [];
  private counterEvent(entry: Entry, kind: "created" | "retired"): void {
    if (entry.pid !== PROCESS_PID || typeof window === "undefined" || !window.__wdCounterReceipt) return;
    this.counterEvents.push({ sequence: this.counterEvents.length + 1, kind, at: performance.timeOrigin + performance.now(),
      pid: entry.pid, pkg: entry.pkg, process: entry.process, url: location.href });
  }
  counterReceipts() {
    if (typeof window === "undefined" || !window.__wdCounterReceipt) return null;
    const entry = this.entries.get(PROCESS_PID), rows = [];
    if (entry) {
      let receipt = null, error = null;
      try { receipt = window.__wdCounterReceipt(); } catch (e) { error = String(e); }
      rows.push(Object.freeze({ owner: Object.freeze({ pid: entry.pid, pkg: entry.pkg, process: entry.process, url: location.href }),
        dead: false, processDead: entry.dead, receipt, error }));
    }
    return Object.freeze({ schema: 1, source: import.meta.url, at: performance.timeOrigin + performance.now(), sequence: this.counterEvents.length,
      dropped: 0, events: Object.freeze(this.counterEvents.map(e => Object.freeze({ ...e }))), rows: Object.freeze(rows) });
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
  readonly settings = settingsStore();
  constructor() {
    this.location.enabledChanged = () => this.settings.changed("secure", "location_mode");
    this.notifications.bindDescriptors(this.fileDescriptors);
  }
  readonly permissions = new PermissionStore();
  private cookieStores = new Map<string, Promise<WebCookies>>();
  cookies(pkg: string): Promise<WebCookies> {
    let store = this.cookieStores.get(pkg);
    if (!store) { store = import("./webcookies.ts").then(({ WebCookies }) => new WebCookies(pkg)); this.cookieStores.set(pkg, store); }
    return store;
  }
  readonly databases = sqliteStore;
  readonly preferences = preferenceStore;
  readonly notifications = notificationStore;
  private entries = new Map<number, Entry>();
  private byName = new Map<string, Entry>();
  private nextPid = 1001;
  private booted = false;
  readonly fileDescriptors = new FileDescriptors();
  readonly clipboard = new Clipboard(this.fileDescriptors, {
    uid: pid => this.entry(pid).uid, foregroundUid: () => this.entries.get(this.activities.foreground)?.uid,
    changed: pid => { if (this.alive(pid)) unawaited(this.request(this.entry(pid), endpoint => endpoint.clipboardChanged())); },
  });
  readonly activities: ActivityStack = new ActivityStack({
    entry: (pid) => this.entry(pid), alive: (pid) => this.alive(pid), entries: () => this.entries.values(), connect: (pkg, process) => this.connect(pkg, process),
    activity: (entry, request) => this.request(entry, (endpoint) => endpoint.activity(request)),
    rotate: async (entry) => { if (entry.landscape !== undefined) await (await import("./device.ts")).followDisplay(entry.landscape); },
  }, naturalLandscape);
  private services = new ServiceRecords({
    send: (client, pkg, process, request, start) => {
      const live = this.byName.get(pkg + "/" + process), entry = start ? this.connect(pkg, process) : live && !live.dead ? live : null;
      if (!entry) return null;
      const caller = client === null ? null : this.entries.get(client) ?? null;
      return this.request(entry, (endpoint) => endpoint.service(request)).then((result) => {
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

  /** `pid`: the page's own process; any other runs in a Worker */
  connect(pkg: string, process: string, pid?: number): Entry {
    const key = pkg + "/" + process, previous = this.byName.get(key);
    if (previous && !previous.dead) return previous;
    const owner = packages.get(pkg);
    if (!owner) throw new Error("Package not installed: " + pkg);
    let resolve!: Entry["resolve"], reject!: Entry["reject"];
    const worker = pid === undefined, wide = !worker || is64BitPackage(packedArchives.get(owner.path)?.names() ?? Object.keys(owner.res.zip));
    let spare = worker ? this.spare : undefined;
    if (spare) {
      this.spare = undefined;
      if (spare.url !== new URL(this.workerUrl(spare.pid, wide), location.href).href) { spare.worker.terminate(); spare.release(); spare = undefined; }
    }
    const entry: Entry = { pkg, process, uid: owner.uid, pid: pid ?? spare?.pid ?? this.nextPid++, translucent: false, dead: false, launcher: null, watchers: new Set(), pending: new Set(), session: new ProcessSession(),
      ready: new Promise((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
    void entry.ready.catch(() => {});
    this.entries.set(entry.pid, entry); this.byName.set(key, entry);
    if (worker) {
      entry.presented = Promise.withResolvers();
      entry.landscape = device.width > device.height;
      const canvas = document.createElement("canvas"); entry.canvas = canvas;
      canvas.dataset.pid = String(entry.pid); canvas.dataset.pkg = pkg;
      canvas.hidden = true;
      canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border-radius:16px;z-index:1;touch-action:none";
      (document.getElementById("screen")?.parentElement ?? document.body).appendChild(canvas);
      try {
        spare ??= spawnProcessWorker(this.workerUrl(entry.pid, wide), entry.pid);
        entry.workerDiagnostic = {url:spare.url};
        entry.worker = startProcessWorker(spare, canvas,
          () => this.bootstrap(entry.pid), port => this.readyPort(entry.pid, port),
          message => this.fail(entry.pid, message, NOT_CRASHED), () => entry.ime?.focus());
      } catch (error) { this.fail(entry.pid,String(error),NOT_CRASHED); throw error; }
    }
    this.counterEvent(entry, "created");
    this.services.processStarted(pkg, process);
    return entry;
  }
  private spare: SpareWorker | undefined;
  /** a Worker for the next process, loading its runtime and running the 64-bit zygote while the page boots, as the zygote's unspecialized app processes do */
  prestartWorker(): void { if (!this.spare) { const pid = this.nextPid++; this.spare = spawnProcessWorker(this.workerUrl(pid, true), pid); } }
  /** the URL of a process Worker; `wide` picks the bitness of the zygote it runs (process-worker.ts) */
  private workerUrl(pid: number, wide: boolean): string {
    const params = new URLSearchParams(location.search);
    params.set("pid", String(pid)); params.set("screen", formatScreen(device)); params.set("statusBarDp", String(device.statusBarDp));
    if (!wide) params.set("abi", "32");
    return WORKER_SCRIPTS.process.url + "?" + params;
  }
  /** the home screen opening `pkg` while no process of its runs: a new process, which starts the
   *  launcher activity and is shown, at the top app's priority while it starts */
  launch(pkg: string, assetKey: string): { pid: number; shown: Promise<void> } {
    const entry = this.connect(pkg, pkg);
    // the launch took the spare: the processes the app starts next (Google Play services, providers) start from a new one
    this.prestartWorker();
    entry.launcher = { assetKey };
    const shown = entry.ready.then(() => this.activities.bringToFront(entry.pid));
    return { pid: entry.pid, shown };
  }
  private packageSplits = new Map<string, readonly FileSource[]>();
  setPackageSplits(pkg: string, sources: readonly FileSource[]): void {
    if (!packages.has(pkg)) throw new Error("Package not installed: " + pkg);
    this.packageSplits.set(pkg, [...sources]);
  }
  async bootstrap(pid: number): Promise<ProcessBootstrap> {
    const entry = this.entry(pid), owner = packages.get(entry.pkg)!;
    this.watchSettings(pid);
    this.watchAccounts(pid);
    const registry = [...packages.values()].filter((record) => !(record.system && record.pkg === "android")).map((record) => {
      const packed = packedArchives.get(record.path);
      const source = packed ? { index: packed.index, base: packed.base } : null, file = packed ? null : vfs.source(record.path);
      if (!source && !file) throw new Error("Package bytes unavailable: " + record.pkg);
      const splits = this.packageSplits.get(record.pkg) ?? [];
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
      const broker = serveBrokerPort(this, pid), canvas = entry.canvas!;
      ports.push(broker.close);
      const media = new MessageChannel(), display = new MessageChannel(), input = new MessageChannel(), web = new MessageChannel();
      ports.push(receiveMedia(media.port1));
      const frames = receiveFrames(display.port1, canvas, () => entry.presented?.resolve());
      if (this.mirroring) frames.mirror(this.mirroring);
      ports.push(() => { frames.close(); if (entry.display === frames) entry.display = undefined; });
      const ime = receiveIme(input.port1, canvas);
      ports.push(() => { ime.close(); if (entry.ime === ime) entry.ime = undefined; });
      ports.push(receiveWebSurfaces(web.port1, canvas, () => device));
      const payload: ProcessBootstrap = { pid: entry.pid, pkg: owner.pkg, process: entry.process, uid: entry.uid,
        registry: snapshots, launcher: entry.launcher, broker: broker.port,
        display: display.port2, screen: canvas.transferControlToOffscreen(), ime: input.port2, web: web.port2, media: media.port2, storage: storageEntries(entry),
        rotation: this.activities.rotation };
      const data = structuredClone(payload, { transfer: bootstrapTransfers(payload) });
      entry.ime = ime; entry.display = frames;
      // A replacement bootstrap owns a new set; a failed replacement leaves the old one live.
      for (const close of entry.session.bootstrap) close();
      entry.session.bootstrap = ports;
      return data;
    } catch (error) { for (const close of ports) close(); throw error; }
  }
  /** A process's reverse Binder/service channel. Only these serialized operations are exported. */
  brokerPort(pid: number): MessagePort { return serveBrokerPort(this, pid).port; }
  ready(pid: number, endpoint: ProcessEndpoint): void {
    if (this.entry(pid).session.endpoint) return;
    const { port1, port2 } = new MessageChannel();
    this.publishEndpoint(pid, port2, serveProcess(port1, endpoint));
  }
  /** A Worker transfers its serving port here; the broker owns it until process death. */
  readyPort(pid: number, port: MessagePort): void { this.publishEndpoint(pid, port); }
  private publishEndpoint(pid: number, port: MessagePort, stop = () => {}): void {
    try {
      const entry = this.entry(pid);
      if (entry.session.endpoint) { port.postMessage({ kind: "close" }); port.close(); stop(); return; }
      const proxy = processProxy(port, error => error.javaClass ? rt.mkThrowable(error.javaClass, error.message) : processError(error),
        error => { if (!entry.dead) this.fail(pid, error.message ?? "Process endpoint closed", NOT_CRASHED); });
      entry.session.endpoint = () => { stop(); proxy.close(); };
      entry.resolve(proxy.endpoint);
    } catch (error) { port.postMessage({ kind: "close" }); port.close(); stop(); throw error; }
  }
  /** Root uses its local Java watcher; remote processes keep only this owner-side notifier. */
  watchAccounts(pid: number, local?: () => void): void {
    const entry = this.entry(pid), session = entry.session;
    if (local) { session.accounts?.(); session.accounts = local; return; }
    session.accounts ??= this.accounts.watch(() => {
      if (!entry.dead) unawaited(this.request(entry, endpoint => endpoint.accountsChanged()));
    });
  }
  watchSettings(pid: number): void {
    const entry = this.entry(pid);
    entry.session.settings ??= this.settings.watch((table, name) => {
      if (!entry.dead) unawaited(this.request(entry, endpoint => endpoint.settingsChanged(table, name)));
    });
  }
  /** a process ended, or its Worker failed: ActivityManagerService.appDiedLocked */
  fail(pid: number, message: string, death: Death, record: ExitRecord | null = null): void {
    const entry = this.entries.get(pid);
    if (!entry || entry.dead) return;
    this.counterEvent(entry, "retired");
    console.warn(`[process] ${entry.process} (pid ${pid}): ${message}`);
    const error = rt.mkThrowable("android/os/DeadObjectException", message);
    if (entry.worker || entry.workerDiagnostic) entry.workerDiagnostic = {
      url:entry.worker?.url ?? entry.workerDiagnostic!.url,error:message,
      terminal:{cause:message,record:record && copyExitRecord(record),expected:!!record && !death.crashed &&
        (record.reason === REASON_EXIT_SELF && record.status === 0 || record.reason === REASON_USER_REQUESTED)},
    };
    entry.dead = true; entry.reject(error);
    entry.session.dispose();
    this.fileDescriptors.close(pid);
    for (const reject of entry.pending) reject(error);
    entry.pending.clear();
    this.services.clientDied(pid);
    this.services.processDied(entry.pkg, entry.process, death);
    entry.presented?.resolve();
    for (const watcher of entry.watchers) { try { watcher(death); } catch (error) { console.error("[process death]", error); } }
    this.workerReads.delete(pid); this.workerLiveness.delete(pid);
    entry.watchers.clear(); entry.worker?.close(); entry.worker=undefined; entry.canvas?.remove(); entry.canvas=undefined; this.files.detach(pid); this.location.remove(pid); this.clipboard.forget(pid);
    this.activities.processDied(pid);
  }
  private workerReads = new Map<number, Promise<Awaited<ReturnType<WorkerControl["snapshot"]>>>>();
  workerAotProfiles() {
    return Promise.all([...this.entries.values()].flatMap(entry => {
      const worker = entry.worker, url = worker?.url ?? entry.workerDiagnostic?.url;
      if (!url) return [];
      return [(async () => {
        const identity = {pid:entry.pid,pkg:entry.pkg,process:entry.process,url};
        try {
          if (!worker || entry.dead) throw new Error("Worker has exited");
          const result = await within(worker.control.aotProfile(), 5000, () => { throw new Error("Worker AOT profile timeout"); });
          if (entry.dead || result.dead) throw new Error("Worker has exited");
          if (result.phase !== "ready") throw new Error("Worker is not ready: " + result.phase);
          if (result.identity.pid !== entry.pid || result.identity.pkg !== entry.pkg || result.identity.process !== entry.process)
            throw new Error("Worker AOT profile identity mismatch");
          return {...identity,result};
        } catch (error) {
          return {...identity,error:error instanceof Error ? error.message : String(error)};
        }
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
      const read = shared(this.workerReads, entry.pid, () => worker.control.snapshot());
      return [(async () => {
        try {
          const snapshot = await within(read, 5000, () => { throw new Error("Worker diagnostic timeout"); });
          if (entry.dead) return this.terminalWorker(entry,identity);
          if (snapshot.dead || snapshot.phase !== "ready")
            throw new Error(`Worker is ${snapshot.dead || entry.dead ? "dead" : "not ready: " + snapshot.phase}`);
          return {...identity,snapshot};
        } catch (error) {
          if (entry.dead) return this.terminalWorker(entry,identity);
          return {...identity,error: error instanceof Error ? error.message : String(error)};
        }
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
    try {
      return await within(shared(this.workerLiveness, entry.pid, () => worker.control.alive()), ms, () => false) && !entry.dead && entry.worker === worker;
    } catch { return false; }
  }
  /** A control reply is not evidence that the Java main queue can dispatch a job. */
  async visibleWorkersAlive(ms: number): Promise<boolean | null> {
    const entries = this.activities.shownEntries().filter(entry => entry.worker && !entry.dead);
    return entries.length ? (await Promise.all(entries.map(entry => this.workerAlive(entry, ms)))).every(Boolean) : null;
  }
  async visibleWorkerProcesses(ms: number) {
    const entries = this.activities.shownEntries().filter(entry => entry.worker && !entry.dead);
    const [rows, alive] = await Promise.all([this.workerSnapshots(entries), Promise.all(entries.map(entry => this.workerAlive(entry, ms)))]);
    return rows.map((row, i) => ({...row, alive: alive[i]}));
  }
  async foregroundWorkerSnapshot() {
    const entry = this.entries.get(this.activities.foreground);
    if (!entry?.worker && !entry?.workerDiagnostic) return null;
    return (await this.workerSnapshots([entry]))[0] ?? null;
  }
  /** whether a process Worker is still booting: it serves its endpoint once it is ready */
  starting(): boolean { return [...this.entries.values()].some(e => e.worker && !e.dead && !e.session.endpoint); }
  /** settles once the process has presented a frame, or has died */
  presented(pid: number): Promise<void> { return this.entries.get(pid)?.presented?.promise ?? Promise.resolve(); }
  foregroundWorker(): Entry["worker"] {
    const entry = this.entries.get(this.activities.foreground);
    return entry && !entry.dead ? entry.worker : undefined;
  }
  private mirroring: Mirror = false;
  /** whether process Workers send the page a copy of each frame they show, or crops of its regions */
  mirrorFrames(on: Mirror): void {
    this.mirroring = on;
    for (const entry of this.entries.values()) entry.display?.mirror(on);
  }
  displayCanvases(root: HTMLCanvasElement): HTMLCanvasElement[] {
    const layers = this.activities.shownEntries().flatMap(entry => {
      const canvas = entry.canvas;
      return canvas && !canvas.hidden ? [canvas] : [];
    });
    return [...layers, root];
  }
  alive(pid: number): boolean { const entry = this.entries.get(pid); return !!entry && !entry.dead; }
  /** every process registered, dead ones included */
  processes(): IterableIterator<Entry> { return this.entries.values(); }
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
  async changePackageData(pkg: string, change: PackageDataChange, broadcasts: { data: ParcelData; targets: Receiver[] }[], prompt?: string): Promise<boolean> {
    if (prompt && !confirm(prompt)) return false;
    await (await import("./packagedata.ts")).changePackageData(this, pkg, change, broadcasts);
    return true;
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
      return await this.request(target, async endpoint => {
        const reply = await endpoint.transact({...request,data:delivered!},request.system ? SYSTEM_CALLER : {pid:caller.pid,uid:caller.uid});
        try { return {...reply,data:await this.transferDescriptors(target.pid,caller.pid,reply.data)}; }
        finally { await this.discardDescriptors(target.pid,reply.data,true); }
      });
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
  async discardDescriptors(pid: number, data: ParcelData, staged: boolean): Promise<void> {
    await Promise.all(data.objects.map(([,object]) => object && "descriptor" in object ? this.fileDescriptors.discard(pid,object.descriptor,staged) : undefined));
  }
  async transferDescriptors(from: number, to: number, data: ParcelData, broker = false): Promise<ParcelData> {
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
    const target = this.connect(pkg, process);
    return this.request(target, (endpoint) => endpoint.contentProvider(authority));
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
  /** the live process `pid`; a dead one's callers see DeadObjectException */
  entry(pid: number): Entry {
    const entry = this.entries.get(pid);
    if (!entry || entry.dead) throw rt.mkThrowable("android/os/DeadObjectException", "Process is dead: " + pid);
    return entry;
  }
  /** a request to `entry` once its endpoint is ready, which fails when it dies */
  request<T>(entry: Entry, call: (endpoint: ProcessEndpoint) => Promise<T>): Promise<T> {
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
  if (!window.__wdProcesses) {
    const broker = window.__wdProcesses = new ProcessBroker();
    addEventListener("pagehide", () => { void broker.files.flush().catch((error) => console.error("[private files]", error)); });
  }
  return window.__wdProcesses;
}
