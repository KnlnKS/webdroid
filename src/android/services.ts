// System services hosted behind binder, each the TS half of AOSP's generated AIDL Stub: AOSP's
// managers run from bytecode over them (ActivityManager, AppTask, LoudnessCodecController,
// ScreenRecordingCallbacks), and a raw transaction reaches the Stub's own onTransact, so an unknown
// code (Shizuku's Sui probe) gets the Stub's answer. A method not implemented here is reported as
// missing by its AIDL name.
import { awaited, JObj, rt, noops, stubs, getDeclared, driven, type Gen } from "../jvm/runtime.ts";
import { jarray } from "../jvm/abi.ts";
import { newObj, vcall, scall, after } from "../jvm/natives/jentry.ts";
import { uptimeMillis, wallMillis } from "../guest-clock.ts";
import { newArrayList } from "../jvm/natives/jcoll.ts";
import { device } from "../shell/config.ts";
import { appHost } from "./apphost.ts";
import { intentSenderMethods, intentSenderTaskMethods } from "./pendingintent.ts";
import { protectionLevel, isRuntimePermission, permissionGranted, checkUidPermission } from "./permissions.ts";
import { systemResource, javaLocales, localesOf, applicationLocales, deviceLocales } from "./configuration.ts";
import { absentService, callingIdentity, enforceCallingOrSelfPermission, hostService, parceledList } from "./binder.ts";
import { packages, ownedBy } from "./packages.ts";
import { broadcastQueueMethods } from "./server/broadcastqueue.ts";
import { activityManagerMethods } from "./server/am.ts";
import { activityTaskMethods } from "./server/atm.ts";
import { activeServiceMethods } from "./server/activeservices.ts";

// IActivityManager and IActivityTaskManager, whose methods come from the server/ modules that
// implement them; those import one another, so only a module outside that cycle can read their
// tables as it loads
hostService("activity", "webdroid/ActivityManagerService", "android/app/IActivityManager$Stub",
  { ...activityManagerMethods, ...intentSenderMethods, ...activeServiceMethods, ...broadcastQueueMethods });
hostService("activity_task", "webdroid/ActivityTaskManagerService", "android/app/IActivityTaskManager$Stub", { ...activityTaskMethods, ...intentSenderTaskMethods });

// ITrustManager: the keyguard is never shown and has no secure lock, as on the reference AVD
hostService("trust", "webdroid/TrustManagerService", "android/app/trust/ITrustManager$Stub", {
  ...stubs(0, "isDeviceLocked(II)Z", "isDeviceSecure(II)Z"),
});

// system_server services every device runs, which an app reaches with nothing to act on here: no
// assistant is selected (VoiceInteractionManagerService then ignores activity events), no content
// capture service package is installed to allowlist a package's options, and netd's cleartext
// inspection is not available, so only the default POLICY_ACCEPT, which inspects nothing, applies
hostService("voiceinteraction", "webdroid/VoiceInteractionManagerService", "com/android/internal/app/IVoiceInteractionManagerService$Stub",
  noops("notifyActivityEventChanged(Landroid/os/IBinder;I)V"));
hostService("content_capture", "webdroid/ContentCaptureManagerService", "android/view/contentcapture/IContentCaptureManager$Stub",
  noops("registerContentCaptureOptionsCallback(Ljava/lang/String;Landroid/view/contentcapture/IContentCaptureOptionsCallback;)V"));
