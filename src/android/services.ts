// System services hosted behind binder, each the TS half of AOSP's generated AIDL Stub: AOSP's
// managers run from bytecode over them (ActivityManager, AppTask, LoudnessCodecController,
// ScreenRecordingCallbacks), and a raw transaction reaches the Stub's own onTransact, so an unknown
// code (Shizuku's Sui probe) gets the Stub's answer. A method not implemented here is reported as
// missing by its AIDL name.
import { once } from "../jvm/suspend.ts";
import { awaited, JObj, rt, noops, stubs, setDeclared, getDeclared, driven, type Gen, type NativeSpec } from "../jvm/runtime.ts";
import { jarray } from "../jvm/abi.ts";
import { newObj, vcall, scall, linkInit, staticField, after } from "../jvm/natives/jentry.ts";
import { postMain } from "./mainloop.ts";
import { uptimeMillis, wallMillis } from "../guest-clock.ts";
import { newArrayList } from "../jvm/natives/jcoll.ts";
import { device } from "../shell/config.ts";
import { appHost } from "./apphost.ts";
import { newIntent, putExtra, registerSystemActivity } from "./intent.ts";
import { intentSenderMethods, intentSenderTaskMethods } from "./pendingintent.ts";
import { PROCESS_NAME, PROCESS_PID, PROCESS_UID, totalMemory, freeMemory } from "./os.ts";
import { GL_ES_VERSION } from "./pm.ts";
import { protectionLevel, isRuntimePermission, permissionGranted, checkUidPermission } from "./permissions.ts";
import { deviceConfiguration, systemResource } from "./resnative.ts";
import { absentService, callingIdentity, enforceCallingOrSelfPermission, hostStub, parceledList } from "./binder.ts";
import { packages } from "./packages.ts";
import { getPrefs } from "./sharedprefs.ts";
import { broadcastQueueMethods, stickyBroadcasts } from "./server/broadcastqueue.ts";
import { activityManagerMethods } from "./server/am.ts";
import { activityTaskMethods, foreground } from "./server/atm.ts";
import { activeServiceMethods } from "./server/activeservices.ts";

const PROCESS_INFO = "android/app/ActivityManager$RunningAppProcessInfo";
const IMPORTANCE_FOREGROUND = 100, IMPORTANCE_CACHED = 400;
function fillProc(info: JObj): JObj {
  const pkg = appHost?.pkg ?? "";
  return setDeclared(info, PROCESS_INFO, { processName: PROCESS_NAME || pkg, pid: PROCESS_PID, uid: PROCESS_UID, pkgList: jarray([pkg], "Ljava/lang/String;"),
    importance: foreground() ? IMPORTANCE_FOREGROUND : IMPORTANCE_CACHED });
}

// IActivityManager: this process's view of the activity manager
const checkPidPermission = (name: string, _pid: number, uid: number) => checkUidPermission(name, uid);
const activityManager: NativeSpec["methods"] = {
  "getRunningAppProcesses()Ljava/util/List;": () => after(newObj(PROCESS_INFO), (info) => newArrayList([fillProc(info)])),
  "getMyMemoryState(Landroid/app/ActivityManager$RunningAppProcessInfo;)V": (info: JObj) => { fillProc(info); },
  // the device profile's memory: the page cannot read the host's
  "getMemoryInfo(Landroid/app/ActivityManager$MemoryInfo;)V": (mi: JObj) => {
    setDeclared(mi, "android/app/ActivityManager$MemoryInfo", { totalMem: totalMemory(), availMem: freeMemory(), lowMemory: 0, threshold: 128n << 20n });
  },
  "getProcessMemoryInfo([I)[Landroid/os/Debug$MemoryInfo;": driven(function* (pids: Int32Array): Gen {
    const infos: JObj[] = [];
    for (const pid of pids) {
      const info: JObj = yield newObj("android/os/Debug$MemoryInfo");
      yield scall("android/os/Debug", "getMemoryInfo", "(ILandroid/os/Debug$MemoryInfo;)Z", pid, info);
      infos.push(info);
    }
    return jarray(infos, "Landroid/os/Debug$MemoryInfo;");
  }),
  // ActiveServices does not report its records as RunningServiceInfo
  "getServices(II)Ljava/util/List;": () => newArrayList(),
  // no starts are recorded, and nothing restricts this app or drives it as a monkey
  "getHistoricalProcessStartReasons(Ljava/lang/String;II)Landroid/content/pm/ParceledListSlice;": () => parceledList(),
  "reportStartInfoViewTimestamps(JJ)V": () => {},
  "isBackgroundRestricted(Ljava/lang/String;)Z": () => 0,
  "checkPermission(Ljava/lang/String;II)I": checkPidPermission,
  "checkPermissionForDevice(Ljava/lang/String;III)I": checkPidPermission,
  "isUserAMonkey()Z": () => 0,
  // the render thread's tid, for scheduling: everything here shares the page's one thread
  "setRenderThread(I)V": () => {},
  // AMS records it to kill this process when that package changes; no package changes under a running app
  "addPackageDependency(Ljava/lang/String;)V": () => {},
  ...intentSenderMethods,
};
rt.register({ name: "webdroid/ActivityManagerService", ctor: class extends JObj {}, sup: "android/app/IActivityManager$Stub",
  methods: { ...activityManager, ...activityManagerMethods, ...activeServiceMethods, ...broadcastQueueMethods } });

