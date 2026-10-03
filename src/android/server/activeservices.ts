// ActiveServices for AOSP's ActivityThread: the services this process hosts are created, started,
// bound, unbound and stopped through its IApplicationThread in ActiveServices' order, and their
// connections hear each binder the service publishes. A service of another process is reached
// through the broker, whose request lands in that process's ActiveServices. The broker keeps what
// outlives this process: each created service's start state, reported here as it changes, and
// other processes' bindings, which it recreates in a restarted process.
import { awaited, rt, JObj, getDeclared, driven, type Gen } from "../../jvm/runtime";
import { newObj, vcall, detached, logUncaught } from "../../jvm/natives/jlang";
import { notConnected, parceledList, type ParcelData, binderEscape } from "../binder";
import { encodeIntent, decodeIntent } from "../intentipc";
import { PROCESS_PID, PROCESS_UID } from "../os";
import { appHost } from "../apphost";
import { packages, qualifyComponent, type PackageRecord } from "../packages";
import { checkPermission } from "../permissions";
import { type JComponentName, type JIntent, componentParts, mkComponentName, newIntent } from "../intent";
import { startForegroundNotification, stopForegroundNotification } from "../notification";
import { uptimeMillis } from "../../guest-clock";
import { scheduleOnApp, compatInfo, pms, runsHere } from "./am";
import { processState, PROCESS_STATE_SERVICE } from "./atm";
import type { ServiceBinding, ServiceState, StartItem as StartState } from "../../shell/servicerecords";

/** the services of another process, through the broker; `flags` are bindService's. A binding hears
 *  its service's binder through `connected`, which the broker sends again when the service restarts. */
export const serviceTransport: {
  bind: (owner: PackageRecord, process: string, cls: string, intent: JIntent, key: string, flags: number) => unknown;
  unbind: (owner: PackageRecord, process: string, key: string) => unknown;
  start: (owner: PackageRecord, process: string, intent: JIntent, foreground: boolean) => unknown;
  stop: (owner: PackageRecord, process: string, cls: string, intent: JIntent) => unknown;
  peek: (owner: PackageRecord, process: string, intent: JIntent) => unknown;
  /** this process's service's start state for the broker, null once it is destroyed */
  record: (cls: string, state: ServiceState | null) => unknown;
  /** what a binding of another process hears: the binder published, or that the service is gone */
  connected: (key: string, binder: JObj | null, dead: boolean) => unknown;
} = { bind: notConnected, unbind: notConnected, start: notConnected, stop: notConnected, peek: notConnected, record: () => {}, connected: () => {} };

const SI = "android/content/pm/ServiceInfo", INTENT = "Landroid/content/Intent;", BINDER = "Landroid/os/IBinder;";
const CONNECTED = "(Landroid/content/ComponentName;Landroid/os/IBinder;Z)V";
const BIND_AUTO_CREATE = 1, GET_SHARED_LIBRARY_FILES = 0x400n, STOP_FOREGROUND_REMOVE = 1, STOP_FOREGROUND_DETACH = 2;

/** a ConnectionRecord: an IServiceConnection of this process, or another process's binding by its key */
interface Connection { id: JObj | string; autoCreate: boolean; connected: (binder: JObj | null, dead: boolean) => void }
/** an IntentBindRecord: the binding of one filterEquals-distinct intent */
interface Binding { intent: JObj; binder: JObj | null; requested: boolean; received: boolean; hasBound: boolean; doRebind: boolean; connections: Connection[] }
/** ServiceRecord.StartItem, with its intent as the broker holds it */
interface StartItem extends Omit<StartState, "intent"> { intent: JObj | null; data: ParcelData | null }
interface ServiceRecord {
  key: string; info: JObj; intent: JObj; data: ParcelData; token: JObj; created: boolean;
  startRequested: boolean; stopIfKilled: boolean; lastStartId: number; pendingStarts: StartItem[]; deliveredStarts: StartItem[];
  bindings: Binding[]; foregroundId: number; isForeground: boolean;
}
const services = new Map<string, ServiceRecord>();
const byToken = (token: JObj) => [...services.values()].find((s) => s.token === token) ?? null;
/** the broker's copy of a created service's start state, as it changes */
function report(s: ServiceRecord): void {
  const state: ServiceState | null = services.get(s.key) === s && s.created ? { intent: s.data, startRequested: s.startRequested, stopIfKilled: s.stopIfKilled,
    lastStartId: s.lastStartId, starts: [...s.deliveredStarts, ...s.pendingStarts].map(({ data, ...si }) => ({ ...si, intent: data })), foreground: s.isForeground } : null;
  try { serviceTransport.record(getDeclared<string>(s.info, SI, "name"), state); } catch (error) { console.error("[services]", error); }
}
function* startItem(id: number, intent: JObj | null, data: ParcelData | null = null): Gen<StartItem> {
  return { id, intent, data: data ?? (intent && (yield* awaited(encodeIntent(intent)))), deliveries: 0, done: 0, delivered: null };
}