hostService("network_management", "webdroid/NetworkManagementService", "android/os/INetworkManagementService$Stub", {
  "setUidCleartextNetworkPolicy(II)V": (_uid: number, policy: number) => { if (policy !== 0) rt.noteMissing(`netd cleartext network policy ${policy}`); },
});
// TextClassificationManagerService with no TextClassifierService package installed: each request
// fails ("No configured system TextClassifierService") and the caller uses its local classifier
const TC = "Landroid/view/textclassifier/", TCB = "Landroid/service/textclassifier/ITextClassifierCallback;";
const classifierFailure = (_session: unknown, _request: unknown, callback: JObj) => vcall(callback, "onFailure", "()V");
hostService("textclassification", "webdroid/TextClassificationManagerService", "android/service/textclassifier/ITextClassifierService$Stub", {
  ...Object.fromEntries([["onSuggestSelection", "TextSelection$Request"], ["onClassifyText", "TextClassification$Request"],
    ["onGenerateLinks", "TextLinks$Request"], ["onDetectLanguage", "TextLanguage$Request"], ["onSuggestConversationActions", "ConversationActions$Request"]]
    .map(([name, request]) => [`${name}(${TC}TextClassificationSessionId;${TC}${request};${TCB})V`, classifierFailure])),
  ...noops(`onSelectionEvent(${TC}TextClassificationSessionId;${TC}SelectionEvent;)V`, `onTextClassifierEvent(${TC}TextClassificationSessionId;${TC}TextClassifierEvent;)V`,
    `onCreateTextClassificationSession(${TC}TextClassificationContext;${TC}TextClassificationSessionId;)V`, `onDestroyTextClassificationSession(${TC}TextClassificationSessionId;)V`),
});
// ITextServicesManager, under AOSP's TextServicesManager: no spell checker is installed, so none
// is enabled or current, and a new session is null as AOSP's manager returns then
hostService("textservices", "webdroid/TextServicesManagerService", "com/android/internal/textservice/ITextServicesManager$Stub", {
  "isSpellCheckerEnabled(I)Z": () => 0,
  "getCurrentSpellChecker(ILjava/lang/String;)Landroid/view/textservice/SpellCheckerInfo;": () => null,
  "getCurrentSpellCheckerSubtype(IZ)Landroid/view/textservice/SpellCheckerSubtype;": () => null,
  "getEnabledSpellCheckers(I)[Landroid/view/textservice/SpellCheckerInfo;": () => jarray([], "Landroid/view/textservice/SpellCheckerInfo;"),
});
// SensitiveContentProtectionManagerService only blocks a sensitive window from screen sharing, and
// nothing projects the screen here
hostService("sensitive_content_protection_service", "webdroid/SensitiveContentProtectionManagerService", "android/view/ISensitiveContentProtectionManager$Stub",
  noops("setSensitiveContentProtection(Landroid/os/IBinder;Ljava/lang/String;Z)V"));
// MediaProjectionManagerService with no projection: nothing records or casts the screen, so there is
// no active projection to report and no change for a watcher to hear
hostService("media_projection", "webdroid/MediaProjectionManagerService", "android/media/projection/IMediaProjectionManager$Stub", {
  ...stubs(null, "getActiveProjectionInfo()Landroid/media/projection/MediaProjectionInfo;",
    "addCallback(Landroid/media/projection/IMediaProjectionWatcherCallback;)Landroid/media/projection/MediaProjectionInfo;"),
  ...noops("removeCallback(Landroid/media/projection/IMediaProjectionWatcherCallback;)V"),
});
// ITimeDetectorService: the host's wall clock is network-synchronized, so it is the latest network time
hostService("time_detector", "webdroid/TimeDetectorService", "android/app/timedetector/ITimeDetectorService$Stub", {
  "latestNetworkTime()Landroid/app/time/UnixEpochTime;": () =>
    newObj("android/app/time/UnixEpochTime", "(JJ)V", BigInt(Math.floor(uptimeMillis())), BigInt(Math.floor(wallMillis()))),
});
// IDeviceIdentifiersPolicyService: ro.serialno is unset, so a caller that may read the serial gets
// Build.UNKNOWN; TelephonyPermissions admits READ_PRIVILEGED_PHONE_STATE, or READ_PHONE_STATE below Q
hostService("device_identifiers", "webdroid/DeviceIdentifiersPolicyService", "android/os/IDeviceIdentifiersPolicyService$Stub", {
  "getSerialForPackage(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;": driven(function* (pkg: string | null) {
    const { uid } = callingIdentity(), record = pkg === null ? undefined : packages.get(pkg);
    if (record?.uid !== uid) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid callingPackage or callingPackage does not belong to caller's uid:" + uid);
    if ((yield* awaited(checkUidPermission("android.permission.READ_PRIVILEGED_PHONE_STATE", uid))) === 0) return "unknown";
    if (record.sdk.target < 29 && (yield* awaited(checkUidPermission("android.permission.READ_PHONE_STATE", uid))) === 0) return "unknown";
    throw rt.mkThrowable("java/lang/SecurityException", `getSerial: The uid ${uid} does not meet the requirements to access device identifiers.`);
  }),
});
// StatusBarManagerService: quick settings never bind a tile, so a tile's listening request has no panel to reach
hostService("statusbar", "webdroid/StatusBarManagerService", "com/android/internal/statusbar/IStatusBarService$Stub",
  noops("requestTileServiceListeningState(Landroid/content/ComponentName;I)V"));
