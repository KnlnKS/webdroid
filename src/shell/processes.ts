import { PendingIntents, type PendingOperation } from "./pendingintents";
import { Alarms } from "./alarms";
import { AccountStore } from "./accounts";
import { useAccountStore } from "../android/accounts";
import { executePendingIntent, pendingTransport } from "../android/pendingintent";
import { alarmTransport } from "../android/alarm";
import { encodeIntent, decodeIntent, intentCodec } from "../android/intentipc";
import { packages } from "../android/packages";
import { appHost } from "../android/apphost";
import { asSystem, binderTransport, receiveTransaction, SYSTEM_CALLER, INTERFACE_TRANSACTION, exportBinder, importBinder, exportParcel, parcelled, unparcelled, type Caller, type ParcelData, type Transaction, type TransactionReply, type BinderHandle } from "../android/binder";
import { NativeParcel, writeString } from "../android/parcel";
import { newIntent, type ComponentRef } from "../android/intent";
import { PROCESS_PID, processTransport } from "../android/os";
import { exitProcess, onProcessExit, type ExitStatus } from "../process-exit";
import { after, callUncaught, reportUncaught } from "../jvm/natives/jlang";
import { guestSleep, uptimeMillis } from "../guest-clock";
import { hostedServices, serviceTransport } from "../android/server/activeservices";
import { apkPath, vfs } from "./vfs";
import type { FileSource } from "./lazyfile";
import { device, formatScreen } from "./config";
import { broadcastTransport, deliverBroadcast as deliverQueued, type BroadcastResult, type Sender } from "../android/server/broadcastqueue";
import { activityTransport, startActivityInProcess, taskVisibility, type ResultDelivery } from "../android/server/atm";
import { publishedProvider, providerProcesses } from "../android/server/am";
import { queryReceivers, exported, componentPermission, componentProcess, resolveProvider } from "../android/pm";
import { checkPermission, PermissionStore, usePermissionStore } from "../android/permissions";
import { attrStr } from "../android/axml";
import { sqliteStore, useSQLiteStore } from "../android/sqlite";
import { preferenceStore, usePreferenceStore } from "../android/sharedprefs";
import { notificationStore, useNotificationStore } from "../android/notification";
import { settingsStore, useSettingsStore } from "../android/settings";
import { awaited, rt, driven, type Gen } from "../jvm/runtime";
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
/** the broker's work with Java objects, and a process's on the broker's requests, as system_server does it */
const asBroker = <T>(work: Gen<T>): Promise<T> => asSystem(() => rt.drive(work));
const resultData = (result: BroadcastResult): BroadcastData | Promise<BroadcastData> =>
  after(result.extras && parcelled(result.extras), (extras) => ({ ...result, extras }));
const broadcastResult = (data: BroadcastData): BroadcastResult | Promise<BroadcastResult> =>
  after(data.extras && unparcelled("android/os/Bundle", data.extras), (extras) => ({ ...data, extras }));
function setVisible(visible: boolean): void { processPresentation.visible = visible; processPresentation.changed(visible); }
type ServiceRequest = { kind: "bind"; intent: ParcelData; key: string; flags?: number } | { kind: "unbind"; key: string }
  | { kind: "stop"; intent: ParcelData } | { kind: "peek"; intent: ParcelData }
  | { kind: "start"; intent: ParcelData; foreground: boolean }
  | { kind: "pending"; operation: PendingOperation; fill: ParcelData | null; alarmCount: number };
type BroadcastData = { code: number; data: string | null; extras: ParcelData | null; aborted: boolean };
type ActivityRequest = { kind: "launch"; id: number; component: string; intent: ParcelData; caller: ComponentRef | null }
  | { kind: "visibility"; phase: "pause" | "stop" | "resume" | "visible" }
  | { kind: "result"; request: number; code: number; data: ParcelData | null } | { kind: "back" };