interface Target { info: JObj; name: JObj; pkg: string; process: string }
function* resolve(intent: JObj, resolvedType: string | null): Gen<Target | null> {
  const resolved = yield vcall(yield* awaited(pms()), "resolveService", `(${INTENT}Ljava/lang/String;JI)Landroid/content/pm/ResolveInfo;`, intent, resolvedType, GET_SHARED_LIBRARY_FILES, 0);
  const info = resolved && getDeclared<JObj | null>(resolved, "android/content/pm/ResolveInfo", "serviceInfo");
  if (!info) return null;
  const pkg = getDeclared<string>(info, SI, "packageName");
  return { info, pkg, process: getDeclared<string>(info, SI, "processName"),
    name: yield* awaited(mkComponentName(pkg, getDeclared(info, SI, "name"))) };
}
const isLocal = (t: Target) => runsHere(t.pkg, t.process);
/** retrieveServiceLocked's refusal of the calling package, or null */
function* denial(t: Target, callingPackage: string): Gen<string | null> {
  const uid = getDeclared<number>(getDeclared(t.info, SI, "applicationInfo"), "android/content/pm/ApplicationInfo", "uid");
  if (uid === PROCESS_UID) return null;
  if (!getDeclared(t.info, SI, "exported")) return "not exported from uid " + uid;
  const permission = getDeclared<string | null>(t.info, SI, "permission");
  return permission && (yield* awaited(checkPermission(permission, callingPackage))) !== 0 ? permission : null;
}
function* withComponent(intent: JObj, name: JObj): Gen<JObj> {
  const copy = yield newObj("android/content/Intent", `(${INTENT})V`, intent);
  yield vcall(copy, "setComponent", `(Landroid/content/ComponentName;)${INTENT}`, name);
  return copy;
}
function remoteOwner(t: Target) {
  const owner = packages.get(t.pkg);
  if (!owner) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown package: " + t.pkg);
  return owner;
}

const keyOf = (t: Target) => t.pkg + "/" + getDeclared<string>(t.info, SI, "name");
function* record(t: Target, intent: JObj, data: ParcelData | null = null): Gen<ServiceRecord> {
  const key = keyOf(t);
  if (!services.has(key)) {
    const token: JObj = yield newObj("android/os/Binder", "()V"), encoded = data ?? (yield* awaited(encodeIntent(intent)));
    if (!services.has(key)) services.set(key, { key, info: t.info, intent, data: encoded, token, created: false, startRequested: false,
      stopIfKilled: false, lastStartId: 0, pendingStarts: [], deliveredStarts: [], bindings: [], foregroundId: 0, isForeground: false });
  }
  return services.get(key)!;
}
function* bindingFor(s: ServiceRecord, intent: JObj, create: boolean): Gen<Binding | null> {
  for (const b of s.bindings) if (yield vcall(b.intent, "filterEquals", `(${INTENT})Z`, intent)) return b;
  if (!create) return null;
  const b: Binding = { intent, binder: null, requested: false, received: false, hasBound: false, doRebind: false, connections: [] };
  s.bindings.push(b);
  return b;
}