// FontManagerService: both calls require UPDATE_FONTS, which only signature or privileged apps hold
const updateFonts = () => enforceCallingOrSelfPermission("android.permission.UPDATE_FONTS", "UPDATE_FONTS permission required.");
hostService("font", "webdroid/FontManagerService", "com/android/internal/graphics/fonts/IFontManager$Stub", {
  "getFontConfig()Landroid/text/FontConfig;": updateFonts,
  "updateFontFamily(Ljava/util/List;I)I": updateFonts,
});
// IAccessibilityManager, under AOSP's AccessibilityManager: no accessibility service is installed
// or enabled, so a client's state is all off; the focus highlight is framework-res's
hostService("accessibility", "webdroid/AccessibilityManagerService", "android/view/accessibility/IAccessibilityManager$Stub", {
  "addClient(Landroid/view/accessibility/IAccessibilityManagerClient;I)J": () => 0n,
  "removeClient(Landroid/view/accessibility/IAccessibilityManagerClient;I)Z": () => 1,
  "getRecommendedTimeoutMillis()J": () => 0n,
  "getFocusStrokeWidth()I": () => systemResource("dimen", "accessibility_focus_highlight_stroke_width", "getDimensionPixelSize", "(I)I"),
  "getFocusColor()I": () => systemResource("color", "accessibility_focus_highlight_color", "getColor", "(ILandroid/content/res/Resources$Theme;)I", null),
  "getEnabledAccessibilityServiceList(II)Ljava/util/List;": () => newArrayList(),
  "getInstalledAccessibilityServiceList(I)Landroid/content/pm/ParceledListSlice;": () => parceledList(),
  ...noops("sendAccessibilityEvent(Landroid/view/accessibility/AccessibilityEvent;I)V", "interrupt(I)V"),
});
// No Bluetooth, NFC or autofill: SystemServer starts none of their services without the hardware
// or FEATURE_AUTOFILL, so AOSP's managers, which every device registers, report no service
absentService("bluetooth_manager", "nfc", "autofill");

