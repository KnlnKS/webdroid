// The broker's side of a process's command port: the serialized operations a process may ask of
// system_server, each made as the process the port belongs to.
import { SYSTEM_SERVICES, asSystem, exportBinder, ownedSystemService } from "../android/binder.ts";
import { intentCodec } from "../android/intentipc.ts";
import { receiveForegroundNotification } from "../android/notification.ts";
import { PROCESS_PID } from "../android/os.ts";
import { ownedBy, packages } from "../android/packages.ts";
import { canonicalPermissionCommands, checkUidPermission, holdsPlatformPermission } from "../android/permissions.ts";
import { REASON_EXIT_SELF, deathOf, exitRecords, recordRemoteExit } from "../android/server/appexitinfo.ts";
import { canonicalPreferenceCommands, createAppData } from "../android/sharedprefs.ts";
import { createSQLiteSession } from "../android/sqlite.ts";
import { systemProviders } from "../android/systemproviders.ts";
import { canonicalWebStorage } from "../android/webstorage.ts";
import { rt } from "../jvm/runtime.ts";
import { cookieCalls } from "./cookie-access.ts";
import { storageAccess, storageWrite } from "./device-storage.ts";
import { canonicalFilePaths, isMutablePath, packageOfPath, sameUidOrSystem } from "./file-path.ts";
import { hostUi, hostUiMethods, type HostUi } from "./host-ui.ts";
import { serveCalls } from "./process-port.ts";
import { permissionDenied, unawaited, type BrokerCalls, type ProcessBroker } from "./processes.ts";

