// ActiveServices for AOSP's ActivityThread: the services this process hosts are created, started,
// bound, unbound and stopped through its IApplicationThread in ActiveServices' order, and their
// connections hear each binder the service publishes. A service of another process is reached
// through the broker, whose request lands in that process's ActiveServices.
import { rt, JObj, getDeclared } from "../../jvm/runtime";
import { newObj, vcall, vcallUncaught } from "../../jvm/natives/jlang";
import { newArrayList } from "../../jvm/natives/jcoll";
import { hostedService, notConnected } from "../binder";
import { PROCESS_NAME, PROCESS_PID, PROCESS_UID, reportUncaught } from "../os";
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
  key: string; name: JObj; info: JObj; intent: JObj; token: JObj; created: boolean;
  startRequested: boolean; lastStartId: number; pendingStarts: [JObj, number][]; bindings: Binding[]; foregroundId: number;
}
const services = new Map<string, ServiceRecord>();
const byToken = (token: JObj) => [...services.values()].find((s) => s.token === token) ?? null;

interface Target { info: JObj; name: JObj; pkg: string; process: string }
async function resolve(intent: JObj, resolvedType: string | null): Promise<Target | null> {
  const resolved = await vcall(await pms(), "resolveService", `(${INTENT}Ljava/lang/String;JI)Landroid/content/pm/ResolveInfo;`, intent, resolvedType, GET_SHARED_LIBRARY_FILES, 0);
  const info = resolved && getDeclared<JObj | null>(resolved, "android/content/pm/ResolveInfo", "serviceInfo");
  if (!info) return null;
  const pkg = getDeclared<string>(info, SI, "packageName");
  return { info, pkg, process: getDeclared<string>(info, SI, "processName"),
    name: await newObj("android/content/ComponentName", "(Ljava/lang/String;Ljava/lang/String;)V", pkg, getDeclared(info, SI, "name")) };
}
const isLocal = (t: Target) => t.pkg === appHost?.pkg && t.process === (PROCESS_NAME || t.pkg);
/** retrieveServiceLocked's refusal of the calling package, or null */
async function denial(t: Target, callingPackage: string): Promise<string | null> {
  const uid = getDeclared<number>(getDeclared(t.info, SI, "applicationInfo"), "android/content/pm/ApplicationInfo", "uid");
  if (uid === PROCESS_UID) return null;
  if (!getDeclared(t.info, SI, "exported")) return "not exported from uid " + uid;
  const permission = getDeclared<string | null>(t.info, SI, "permission");
  return permission && await checkPermission(permission, callingPackage) !== 0 ? permission : null;
}
const withComponent = async (intent: JObj, name: JObj): Promise<JObj> => {
  const copy = await newObj("android/content/Intent", `(${INTENT})V`, intent);
  await vcall(copy, "setComponent", `(Landroid/content/ComponentName;)${INTENT}`, name);
  return copy;
};
function remoteOwner(t: Target) {
  const owner = packages.get(t.pkg);
  if (!owner) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown package: " + t.pkg);
  return owner;
}