// IActivityTaskManager
rt.register({ name: "webdroid/ActivityTaskManagerService", ctor: class extends JObj {}, sup: "android/app/IActivityTaskManager$Stub", methods: {
  ...activityTaskMethods,
  ...intentSenderTaskMethods,
  "getDeviceConfigurationInfo()Landroid/content/pm/ConfigurationInfo;": () => after(newObj("android/content/pm/ConfigurationInfo"), (info) => {
    const config = deviceConfiguration();
    return setDeclared(info, "android/content/pm/ConfigurationInfo", { reqTouchScreen: config.touchscreen, reqKeyboardType: config.keyboard,
      reqNavigation: config.navigation, reqGlEsVersion: GL_ES_VERSION });
  }),
} });

hostStub("activity", "webdroid/ActivityManagerService");
hostStub("activity_task", "webdroid/ActivityTaskManagerService");

// ITrustManager: the keyguard is never shown and has no secure lock, as on the reference AVD
rt.register({ name: "webdroid/TrustManagerService", ctor: class extends JObj {}, sup: "android/app/trust/ITrustManager$Stub", methods: {
  ...stubs(0, "isDeviceLocked(II)Z", "isDeviceSecure(II)Z"),
} });

hostStub("trust", "webdroid/TrustManagerService");

// system_server services every device runs, which an app reaches with nothing to act on here: no
// assistant is selected (VoiceInteractionManagerService then ignores activity events), no content
// capture service package is installed to allowlist a package's options, and netd's cleartext
// inspection is not available, so only the default POLICY_ACCEPT, which inspects nothing, applies
rt.register({ name: "webdroid/VoiceInteractionManagerService", ctor: class extends JObj {}, sup: "com/android/internal/app/IVoiceInteractionManagerService$Stub",
  methods: noops("notifyActivityEventChanged(Landroid/os/IBinder;I)V") });
rt.register({ name: "webdroid/ContentCaptureManagerService", ctor: class extends JObj {}, sup: "android/view/contentcapture/IContentCaptureManager$Stub",
  methods: noops("registerContentCaptureOptionsCallback(Ljava/lang/String;Landroid/view/contentcapture/IContentCaptureOptionsCallback;)V") });
rt.register({ name: "webdroid/NetworkManagementService", ctor: class extends JObj {}, sup: "android/os/INetworkManagementService$Stub", methods: {
  "setUidCleartextNetworkPolicy(II)V": (_uid: number, policy: number) => { if (policy !== 0) rt.noteMissing(`netd cleartext network policy ${policy}`); },
} });
// TextClassificationManagerService with no TextClassifierService package installed: each request
// fails ("No configured system TextClassifierService") and the caller uses its local classifier
const TC = "Landroid/view/textclassifier/", TCB = "Landroid/service/textclassifier/ITextClassifierCallback;";
const classifierFailure = (_session: unknown, _request: unknown, callback: JObj) => vcall(callback, "onFailure", "()V");
rt.register({ name: "webdroid/TextClassificationManagerService", ctor: class extends JObj {}, sup: "android/service/textclassifier/ITextClassifierService$Stub", methods: {
  ...Object.fromEntries([["onSuggestSelection", "TextSelection$Request"], ["onClassifyText", "TextClassification$Request"],
    ["onGenerateLinks", "TextLinks$Request"], ["onDetectLanguage", "TextLanguage$Request"], ["onSuggestConversationActions", "ConversationActions$Request"]]
    .map(([name, request]) => [`${name}(${TC}TextClassificationSessionId;${TC}${request};${TCB})V`, classifierFailure])),
  ...noops(`onSelectionEvent(${TC}TextClassificationSessionId;${TC}SelectionEvent;)V`, `onTextClassifierEvent(${TC}TextClassificationSessionId;${TC}TextClassifierEvent;)V`,
    `onCreateTextClassificationSession(${TC}TextClassificationContext;${TC}TextClassificationSessionId;)V`, `onDestroyTextClassificationSession(${TC}TextClassificationSessionId;)V`),
} });
hostStub("textclassification", "webdroid/TextClassificationManagerService");
// ITextServicesManager, under AOSP's TextServicesManager: no spell checker is installed, so none
// is enabled or current, and a new session is null as AOSP's manager returns then
rt.register({ name: "webdroid/TextServicesManagerService", ctor: class extends JObj {}, sup: "com/android/internal/textservice/ITextServicesManager$Stub", methods: {
  "isSpellCheckerEnabled(I)Z": () => 0,
  "getCurrentSpellChecker(ILjava/lang/String;)Landroid/view/textservice/SpellCheckerInfo;": () => null,
  "getCurrentSpellCheckerSubtype(IZ)Landroid/view/textservice/SpellCheckerSubtype;": () => null,
  "getEnabledSpellCheckers(I)[Landroid/view/textservice/SpellCheckerInfo;": () => jarray([], "Landroid/view/textservice/SpellCheckerInfo;"),
} });
hostStub("textservices", "webdroid/TextServicesManagerService");
// SensitiveContentProtectionManagerService only blocks a sensitive window from screen sharing, and
// nothing projects the screen here
rt.register({ name: "webdroid/SensitiveContentProtectionManagerService", ctor: class extends JObj {}, sup: "android/view/ISensitiveContentProtectionManager$Stub",
  methods: noops("setSensitiveContentProtection(Landroid/os/IBinder;Ljava/lang/String;Z)V") });
