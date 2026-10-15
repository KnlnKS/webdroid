import { webStorageTransport } from "../android/webstorage";
// A process realm's side of the broker: the transports its system services reach other processes
// and the broker's stores through, and the endpoint the broker's requests to it land on.
import { remoteLocation } from "./location-access";
import { remoteProcessLife } from "./process-life";
import { filePathTransport } from "./file-path";
import { descriptorTransport } from "../native/process-fd";
import { useAccountStore, useAccountAccess, accountsChanged } from "../android/accounts";
import { executePendingIntent, pendingTransport } from "../android/pendingintent";
import { alarmTransport } from "../android/alarm";
import { encodeIntent, decodeIntent, intentCodec } from "../android/intentipc";
import { useSystemServiceAccess, binderTransport, receiveTransaction, exportBinder, importBinder, parcelled, unparcelled, type BinderHandle, type ParcelData } from "../android/binder";
import { PROCESS_PID, processTransport } from "../android/os";
import { exitProcess, onProcessExit } from "../process-exit";
import { deathOf, lastExit, noteAppKill, exitRecordTransport } from "../android/server/appexitinfo";
import { after } from "../jvm/natives/jentry";
import { logUncaught, detached } from "../jvm/natives/jthrowable";
import { hostedServices, remoteServiceConnected, serviceTransport } from "../android/server/activeservices";
import type { ServiceRequest, ServiceStarts } from "./servicerecords";
import { vfs } from "./vfs";
import { broadcastTransport, deliverBroadcast as deliverQueued, type BroadcastResult } from "../android/server/broadcastqueue";
import { activityTransport, startActivityInProcess, taskVisibility, type ResultDelivery } from "../android/server/atm";
import { publishedProvider, providerProcesses } from "../android/server/am";
import { usePermissionStore, usePermissionAccess } from "../android/permissions";
import { sqliteTransport } from "../android/sqlite";
import { usePreferenceStore, usePreferenceAccess } from "../android/sharedprefs";
import { useNotificationStore, notificationTransport } from "../android/notification";
import { useSettingsStore, useSettingsAccess, settingsChanged } from "../android/settings";
import { remoteSettings } from "./settings";
import { awaited, rt, driven, type Gen } from "../jvm/runtime";
import { cookieTransport, useWebCookies } from "../android/cookies";
import { clipboardTransport, clipboardChanged } from "../android/clipboard";
import { locationTransport } from "../android/locationmanager";
import { useHostUi } from "./host-ui";
import { packageDataTransport } from "../android/appdata";
import { storageChanged } from "./device-storage";
import { asBroker, forgetRemoved, processBroker, receivers, type BroadcastData, type ProcessEndpoint, type BrokerCalls, brokerMethods } from "./processes";

import { callProxy, processError, processFailure } from "./process-port";
import { note, Ev } from "../timeline";

let calls: ReturnType<typeof callProxy<BrokerCalls>> | undefined;
const commandProxy = (port: MessagePort) => callProxy<BrokerCalls>(port, brokerMethods, ["processExited", "storageWrite"],
  error => error.javaClass ? rt.mkThrowable(error.javaClass, error.message) : processError(error));
