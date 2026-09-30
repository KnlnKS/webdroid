// System services hosted behind binder, each the TS half of AOSP's generated AIDL Stub: AOSP's
// managers run from bytecode over them (ActivityManager, AppTask, LoudnessCodecController,
// ScreenRecordingCallbacks), and a raw transaction reaches the Stub's own onTransact, so an unknown
// code (Shizuku's Sui probe) gets the Stub's answer. A method not implemented here is reported as
// missing by its AIDL name.
import { JObj, rt, noops, stubs, declaredField, type NativeSpec } from "../jvm/runtime";
import { jarray, mangleMethod, mangleStaticField } from "../jvm/abi";
import { newObj, vcall, scall, linkInit } from "../jvm/natives/jlang";
import { newArrayList } from "../jvm/natives/jcoll";
import { device } from "../shell/config";
import { appHost, jclsNameOf } from "./apphost";
import { type JComponentName, mkComponentName } from "./intent";
import type { JActivity } from "./app";
import { PROCESS_NAME, PROCESS_PID, PROCESS_UID, reportUncaught } from "./os";
import { runningServices } from "./runningservices";
import { JConfigurationInfo, getPM } from "./pm";
import { deviceConfiguration } from "./resnative";
import { hostStub } from "./binder";
import { registerSystemActivity } from "./intent";
import { packages } from "./packages";
import { getPrefs } from "./sharedprefs";
import { isRuntimePermission, permissionGranted } from "./context";
import { stickyBroadcasts } from "./broadcast";
import type { JIntent } from "./intent";
import { bundleBox } from "./os";

class JRunningAppProcessInfo extends JObj {
  processName = ""; pid = PROCESS_PID; uid = PROCESS_UID; pkgList: string[] = [];
  importance = 100; lru = 0; lastTrimLevel = 0;
  importanceReasonCode = 0; importanceReasonPid = 0;
  importanceReasonComponent: JComponentName | null = null;
}
rt.register({
  name: "android/app/ActivityManager$RunningAppProcessInfo", ctor: JRunningAppProcessInfo, ifaces: ["android/os/Parcelable"],
  statics: {
    IMPORTANCE_FOREGROUND: 100, IMPORTANCE_FOREGROUND_SERVICE: 125, IMPORTANCE_VISIBLE: 200,
    IMPORTANCE_PERCEPTIBLE: 230, IMPORTANCE_SERVICE: 300, IMPORTANCE_TOP_SLEEPING: 325,
    IMPORTANCE_CANT_SAVE_STATE: 350, IMPORTANCE_CACHED: 400, IMPORTANCE_BACKGROUND: 400,
    IMPORTANCE_EMPTY: 500, IMPORTANCE_GONE: 1000,
    REASON_UNKNOWN: 0, REASON_PROVIDER_IN_USE: 1, REASON_SERVICE_IN_USE: 2,
  },
  fields: ["processName", "pid", "uid", "pkgList", "importance", "lru", "lastTrimLevel", "importanceReasonCode",
    "importanceReasonPid", "importanceReasonComponent"],
  methods: { "<init>()V": function () {} },
});
function fillProc<T extends JRunningAppProcessInfo>(p: T): T {
  const pkg = appHost?.pkg ?? "";
  p.processName = PROCESS_NAME || pkg; p.pkgList = [pkg];
  p.importance = appHost?.currentActivity() ? 100 : runningServices.size ? 300 : 400;
  return p;
}

class JRecentTaskInfo extends JObj {
  id = -1; persistentId = -1; taskId = -1; numActivities = 0; isRunning = 0;
  baseIntent: unknown = null;
  baseActivity: JComponentName | null = null; topActivity: JComponentName | null = null;
  origActivity: JComponentName | null = null; description: string | null = null;
}
rt.register({
  name: "android/app/ActivityManager$RecentTaskInfo", ctor: JRecentTaskInfo, ifaces: ["android/os/Parcelable"],
  fields: ["id", "persistentId", "taskId", "numActivities", "isRunning", "baseIntent", "baseActivity", "topActivity",
    "origActivity", "description"],
  methods: { "<init>()V": function () {} },
});

// IActivityManager: this process's view of the activity manager
const activityManager: NativeSpec["methods"] = {
  "getRunningAppProcesses()Ljava/util/List;": () => newArrayList([fillProc(new JRunningAppProcessInfo())]),
  "getMyMemoryState(Landroid/app/ActivityManager$RunningAppProcessInfo;)V": (info: JRunningAppProcessInfo) => { fillProc(info); },
  // the device profile's memory: the page cannot read the host's
  "getMemoryInfo(Landroid/app/ActivityManager$MemoryInfo;)V": (mi: { totalMem: bigint; availMem: bigint; lowMemory: number; threshold: bigint }) => {
    mi.totalMem = 4n << 30n; mi.availMem = 2n << 30n; mi.lowMemory = 0; mi.threshold = 128n << 20n;
  },
  "getProcessMemoryInfo([I)[Landroid/os/Debug$MemoryInfo;": (pids: Int32Array) =>
    jarray(Array.from(pids, () => rt.make("android/os/Debug$MemoryInfo")), "Landroid/os/Debug$MemoryInfo;"),
  "getServices(II)Ljava/util/List;": (max: number) => newArrayList([...runningServices.values()].slice(0, max)),
  // no exits or starts are recorded, and nothing restricts this app or drives it as a monkey
  "getHistoricalProcessExitReasons(Ljava/lang/String;III)Landroid/content/pm/ParceledListSlice;": () =>
    newObj("android/content/pm/ParceledListSlice", "(Ljava/util/List;)V", newArrayList()),
  "getHistoricalProcessStartReasons(Ljava/lang/String;II)Landroid/content/pm/ParceledListSlice;": () =>
    newObj("android/content/pm/ParceledListSlice", "(Ljava/util/List;)V", newArrayList()),
  "isBackgroundRestricted(Ljava/lang/String;)Z": () => 0,
  "isUserAMonkey()Z": () => 0,
};
rt.register({ name: "webdroid/ActivityManagerService", ctor: class extends JObj {}, sup: "android/app/IActivityManager$Stub", methods: activityManager });

