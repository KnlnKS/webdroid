// ActiveServices for AOSP's ActivityThread: the services this process hosts are created, started,
// bound, unbound and stopped through its IApplicationThread in ActiveServices' order, and their
// connections hear each binder the service publishes. A service of another process is reached
// through the broker, whose request lands in that process's ActiveServices.
import { rt, JObj, getDeclared, driven, type Gen } from "../../jvm/runtime";
import { newObj, vcall, callUncaught } from "../../jvm/natives/jlang";
import { hostedService, notConnected, parceledList } from "../binder";
import { PROCESS_NAME, PROCESS_PID, PROCESS_UID } from "../os";
import { appHost } from "../apphost";
import { packages, qualifyComponent, type PackageRecord } from "../packages";
import { checkPermission } from "../permissions";
import { type JComponentName, type JIntent, componentParts, mkComponentName, newIntent } from "../intent";
import { startForegroundNotification, stopForegroundNotification } from "../notification";
import { scheduleOnApp, compatInfo } from "./am";
import { processState, PROCESS_STATE_SERVICE } from "./atm";

/** the services of another process, through the broker; `flags` are bindService's (BIND_AUTO_CREATE when omitted) */
export const serviceTransport: {
  bind: (owner: PackageRecord, process: string, intent: JIntent, key: string, flags?: number) => Promise<unknown>;
  unbind: (owner: PackageRecord, process: string, key: string) => Promise<void>;
  start: (owner: PackageRecord, process: string, intent: JIntent, foreground: boolean) => Promise<void>;
  stop: (owner: PackageRecord, process: string, intent: JIntent) => Promise<void>;
  peek: (owner: PackageRecord, process: string, intent: JIntent) => Promise<unknown>;
} = { bind: notConnected, unbind: notConnected, start: notConnected, stop: notConnected, peek: notConnected };

const SI = "android/content/pm/ServiceInfo", INTENT = "Landroid/content/Intent;", BINDER = "Landroid/os/IBinder;";
const CONNECTED = "(Landroid/content/ComponentName;Landroid/os/IBinder;Z)V";
const BIND_AUTO_CREATE = 1, GET_SHARED_LIBRARY_FILES = 0x400n, STOP_FOREGROUND_REMOVE = 1, STOP_FOREGROUND_DETACH = 2;
const pms = () => hostedService("package") as Promise<JObj>;

/** a ConnectionRecord: an IServiceConnection of this process, or another process's binding by its key */
interface Connection { id: JObj | string; autoCreate: boolean; connected: (binder: JObj | null, dead: boolean) => void }
/** an IntentBindRecord: the binding of one filterEquals-distinct intent */
interface Binding { intent: JObj; binder: JObj | null; requested: boolean; received: boolean; hasBound: boolean; doRebind: boolean; connections: Connection[] }
interface ServiceRecord {
  key: string; info: JObj; intent: JObj; token: JObj; created: boolean;
  startRequested: boolean; lastStartId: number; pendingStarts: [JObj, number][]; bindings: Binding[]; foregroundId: number;
}
const services = new Map<string, ServiceRecord>();
const byToken = (token: JObj) => [...services.values()].find((s) => s.token === token) ?? null;