const brokerCalls = (): BrokerCalls => (calls ??= commandProxy(processBroker().brokerPort(PROCESS_PID))).endpoint;
const workerLocation = remoteLocation(brokerCalls);
const workerLife = remoteProcessLife(brokerCalls, logUncaught);
function connectCommandTransports(): void {
  const service = (pkg: string, process: string, request: ServiceRequest) => remote(brokerCalls().service(pkg, process, request));
  serviceTransport.bind = driven(function* (owner, process, cls, intent, key, flags) {
    yield service(owner.pkg, process, { kind: "bind", cls, intent: yield* awaited(encodeIntent(intent)), key, flags });
  });
  serviceTransport.unbind = async (owner, process, key) => { await service(owner.pkg, process, { kind: "unbind", key }); };
  serviceTransport.start = driven(function* (owner, process, intent, foreground) { yield service(owner.pkg, process, { kind: "start", intent: yield* awaited(encodeIntent(intent)), foreground }); });
  serviceTransport.stop = driven(function* (owner, process, cls, intent) { yield service(owner.pkg, process, { kind: "stop", cls, intent: yield* awaited(encodeIntent(intent)) }); });
  serviceTransport.peek = driven(function* (owner, process, intent) {
    return yield* awaited(importBinder(yield* awaited(service(owner.pkg, process, { kind: "peek", intent: yield* awaited(encodeIntent(intent)) }))));
  });
  providerProcesses.get = (pkg, process, authority) => after(remote(brokerCalls().contentProvider(pkg, process, authority)), importBinder);
  broadcastTransport.send = driven(function* (intent, permissions, ordered, initial) {
    const data = yield* awaited(encodeIntent(intent)), targets = yield* receivers(intent), from = initial && (yield* awaited(resultData(initial)));
    return yield* awaited(broadcastResult(yield* awaited(remote(brokerCalls().broadcast(data, targets, permissions, ordered, from)))));
  });
  binderTransport.transact = request => remote(brokerCalls().transact(request));
  descriptorTransport.importCalls = brokerCalls;
  sqliteTransport.call = request => brokerCalls().sqlite(request);
  clipboardTransport.set = data => brokerCalls().clipboardSet(data);
  clipboardTransport.get = () => brokerCalls().clipboardGet();
  clipboardTransport.has = () => brokerCalls().clipboardHas();
  clipboardTransport.listen = active => brokerCalls().clipboardListen(active);
}
/** the stores and system services a Worker reaches only through the broker */
function connectWorkerTransports(): void {
  Object.assign(locationTransport,workerLocation.access);
  pendingTransport.create = (pkg, kind, code, flags, intent, intents) => brokerCalls().pendingCreate(pkg, kind, code, flags, intent, intents);
  pendingTransport.cancel = id => brokerCalls().pendingCancel(id);
  pendingTransport.send = (id, fill) => brokerCalls().pendingSend(id, fill);
  pendingTransport.operation = id => brokerCalls().pendingOperation(id);
  pendingTransport.kind = id => brokerCalls().pendingKind(id);
  pendingTransport.flags = id => brokerCalls().pendingFlags(id);
  pendingTransport.creator = id => brokerCalls().pendingCreator(id);
  alarmTransport.schedule = (id, type, at, interval) => brokerCalls().alarmSchedule(id, type, at, interval);
  alarmTransport.cancel = id => brokerCalls().alarmCancel(id);
  const remoteStarts = {
    created: (cls: string, intent: ParcelData) => brokerCalls().serviceCreated(cls, intent),
    destroyed: (cls: string) => brokerCalls().serviceDestroyed(cls),
    start: (cls: string, intent: ParcelData) => brokerCalls().serviceStart(cls, intent),
    deliver: (cls: string) => brokerCalls().serviceDeliver(cls),
    requested: (cls: string) => brokerCalls().serviceRequested(cls),
    stop: (cls: string) => brokerCalls().serviceStop(cls),
    stopSelf: (cls: string, id: number) => brokerCalls().serviceStopSelf(cls, id),
    done: (cls: string, id: number, result: number) => brokerCalls().serviceDone(cls, id, result),
    foreground: (cls: string, on: boolean) => brokerCalls().serviceForeground(cls, on),
  };
  serviceTransport.starts = () => remoteStarts;
  serviceTransport.connected = (key, binder, dead) => brokerCalls().serviceConnected(key, exportBinder(binder), dead);
  webStorageTransport.calls = brokerCalls;
  useSystemServiceAccess(["notification","mount"], name => brokerCalls().systemService(name));
  notificationTransport.foreground = request => brokerCalls().notificationForeground(request);
  useSettingsAccess(remoteSettings(brokerCalls));
  processTransport.signal = workerLife.signal;
  binderTransport.alive = workerLife.alive;
  binderTransport.watch = workerLife.watch;
  filePathTransport.calls = brokerCalls;
  descriptorTransport.calls = brokerCalls;
  vfs.prepare = pkg => brokerCalls().filePrepare(pkg);
  useHostUi(brokerCalls);
  packageDataTransport.change = (pkg, how, broadcasts, prompt) => brokerCalls().packageDataChange(pkg, how, broadcasts, prompt);
  usePreferenceAccess({
    preferenceRead: (name, key) => brokerCalls().preferenceRead(name, key),
    preferenceKeys: name => brokerCalls().preferenceKeys(name),
    preferenceChange: (name, changes) => brokerCalls().preferenceChange(name, changes),
    preferenceFiles: pkg => brokerCalls().preferenceFiles(pkg),
  });
  usePermissionAccess({
    permissionCheck: (pkg, names) => brokerCalls().permissionCheck(pkg, names),
    permissionGrant: (pkg, names) => brokerCalls().permissionGrant(pkg, names),
  });
  useAccountAccess({
    accountList: query => brokerCalls().accountList(query),
    accountRead: key => brokerCalls().accountRead(key),
    accountExists: key => brokerCalls().accountExists(key),
    accountCached: (key, type) => brokerCalls().accountCached(key, type),
    accountChange: change => brokerCalls().accountChange(change),
  });
}
export function closeProcessBrokerPort(): void {
  calls?.close();
  workerLocation.close();
  workerLife.close();
  workerActivityResults.clear();
}
const workerActivityResults = new Map<number, ResultDelivery["deliver"]>();
function connectActivityCommands(): void {
  let nextRequest = 1;
  activityTransport.presentation = translucent => {
    detached(() => brokerCalls().activityPresentation(translucent), logUncaught);
  };
  activityTransport.launch = async (pkg, process, component, intent, result) => {
    const request = nextRequest++;
    if (result) workerActivityResults.set(request, result.deliver);
    try { await brokerCalls().activityLaunch(pkg, process, component, await encodeIntent(intent), request, result?.caller.cls ?? null); }
    catch (error) { workerActivityResults.delete(request); throw error; }
  };
  activityTransport.finished = (id, code, data) => {
    setVisible(false);
    detached(() => after(data && encodeIntent(data), encoded => brokerCalls().activityFinish(id, code, encoded)), logUncaught);
  };
}
/** Worker commands use the transferred channel, with no parent-window lookup. */
export function attachProcessBrokerPort(port: MessagePort): BrokerCalls {
  if (calls) { commandProxy(port).close(); throw new Error("Process command port already attached"); }
  calls = commandProxy(port);
  connectCommandTransports();
  connectWorkerTransports();
  connectActivityCommands();
  exitRecordTransport.records = pkg => brokerCalls().exitRecords(pkg);
  exitRecordTransport.publish = record => brokerCalls().processExited(record);
  return calls.endpoint;
}