hostStub("sensitive_content_protection_service", "webdroid/SensitiveContentProtectionManagerService");
hostStub("voiceinteraction", "webdroid/VoiceInteractionManagerService");
hostStub("content_capture", "webdroid/ContentCaptureManagerService");
hostStub("network_management", "webdroid/NetworkManagementService");
// MediaProjectionManagerService with no projection: nothing records or casts the screen, so there is
// no active projection to report and no change for a watcher to hear
rt.register({ name: "webdroid/MediaProjectionManagerService", ctor: class extends JObj {}, sup: "android/media/projection/IMediaProjectionManager$Stub", methods: {
  ...stubs(null, "getActiveProjectionInfo()Landroid/media/projection/MediaProjectionInfo;",
    "addCallback(Landroid/media/projection/IMediaProjectionWatcherCallback;)Landroid/media/projection/MediaProjectionInfo;"),
  ...noops("removeCallback(Landroid/media/projection/IMediaProjectionWatcherCallback;)V"),
} });
hostStub("media_projection", "webdroid/MediaProjectionManagerService");
// ITimeDetectorService: the host's wall clock is network-synchronized, so it is the latest network time
rt.register({ name: "webdroid/TimeDetectorService", ctor: class extends JObj {}, sup: "android/app/timedetector/ITimeDetectorService$Stub", methods: {
  "latestNetworkTime()Landroid/app/time/UnixEpochTime;": () =>
    newObj("android/app/time/UnixEpochTime", "(JJ)V", BigInt(Math.floor(uptimeMillis())), BigInt(Math.floor(wallMillis()))),
} });
hostStub("time_detector", "webdroid/TimeDetectorService");
// IDeviceIdentifiersPolicyService: ro.serialno is unset, so a caller that may read the serial gets
// Build.UNKNOWN; TelephonyPermissions admits READ_PRIVILEGED_PHONE_STATE, or READ_PHONE_STATE below Q
rt.register({ name: "webdroid/DeviceIdentifiersPolicyService", ctor: class extends JObj {}, sup: "android/os/IDeviceIdentifiersPolicyService$Stub", methods: {
  "getSerialForPackage(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": driven(function* (pkg: string | null) {
    const { uid } = callingIdentity(), record = pkg === null ? undefined : packages.get(pkg);
    if (record?.uid !== uid) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid callingPackage or callingPackage does not belong to caller's uid:" + uid);
    if ((yield* awaited(checkUidPermission("android.permission.READ_PRIVILEGED_PHONE_STATE", uid))) === 0) return "unknown";
    if (record.sdk.target < 29 && (yield* awaited(checkUidPermission("android.permission.READ_PHONE_STATE", uid))) === 0) return "unknown";
    throw rt.mkThrowable("java/lang/SecurityException", `getSerial: The uid ${uid} does not meet the requirements to access device identifiers.`);
  }),
} });
hostStub("device_identifiers", "webdroid/DeviceIdentifiersPolicyService");
// StatusBarManagerService: quick settings never bind a tile, so a tile's listening request has no panel to reach
rt.register({ name: "webdroid/StatusBarManagerService", ctor: class extends JObj {}, sup: "com/android/internal/statusbar/IStatusBarService$Stub",
  methods: noops("requestTileServiceListeningState(Landroid/content/ComponentName;I)V") });
