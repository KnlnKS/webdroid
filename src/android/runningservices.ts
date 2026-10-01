import { JObj, rt, driven, type Gen } from "../jvm/runtime";
import { type JComponentName, type JIntent, componentParts, intentQuery, intentQuery$, mkComponentName, newIntent } from "./intent";
import { type JContext, JContextWrapper } from "./context";
import { appHost, jclsNameOf } from "./apphost";
import { newObj, vcall, vcallOn, callOn, mainThread } from "../jvm/natives/jlang";
import { onMain, inMainJob, fnRunnable } from "./mainloop";
import { reportUncaught, PROCESS_PID, PROCESS_UID, PROCESS_NAME } from "./os";
import { packages, qualifyComponent, type PackageRecord } from "./packages";
import { resolveService, exported, componentPermission, componentProcess, checkPermission } from "./pm";
import { binderTransport, exportBinder } from "./binder";
import { startForegroundNotification, stopForegroundNotification } from "./notification";

type Binding = { intent: JIntent; binder: unknown; clients: Set<string>; rebind: boolean };
class JRunningServiceInfo extends JObj {
  service: JComponentName | null = null;
  /** the service's dotted class name */
  cls = "";
  pid = PROCESS_PID; uid = PROCESS_UID; process = ""; foreground = 0; started = 0; flags = 0;
  activeSince = 0n; lastActivityTime = 0n; restarting = 0n;
  activeCount = 0; clientCount = 0; crashCount = 0;
  instance: JContextWrapper | null = null;
  startId = 0;
  /** the id its foreground notification posted under, until removed or detached */
  foregroundId = 0;
  /** IntentBindRecords: one per intent distinct under filterEquals */
  bindings: Binding[] = [];
}
const noTransport = async (): Promise<never> => { throw rt.mkThrowable("android/os/RemoteException", "Process transport unavailable"); };
/** the services of another process; `flags` are bindService's (BIND_AUTO_CREATE when omitted) */
export const serviceTransport: {
  bind: (owner: PackageRecord, process: string, intent: JIntent, key: string, flags?: number) => Promise<unknown>;
  unbind: (owner: PackageRecord, process: string, key: string) => Promise<void>;
  start: (owner: PackageRecord, process: string, intent: JIntent, foreground: boolean) => Promise<void>;
  stop: (owner: PackageRecord, process: string, intent: JIntent) => Promise<void>;
  peek: (owner: PackageRecord, process: string, intent: JIntent) => Promise<unknown>;
} = { bind: noTransport, unbind: async () => {}, start: noTransport, stop: noTransport, peek: noTransport };
rt.register({
  name: "android/app/ActivityManager$RunningServiceInfo", ctor: JRunningServiceInfo, ifaces: ["android/os/Parcelable"],
  statics: { FLAG_STARTED: 1, FLAG_FOREGROUND: 2, FLAG_SYSTEM_PROCESS: 4, FLAG_PERSISTENT_PROCESS: 8 },
  fields: ["service", "pid", "uid", "process", "foreground", "started", "flags", "activeSince", "lastActivityTime",
    "restarting", "activeCount", "clientCount", "crashCount"],
  methods: { "<init>()V": function () {} },
});

