// ActiveServices for AOSP's ActivityThread: the services this process hosts are created, started,
// bound, unbound and stopped through its IApplicationThread in ActiveServices' order, and their
// connections hear each binder the service publishes. A service of another process is reached
// through the broker, whose request lands in that process's ActiveServices. The broker's
// ServiceRecords own what outlives this process: each service's start state, which this process
// changes there as it starts, delivers and finishes, and other processes' bindings, which it
// recreates in a restarted process.
import { awaited, rt, type JObj, getDeclared, driven, type Gen } from "../../jvm/runtime.ts";
import { newObj, vcall } from "../../jvm/natives/jentry.ts";
import { logUncaught, detached } from "../../jvm/natives/jthrowable.ts";
import { parceledList, exportBinder, importBinder, type ParcelData, binderEscape } from "../binder.ts";
import { encodeIntent, decodeIntent } from "../intentipc.ts";
import { runningApp } from "../apphost.ts";
import { packages, qualifyComponent } from "../packages.ts";
import { checkPermission } from "../permissions.ts";
import { grantIntentUris$ } from "./urigrants.ts";
import { type JComponentName, componentParts$, mkComponentName, newIntent, withComponent$ } from "../intent.ts";
import { startForegroundNotification, stopForegroundNotification } from "../notification.ts";
import { scheduleOnApp, compatInfo, pms, runsHere, STOCK_PM_FLAGS } from "./process.ts";
import { processState, PROCESS_STATE_SERVICE } from "./atm.ts";
import type { ServiceBinding, ServiceRequest } from "../../shell/servicerecords.ts";
import { broker } from "../../shell/broker-access.ts";
import { procIdentity } from "../../shell/procfs.ts";

/** a request to the services of `pkg`'s `process`, which the broker makes of that process's
 *  hostedServices; a binding hears its service's binder through remoteServiceConnected, which the
 *  broker sends again when the service restarts */
const serviceRequest = (pkg: string, process: string, request: ServiceRequest) => broker().service(pkg, process, request);
/** startService of another process's service */
export const startRemoteService = driven(function* (pkg: string, process: string, intent: JObj, foreground: boolean): Gen<void> {
  yield serviceRequest(pkg, process, { kind: "start", intent: yield* awaited(encodeIntent(intent)), foreground });
});
const bindRemote = driven(function* (pkg: string, process: string, cls: string, intent: JObj, key: string, flags: number): Gen<void> {
  yield serviceRequest(pkg, process, { kind: "bind", cls, intent: yield* awaited(encodeIntent(intent)), key, flags });
});
const unbindRemote = (pkg: string, process: string, key: string) => serviceRequest(pkg, process, { kind: "unbind", key });

const SI = "android/content/pm/ServiceInfo", INTENT = "Landroid/content/Intent;", BINDER = "Landroid/os/IBinder;";
const CONNECTED = "(Landroid/content/ComponentName;Landroid/os/IBinder;Z)V";
const BIND_AUTO_CREATE = 1, STOP_FOREGROUND_REMOVE = 1, STOP_FOREGROUND_DETACH = 2;

/** a ConnectionRecord: an IServiceConnection of this process, or another process's binding by its key */
interface Connection { id: JObj | string; autoCreate: boolean; connected: (binder: JObj | null, dead: boolean) => void }
/** an IntentBindRecord: the binding of one filterEquals-distinct intent */
interface Binding { intent: JObj; binder: JObj | null; requested: boolean; received: boolean; hasBound: boolean; doRebind: boolean; connections: Connection[] }
/** this process's part of a ServiceRecord; `intents` are its starts' Intents, by start id, until delivered */
interface ServiceRecord {
  key: string; cls: string; info: JObj; intent: JObj; data: ParcelData; token: JObj; created: boolean; creating?: Promise<void>;
  bindings: Binding[]; foregroundId: number; intents: Map<number, JObj>;
}
const services = new Map<string, ServiceRecord>();
const byToken = (token: JObj) => [...services.values()].find((s) => s.token === token) ?? null;
/** the start state of this process's services, which the broker keeps */
const starts = () => broker().starts;