const keyOf = (t: Target) => t.pkg + "/" + getDeclared<string>(t.info, SI, "name");
async function record(t: Target, intent: JObj): Promise<ServiceRecord> {
  const key = keyOf(t), token = services.has(key) ? null : await newObj("android/os/Binder", "()V");
  let s = services.get(key);
  if (!s) services.set(key, s = { key, name: t.name, info: t.info, intent, token: token!, created: false, startRequested: false,
    lastStartId: 0, pendingStarts: [], bindings: [], foregroundId: 0 });
  return s;
}
async function bindingFor(s: ServiceRecord, intent: JObj, create: boolean): Promise<Binding | null> {
  for (const b of s.bindings) if (await vcall(b.intent, "filterEquals", `(${INTENT})Z`, intent)) return b;
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
  const args = Promise.all(starts.map(([intent, id]) => newObj("android/app/ServiceStartArgs", `(ZII${INTENT})V`, 0, id, 0, intent)))
    .then((list) => newObj("android/content/pm/ParceledListSlice", "(Ljava/util/List;)V", newArrayList(list)));
  return scheduleOnApp("scheduleServiceArgs", `(${BINDER}Landroid/content/pm/ParceledListSlice;)V`, s.token, args);
}
/** bringUpServiceLocked: create, then request the bindings clients wait on, then deliver starts */
async function bringUp(s: ServiceRecord): Promise<void> {
  if (s.created) return;
  s.created = true;
  await Promise.all([
    scheduleOnApp("scheduleCreateService", `(${BINDER}Landroid/content/pm/ServiceInfo;Landroid/content/res/CompatibilityInfo;I)V`,
      s.token, s.info, compatInfo(), processState(PROCESS_STATE_SERVICE)),
    ...s.bindings.map((b) => requestBind(s, b, false)), sendArgs(s)]);
}
async function bringDownIfNeeded(s: ServiceRecord): Promise<void> {
  if (s.startRequested || s.bindings.some((b) => b.connections.some((c) => c.autoCreate))) return;
  services.delete(s.key);
  for (const b of s.bindings) for (const c of b.connections.splice(0)) c.connected(null, true);
  if (s.created) await Promise.all([...s.bindings.filter((b) => b.hasBound).map((b) => {
    b.hasBound = false;
    return scheduleOnApp("scheduleUnbindService", `(${BINDER}${INTENT})V`, s.token, b.intent);
  }), scheduleOnApp("scheduleStopService", `(${BINDER})V`, s.token)]);
  if (s.foregroundId) await stopForegroundNotification(s.foregroundId, true);
}

async function startLocal(t: Target, intent: JObj): Promise<void> {
  const s = await record(t, intent);
  s.startRequested = true;
  s.pendingStarts.push([intent, ++s.lastStartId]);
  await (s.created ? sendArgs(s) : bringUp(s));
}
async function stopLocal(t: Target): Promise<void> {
  const s = services.get(keyOf(t));
  if (!s?.startRequested) return;
  s.startRequested = false;
  await bringDownIfNeeded(s);
}
async function bindLocal(t: Target, intent: JObj, c: Connection): Promise<void> {
  const s = await record(t, intent), b = (await bindingFor(s, intent, true))!;
  b.connections.push(c);
  if (c.autoCreate) await bringUp(s);
  if (b.received && s.created) {
    c.connected(b.binder, false);
    if (b.connections.length === 1 && b.doRebind) await requestBind(s, b, true);
  } else await requestBind(s, b, false);
}
/** removeConnectionLocked for every binding the connection holds */
async function unbindLocal(id: JObj | string): Promise<boolean> {
  let found = false;
  for (const s of [...services.values()]) for (const b of s.bindings) {
    const i = b.connections.findIndex((c) => c.id === id);
    if (i < 0) continue;
    const [c] = b.connections.splice(i, 1);
    found = true;
    if (typeof c.id === "string") c.connected(null, false);   // another process's bind may still wait on a publish
    if (!b.connections.length && s.created && b.hasBound) {
      b.hasBound = false; b.doRebind = false;
      await scheduleOnApp("scheduleUnbindService", `(${BINDER}${INTENT})V`, s.token, b.intent);
    }
    if (c.autoCreate) await bringDownIfNeeded(s);
  }
  return found;
}
async function peekLocal(t: Target): Promise<JObj | null> {
  const s = services.get(keyOf(t));
  return s ? (await bindingFor(s, s.intent, false))?.binder ?? null : null;
}

