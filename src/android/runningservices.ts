import { JObj, rt } from "../jvm/runtime";
import { type JComponentName, type JIntent, mkComponentName } from "./intent";
import { type JContext, JContextWrapper } from "./context";
import { appHost, jclsNameOf } from "./apphost";
import { newObj, vcall } from "../jvm/natives/jlang";
import { onMain, inMainJob } from "./mainloop";
import { reportUncaught, PROCESS_PID, PROCESS_UID, PROCESS_NAME, JFnRunnable } from "./os";
import { packages, qualifyComponent, type PackageRecord } from "./packages";
import { getPM } from "./pm";
import { binderTransport, exportBinder } from "./binder";

class JRunningServiceInfo extends JObj {
  service: JComponentName | null = null;
  pid = PROCESS_PID; uid = PROCESS_UID; process = ""; foreground = 0; started = 0; flags = 0;
  activeSince = 0n; lastActivityTime = 0n; restarting = 0n;
  activeCount = 0; clientCount = 0; crashCount = 0;
  instance: JContextWrapper | null = null;
  startId = 0;
  bindings = new Map<string, { intent: JIntent; binder: unknown; clients: Set<string>; rebind: boolean }>();
}
export const serviceTransport: {
  bind: (owner: PackageRecord, process: string, intent: JIntent, key: string) => Promise<unknown>;
  unbind: (owner: PackageRecord, process: string, key: string) => Promise<void>;
  start: (owner: PackageRecord, process: string, intent: JIntent, foreground: boolean) => Promise<void>;
} = {
  bind: async () => { throw rt.mkThrowable("android/os/RemoteException", "Process transport unavailable"); },
  unbind: async () => {},
  start: async () => { throw rt.mkThrowable("android/os/RemoteException", "Process transport unavailable"); },
};
rt.register({
  name: "android/app/ActivityManager$RunningServiceInfo", ctor: JRunningServiceInfo, ifaces: ["android/os/Parcelable"],
  statics: { FLAG_STARTED: 1, FLAG_FOREGROUND: 2, FLAG_SYSTEM_PROCESS: 4, FLAG_PERSISTENT_PROCESS: 8 },
  fields: ["service", "pid", "uid", "process", "foreground", "started", "flags", "activeSince", "lastActivityTime",
    "restarting", "activeCount", "clientCount", "crashCount"],
  methods: { "<init>()V": function () {} },
});

