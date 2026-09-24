import { PendingIntents, type PendingOperation } from "./pendingintents";
import { Alarms } from "./alarms";
import { ActivityTasks } from "./activitytasks";
import { AccountStore } from "./accounts";
import { useAccountStore } from "../android/accounts";
import { authenticators, authenticatorMethods } from "../android/authenticator";
import { accountTransport } from "../android/accountrequest";
import { executePendingIntent, pendingTransport } from "../android/pendingintent";
import { alarmTransport } from "../android/alarm";
import { encodeIntent, decodeIntent, type IntentData } from "../android/intentipc";
import { PermissionStore, usePermissionStore } from "../android/context";
import { packages } from "../android/packages";
import { appHost } from "../android/apphost";
import { binderTransport, receiveTransaction, exportBinder, importBinder, exportParcel, importParcel, type Caller, type ParcelData, type Transaction, type TransactionReply, type BinderHandle } from "../android/binder";
import { JParcel } from "../android/parcel";
import { JIntent, activityTransport, deliverActivityResult, type ActivityResultTarget } from "../android/intent";
import { onMain } from "../android/mainloop";
import { PROCESS_PID, uptimeMillis, reportUncaught } from "../android/os";
import { bindLocalService, unbindLocalService, svcStart, serviceTransport } from "../android/runningservices";
import { vcall } from "../jvm/natives/jlang";
import { vfs } from "../jvm/natives/jio";
import { device } from "./config";
import { connectProviders, receiveProvider, type ProviderRequest, type ProviderReply } from "../android/provideripc";
import { broadcastTransport, deliverBroadcast, hasBroadcastReceiver } from "../android/broadcast";
import { getPM, JResolveInfo } from "../android/pm";
import { toJsArray } from "../jvm/natives/jutil";
import { attrStr } from "../android/axml";
import { sqliteStore, useSQLiteStore } from "../android/sqlite";
import { preferenceStore, usePreferenceStore } from "../android/sharedprefs";
import { rt } from "../jvm/runtime";
import { useWebCookies } from "../android/cookies";
import { clipboardTransport, clipboardChanged } from "../android/clipboard";
import type { WebCookies } from "./webcookies";
import { BrowserLocation } from "./geolocation";
import { locationTransport } from "../android/locationmanager";
import { PrivateFiles } from "./privatefiles";
import { packedArchives, type PackedArchive } from "./packedarchive";
import { guestSleep } from "../guest-clock";

const permissionDenied = async (permission: string, pkg: string) =>
  await vcall(getPM(), "checkPermission", "(Ljava/lang/String;Ljava/lang/String;)I", permission, pkg) !== 0;
const resultIntent = (data: JIntent | null) => data ? encodeIntent(data) : Promise.resolve(null);
function setVisible(visible: boolean): void { processPresentation.visible = visible; processPresentation.changed(visible); }
type ServiceRequest = { kind: "bind"; intent: IntentData; key: string } | { kind: "unbind"; key: string }
  | { kind: "start"; intent: IntentData; foreground: boolean }
  | { kind: "pending"; operation: PendingOperation; fill: IntentData | null; alarmCount: number };
type BroadcastData = { code: number; data: string | null; extras: ParcelData; aborted: boolean };
type ActivityRequest = { kind: "launch"; id: number; taskId: number; component: string; intent: IntentData; caller: { pkg: string; cls: string } | null }
  | { kind: "visibility"; phase: "pause" | "stop" | "resume" | "visible" }
  | { kind: "result"; request: number; code: number; data: IntentData | null } | { kind: "back" } | { kind: "finishTask"; taskId: number; resume: boolean };
export const processPresentation = { visible: true, changed: (_visible: boolean) => {} };
/** AOSP ActivityRecord: how long the previous activity may take to pause, then to stop */
const PAUSE_TIMEOUT_MS = 500, STOP_TIMEOUT_MS = 11_000;
type PackageSnapshot = { pkg: string; source: Uint8Array | PackedArchive; uid: number; system: boolean; grants: string[]; signatures: Uint8Array[] | null };
type ProcessEndpoint = {
  activity: (request: ActivityRequest) => Promise<void>;
  transact: (request: Transaction, caller: Caller) => Promise<TransactionReply>;
  service: (request: ServiceRequest) => Promise<BinderHandle | null>;
  provider: (request: ProviderRequest, caller: Caller) => Promise<ProviderReply>;
  broadcast: (intent: IntentData, component: string | null, ordered: boolean, result: BroadcastData) => Promise<BroadcastData>;
  clipboardChanged: () => Promise<void>;
};
type Entry = { pkg: string; process: string; uid: number; pid: number; frame: HTMLIFrameElement | null;
  translucent: boolean;
  ready: Promise<ProcessEndpoint>; resolve: (endpoint: ProcessEndpoint) => void; reject: (error: unknown) => void; dead: boolean;
  bindings: Map<string, { pkg: string; process: string }>;
  watchers: Set<() => void>; pending: Set<(error: unknown) => void> };
