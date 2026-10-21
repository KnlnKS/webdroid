import { webStorageTransport } from "../android/webstorage.ts";
// A process realm's side of the broker: the transports its system services reach other processes
// and the broker's stores through, and the endpoint the broker's requests to it land on.
import { remoteProcessLife } from "./process-life.ts";
import { usePathOwner } from "./file-path.ts";
import { descriptorTransport } from "../native/process-fd.ts";
import { useAccountStore } from "../android/accounts.ts";
import { executePendingIntent, pendingTransport } from "../android/pendingintent.ts";
import { useAlarmScheduler } from "../android/alarm.ts";
import { encodeIntent, decodeIntent } from "../android/intentipc.ts";
import { SYSTEM_SERVICES, useSystemServiceAccess, binderTransport, receiveTransaction, exportBinder, importBinder, parcelled, unparcelled, type BinderHandle } from "../android/binder.ts";
import { PROCESS_PID, processTransport } from "../android/os.ts";
import { exitProcess, onProcessExit } from "../process-exit.ts";
import { deathOf, lastExit, noteAppKill, exitRecordTransport } from "../android/server/appexitinfo.ts";
import { after } from "../jvm/natives/jentry.ts";
import { systemProviderTransport } from "../android/systemproviders.ts";
import { logUncaught, detached } from "../jvm/natives/jthrowable.ts";
import { hostedServices, remoteServiceConnected, serviceTransport } from "../android/server/activeservices.ts";
import { vfs } from "./vfs.ts";
import { broadcastTransport, deliverBroadcast as deliverQueued, type BroadcastResult } from "../android/server/broadcastqueue.ts";
import { activityTransport, startActivityInProcess, taskVisibility, type ResultDelivery } from "../android/server/atm.ts";
import { publishedProvider, providerProcesses } from "../android/server/am.ts";
import { usePermissionStore, usePermissionAccess } from "../android/permissions.ts";
import { sqliteTransport } from "../android/sqlite.ts";
import { usePreferenceStore, usePreferenceAccess } from "../android/sharedprefs.ts";
import { useNotificationStore, notificationTransport } from "../android/notification.ts";
import { useSettingsStore, useSettingsAccess } from "../android/settings.ts";
import { awaited, rt, driven, type Gen } from "../jvm/runtime.ts";
import { cookieTransport, cookiesChanged } from "../android/cookies.ts";
import { useGeolocation } from "../android/locationmanager.ts";
import { useFocusedUid } from "../android/clipboard.ts";
import { useHostUi } from "./host-ui.ts";
import { packageDataTransport } from "../android/appdata.ts";
import { storageChanged } from "./device-storage.ts";
import { asBroker, brokerMethods, forgetRemoved, receivers, type BroadcastData, type BrokerCalls, type ProcessEndpoint } from "./broker-contract.ts";
import type { ProcessBroker } from "./processes.ts";
import type { ServiceRequest } from "./servicerecords.ts";
import { callProxy, closePort, processError, processFailure } from "./process-port.ts";
import { note, Ev } from "../timeline.ts";

let calls: ReturnType<typeof callProxy<BrokerCalls>> | undefined;
const brokerCalls = (): BrokerCalls => calls!.endpoint;
const life = remoteProcessLife(() => brokerCalls().process, logUncaught);
/** what both realms ask the broker for: other processes' services, providers, broadcasts, binders
 *  and lives, SQLite, cookies, WebView storage, PendingIntents, service starts and package data changes */
function connectCommandTransports(broker: BrokerCalls): void {
  const service = (pkg: string, process: string, request: ServiceRequest) => remote(broker.service(pkg, process, request));
  serviceTransport.bind = driven(function* (owner, process, cls, intent, key, flags) {
    yield service(owner.pkg, process, { kind: "bind", cls, intent: yield* awaited(encodeIntent(intent)), key, flags });
  });
  serviceTransport.unbind = async (owner, process, key) => { await service(owner.pkg, process, { kind: "unbind", key }); };
  serviceTransport.start = driven(function* (owner, process, intent, foreground) { yield service(owner.pkg, process, { kind: "start", intent: yield* awaited(encodeIntent(intent)), foreground }); });
  serviceTransport.stop = driven(function* (owner, process, cls, intent) { yield service(owner.pkg, process, { kind: "stop", cls, intent: yield* awaited(encodeIntent(intent)) }); });
  serviceTransport.peek = driven(function* (owner, process, intent) {
    return yield* awaited(importBinder(yield* awaited(service(owner.pkg, process, { kind: "peek", intent: yield* awaited(encodeIntent(intent)) }))));
  });
  providerProcesses.get = (pkg, process, authority) => after(remote(broker.contentProvider(pkg, process, authority)), importBinder);
  broadcastTransport.send = driven(function* (intent, permissions, ordered, initial) {
    const data = yield* awaited(encodeIntent(intent)), targets = yield* receivers(intent), from = initial && (yield* awaited(resultData(initial)));
    return yield* awaited(broadcastResult(yield* awaited(remote(broker.broadcast(data, targets, permissions, ordered, from)))));
  });
  binderTransport.transact = request => remote(broker.transact(request));
  sqliteTransport.call = broker.sqlite;
  cookieTransport.calls = brokerCalls;
  webStorageTransport.calls = () => broker.webStorage;
  Object.assign(pendingTransport, broker.pending);
  serviceTransport.starts = () => broker.starts;
  serviceTransport.connected = (key, binder, dead) => broker.serviceConnected(key, exportBinder(binder), dead);
  packageDataTransport.change = broker.packageDataChange;
  processTransport.signal = life.signal;
  binderTransport.alive = life.alive;
  binderTransport.watch = life.watch;
}
/** the stores and system services a Worker reaches through the broker, which system_server's realm holds */
function connectRemoteStores(broker: BrokerCalls): void {
  useSystemServiceAccess(SYSTEM_SERVICES, broker.systemService);
  systemProviderTransport.lookup = broker.systemProvider;
  notificationTransport.foreground = broker.notificationForeground;
  useSettingsAccess(broker.settings);
  usePathOwner(broker);
  vfs.prepare = broker.files.filePrepare;
  useHostUi(() => broker.ui);
  usePreferenceAccess(broker.prefs);
  usePermissionAccess(broker.permissions);
  exitRecordTransport.records = broker.exitRecords;
  exitRecordTransport.publish = broker.processExited;
}
export function closeProcessBrokerPort(): void {
  calls?.close();
  life.close();
  activityResults.clear();
  // its presence routes system providers to system_server, which a closed port no longer reaches
  systemProviderTransport.lookup = undefined;
}
/** each launch's result delivery, by request */
const activityResults = new Map<number, ResultDelivery["deliver"]>();
function connectActivityCommands({ activity }: BrokerCalls): void {
  let nextRequest = 1;
  activityTransport.presentation = translucent => {
    detached(() => activity.presentation(translucent), logUncaught);
  };
  activityTransport.launch = async (pkg, process, component, intent, result) => {
    const request = nextRequest++;
    if (result) activityResults.set(request, result.deliver);
    try { await activity.launch(pkg, process, component, await encodeIntent(intent), request, result?.caller.cls ?? null); }
    catch (error) { activityResults.delete(request); throw error; }
  };
  activityTransport.finished = (id, code, data) => {
    setVisible(false);
    detached(() => after(data && encodeIntent(data), encoded => activity.finish(id, code, encoded)), logUncaught);
  };
}
/** this process's command port: the one transferred to a Worker, whose stores system_server's realm
 *  holds behind it, or the page's own */