// IAppTask: one of the caller's tasks, the activities the shell stacks under a task id
class JAppTask extends JObj { taskId = 0; }
rt.register({ name: "webdroid/AppTask", ctor: JAppTask, sup: "android/app/IAppTask$Stub", methods: {
  "getTaskInfo()Landroid/app/ActivityManager$RecentTaskInfo;": function (this: JAppTask) {
    const activities = (appHost?.activities() ?? []).filter((a) => a.taskId === this.taskId);
    const info = new JRecentTaskInfo(), component = (a: JActivity | undefined) => a ? mkComponentName(appHost?.pkg ?? "", jclsNameOf(a)) : null;
    info.id = info.persistentId = info.taskId = this.taskId;
    info.numActivities = activities.length;
    info.isRunning = activities.length ? 1 : 0;
    info.baseIntent = activities[0]?.intent ?? null;
    info.baseActivity = component(activities[0]);
    info.topActivity = component(activities.at(-1));
    return info;
  },
  "finishAndRemoveTask()V": function (this: JAppTask) { appHost?.finishTask(this.taskId); },
  // one task is shown at a time, and there are no recents to exclude it from
  "moveToFront(Landroid/app/IApplicationThread;Ljava/lang/String;)V": () => {},
  "setExcludeFromRecents(Z)V": () => {},
} });
const appTasks = new Map<number, Promise<JAppTask>>();

// IActivityTaskManager
rt.register({ name: "webdroid/ActivityTaskManagerService", ctor: class extends JObj {}, sup: "android/app/IActivityTaskManager$Stub", methods: {
  "getAppTasks(Ljava/lang/String;)Ljava/util/List;": async () => {
    const ids = [...new Set((appHost?.activities() ?? []).map((a) => a.taskId))];
    for (const id of appTasks.keys()) if (!ids.includes(id)) appTasks.delete(id);
    return newArrayList(await Promise.all(ids.map((taskId) => {
      let task = appTasks.get(taskId);
      if (!task) appTasks.set(taskId, task = newObj("webdroid/AppTask").then((t: JAppTask) => Object.assign(t, { taskId })));
      return task;
    })));
  },
  "getDeviceConfigurationInfo()Landroid/content/pm/ConfigurationInfo;": () => {
    rt.link("android/content/pm/ConfigurationInfo");
    const info = new JConfigurationInfo(), config = deviceConfiguration();
    info.reqTouchScreen = config.touchscreen; info.reqKeyboardType = config.keyboard; info.reqNavigation = config.navigation;
    info.reqGlEsVersion = 0x30000; return info;
  },
} });

hostStub("activity", "webdroid/ActivityManagerService");
hostStub("activity_task", "webdroid/ActivityTaskManagerService");

// IAudioService: codec loudness only. A codec's loudness parameters are the reference AVD's for its
// output (the speaker): the target reference level, and the DRC setting for the metadata type.
rt.register({ name: "webdroid/AudioService", ctor: class extends JObj {}, sup: "android/media/IAudioService$Stub", methods: {
  "getLoudnessParams(Landroid/media/LoudnessCodecInfo;)Landroid/os/PersistableBundle;": async (info: Record<string, number>) => {
    const bundle = await newObj("android/os/PersistableBundle"), type = info[declaredField("android/media/LoudnessCodecInfo", "metadataType")];
    await vcall(bundle, "putInt", "(Ljava/lang/String;I)V", "aac-target-ref-level", 64);
    if (type === 1) await vcall(bundle, "putInt", "(Ljava/lang/String;I)V", "aac-drc-heavy-compression", 1);
    if (type === 2) await vcall(bundle, "putInt", "(Ljava/lang/String;I)V", "aac-drc-effect-type", 3);
    return bundle;
  },
  // the output never changes, so no updated parameters are ever dispatched
  ...noops("registerLoudnessCodecUpdatesDispatcher(Landroid/media/ILoudnessCodecUpdatesDispatcher;)V",
    "unregisterLoudnessCodecUpdatesDispatcher(Landroid/media/ILoudnessCodecUpdatesDispatcher;)V", "startLoudnessCodecUpdates(I)V",
    "stopLoudnessCodecUpdates(I)V", "addLoudnessCodecInfo(IILandroid/media/LoudnessCodecInfo;)V",
    "removeLoudnessCodecInfo(ILandroid/media/LoudnessCodecInfo;)V"),
} });