/** Process `pid`'s command port; every call fails once the process is dead. */
export function serveBrokerPort(broker: ProcessBroker, pid: number): { port: MessagePort; close(): void } {
  const caller = broker.entry(pid), { callers } = caller.session, { port1, port2 } = new MessageChannel();
  // root and system act for any uid, as checkComponentPermission grants them
  const privileged = caller.uid === 0 || caller.uid === 1000;
  const permissions = canonicalPermissionCommands(broker.permissions, pkg => {
    broker.entry(pid);
    if (privileged || ownedBy(pkg, caller.uid) || holdsPlatformPermission(caller.pkg, "android.permission.GRANT_RUNTIME_PERMISSIONS")) return;
    throw rt.mkThrowable("java/lang/SecurityException", "Permission grants belong to another UID");
  });
  const authorizePreference = (name: string, write: boolean) => {
    broker.entry(pid);
    const notification = name.startsWith("android:notification-policy:");
    const pkg = notification ? name.slice("android:notification-policy:".length) : name.split(":", 1)[0];
    const publicRead = notification || name === `${pkg}:__system_power`;
    if (privileged || ownedBy(pkg, caller.uid) || !write && publicRead) return;
    throw rt.mkThrowable("java/lang/SecurityException", "Preferences belong to another UID");
  };
  const webStorage = canonicalWebStorage(caller.pkg);
  const preferences = canonicalPreferenceCommands(broker.preferences, authorizePreference);
  const authorizePath = (path: string): number => {
    broker.entry(pid);
    const owner = packageOfPath(path);
    return owner?.private && !sameUidOrSystem(caller.uid, packages.get(owner.pkg)?.uid) ? 13 : 0;
  };
  const paths = canonicalFilePaths(authorizePath, caller.uid);
  const descriptors = broker.fileDescriptors.session(pid, path => isMutablePath(path) ? authorizePath(path) : 13, caller.uid);
  const starts = (cls: string) => {
    const owner = packages.get(caller.pkg), node = owner?.components.service.get(cls);
    if (!node || owner!.process(node) !== caller.process)
      throw rt.mkThrowable("java/lang/SecurityException", "Service start state belongs to another process");
    return broker.serviceStarts(pid);
  };
  const watches = new Map<number, () => void>();
  const ui = Object.fromEntries(hostUiMethods.map(name => [name, (...args: never[]) =>
    (hostUi()[name] as (...args: never[]) => unknown)(...args)])) as unknown as HostUi;
  const calls: BrokerCalls = {
    ...ui,
    processAlive: async target => target === 0 || broker.alive(target),
    processSignal: async (target, signal) => broker.signal(pid, target, signal),
    processWatch: async (target, token) => {
      watches.get(token)?.(); watches.delete(token);
      if (target === 0) return;
      watches.set(token, broker.watch(target, () => {
        watches.delete(token);
        if (broker.alive(pid)) unawaited(broker.request(broker.entry(pid), endpoint => endpoint.processDied(token)));
      }));
    },
    processUnwatch: async token => { watches.get(token)?.(); watches.delete(token); },
    serviceCreated: async (cls, intent) => starts(cls).created(cls, intent),
    serviceDestroyed: async cls => starts(cls).destroyed(cls),
    serviceStart: async (cls, intent) => starts(cls).start(cls, intent),
    serviceDeliver: async cls => starts(cls).deliver(cls),
    serviceRequested: async cls => starts(cls).requested(cls),
    serviceStop: async cls => starts(cls).stop(cls),
    serviceStopSelf: async (cls, id) => starts(cls).stopSelf(cls, id),
    serviceDone: async (cls, id, result) => starts(cls).done(cls, id, result),
    serviceForeground: async (cls, on) => starts(cls).foreground(cls, on),
    serviceConnected: async (key, binder, dead) => broker.serviceConnected(pid, key, binder, dead),
    // Intent.filterEquals and replaceExtras are Android framework operations on serialized
    // Intents; the canonical Java owner keeps extras parcelled instead of borrowing a VM.
    pendingCreate: (pkg, kind, code, flags, intent, intents) => broker.createPending(pid, pkg, kind, code, flags, intent, intents, intentCodec),
    pendingCancel: async id => broker.cancelPending(pid, id),
    pendingSend: async (id, fill) => broker.intents.send(id, fill),
    pendingOperation: async id => broker.takePending(pid, id),
    pendingKind: async id => broker.intents.get(id)?.kind ?? null,
    pendingFlags: async id => broker.intents.get(id)?.flags ?? 0,
    pendingCreator: async id => {
      const operation = broker.intents.get(id);
      return operation ? { pkg: operation.pkg, uid: operation.uid } : null;
    },
    systemService: async name => {
      if (!SYSTEM_SERVICES.includes(name)) throw rt.mkThrowable("java/lang/SecurityException", "Unsupported canonical service lookup");
      const handle = await asSystem(() => ownedSystemService(name));
      broker.entry(pid);
      return handle;
    },
    systemProvider: async authority => {
      const provider = systemProviders.get(authority);
      return provider?.systemRealm ? asSystem(async () => exportBinder(await provider.binder())) : null;
    },
    notificationForeground: async request => {
      const sender = { pid, uid: caller.uid };
      if (request.kind === "stop" || !request.data) return receiveForegroundNotification(caller.pkg, sender, request);
      // the rights the notification did not take go back whether or not it was posted
      await broker.withTransferred(pid, PROCESS_PID, request.data, async received => {
        try {
          broker.entry(pid);
          await receiveForegroundNotification(caller.pkg, sender, { ...request, data: received });
        } finally { await broker.discardDescriptors(PROCESS_PID, received, false); }
      }, true);
    },
    filePrepare: async pkg => {
      if (!ownedBy(pkg, caller.uid)) throw rt.mkThrowable("java/lang/SecurityException", "File preparation belongs to another UID");
      await broker.files.prepare(pkg);
      broker.entry(pid);
      await createAppData(pkg);
    },
    fileSetAttributes: async (path, change) => paths.fileSetAttributes(path, change),
    fileStat: async path => paths.fileStat(path), fileMkdir: async path => paths.fileMkdir(path),
    fileAccess: async (path, mode) => paths.fileAccess(path, mode), fileList: async path => paths.fileList(path),
    fileRename: async (from, to) => paths.fileRename(from, to), fileRemove: async (path, directory) => paths.fileRemove(path, directory),
    fileCreate: async path => paths.fileCreate(path), fileFifo: async path => paths.fileFifo(path),
    fileDescriptor: request => descriptors.fileDescriptor(request),
    webRenderer: async origin => webStorage.webRenderer(origin),
    webStorage: async (op, origin) => webStorage.webStorage(op, origin),
    preferenceRead: async (name, key) => preferences.preferenceRead(name, key),
    preferenceKeys: async name => preferences.preferenceKeys(name),
    preferenceChange: async (name, changes) => preferences.preferenceChange(name, changes),
    preferenceFiles: async pkg => { authorizePreference(pkg + ":", false); return preferences.preferenceFiles(pkg); },
    permissionCheck: async (pkg, names) => permissions.permissionCheck(pkg, names),
    permissionGrant: async (pkg, names) => permissions.permissionGrant(pkg, names),
    ...cookieCalls(() => broker.cookies(caller.pkg), () => { broker.entry(pid); }, () => {
      if (!broker.alive(pid)) return false;
      unawaited(broker.request(broker.entry(pid), endpoint => endpoint.cookiesChanged()));
      return true;
    }),
    exitRecords: async pkg => {
      if (!ownedBy(pkg, caller.uid) && await permissionDenied("android.permission.DUMP", caller.pkg))
        throw rt.mkThrowable("java/lang/SecurityException", "Exit records belong to another UID");
      broker.entry(pid);
      return exitRecords(pkg);
    },
    packageDataChange: async (pkg, change, broadcasts, prompt) => {
      const own = change.kind === "clear" && change.fromApp && pkg === caller.pkg;
      const permission = change.kind === "clear" ? "android.permission.CLEAR_APP_USER_DATA" : "android.permission.DELETE_PACKAGES";
      if (!own && !prompt && await checkUidPermission(permission, caller.uid) !== 0)
        throw rt.mkThrowable("java/lang/SecurityException", `uid ${caller.uid} does not hold ${permission}`);
      return broker.changePackageData(pkg, change, broadcasts, prompt);
    },
    storageWrite: (key, value) => {
      if (storageWrite(caller, key, value)) for (const other of broker.processes())
        if (other !== caller && !other.dead && storageAccess(key, other)) unawaited(broker.request(other, endpoint => endpoint.storageChanged(key, value)));
    },
    processExited: record => {
      const canonical = recordRemoteExit({ ...record, pid, uid: caller.uid, pkg: caller.pkg, process: caller.process });
      broker.fail(pid, `Process has died: ${canonical.reason === REASON_EXIT_SELF ? "exit " : "status "}${canonical.status}`, deathOf(canonical), canonical);
    },
    // Acknowledgment means queued in ActivityStack; waiting for its lifecycle work here
    // would hold the launching main job while that same process is asked to pause.
    activityLaunch: async (pkg, process, component, intent, request, callingClass) => {
      unawaited(broker.activities.launch(pid, pkg, process, component, intent, request, callingClass));
    },
    activityFinish: async (id, code, data) => { unawaited(broker.activities.finish(pid, id, code, data)); },
    activityPresentation: async translucent => broker.activities.presentation(pid, translucent),
    displayOrientation: async landscape => broker.activities.orientation(pid, landscape),
    settingsGet: async (table, name) => { broker.watchSettings(pid); return broker.settings.get(table, name); },
    settingsEntries: async table => { broker.watchSettings(pid); return broker.settings.entries(table); },
    settingsPut: async (table, name, value) => { broker.watchSettings(pid); return broker.settings.put(table, name, value); },
    settingsSsaid: async () => { broker.watchSettings(pid); return broker.settings.ssaidKey(); },
    sqlite: request => (caller.session.sqlite ??= createSQLiteSession()).call(request),
    transact: request => broker.transact(pid, request),
    service: (pkg, process, request) => broker.service(pid, pkg, process, request),
    contentProvider: (pkg, process, authority) => broker.contentProvider(pid, pkg, process, authority),
    broadcast: (data, manifest, permissions, ordered, initial) => broker.broadcast(pid, data, manifest, permissions, ordered, initial),
  };
  const live = Object.fromEntries(Object.entries(calls).map(([name, call]) => [name, (...args: never[]) => {
    broker.entry(pid);
    return (call as (...args: never[]) => unknown)(...args);
  }])) as BrokerCalls;
  const stop = serveCalls(port1, live, () => { for (const cancel of watches.values()) cancel(); watches.clear(); callers.delete(stop); }, {
    // a reply its caller never receives gives back the descriptor rights it carried
    transact: reply => broker.discardDescriptors(pid, reply.data, false),
  });
  callers.add(stop);
  return { port: port2, close: stop };
}