class ProcessBroker {
  readonly files = new PrivateFiles();
  readonly tasks = new ActivityTasks();
  readonly accounts = new AccountStore();
  readonly intents = new PendingIntents(async (operation, fill, alarmCount) => {
    if (packages.get(operation.pkg)?.uid !== operation.uid)
      throw rt.mkThrowable("android/app/PendingIntent$CanceledException", "Creator package is unavailable");
    await this.service(null, operation.pkg, operation.process, { kind: "pending", operation, fill, alarmCount });
  });
  readonly alarms = new Alarms(this.intents, uptimeMillis, reportUncaught);
  createPending(pid: number, pkg: string, kind: PendingOperation["kind"], code: number, flags: number, intent: IntentData): number | null {
    const caller = this.entry(pid), owner = packages.get(pkg);
    if (!owner || owner.uid !== caller.uid) throw rt.mkThrowable("java/lang/SecurityException", "PendingIntent creator does not match caller");
    return this.intents.create({ pkg, kind, code, flags, intent, uid: caller.uid, process: caller.process });
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
  readonly permissions = new PermissionStore();
  private cookieStores = new Map<string, Promise<WebCookies>>();
  cookies(pkg: string): Promise<WebCookies> {
    let store = this.cookieStores.get(pkg);
    if (!store) { store = import("./webcookies").then(({ WebCookies }) => new WebCookies(pkg)); this.cookieStores.set(pkg, store); }
    return store;
  }
  readonly databases = sqliteStore;
  readonly preferences = preferenceStore;
  private entries = new Map<number, Entry>();
  private byName = new Map<string, Entry>();
  private nextPid = 1001;
  private foregroundPid = 0;
  private shownPids = new Set<number>();
  private clipboard: ParcelData | null = null;
  private clipboardWatchers = new Set<number>();
  private nextActivity = 1;
  private activities: { id: number; pid: number; taskId: number; caller: number; previous: number; request: number }[] = [];
  private activityQueue: Promise<void> = Promise.resolve();
  private booted = false;

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    const intent = new JIntent(); intent.action = "android.intent.action.BOOT_COMPLETED";
    await this.broadcast(null, await encodeIntent(intent), "android.permission.RECEIVE_BOOT_COMPLETED", false);
  }