// IWindowManager: what WindowManagerGlobal and screen recording callbacks ask of it. Animations run
// at the default duration scale, and nothing records the page, so a registration reports "not
// recorded" and that never changes. The keyguard is never shown and has no secure lock, as on the
// reference AVD, so an exit succeeds at once; ITrustManager agrees.
rt.register({ name: "webdroid/WindowManagerService", ctor: class extends JObj {}, sup: "android/view/IWindowManager$Stub", methods: {
  "getCurrentAnimatorScale()F": () => 1,
  "registerScreenRecordingCallback(Landroid/window/IScreenRecordingCallback;)Z": () => 0,
  "unregisterScreenRecordingCallback(Landroid/window/IScreenRecordingCallback;)V": () => {},
  ...stubs(0, "isKeyguardLocked()Z", "isKeyguardSecure(I)Z"),
  ...noops("addKeyguardLockedStateListener(Lcom/android/internal/policy/IKeyguardLockedStateListener;)V",
    "removeKeyguardLockedStateListener(Lcom/android/internal/policy/IKeyguardLockedStateListener;)V"),
  "exitKeyguardSecurely(Landroid/view/IOnKeyguardExitResult;)V": (callback: unknown) =>
    vcall(callback, "onKeyguardExitResult", "(Z)V", 1),
} });
rt.register({ name: "webdroid/TrustManagerService", ctor: class extends JObj {}, sup: "android/app/trust/ITrustManager$Stub", methods: {
  ...stubs(0, "isDeviceLocked(II)Z", "isDeviceSecure(II)Z"),
} });
// INotificationManager: notifications are still NotificationManager's TS spec (notification.ts);
// the Stub is here for the managers that bind it at construction (KeyguardManager)
rt.register({ name: "webdroid/NotificationManagerService", ctor: class extends JObj {}, sup: "android/app/INotificationManager$Stub" });

hostStub("audio", "webdroid/AudioService");
hostStub("window", "webdroid/WindowManagerService");
hostStub("trust", "webdroid/TrustManagerService");
hostStub("notification", "webdroid/NotificationManagerService");

// IConnectivityManager: one Wi-Fi network (netId 100), the one the page reaches the internet
// through, up while the page is online. Its capabilities and link properties are the reference
// AVD's Wi-Fi network as an app sees it (no transport info, owner or admin uids); its DNS server is
// one any resolver can use, as port-53 datagrams are answered over DNS-over-HTTPS (shell/relay.ts).
// Callbacks reach ConnectivityManager's CallbackHandler as CALLBACK_* messages through the
// Messenger each request carries, as ConnectivityService sends them.
const NET_ID = 100, TYPE_WIFI = 1, TRANSPORT_WIFI = 1;
/** NET_CAPABILITY_*: NOT_METERED, INTERNET, NOT_RESTRICTED, TRUSTED, NOT_VPN, VALIDATED, NOT_ROAMING,
 *  FOREGROUND, NOT_CONGESTED, NOT_SUSPENDED, NOT_VCN_MANAGED, NOT_BANDWIDTH_CONSTRAINED */