export function attachProcessBrokerPort(port: MessagePort, remoteStores = true): BrokerCalls {
  if (calls) { closePort(port); throw new Error("Process command port already attached"); }
  calls = callProxy<BrokerCalls>(port, brokerMethods, ["processExited", "storageWrite"],
    error => error.javaClass ? rt.mkThrowable(error.javaClass, error.message) : processError(error));
  const broker = calls.endpoint;
  connectCommandTransports(broker);
  connectActivityCommands(broker);
  if (remoteStores) connectRemoteStores(broker);
  return broker;
}

const resultData = (result: BroadcastResult): BroadcastData | Promise<BroadcastData> =>
  after(result.extras && parcelled(result.extras), (extras) => ({ ...result, extras }));
const broadcastResult = (data: BroadcastData): BroadcastResult | Promise<BroadcastResult> =>
  after(data.extras && unparcelled("android/os/Bundle", data.extras), (extras) => ({ ...data, extras }));
/** whether this process's windows are on screen, which its display loop follows */
export const processPresentation = { visible: true };
function setVisible(visible: boolean): void { note(Ev.Visible, +visible); processPresentation.visible = visible; }
async function remote<T>(pending: Promise<T>): Promise<T> {
  try { return await pending; } catch (error) {
    const failure = processFailure(error);
    if (failure.javaClass) throw rt.mkThrowable(failure.javaClass, failure.message);
    throw error;
  }
}
/** system_server's realm: it asks the broker over its own command port as a Worker does, but holds
 *  the stores and its descriptors itself */
export function connectProcess(broker: ProcessBroker): ProcessEndpoint {
  onProcessExit((status) => broker.fail(PROCESS_PID, `Process has died: ${status.signal !== undefined ? "signal " + status.signal : "exit " + status.code}`, deathOf(lastExit)));
  attachProcessBrokerPort(broker.brokerPort(PROCESS_PID), false);
  broker.files.attach(PROCESS_PID, vfs);
  descriptorTransport.local = broker.descriptorRights(PROCESS_PID);
  useNotificationStore(broker.notifications);
  usePreferenceStore(broker.preferences);
  usePermissionStore(broker.permissions);
  useFocusedUid(() => broker.foregroundUid());
  useAlarmScheduler(broker.alarms);
  useGeolocation(broker.location);
  // system_server announces the stores' changes, and its watches of them end with it
  const stops = [useAccountStore(broker.accounts), useSettingsStore(broker.settings)];
  if (broker.alive(PROCESS_PID)) for (const stop of stops) broker.watch(PROCESS_PID, stop);
  return createProcessEndpoint();
}

/** JVM callbacks are local to this realm; constructing the endpoint needs no live broker. */
export function createProcessEndpoint(): ProcessEndpoint {
  return {
    processDied: async token => life.died(token),
    cookiesChanged: async () => cookiesChanged(),
    storageChanged: async (key, value) => storageChanged(key, value),
    packageRemoved: async pkg => forgetRemoved(pkg),
    kill: (signal, note) => { if (note) noteAppKill(note); exitProcess({ signal }); },
    activity: async (request) => {
      if (request.kind === "back") return (await import("./device.ts")).pressBack();
      if (request.kind === "rotate") return (await import("./device.ts")).rotateDevice(request.landscape);
      return asBroker(function* (): Gen<void> {
        if (request.kind === "visibility") {
          yield taskVisibility(request.phase);
          if (request.phase !== "pause") setVisible(request.phase !== "stop");
        } else if (request.kind === "launch") {
          yield startActivityInProcess(request.component, yield* awaited(decodeIntent(request.intent)), request.id, request.caller);
          setVisible(true);
        } else {
          const deliver = activityResults.get(request.request);
          activityResults.delete(request.request);
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