/** what a broker request for this process's services does */
async function local(intent: JObj): Promise<Target> {
  const t = await resolve(intent, null);
  if (!t || !isLocal(t)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Service not hosted here: " + await vcall(intent, "toString", "()Ljava/lang/String;"));
  return t;
}
export const hostedServices = {
  start: async (intent: JObj) => startLocal(await local(intent), intent),
  stop: async (intent: JObj) => stopLocal(await local(intent)),
  peek: async (intent: JObj) => peekLocal(await local(intent)),
  unbind: (key: string) => unbindLocal(key),
  bind: async (intent: JObj, key: string, flags = BIND_AUTO_CREATE): Promise<JObj | null> => {
    const t = await local(intent);
    return new Promise<JObj | null>((resolve, reject) => {
      bindLocal(t, intent, { id: key, autoCreate: !!(flags & BIND_AUTO_CREATE), connected: (binder, dead) =>
        dead ? reject(rt.mkThrowable("android/os/DeadObjectException", "Service stopped")) : resolve(binder) }).catch(reject);
    });
  },
};

/** a service the platform binds for itself (JobScheduler, the geocode provider): no caller permission applies */
export async function bindAsSystem(component: JComponentName, key: string, action: string | null = null): Promise<{ binder: JObj; unbind: () => Promise<void> }> {
  const parts = (await componentParts(component))!;
  const owner = packages.get(parts.pkg), cls = qualifyComponent(parts.cls, parts.pkg);
  const node = owner?.components.service.get(cls);
  if (!owner || !node || !appHost) throw rt.mkThrowable("java/lang/IllegalArgumentException", "No such service ComponentInfo{" + parts.pkg + "/" + cls + "}");
  const intent = await newIntent(action);
  await vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", await mkComponentName(owner.pkg, cls));
  const process = owner.process(node);
  if (owner.pkg === appHost.pkg && process === (PROCESS_NAME || owner.pkg))
    return { binder: (await hostedServices.bind(intent, key))!, unbind: async () => { await hostedServices.unbind(key); } };
  return { binder: await serviceTransport.bind(owner, process, intent, key) as JObj, unbind: () => serviceTransport.unbind(owner, process, key) };
}

/** ActivityManagerService.startService: the component, or "!" with the refusal ContextImpl throws */
export async function startService(intent: JObj, resolvedType: string | null, foreground: boolean, callingPackage: string): Promise<JObj | null> {
  const t = await resolve(intent, resolvedType);
  if (!t) return null;
  const denied = await denial(t, callingPackage);
  if (denied) return newObj("android/content/ComponentName", "(Ljava/lang/String;Ljava/lang/String;)V", "!", denied);
  const bound = await withComponent(intent, t.name);
  if (isLocal(t)) await startLocal(t, bound);
  else void serviceTransport.start(remoteOwner(t), t.process, bound, foreground).catch(reportUncaught);
  return t.name;
}
/** a connection to a service elsewhere: the broker key that binding holds */
const remoteConnections = new Map<JObj, { t: Target; key: string }[]>();
let nextKey = 1;

/** the methods IActivityManager adds for ActivityThread's services */
export const activeServiceMethods = {
  "startService(Landroid/app/IApplicationThread;Landroid/content/Intent;Ljava/lang/String;ZLjava/lang/String;Ljava/lang/String;I)Landroid/content/ComponentName;":
    (_caller: JObj, intent: JObj, resolvedType: string | null, foreground: number, callingPackage: string) => startService(intent, resolvedType, !!foreground, callingPackage),
  // stopServiceLocked answers 1 for any service the caller may reach, running or not
  "stopService(Landroid/app/IApplicationThread;Landroid/content/Intent;Ljava/lang/String;I)I": async (_caller: JObj, intent: JObj, resolvedType: string | null) => {
    const t = await resolve(intent, resolvedType);
    if (!t) return 0;
    if (await denial(t, appHost!.pkg)) return -1;
    if (isLocal(t)) await stopLocal(t);
    else void serviceTransport.stop(remoteOwner(t), t.process, await withComponent(intent, t.name)).catch(reportUncaught);
    return 1;
  },
  "stopServiceToken(Landroid/content/ComponentName;Landroid/os/IBinder;I)Z": async (_name: JObj, token: JObj, startId: number) => {
    const s = byToken(token);
    if (!s || startId >= 0 && startId !== s.lastStartId) return 0;
    s.startRequested = false;
    await bringDownIfNeeded(s);
    return 1;
  },
  "bindServiceInstance(Landroid/app/IApplicationThread;Landroid/os/IBinder;Landroid/content/Intent;Ljava/lang/String;Landroid/app/IServiceConnection;JLjava/lang/String;Ljava/lang/String;I)I":
    async (_caller: JObj, _token: JObj | null, intent: JObj, resolvedType: string | null, conn: JObj, flags: bigint, _instance: string | null, callingPackage: string) => {
      const t = await resolve(intent, resolvedType);
      if (!t) return 0;
      if (await denial(t, callingPackage)) return -1;
      const bound = await withComponent(intent, t.name), bits = Number(BigInt.asIntN(32, flags));
      const connected = (binder: JObj | null, dead: boolean) => vcallUncaught(conn, "connected", CONNECTED, t.name, binder, +dead);
      if (isLocal(t)) {
        await bindLocal(t, bound, { id: conn, autoCreate: !!(bits & BIND_AUTO_CREATE), connected });
        return 1;
      }
      const key = PROCESS_PID + ":" + nextKey++, held = remoteConnections.get(conn) ?? [];
      held.push({ t, key }); remoteConnections.set(conn, held);
      void serviceTransport.bind(remoteOwner(t), t.process, bound, key, bits).then((binder) => {
        if (remoteConnections.get(conn)?.some((r) => r.key === key)) connected(binder as JObj | null, false);
      }, (error) => { connected(null, true); reportUncaught(error); });
      return 1;
    },
  "unbindService(Landroid/app/IServiceConnection;)Z": async (conn: JObj) => {
    const held = remoteConnections.get(conn) ?? [];
    remoteConnections.delete(conn);
    for (const { t, key } of held) void serviceTransport.unbind(remoteOwner(t), t.process, key).catch(reportUncaught);
    return +(await unbindLocal(conn) || held.length > 0);
  },
  "publishService(Landroid/os/IBinder;Landroid/content/Intent;Landroid/os/IBinder;)V": async (token: JObj, intent: JObj, binder: JObj | null) => {
    const s = byToken(token), b = s && await bindingFor(s, intent, false);
    if (!b) return;
    b.binder = binder; b.requested = b.received = true;
    for (const c of b.connections) c.connected(binder, false);
  },
  // onUnbind asked for onRebind: a client that bound since gets it now, a later one when it binds
  "unbindFinished(Landroid/os/IBinder;Landroid/content/Intent;Z)V": async (token: JObj, intent: JObj, doRebind: number) => {
    const s = byToken(token), b = s && await bindingFor(s, intent, false);
    if (!b || !doRebind) return;
    if (b.connections.length) await requestBind(s!, b, true);
    else b.doRebind = true;
  },
  // no service times out or restarts here, so a finished callback changes nothing
  "serviceDoneExecuting(Landroid/os/IBinder;IIILandroid/content/Intent;)V": () => {},
  "peekService(Landroid/content/Intent;Ljava/lang/String;Ljava/lang/String;)Landroid/os/IBinder;": async (intent: JObj, resolvedType: string | null, callingPackage: string) => {
    const t = await resolve(intent, resolvedType);
    if (!t) return null;
    if (await denial(t, callingPackage)) throw rt.mkThrowable("java/lang/SecurityException", "Permission Denial: Accessing service " + t.pkg);
    return isLocal(t) ? peekLocal(t) : serviceTransport.peek(remoteOwner(t), t.process, await withComponent(intent, t.name));
  },
  // Service.startForeground (id) and stopForeground (its STOP_FOREGROUND_* flags): the service's notification
  "setServiceForeground(Landroid/content/ComponentName;Landroid/os/IBinder;ILandroid/app/Notification;II)V":
    async (_name: JObj, token: JObj, id: number, notification: JObj | null, flags: number) => {
      const s = byToken(token);
      if (!s) return;
      if (id) { s.foregroundId = id; await startForegroundNotification(id, notification); return; }
      const posted = s.foregroundId;
      if (!posted) return;
      if (flags & (STOP_FOREGROUND_REMOVE | STOP_FOREGROUND_DETACH)) s.foregroundId = 0;
      await stopForegroundNotification(posted, !!(flags & STOP_FOREGROUND_REMOVE));
    },
};