/** started-and-not-stopped services, keyed by dotted class name (matches Class.getName()) */
export const runningServices = new Map<string, JRunningServiceInfo>();
async function serviceRecord(ctx: JContext, cls: string): Promise<JRunningServiceInfo> {
  let si = runningServices.get(cls);
  if (!si) {
    const pkg = ctx.$host?.pkg ?? appHost?.pkg ?? "";
    si = rt.make("android/app/ActivityManager$RunningServiceInfo") as JRunningServiceInfo;
    si.cls = cls; si.process = PROCESS_NAME || pkg;
    si.activeSince = BigInt(Date.now()); runningServices.set(cls, si);
    si.service = await mkComponentName(pkg, cls);
  }
  return si;
}
// a service's callbacks run on the main thread; the awaits between them can resume under another
// thread's identity, so each call names the main thread
async function createService(service: JRunningServiceInfo, ctx: JContext): Promise<JContextWrapper> {
  if (!service.instance) {
    const instance: unknown = await callOn(mainThread, () => newObj(service.cls.replaceAll(".", "/")));
    if (!(instance instanceof JContextWrapper) || !rt.iof(instance, "android/app/Service")) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Not a service: " + service.cls);
    service.instance = instance;
    await vcallOn(mainThread, instance, "attachBaseContext", "(Landroid/content/Context;)V", ctx.$host?.application ?? ctx);
    await vcallOn(mainThread, instance, "onCreate", "()V");
  }
  return service.instance;
}
/** ActivityThread.handleStopService: the destroyed service stays reachable until a context-cleanup
 *  message queued behind it runs, so what onDestroy posts (androidx's ServiceLifecycleDispatcher
 *  weakly holds the service) still finds it */
async function destroyService({ instance, foregroundId }: JRunningServiceInfo): Promise<void> {
  if (foregroundId) await stopForegroundNotification(foregroundId, true);
  if (!instance) return;
  await vcallOn(mainThread, instance, "onDestroy", "()V");
  void onMain(() => instance);
}
export const svcStart = driven(function* svcStart$(ctx: JContext, intent: JIntent | null, _fg: boolean): Gen<JComponentName | null> {
  const q = intent && (yield* intentQuery$(intent)), cls = q?.component;
  if (!intent || !q || !cls) return null;
  const owner = packages.get(q.componentPkg ?? q.pkg ?? ctx.$host?.pkg ?? "");
  const node = owner?.components.service.get(qualifyComponent(cls, owner.pkg));
  if (owner && node && (owner.pkg !== ctx.$host?.pkg || owner.process(node) !== (PROCESS_NAME || ctx.$host?.pkg))) {
    void serviceTransport.start(owner, owner.process(node), intent, _fg)
      .then(() => activatePending(owner.pkg + "/" + qualifyComponent(cls, owner.pkg))).catch(reportUncaught);
    return yield mkComponentName(owner.pkg, qualifyComponent(cls, owner.pkg));
  }
  const si: JRunningServiceInfo = yield serviceRecord(ctx, cls);
  si.started = 1; si.flags |= 1;
  si.lastActivityTime = BigInt(Date.now());
  const service = si, startId = ++si.startId;
  void onMain(async () => {
    await vcallOn(mainThread, await createService(service, ctx), "onStartCommand", "(Landroid/content/Intent;II)I", intent, 0, startId);
  }).catch((error) => {
    if (runningServices.get(cls) === service) runningServices.delete(cls);
    reportUncaught(error);
  });
  activatePending((owner?.pkg ?? ctx.$host?.pkg ?? "") + "/" + qualifyComponent(cls, owner?.pkg ?? ctx.$host?.pkg ?? ""));
  return si.service;
});
export function svcStop(cls: string | null | undefined, startId = -1): number {
  const service = cls ? runningServices.get(cls) : null;
  if (!service || (startId !== -1 && startId !== service.startId)) return 0;
  service.started = 0; service.flags &= ~1;
  if (service.clientCount) return 1;
  runningServices.delete(cls!);
  void onMain(() => destroyService(service)).catch(reportUncaught);
  return 1;
}
const localConnections = new Map<string, { service: JRunningServiceInfo; binding: Binding }>();
export function bindLocalService(ctx: JContext, intent: JIntent, key: string): Promise<unknown> {
  const run = async () => {
    const { component } = await intentQuery(intent);
    const service = await serviceRecord(ctx, component!), instance = await createService(service, ctx);
    let binding: Binding | undefined;
    for (const b of service.bindings) if (await vcall(b.intent, "filterEquals", "(Landroid/content/Intent;)Z", intent)) { binding = b; break; }
    if (!binding) {
      binding = { intent, binder: await vcallOn(mainThread, instance, "onBind", "(Landroid/content/Intent;)Landroid/os/IBinder;", intent), clients: new Set(), rebind: false };
      service.bindings.push(binding);
    } else if (!binding.clients.size && binding.rebind) {
      await vcallOn(mainThread, instance, "onRebind", "(Landroid/content/Intent;)V", intent); binding.rebind = false;
    }
    if (!binding.clients.has(key)) { binding.clients.add(key); service.clientCount++; }
    localConnections.set(key, { service, binding });
    return binding.binder;
  };
  return inMainJob() ? run() : onMain(run);
}
export function unbindLocalService(key: string): Promise<void> {
  const run = async () => {
    const connection = localConnections.get(key);
    if (!connection) return;
    localConnections.delete(key);
    const { service, binding } = connection;
    if (binding.clients.delete(key)) service.clientCount--;
    if (!binding.clients.size) binding.rebind = !!await vcallOn(mainThread, service.instance, "onUnbind", "(Landroid/content/Intent;)Z", binding.intent);
    if (!service.started && !service.clientCount) {
      runningServices.delete(service.cls);
      await destroyService(service);
    }
  };
  return inMainJob() ? run() : onMain(run);
}
type Connection = { key: string; owner: PackageRecord; process: string; remote: boolean;
  cancelDeath: (() => void) | null; pendingService: string | null; connect: () => void };