/** started-and-not-stopped services, keyed by dotted class name (matches Class.getName()) */
export const runningServices = new Map<string, JRunningServiceInfo>();
function serviceRecord(ctx: JContext, cls: string): JRunningServiceInfo {
  let si = runningServices.get(cls);
  if (!si) {
    const pkg = ctx.$host?.pkg ?? appHost?.pkg ?? "";
    si = rt.make("android/app/ActivityManager$RunningServiceInfo") as JRunningServiceInfo;
    si.service = mkComponentName(pkg, cls); si.process = PROCESS_NAME || pkg;
    si.activeSince = BigInt(Date.now()); runningServices.set(cls, si);
  }
  return si;
}
async function createService(service: JRunningServiceInfo, ctx: JContext): Promise<JContextWrapper> {
  if (!service.instance) {
    const instance: unknown = await newObj(service.service!.cls.replace(/\./g, "/"));
    if (!(instance instanceof JContextWrapper) || !rt.iof(instance, "android/app/Service")) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Not a service: " + service.service!.cls);
    service.instance = instance;
    await vcall(instance, "attachBaseContext", "(Landroid/content/Context;)V", ctx.$host?.application ?? ctx);
    await vcall(instance, "onCreate", "()V");
  }
  return service.instance;
}
export async function acquireJobService(component: JComponentName): Promise<JContextWrapper> {
  const owner = packages.get(component.pkg), cls = qualifyComponent(component.cls, component.pkg);
  const node = owner?.components.service.get(cls), ctx = appHost?.application;
  if (!owner || !node || !ctx || owner.pkg !== ctx.$host.pkg || owner.process(node) !== (PROCESS_NAME || owner.pkg))
    throw rt.mkThrowable("java/lang/IllegalArgumentException", "Job service unavailable: " + component.cls);
  const record = serviceRecord(ctx, cls);
  record.clientCount++;
  try { return await (inMainJob() ? createService(record, ctx) : onMain(() => createService(record, ctx))); }
  catch (error) { record.clientCount--; throw error; }
}
export async function releaseJobService(instance: JContextWrapper): Promise<void> {
  const cls = jclsNameOf(instance), record = runningServices.get(cls);
  if (!record) return;
  record.clientCount = Math.max(0, record.clientCount - 1);
  if (!record.clientCount && !record.started) {
    runningServices.delete(cls);
    await (inMainJob() ? vcall(instance, "onDestroy", "()V") : onMain(() => vcall(instance, "onDestroy", "()V")));
  }
}
export function svcStart(ctx: JContext, intent: JIntent | null, _fg: boolean): JComponentName | null {
  const cls = intent?.component;
  if (!cls) return null;
  const owner = packages.get(intent.componentPkg ?? intent.pkg ?? ctx.$host?.pkg ?? "");
  const node = owner?.components.service.get(qualifyComponent(cls, owner.pkg));
  if (owner && node && (owner.pkg !== ctx.$host?.pkg || owner.process(node) !== (PROCESS_NAME || ctx.$host?.pkg))) {
    void serviceTransport.start(owner, owner.process(node), intent, _fg)
      .then(() => activatePending(owner.pkg + "/" + qualifyComponent(cls, owner.pkg))).catch(reportUncaught);
    return mkComponentName(owner.pkg, qualifyComponent(cls, owner.pkg));
  }
  const si = serviceRecord(ctx, cls);
  si.started = 1; si.flags |= 1;
  si.lastActivityTime = BigInt(Date.now());
  const service = si, startId = ++si.startId;
  void onMain(async () => {
    await vcall(await createService(service, ctx), "onStartCommand", "(Landroid/content/Intent;II)I", intent, 0, startId);
  }).catch((error) => {
    if (runningServices.get(cls) === service) runningServices.delete(cls);
    reportUncaught(error);
  });
  activatePending((owner?.pkg ?? ctx.$host?.pkg ?? "") + "/" + qualifyComponent(cls, owner?.pkg ?? ctx.$host?.pkg ?? ""));
  return si.service;
}
export function svcStop(cls: string | null | undefined, startId = -1): number {
  const service = cls ? runningServices.get(cls) : null;
  if (!service || (startId !== -1 && startId !== service.startId)) return 0;
  service.started = 0; service.flags &= ~1;
  if (service.clientCount) return 1;
  runningServices.delete(cls!);
  void onMain(async () => { if (service.instance) await vcall(service.instance, "onDestroy", "()V"); }).catch(reportUncaught);
  return 1;
}
const filterKey = (intent: JIntent) => JSON.stringify([intent.action, intent.dataUri, intent.typeStr, intent.identifier, intent.pkg, intent.component, [...intent.categories].sort()]);
const localConnections = new Map<string, { service: JRunningServiceInfo; filter: string }>();
export function bindLocalService(ctx: JContext, intent: JIntent, key: string): Promise<unknown> {
  const run = async () => {
    const service = serviceRecord(ctx, intent.component!), instance = await createService(service, ctx), filter = filterKey(intent);
    let binding = service.bindings.get(filter);
    if (!binding) {
      binding = { intent, binder: await vcall(instance, "onBind", "(Landroid/content/Intent;)Landroid/os/IBinder;", intent), clients: new Set(), rebind: false };
      service.bindings.set(filter, binding);
    } else if (!binding.clients.size && binding.rebind) {
      await vcall(instance, "onRebind", "(Landroid/content/Intent;)V", intent); binding.rebind = false;
    }
    if (!binding.clients.has(key)) { binding.clients.add(key); service.clientCount++; }
    localConnections.set(key, { service, filter });
    return binding.binder;
  };
  return inMainJob() ? run() : onMain(run);
}
export function unbindLocalService(key: string): Promise<void> {
  const run = async () => {
    const connection = localConnections.get(key);
    if (!connection) return;
    localConnections.delete(key);
    const { service, filter } = connection, binding = service.bindings.get(filter)!;
    if (binding.clients.delete(key)) service.clientCount--;
    if (!binding.clients.size) binding.rebind = !!await vcall(service.instance, "onUnbind", "(Landroid/content/Intent;)Z", binding.intent);
    if (!service.started && !service.clientCount) {
      runningServices.delete(service.service!.cls);
      await vcall(service.instance, "onDestroy", "()V");
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
    rt.link("webdroid/FnRunnable"); const runnable = new JFnRunnable(); runnable.fn = job;
    return vcall(executor, "execute", "(Ljava/lang/Runnable;)V", runnable);
  };
}
export async function svcBind(ctx: JContext, intent: JIntent, connection: unknown, flags: number, executor: unknown = null): Promise<number> {
  const deliver = connectionDelivery(executor);
  const resolved = await vcall(getPM(), "resolveService", "(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;", intent, 0);
  const info = resolved?.serviceInfo, owner = info && packages.get(info.packageName);
  if (!owner || (!info.exported && owner.pkg !== ctx.$host.pkg)) {
    if (!connections.has(connection)) failedConnections.add(connection);
    return 0;
  }
  if (info.permission && await vcall(getPM(), "checkPermission", "(Ljava/lang/String;Ljava/lang/String;)I", info.permission, ctx.$host.pkg) !== 0)
    throw rt.mkThrowable("java/lang/SecurityException", "Service requires " + info.permission);
  if (connections.has(connection)) return 1;
  failedConnections.delete(connection);
  const key = PROCESS_PID + ":" + nextConnection++, remote = owner.pkg !== ctx.$host.pkg || info.processName !== (PROCESS_NAME || ctx.$host.pkg);
  const bound: JIntent = await newObj("android/content/Intent", "(Landroid/content/Intent;)V", intent);
  bound.component = info.name; bound.componentPkg = owner.pkg;
  const connect = () => {
    const ready = remote ? serviceTransport.bind(owner, info.processName, bound, key) : onMain(() => bindLocalService(ctx, bound, key));
    void ready.then(binder => {
      if (connections.get(connection) !== record) return;
      const component = mkComponentName(owner.pkg, info.name), handle = remote ? exportBinder(binder) : null;
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
      void deliver(() => vcall(connection, "onBindingDied", "(Landroid/content/ComponentName;)V", mkComponentName(owner.pkg, info.name))).catch(reportUncaught);
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
export function svcFg(svc: unknown, fg: boolean) {
  const si = runningServices.get(jclsNameOf(svc));
  if (si) { si.foreground = fg ? 1 : 0; si.flags = fg ? si.flags | 2 : si.flags & ~2; }
}
