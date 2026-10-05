// A process realm's side of the broker: the transports its system services reach other processes
// and the broker's stores through, and the endpoint the broker's requests to it land on.
import { useAccountStore } from "../android/accounts";
import { executePendingIntent, pendingTransport } from "../android/pendingintent";
import { alarmTransport } from "../android/alarm";
import { encodeIntent, decodeIntent, intentCodec } from "../android/intentipc";
import { appHost } from "../android/apphost";
import { binderTransport, receiveTransaction, exportBinder, importBinder, parcelled, unparcelled, type BinderHandle } from "../android/binder";
import { PROCESS_PID, processTransport } from "../android/os";
import { exitProcess, onProcessExit } from "../process-exit";
import { deathOf, lastExit, noteAppKill } from "../android/server/appexitinfo";
import { after } from "../jvm/natives/jentry";
import { logUncaught, detached } from "../jvm/natives/jthrowable";
import { hostedServices, remoteServiceConnected, serviceTransport } from "../android/server/activeservices";
import type { ServiceRequest, ServiceStarts } from "./servicerecords";
import { vfs } from "./vfs";
import { broadcastTransport, deliverBroadcast as deliverQueued, type BroadcastResult } from "../android/server/broadcastqueue";
import { activityTransport, startActivityInProcess, taskVisibility, type ResultDelivery } from "../android/server/atm";
import { publishedProvider, providerProcesses } from "../android/server/am";
import { usePermissionStore } from "../android/permissions";
import { sqliteTransport } from "../android/sqlite";
import { usePreferenceStore } from "../android/sharedprefs";
import { useNotificationStore } from "../android/notification";
import { useSettingsStore } from "../android/settings";
import { awaited, rt, driven, type Gen } from "../jvm/runtime";
import { useWebCookies } from "../android/cookies";
import { clipboardTransport, clipboardChanged } from "../android/clipboard";
import { locationTransport } from "../android/locationmanager";
import { asBroker, forgetRemoved, processBroker, receivers, type BroadcastData, type ProcessEndpoint, type BrokerCalls, brokerMethods } from "./processes";

import { callProxy, processError } from "./process-port";

let calls: ReturnType<typeof callProxy<BrokerCalls>> | undefined;
const brokerCalls = (): BrokerCalls => (calls ??= callProxy<BrokerCalls>(processBroker().brokerPort(PROCESS_PID), brokerMethods, [],
  error => error.javaClass ? rt.mkThrowable(error.javaClass, error.message) : processError(error))).endpoint;

const resultData = (result: BroadcastResult): BroadcastData | Promise<BroadcastData> =>
  after(result.extras && parcelled(result.extras), (extras) => ({ ...result, extras }));
const broadcastResult = (data: BroadcastData): BroadcastResult | Promise<BroadcastResult> =>
  after(data.extras && unparcelled("android/os/Bundle", data.extras), (extras) => ({ ...data, extras }));