// Each schedule* call is made synchronously, so the IApplicationThread hears them in this order.
function requestBind(s: ServiceRecord, b: Binding, rebind: boolean): Promise<void> | undefined {
  if (!s.created || b.requested && !rebind || !b.connections.length) return;
  if (!rebind) b.requested = true;
  b.hasBound = true; b.doRebind = false;
  return scheduleOnApp("scheduleBindService", `(${BINDER}${INTENT}ZIJ)V`, s.token, b.intent, +rebind, processState(PROCESS_STATE_SERVICE), 0n);
}
/** Service.START_FLAG_REDELIVERY and START_FLAG_RETRY */
const START_FLAG_REDELIVERY = 1, START_FLAG_RETRY = 2;
/** sendServiceArgsLocked: each pending start is delivered, and stays delivered until it finishes */
function sendArgs(s: ServiceRecord): Promise<void> | undefined {
  if (!s.pendingStarts.length) return;
  const starts = s.pendingStarts.splice(0), now = uptimeMillis();
  for (const si of starts) { si.deliveries++; si.delivered = now; }
  s.deliveredStarts.push(...starts);
  const args = rt.drive(function* () {
    const list: JObj[] = [];
    for (const si of starts) {
      const flags = (si.deliveries > 1 ? START_FLAG_RETRY : 0) | (si.done > 0 ? START_FLAG_REDELIVERY : 0);
      list.push(yield newObj("android/app/ServiceStartArgs", `(ZII${INTENT})V`, 0, si.id, flags, si.intent));
    }
    return yield* awaited(parceledList(list));
  }());
  return scheduleOnApp("scheduleServiceArgs", `(${BINDER}Landroid/content/pm/ParceledListSlice;)V`, s.token, args);
}
/** bringUpServiceLocked: create, then request the bindings clients wait on, then deliver starts */
function* bringUp(s: ServiceRecord): Gen<void> {
  if (s.created) return;
  s.created = true;
  const calls = [scheduleOnApp("scheduleCreateService", `(${BINDER}Landroid/content/pm/ServiceInfo;Landroid/content/res/CompatibilityInfo;I)V`,
    s.token, s.info, compatInfo(), processState(PROCESS_STATE_SERVICE)), ...s.bindings.map((b) => requestBind(s, b, false)), sendArgs(s)];
  report(s);
  yield Promise.all(calls);
}
function* bringDownIfNeeded(s: ServiceRecord): Gen<void> {
  if (s.startRequested || s.bindings.some((b) => b.connections.some((c) => c.autoCreate))) { report(s); return; }
  services.delete(s.key);
  for (const b of s.bindings) for (const c of b.connections.splice(0)) c.connected(null, true);
  report(s);
  if (s.created) yield Promise.all([...s.bindings.filter((b) => b.hasBound).map((b) => {
    b.hasBound = false;
    return scheduleOnApp("scheduleUnbindService", `(${BINDER}${INTENT})V`, s.token, b.intent);
  }), scheduleOnApp("scheduleStopService", `(${BINDER})V`, s.token)]);
  if (s.foregroundId) yield stopForegroundNotification(s.foregroundId, true);
}
/** queue starts and deliver them, bringing the service up if it is not */
function* deliver(s: ServiceRecord): Gen<void> {
  if (!s.created) return yield* bringUp(s);
  const sent = sendArgs(s);
  report(s);
  yield sent;
}

function* startLocal(t: Target, intent: JObj): Gen<void> {
  const s = yield* record(t, intent), si = yield* startItem(0, intent);
  s.startRequested = true; si.id = ++s.lastStartId;
  s.pendingStarts.push(si);
  yield* deliver(s);
}
function* stopLocal(t: Target): Gen<void> {
  const s = services.get(keyOf(t));
  if (!s?.startRequested) return;
  s.startRequested = false;
  yield* bringDownIfNeeded(s);
}
function* bindLocal(t: Target, intent: JObj, c: Connection): Gen<void> {
  const s = yield* record(t, intent), b = (yield* bindingFor(s, intent, true))!;
  b.connections.push(c);
  if (c.autoCreate) yield* bringUp(s);
  if (b.received && s.created) {
    c.connected(b.binder, false);
    if (b.connections.length === 1 && b.doRebind) yield requestBind(s, b, true);
  } else yield requestBind(s, b, false);
}
/** removeConnectionLocked for every binding the connection holds */
function* unbindLocal(id: JObj | string): Gen<boolean> {
  let found = false;
  for (const s of [...services.values()]) for (const b of s.bindings) {
    const i = b.connections.findIndex((c) => c.id === id);
    if (i < 0) continue;
    const [c] = b.connections.splice(i, 1);
    found = true;
    if (!b.connections.length && s.created && b.hasBound) {
      b.hasBound = false; b.doRebind = false;
      yield scheduleOnApp("scheduleUnbindService", `(${BINDER}${INTENT})V`, s.token, b.intent);
    }
    if (c.autoCreate) yield* bringDownIfNeeded(s);
  }
  return found;
}
function* peekLocal(t: Target): Gen<JObj | null> {
  const s = services.get(keyOf(t));
  return s ? (yield* bindingFor(s, s.intent, false))?.binder ?? null : null;
}
/** another process's binding, which hears its binder through the broker */
const remoteConnection = (key: string, flags: number): Connection => ({ id: key, autoCreate: !!(flags & BIND_AUTO_CREATE),
  connected: (binder, dead) => detached(() => serviceTransport.connected(key, binder, dead), logUncaught) });