  foreground(pid: number): void { this.foregroundPid = pid; this.shownPids = new Set([pid]); }
  private copyClipboard(data: ParcelData): ParcelData {
    return { bytes: data.bytes.slice(), objects: data.objects.map(([at, handle]) => [at, handle && { ...handle }]) };
  }
  setClipboard(pid: number, data: ParcelData | null): void {
    this.entry(pid);
    this.clipboard = data ? this.copyClipboard(data) : null;
    for (const watcher of this.clipboardWatchers) {
      if (this.alive(watcher)) void this.request(this.entry(watcher), (endpoint) => endpoint.clipboardChanged()).catch(reportUncaught);
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
  launchActivity(caller: number, pkg: string, process: string, component: string, intent: IntentData, request: number, callingClass: string | null = null, taskId = 0): Promise<void> {
    const source = this.entry(caller);
    const target = this.connect(pkg, process), activity = { id: this.nextActivity++, pid: target.pid, taskId, caller, previous: 0, request };
    return this.queueActivity(async () => {
      const previous = this.entry(this.foregroundPid || caller); activity.previous = previous.pid;
      await this.visibility(previous, "pause", PAUSE_TIMEOUT_MS);
      this.activities.push(activity);
      try {
        await this.request(target, (endpoint) => endpoint.activity({ kind: "launch", id: activity.id, taskId, component, intent, caller: callingClass ? { pkg: source.pkg, cls: callingClass } : null }));
        await this.show(target.pid);
      } catch (error) {
        this.activities.splice(this.activities.indexOf(activity), 1);
        await this.restore(activity, 0, null);
        throw error;
      }
    });
  }
  finishActivity(pid: number, id: number, code: number, data: IntentData | null): Promise<void> {
    return this.queueActivity(async () => {
      const index = this.activities.findIndex((a) => a.pid === pid && a.id === id);
      if (index < 0) return;
      const [activity] = this.activities.splice(index, 1);
      if (index === this.activities.length) await this.restore(activity, code, data);
      else if (this.alive(activity.caller)) await this.result(activity, code, data);
    });
  }
  activityTask(pid: number, id: number, taskId: number): void {
    const activity = this.activities.find(a => a.pid === pid && a.id === id);
    if (activity) activity.taskId = taskId;
  }
  removeTask(pid: number, activityId: number, code: number, data: IntentData | null): Promise<void> {
    if (!this.tasks.root(pid, activityId)) throw rt.mkThrowable("java/lang/SecurityException", "Activity is not the task root");
    const taskId = this.tasks.task(pid, activityId);
    return this.queueActivity(async () => {
      const members = this.tasks.members(taskId), removed = this.activities.filter(a => a.taskId === taskId);
      const restore = this.activities.at(-1)?.taskId === taskId;
      this.activities = this.activities.filter(a => a.taskId !== taskId);
      for (const member of members.reverse()) if (this.alive(member)) await this.request(this.entry(member), endpoint => endpoint.activity({ kind: "finishTask", taskId, resume: !removed.length && member === this.foregroundPid }));
      const root = removed[0];
      if (root && restore) await this.restore(root, code, data);
      else if (root && this.alive(root.caller)) await this.result(root, code, data);
      for (const activity of removed.slice(1)) if (this.alive(activity.caller)) await this.result(activity, 0, null);
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
  private async restore(activity: { caller: number; previous: number; request: number }, code: number, data: IntentData | null): Promise<void> {
    const target = this.alive(activity.previous) ? activity.previous : activity.caller;
    if (this.alive(target)) {
      await this.request(this.entry(target), (endpoint) => endpoint.activity({ kind: "visibility", phase: "resume" }));
      await this.show(target);
    }
    if (this.alive(activity.caller)) await this.result(activity, code, data);
  }
  private result(activity: { caller: number; request: number }, code: number, data: IntentData | null): Promise<void> {
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
    const entry: Entry = { pkg, process, uid: owner.uid, pid: pid ?? this.nextPid++, frame: null, translucent: false, dead: false, bindings: new Map(), watchers: new Set(), pending: new Set(),
      ready: new Promise((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
    void entry.ready.catch(() => {});
    this.entries.set(entry.pid, entry); this.byName.set(key, entry);
    if (pid === undefined) {
      const frame = document.createElement("iframe"); entry.frame = frame;
      frame.hidden = true;
      frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:16px;z-index:1";
      frame.src = "/process?pid=" + entry.pid + `&screen=${device.width}x${device.height}@${device.densityDpi}&statusBarDp=${device.statusBarDp}`;
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
    const registry = await Promise.all([...packages.values()].map(async (record) => {
      const source = packedArchives.get(record.path) ?? await vfs.readFile(record.path);
      if (!source) throw new Error("Package bytes unavailable: " + record.pkg);
      return { pkg: record.pkg, source, uid: record.uid, system: record.system, grants: [...record.grants], signatures: record.compatibilityCertificates };
    }));
    return { pkg: owner.pkg, process: entry.process, uid: entry.uid, registry };
  }
  ready(pid: number, endpoint: ProcessEndpoint): void { this.entry(pid).resolve(endpoint); }
  fail(pid: number, message: string): void {
    const entry = this.entries.get(pid);
    if (!entry || entry.dead) return;
    const error = rt.mkThrowable("android/os/DeadObjectException", message);
    entry.dead = true; entry.reject(error); this.tasks.died(pid);
    for (const reject of entry.pending) reject(error);
    entry.pending.clear();
    for (const [key, binding] of entry.bindings)
      void this.service(null, binding.pkg, binding.process, { kind: "unbind", key }).catch(reportUncaught);
    entry.bindings.clear();
    for (const watcher of entry.watchers) { try { watcher(); } catch (error) { console.error("[process death]", error); } }
    entry.watchers.clear(); entry.frame?.remove(); this.files.detach(pid); this.location.remove(pid); this.clipboardWatchers.delete(pid);
    for (const activity of this.activities.filter((a) => a.pid === pid)) this.finishActivity(pid, activity.id, 0, null);
  }
  alive(pid: number): boolean { const entry = this.entries.get(pid); return !!entry && !entry.dead; }
  watch(pid: number, died: () => void): () => void {
    const entry = this.entry(pid); entry.watchers.add(died); return () => { entry.watchers.delete(died); };
  }
  async transact(callerPid: number, request: Transaction): Promise<TransactionReply> {
    const caller = this.entry(callerPid);
    if (request.handle.pid === 0) {
      if (!this.intents.known(request.handle.id)) throw rt.mkThrowable("android/os/DeadObjectException", "Unknown system Binder");
      rt.link("android/os/Parcel");
      const reply = new JParcel(), handled = +(request.code === 0x5f4e5446);
      if (handled) await vcall(reply, "writeString", "(Ljava/lang/String;)V", "android.content.IIntentSender");
      return { handled, data: exportParcel(reply) };
    }
    const target = this.entry(request.handle.pid);
    return this.request(target, (endpoint) => endpoint.transact(request, { pid: caller.pid, uid: caller.uid }));
  }
  async service(pid: number | null, pkg: string, process: string, request: ServiceRequest): Promise<BinderHandle | null> {
    const caller = pid === null ? null : this.entry(pid);
    if (request.kind === "unbind") caller?.bindings.delete(request.key);
    const entry = request.kind === "unbind" ? this.byName.get(pkg + "/" + process) : this.connect(pkg, process);
    if (!entry || entry.dead) return null;
    const binding = request.kind === "bind" ? { pkg, process } : null;
    if (request.kind === "bind" && binding) caller?.bindings.set(request.key, binding);
    try {
      const result = await this.request(entry, endpoint => endpoint.service(request));
      if (caller?.dead) throw rt.mkThrowable("android/os/DeadObjectException", "Service caller died");
      return result;
    } catch (error) {
      if (request.kind === "bind" && caller?.bindings.get(request.key) === binding) caller.bindings.delete(request.key);
      throw error;
    }
  }
  async accountRequest(pid: number, type: string, code: number, key: string, data: ParcelData): Promise<number> {
    const caller = this.entry(pid), owner = authenticators().find(a => a.type === type);
    if (!owner || !authenticatorMethods[code - 1]) throw rt.mkThrowable("android/accounts/AuthenticatorException", "Authenticator unavailable");
    rt.link("android/content/Intent"); const intent = new JIntent();
    intent.action = "android.accounts.AccountAuthenticator"; intent.componentPkg = owner.packageName; intent.component = owner.component;
    const handle = await this.service(pid, owner.packageName, owner.process, { kind: "bind", key, intent: await encodeIntent(intent) });
    if (!handle || caller.dead) throw rt.mkThrowable("android/os/DeadObjectException", "Authenticator unavailable");
    const target = this.entry(handle.pid);
    if (target.pkg !== owner.packageName || target.process !== owner.process) throw rt.mkThrowable("java/lang/SecurityException", "Unexpected authenticator Binder owner");
    await this.request(target, endpoint => endpoint.transact({ handle, code, flags: 1, data }, { pid: 0, uid: 1000 }));
    return target.pid;
  }
  async releaseBinding(pid: number, key: string): Promise<void> {
    const caller = this.entries.get(pid), binding = caller?.bindings.get(key);
    if (!binding) return;
    caller!.bindings.delete(key);
    await this.service(null, binding.pkg, binding.process, { kind: "unbind", key });
  }
  async provider(pid: number, pkg: string, process: string, request: ProviderRequest): Promise<ProviderReply> {
    const caller = this.entry(pid);
    const owner = packages.get(pkg), node = [...owner?.components.provider.values() ?? []].find((n) => attrStr(n, "authorities")?.split(";").includes(request.authority));
    if (!node) throw new Error("Provider not installed");
    const permission = attrStr(node, request.access === "read" || request.name === "query" || request.name === "getType" ? "readPermission" : "writePermission") ?? attrStr(node, "permission");
    if (caller.pkg !== pkg && permission && await permissionDenied(permission, caller.pkg))
      throw new Error("Provider permission denied: " + permission);
    return this.request(this.connect(pkg, process), (endpoint) => endpoint.provider(request, { uid: caller.uid, pid }));
  }
  async broadcast(pid: number | null, data: IntentData, permission: string | null, ordered: boolean): Promise<void> {
    const caller = pid === null ? null : this.entry(pid), intent = await decodeIntent(data, false);
    const list = await vcall(getPM(), "queryBroadcastReceivers", "(Landroid/content/Intent;I)Ljava/util/List;", intent, 0);
    const targets: { entry: Entry; component: string | null; priority: number }[] = [...this.entries.values()].filter((e) => !e.dead).map((entry) => ({ entry, component: null, priority: 0 }));
    for (const resolved of await toJsArray(list)) {
      if (!(resolved instanceof JResolveInfo)) continue;
      const info = resolved.activityInfo;
      if (!info || caller && !info.exported && info.packageName !== caller.pkg) continue;
      if (caller && info.permission && await permissionDenied(info.permission, caller.pkg)) continue;
      targets.push({ entry: this.connect(info.packageName, info.processName), component: info.name, priority: resolved.priority ?? 0 });
    }
    targets.sort((a, b) => b.priority - a.priority);
    const bundle = new JParcel(); await vcall(bundle, "writeBundle", "(Landroid/os/Bundle;)V", null);
    let result: BroadcastData = { code: 0, data: null, extras: exportParcel(bundle), aborted: false };
    for (const target of targets) {
      if (permission && await permissionDenied(permission, target.entry.pkg)) continue;
      result = await this.request(target.entry, (endpoint) => endpoint.broadcast(data, target.component, ordered, result));
      if (ordered && result.aborted) break;
    }
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
  clipboardTransport.set = data => broker.setClipboard(PROCESS_PID, data);
  clipboardTransport.get = () => broker.getClipboard(PROCESS_PID);
  clipboardTransport.listen = active => broker.watchClipboard(PROCESS_PID, active);
  let nextRequest = 1;
  const requests = new Map<number, ActivityResultTarget>();
  activityTransport.presentation = translucent => broker.presentation(PROCESS_PID, translucent);
  activityTransport.launch = async (pkg, process, component, intent, result) => {
    const request = nextRequest++, data = await encodeIntent(intent);
    if (result && result.code >= 0) requests.set(request, result);
    const caller = result && result.code >= 0 ? await vcall(result.act, "getComponentName", "()Landroid/content/ComponentName;") : null;
    const taskId = intent.flags & 0x10000000 ? 0 : (result?.act ?? appHost?.currentActivity())?.taskId ?? 0;
    void broker.launchActivity(PROCESS_PID, pkg, process, component, data, request, caller?.cls ?? null, taskId);
  };
  activityTransport.attach = (act, task) => {
    const attached = broker.tasks.attach(PROCESS_PID, task); act.activityId = attached.id; act.taskId = attached.task;
    if (act.remoteId) broker.activityTask(PROCESS_PID, act.remoteId, act.taskId);
  };
  activityTransport.isTaskRoot = act => broker.tasks.root(PROCESS_PID, act.activityId);
  activityTransport.removeTask = act => {
    void resultIntent(act.resultData).then(data => broker.removeTask(PROCESS_PID, act.activityId, act.resultCode, data)).catch(reportUncaught);
  };
  activityTransport.finish = (act) => {
    broker.tasks.detach(PROCESS_PID, act.activityId);
    const id = act.remoteId;
    if (!id) return false;
    act.remoteId = 0;
    setVisible(false);
    void resultIntent(act.resultData).then((data) => broker.finishActivity(PROCESS_PID, id, act.resultCode, data));
    return true;
  };
  broker.files.attach(PROCESS_PID, vfs);
  useSQLiteStore(broker.databases);
  usePreferenceStore(broker.preferences);
  const stopAccounts = useAccountStore(broker.accounts);
  if (broker.alive(PROCESS_PID)) broker.watch(PROCESS_PID, stopAccounts);
  usePermissionStore(broker.permissions);
  useWebCookies((pkg) => broker.cookies(pkg));
  locationTransport.available = () => broker.location.available;
  locationTransport.enabled = () => broker.location.enabled;
  locationTransport.last = () => broker.location.last;
  locationTransport.subscribe = (id, high, active, receive) => broker.location.subscribe(PROCESS_PID, id, high, active, receive);
  locationTransport.remove = id => broker.location.remove(PROCESS_PID, id);
  connectProviders((pkg, process, request) => remote(broker.provider(PROCESS_PID, pkg, process, request)));
  broadcastTransport.send = async (intent, permission, ordered) => remote(broker.broadcast(PROCESS_PID, await encodeIntent(intent), permission, ordered));
  accountTransport.request = (type, code, key, data) => remote(broker.accountRequest(PROCESS_PID, type, code, key, data));
  accountTransport.finish = key => remote(broker.releaseBinding(PROCESS_PID, key));
  binderTransport.transact = (request) => remote(broker.transact(PROCESS_PID, request));
  binderTransport.alive = (pid) => pid === 0 || broker.alive(pid);
  binderTransport.watch = (pid, died) => pid === 0 ? () => {} : broker.watch(pid, died);
  pendingTransport.create = (pkg, kind, code, flags, intent) => {
    try { return broker.createPending(PROCESS_PID, pkg, kind, code, flags, intent); } catch (error) { return remoteError(error); }
  };
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
  alarmTransport.schedule = (id, type, at, interval) => broker.alarms.schedule(id, type, at, interval);
  alarmTransport.cancel = id => broker.alarms.cancel(id);
  serviceTransport.bind = async (owner, process, intent, key) => importBinder(await remote(broker.service(PROCESS_PID, owner.pkg, process, { kind: "bind", intent: await encodeIntent(intent), key })));
  serviceTransport.unbind = async (owner, process, key) => { await remote(broker.service(PROCESS_PID, owner.pkg, process, { kind: "unbind", key })); };
  serviceTransport.start = async (owner, process, intent, foreground) => { await remote(broker.service(PROCESS_PID, owner.pkg, process, { kind: "start", intent: await encodeIntent(intent), foreground })); };
  return {
    clipboardChanged: async () => clipboardChanged(),
    activity: async (request) => {
      const shell = await import("./device");
      if (request.kind === "finishTask") return shell.finishTask(request.taskId, request.resume);
      if (request.kind === "back") return shell.pressBack();
      if (request.kind === "visibility") {
        await shell.activityVisibility(request.phase);
        if (request.phase !== "pause") setVisible(request.phase !== "stop");
      } else if (request.kind === "launch") {
        const intent = await decodeIntent(request.intent);
        await onMain(async () => {
          if (!appHost) throw new Error("Process has no application");
          await appHost.launch(request.component, intent, { caller: request.caller, remoteId: request.id, taskId: request.taskId });
          if (!appHost.currentActivity()) throw new Error("Activity did not start: " + request.component);
        });
        setVisible(true);
      } else {
        const result = requests.get(request.request);
        requests.delete(request.request);
        if (result && !result.act.finished) deliverActivityResult(result.act, result.code, request.code, request.data ? await decodeIntent(request.data) : null);
      }
    },
    transact: receiveTransaction,
    provider: receiveProvider,
    broadcast: async (intent, component, ordered, data) => {
      if (!appHost?.application) throw new Error("Process has no application");
      if (!component && !hasBroadcastReceiver(await decodeIntent(intent, false))) return data;
      const result = await deliverBroadcast(appHost.application, await decodeIntent(intent), component, ordered,
        { ...data, extras: await vcall(importParcel(data.extras), "readBundle", "()Landroid/os/Bundle;") });
      const extras = new JParcel(); await vcall(extras, "writeBundle", "(Landroid/os/Bundle;)V", result.extras);
      return { ...result, extras: exportParcel(extras) };
    },
    service: async (request) => {
      if (request.kind === "unbind") { await unbindLocalService(request.key); return null; }
      if (request.kind === "pending") { await executePendingIntent(request.operation, request.fill, request.alarmCount); return null; }
      const context = appHost?.application;
      if (!context) throw new Error("Process has no application");
      const intent = await decodeIntent(request.intent);
      if (request.kind === "bind") return exportBinder(await bindLocalService(context, intent, request.key));
      svcStart(context, intent, request.foreground); return null;
    },
  };
}
export function registerForegroundProcess(): void {
  if (!appHost) return;
  const broker = processBroker();
  broker.connect(appHost.pkg, appHost.pkg, PROCESS_PID);
  broker.foreground(PROCESS_PID);
  broker.ready(PROCESS_PID, connectProcess());
}
