import { PendingIntents, type PendingOperation } from "./pendingintents";
import { Alarms } from "./alarms";
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
import type { WebCookies } from "./webcookies";
import { BrowserLocation } from "./geolocation";
import { locationTransport } from "../android/locationmanager";
import { PrivateFiles } from "./privatefiles";
import { packedArchives, type PackedArchive } from "./packedarchive";

type ServiceRequest = { kind: "bind"; intent: IntentData; key: string } | { kind: "unbind"; key: string }
  | { kind: "start"; intent: IntentData; foreground: boolean }
  | { kind: "pending"; operation: PendingOperation; fill: IntentData | null; alarmCount: number };
type BroadcastData = { code: number; data: string | null; extras: ParcelData; aborted: boolean };
type ActivityRequest = { kind: "launch"; id: number; component: string; intent: IntentData; caller: { pkg: string; cls: string } | null }
  | { kind: "visibility"; phase: "pause" | "stop" | "resume" }
  | { kind: "result"; request: number; code: number; data: IntentData | null } | { kind: "back" };
export const processPresentation = { visible: true, changed: (_visible: boolean) => {} };
export type PackageSnapshot = { pkg: string; source: Uint8Array | PackedArchive; uid: number; system: boolean; grants: string[]; signatures: Uint8Array[] | null };
export type ProcessEndpoint = {
  activity: (request: ActivityRequest) => Promise<void>;
  transact: (request: Transaction, caller: Caller) => Promise<TransactionReply>;
  service: (request: ServiceRequest) => Promise<BinderHandle | null>;
  provider: (request: ProviderRequest, caller: Caller) => Promise<ProviderReply>;
  broadcast: (intent: IntentData, component: string | null, ordered: boolean, result: BroadcastData) => Promise<BroadcastData>;
};
type Entry = { pkg: string; process: string; uid: number; pid: number; frame: HTMLIFrameElement | null;
  ready: Promise<ProcessEndpoint>; resolve: (endpoint: ProcessEndpoint) => void; reject: (error: unknown) => void; dead: boolean;
  watchers: Set<() => void>; pending: Set<(error: unknown) => void> };
export class ProcessBroker {
  readonly files = new PrivateFiles();
  readonly intents = new PendingIntents(async (operation, fill, alarmCount) => {
    if (packages.get(operation.pkg)?.uid !== operation.uid)
      throw rt.mkThrowable("android/app/PendingIntent$CanceledException", "Creator package is unavailable");
    await this.service(operation.pkg, operation.process, { kind: "pending", operation, fill, alarmCount });
  });
  readonly alarms = new Alarms(this.intents, uptimeMillis, reportUncaught);
  createPending(pid: number, pkg: string, kind: PendingOperation["kind"], code: number, flags: number, intent: IntentData): number | null {
    const caller = this.entry(pid), owner = packages.get(pkg);
    if (!owner || owner.uid !== caller.uid) throw rt.mkThrowable("java/lang/SecurityException", "PendingIntent creator does not match caller");
    return this.intents.create({ pkg, kind, code, flags, intent, uid: caller.uid, process: caller.process });
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
  private nextActivity = 1;
  private activities: { id: number; pid: number; caller: number; previous: number; request: number }[] = [];
  private activityQueue: Promise<void> = Promise.resolve();
  private booted = false;

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    const intent = new JIntent(); intent.action = "android.intent.action.BOOT_COMPLETED";
    await this.broadcast(null, await encodeIntent(intent), "android.permission.RECEIVE_BOOT_COMPLETED", false);
  }