hostStub("statusbar", "webdroid/StatusBarManagerService");
// FontManagerService: both calls require UPDATE_FONTS, which only signature or privileged apps hold
const updateFonts = () => enforceCallingOrSelfPermission("android.permission.UPDATE_FONTS", "UPDATE_FONTS permission required.");
rt.register({ name: "webdroid/FontManagerService", ctor: class extends JObj {}, sup: "com/android/internal/graphics/fonts/IFontManager$Stub", methods: {
  "getFontConfig()Landroid/text/FontConfig;": updateFonts,
  "updateFontFamily(Ljava/util/List;I)I": updateFonts,
} });
hostStub("font", "webdroid/FontManagerService");
// IAccessibilityManager, under AOSP's AccessibilityManager: no accessibility service is installed
// or enabled, so a client's state is all off; the focus highlight is framework-res's
rt.register({ name: "webdroid/AccessibilityManagerService", ctor: class extends JObj {}, sup: "android/view/accessibility/IAccessibilityManager$Stub", methods: {
  "addClient(Landroid/view/accessibility/IAccessibilityManagerClient;I)J": () => 0n,
  "removeClient(Landroid/view/accessibility/IAccessibilityManagerClient;I)Z": () => 1,
  "getRecommendedTimeoutMillis()J": () => 0n,
  "getFocusStrokeWidth()I": () => systemResource("dimen", "accessibility_focus_highlight_stroke_width", "getDimensionPixelSize", "(I)I"),
  "getFocusColor()I": () => systemResource("color", "accessibility_focus_highlight_color", "getColor", "(ILandroid/content/res/Resources$Theme;)I", null),
  "getEnabledAccessibilityServiceList(II)Ljava/util/List;": () => newArrayList(),
  "getInstalledAccessibilityServiceList(I)Landroid/content/pm/ParceledListSlice;": () => parceledList(),
  ...noops("sendAccessibilityEvent(Landroid/view/accessibility/AccessibilityEvent;I)V", "interrupt(I)V"),
} });
hostStub("accessibility", "webdroid/AccessibilityManagerService");
// No Bluetooth, NFC or autofill: SystemServer starts none of their services without the hardware
// or FEATURE_AUTOFILL, so AOSP's managers, which every device registers, report no service
absentService("bluetooth_manager", "nfc", "autofill");

// IConnectivityManager: one Wi-Fi network (netId 100), the one the page reaches the internet
// through, up while the page is online. Its capabilities and link properties are the reference
// AVD's Wi-Fi network as an app sees it (no transport info, owner or admin uids); its DNS server is
// one any resolver can use, as port-53 datagrams are answered over DNS-over-HTTPS (shell/relay.ts).
// Callbacks reach ConnectivityManager's CallbackHandler as CALLBACK_* messages through the
// Messenger each request carries, as ConnectivityService sends them.
const NET_ID = 100, TYPE_WIFI = 1, TRANSPORT_WIFI = 1;
export const DNS_SERVER = "8.8.8.8";
/** NET_CAPABILITY_*: NOT_METERED, INTERNET, NOT_RESTRICTED, TRUSTED, NOT_VPN, VALIDATED, NOT_ROAMING,
 *  FOREGROUND, NOT_CONGESTED, NOT_SUSPENDED, NOT_VCN_MANAGED, NOT_BANDWIDTH_CONSTRAINED */