/** what a broker request for this process's services does */
function* local(intent: JObj): Gen<Target> {
  const t = yield* resolve(intent, null);
  if (!t || !isLocal(t)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Service not hosted here: " + (yield vcall(intent, "toString", "()Ljava/lang/String;")));
  return t;
}
export const hostedServices = {
  start: driven(function* (intent: JObj): Gen<void> { yield* startLocal(yield* local(intent), intent); }),
  stop: driven(function* (intent: JObj): Gen<void> { yield* stopLocal(yield* local(intent)); }),
  peek: driven(function* (intent: JObj): Gen<JObj | null> { return yield* peekLocal(yield* local(intent)); }),
  unbind: driven(unbindLocal),
  bind: driven(function* (intent: JObj, key: string, flags: number): Gen<void> { yield* bindLocal(yield* local(intent), intent, remoteConnection(key, flags)); }),
  /** performServiceRestartLocked in a process started for it: the service's bindings and the starts
   *  it had not finished, or for a sticky start with none a null intent, as bringUpServiceLocked adds */
  restart: driven(function* (data: ParcelData, state: ServiceState | null, binds: ServiceBinding[]): Gen<void> {
    const intent: JObj = yield* awaited(decodeIntent(data)), t = yield* local(intent), s = yield* record(t, intent, data);
    for (const bind of binds) {
      const b = (yield* bindingFor(s, yield* awaited(decodeIntent(bind.intent)), true))!;
      if (!b.connections.some((c) => c.id === bind.key)) b.connections.push(remoteConnection(bind.key, bind.flags));
    }
    if (state) {
      s.startRequested ||= state.startRequested; s.stopIfKilled = state.stopIfKilled; s.lastStartId = Math.max(s.lastStartId, state.lastStartId);
      for (const si of state.starts) s.pendingStarts.push({ ...si, intent: si.intent && (yield* awaited(decodeIntent(si.intent))), data: si.intent });
      if (!s.created && s.startRequested && !s.pendingStarts.length) s.pendingStarts.push(yield* startItem(++s.lastStartId, null));
    }
    if (s.created) yield Promise.all(s.bindings.map((b) => requestBind(s, b, false)));
    yield* deliver(s);
  }),
};
/** the callbacks of this process's bindings to other processes' services, by broker key */
const remoteCallbacks = new Map<string, Connection["connected"]>();
export function remoteServiceConnected(key: string, binder: JObj | null, dead: boolean): void {
  const connected = remoteCallbacks.get(key);
  if (dead) remoteCallbacks.delete(key);
  connected?.(binder, dead);
}

/** a service the platform binds for itself (JobScheduler, the geocode provider): no caller permission applies */
export const bindAsSystem = driven(function* (component: JComponentName, key: string, action: string | null = null): Gen<{ binder: JObj; unbind: () => unknown }> {
  const parts = (yield* awaited(componentParts(component)))!;
  const owner = packages.get(parts.pkg), cls = qualifyComponent(parts.cls, parts.pkg);
  const node = owner?.components.service.get(cls);
  if (!owner || !node || !appHost) throw rt.mkThrowable("java/lang/IllegalArgumentException", "No such service ComponentInfo{" + parts.pkg + "/" + cls + "}");
  const intent = yield* awaited(newIntent(action));
  yield vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", yield* awaited(mkComponentName(owner.pkg, cls)));
  const process = owner.process(node), bound = Promise.withResolvers<JObj | null>();
  const connected = (binder: JObj | null, dead: boolean) => dead ? bound.reject(rt.mkThrowable("android/os/DeadObjectException", "Service stopped")) : bound.resolve(binder);
  if (runsHere(owner.pkg, process)) {
    yield* bindLocal(yield* local(intent), intent, { id: key, autoCreate: true, connected });
    return { binder: (yield* awaited(bound.promise))!, unbind: () => hostedServices.unbind(key) };
  }
  remoteCallbacks.set(key, connected);
  const unbind = () => { remoteCallbacks.delete(key); return serviceTransport.unbind(owner, process, key); };
  try { yield serviceTransport.bind(owner, process, cls, intent, key, BIND_AUTO_CREATE); }
  catch (error) { remoteCallbacks.delete(key); throw error; }
  return { binder: (yield* awaited(bound.promise))!, unbind };
});

/** ActivityManagerService.startService: the component, or "!" with the refusal ContextImpl throws */
export const startService = driven(function* (intent: JObj, resolvedType: string | null, foreground: boolean, callingPackage: string): Gen<JObj | null> {
  const t = yield* resolve(intent, resolvedType);
  if (!t) return null;
  const denied = yield* denial(t, callingPackage);
  if (denied) return yield* awaited(mkComponentName("!", denied));
  const bound = yield* withComponent(intent, t.name);
  if (isLocal(t)) yield* startLocal(t, bound);
  else detached(() => serviceTransport.start(remoteOwner(t), t.process, bound, foreground), logUncaught);
  return t.name;
});
/** a connection to a service elsewhere: the broker key that binding holds */
const remoteConnections = new Map<JObj, { t: Target; key: string }[]>();
let nextKey = 1;
const serviceClass = (t: Target) => getDeclared<string>(t.info, SI, "name");
/** ServiceRecord.findDeliveredStart(id, taskRemoved, remove) */
function finishStart(s: ServiceRecord, id: number): void {
  const i = s.deliveredStarts.findIndex((si) => si.id === id);
  if (i >= 0) s.deliveredStarts.splice(i, 1);
}
/** IActivityManager's SERVICE_DONE_EXECUTING_START and Service's START_* results */
const DONE_EXECUTING_START = 1, START_STICKY_COMPATIBILITY = 0, START_STICKY = 1, START_NOT_STICKY = 2, START_REDELIVER_INTENT = 3, START_TASK_REMOVED_COMPLETE = 1000;

/** the methods IActivityManager adds for ActivityThread's services */
export const activeServiceMethods = {
  "startService(Landroid/app/IApplicationThread;Landroid/content/Intent;Ljava/lang/String;ZLjava/lang/String;Ljava/lang/String;I)Landroid/content/ComponentName;":
    (_caller: JObj, intent: JObj, resolvedType: string | null, foreground: number, callingPackage: string) => startService(intent, resolvedType, !!foreground, callingPackage),
  // stopServiceLocked answers 1 for any service the caller may reach, running or not
  "stopService(Landroid/app/IApplicationThread;Landroid/content/Intent;Ljava/lang/String;I)I": driven(function* (_caller: JObj, intent: JObj, resolvedType: string | null) {
    const t = yield* resolve(intent, resolvedType);
    if (!t) return 0;
    if (yield* denial(t, appHost!.pkg)) return -1;
    if (isLocal(t)) yield* stopLocal(t);
    else { const bound = yield* withComponent(intent, t.name); detached(() => serviceTransport.stop(remoteOwner(t), t.process, serviceClass(t), bound), logUncaught); }
    return 1;
  }),
  // stopSelf(startId) drops the starts delivered up to it, and stops only at the last one
  "stopServiceToken(Landroid/content/ComponentName;Landroid/os/IBinder;I)Z": driven(function* (_name: JObj, token: JObj, startId: number) {
    const s = byToken(token);
    if (!s) return 0;
    if (startId >= 0) {
      const i = s.deliveredStarts.findIndex((si) => si.id === startId);
      if (i >= 0) s.deliveredStarts.splice(0, i + 1);
      if (startId !== s.lastStartId) { report(s); return 0; }
    }
    s.startRequested = false;
    yield* bringDownIfNeeded(s);
    return 1;
  }),
  "bindServiceInstance(Landroid/app/IApplicationThread;Landroid/os/IBinder;Landroid/content/Intent;Ljava/lang/String;Landroid/app/IServiceConnection;JLjava/lang/String;Ljava/lang/String;I)I":
    driven(function* (_caller: JObj, _token: JObj | null, intent: JObj, resolvedType: string | null, conn: JObj, flags: bigint, _instance: string | null, callingPackage: string) {
      const t = yield* resolve(intent, resolvedType);
      if (!t) return 0;
      if (yield* denial(t, callingPackage)) return -1;
      const bound = yield* withComponent(intent, t.name), bits = Number(BigInt.asIntN(32, flags));
      const connected = (binder: JObj | null, dead: boolean) => detached(() => vcall(conn, "connected", CONNECTED, t.name, binder, +dead), binderEscape());
      if (isLocal(t)) {
        yield* bindLocal(t, bound, { id: conn, autoCreate: !!(bits & BIND_AUTO_CREATE), connected });
        return 1;
      }
      const key = PROCESS_PID + ":" + nextKey++, held = remoteConnections.get(conn) ?? [];
      held.push({ t, key }); remoteConnections.set(conn, held);
      remoteCallbacks.set(key, connected);
      // the binding answers later, on this thread
      detached(() => rt.drive(function* () {
        try { yield serviceTransport.bind(remoteOwner(t), t.process, serviceClass(t), bound, key, bits); }
        catch (error) { if (remoteCallbacks.delete(key)) connected(null, true); throw error; }
      }()), logUncaught);
      return 1;
    }),
  "unbindService(Landroid/app/IServiceConnection;)Z": driven(function* (conn: JObj) {
    const held = remoteConnections.get(conn) ?? [];
    remoteConnections.delete(conn);
    for (const { t, key } of held) { remoteCallbacks.delete(key); detached(() => serviceTransport.unbind(remoteOwner(t), t.process, key), logUncaught); }
    return +((yield* unbindLocal(conn)) || held.length > 0);
  }),
  "publishService(Landroid/os/IBinder;Landroid/content/Intent;Landroid/os/IBinder;)V": driven(function* (token: JObj, intent: JObj, binder: JObj | null) {
    const s = byToken(token), b = s && (yield* bindingFor(s, intent, false));
    if (!b) return;
    b.binder = binder; b.requested = b.received = true;
    for (const c of b.connections) c.connected(binder, false);
  }),
  // onUnbind asked for onRebind: a client that bound since gets it now, a later one when it binds
  "unbindFinished(Landroid/os/IBinder;Landroid/content/Intent;Z)V": driven(function* (token: JObj, intent: JObj, doRebind: number) {
    const s = byToken(token), b = s && (yield* bindingFor(s, intent, false));
    if (!b || !doRebind) return;
    if (b.connections.length) yield requestBind(s!, b, true);
    else b.doRebind = true;
  }),
  // serviceDoneExecutingLocked: onStartCommand's result decides what a restart after this
  // process dies delivers; no service times out here
  "serviceDoneExecuting(Landroid/os/IBinder;IIILandroid/content/Intent;)V": (token: JObj, type: number, startId: number, res: number) => {
    const s = byToken(token);
    if (!s || type !== DONE_EXECUTING_START) return;
    if (res === START_STICKY_COMPATIBILITY || res === START_STICKY) { finishStart(s, startId); s.stopIfKilled = false; }
    else if (res === START_NOT_STICKY) { finishStart(s, startId); if (s.lastStartId === startId) s.stopIfKilled = true; }
    else if (res === START_REDELIVER_INTENT) {
      const si = s.deliveredStarts.find((si) => si.id === startId);
      if (si) { si.deliveries = 0; si.done++; s.stopIfKilled = true; }
    } else if (res === START_TASK_REMOVED_COMPLETE) finishStart(s, startId);
    else throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown service start result: " + res);
    report(s);
  },
  "peekService(Landroid/content/Intent;Ljava/lang/String;Ljava/lang/String;)Landroid/os/IBinder;": driven(function* (intent: JObj, resolvedType: string | null, callingPackage: string) {
    const t = yield* resolve(intent, resolvedType);
    if (!t) return null;
    if (yield* denial(t, callingPackage)) throw rt.mkThrowable("java/lang/SecurityException", "Permission Denial: Accessing service " + t.pkg);
    return isLocal(t) ? yield* peekLocal(t) : yield serviceTransport.peek(remoteOwner(t), t.process, yield* withComponent(intent, t.name));
  }),
  // Service.startForeground (id) and stopForeground (its STOP_FOREGROUND_* flags): the service's notification
  "setServiceForeground(Landroid/content/ComponentName;Landroid/os/IBinder;ILandroid/app/Notification;II)V":
    driven(function* (_name: JObj, token: JObj, id: number, notification: JObj | null, flags: number) {
      const s = byToken(token);
      if (!s) return;
      s.isForeground = id !== 0;
      report(s);
      if (id) { s.foregroundId = id; yield startForegroundNotification(id, notification); return; }
      const posted = s.foregroundId;
      if (!posted) return;
      if (flags & (STOP_FOREGROUND_REMOVE | STOP_FOREGROUND_DETACH)) s.foregroundId = 0;
      yield stopForegroundNotification(posted, !!(flags & STOP_FOREGROUND_REMOVE));
    }),
};