  foreground(pid: number): void { this.foregroundPid = pid; }
  launchActivity(caller: number, pkg: string, process: string, component: string, intent: IntentData, request: number, callingClass: string | null = null): Promise<void> {
    const source = this.entry(caller);
    const target = this.connect(pkg, process), activity = { id: this.nextActivity++, pid: target.pid, caller, previous: 0, request };
    return this.queueActivity(async () => {
      const previous = this.entry(this.foregroundPid || caller); activity.previous = previous.pid;
      await this.request(previous, (endpoint) => endpoint.activity({ kind: "visibility", phase: "pause" }));
      this.activities.push(activity);
      try {
        await this.request(target, (endpoint) => endpoint.activity({ kind: "launch", id: activity.id, component, intent, caller: callingClass ? { pkg: source.pkg, cls: callingClass } : null }));
        await this.request(previous, (endpoint) => endpoint.activity({ kind: "visibility", phase: "stop" }));
        this.show(target.pid);
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
  back(caller: number): boolean {
    if (!this.foregroundPid || this.foregroundPid === caller) return false;
    this.queueActivity(() => this.request(this.entry(this.foregroundPid), (endpoint) => endpoint.activity({ kind: "back" })));
    return true;
  }
  private queueActivity(run: () => Promise<void>): Promise<void> {
    this.activityQueue = this.activityQueue.then(run).catch((error) => console.error("[activity process]", error));
    return this.activityQueue;
  }
  private async restore(activity: { caller: number; previous: number; request: number }, code: number, data: IntentData | null): Promise<void> {
    const target = this.alive(activity.previous) ? activity.previous : activity.caller;
    if (this.alive(target)) {
      await this.request(this.entry(target), (endpoint) => endpoint.activity({ kind: "visibility", phase: "resume" }));
      this.show(target);
    }
    if (this.alive(activity.caller)) await this.result(activity, code, data);
  }
  private result(activity: { caller: number; request: number }, code: number, data: IntentData | null): Promise<void> {
    return this.request(this.entry(activity.caller), (endpoint) => endpoint.activity({ kind: "result", request: activity.request, code, data }));
  }
  private show(pid: number): void {
    this.foregroundPid = pid;
    for (const entry of this.entries.values()) {
      if (!entry.frame) continue;
      entry.frame.hidden = entry.pid !== pid;
    }
  }

  connect(pkg: string, process: string, pid?: number): Entry {
    const key = pkg + "/" + process, previous = this.byName.get(key);
    if (previous && !previous.dead) return previous;
    const owner = packages.get(pkg);
    if (!owner) throw new Error("Package not installed: " + pkg);
    let resolve!: Entry["resolve"], reject!: Entry["reject"];
    const entry: Entry = { pkg, process, uid: owner.uid, pid: pid ?? this.nextPid++, frame: null, dead: false, watchers: new Set(), pending: new Set(),
      ready: new Promise((yes, no) => { resolve = yes; reject = no; }), resolve, reject };
    void entry.ready.catch(() => {});
    this.entries.set(entry.pid, entry); this.byName.set(key, entry);
    if (pid === undefined) {
      const frame = document.createElement("iframe"); entry.frame = frame;
      frame.hidden = true;
      frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;border-radius:16px;z-index:1";
      frame.src = "/process?pid=" + entry.pid + `&screen=${device.width}x${device.height}@${device.densityDpi}`;
      const params = new URLSearchParams(location.search);
      for (const key of ["bytecode", "natcheck", "jit"]) {
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
    entry.dead = true; entry.reject(error);
    for (const reject of entry.pending) reject(error);
    entry.pending.clear();
    for (const watcher of entry.watchers) { try { watcher(); } catch (error) { console.error("[process death]", error); } }
    entry.watchers.clear(); entry.frame?.remove(); this.files.detach(pid); this.location.remove(pid);
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
  async service(pkg: string, process: string, request: ServiceRequest): Promise<BinderHandle | null> {
    const entry = request.kind === "unbind" ? this.byName.get(pkg + "/" + process) : this.connect(pkg, process);
    if (!entry || entry.dead) return null;
    return this.request(entry, (endpoint) => endpoint.service(request));
  }
  async provider(pid: number, pkg: string, process: string, request: ProviderRequest): Promise<ProviderReply> {
    const caller = this.entry(pid);
    const owner = packages.get(pkg), node = [...owner?.components.provider.values() ?? []].find((n) => attrStr(n, "authorities")?.split(";").includes(request.authority));
    if (!node) throw new Error("Provider not installed");
    const permission = attrStr(node, request.name === "query" || request.name === "getType" ? "readPermission" : "writePermission") ?? attrStr(node, "permission");
    if (caller.pkg !== pkg && permission && await vcall(getPM(), "checkPermission", "(Ljava/lang/String;Ljava/lang/String;)I", permission, caller.pkg) !== 0)
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
      if (caller && info.permission && await vcall(getPM(), "checkPermission", "(Ljava/lang/String;Ljava/lang/String;)I", info.permission, caller.pkg) !== 0) continue;
      targets.push({ entry: this.connect(info.packageName, info.processName), component: info.name, priority: resolved.priority ?? 0 });
    }
    targets.sort((a, b) => b.priority - a.priority);
    const bundle = new JParcel(); await vcall(bundle, "writeBundle", "(Landroid/os/Bundle;)V", null);
    let result: BroadcastData = { code: 0, data: null, extras: exportParcel(bundle), aborted: false };
    for (const target of targets) {
      if (permission && await vcall(getPM(), "checkPermission", "(Ljava/lang/String;Ljava/lang/String;)I", permission, target.entry.pkg) !== 0) continue;
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
  let nextRequest = 1;
  const requests = new Map<number, ActivityResultTarget>();
  activityTransport.launch = async (pkg, process, component, intent, result) => {
    const request = nextRequest++, data = await encodeIntent(intent);
    if (result && result.code >= 0) requests.set(request, result);
    const caller = result && result.code >= 0 ? await vcall(result.act, "getComponentName", "()Landroid/content/ComponentName;") : null;
    void broker.launchActivity(PROCESS_PID, pkg, process, component, data, request, caller?.cls ?? null);
  };
  activityTransport.finish = (act) => {
    const id = act.remoteId;
    if (!id) return false;
    act.remoteId = 0;
    processPresentation.visible = false; processPresentation.changed(false);
    void (act.resultData ? encodeIntent(act.resultData) : Promise.resolve(null)).then((data) => broker.finishActivity(PROCESS_PID, id, act.resultCode, data));
    return true;
  };
  broker.files.attach(PROCESS_PID, vfs);
  useSQLiteStore(broker.databases);
  usePreferenceStore(broker.preferences);
  usePermissionStore(broker.permissions);
  useWebCookies((pkg) => broker.cookies(pkg));
  locationTransport.available = () => broker.location.available;
  locationTransport.enabled = () => broker.location.enabled;
  locationTransport.last = () => broker.location.last;
  locationTransport.subscribe = (id, high, active, receive) => broker.location.subscribe(PROCESS_PID, id, high, active, receive);
  locationTransport.remove = id => broker.location.remove(PROCESS_PID, id);
  connectProviders((pkg, process, request) => remote(broker.provider(PROCESS_PID, pkg, process, request)));
  broadcastTransport.send = async (intent, permission, ordered) => remote(broker.broadcast(PROCESS_PID, await encodeIntent(intent), permission, ordered));
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
  alarmTransport.schedule = (id, type, at, interval) => broker.alarms.schedule(id, type, at, interval);
  alarmTransport.cancel = id => broker.alarms.cancel(id);
  serviceTransport.bind = async (owner, process, intent, key) => importBinder(await remote(broker.service(owner.pkg, process, { kind: "bind", intent: await encodeIntent(intent), key })));
  serviceTransport.unbind = async (owner, process, key) => { await remote(broker.service(owner.pkg, process, { kind: "unbind", key })); };
  serviceTransport.start = async (owner, process, intent, foreground) => { await remote(broker.service(owner.pkg, process, { kind: "start", intent: await encodeIntent(intent), foreground })); };
  return {
    activity: async (request) => {
      if (request.kind === "back") return (await import("./device")).pressBack();
      if (request.kind === "visibility") {
        await (await import("./device")).activityVisibility(request.phase);
        if (request.phase !== "pause") {
          processPresentation.visible = request.phase === "resume";
          processPresentation.changed(processPresentation.visible);
        }
      } else if (request.kind === "launch") {
        const intent = await decodeIntent(request.intent);
        await onMain(async () => {
          if (!appHost) throw new Error("Process has no application");
          await appHost.launch(request.component, intent, { caller: request.caller, remoteId: request.id });
          if (!appHost.currentActivity()) throw new Error("Activity did not start: " + request.component);
        });
        processPresentation.visible = true; processPresentation.changed(true);
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
