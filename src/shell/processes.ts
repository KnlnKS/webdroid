import { PendingIntents, type PendingOperation } from "./pendingintents";
import { Alarms } from "./alarms";
import { AccountStore } from "./accounts";
import { useAccountStore } from "../android/accounts";
import { executePendingIntent, pendingTransport } from "../android/pendingintent";
import { alarmTransport } from "../android/alarm";
import { encodeIntent, decodeIntent, intentCodec } from "../android/intentipc";
import type { IntentCodec } from "./pendingintents";
import { packages } from "../android/packages";
import { appHost } from "../android/apphost";
import { asSystem, binderTransport, receiveTransaction, SYSTEM_CALLER, INTERFACE_TRANSACTION, exportBinder, importBinder, exportParcel, parcelled, unparcelled, type Caller, type ParcelData, type Transaction, type TransactionReply, type BinderHandle } from "../android/binder";
import { NativeParcel, writeString } from "../android/parcel";
import { newIntent, type ComponentRef } from "../android/intent";
import { PROCESS_PID, processTransport } from "../android/os";
import { exitProcess, onProcessExit } from "../process-exit";
import { deathOf, lastExit, noteAppKill, NOT_CRASHED, type Death, type KillNote } from "../android/server/appexitinfo";
import type { PackageDataChange } from "./packagedata";
import { after } from "../jvm/natives/jentry";
import { logUncaught, detached } from "../jvm/natives/jthrowable";
import { guestSleep, uptimeMillis } from "../guest-clock";
import { hostedServices, remoteServiceConnected, serviceTransport } from "../android/server/activeservices";
import { ServiceRecords, type ServiceRequest, type ServiceStarts } from "./servicerecords";
import { apkPath, vfs } from "./vfs";
import type { FileSource } from "./lazyfile";
import { device, formatScreen } from "./config";
import { broadcastTransport, deliverBroadcast as deliverQueued, type BroadcastResult, type Sender } from "../android/server/broadcastqueue";
import { activityTransport, startActivityInProcess, taskVisibility, type ResultDelivery } from "../android/server/atm";
import { publishedProvider, providerProcesses } from "../android/server/am";
import { queryReceivers, exported, componentPermission, componentProcess, resolveProvider, installedPath } from "../android/pm";
import { checkPermission, PermissionStore, usePermissionStore } from "../android/permissions";
import { attrStr } from "../android/axml";
import { sqliteStore, useSQLiteStore } from "../android/sqlite";
import { preferenceStore, usePreferenceStore } from "../android/sharedprefs";
import { notificationStore, useNotificationStore } from "../android/notification";
import { settingsStore, useSettingsStore } from "../android/settings";
import { awaited, rt, driven, type Gen, type JObj } from "../jvm/runtime";
import { useWebCookies } from "../android/cookies";
import { clipboardTransport, clipboardChanged } from "../android/clipboard";
import type { WebCookies } from "./webcookies";
import { BrowserLocation } from "./geolocation";
import { locationTransport } from "../android/locationmanager";
import { PrivateFiles } from "./privatefiles";
import { packedArchives, type PackedArchive } from "./packedarchive";

const permissionDenied = async (permission: string, pkg: string) =>
  await checkPermission(permission, pkg) !== 0;
async function someDenied(permissions: string[], pkg: string): Promise<boolean> {
  for (const permission of permissions) if (await permissionDenied(permission, pkg)) return true;
  return false;
}
/** a process's Java work on the broker's requests, or for the broker on its own behalf, as
 *  system_server does it. The broker runs none itself (a caller's realm rebuilds its errors), so
 *  it answers whichever process's JVM has ended, the page's included. */
const asBroker = <T>(work: Gen<T>): Promise<T> => asSystem(() => rt.drive(work));
const unawaited = (work: Promise<unknown>) => void work.catch((error) => console.error("[broker]", error));
export type Receiver = { pkg: string; cls: string; priority: number };
/** the manifest receivers an intent reaches, as the sending process's package manager resolves them */
function* receivers(intent: JObj): Gen<Receiver[]> {
  return (yield* awaited(queryReceivers(intent))).map((r) => ({ pkg: r.owner.pkg, cls: r.name, priority: r.priority }));
}
const resultData = (result: BroadcastResult): BroadcastData | Promise<BroadcastData> =>
  after(result.extras && parcelled(result.extras), (extras) => ({ ...result, extras }));