export const processPresentation = { visible: true, changed: (_visible: boolean) => {} };
/** AOSP ActivityRecord: how long the previous activity may take to pause, then to stop */
const PAUSE_TIMEOUT_MS = 500, STOP_TIMEOUT_MS = 11_000;
/** splits: the installed config/feature split apks beside the base, which only the running app has */
type PackageSnapshot = { pkg: string; source: Uint8Array | PackedArchive; splits: FileSource[]; uid: number; system: boolean; grants: string[]; signatures: Uint8Array[] | null };
type ProcessEndpoint = {
  activity: (request: ActivityRequest) => Promise<void>;
  transact: (request: Transaction, caller: Caller) => Promise<TransactionReply>;
  service: (request: ServiceRequest) => Promise<BinderHandle | null>;
  contentProvider: (authority: string) => Promise<BinderHandle | null>;
  broadcast: (intent: ParcelData, component: string | null, ordered: boolean, result: BroadcastData, sender: Sender | null) => Promise<BroadcastData>;
  clipboardChanged: () => Promise<void>;
  /** the kernel's SIGKILL: the process ends where it stands */
  kill: (signal: number) => void;
};
type Entry = { pkg: string; process: string; uid: number; pid: number; frame: HTMLIFrameElement | null;
  translucent: boolean;
  ready: Promise<ProcessEndpoint>; resolve: (endpoint: ProcessEndpoint) => void; reject: (error: unknown) => void; dead: boolean;
  /** requests in flight from foreground processes, which this one runs at their priority */
  foregroundClients: number;
  bindings: Map<string, { pkg: string; process: string }>;
  watchers: Set<() => void>; pending: Set<(error: unknown) => void> };
class ProcessBroker {
  readonly files = new PrivateFiles();
  readonly accounts = new AccountStore();
  readonly intents = new PendingIntents(intentCodec, async (operation, fill, alarmCount) => {
    if (packages.get(operation.pkg)?.uid !== operation.uid)
      throw rt.mkThrowable("android/app/PendingIntent$CanceledException", "Creator package is unavailable");
    await this.service(null, operation.pkg, operation.process, { kind: "pending", operation, fill, alarmCount });
  });
  readonly alarms = new Alarms(this.intents, uptimeMillis, reportUncaught);
  async createPending(pid: number, pkg: string, kind: PendingOperation["kind"], code: number, flags: number, intent: ParcelData, intents?: ParcelData[]): Promise<number | null> {
    const caller = this.entry(pid), owner = packages.get(pkg);
    if (!owner || owner.uid !== caller.uid) throw rt.mkThrowable("java/lang/SecurityException", "PendingIntent creator does not match caller");
    return this.intents.create({ pkg, kind, code, flags, intent, intents, uid: caller.uid, process: caller.process });
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
  private clipboard: ParcelData | null = null;
  private clipboardWatchers = new Set<number>();
  private nextActivity = 1;
  private activities: { id: number; pid: number; caller: number; previous: number; request: number }[] = [];
  private activityQueue: Promise<void> = Promise.resolve();
  private booted = false;

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    const intent = await asBroker(function* () { return yield* awaited(encodeIntent(yield* awaited(newIntent("android.intent.action.BOOT_COMPLETED")))); }());
    await this.broadcast(null, intent, ["android.permission.RECEIVE_BOOT_COMPLETED"], false);
  }