const CAPABILITIES = [11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 28, 37];
export const netUp = (): boolean => typeof navigator === "undefined" || navigator.onLine !== false;
const NC = "android/net/NetworkCapabilities", NCB = "Landroid/net/NetworkCapabilities$Builder;";
const networkState = {
  network: null as Promise<JObj> | null,
  caps: null as Promise<JObj> | null,
  link: null as Promise<JObj> | null,
};
const theNetwork = () => networkState.network ??= newObj("android/net/Network", "(I)V", NET_ID);
const capabilities = () => networkState.caps ??= (async () => {
  let b = await newObj(`${NC}$Builder`);
  b = await vcall(b, "addTransportType", `(I)${NCB}`, TRANSPORT_WIFI);
  for (const c of CAPABILITIES) b = await vcall(b, "addCapability", `(I)${NCB}`, c);
  b = await vcall(b, "setLinkUpstreamBandwidthKbps", `(I)${NCB}`, 12000);
  b = await vcall(b, "setLinkDownstreamBandwidthKbps", `(I)${NCB}`, 30000);
  b = await vcall(b, "setSignalStrength", `(I)${NCB}`, -50);
  return vcall(b, "build", `()L${NC};`);
})();
const linkProperties = () => networkState.link ??= (async () => {
  const lp = await newObj("android/net/LinkProperties");
  await vcall(lp, "setInterfaceName", "(Ljava/lang/String;)V", "wlan0");
  const dns = await scall("java/net/InetAddress", "getByName", "(Ljava/lang/String;)Ljava/net/InetAddress;", "8.8.8.8");
  await vcall(lp, "addDnsServer", "(Ljava/net/InetAddress;)Z", dns);
  return lp;
})();
const isOurs = async (n: unknown) => n != null && await vcall(n, "equals", "(Ljava/lang/Object;)Z", await theNetwork()) === 1;
async function networkInfo(): Promise<JObj> {
  const info = await newObj("android/net/NetworkInfo", "(IILjava/lang/String;Ljava/lang/String;)V", TYPE_WIFI, 0, "WIFI", "");
  const connected = (await linkInit("android/net/NetworkInfo$DetailedState")).ctor[mangleStaticField(netUp() ? "CONNECTED" : "DISCONNECTED")];
  await vcall(info, "setDetailedState", "(Landroid/net/NetworkInfo$DetailedState;Ljava/lang/String;Ljava/lang/String;)V", connected, null, "");
  await vcall(info, "setIsAvailable", "(Z)V", 1);
  return info;
}
/** ConnectivityManager's CALLBACK_* message codes */
const callbackCode = async (name: string): Promise<number> => (await linkInit("android/net/ConnectivityManager")).ctor[mangleStaticField(name)];
type Registration = { request: JObj; messenger: JObj };
const registrations = new Map<JObj, Registration>();
let nextRequestId = 1;
/** ConnectivityService.callCallbackForRequest: the request, the network and what the code carries */
async function sendCallback(r: Registration, name: string): Promise<void> {
  const data = await newObj("android/os/Bundle"), put = (cls: string, value: unknown) =>
    vcall(data, "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", cls, value);
  await put("NetworkRequest", r.request);
  await put("Network", await theNetwork());
  if (name === "CALLBACK_AVAILABLE") {
    await put("NetworkCapabilities", await capabilities());
    await put("LinkProperties", await linkProperties());
  }
  const msg = await scall("android/os/Message", "obtain", "()Landroid/os/Message;");
  msg[declaredField("android/os/Message", "what")] = await callbackCode(name);
  await vcall(msg, "setData", "(Landroid/os/Bundle;)V", data);
  await vcall(r.messenger, "send", "(Landroid/os/Message;)V", msg);
}
/** a request's NetworkRequest, registered for callbacks; one the network satisfies hears of it */
async function register(caps: unknown, legacyType: number, messenger: JObj, type: number): Promise<JObj> {
  const types = (await linkInit("android/net/NetworkRequest$Type")).ctor[mangleMethod("values", "()[Landroid/net/NetworkRequest$Type;")]() as JObj[];
  const request: JObj = await newObj("android/net/NetworkRequest", "(Landroid/net/NetworkCapabilities;IILandroid/net/NetworkRequest$Type;)V",
    caps ?? await newObj(NC), legacyType, nextRequestId++, types[type]);
  const r = { request, messenger };
  registrations.set(request, r);
  if (netUp() && await vcall(caps ?? await capabilities(), "satisfiedByNetworkCapabilities", `(L${NC};)Z`, await capabilities()))
    await sendCallback(r, "CALLBACK_AVAILABLE");
  return request;
}
rt.register({ name: "webdroid/ConnectivityService", ctor: class extends JObj {}, sup: "android/net/IConnectivityManager$Stub", methods: {
  "getActiveNetwork()Landroid/net/Network;": () => netUp() ? theNetwork() : null,
  "getActiveNetworkForUid(IZ)Landroid/net/Network;": () => netUp() ? theNetwork() : null,
  "getAllNetworks()[Landroid/net/Network;": async () => jarray(netUp() ? [await theNetwork()] : [], "Landroid/net/Network;"),
  "getActiveNetworkInfo()Landroid/net/NetworkInfo;": networkInfo,
  "getActiveNetworkInfoForUid(IZ)Landroid/net/NetworkInfo;": networkInfo,
  // the one network's own type answers; this device has no other
  "getNetworkInfo(I)Landroid/net/NetworkInfo;": (type: number) => type === TYPE_WIFI ? networkInfo() : null,
  "getNetworkInfoForUid(Landroid/net/Network;IZ)Landroid/net/NetworkInfo;": async (n: unknown) => await isOurs(n) ? networkInfo() : null,
  "getNetworkCapabilities(Landroid/net/Network;Ljava/lang/String;Ljava/lang/String;)Landroid/net/NetworkCapabilities;": async (n: unknown) =>
    await isOurs(n) ? capabilities() : null,
  "getLinkProperties(Landroid/net/Network;)Landroid/net/LinkProperties;": async (n: unknown) => await isOurs(n) ? linkProperties() : null,
  "isActiveNetworkMetered()Z": () => 0,
  "isDefaultNetworkActive()Z": () => +netUp(),
  // RESTRICT_BACKGROUND_STATUS_DISABLED: data saver is off
  "getRestrictBackgroundStatusByCaller()I": () => 1,
  "getProxyForNetwork(Landroid/net/Network;)Landroid/net/ProxyInfo;": () => null,
  "requestNetwork(ILandroid/net/NetworkCapabilities;ILandroid/os/Messenger;ILandroid/os/IBinder;IILjava/lang/String;Ljava/lang/String;)Landroid/net/NetworkRequest;":
    (_uid: number, caps: unknown, type: number, messenger: JObj, _timeout: number, _binder: unknown, legacyType: number) => register(caps, legacyType, messenger, type),
  "listenForNetwork(Landroid/net/NetworkCapabilities;Landroid/os/Messenger;Landroid/os/IBinder;ILjava/lang/String;Ljava/lang/String;)Landroid/net/NetworkRequest;":
    async (caps: unknown, messenger: JObj) => register(caps, -1, messenger, 1),
  "releaseNetworkRequest(Landroid/net/NetworkRequest;)V": (request: JObj) => { registrations.delete(request); },
  // the network is already validated; revalidation is only a hint
  ...noops("reportNetworkConnectivity(Landroid/net/Network;Z)V",
    "registerNetworkActivityListener(Landroid/net/INetworkActivityListener;)V",
    "unregisterNetworkActivityListener(Landroid/net/INetworkActivityListener;)V"),
} });
if (typeof addEventListener !== "undefined") for (const event of ["online", "offline"])
  addEventListener(event, () => void (async () => {
    for (const r of registrations.values()) await sendCallback(r, event === "online" ? "CALLBACK_AVAILABLE" : "CALLBACK_LOST");
  })().catch(reportUncaught));