const resultData = (result: BroadcastResult): BroadcastData | Promise<BroadcastData> =>
  after(result.extras && parcelled(result.extras), (extras) => ({ ...result, extras }));
const broadcastResult = (data: BroadcastData): BroadcastResult | Promise<BroadcastResult> =>
  after(data.extras && unparcelled("android/os/Bundle", data.extras), (extras) => ({ ...data, extras }));
/** whether this process's windows are on screen, which its display loop follows */
export const processPresentation = { visible: true, changed: (_visible: boolean) => {} };
function setVisible(visible: boolean): void { note(Ev.Visible, +visible); processPresentation.visible = visible; processPresentation.changed(visible); }
function remoteError(error: unknown): never {
  const failure = processFailure(error);
  if (failure.javaClass) throw rt.mkThrowable(failure.javaClass, failure.message);
  throw error;
}
async function remote<T>(pending: Promise<T>): Promise<T> {
  try { return await pending; } catch (error) { return remoteError(error); }
}
export function connectProcess(): ProcessEndpoint {
  const broker = processBroker();
  onProcessExit((status) => broker.fail(PROCESS_PID, `Process has died: ${status.signal !== undefined ? "signal " + status.signal : "exit " + status.code}`, deathOf(lastExit)));
  processTransport.signal = (pid, signal) => broker.signal(PROCESS_PID, pid, signal);
  connectCommandTransports();
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
  descriptorTransport.stageLocal = fd => broker.stageDescriptor(PROCESS_PID,fd);
  descriptorTransport.takeLocal = token => broker.takeDescriptor(PROCESS_PID,token);
  descriptorTransport.unstageLocal = token => broker.unstageDescriptor(PROCESS_PID,token);
  descriptorTransport.discardLocal = token => broker.discardDescriptor(PROCESS_PID,token);
  useSystemServiceAccess([]);
  notificationTransport.foreground = null;
  useNotificationStore(broker.notifications);
  usePreferenceStore(broker.preferences);
  usePermissionStore(broker.permissions);
  const stopAccounts = useAccountStore(broker.accounts);
  if (broker.alive(PROCESS_PID)) broker.watchAccounts(PROCESS_PID, stopAccounts);
  const stopSettings = useSettingsStore(broker.settings);
  if (broker.alive(PROCESS_PID)) broker.watch(PROCESS_PID, stopSettings);
  useWebCookies((pkg) => broker.cookies(pkg));
  cookieTransport.calls = brokerCalls;
  locationTransport.available = () => broker.location.available;
  locationTransport.enabled = () => broker.location.enabled;
  locationTransport.last = () => broker.location.last;
  locationTransport.subscribe = (id, high, active, receive) => broker.location.subscribe(PROCESS_PID, id, high, active, receive);
  locationTransport.remove = id => broker.location.remove(PROCESS_PID, id);
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
  // The root retains its synchronous owner; Workers use acknowledged commands.
  let starts: ServiceStarts | undefined;
  serviceTransport.starts = () => starts ??= broker.serviceStarts(PROCESS_PID);
  serviceTransport.connected = (key, binder, dead) => broker.serviceConnected(PROCESS_PID, key, exportBinder(binder), dead);
  return createProcessEndpoint(requests);
}

/** JVM callbacks are local to this realm; constructing the endpoint needs no live broker. */
export function createProcessEndpoint(requests = workerActivityResults): ProcessEndpoint {
  return {
    processDied: async token => workerLife.died(token),
    locationChanged: async (id,token,event) => workerLocation.changed(id,token,event),
    accountsChanged: async () => accountsChanged(),
    clipboardChanged: async () => clipboardChanged(),
    settingsChanged: async (table, name) => settingsChanged(table, name),
    storageChanged: async (key, value) => storageChanged(key, value),
    packageRemoved: async pkg => forgetRemoved(pkg),
    kill: (signal, note) => { if (note) noteAppKill(note); exitProcess({ signal }); },
    activity: async (request) => {
      if (request.kind === "back") return (await import("./device")).pressBack();
      if (request.kind === "rotate") return (await import("./device")).rotateDevice(request.landscape);
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