const CAPABILITIES = [11, 12, 13, 14, 15, 16, 18, 19, 20, 21, 28, 37];
export const netUp = (): boolean => typeof navigator === "undefined" || navigator.onLine !== false;
const NC = "android/net/NetworkCapabilities", NCB = "Landroid/net/NetworkCapabilities$Builder;";
export const theNetwork = once(() => newObj("android/net/Network", "(I)V", NET_ID));
const capabilities = once(driven(function* (): Gen<JObj> {
  let b = yield newObj(`${NC}$Builder`);
  b = yield vcall(b, "addTransportType", `(I)${NCB}`, TRANSPORT_WIFI);
  for (const c of CAPABILITIES) b = yield vcall(b, "addCapability", `(I)${NCB}`, c);
  b = yield vcall(b, "setLinkUpstreamBandwidthKbps", `(I)${NCB}`, 12000);
  b = yield vcall(b, "setLinkDownstreamBandwidthKbps", `(I)${NCB}`, 30000);
  b = yield vcall(b, "setSignalStrength", `(I)${NCB}`, -50);
  return yield vcall(b, "build", `()L${NC};`);
}));
const linkProperties = once(driven(function* (): Gen<JObj> {
  const lp = yield newObj("android/net/LinkProperties");
  yield vcall(lp, "setInterfaceName", "(Ljava/lang/String;)V", "wlan0");
  const dns = yield scall("java/net/InetAddress", "getByName", "(Ljava/lang/String;)Ljava/net/InetAddress;", DNS_SERVER);
  yield vcall(lp, "addDnsServer", "(Ljava/net/InetAddress;)Z", dns);
  return lp;
}));
/** `n` is the one network: then `answer`, else null */
const ifOurs = (answer: () => unknown) => driven(function* (n: unknown): Gen {
  return n != null && (yield vcall(n, "equals", "(Ljava/lang/Object;)Z", yield theNetwork())) === 1 ? yield answer() : null;
});
const networkInfo = driven(function* (): Gen<JObj> {
  const info = yield newObj("android/net/NetworkInfo", "(IILjava/lang/String;Ljava/lang/String;)V", TYPE_WIFI, 0, "WIFI", "");
  const connected = yield staticField("android/net/NetworkInfo$DetailedState", netUp() ? "CONNECTED" : "DISCONNECTED");
  yield vcall(info, "setDetailedState", "(Landroid/net/NetworkInfo$DetailedState;Ljava/lang/String;Ljava/lang/String;)V", connected, null, "");
  yield vcall(info, "setIsAvailable", "(Z)V", 1);
  return info;
});
/** ConnectivityManager's CALLBACK_* message codes */
const callbackCode = (name: string) => staticField<number>("android/net/ConnectivityManager", name);
type Registration = { request: JObj; messenger: JObj };
const registrations = new Map<JObj, Registration>();
let nextRequestId = 1;
/** ConnectivityService.callCallbackForRequest: the request, the network and what the code carries */
function* sendCallback(r: Registration, name: string): Gen<void> {
  const data = yield newObj("android/os/Bundle"), put = (cls: string, value: unknown) =>
    vcall(data, "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", cls, value);
  yield put("NetworkRequest", r.request);
  yield put("Network", yield theNetwork());
  if (name === "CALLBACK_AVAILABLE") {
    yield put("NetworkCapabilities", yield* awaited(capabilities()));
    yield put("LinkProperties", yield* awaited(linkProperties()));
  }
  const msg = yield scall("android/os/Message", "obtain", "()Landroid/os/Message;");
  setDeclared(msg, "android/os/Message", { what: yield* awaited(callbackCode(name)) });
  yield vcall(msg, "setData", "(Landroid/os/Bundle;)V", data);
  yield vcall(r.messenger, "send", "(Landroid/os/Message;)V", msg);
}
/** a request's NetworkRequest, registered for callbacks; one the network satisfies hears of it */
const register = driven(function* (caps: unknown, legacyType: number, messenger: JObj, type: number): Gen<JObj> {
  const types = (yield* awaited(linkInit("android/net/NetworkRequest$Type"))).call("values", "()[Landroid/net/NetworkRequest$Type;")() as JObj[];
  const request: JObj = yield newObj("android/net/NetworkRequest", "(Landroid/net/NetworkCapabilities;IILandroid/net/NetworkRequest$Type;)V",
    caps ?? (yield newObj(NC)), legacyType, nextRequestId++, types[type]);
  const r = { request, messenger };
  registrations.set(request, r);
  if (netUp() && (yield vcall(caps ?? (yield* awaited(capabilities())), "satisfiedByNetworkCapabilities", `(L${NC};)Z`, yield* awaited(capabilities()))))
    yield* sendCallback(r, "CALLBACK_AVAILABLE");
  return request;
});
rt.register({ name: "webdroid/ConnectivityService", ctor: class extends JObj {}, sup: "android/net/IConnectivityManager$Stub", methods: {
  "getActiveNetwork()Landroid/net/Network;": () => netUp() ? theNetwork() : null,
  "getActiveNetworkForUid(IZ)Landroid/net/Network;": () => netUp() ? theNetwork() : null,
  "getAllNetworks()[Landroid/net/Network;": driven(function* () { return jarray(netUp() ? [yield theNetwork()] : [], "Landroid/net/Network;"); }),
  "getActiveNetworkInfo()Landroid/net/NetworkInfo;": networkInfo,
  "getActiveNetworkInfoForUid(IZ)Landroid/net/NetworkInfo;": networkInfo,
  // the one network's own type answers; this device has no other
  "getNetworkInfo(I)Landroid/net/NetworkInfo;": (type: number) => type === TYPE_WIFI ? networkInfo() : null,
  "getNetworkInfoForUid(Landroid/net/Network;IZ)Landroid/net/NetworkInfo;": ifOurs(networkInfo),
  "getNetworkCapabilities(Landroid/net/Network;Ljava/lang/String;Ljava/lang/String;)Landroid/net/NetworkCapabilities;": ifOurs(capabilities),
  "getLinkProperties(Landroid/net/Network;)Landroid/net/LinkProperties;": ifOurs(linkProperties),
  "isActiveNetworkMetered()Z": () => 0,
  "isDefaultNetworkActive()Z": () => +netUp(),
  // RESTRICT_BACKGROUND_STATUS_DISABLED: data saver is off
  "getRestrictBackgroundStatusByCaller()I": () => 1,
  "getProxyForNetwork(Landroid/net/Network;)Landroid/net/ProxyInfo;": () => null,
  "requestNetwork(ILandroid/net/NetworkCapabilities;ILandroid/os/Messenger;ILandroid/os/IBinder;IILjava/lang/String;Ljava/lang/String;)Landroid/net/NetworkRequest;":
    (_uid: number, caps: unknown, type: number, messenger: JObj, _timeout: number, _binder: unknown, legacyType: number) => register(caps, legacyType, messenger, type),
  "listenForNetwork(Landroid/net/NetworkCapabilities;Landroid/os/Messenger;Landroid/os/IBinder;ILjava/lang/String;Ljava/lang/String;)Landroid/net/NetworkRequest;":
    (caps: unknown, messenger: JObj) => register(caps, -1, messenger, 1),
  "releaseNetworkRequest(Landroid/net/NetworkRequest;)V": (request: JObj) => { registrations.delete(request); },
  // the network is already validated; revalidation is only a hint
  ...noops("reportNetworkConnectivity(Landroid/net/Network;Z)V",
    "registerNetworkActivityListener(Landroid/net/INetworkActivityListener;)V",
    "unregisterNetworkActivityListener(Landroid/net/INetworkActivityListener;)V"),
} });
if (typeof addEventListener !== "undefined") for (const event of ["online", "offline"])
  addEventListener(event, () => postMain(() => rt.drive(function* () {
    for (const r of registrations.values()) yield* sendCallback(r, event === "online" ? "CALLBACK_AVAILABLE" : "CALLBACK_LOST");
  }())));

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
  "getPowerSaveState(I)Landroid/os/PowerSaveState;": driven(function* () {
    return yield vcall(yield newObj("android/os/PowerSaveState$Builder"), "build", "()Landroid/os/PowerSaveState;");
  }),
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
  "registerThermalStatusListener(Landroid/os/IThermalStatusListener;)Z": (listener: unknown) => after(vcall(listener, "onStatusChange", "(I)V", 0), () => 1),
  "unregisterThermalStatusListener(Landroid/os/IThermalStatusListener;)Z": () => 1,
} });
// IDeviceIdleController's power-save allowlist, which PowerManager.isIgnoringBatteryOptimizations
// reads. The system's "let this app run in the background?" dialog, answered by the grant policy runtime
// permissions follow (permissions.ts). AOSP's activity ignores an app that did not declare the
// permission to ask, which reads as the user declining.
const DOZE_EXEMPTION = "__system_power";
registerSystemActivity("android.settings.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", driven(function* (intent: JObj) {
  const data: JObj | null = yield vcall(intent, "getData", "()Landroid/net/Uri;");
  const pkg: string | null = data && (yield vcall(data, "getScheme", "()Ljava/lang/String;")) === "package" ? yield vcall(data, "getSchemeSpecificPart", "()Ljava/lang/String;") : null;
  if (!pkg || !packages.get(pkg)?.requested.has("android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS")) return null;
  yield* awaited(getPrefs(pkg, DOZE_EXEMPTION).set("exempt", 1));
  return newIntent();
}));
const exempt = (pkg: string) => after(getPrefs(pkg, DOZE_EXEMPTION).get("exempt"), value => +(value === 1));
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
const opPermission = (code: number) => scall(AOM, "opToPermission", "(I)Ljava/lang/String;", code);
function* opMode(code: number, pkg: string): Gen<number> {
  const op: number = yield scall(AOM, "opToSwitch", "(I)I", code);
  const permission: string | null = yield opPermission(op);
  if (permission !== null && isRuntimePermission(permission)) return (yield* awaited(permissionGranted(pkg, permission))) ? MODE_ALLOWED : MODE_IGNORED;
  return yield* awaited(defaultMode(op));
}
const checkOp = driven(function* (code: number, uid: number, pkg: string | null): Gen<number> {
  return owns(uid, pkg) ? yield* opMode(code, pkg!) : yield* awaited(defaultMode(code));
});
const noteOp = driven(function* (code: number, uid: number, pkg: string | null, tag: string | null): Gen<JObj> {
  return yield newObj("android/app/SyncNotedAppOp", "(IILjava/lang/String;Ljava/lang/String;)V", owns(uid, pkg) ? yield* opMode(code, pkg!) : MODE_ERRORED, code, tag, pkg);
});
const startOp = (_token: unknown, code: number, uid: number, pkg: string | null, tag: string | null) => noteOp(code, uid, pkg, tag);
const sourceField = <T>(state: JObj, name: string) => getDeclared<T>(state, "android/content/AttributionSourceState", name);
const noteFor = (code: number, state: JObj) =>
  noteOp(code, sourceField(state, "uid"), sourceField(state, "packageName"), sourceField(state, "attributionTag"));