interface Target { info: JObj; name: JObj; pkg: string; process: string }
function* resolve(intent: JObj, resolvedType: string | null): Gen<Target | null> {
  const resolved = yield vcall(yield* awaited(pms()), "resolveService", `(${INTENT}Ljava/lang/String;JI)Landroid/content/pm/ResolveInfo;`, intent, resolvedType, STOCK_PM_FLAGS, 0);
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
  if (uid === procIdentity.uid) return null;
  if (!getDeclared(t.info, SI, "exported")) return "not exported from uid " + uid;
  const permission = getDeclared<string | null>(t.info, SI, "permission");
  return permission && (yield* awaited(checkPermission(permission, callingPackage))) !== 0 ? permission : null;
}
function remotePkg(t: Target): string {
  if (!packages.has(t.pkg)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown package: " + t.pkg);
  return t.pkg;
}

const serviceClass = (t: Target) => getDeclared<string>(t.info, SI, "name");
const keyOf = (t: Target) => t.pkg + "/" + serviceClass(t);
function* record(t: Target, intent: JObj, data: ParcelData | null = null): Gen<ServiceRecord> {
  const key = keyOf(t);
  if (!services.has(key)) {
    const token: JObj = yield newObj("android/os/Binder", "()V"), encoded = data ?? (yield* awaited(encodeIntent(intent)));
    if (!services.has(key)) services.set(key, { key, cls: serviceClass(t), info: t.info, intent, data: encoded, token, created: false, bindings: [], foregroundId: 0, intents: new Map() });
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
function unbindApp(s: ServiceRecord, b: Binding): Promise<void> {
  b.hasBound = false;
  return scheduleOnApp("scheduleUnbindService", `(${BINDER}${INTENT})V`, s.token, b.intent);
}
/** Service.START_FLAG_REDELIVERY and START_FLAG_RETRY */
const START_FLAG_REDELIVERY = 1, START_FLAG_RETRY = 2;
/** sendServiceArgsLocked: each pending start is delivered, and stays delivered until it finishes */
const sendArgs = driven(function* (s: ServiceRecord): Gen<void> {
  const delivered = yield* awaited(starts().deliver(s.cls));
  if (!delivered.length) return;
  const list: JObj[] = [];
  for (const si of delivered) {
    const local = s.intents.get(si.id); s.intents.delete(si.id);
    const flags = (si.deliveries > 1 ? START_FLAG_RETRY : 0) | (si.done > 0 ? START_FLAG_REDELIVERY : 0);
    const intent = local ?? (si.intent && (yield* awaited(decodeIntent(si.intent))));
    list.push(yield newObj("android/app/ServiceStartArgs", `(ZII${INTENT})V`, 0, si.id, flags, intent));
  }
  yield scheduleOnApp("scheduleServiceArgs", `(${BINDER}Landroid/content/pm/ParceledListSlice;)V`, s.token, yield* awaited(parceledList(list)));
});
/** bringUpServiceLocked: create, then request the bindings clients wait on, then deliver starts */
function* bringUp(s: ServiceRecord): Gen<void> {
  if (s.creating) { yield* awaited(s.creating); return; }
  if (s.created) return;
  // creation is shared by independent Java callers
  const made = Promise.resolve(rt.drive(function* (): Gen<void> {
    yield* awaited(starts().created(s.cls, s.data));
    s.created = true;
    yield Promise.all([scheduleOnApp("scheduleCreateService", `(${BINDER}Landroid/content/pm/ServiceInfo;Landroid/content/res/CompatibilityInfo;I)V`,
      s.token, s.info, compatInfo(), processState(PROCESS_STATE_SERVICE)), ...s.bindings.map((b) => requestBind(s, b, false)), sendArgs(s)]);
  }()));
  s.creating = made;
  try { yield* awaited(made); }
  finally { if (s.creating === made) s.creating = undefined; }
}
function* bringDownIfNeeded(s: ServiceRecord): Gen<void> {
  if (s.creating) yield* awaited(s.creating);
  if ((yield* awaited(starts().requested(s.cls))) || s.bindings.some((b) => b.connections.some((c) => c.autoCreate))) return;
  services.delete(s.key);
  for (const b of s.bindings) for (const c of b.connections.splice(0)) c.connected(null, true);
  yield* awaited(starts().destroyed(s.cls));
  if (s.created) yield Promise.all([...s.bindings.filter((b) => b.hasBound).map((b) => unbindApp(s, b)), scheduleOnApp("scheduleStopService", `(${BINDER})V`, s.token)]);
  if (s.foregroundId) yield stopForegroundNotification(s.foregroundId, true);
}
/** queue starts and deliver them, bringing the service up if it is not */
function* deliver(s: ServiceRecord): Gen<void> {
  if (s.creating || !s.created) return yield* bringUp(s);
  yield sendArgs(s);
}

function* startLocal(t: Target, intent: JObj): Gen<void> {
  const s = yield* record(t, intent), data = yield* awaited(encodeIntent(intent));
  s.intents.set(yield* awaited(starts().start(s.cls, data)), intent);
  yield* deliver(s);
}
function* stopLocal(t: Target): Gen<void> {
  const s = services.get(keyOf(t));
  if (s && (yield* awaited(starts().stop(s.cls)))) yield* bringDownIfNeeded(s);
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
      b.doRebind = false;
      yield unbindApp(s, b);
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
  connected: (binder, dead) => detached(() => broker().serviceConnected(key, exportBinder(binder), dead), logUncaught) });

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
  /** performServiceRestartLocked in a process started for it: the service's bindings, then the starts
   *  the broker kept */
  restart: driven(function* (data: ParcelData, binds: ServiceBinding[]): Gen<void> {
    const intent: JObj = yield* awaited(decodeIntent(data)), t = yield* local(intent), s = yield* record(t, intent, data);
    for (const bind of binds) {
      const b = (yield* bindingFor(s, yield* awaited(decodeIntent(bind.intent)), true))!;
      if (!b.connections.some((c) => c.id === bind.key)) b.connections.push(remoteConnection(bind.key, bind.flags));
    }
    if (s.created) yield Promise.all(s.bindings.map((b) => requestBind(s, b, false)));
    yield* deliver(s);
  }),
};
/** this process's bindings to other processes' services, by their key: the IServiceConnection
 *  (none for the platform's own), what the binding hears and how it unbinds */
const remoteBindings = new Map<string, { conn: JObj | null; connected: Connection["connected"]; unbind: () => unknown }>();
export function remoteServiceConnected(key: string, binder: JObj | null, dead: boolean): void {
  const binding = remoteBindings.get(key);
  if (dead) remoteBindings.delete(key);
  binding?.connected(binder, dead);
}
function remoteUnbind(key: string): unknown {
  const binding = remoteBindings.get(key);
  remoteBindings.delete(key);
  return binding?.unbind();
}

/** a service the platform binds for itself (JobScheduler, the geocode provider): no caller permission applies */
export const bindAsSystem = driven(function* (component: JComponentName, key: string, action: string | null = null): Gen<{ binder: JObj; unbind: () => unknown }> {
  const parts = (yield* componentParts$(component))!;
  const owner = packages.get(parts.pkg), cls = qualifyComponent(parts.cls, parts.pkg);
  const node = owner?.components.service.get(cls);
  if (!owner || !node) throw rt.mkThrowable("java/lang/IllegalArgumentException", "No such service ComponentInfo{" + parts.pkg + "/" + cls + "}");
  const intent = yield* awaited(newIntent(action));
  yield vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", yield* awaited(mkComponentName(owner.pkg, cls)));
  const process = owner.process(node), bound = Promise.withResolvers<JObj | null>();
  const connected = (binder: JObj | null, dead: boolean) => dead ? bound.reject(rt.mkThrowable("android/os/DeadObjectException", "Service stopped")) : bound.resolve(binder);
  if (runsHere(owner.pkg, process)) {
    yield* bindLocal(yield* local(intent), intent, { id: key, autoCreate: true, connected });
    return { binder: (yield* awaited(bound.promise))!, unbind: () => hostedServices.unbind(key) };
  }
  remoteBindings.set(key, { conn: null, connected, unbind: () => unbindRemote(owner.pkg, process, key) });
  try { yield bindRemote(owner.pkg, process, cls, intent, key, BIND_AUTO_CREATE); }
  catch (error) { remoteBindings.delete(key); throw error; }
  return { binder: (yield* awaited(bound.promise))!, unbind: () => remoteUnbind(key) };
});

/** ActivityManagerService.startService: the component, or "!" with the refusal ContextImpl throws */
export const startService = driven(function* (intent: JObj, resolvedType: string | null, foreground: boolean, callingPackage: string): Gen<JObj | null> {
  const t = yield* resolve(intent, resolvedType);
  if (!t) return null;
  const denied = yield* denial(t, callingPackage);
  if (denied) return yield* awaited(mkComponentName("!", denied));
  yield* grantIntentUris$(t.pkg, intent);
  const bound = yield* withComponent$(intent, t.name);
  if (isLocal(t)) yield* startLocal(t, bound);
  else detached(() => startRemoteService(remotePkg(t), t.process, bound, foreground), logUncaught);
  return t.name;
});
let nextKey = 1;
/** IActivityManager's SERVICE_DONE_EXECUTING_START */
const DONE_EXECUTING_START = 1;

/** the methods IActivityManager adds for ActivityThread's services */
export const activeServiceMethods = {
  "startService(Landroid/app/IApplicationThread;Landroid/content/Intent;Ljava/lang/String;ZLjava/lang/String;Ljava/lang/String;I)Landroid/content/ComponentName;":
    (_caller: JObj, intent: JObj, resolvedType: string | null, foreground: number, callingPackage: string) => startService(intent, resolvedType, !!foreground, callingPackage),
  // stopServiceLocked answers 1 for any service the caller may reach, running or not
  "stopService(Landroid/app/IApplicationThread;Landroid/content/Intent;Ljava/lang/String;I)I": driven(function* (_caller: JObj, intent: JObj, resolvedType: string | null) {
    const t = yield* resolve(intent, resolvedType);
    if (!t) return 0;
    if (yield* denial(t, runningApp().pkg)) return -1;
    if (isLocal(t)) yield* stopLocal(t);
    else { const bound = yield* withComponent$(intent, t.name); detached(() => rt.drive(function* () {
      yield serviceRequest(remotePkg(t), t.process, { kind: "stop", cls: serviceClass(t), intent: yield* awaited(encodeIntent(bound)) });
    }()), logUncaught); }
    return 1;
  }),
  "stopServiceToken(Landroid/content/ComponentName;Landroid/os/IBinder;I)Z": driven(function* (_name: JObj, token: JObj, startId: number) {
    const s = byToken(token);
    if (!s || !(yield* awaited(starts().stopSelf(s.cls, startId)))) return 0;
    yield* bringDownIfNeeded(s);
    return 1;
  }),
  "bindServiceInstance(Landroid/app/IApplicationThread;Landroid/os/IBinder;Landroid/content/Intent;Ljava/lang/String;Landroid/app/IServiceConnection;JLjava/lang/String;Ljava/lang/String;I)I":
    driven(function* (_caller: JObj, _token: JObj | null, intent: JObj, resolvedType: string | null, conn: JObj, flags: bigint, _instance: string | null, callingPackage: string) {
      const t = yield* resolve(intent, resolvedType);
      if (!t) return 0;
      if (yield* denial(t, callingPackage)) return -1;
      const bound = yield* withComponent$(intent, t.name), bits = Number(BigInt.asIntN(32, flags));
      const connected = (binder: JObj | null, dead: boolean) => detached(() => vcall(conn, "connected", CONNECTED, t.name, binder, +dead), binderEscape());
      if (isLocal(t)) {
        yield* bindLocal(t, bound, { id: conn, autoCreate: !!(bits & BIND_AUTO_CREATE), connected });
        return 1;
      }
      const key = procIdentity.pid + ":" + nextKey++;
      remoteBindings.set(key, { conn, connected, unbind: () => unbindRemote(remotePkg(t), t.process, key) });
      // the binding answers later, on this thread
      detached(() => rt.drive(function* () {
        try { yield bindRemote(remotePkg(t), t.process, serviceClass(t), bound, key, bits); }
        catch (error) { if (remoteBindings.delete(key)) connected(null, true); throw error; }
      }()), logUncaught);
      return 1;
    }),
  "unbindService(Landroid/app/IServiceConnection;)Z": driven(function* (conn: JObj) {
    const held = [...remoteBindings].filter(([, b]) => b.conn === conn).map(([key]) => key);
    for (const key of held) detached(() => remoteUnbind(key), logUncaught);
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
  // no service times out here
  "serviceDoneExecuting(Landroid/os/IBinder;IIILandroid/content/Intent;)V": driven(function* (token: JObj, type: number, startId: number, res: number) {
    const s = byToken(token);
    if (s && type === DONE_EXECUTING_START && !(yield* awaited(starts().done(s.cls, startId, res))))
      throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown service start result: " + res);
  }),
  "peekService(Landroid/content/Intent;Ljava/lang/String;Ljava/lang/String;)Landroid/os/IBinder;": driven(function* (intent: JObj, resolvedType: string | null, callingPackage: string) {
    const t = yield* resolve(intent, resolvedType);
    if (!t) return null;
    if (yield* denial(t, callingPackage)) throw rt.mkThrowable("java/lang/SecurityException", "Permission Denial: Accessing service " + t.pkg);
    if (isLocal(t)) return yield* peekLocal(t);
    const bound = yield* awaited(encodeIntent(yield* withComponent$(intent, t.name)));
    return yield* awaited(importBinder(yield* awaited(serviceRequest(remotePkg(t), t.process, { kind: "peek", intent: bound }))));
  }),
  // Service.startForeground (id) and stopForeground (its STOP_FOREGROUND_* flags): the service's notification
  "setServiceForeground(Landroid/content/ComponentName;Landroid/os/IBinder;ILandroid/app/Notification;II)V":
    driven(function* (_name: JObj, token: JObj, id: number, notification: JObj | null, flags: number) {
      const s = byToken(token);
      if (!s) return;
      yield* awaited(starts().foreground(s.cls, id !== 0));
      if (id) { s.foregroundId = id; yield startForegroundNotification(id, notification); return; }
      const posted = s.foregroundId;
      if (!posted) return;
      if (flags & (STOP_FOREGROUND_REMOVE | STOP_FOREGROUND_DETACH)) s.foregroundId = 0;
      yield stopForegroundNotification(posted, !!(flags & STOP_FOREGROUND_REMOVE));
    }),
};