// IAppOpsService, under AppOpsManager: an op's mode as AppOpsService derives it for this app. A
// runtime permission's op follows its grant (IGNORED until granted; the app in front evaluates a
// foreground grant as ALLOWED); any other op has its default mode, MODE_DEFAULT for special access
// (SYSTEM_ALERT_WINDOW, GET_USAGE_STATS) that callers then decide by the permission. A package the
// uid does not own reads as the op's default when checked and MODE_ERRORED when noted or started,
// as the reference AVD's services.jar answers. Mode changes are not reported to watchers.
const AOM = "android/app/AppOpsManager", MODE_ALLOWED = 0, MODE_IGNORED = 1, MODE_ERRORED = 2;
const defaultMode = (code: number): Promise<number> => scall(AOM, "opToDefaultMode", "(I)I", code);
const opPermission = (code: number) => scall(AOM, "opToPermission", "(I)Ljava/lang/String;", code);
function* opMode(code: number, pkg: string): Gen<number> {
  const op: number = yield scall(AOM, "opToSwitch", "(I)I", code);
  const permission: string | null = yield opPermission(op);
  if (permission !== null && isRuntimePermission(permission)) return (yield* awaited(permissionGranted(pkg, permission))) ? MODE_ALLOWED : MODE_IGNORED;
  return yield* awaited(defaultMode(op));
}
const checkOp = driven(function* (code: number, uid: number, pkg: string | null): Gen<number> {
  return ownedBy(pkg, uid) ? yield* opMode(code, pkg!) : yield* awaited(defaultMode(code));
});
const noteOp = driven(function* (code: number, uid: number, pkg: string | null, tag: string | null): Gen<JObj> {
  return yield newObj("android/app/SyncNotedAppOp", "(IILjava/lang/String;Ljava/lang/String;)V", ownedBy(pkg, uid) ? yield* opMode(code, pkg!) : MODE_ERRORED, code, tag, pkg);
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
hostService("appops", "webdroid/AppOpsService", "com/android/internal/app/IAppOpsService$Stub", {
  "checkOperation(IILjava/lang/String;)I": checkOp,
  "checkOperationForDevice(IILjava/lang/String;I)I": checkOp,
  "checkOperationRaw(IILjava/lang/String;Ljava/lang/String;)I": checkOp,
  "checkOperationRawForDevice(IILjava/lang/String;Ljava/lang/String;I)I": checkOp,
  "checkAudioOperation(IIILjava/lang/String;)I": (code: number, _usage: number, uid: number, pkg: string | null) => checkOp(code, uid, pkg),
  "checkPackage(ILjava/lang/String;)I": (uid: number, pkg: string | null) => ownedBy(pkg, uid) ? MODE_ALLOWED : MODE_ERRORED,
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
});

// IPermissionChecker (PermissionCheckerService), behind PermissionChecker: every app in the
// attribution chain must hold the permission; a data source checking for a caller (a provider)
// is itself exempt. App ops are not modelled, so nothing is soft-denied.
hostService("permission_checker", "webdroid/PermissionCheckerService", "android/permission/IPermissionChecker$Stub", {
  "checkPermission(Ljava/lang/String;Landroid/content/AttributionSourceState;Ljava/lang/String;ZZZI)I":
    driven(function* (permission: string, source: JObj, _message: string | null, _delivery: number, _start: number, fromDatasource: number) {
      for (let current: JObj | undefined = source, first = true; current; first = false) {
        if (!(first && fromDatasource) && (yield* awaited(checkUidPermission(permission, sourceField<number>(current, "uid")))) !== 0) return 2; // PERMISSION_HARD_DENIED
        current = sourceField<JObj[] | null>(current, "next")?.[0];
      }
      return 0;
    }),
  "finishDataDelivery(ILandroid/content/AttributionSourceState;Z)V": () => {},
});

// IUsageStatsManager, under UsageStatsManager: the app in front is in the ACTIVE standby bucket and
// never inactive. Usage history needs PACKAGE_USAGE_STATS, which an app is never granted here, so
// queries answer null as UsageStatsService does for a caller without it (the manager returns empty).
hostService("usagestats", "webdroid/UsageStatsService", "android/app/usage/IUsageStatsManager$Stub", {
  "getAppStandbyBucket(Ljava/lang/String;Ljava/lang/String;I)I": () => 10,
  "isAppInactive(Ljava/lang/String;ILjava/lang/String;)Z": () => 0,
  ...stubs(null, "queryUsageStats(IJJLjava/lang/String;I)Landroid/content/pm/ParceledListSlice;",
    "queryConfigurationStats(IJJLjava/lang/String;)Landroid/content/pm/ParceledListSlice;",
    "queryEventStats(IJJLjava/lang/String;)Landroid/content/pm/ParceledListSlice;",
    "queryEvents(JJLjava/lang/String;)Landroid/app/usage/UsageEvents;",
    "queryEventsWithFilter(Landroid/app/usage/UsageEventsQuery;Ljava/lang/String;)Landroid/app/usage/UsageEvents;",
    "queryEventsForPackage(JJLjava/lang/String;)Landroid/app/usage/UsageEvents;"),
});

// No biometric sensor and no USB host or accessory: FingerprintManager has no service, as
// SystemServiceRegistry builds it without FEATURE_FINGERPRINT; IAuthService and IUsbManager answer
// as their system services do with no hardware behind them.
const BIOMETRIC_ERROR_NO_HARDWARE = 12;
hostService("auth", "webdroid/AuthService", "android/hardware/biometrics/IAuthService$Stub", {
  "canAuthenticate(Ljava/lang/String;II)I": () => BIOMETRIC_ERROR_NO_HARDWARE,
  "hasEnrolledBiometrics(ILjava/lang/String;)Z": () => 0,
  "getSensorProperties(Ljava/lang/String;)Ljava/util/List;": () => newArrayList(),
  "getAuthenticatorIds(I)[J": () => new BigInt64Array(0),
});
hostService("usb", "webdroid/UsbService", "android/hardware/usb/IUsbManager$Stub", {
  ...noops("getDeviceList(Landroid/os/Bundle;)V"),
  "getCurrentAccessory()Landroid/hardware/usb/UsbAccessory;": () => null,
});

// IUserManager: one unlocked, running system user, user 0, as the reference AVD's (pm list users:
// UserInfo{0:Owner:4c13}), with no restrictions and no profiles
const USER = 0, USER_FLAGS = 0x4c13, USER_TYPE = "android.os.usertype.full.SYSTEM";
const userInfo = () => newObj("android/content/pm/UserInfo", "(ILjava/lang/String;Ljava/lang/String;ILjava/lang/String;)V", USER, "Owner", null, USER_FLAGS, USER_TYPE);
const isUser = (id: number) => +(id === USER);
hostService("user", "webdroid/UserManagerService", "android/os/IUserManager$Stub", {
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
});

// IUiModeManager: a handset (UI_MODE_TYPE_NORMAL) at standard contrast, which never changes, in
// the device's night mode (the browser's preference, "no" or "yes"); an app's own night mode
// follows the shell's configuration
hostService("uimode", "webdroid/UiModeManagerService", "android/app/IUiModeManager$Stub", {
  "getCurrentModeType()I": () => 1,
  "getNightMode()I": () => device.night ? 2 : 1,
  "getContrast()F": () => 0,
  "setApplicationNightMode(I)V": (mode: number) => appHost?.setApplicationNightMode(mode),
  ...stubs(0, "isNightModeLocked()Z", "isUiModeLocked()Z", "getActiveProjectionTypes()I"),
  ...noops("addCallback(Landroid/app/IUiModeManagerCallback;)V"),
});

// ILocaleManager, under AOSP's LocaleManager: an app reads and sets its own languages; another
// app's need READ_APP_SPECIFIC_LOCALES or CHANGE_CONFIGURATION, which no app holds here
const ownLocales = (pkg: string | null, permission: string) => {
  if (pkg !== appHost?.pkg) throw rt.mkThrowable("java/lang/SecurityException", `Caller must be ${pkg} or hold ${permission}`);
};
hostService("locale", "webdroid/LocaleManagerService", "android/app/ILocaleManager$Stub", {
  "getApplicationLocales(Ljava/lang/String;I)Landroid/os/LocaleList;": (pkg: string | null) => {
    ownLocales(pkg, "android.permission.READ_APP_SPECIFIC_LOCALES");
    return javaLocales(applicationLocales());
  },
  "setApplicationLocales(Ljava/lang/String;ILandroid/os/LocaleList;Z)V": (pkg: string | null, _user: number, list: JObj | null) => {
    ownLocales(pkg, "android.permission.CHANGE_CONFIGURATION");
    return after(localesOf(list ?? rt.npe()), (locales) => appHost?.setApplicationLocales(locales));
  },
  "getSystemLocales()Landroid/os/LocaleList;": () => javaLocales(deviceLocales()),
  // no app has an override of its LocaleConfig
  "getOverrideLocaleConfig(Ljava/lang/String;I)Landroid/app/LocaleConfig;": () => null,
});

// IRestrictionsManager, under AOSP's RestrictionsManager: no device or profile owner manages this
// device, so there are no restrictions and no provider to ask
hostService("restrictions", "webdroid/RestrictionsManagerService", "android/content/IRestrictionsManager$Stub", {
  "getApplicationRestrictions(Ljava/lang/String;)Landroid/os/Bundle;": () => newObj("android/os/Bundle"),
  "getApplicationRestrictionsPerAdminForUser(ILjava/lang/String;)Ljava/util/List;": () => newArrayList(),
  "hasRestrictionsProvider()Z": () => 0,
  "createLocalApprovalIntent()Landroid/content/Intent;": () => null,
  "requestPermission(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Landroid/os/PersistableBundle;)V": () => {
    throw rt.mkThrowable("java/lang/IllegalStateException", "Cannot request permission without a restrictions provider registered");
  },
});

// IDropBoxManagerService, under AOSP's DropBoxManager: tags are enabled, as by default on a device,
// and entries are accepted; reading them back needs READ_LOGS, which no app holds, so there are none
hostService("dropbox", "webdroid/DropBoxManagerService", "com/android/internal/os/IDropBoxManagerService$Stub", {
  "isTagEnabled(Ljava/lang/String;)Z": () => 1,
  ...noops("addData(Ljava/lang/String;[BI)V", "addFile(Ljava/lang/String;Landroid/os/ParcelFileDescriptor;I)V"),
  "getNextEntryWithAttribution(Ljava/lang/String;JLjava/lang/String;Ljava/lang/String;)Landroid/os/DropBoxManager$Entry;": () => null,
});