/** a proxied op is noted for the proxy (an app is never a trusted proxy) and then the app it serves */
const noteProxyOp = driven(function* (code: number, state: JObj): Gen<JObj> {
  const proxy = yield* awaited(noteFor(code, state)), next = sourceField<JObj[] | null>(state, "next");
  return next?.length && (yield vcall(proxy, "getOpMode", "()I")) === MODE_ALLOWED ? yield* awaited(noteFor(code, next[0])) : proxy;
});
rt.register({ name: "webdroid/AppOpsService", ctor: class extends JObj {}, sup: "com/android/internal/app/IAppOpsService$Stub", methods: {
  "checkOperation(IILjava/lang/String;)I": checkOp,
  "checkOperationForDevice(IILjava/lang/String;I)I": checkOp,
  "checkOperationRaw(IILjava/lang/String;Ljava/lang/String;)I": checkOp,
  "checkOperationRawForDevice(IILjava/lang/String;Ljava/lang/String;I)I": checkOp,
  "checkAudioOperation(IIILjava/lang/String;)I": (code: number, _usage: number, uid: number, pkg: string | null) => checkOp(code, uid, pkg),
  "checkPackage(ILjava/lang/String;)I": (uid: number, pkg: string | null) => owns(uid, pkg) ? MODE_ALLOWED : MODE_ERRORED,
  "noteOperation(IILjava/lang/String;Ljava/lang/String;ZLjava/lang/String;Z)Landroid/app/SyncNotedAppOp;": noteOp,
  "noteOperationForDevice(IILjava/lang/String;Ljava/lang/String;IZLjava/lang/String;Z)Landroid/app/SyncNotedAppOp;": noteOp,
  "startOperation(Landroid/os/IBinder;IILjava/lang/String;Ljava/lang/String;ZZLjava/lang/String;ZII)Landroid/app/SyncNotedAppOp;": startOp,
  "startOperationForDevice(Landroid/os/IBinder;IILjava/lang/String;Ljava/lang/String;IZZLjava/lang/String;ZII)Landroid/app/SyncNotedAppOp;": startOp,
  "noteProxyOperationWithState(ILandroid/content/AttributionSourceState;ZLjava/lang/String;ZZ)Landroid/app/SyncNotedAppOp;": noteProxyOp,
  "startProxyOperationWithState(Landroid/os/IBinder;ILandroid/content/AttributionSourceState;ZZLjava/lang/String;ZZIII)Landroid/app/SyncNotedAppOp;":
    (_token: unknown, code: number, state: JObj) => noteProxyOp(code, state),
  "isOperationActive(IILjava/lang/String;)Z": () => 0,
  // an app's own notes are collected for ops a dangerous or appop permission guards
  "shouldCollectNotes(I)Z": driven(function* (code: number) {
    if (yield scall(AOM, "shouldForceCollectNoteForOp", "(I)Z", code)) return 1;
    const permission: string | null = yield opPermission(code);
    if (permission === null) return 0;
    // PermissionInfo's PROTECTION_DANGEROUS, or PROTECTION_FLAG_APPOP; an undeclared permission is neither
    const level = protectionLevel(permission) ?? 0;
    return +((level & 15) === 1 || (level & 0x40) !== 0);
  }),
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
  // no package is sampled for runtime access messages: OP_NONE, asked again in an hour
  "reportRuntimeAppOpAccessMessageAndGetConfig(Ljava/lang/String;Landroid/app/SyncNotedAppOp;Ljava/lang/String;)Lcom/android/internal/app/MessageSamplingConfig;": () =>
    newObj("com/android/internal/app/MessageSamplingConfig", "(IIJ)V", -1, 0, BigInt(Date.now() + 3600_000)),
} });
hostStub("appops", "webdroid/AppOpsService");