hostStub("connectivity", "webdroid/ConnectivityService");

// NetworkUtils (libframework-connectivity-jni): binding to the one network, which every socket
// already uses
rt.claimNativeLib("framework-connectivity-jni");
let boundNetwork = 0n;
rt.registerJnis("android/net/NetworkUtils", {
  "bindProcessToNetworkHandle(J)Z": (handle: bigint) => { boundNetwork = handle; return 1; },
  "getBoundNetworkHandleForProcess()J": () => boundNetwork,
  "bindProcessToNetworkForHostResolution(I)Z": () => 1,
  "bindSocketToNetworkHandle(Ljava/io/FileDescriptor;J)I": () => 0,
});

// IPowerManager: the screen is on and never dozes, battery saver is off, and wake locks are
// accepted, as nothing here sleeps. IThermalService: no thermal pressure (THERMAL_STATUS_NONE) and
// no headroom forecast (NaN, as on the reference AVD, which has no thermal HAL).
rt.register({ name: "webdroid/PowerManagerService", ctor: class extends JObj {}, sup: "android/os/IPowerManager$Stub", methods: {
  ...stubs(1, "isInteractive()Z", "isWakeLockLevelSupported(I)Z"),
  ...stubs(0, "isPowerSaveMode()Z", "isDeviceIdleMode()Z", "isLightDeviceIdleMode()Z", "isLowPowerStandbyEnabled()Z", "isLowPowerStandbySupported()Z"),
  "getPowerSaveState(I)Landroid/os/PowerSaveState;": async () =>
    vcall(await newObj("android/os/PowerSaveState$Builder"), "build", "()Landroid/os/PowerSaveState;"),
  ...noops("acquireWakeLock(Landroid/os/IBinder;ILjava/lang/String;Ljava/lang/String;Landroid/os/WorkSource;Ljava/lang/String;ILandroid/os/IWakeLockCallback;)V",
    "acquireWakeLockAsync(Landroid/os/IBinder;ILjava/lang/String;Ljava/lang/String;Landroid/os/WorkSource;Ljava/lang/String;)V",
    "releaseWakeLock(Landroid/os/IBinder;I)V", "releaseWakeLockAsync(Landroid/os/IBinder;I)V",
    "updateWakeLockWorkSource(Landroid/os/IBinder;Landroid/os/WorkSource;Ljava/lang/String;)V",
    "updateWakeLockUids(Landroid/os/IBinder;[I)V", "updateWakeLockUidsAsync(Landroid/os/IBinder;[I)V",
    "updateWakeLockCallback(Landroid/os/IBinder;Landroid/os/IWakeLockCallback;)V"),
} });
rt.register({ name: "webdroid/ThermalService", ctor: class extends JObj {}, sup: "android/os/IThermalService$Stub", methods: {
  "getCurrentThermalStatus()I": () => 0,
  "getThermalHeadroom(I)F": () => NaN,
  // ThermalManagerService reports the current status to a listener as it registers
  "registerThermalStatusListener(Landroid/os/IThermalStatusListener;)Z": async (listener: unknown) => {
    await vcall(listener, "onStatusChange", "(I)V", 0); return 1;
  },
  "unregisterThermalStatusListener(Landroid/os/IThermalStatusListener;)Z": () => 1,
} });
// IDeviceIdleController's power-save allowlist, which PowerManager.isIgnoringBatteryOptimizations
// reads. The system's "let this app run in the background?" dialog, answered by the grant policy runtime
// permissions follow (context.ts). AOSP's activity ignores an app that did not declare the
// permission to ask, which reads as the user declining.
const DOZE_EXEMPTION = "__system_power";
registerSystemActivity("android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", async (intent) => {
  const pkg = intent.dataUri?.startsWith("package:") ? intent.dataUri.slice(8) : null;
  if (!pkg || !packages.get(pkg)?.permissions.has("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS")) return null;
  const prefs = getPrefs(pkg, DOZE_EXEMPTION);
  prefs.map.set("exempt", 1); prefs.persist();
  return rt.make("android/content/Intent");
});
const exempt = (pkg: string) => +(getPrefs(pkg, DOZE_EXEMPTION).map.get("exempt") === 1);
rt.register({ name: "webdroid/DeviceIdleController", ctor: class extends JObj {}, sup: "android/os/IDeviceIdleController$Stub", methods: {
  "isPowerSaveWhitelistApp(Ljava/lang/String;)Z": exempt,
  "isPowerSaveWhitelistExceptIdleApp(Ljava/lang/String;)Z": exempt,
} });