  foreground(pid: number): void { this.foregroundPid = pid; this.shownPids = new Set([pid]); }
  /** the foreground process's window when it runs in a frame of its own */
  foregroundWindow(): Window | null { return this.entries.get(this.foregroundPid)?.frame?.contentWindow ?? null; }
  private copyClipboard(data: ParcelData): ParcelData {
    return { bytes: data.bytes.slice(), objects: data.objects.map(([at, handle]) => [at, handle && { ...handle }]) };
  }
  setClipboard(pid: number, data: ParcelData | null): void {
    this.entry(pid);
    this.clipboard = data ? this.copyClipboard(data) : null;
    for (const watcher of this.clipboardWatchers) {
      if (this.alive(watcher)) callUncaught(() => this.request(this.entry(watcher), (endpoint) => endpoint.clipboardChanged()));
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
    const layers = [...visible].reverse();
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
    const entry: Entry = { pkg, process, uid: owner.uid, pid: pid ?? this.nextPid++, frame: null, translucent: false, dead: false, foregroundClients: 0, bindings: new Map(), watchers: new Set(), pending: new Set(),
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
      frame.addEventListener("error", () => this.fail(entry.pid, "Process frame failed"));
      (document.getElementById("screen")?.parentElement ?? document.body).appendChild(frame);
    }
    return entry;
  }
  async bootstrap(pid: number): Promise<{ pkg: string; process: string; uid: number; registry: PackageSnapshot[] }> {
    const entry = this.entry(pid), owner = packages.get(entry.pkg)!;
    const registry = await Promise.all([...packages.values()].filter((record) => !(record.system && record.pkg === "android")).map(async (record) => {
      const source = packedArchives.get(record.path) ?? await vfs.readFile(record.path);
      if (!source) throw new Error("Package bytes unavailable: " + record.pkg);
      const splits = record.pkg === appHost?.pkg ? appHost.splits.map((name) => vfs.source(apkPath(name))!) : [];
      return { pkg: record.pkg, source, splits, uid: record.uid, system: record.system, grants: [...record.grants], signatures: record.compatibilityCertificates };
    }));
    return { pkg: owner.pkg, process: entry.process, uid: entry.uid, registry };
  }
  ready(pid: number, endpoint: ProcessEndpoint): void { this.entry(pid).resolve(endpoint); }
  fail(pid: number, message: string): void {
    const entry = this.entries.get(pid);
    if (!entry || entry.dead) return;
    const error = rt.mkThrowable("android/os/DeadObjectException", message);
    entry.dead = true; entry.reject(error);
    for (const reject of entry.pending) reject(error);
    entry.pending.clear();
    for (const [key, binding] of entry.bindings)
      callUncaught(() => this.service(null, binding.pkg, binding.process, { kind: "unbind", key }));
    entry.bindings.clear();
    for (const watcher of entry.watchers) { try { watcher(); } catch (error) { console.error("[process death]", error); } }
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
  /** a process ended: ActivityManagerService.appDiedLocked's notice, from the process itself */
  died(pid: number, status: ExitStatus): void {
    const entry = this.entries.get(pid);
    if (!entry || entry.dead) return;
    console.warn(`[process] ${entry.process} (pid ${pid}) has died: ${status.signal !== undefined ? "signal " + status.signal : "exit " + status.code}`);
    this.fail(pid, "Process has died");
  }
  /** whether a process shown on screen, or one serving such a process, waits on `pid`: as binder
   *  calls inherit their caller's priority and a service bound from the top app runs in its
   *  scheduling group, process start included */
  servesForeground(pid: number): boolean { return (this.entries.get(pid)?.foregroundClients ?? 0) > 0; }
  /** `work` for `caller` on `target`, at the caller's priority */
  private inherit<T>(caller: Entry | null, target: Entry, work: () => Promise<T>): Promise<T> {
    if (!caller || !(this.shownPids.has(caller.pid) || caller.foregroundClients > 0)) return work();
    target.foregroundClients++;
    return work().finally(() => { target.foregroundClients--; });
  }
  watch(pid: number, died: () => void): () => void {
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
    const caller = pid === null ? null : this.entry(pid);
    if (request.kind === "unbind") caller?.bindings.delete(request.key);
    // only a start, a bind or a pending operation brings up the service's process
    const entry = request.kind === "unbind" || request.kind === "stop" || request.kind === "peek" ? this.byName.get(pkg + "/" + process) : this.connect(pkg, process);
    if (!entry || entry.dead) return null;
    const binding = request.kind === "bind" ? { pkg, process } : null;
    if (request.kind === "bind" && binding) caller?.bindings.set(request.key, binding);
    try {
      const result = await this.inherit(caller, entry, () => this.request(entry, endpoint => endpoint.service(request)));
      if (caller?.dead) throw rt.mkThrowable("android/os/DeadObjectException", "Service caller died");
      return result;
    } catch (error) {
      if (request.kind === "bind" && caller?.bindings.get(request.key) === binding) caller.bindings.delete(request.key);
      throw error;
    }
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
  broadcast(pid: number | null, data: ParcelData, permissions: string[], ordered: boolean, initial?: BroadcastData): Promise<BroadcastData> {
    const broker = this;
    return asBroker(function* (): Gen<BroadcastData> {
      const caller = pid === null ? null : broker.entry(pid), intent = yield* awaited(decodeIntent(data)), sender = caller && { uid: caller.uid, pkg: caller.pkg };
      const targets: { entry: Entry; component: string | null; priority: number }[] = [...broker.entries.values()].filter((e) => !e.dead).map((entry) => ({ entry, component: null, priority: 0 }));
      for (const receiver of yield* awaited(queryReceivers(intent))) {
        const pkg = receiver.owner.pkg, permission = componentPermission(receiver);
        // the platform package's receivers are system_server's, whose part the shell plays itself
        if (pkg === "android" || caller && !exported(receiver) && pkg !== caller.pkg) continue;
        if (caller && permission && (yield* awaited(permissionDenied(permission, caller.pkg)))) continue;
        targets.push({ entry: broker.connect(pkg, componentProcess(receiver)), component: receiver.name, priority: receiver.priority });
      }
      targets.sort((a, b) => b.priority - a.priority);
      let result: BroadcastData = initial ?? (yield* awaited(resultData({ code: 0, data: null, extras: null, aborted: false })));
      for (const target of targets) {
        if (yield* awaited(someDenied(permissions, target.entry.pkg))) continue;
        const sent = result;
        result = yield* awaited(broker.request(target.entry, (endpoint) => endpoint.broadcast(data, target.component, ordered, sent, sender)));
        if (ordered && result.aborted) break;
      }
      return result;
    }());
  }
  private entry(pid: number): Entry {
    const entry = this.entries.get(pid);
    if (!entry || entry.dead) throw rt.mkThrowable("android/os/DeadObjectException", "Process is dead: " + pid);
    return entry;
  }
  private request<T>(entry: Entry, call: (endpoint: ProcessEndpoint) => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      entry.pending.add(reject);
      void entry.ready.then((endpoint) => {
        if (entry.dead) throw rt.mkThrowable("android/os/DeadObjectException", "Process is dead: " + entry.pid);
        return call(endpoint);
      }).then(resolve, reject).finally(() => entry.pending.delete(reject));
    });
  }
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
  onProcessExit((status) => broker.died(PROCESS_PID, status));
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
    callUncaught(() => after(data && encodeIntent(data), (encoded) => broker.finishActivity(PROCESS_PID, id, code, encoded)));
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
    const data = yield* awaited(encodeIntent(intent)), from = initial && (yield* awaited(resultData(initial)));
    return yield* awaited(broadcastResult(yield* awaited(remote(broker.broadcast(PROCESS_PID, data, permissions, ordered, from)))));
  });
  binderTransport.transact = (request) => remote(broker.transact(PROCESS_PID, request));
  binderTransport.alive = (pid) => pid === 0 || broker.alive(pid);
  binderTransport.watch = (pid, died) => pid === 0 ? () => {} : broker.watch(pid, died);
  pendingTransport.create = (pkg, kind, code, flags, intent, intents) => remote(broker.createPending(PROCESS_PID, pkg, kind, code, flags, intent, intents));
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
  serviceTransport.bind = driven(function* (owner, process, intent, key, flags) {
    return yield* awaited(importBinder(yield* awaited(service(owner.pkg, process, { kind: "bind", intent: yield* awaited(encodeIntent(intent)), key, flags }))));
  });
  serviceTransport.unbind = async (owner, process, key) => { await service(owner.pkg, process, { kind: "unbind", key }); };
  serviceTransport.start = driven(function* (owner, process, intent, foreground) { yield service(owner.pkg, process, { kind: "start", intent: yield* awaited(encodeIntent(intent)), foreground }); });
  serviceTransport.stop = driven(function* (owner, process, intent) { yield service(owner.pkg, process, { kind: "stop", intent: yield* awaited(encodeIntent(intent)) }); });
  serviceTransport.peek = driven(function* (owner, process, intent) {
    return yield* awaited(importBinder(yield* awaited(service(owner.pkg, process, { kind: "peek", intent: yield* awaited(encodeIntent(intent)) }))));
  });
  return {
    clipboardChanged: async () => clipboardChanged(),
    kill: (signal) => exitProcess({ signal }),
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
      const intent = yield* awaited(decodeIntent(request.intent));
      if (request.kind === "bind") return exportBinder(yield* awaited(hostedServices.bind(intent, request.key, request.flags)));
      if (request.kind === "peek") return exportBinder(yield* awaited(hostedServices.peek(intent)));
      yield hostedServices[request.kind](intent);
      return null;
    }()),
  };
}
export function registerForegroundProcess(): void {
  if (!appHost) return;
  const broker = processBroker();
  broker.connect(appHost.pkg, appHost.pkg, PROCESS_PID);
  broker.foreground(PROCESS_PID);
  broker.ready(PROCESS_PID, connectProcess());
}