// IPermissionChecker (PermissionCheckerService), behind PermissionChecker: every app in the
// attribution chain must hold the permission; a data source checking for a caller (a provider)
// is itself exempt. App ops are not modelled, so nothing is soft-denied.
rt.register({ name: "webdroid/PermissionCheckerService", ctor: class extends JObj {}, sup: "android/permission/IPermissionChecker$Stub", methods: {
  "checkPermission(Ljava/lang/String;Landroid/content/AttributionSourceState;Ljava/lang/String;ZZZI)I":
    driven(function* (permission: string, source: JObj, _message: string | null, _delivery: number, _start: number, fromDatasource: number) {
      for (let current: JObj | undefined = source, first = true; current; first = false) {
        if (!(first && fromDatasource) && (yield* awaited(checkUidPermission(permission, sourceField<number>(current, "uid")))) !== 0) return 2; // PERMISSION_HARD_DENIED
        current = sourceField<JObj[] | null>(current, "next")?.[0];
      }
      return 0;
    }),
  "finishDataDelivery(ILandroid/content/AttributionSourceState;Z)V": () => {},
} });
hostStub("permission_checker", "webdroid/PermissionCheckerService");

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
stickyBroadcasts.set("android.intent.action.BATTERY_CHANGED", driven(function* (): Gen<JObj> {
  const intent = yield* awaited(newIntent("android.intent.action.BATTERY_CHANGED"));
  // as recorded on the reference AVD: REGISTERED_ONLY, REPLACE_PENDING, EXCLUDE_STOPPED_PACKAGES
  yield vcall(intent, "setFlags", "(I)Landroid/content/Intent;", 0x60000010);
  for (const [key, value, desc] of [["status", device.battery.status, "I"], ["health", 2, "I"], ["present", 1, "Z"],
    ["level", device.battery.level, "I"], ["scale", 100, "I"], ["plugged", pluggedIn() ? 1 : 0, "I"], ["battery_low", +batteryLow(), "Z"]] as const)
    yield putExtra(intent, key, value, desc);
  return intent;
}));
/** BatteryStatsService.takeUidSnapshot: no uid's usage is recorded here, so a snapshot holds no
 *  values; another uid's needs BATTERY_STATS */
