import { type JObj, rt } from "../jvm/runtime";
import { type JComponentName, type JIntent, componentParts, mkComponentName, newIntent } from "./intent";
import { appHost } from "./apphost";
import { vcall } from "../jvm/natives/jlang";
import { PROCESS_NAME } from "./os";
import { packages, qualifyComponent, type PackageRecord } from "./packages";

const noTransport = async (): Promise<never> => { throw rt.mkThrowable("android/os/RemoteException", "Process transport unavailable"); };
/** the services of another process; `flags` are bindService's (BIND_AUTO_CREATE when omitted) */
export const serviceTransport: {
  bind: (owner: PackageRecord, process: string, intent: JIntent, key: string, flags?: number) => Promise<unknown>;
  unbind: (owner: PackageRecord, process: string, key: string) => Promise<void>;
  start: (owner: PackageRecord, process: string, intent: JIntent, foreground: boolean) => Promise<void>;
  stop: (owner: PackageRecord, process: string, intent: JIntent) => Promise<void>;
  peek: (owner: PackageRecord, process: string, intent: JIntent) => Promise<unknown>;
} = { bind: noTransport, unbind: async () => {}, start: noTransport, stop: noTransport, peek: noTransport };

/** a service the platform binds for itself (JobScheduler, the geocode provider): no caller permission applies */
export async function bindAsSystem(component: JComponentName, key: string, action: string | null = null): Promise<{ binder: JObj; unbind: () => Promise<void> }> {
  const parts = (await componentParts(component))!;
  const owner = packages.get(parts.pkg), cls = qualifyComponent(parts.cls, parts.pkg);
  const node = owner?.components.service.get(cls);
  if (!owner || !node || !appHost) throw rt.mkThrowable("java/lang/IllegalArgumentException", "No such service ComponentInfo{" + parts.pkg + "/" + cls + "}");
  const intent = await newIntent(action);
  await vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", await mkComponentName(owner.pkg, cls));
  const process = owner.process(node);
  if (owner.pkg === appHost.pkg && process === (PROCESS_NAME || owner.pkg)) {
    const { hostedServices } = await import("./server/activeservices");
    return { binder: (await hostedServices.bind(intent, key))!, unbind: async () => { await hostedServices.unbind(key); } };
  }
  return { binder: await serviceTransport.bind(owner, process, intent, key) as JObj, unbind: () => serviceTransport.unbind(owner, process, key) };
}