const broadcastResult = (data: BroadcastData): BroadcastResult | Promise<BroadcastResult> =>
  after(data.extras && unparcelled("android/os/Bundle", data.extras), (extras) => ({ ...data, extras }));
function setVisible(visible: boolean): void { processPresentation.visible = visible; processPresentation.changed(visible); }
type BroadcastData = { code: number; data: string | null; extras: ParcelData | null; aborted: boolean };
type ActivityRequest = { kind: "launch"; id: number; component: string; intent: ParcelData; caller: ComponentRef | null }
  | { kind: "visibility"; phase: "pause" | "stop" | "resume" | "visible" }
  | { kind: "result"; request: number; code: number; data: ParcelData | null } | { kind: "back" };
export const processPresentation = { visible: true, changed: (_visible: boolean) => {} };
/** AOSP ActivityRecord: how long the previous activity may take to pause, then to stop */
const PAUSE_TIMEOUT_MS = 500, STOP_TIMEOUT_MS = 11_000;
const BIND_NOT_FOREGROUND = 4, BIND_WAIVE_PRIORITY = 0x20;
/** splits: the installed config/feature split apks beside the base, which only the running app has */
type PackageSnapshot = { pkg: string; source: Uint8Array | PackedArchive; splits: FileSource[]; uid: number; system: boolean; grants: string[]; signatures: Uint8Array[] | null };
type ProcessEndpoint = {
  activity: (request: ActivityRequest) => Promise<void>;
  transact: (request: Transaction, caller: Caller) => Promise<TransactionReply>;
  service: (request: ServiceRequest) => Promise<BinderHandle | null>;
  /** IServiceConnection.connected for a binding this process holds by its key */
  serviceConnected: (key: string, binder: BinderHandle | null, dead: boolean) => Promise<void>;
  contentProvider: (authority: string) => Promise<BinderHandle | null>;
  broadcast: (intent: ParcelData, component: string | null, ordered: boolean, result: BroadcastData, sender: Sender | null) => Promise<BroadcastData>;
  clipboardChanged: () => Promise<void>;
  /** a package was removed: this process's package manager forgets it */
  packageRemoved: (pkg: string) => void;
  /** the kernel's SIGKILL: the process ends where it stands, with the reason the kill noted */
  kill: (signal: number, note?: KillNote) => void;
};
type Entry = { pkg: string; process: string; uid: number; pid: number; frame: HTMLIFrameElement | null;
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
  private foregroundPid = 0;
  private shownPids = new Set<number>();
  /** the shown processes as show() last layered their frames, bottom to top */
  private layers: number[] = [];
  private clipboard: ParcelData | null = null;
  private clipboardWatchers = new Set<number>();
  private nextActivity = 1;
  private activities: { id: number; pid: number; caller: number; previous: number; request: number }[] = [];
  private activityQueue: Promise<void> = Promise.resolve();
  private booted = false;
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

  foreground(pid: number): void { this.foregroundPid = pid; this.shownPids = new Set([pid]); this.layers = [pid]; }
  /** the windows of the processes on screen, bottom to top: their frames, or the page for its own process */
  shownWindows(): Window[] {
    return this.layers.flatMap((pid) => {
      const entry = this.entries.get(pid);
      return entry && !entry.dead ? [entry.frame?.contentWindow ?? window.parent] : [];
    });
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
    const caller = this.entry(pid), foreground = this.entries.get(this.foregroundPid);
    if (caller.uid !== foreground?.uid || !this.clipboard) return null;
    return this.copyClipboard(this.clipboard);
  }
  watchClipboard(pid: number, active: boolean): void {
    this.entry(pid);
    if (active) this.clipboardWatchers.add(pid); else this.clipboardWatchers.delete(pid);
  }
  presentation(pid: number, translucent: boolean): void {
    const entry = this.entry(pid);
    if (entry.translucent === translucent) return;
    entry.translucent = translucent;
    if (pid === this.foregroundPid) void this.queueActivity(() => pid === this.foregroundPid ? this.show(pid) : Promise.resolve());
  }
  launchActivity(caller: number, pkg: string, process: string, component: string, intent: ParcelData, request: number, callingClass: string | null = null): Promise<void> {
    const source = this.entry(caller);
    const target = this.connect(pkg, process), activity = { id: this.nextActivity++, pid: target.pid, caller, previous: 0, request };
    return this.queueActivity(async () => {
      const previous = this.entry(this.foregroundPid || caller); activity.previous = previous.pid;
      await this.visibility(previous, "pause", PAUSE_TIMEOUT_MS);
      this.activities.push(activity);
      try {
        await this.request(target, (endpoint) => endpoint.activity({ kind: "launch", id: activity.id, component, intent, caller: callingClass ? { pkg: source.pkg, cls: callingClass } : null }));
        await this.show(target.pid);
      } catch (error) {
        this.activities.splice(this.activities.indexOf(activity), 1);
        await this.restore(activity, 0, null);
        throw error;
      }
    });
  }
  finishActivity(pid: number, id: number, code: number, data: ParcelData | null): Promise<void> {
    return this.queueActivity(async () => {
      const index = this.activities.findIndex((a) => a.pid === pid && a.id === id);
      if (index < 0) return;
      const [activity] = this.activities.splice(index, 1);
      if (index === this.activities.length) await this.restore(activity, code, data);
      else if (this.alive(activity.caller)) await this.result(activity, code, data);
    });
  }
  back(caller: number): boolean {
    if (!this.foregroundPid || this.foregroundPid === caller) return false;
    this.queueActivity(() => this.request(this.entry(this.foregroundPid), (endpoint) => endpoint.activity({ kind: "back" })));
    return true;
  }
  background(ms: number): Promise<void> {
    const pid = this.foregroundPid;
    if (!pid) return Promise.resolve();
    return this.queueActivity(async () => {
      const entry = this.entry(pid);
      await this.visibility(entry, "pause", PAUSE_TIMEOUT_MS);
      for (const shown of this.shownPids) if (this.alive(shown)) await this.visibility(this.entry(shown), "stop", STOP_TIMEOUT_MS);
      this.shownPids.clear();
      await guestSleep(ms);
      await this.request(entry, (endpoint) => endpoint.activity({ kind: "visibility", phase: "resume" }));
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
      this.request(entry, (endpoint) => endpoint.activity({ kind: "visibility", phase }))
        .catch((error) => { if (!entry.dead) console.error("[activity process]", error); })
        .finally(() => { clearTimeout(timer); resolve(); });
    });
  }
  private queueActivity(run: () => Promise<void>): Promise<void> {
    this.activityQueue = this.activityQueue.then(run).catch((error) => console.error("[activity process]", error));
    return this.activityQueue;
  }
  private async restore(activity: { caller: number; previous: number; request: number }, code: number, data: ParcelData | null): Promise<void> {
    const target = this.alive(activity.previous) ? activity.previous : activity.caller;
    if (this.alive(target)) {
      await this.request(this.entry(target), (endpoint) => endpoint.activity({ kind: "visibility", phase: "resume" }));
      await this.show(target);
    }
    if (this.alive(activity.caller)) await this.result(activity, code, data);
  }
  private result(activity: { caller: number; request: number }, code: number, data: ParcelData | null): Promise<void> {
    return this.request(this.entry(activity.caller), (endpoint) => endpoint.activity({ kind: "result", request: activity.request, code, data }));
  }
  private async show(pid: number): Promise<void> {
    this.foregroundPid = pid;
    const visible = new Set<number>();
    let current = pid, index = this.activities.length;
    while (this.alive(current) && !visible.has(current)) {
      visible.add(current);
      if (!this.entry(current).translucent) break;
      do { index--; } while (index >= 0 && this.activities[index].pid !== current);
      if (index < 0) break;
      current = this.activities[index].previous;
    }
    for (const covered of this.shownPids) {
      if (!visible.has(covered) && this.alive(covered)) await this.visibility(this.entry(covered), "stop", STOP_TIMEOUT_MS);
    }
    for (const shown of visible) {
      if (!this.shownPids.has(shown)) await this.visibility(this.entry(shown), "visible", STOP_TIMEOUT_MS);
    }
    this.shownPids = visible;
    const layers = this.layers = [...visible].reverse();
    for (const entry of this.entries.values()) {
      if (!entry.frame) continue;
      entry.frame.hidden = !visible.has(entry.pid);
      entry.frame.style.zIndex = String(layers.indexOf(entry.pid) + 1);
      entry.frame.style.pointerEvents = entry.pid === pid ? "auto" : "none";
    }
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
      for (const key of ["bytecode", "jit", "fuzzCoverage", "testClock"]) {
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
    const shown = entry.ready.then(() => new Promise<void>((resolve, reject) => {
      void this.queueActivity(async () => {
        if (this.alive(this.foregroundPid) && this.foregroundPid !== entry.pid) await this.visibility(this.entry(this.foregroundPid), "pause", PAUSE_TIMEOUT_MS);
        await this.show(entry.pid).then(resolve, reject);
      });
    })).finally(() => { entry.foregroundClients--; });
    return { pid: entry.pid, shown };
  }
  async bootstrap(pid: number): Promise<{ pkg: string; process: string; uid: number; registry: PackageSnapshot[]; launcher: Entry["launcher"] }> {
    const entry = this.entry(pid), owner = packages.get(entry.pkg)!;
    const registry = await Promise.all([...packages.values()].filter((record) => !(record.system && record.pkg === "android")).map(async (record) => {
      const source = packedArchives.get(record.path) ?? await vfs.readFile(record.path);
      if (!source) throw new Error("Package bytes unavailable: " + record.pkg);
      const splits = record.pkg === appHost?.pkg ? appHost.splits.map((name) => vfs.source(apkPath(name))!) : [];
      return { pkg: record.pkg, source, splits, uid: record.uid, system: record.system, grants: [...record.grants], signatures: record.compatibilityCertificates };
    }));
    return { pkg: owner.pkg, process: entry.process, uid: entry.uid, registry, launcher: entry.launcher };
  }
  ready(pid: number, endpoint: ProcessEndpoint): void { this.entry(pid).resolve(endpoint); }
  /** a process ended, or its frame failed: ActivityManagerService.appDiedLocked */
  fail(pid: number, message: string, death: Death): void {
    const entry = this.entries.get(pid);
    if (!entry || entry.dead) return;
    console.warn(`[process] ${entry.process} (pid ${pid}): ${message}`);
    const error = rt.mkThrowable("android/os/DeadObjectException", message);
    entry.dead = true; entry.reject(error);
    for (const reject of entry.pending) reject(error);
    entry.pending.clear();
    this.services.clientDied(pid);
    this.services.processDied(entry.pkg, entry.process, death);
    for (const watcher of entry.watchers) { try { watcher(death); } catch (error) { console.error("[process death]", error); } }
    entry.watchers.clear(); entry.frame?.remove(); this.files.detach(pid); this.location.remove(pid); this.clipboardWatchers.delete(pid);
    for (const activity of this.activities.filter((a) => a.pid === pid)) this.finishActivity(pid, activity.id, 0, null);
  }
  alive(pid: number): boolean { const entry = this.entries.get(pid); return !!entry && !entry.dead; }
  /** kill(2) from a process: SIGKILL of a process of the caller's uid (Process.killProcess of
   *  its other processes); other signals are ART's to handle in the target and are not modelled */
  signal(callerPid: number, pid: number, signal: number): void {
    const caller = this.entry(callerPid), target = this.entries.get(pid);
    if (signal !== 9 || !target || target.dead || target.uid !== caller.uid) return;
    void target.ready.then((endpoint) => endpoint.kill(signal), () => {});
  }
  /** forceStopPackageLocked: the package's services go without restarting, and every process of its
   *  uid dies */
  async forceStop(pkg: string, note?: KillNote): Promise<void> {
    this.services.forceStop(pkg);
    const uid = packages.get(pkg)?.uid;
    await Promise.all([...this.entries.values()].filter((e) => !e.dead && (e.pkg === pkg || e.uid === uid))
      .map((e) => e.ready.then((endpoint) => endpoint.kill(9, note), () => {})));
  }
  /** a removed package leaves every process's package manager, this one's too */
  async packageRemoved(pkg: string): Promise<void> {
    forgetRemoved(pkg);
    await Promise.all([...this.entries.values()].filter((e) => !e.dead).map((e) => e.ready.then((endpoint) => endpoint.packageRemoved(pkg), () => {})));
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
      && (this.shownPids.has(b.client) && this.alive(b.client) || this.servesForeground(b.client, seen)));
  }
  /** `work` for `caller` on `target`, at the caller's priority */
  private inherit<T>(caller: Entry | null, target: Entry, work: () => Promise<T>): Promise<T> {
    if (!caller || !(this.shownPids.has(caller.pid) || caller.foregroundClients > 0)) return work();
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
function forgetRemoved(pkg: string): void {
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
function remoteError(error: unknown): never {
  if (error && typeof error === "object") {
    const ctor: unknown = Reflect.get(error, "constructor"), info: unknown = typeof ctor === "function" ? Reflect.get(ctor, "$i") : null;
    if (info && typeof info === "object" && "name" in info && typeof info.name === "string") {
      const message: unknown = Reflect.get(error, "msg");
      throw rt.mkThrowable(info.name, typeof message === "string" ? message : null);
    }
  }
  throw error;
}
async function remote<T>(pending: Promise<T>): Promise<T> {
  try { return await pending; } catch (error) { return remoteError(error); }
}
export function connectProcess(): ProcessEndpoint {
  const broker = processBroker();
  onProcessExit((status) => broker.fail(PROCESS_PID, `Process has died: ${status.signal !== undefined ? "signal " + status.signal : "exit " + status.code}`, deathOf(lastExit)));
  processTransport.signal = (pid, signal) => broker.signal(PROCESS_PID, pid, signal);
  clipboardTransport.set = data => broker.setClipboard(PROCESS_PID, data);
  clipboardTransport.get = () => broker.getClipboard(PROCESS_PID);
  clipboardTransport.listen = active => broker.watchClipboard(PROCESS_PID, active);
  let nextRequest = 1;
  /** each launch's result delivery, by request */
  const requests = new Map<number, ResultDelivery["deliver"]>();
  activityTransport.presentation = translucent => broker.presentation(PROCESS_PID, translucent);
  activityTransport.launch = async (pkg, process, component, intent, result) => {
    const request = nextRequest++;
    if (result) requests.set(request, result.deliver);
    void broker.launchActivity(PROCESS_PID, pkg, process, component, await encodeIntent(intent), request, result?.caller.cls ?? null);
  };
  activityTransport.finished = (id, code, data) => {
    setVisible(false);
    detached(() => after(data && encodeIntent(data), (encoded) => broker.finishActivity(PROCESS_PID, id, code, encoded)), logUncaught);
  };
  broker.files.attach(PROCESS_PID, vfs);
  useSQLiteStore(broker.databases);
  usePreferenceStore(broker.preferences);
  useNotificationStore(broker.notifications);
  const stopAccounts = useAccountStore(broker.accounts), stopSettings = useSettingsStore(broker.settings);
  if (broker.alive(PROCESS_PID)) { broker.watch(PROCESS_PID, stopAccounts); broker.watch(PROCESS_PID, stopSettings); }
  usePermissionStore(broker.permissions);
  useWebCookies((pkg) => broker.cookies(pkg));
  locationTransport.available = () => broker.location.available;
  locationTransport.enabled = () => broker.location.enabled;
  locationTransport.last = () => broker.location.last;
  locationTransport.subscribe = (id, high, active, receive) => broker.location.subscribe(PROCESS_PID, id, high, active, receive);
  locationTransport.remove = id => broker.location.remove(PROCESS_PID, id);
  providerProcesses.get = (pkg, process, authority) => after(remote(broker.contentProvider(PROCESS_PID, pkg, process, authority)), importBinder);
  broadcastTransport.send = driven(function* (intent, permissions, ordered, initial) {
    const data = yield* awaited(encodeIntent(intent)), targets = yield* receivers(intent), from = initial && (yield* awaited(resultData(initial)));
    return yield* awaited(broadcastResult(yield* awaited(remote(broker.broadcast(PROCESS_PID, data, targets, permissions, ordered, from)))));
  });
  binderTransport.transact = (request) => remote(broker.transact(PROCESS_PID, request));
  binderTransport.alive = (pid) => pid === 0 || broker.alive(pid);
  binderTransport.watch = (pid, died) => pid === 0 ? () => {} : broker.watch(pid, died);
  pendingTransport.create = (pkg, kind, code, flags, intent, intents) => remote(broker.createPending(PROCESS_PID, pkg, kind, code, flags, intent, intents, intentCodec));
  pendingTransport.cancel = id => {
    try { broker.cancelPending(PROCESS_PID, id); } catch (error) { remoteError(error); }
  };
  pendingTransport.send = (id, fill) => remote(broker.intents.send(id, fill));
  pendingTransport.operation = id => {
    try { return broker.takePending(PROCESS_PID, id); } catch (error) { return remoteError(error); }
  };
  pendingTransport.creator = id => {
    const operation = broker.intents.get(id);
    return operation ? { pkg: operation.pkg, uid: operation.uid } : null;
  };
  pendingTransport.kind = id => broker.intents.get(id)?.kind ?? null;
  pendingTransport.flags = id => broker.intents.get(id)?.flags ?? 0;
  alarmTransport.schedule = (id, type, at, interval) => broker.alarms.schedule(id, type, at, interval);
  alarmTransport.cancel = id => broker.alarms.cancel(id);
  const service = (pkg: string, process: string, request: ServiceRequest) => remote(broker.service(PROCESS_PID, pkg, process, request));
  serviceTransport.bind = driven(function* (owner, process, cls, intent, key, flags) {
    yield service(owner.pkg, process, { kind: "bind", cls, intent: yield* awaited(encodeIntent(intent)), key, flags });
  });
  serviceTransport.unbind = async (owner, process, key) => { await service(owner.pkg, process, { kind: "unbind", key }); };
  serviceTransport.start = driven(function* (owner, process, intent, foreground) { yield service(owner.pkg, process, { kind: "start", intent: yield* awaited(encodeIntent(intent)), foreground }); });
  serviceTransport.stop = driven(function* (owner, process, cls, intent) { yield service(owner.pkg, process, { kind: "stop", cls, intent: yield* awaited(encodeIntent(intent)) }); });
  // a process's services run once it is registered, which the page's is only after its boot starts
  let starts: ServiceStarts | undefined;
  serviceTransport.starts = () => starts ??= broker.serviceStarts(PROCESS_PID);
  serviceTransport.connected = (key, binder, dead) => broker.serviceConnected(PROCESS_PID, key, exportBinder(binder), dead);
  serviceTransport.peek = driven(function* (owner, process, intent) {
    return yield* awaited(importBinder(yield* awaited(service(owner.pkg, process, { kind: "peek", intent: yield* awaited(encodeIntent(intent)) }))));
  });
  return {
    clipboardChanged: async () => clipboardChanged(),
    packageRemoved: forgetRemoved,
    kill: (signal, note) => { if (note) noteAppKill(note); exitProcess({ signal }); },
    activity: async (request) => {
      if (request.kind === "back") return (await import("./device")).pressBack();
      return asBroker(function* (): Gen<void> {
        if (request.kind === "visibility") {
          yield taskVisibility(request.phase);
          if (request.phase !== "pause") setVisible(request.phase !== "stop");
        } else if (request.kind === "launch") {
          yield startActivityInProcess(request.component, yield* awaited(decodeIntent(request.intent)), request.id, request.caller);
          setVisible(true);
        } else {
          const deliver = requests.get(request.request);
          requests.delete(request.request);
          deliver?.(request.code, request.data ? yield* awaited(decodeIntent(request.data)) : null);
        }
      }());
    },
    transact: receiveTransaction,
    contentProvider: (authority) => asBroker(function* (): Gen<BinderHandle | null> { return exportBinder(yield* awaited(publishedProvider(authority))); }()),
    broadcast: (intent, component, ordered, data, sender) => asBroker(function* (): Gen<BroadcastData> {
      return yield* awaited(resultData(yield* awaited(deliverQueued(yield* awaited(decodeIntent(intent)), component, ordered, yield* awaited(broadcastResult(data)), sender))));
    }()),
    service: (request) => asBroker(function* (): Gen<BinderHandle | null> {
      if (request.kind === "pending") { yield executePendingIntent(request.operation, request.fill, request.alarmCount); return null; }
      if (request.kind === "unbind") { yield hostedServices.unbind(request.key); return null; }
      if (request.kind === "restart") { yield hostedServices.restart(request.intent, request.binds); return null; }
      const intent = yield* awaited(decodeIntent(request.intent));
      if (request.kind === "bind") { yield hostedServices.bind(intent, request.key, request.flags); return null; }
      if (request.kind === "peek") return exportBinder(yield* awaited(hostedServices.peek(intent)));
      yield hostedServices[request.kind](intent);
      return null;
    }()),
    serviceConnected: (key, binder, dead) => asBroker(function* (): Gen<void> { remoteServiceConnected(key, yield* awaited(importBinder(binder)), dead); }()),
  };
}
export function registerForegroundProcess(): void {
  if (!appHost) return;
  const broker = processBroker();
  broker.connect(appHost.pkg, appHost.pkg, PROCESS_PID);
  broker.foreground(PROCESS_PID);
  broker.ready(PROCESS_PID, connectProcess());
}