const HPARCELER = "Landroid/os/health/HealthStatsParceler;";
function* uidSnapshot(uid: number): Gen<JObj> {
  if (uid !== callingIdentity().uid) yield enforceCallingOrSelfPermission("android.permission.BATTERY_STATS", null);
  return yield newObj("android/os/health/HealthStatsParceler", "(Landroid/os/health/HealthStatsWriter;)V", yield newObj("android/os/health/HealthStatsWriter",
    "(Landroid/os/health/HealthKeys$Constants;)V", yield staticField("android/os/health/UidHealthStats", "CONSTANTS")));
}
function* uidSnapshots(uids: Int32Array): Gen<JObj[]> {
  const snapshots: JObj[] = [];
  for (const uid of uids) snapshots.push(yield* uidSnapshot(uid));
  return jarray(snapshots, HPARCELER);
}
rt.register({ name: "webdroid/BatteryStatsService", ctor: class extends JObj {}, sup: "com/android/internal/app/IBatteryStats$Stub", methods: {
  "isCharging()Z": () => +pluggedIn(),
  "computeChargeTimeRemaining()J": () => -1n,
  [`takeUidSnapshot(I)${HPARCELER}`]: driven(uidSnapshot),
  [`takeUidSnapshots([I)[${HPARCELER}`]: driven(uidSnapshots),
  "takeUidSnapshotsAsync([ILandroid/os/ResultReceiver;)V": driven(function* (uids: Int32Array, receiver: JObj) {
    const result = yield newObj("android/os/Bundle", "(I)V", 1);
    yield vcall(result, "putParcelableArray", "(Ljava/lang/String;[Landroid/os/Parcelable;)V", "uid_snapshots", yield* uidSnapshots(uids));
    yield vcall(receiver, "send", "(ILandroid/os/Bundle;)V", 0, result);
  }),
} });
// IPowerStatsService: present on every device; nothing here reads a power monitor
rt.register({ name: "webdroid/PowerStatsService", ctor: class extends JObj {}, sup: "android/os/IPowerStatsService$Stub" });
rt.register({ name: "webdroid/BatteryPropertiesRegistrar", ctor: class extends JObj {}, sup: "android/os/IBatteryPropertiesRegistrar$Stub", methods: {
  "getProperty(ILandroid/os/BatteryProperty;)I": (id: number, prop: JObj) => {
    const value = id === BATTERY_CAPACITY ? device.battery.level : id === BATTERY_STATUS ? device.battery.status : null;
    return value === null ? NAME_NOT_FOUND : after(vcall(prop, "setLong", "(J)V", BigInt(value)), () => 0);
  },
} });

hostStub("power", "webdroid/PowerManagerService");
hostStub("batterystats", "webdroid/BatteryStatsService");
hostStub("powerstats", "webdroid/PowerStatsService");
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
  "getProfiles(IZ)Ljava/util/List;": () => after(userInfo(), (user) => newArrayList([user])),
  "getUsers(ZZZ)Ljava/util/List;": () => after(userInfo(), (user) => newArrayList([user])),
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
  "setApplicationNightMode(I)V": (mode: number) => appHost?.setApplicationNightMode(mode),
  ...stubs(0, "isNightModeLocked()Z", "isUiModeLocked()Z", "getActiveProjectionTypes()I"),
  ...noops("addCallback(Landroid/app/IUiModeManagerCallback;)V"),
} });

hostStub("user", "webdroid/UserManagerService");
hostStub("alarm", "webdroid/AlarmManagerService");
hostStub("clipboard", "webdroid/ClipboardService");
hostStub("vibrator_manager", "webdroid/VibratorManagerService");
hostStub("uimode", "webdroid/UiModeManagerService");