/** whether this process's windows are on screen, which its display loop follows */
export const processPresentation = { visible: true, changed: (_visible: boolean) => {} };
function setVisible(visible: boolean): void { processPresentation.visible = visible; processPresentation.changed(visible); }
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
  onProcessExit((status) => broker.fail(PROCESS_PID, `Process has died: ${status.signal !== undefined ? "signal " + status.signal : "exit " + status.code}`, deathOf(lastExit)));
  processTransport.signal = (pid, signal) => broker.signal(PROCESS_PID, pid, signal);
  clipboardTransport.set = data => broker.setClipboard(PROCESS_PID, data);
  clipboardTransport.get = () => broker.getClipboard(PROCESS_PID);
  clipboardTransport.listen = active => broker.watchClipboard(PROCESS_PID, active);
  let nextRequest = 1;
  /** each launch's result delivery, by request */
  const requests = new Map<number, ResultDelivery["deliver"]>();
  activityTransport.presentation = translucent => broker.activities.presentation(PROCESS_PID, translucent);
  activityTransport.launch = async (pkg, process, component, intent, result) => {
    const request = nextRequest++;
    if (result) requests.set(request, result.deliver);
    void broker.activities.launch(PROCESS_PID, pkg, process, component, await encodeIntent(intent), request, result?.caller.cls ?? null);
  };
  activityTransport.finished = (id, code, data) => {
    setVisible(false);
    detached(() => after(data && encodeIntent(data), (encoded) => broker.activities.finish(PROCESS_PID, id, code, encoded)), logUncaught);
  };
  broker.files.attach(PROCESS_PID, vfs);
  sqliteTransport.call = request => brokerCalls().sqlite(request);
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
  providerProcesses.get = (pkg, process, authority) => after(remote(brokerCalls().contentProvider(pkg, process, authority)), importBinder);
  broadcastTransport.send = driven(function* (intent, permissions, ordered, initial) {
    const data = yield* awaited(encodeIntent(intent)), targets = yield* receivers(intent), from = initial && (yield* awaited(resultData(initial)));
    return yield* awaited(broadcastResult(yield* awaited(remote(brokerCalls().broadcast(data, targets, permissions, ordered, from)))));
  });
  binderTransport.transact = (request) => remote(brokerCalls().transact(request));
  binderTransport.alive = (pid) => pid === 0 || broker.alive(pid);
  binderTransport.watch = (pid, died) => pid === 0 ? () => {} : broker.watch(pid, died);
  pendingTransport.create = (pkg, kind, code, flags, intent, intents) => remote(broker.createPending(PROCESS_PID, pkg, kind, code, flags, intent, intents, intentCodec));
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
  const service = (pkg: string, process: string, request: ServiceRequest) => remote(brokerCalls().service(pkg, process, request));
  serviceTransport.bind = driven(function* (owner, process, cls, intent, key, flags) {
    yield service(owner.pkg, process, { kind: "bind", cls, intent: yield* awaited(encodeIntent(intent)), key, flags });
  });
  serviceTransport.unbind = async (owner, process, key) => { await service(owner.pkg, process, { kind: "unbind", key }); };
  serviceTransport.start = driven(function* (owner, process, intent, foreground) { yield service(owner.pkg, process, { kind: "start", intent: yield* awaited(encodeIntent(intent)), foreground }); });
  serviceTransport.stop = driven(function* (owner, process, cls, intent) { yield service(owner.pkg, process, { kind: "stop", cls, intent: yield* awaited(encodeIntent(intent)) }); });
  // a process's services run once it is registered, which the page's is only after its boot starts
  let starts: ServiceStarts | undefined;
  serviceTransport.starts = () => starts ??= broker.serviceStarts(PROCESS_PID);
  serviceTransport.connected = (key, binder, dead) => broker.serviceConnected(PROCESS_PID, key, exportBinder(binder), dead);
  serviceTransport.peek = driven(function* (owner, process, intent) {
    return yield* awaited(importBinder(yield* awaited(service(owner.pkg, process, { kind: "peek", intent: yield* awaited(encodeIntent(intent)) }))));
  });
  return {
    clipboardChanged: async () => clipboardChanged(),
    packageRemoved: async pkg => forgetRemoved(pkg),
    kill: (signal, note) => { if (note) noteAppKill(note); exitProcess({ signal }); },
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
      if (request.kind === "restart") { yield hostedServices.restart(request.intent, request.binds); return null; }
      const intent = yield* awaited(decodeIntent(request.intent));
      if (request.kind === "bind") { yield hostedServices.bind(intent, request.key, request.flags); return null; }
      if (request.kind === "peek") return exportBinder(yield* awaited(hostedServices.peek(intent)));
      yield hostedServices[request.kind](intent);
      return null;
    }()),
    serviceConnected: (key, binder, dead) => asBroker(function* (): Gen<void> { remoteServiceConnected(key, yield* awaited(importBinder(binder)), dead); }()),
  };
}
export function registerForegroundProcess(): void {
  if (!appHost) return;
  const broker = processBroker();
  broker.connect(appHost.pkg, appHost.pkg, PROCESS_PID);
  broker.activities.setForeground(PROCESS_PID);
  broker.ready(PROCESS_PID, connectProcess());
}