// IAppOpsService, under AppOpsManager: an op's mode as AppOpsService derives it for this app. A
// runtime permission's op follows its grant (IGNORED until granted; the app in front evaluates a
// foreground grant as ALLOWED); any other op has its default mode, MODE_DEFAULT for special access
// (SYSTEM_ALERT_WINDOW, GET_USAGE_STATS) that callers then decide by the permission. A package the
// uid does not own reads as the op's default when checked and MODE_ERRORED when noted or started,
// as the reference AVD's services.jar answers. Mode changes are not reported to watchers.
const AOM = "android/app/AppOpsManager", MODE_ALLOWED = 0, MODE_IGNORED = 1, MODE_ERRORED = 2;
const owns = (uid: number, pkg: string | null) => pkg !== null && packages.get(pkg)?.uid === uid;
const defaultMode = (code: number): Promise<number> => scall(AOM, "opToDefaultMode", "(I)I", code);
async function opMode(code: number, pkg: string): Promise<number> {
  const op: number = await scall(AOM, "opToSwitch", "(I)I", code);
  const permission: string | null = await scall(AOM, "opToPermission", "(I)Ljava/lang/String;", op);
  if (permission !== null && isRuntimePermission(permission)) return permissionGranted(pkg, permission) ? MODE_ALLOWED : MODE_IGNORED;
  return defaultMode(op);
}
const checkOp = (code: number, uid: number, pkg: string | null) => owns(uid, pkg) ? opMode(code, pkg!) : defaultMode(code);
const noteOp = async (code: number, uid: number, pkg: string | null, tag: string | null) => newObj("android/app/SyncNotedAppOp",
  "(IILjava/lang/String;Ljava/lang/String;)V", owns(uid, pkg) ? await opMode(code, pkg!) : MODE_ERRORED, code, tag, pkg);
const sourceField = (state: JObj, name: string) => (state as unknown as Record<string, unknown>)[declaredField("android/content/AttributionSourceState", name)];
const noteFor = (code: number, state: JObj) =>
  noteOp(code, sourceField(state, "uid") as number, sourceField(state, "packageName") as string | null, sourceField(state, "attributionTag") as string | null);
/** a proxied op is noted for the proxy (an app is never a trusted proxy) and then the app it serves */
async function noteProxyOp(code: number, state: JObj) {
  const proxy: JObj = await noteFor(code, state), next = sourceField(state, "next") as JObj[] | null;
  return next?.length && await vcall(proxy, "getOpMode", "()I") === MODE_ALLOWED ? noteFor(code, next[0]) : proxy;
}
rt.register({ name: "webdroid/AppOpsService", ctor: class extends JObj {}, sup: "com/android/internal/app/IAppOpsService$Stub", methods: {
  "checkOperation(IILjava/lang/String;)I": checkOp,
  "checkOperationForDevice(IILjava/lang/String;I)I": checkOp,
  "checkOperationRaw(IILjava/lang/String;Ljava/lang/String;)I": checkOp,
  "checkOperationRawForDevice(IILjava/lang/String;Ljava/lang/String;I)I": checkOp,
  "checkAudioOperation(IIILjava/lang/String;)I": (code: number, _usage: number, uid: number, pkg: string | null) => checkOp(code, uid, pkg),
  "checkPackage(ILjava/lang/String;)I": (uid: number, pkg: string | null) => owns(uid, pkg) ? MODE_ALLOWED : MODE_ERRORED,
  "noteOperation(IILjava/lang/String;Ljava/lang/String;ZLjava/lang/String;Z)Landroid/app/SyncNotedAppOp;": noteOp,
  "noteOperationForDevice(IILjava/lang/String;Ljava/lang/String;IZLjava/lang/String;Z)Landroid/app/SyncNotedAppOp;": noteOp,
  "startOperation(Landroid/os/IBinder;IILjava/lang/String;Ljava/lang/String;ZZLjava/lang/String;ZII)Landroid/app/SyncNotedAppOp;":
    (_token: unknown, code: number, uid: number, pkg: string | null, tag: string | null) => noteOp(code, uid, pkg, tag),
  "startOperationForDevice(Landroid/os/IBinder;IILjava/lang/String;Ljava/lang/String;IZZLjava/lang/String;ZII)Landroid/app/SyncNotedAppOp;":
    (_token: unknown, code: number, uid: number, pkg: string | null, tag: string | null) => noteOp(code, uid, pkg, tag),
  "noteProxyOperationWithState(ILandroid/content/AttributionSourceState;ZLjava/lang/String;ZZ)Landroid/app/SyncNotedAppOp;": noteProxyOp,
  "startProxyOperationWithState(Landroid/os/IBinder;ILandroid/content/AttributionSourceState;ZZLjava/lang/String;ZZIII)Landroid/app/SyncNotedAppOp;":
    (_token: unknown, code: number, state: JObj) => noteProxyOp(code, state),
  "isOperationActive(IILjava/lang/String;)Z": () => 0,
  // an app's own notes are collected for ops a dangerous or appop permission guards
  "shouldCollectNotes(I)Z": async (code: number) => {
    if (await scall(AOM, "shouldForceCollectNoteForOp", "(I)Z", code)) return 1;
    const permission: string | null = await scall(AOM, "opToPermission", "(I)Ljava/lang/String;", code);
    if (permission === null) return 0;
    const info = await vcall(getPM(), "getPermissionInfo", "(Ljava/lang/String;I)Landroid/content/pm/PermissionInfo;", permission, 0);
    return +(await vcall(info, "getProtection", "()I") === 1 || (await vcall(info, "getProtectionFlags", "()I") & 0x40) !== 0);
  },
  ...noops("finishOperation(Landroid/os/IBinder;IILjava/lang/String;Ljava/lang/String;)V",
    "finishOperationForDevice(Landroid/os/IBinder;IILjava/lang/String;Ljava/lang/String;I)V",
    "finishProxyOperationWithState(Landroid/os/IBinder;ILandroid/content/AttributionSourceState;Z)V",
    "startWatchingModeWithFlags(ILjava/lang/String;ILcom/android/internal/app/IAppOpsCallback;)V",
    "stopWatchingMode(Lcom/android/internal/app/IAppOpsCallback;)V",
    "startWatchingActive([ILcom/android/internal/app/IAppOpsActiveCallback;)V",
    "stopWatchingActive(Lcom/android/internal/app/IAppOpsActiveCallback;)V",
    "startWatchingStarted([ILcom/android/internal/app/IAppOpsStartedCallback;)V",
    "stopWatchingStarted(Lcom/android/internal/app/IAppOpsStartedCallback;)V",
    "startWatchingNoted([ILcom/android/internal/app/IAppOpsNotedCallback;)V",
    "stopWatchingNoted(Lcom/android/internal/app/IAppOpsNotedCallback;)V",
    "startWatchingAsyncNoted(Ljava/lang/String;Lcom/android/internal/app/IAppOpsAsyncNotedCallback;)V",
    "stopWatchingAsyncNoted(Ljava/lang/String;Lcom/android/internal/app/IAppOpsAsyncNotedCallback;)V"),
  "extractAsyncOps(Ljava/lang/String;)Ljava/util/List;": () => newArrayList(),
} });
hostStub("appops", "webdroid/AppOpsService");