interface Target { info: JObj; name: JObj; pkg: string; process: string }
function* resolve(intent: JObj, resolvedType: string | null): Gen<Target | null> {
  const resolved = yield vcall(yield pms(), "resolveService", `(${INTENT}Ljava/lang/String;JI)Landroid/content/pm/ResolveInfo;`, intent, resolvedType, GET_SHARED_LIBRARY_FILES, 0);
  const info = resolved && getDeclared<JObj | null>(resolved, "android/content/pm/ResolveInfo", "serviceInfo");
  if (!info) return null;
  const pkg = getDeclared<string>(info, SI, "packageName");
  return { info, pkg, process: getDeclared<string>(info, SI, "processName"),
    name: yield mkComponentName(pkg, getDeclared(info, SI, "name")) };
}
const isLocal = (t: Target) => t.pkg === appHost?.pkg && t.process === (PROCESS_NAME || t.pkg);
/** retrieveServiceLocked's refusal of the calling package, or null */
function* denial(t: Target, callingPackage: string): Gen<string | null> {
  const uid = getDeclared<number>(getDeclared(t.info, SI, "applicationInfo"), "android/content/pm/ApplicationInfo", "uid");
  if (uid === PROCESS_UID) return null;
  if (!getDeclared(t.info, SI, "exported")) return "not exported from uid " + uid;
  const permission = getDeclared<string | null>(t.info, SI, "permission");
  return permission && (yield checkPermission(permission, callingPackage)) !== 0 ? permission : null;
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
function* record(t: Target, intent: JObj): Gen<ServiceRecord> {
  const key = keyOf(t), token = services.has(key) ? null : yield newObj("android/os/Binder", "()V");
  let s = services.get(key);
  if (!s) services.set(key, s = { key, info: t.info, intent, token: token!, created: false, startRequested: false,
    lastStartId: 0, pendingStarts: [], bindings: [], foregroundId: 0 });
  return s;
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
function sendArgs(s: ServiceRecord): Promise<void> | undefined {
  if (!s.pendingStarts.length) return;
  const starts = s.pendingStarts.splice(0);
  const args = rt.drive(function* () {
    const list: JObj[] = [];
    for (const [intent, id] of starts) list.push(yield newObj("android/app/ServiceStartArgs", `(ZII${INTENT})V`, 0, id, 0, intent));
    return yield parceledList(list);
  }());
  return scheduleOnApp("scheduleServiceArgs", `(${BINDER}Landroid/content/pm/ParceledListSlice;)V`, s.token, args);
}
/** bringUpServiceLocked: create, then request the bindings clients wait on, then deliver starts */
function* bringUp(s: ServiceRecord): Gen<void> {
  if (s.created) return;
  s.created = true;
  yield Promise.all([
    scheduleOnApp("scheduleCreateService", `(${BINDER}Landroid/content/pm/ServiceInfo;Landroid/content/res/CompatibilityInfo;I)V`,
      s.token, s.info, compatInfo(), processState(PROCESS_STATE_SERVICE)),
    ...s.bindings.map((b) => requestBind(s, b, false)), sendArgs(s)]);
}
function* bringDownIfNeeded(s: ServiceRecord): Gen<void> {
  if (s.startRequested || s.bindings.some((b) => b.connections.some((c) => c.autoCreate))) return;
  services.delete(s.key);
  for (const b of s.bindings) for (const c of b.connections.splice(0)) c.connected(null, true);
  if (s.created) yield Promise.all([...s.bindings.filter((b) => b.hasBound).map((b) => {
    b.hasBound = false;
    return scheduleOnApp("scheduleUnbindService", `(${BINDER}${INTENT})V`, s.token, b.intent);
  }), scheduleOnApp("scheduleStopService", `(${BINDER})V`, s.token)]);
  if (s.foregroundId) yield stopForegroundNotification(s.foregroundId, true);
}

function* startLocal(t: Target, intent: JObj): Gen<void> {
  const s = yield* record(t, intent);
  s.startRequested = true;
  s.pendingStarts.push([intent, ++s.lastStartId]);
  if (s.created) yield sendArgs(s);
  else yield* bringUp(s);
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
    if (typeof c.id === "string") c.connected(null, false);   // another process's bind may still wait on a publish
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
  bind: driven(function* (intent: JObj, key: string, flags: number = BIND_AUTO_CREATE): Gen<JObj | null> {
    const t = yield* local(intent), bound = Promise.withResolvers<JObj | null>();
    yield* bindLocal(t, intent, { id: key, autoCreate: !!(flags & BIND_AUTO_CREATE), connected: (binder, dead) =>
      dead ? bound.reject(rt.mkThrowable("android/os/DeadObjectException", "Service stopped")) : bound.resolve(binder) });
    return yield bound.promise;
  }),
};

/** a service the platform binds for itself (JobScheduler, the geocode provider): no caller permission applies */
export const bindAsSystem = driven(function* (component: JComponentName, key: string, action: string | null = null): Gen<{ binder: JObj; unbind: () => unknown }> {
  const parts = (yield componentParts(component))!;
  const owner = packages.get(parts.pkg), cls = qualifyComponent(parts.cls, parts.pkg);
  const node = owner?.components.service.get(cls);
  if (!owner || !node || !appHost) throw rt.mkThrowable("java/lang/IllegalArgumentException", "No such service ComponentInfo{" + parts.pkg + "/" + cls + "}");
  const intent = yield newIntent(action);
  yield vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", yield mkComponentName(owner.pkg, cls));
  const process = owner.process(node);
  if (owner.pkg === appHost.pkg && process === (PROCESS_NAME || owner.pkg))
    return { binder: (yield hostedServices.bind(intent, key))!, unbind: () => hostedServices.unbind(key) };
  return { binder: (yield serviceTransport.bind(owner, process, intent, key)) as JObj, unbind: () => serviceTransport.unbind(owner, process, key) };
});

/** ActivityManagerService.startService: the component, or "!" with the refusal ContextImpl throws */
export const startService = driven(function* (intent: JObj, resolvedType: string | null, foreground: boolean, callingPackage: string): Gen<JObj | null> {
  const t = yield* resolve(intent, resolvedType);
  if (!t) return null;
  const denied = yield* denial(t, callingPackage);
  if (denied) return yield mkComponentName("!", denied);
  const bound = yield* withComponent(intent, t.name);
  if (isLocal(t)) yield* startLocal(t, bound);
  else callUncaught(() => serviceTransport.start(remoteOwner(t), t.process, bound, foreground));
  return t.name;
});
/** a connection to a service elsewhere: the broker key that binding holds */
const remoteConnections = new Map<JObj, { t: Target; key: string }[]>();
let nextKey = 1;

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
    else { const bound = yield* withComponent(intent, t.name); callUncaught(() => serviceTransport.stop(remoteOwner(t), t.process, bound)); }
    return 1;
  }),
  "stopServiceToken(Landroid/content/ComponentName;Landroid/os/IBinder;I)Z": driven(function* (_name: JObj, token: JObj, startId: number) {
    const s = byToken(token);
    if (!s || startId >= 0 && startId !== s.lastStartId) return 0;
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
      const connected = (binder: JObj | null, dead: boolean) => callUncaught(() => vcall(conn, "connected", CONNECTED, t.name, binder, +dead));
      if (isLocal(t)) {
        yield* bindLocal(t, bound, { id: conn, autoCreate: !!(bits & BIND_AUTO_CREATE), connected });
        return 1;
      }
      const key = PROCESS_PID + ":" + nextKey++, held = remoteConnections.get(conn) ?? [];
      held.push({ t, key }); remoteConnections.set(conn, held);
      // the binding answers later, on this thread
      callUncaught(() => rt.drive(function* () {
        let binder: JObj | null;
        try { binder = yield serviceTransport.bind(remoteOwner(t), t.process, bound, key, bits); }
        catch (error) { connected(null, true); throw error; }
        if (remoteConnections.get(conn)?.some((r) => r.key === key)) connected(binder, false);
      }()));
      return 1;
    }),
  "unbindService(Landroid/app/IServiceConnection;)Z": driven(function* (conn: JObj) {
    const held = remoteConnections.get(conn) ?? [];
    remoteConnections.delete(conn);
    for (const { t, key } of held) callUncaught(() => serviceTransport.unbind(remoteOwner(t), t.process, key));
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
  // no service times out or restarts here, so a finished callback changes nothing
  "serviceDoneExecuting(Landroid/os/IBinder;IIILandroid/content/Intent;)V": () => {},
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
      if (id) { s.foregroundId = id; yield startForegroundNotification(id, notification); return; }
      const posted = s.foregroundId;
      if (!posted) return;
      if (flags & (STOP_FOREGROUND_REMOVE | STOP_FOREGROUND_DETACH)) s.foregroundId = 0;
      yield stopForegroundNotification(posted, !!(flags & STOP_FOREGROUND_REMOVE));
    }),
};