const connections = new Map<unknown, Connection>();
const failedConnections = new Set<unknown>();
const pendingConnections = new Map<string, Set<Connection>>();
function activatePending(service: string): void {
  const pending = pendingConnections.get(service);
  if (!pending) return;
  pendingConnections.delete(service);
  for (const connection of pending) { connection.pendingService = null; connection.connect(); }
}
let nextConnection = 1;
/** ServiceConnection callbacks run on the caller's main queue, or on the Executor the API 29 overload names. */
function connectionDelivery(executor: unknown): (job: () => Promise<void>) => Promise<void> {
  if (!executor) return onMain;
  return job => {
    return vcall(executor, "execute", "(Ljava/lang/Runnable;)V", fnRunnable(job));
  };
}
export async function svcBind(ctx: JContext, intent: JIntent, connection: unknown, flags: number, executor: unknown = null): Promise<number> {
  const deliver = connectionDelivery(executor);
  const resolved = await resolveService(intent), owner = resolved?.owner;
  if (!resolved || !owner || (!exported(resolved) && owner.pkg !== ctx.$host.pkg)) {
    if (!connections.has(connection)) failedConnections.add(connection);
    return 0;
  }
  const permission = componentPermission(resolved), processName = componentProcess(resolved);
  if (permission && await checkPermission(permission, ctx.$host.pkg) !== 0)
    throw rt.mkThrowable("java/lang/SecurityException", "Service requires " + permission);
  if (connections.has(connection)) return 1;
  failedConnections.delete(connection);
  const key = PROCESS_PID + ":" + nextConnection++, remote = owner.pkg !== ctx.$host.pkg || processName !== (PROCESS_NAME || ctx.$host.pkg);
  const info = { name: resolved.name, processName };
  const bound: JIntent = await newObj("android/content/Intent", "(Landroid/content/Intent;)V", intent);
  const component = await mkComponentName(owner.pkg, info.name);
  await vcall(bound, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", component);
  const connect = () => {
    const ready = remote ? serviceTransport.bind(owner, info.processName, bound, key) : onMain(() => bindLocalService(ctx, bound, key));
    void ready.then(binder => {
      if (connections.get(connection) !== record) return;
      const handle = remote ? exportBinder(binder) : null;
      if (handle) record.cancelDeath = binderTransport.watch(handle.pid, () => {
        record.cancelDeath = null;
        void deliver(async () => {
          if (connections.get(connection) !== record) return;
          await vcall(connection, "onServiceDisconnected", "(Landroid/content/ComponentName;)V", component);
          if (connections.get(connection) === record && flags & 1) connect();
        }).catch(reportUncaught);
      });
      return deliver(async () => {
        if (connections.get(connection) !== record) return;
        if (binder) await vcall(connection, "onServiceConnected", "(Landroid/content/ComponentName;Landroid/os/IBinder;)V", component, binder);
        else await vcall(connection, "onNullBinding", "(Landroid/content/ComponentName;)V", component);
      });
    }).catch(error => {
      if (connections.get(connection) !== record) return;
      void deliver(() => vcall(connection, "onBindingDied", "(Landroid/content/ComponentName;)V", component)).catch(reportUncaught);
      reportUncaught(error);
    });
  };
  const record: Connection = { key, owner, process: info.processName, remote, cancelDeath: null, pendingService: null, connect };
  connections.set(connection, record);
  if (!(flags & 1) && !runningServices.has(info.name)) {
    const service = owner.pkg + "/" + info.name;
    record.pendingService = service;
    let pending = pendingConnections.get(service);
    if (!pending) pendingConnections.set(service, pending = new Set());
    pending.add(record);
  } else connect();
  return 1;
}
export function svcUnbind(connection: unknown): void {
  if (failedConnections.delete(connection)) return;
  const record = connections.get(connection);
  if (!record) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Service not registered");
  connections.delete(connection); record.cancelDeath?.();
  if (record.pendingService) {
    const pending = pendingConnections.get(record.pendingService);
    pending?.delete(record);
    if (!pending?.size) pendingConnections.delete(record.pendingService);
    return;
  }
  void (record.remote ? serviceTransport.unbind(record.owner, record.process, record.key) : onMain(() => unbindLocalService(record.key))).catch(reportUncaught);
}
/** Service.startForeground (id) and stopForeground (its STOP_FOREGROUND_* flags), as ActiveServices
 *  handles the service's notification */
export async function svcFg(svc: unknown, fg: boolean, id = 0, notification: JObj | null = null, stopFlags = 0): Promise<void> {
  const si = runningServices.get(jclsNameOf(svc));
  if (si) { si.foreground = fg ? 1 : 0; si.flags = fg ? si.flags | 2 : si.flags & ~2; }
  if (fg) {
    if (si) si.foregroundId = id;
    await startForegroundNotification(id, notification);
  } else if (si?.foregroundId) {
    const posted = si.foregroundId;
    if (stopFlags & (STOP_FOREGROUND_REMOVE | STOP_FOREGROUND_DETACH)) si.foregroundId = 0;
    await stopForegroundNotification(posted, (stopFlags & STOP_FOREGROUND_REMOVE) !== 0);
  }
}
const STOP_FOREGROUND_REMOVE = 1, STOP_FOREGROUND_DETACH = 2;
/** a service the platform binds for itself (JobScheduler, the geocode provider): no caller permission applies */
export async function bindAsSystem(component: JComponentName, key: string, action: string | null = null): Promise<{ binder: JObj; unbind: () => Promise<void> }> {
  const parts = (await componentParts(component))!;
  const owner = packages.get(parts.pkg), cls = qualifyComponent(parts.cls, parts.pkg);
  const node = owner?.components.service.get(cls), ctx = appHost?.application;
  if (!owner || !node || !ctx) throw rt.mkThrowable("java/lang/IllegalArgumentException", "No such service ComponentInfo{" + parts.pkg + "/" + cls + "}");
  const intent = await newIntent(action);
  await vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", await mkComponentName(owner.pkg, cls));
  const process = owner.process(node);
  if (owner.pkg === ctx.$host.pkg && process === (PROCESS_NAME || owner.pkg)) return { binder: await bindLocalService(ctx, intent, key) as JObj, unbind: () => unbindLocalService(key) };
  return { binder: await serviceTransport.bind(owner, process, intent, key) as JObj, unbind: () => serviceTransport.unbind(owner, process, key) };
}