// IUsageStatsManager, under UsageStatsManager: the app in front is in the ACTIVE standby bucket and
// never inactive. Usage history needs PACKAGE_USAGE_STATS, which an app is never granted here, so
// queries answer null as UsageStatsService does for a caller without it (the manager returns empty).
rt.register({ name: "webdroid/UsageStatsService", ctor: class extends JObj {}, sup: "android/app/usage/IUsageStatsManager$Stub", methods: {
  "getAppStandbyBucket(Ljava/lang/String;Ljava/lang/String;I)I": () => 10,
  "isAppInactive(Ljava/lang/String;ILjava/lang/String;)Z": () => 0,
  ...stubs(null, "queryUsageStats(IJJLjava/lang/String;I)Landroid/content/pm/ParceledListSlice;",
    "queryConfigurationStats(IJJLjava/lang/String;)Landroid/content/pm/ParceledListSlice;",
    "queryEventStats(IJJLjava/lang/String;)Landroid/content/pm/ParceledListSlice;",
    "queryEvents(JJLjava/lang/String;)Landroid/app/usage/UsageEvents;",
    "queryEventsWithFilter(Landroid/app/usage/UsageEventsQuery;Ljava/lang/String;)Landroid/app/usage/UsageEvents;",
    "queryEventsForPackage(JJLjava/lang/String;)Landroid/app/usage/UsageEvents;"),
} });
hostStub("usagestats", "webdroid/UsageStatsService");

// No biometric sensor and no USB host or accessory: FingerprintManager has no service, as
// SystemServiceRegistry builds it without FEATURE_FINGERPRINT; IAuthService and IUsbManager answer
// as their system services do with no hardware behind them.
const BIOMETRIC_ERROR_NO_HARDWARE = 12;
rt.register({ name: "webdroid/AuthService", ctor: class extends JObj {}, sup: "android/hardware/biometrics/IAuthService$Stub", methods: {
  "canAuthenticate(Ljava/lang/String;II)I": () => BIOMETRIC_ERROR_NO_HARDWARE,
  "hasEnrolledBiometrics(ILjava/lang/String;)Z": () => 0,
  "getSensorProperties(Ljava/lang/String;)Ljava/util/List;": () => newArrayList(),
  "getAuthenticatorIds(I)[J": () => new BigInt64Array(0),
} });
rt.register({ name: "webdroid/UsbService", ctor: class extends JObj {}, sup: "android/hardware/usb/IUsbManager$Stub", methods: {
  ...noops("getDeviceList(Landroid/os/Bundle;)V"),
  "getCurrentAccessory()Landroid/hardware/usb/UsbAccessory;": () => null,
} });
hostStub("auth", "webdroid/AuthService");
hostStub("usb", "webdroid/UsbService");

// IBatteryStats and IBatteryPropertiesRegistrar, under BatteryManager: the configured battery's
// capacity and status; any other property is NAME_NOT_FOUND, as healthd answers one its HAL lacks
const BATTERY_CAPACITY = 4, BATTERY_STATUS = 6, NAME_NOT_FOUND = -2;
/** BATTERY_STATUS_CHARGING or FULL, which the reference AVD reports as plugged into AC */
const pluggedIn = () => device.battery.status === 2 || device.battery.status === 5;
/** BatteryService's low level: unplugged at or under config_lowBatteryWarningLevel (20) */
export const batteryLow = (): boolean => !pluggedIn() && device.battery.level <= 20;
// the extras BatteryService puts on BATTERY_CHANGED that the battery model determines
stickyBroadcasts.set("android.intent.action.BATTERY_CHANGED", () => {
  const intent: JIntent = rt.make("android/content/Intent");
  intent.action = "android.intent.action.BATTERY_CHANGED";
  intent.flags = 0x60000010;   // as recorded on the reference AVD: REGISTERED_ONLY, REPLACE_PENDING, EXCLUDE_STOPPED_PACKAGES
  for (const [key, value] of Object.entries({
    status: device.battery.status, health: 2, present: bundleBox(1, "Z"), level: device.battery.level, scale: 100,
    plugged: pluggedIn() ? 1 : 0, battery_low: bundleBox(+batteryLow(), "Z"),
  })) intent.extras.map.set(key, value);
  return intent;
});
rt.register({ name: "webdroid/BatteryStatsService", ctor: class extends JObj {}, sup: "com/android/internal/app/IBatteryStats$Stub", methods: {
  "isCharging()Z": () => +pluggedIn(),
  "computeChargeTimeRemaining()J": () => -1n,
} });
rt.register({ name: "webdroid/BatteryPropertiesRegistrar", ctor: class extends JObj {}, sup: "android/os/IBatteryPropertiesRegistrar$Stub", methods: {
  "getProperty(ILandroid/os/BatteryProperty;)I": async (id: number, prop: JObj) => {
    const value = id === BATTERY_CAPACITY ? device.battery.level : id === BATTERY_STATUS ? device.battery.status : null;
    if (value === null) return NAME_NOT_FOUND;
    await vcall(prop, "setLong", "(J)V", BigInt(value));
    return 0;
  },
} });

hostStub("power", "webdroid/PowerManagerService");
hostStub("batterystats", "webdroid/BatteryStatsService");
hostStub("batteryproperties", "webdroid/BatteryPropertiesRegistrar");
hostStub("thermalservice", "webdroid/ThermalService");
hostStub("deviceidle", "webdroid/DeviceIdleController");

// IUserManager: one unlocked, running system user, user 0, as the reference AVD's (pm list users:
// UserInfo{0:Owner:4c13}), with no restrictions and no profiles
const USER = 0, USER_FLAGS = 0x4c13, USER_TYPE = "android.os.usertype.full.SYSTEM";
const userInfo = () => newObj("android/content/pm/UserInfo", "(ILjava/lang/String;Ljava/lang/String;ILjava/lang/String;)V", USER, "Owner", null, USER_FLAGS, USER_TYPE);
const isUser = (id: number) => +(id === USER);
rt.register({ name: "webdroid/UserManagerService", ctor: class extends JObj {}, sup: "android/os/IUserManager$Stub", methods: {
  "getUserName()Ljava/lang/String;": () => "Owner",
  "getUserInfo(I)Landroid/content/pm/UserInfo;": (id: number) => id === USER ? userInfo() : null,
  "getProfiles(IZ)Ljava/util/List;": async () => newArrayList([await userInfo()]),
  "getUsers(ZZZ)Ljava/util/List;": async () => newArrayList([await userInfo()]),
  "getProfileIds(IZ)[I": () => Int32Array.of(USER),
  "getProfileIdsExcludingHidden(IZ)[I": () => Int32Array.of(USER),
  "getProfileType(I)Ljava/lang/String;": () => "",
  "isUserOfType(ILjava/lang/String;)Z": (id: number, type: string) => +(id === USER && type === USER_TYPE),
  "isUserUnlocked(I)Z": isUser, "isUserUnlockingOrUnlocked(I)Z": isUser, "isUserRunning(I)Z": isUser, "isUserForeground(I)Z": isUser,
  "getUserSerialNumber(I)I": (id: number) => id === USER ? 0 : -1,
  "getUserHandle(I)I": (serial: number) => serial === 0 ? USER : -1,
  ...stubs(0, "isDemoUser(I)Z", "isQuietModeEnabled(I)Z", "hasUserRestriction(Ljava/lang/String;I)Z", "hasUserRestrictionOnAnyUser(Ljava/lang/String;)Z"),
  "getUserRestrictions(I)Landroid/os/Bundle;": () => newObj("android/os/Bundle"),
  "getApplicationRestrictions(Ljava/lang/String;)Landroid/os/Bundle;": () => newObj("android/os/Bundle"),
  "getApplicationRestrictionsForUser(Ljava/lang/String;I)Landroid/os/Bundle;": () => newObj("android/os/Bundle"),
} });

// IUiModeManager: a handset (UI_MODE_TYPE_NORMAL) at standard contrast, which never changes, in
// the device's night mode (the browser's preference, "no" or "yes"); an app's own night mode
// follows the shell's configuration
rt.register({ name: "webdroid/UiModeManagerService", ctor: class extends JObj {}, sup: "android/app/IUiModeManager$Stub", methods: {
  "getCurrentModeType()I": () => 1,
  "getNightMode()I": () => device.night ? 2 : 1,
  "getContrast()F": () => 0,
  "setApplicationNightMode(I)V": (mode: number) => { appHost?.setApplicationNightMode(mode); },
  ...stubs(0, "isNightModeLocked()Z", "isUiModeLocked()Z", "getActiveProjectionTypes()I"),
  ...noops("addCallback(Landroid/app/IUiModeManagerCallback;)V"),
} });

hostStub("user", "webdroid/UserManagerService");
hostStub("alarm", "webdroid/AlarmManagerService");
hostStub("clipboard", "webdroid/ClipboardService");
hostStub("vibrator_manager", "webdroid/VibratorManagerService");
hostStub("uimode", "webdroid/UiModeManagerService");
