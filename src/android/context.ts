import type { JIntentFilter } from "./intent-filter";
import { newFile } from "../jvm/natives/jio";
import { vfs } from "../shell/vfs";
import { JObj, rt, type NativeSpec, callSelf, stubs, noops, driven, without, type Gen } from "../jvm/runtime";
import { type AppHost, appHost } from "./apphost";
import { resString, themeOf, JTheme, nativeTheme, nativeRes, type JAttrSet } from "./res";
import { newObj, vcall, vcallOn, curThread, after, systemClassLoader, type JClassLoader } from "../jvm/natives/jlang";
import { mangleMethod, jarray } from "../jvm/abi";
import { getInflater } from "./inflate";
import { getAppInfo, getPM } from "./pm";
import { contentResolver, checkUriPermission, grantUriPermission, revokeUriPermission } from "./contentresolver";
import type { JUri } from "./net";
import { mainLooper, mainExecutor, mainHandler, PROCESS_PID, PROCESS_UID } from "./os";
import { getPrefs, movePrefs, deletePrefs } from "./sharedprefs";
import { dbPath, openDatabase } from "./sqlite";
import { javaTheme, newTheme, loadResources, configuredResources, javaConfiguration } from "./resources";
import { deviceConfiguration } from "./resnative";
import { type JIntent, launchIntent } from "./intent";
import { type JIntentSender, startIntentSender } from "./pendingintent";
import { svcStart, svcStop, svcBind, svcUnbind } from "./runningservices";
import { registerReceiver, unregisterReceiver, sendBroadcast } from "./broadcast";
import { packages } from "./packages";
import { hostedService } from "./binder";

const privDir = (p: string) => { vfs.mkdir(p); return newFile(p); };

export class JContext extends JObj {
  declare $host: AppHost;
  packageLoader: JClassLoader | null = null;
  attributionTag: string | null = null;
  attributionSource: Promise<JObj> | null = null;
}
/** AOSP's base context of the application, activities and created contexts; SDKs reflect on its
 *  fields (Phrase replaces mResources), so getResources answers from the field */
class JContextImpl extends JContext { resources: unknown = null; }
class JDisplayContext extends JContextImpl { display: unknown = null; }
export function newContextImpl<T extends JContextImpl = JContextImpl>(host: AppHost, cls = "android/app/ContextImpl"): T {
  const context: T = rt.make(cls);
  context.$host = host; context.resources = host.jresources;
  return context;
}
function contextForDisplay(source: JContext, display: unknown, windowType?: number) {
  if (display == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Display must not be null");
  const context = newContextImpl<JDisplayContext>(source.$host, "webdroid/DisplayContext");
  context.packageLoader = source.packageLoader; context.display = display;
  if (windowType === undefined) return context;
  const window: JWindowContext = rt.make("android/window/WindowContext");
  window.base = context; window.$host = context.$host; window.packageLoader = context.packageLoader; window.windowType = windowType;
  return window;
}
const packageContexts = new Map<string, Promise<JContext>>();

// system service singletons (created lazily per name)
export const services = new Map<string, unknown>();
/** a string resource of the running app ("" before boot) */
export const appString = (id: number) => (appHost ? resString(appHost.res, id) : "");
/** A Context getter that is getResources().name(args[, getTheme()]) through the virtual entries,
 *  every call on the caller's thread: another thread may resume between them, and AOSP's
 *  ResourcesImpl keeps per-thread state (its drawable lookup stack). */
const viaResources = (name: string, desc: string, themed = false) => async function (this: JContext, ...args: unknown[]) {
  const thread = curThread;
  const resources = await vcallOn(thread, this, "getResources", "()Landroid/content/res/Resources;");
  if (themed) args.push(await vcallOn(thread, this, "getTheme", "()Landroid/content/res/Resources$Theme;"));
  return vcallOn(thread, resources, name, desc, ...args);
};
// the one logical display (Display.DEFAULT_DISPLAY = 0); AOSP hands out one Display per id
let defaultDisplay: unknown;
export const display = () => defaultDisplay ??= newObj("android/view/Display", null);
export const displayListeners = new Set<unknown>();
/**
 * A runtime permission is DENIED until the app asks for it, which is the state a freshly
 * installed app is in — reporting a blanket grant sends an app straight past the fallback it
 * was written to take. Install-time permissions stay granted, as the platform grants them.
 * AOSP's dangerous groups, by their permission names.
 */
const RUNTIME_PERMISSIONS = new Set(["READ_CALENDAR", "WRITE_CALENDAR", "READ_CALL_LOG", "WRITE_CALL_LOG",
  "PROCESS_OUTGOING_CALLS", "CAMERA", "READ_CONTACTS", "WRITE_CONTACTS", "GET_ACCOUNTS",
  "ACCESS_FINE_LOCATION", "ACCESS_COARSE_LOCATION", "ACCESS_BACKGROUND_LOCATION", "RECORD_AUDIO",
  "READ_PHONE_STATE", "READ_PHONE_NUMBERS", "CALL_PHONE", "ANSWER_PHONE_CALLS", "ADD_VOICEMAIL",
  "USE_SIP", "ACCEPT_HANDOVER", "BODY_SENSORS", "ACTIVITY_RECOGNITION", "SEND_SMS", "RECEIVE_SMS",
  "READ_SMS", "RECEIVE_WAP_PUSH", "RECEIVE_MMS", "READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE",
  "READ_MEDIA_IMAGES", "READ_MEDIA_VIDEO", "READ_MEDIA_AUDIO", "POST_NOTIFICATIONS",
  "BLUETOOTH_SCAN", "BLUETOOTH_CONNECT", "BLUETOOTH_ADVERTISE", "NEARBY_WIFI_DEVICES"]
  .map((n) => "android.permission." + n));
export class PermissionStore {
  private packages = new Map<string, Set<string>>();
  get(pkg: string): Set<string> {
    let grants = this.packages.get(pkg);
    if (!grants) {
      grants = new Set(); this.packages.set(pkg, grants);
      try {
        const saved: unknown = JSON.parse(globalThis.localStorage?.getItem("wd:permissions:" + pkg) ?? "[]");
        if (Array.isArray(saved)) for (const value of saved) if (typeof value === "string") grants.add(value);
      } catch { /* corrupt permission state remains denied */ }
    }
    return grants;
  }
  grant(pkg: string, names: string[]) {
    const grants = this.get(pkg); for (const name of names) grants.add(name);
    globalThis.localStorage?.setItem("wd:permissions:" + pkg, JSON.stringify([...grants]));
  }
}
let permissionStore = new PermissionStore();
export function usePermissionStore(store: PermissionStore) { permissionStore = store; }
// granted by the app's own request, or to a system package by the default grant policy
export const isRuntimePermission = (name: string): boolean => RUNTIME_PERMISSIONS.has(name);
export const permissionGranted = (pkg: string, name: string): boolean =>
  !RUNTIME_PERMISSIONS.has(name) || permissionStore.get(pkg).has(name) || !!packages.get(pkg)?.grants.has(name);
const permissionState = (name: string) => permissionGranted(appHost?.pkg ?? "", name) ? 0 : -1;
export function grantPermissions(names: string[]): Int32Array {
  permissionStore.grant(appHost?.pkg ?? "", names);
  return new Int32Array(names.length);
}

// Context.XXX_SERVICE name → the manager class; getSystemService(Class) walks it backwards.
const SERVICE_CLASS: Record<string, string> = {
  window: "android/view/WindowManagerImpl",
  input_method: "android/view/inputmethod/InputMethodManager",
  device_policy: "android/app/admin/DevicePolicyManager",
  game: "android/app/GameManager",
  performance_hint: "android/os/PerformanceHintManager",
  input: "android/hardware/input/InputManager",
  media_router: "android/media/MediaRouter",
  print: "android/print/PrintManager",
  media_metrics: "android/media/metrics/MediaMetricsManager",
  audio: "android/media/AudioManager",
  phone: "android/telephony/TelephonyManager",
  notification: "android/app/NotificationManager",
  accessibility: "android/view/accessibility/AccessibilityManager",
  captioning: "android/view/accessibility/CaptioningManager",
  sensor: "android/hardware/SensorManager",
  camera: "android/hardware/camera2/CameraManager",
  fingerprint: "android/hardware/fingerprint/FingerprintManager",
  biometric: "android/hardware/biometrics/BiometricManager",
  usb: "android/hardware/usb/UsbManager",
  display: "android/hardware/display/DisplayManager",
  autofill: "android/view/autofill/AutofillManager",
  textservices: "android/view/textservice/TextServicesManager",
  restrictions: "android/content/RestrictionsManager",
  appwidget: "android/appwidget/AppWidgetManager",
  shortcut: "android/content/pm/ShortcutManager",
  systemhealth: "android/os/health/SystemHealthManager",
  permission_controller: "android/permission/PermissionControllerManager",
  locale: "android/app/LocaleManager",
  dropbox: "android/os/DropBoxManager",
  storage: "android/os/storage/StorageManager",
  netstats: "android/app/usage/NetworkStatsManager",
  storagestats: "android/app/usage/StorageStatsManager",
  measurement_service: "android/adservices/measurement/MeasurementManager",
  wifi: "android/net/wifi/WifiManager",
  telephony_subscription_service: "android/telephony/SubscriptionManager",
  servicediscovery: "android/net/nsd/NsdManager",
  bluetooth: "android/bluetooth/BluetoothManager",
  nfc: "android/nfc/NfcManager",
  crossprofileapps: "android/content/pm/CrossProfileApps",
};
/** managers AOSP's bytecode serves over the services hosted behind binder, constructed as
 *  SystemServiceRegistry constructs them (for the application: this cache is per process) */
const AOSP_MANAGERS: Record<string, [cls: string, make: (ctx: unknown) => Promise<unknown>]> = {
  activity: ["android/app/ActivityManager", (ctx) => newObj("android/app/ActivityManager", "(Landroid/content/Context;Landroid/os/Handler;)V", ctx, mainHandler())],
  power: ["android/os/PowerManager", async (ctx) => newObj("android/os/PowerManager",
    "(Landroid/content/Context;Landroid/os/IPowerManager;Landroid/os/IThermalService;Landroid/os/Handler;)V",
    ctx, await hostedService("power"), await hostedService("thermalservice"), mainHandler())],
  deviceidle: ["android/os/DeviceIdleManager", async (ctx) =>
    newObj("android/os/DeviceIdleManager", "(Landroid/content/Context;Landroid/os/IDeviceIdleController;)V", ctx, await hostedService("deviceidle"))],
  power_exemption: ["android/os/PowerExemptionManager", (ctx) => newObj("android/os/PowerExemptionManager", "(Landroid/content/Context;)V", ctx)],
  user: ["android/os/UserManager", async (ctx) =>
    newObj("android/os/UserManager", "(Landroid/content/Context;Landroid/os/IUserManager;)V", ctx, await hostedService("user"))],
  uimode: ["android/app/UiModeManager", (ctx) => newObj("android/app/UiModeManager", "(Landroid/content/Context;)V", ctx)],
  alarm: ["android/app/AlarmManager", async (ctx) =>
    newObj("android/app/AlarmManager", "(Landroid/app/IAlarmManager;Landroid/content/Context;)V", await hostedService("alarm"), ctx)],
  clipboard: ["android/content/ClipboardManager", (ctx) => newObj("android/content/ClipboardManager", "(Landroid/content/Context;Landroid/os/Handler;)V", ctx, mainHandler())],
  vibrator_manager: ["android/os/VibratorManager", (ctx) => newObj("android/os/SystemVibratorManager", "(Landroid/content/Context;)V", ctx)],
  vibrator: ["android/os/Vibrator", (ctx) => newObj("android/os/SystemVibrator", "(Landroid/content/Context;)V", ctx)],
  keyguard: ["android/app/KeyguardManager", (ctx) => newObj("android/app/KeyguardManager", "(Landroid/content/Context;)V", ctx)],
  usagestats: ["android/app/usage/UsageStatsManager", async (ctx) => newObj("android/app/usage/UsageStatsManager",
    "(Landroid/content/Context;Landroid/app/usage/IUsageStatsManager;)V", ctx, await hostedService("usagestats"))],
  jobscheduler: ["android/app/job/JobScheduler", async (ctx) =>
    newObj("android/app/JobSchedulerImpl", "(Landroid/content/Context;Landroid/app/job/IJobScheduler;)V", ctx, await hostedService("jobscheduler"))],
  location: ["android/location/LocationManager", async (ctx) =>
    newObj("android/location/LocationManager", "(Landroid/content/Context;Landroid/location/ILocationManager;)V", ctx, await hostedService("location"))],
  account: ["android/accounts/AccountManager", async (ctx) =>
    newObj("android/accounts/AccountManager", "(Landroid/content/Context;Landroid/accounts/IAccountManager;)V", ctx, await hostedService("account"))],
  permission_enforcer: ["android/os/PermissionEnforcer", (ctx) => newObj("android/os/PermissionEnforcer", "(Landroid/content/Context;)V", ctx)],
  appops: ["android/app/AppOpsManager", async (ctx) =>
    newObj("android/app/AppOpsManager", "(Landroid/content/Context;Lcom/android/internal/app/IAppOpsService;)V", ctx, await hostedService("appops"))],
  batterymanager: ["android/os/BatteryManager", async (ctx) => newObj("android/os/BatteryManager",
    "(Landroid/content/Context;Lcom/android/internal/app/IBatteryStats;Landroid/os/IBatteryPropertiesRegistrar;)V",
    ctx, await hostedService("batterystats"), await hostedService("batteryproperties"))],
  connectivity: ["android/net/ConnectivityManager", async (ctx) =>
    newObj("android/net/ConnectivityManager", "(Landroid/content/Context;Landroid/net/IConnectivityManager;)V", ctx, await hostedService("connectivity"))],
};
const SERVICE_NAME = new Map([...Object.entries(SERVICE_CLASS), ...Object.entries(AOSP_MANAGERS).map(([n, [c]]) => [n, c] as const)].map(([n, c]) => [c, n]));
SERVICE_NAME.set("android/view/WindowManager", "window");
export function systemService(jctx: JContext | null, name: string): unknown {
  if (name === "layout_inflater") return getInflater(jctx);
  if (name === "performance_hint") return null;
  let s = services.get(name);
  if (s) return s;
  const manager = AOSP_MANAGERS[name];
  if (manager) {
    const made = manager[1](appHost?.application ?? jctx);
    services.set(name, made);
    return made.then((m) => { services.set(name, m); return m; });
  }
  const cls = SERVICE_CLASS[name];
  // A service we do not model is one this device does not have: AOSP returns null, and callers
  // handle that. Handing back a stand-in object instead only moved the failure to their cast.
  if (!cls) { rt.noteMissing("systemService " + name); return null; }
  s = rt.make(cls);
  services.set(name, s);
  return s;
}

// API 31: a context's own AttributionSource is this process, as ContextImpl builds it
const ATTRIBUTION = "(IILjava/lang/String;Ljava/lang/String;)V";
function contextAttributionSource(this: JContext): Promise<JObj> {
  return this.attributionSource ??= newObj("android/content/AttributionSource", ATTRIBUTION, PROCESS_UID, PROCESS_PID, this.$host?.pkg ?? appHost?.pkg ?? null, this.attributionTag);
}
export const attributionSource = (uid: number, pid: number, pkg: string | null): Promise<JObj> =>
  newObj("android/content/AttributionSource", ATTRIBUTION, uid, pid, pkg, null);

// ── Context methods (shared by Context/ContextWrapper/Activity/Application)
function contextRegisterReceiver(this: JContext, receiver: JObj | null, filter: JIntentFilter) { return registerReceiver(this, receiver, filter); }
function contextRegisterReceiverOn(this: JContext, receiver: JObj | null, filter: JIntentFilter, _permission: string, handler: unknown) {
  return registerReceiver(this, receiver, filter, handler);
}
function contextStartActivity(this: JContext, intent: JIntent) { return launchIntent(this.$host, intent); }
/** startActivities: the intents stack in order, the last one in front */
async function contextStartActivities(this: JContext, intents: JIntent[] | null) {
  if (!intents) return rt.npe();
  for (const intent of intents) await launchIntent(this.$host, intent);
}
function contextSender(this: JContext, sender: JIntentSender, fill: JIntent | null) { return startIntentSender(this, sender, fill); }
/** AOSP's Context.obtainStyledAttributes delegates to getTheme(). Reading the application theme
 *  instead loses every ThemeOverlay — which is how Material passes a widget its shape and
 *  colours — and resolves `?attr` references against the wrong stack. */
function contextStyled(this: JContext, set: JAttrSet | null, attrs: Int32Array, dsa = 0, dsr = 0) {
  return after(vcall(this, "getTheme", "()Landroid/content/res/Resources$Theme;"), (theme) =>
    vcall(theme, "obtainStyledAttributes", "(Landroid/util/AttributeSet;[III)Landroid/content/res/TypedArray;", set, attrs, dsa, dsr));
}
const extFilesDir = (c: JContext, type: string | null) => privDir(`/sdcard/Android/data/${c.$host.pkg}/files` + (type ? "/" + type : ""));
const extCacheDir = (c: JContext) => privDir(`/sdcard/Android/data/${c.$host.pkg}/cache`);
const obbDir = (c: JContext) => privDir(`/sdcard/Android/obb/${c.$host.pkg}`);
function contextOpenDatabase(this: JContext, name: string) {
  const path = dbPath(this.$host.pkg, name);
  vfs.mkdir(path.slice(0, path.lastIndexOf("/")));
  return openDatabase(path);
}
const contextMethods: NativeSpec["methods"] = {
  "getResources()Landroid/content/res/Resources;": function (this: JContext) { return this.$host.jresources; },
  "getTheme()Landroid/content/res/Resources$Theme;": function (this: JContext) {
    return javaTheme(themeOf(this) ?? this.$host.theme);
  },
  // AOSP layers the style over whatever theme this context already resolves to, so a
  // ThemeOverlay on an already-themed context keeps everything underneath it
  "setTheme(I)V": function (this: JContext, id: number) {
    return after(newTheme(this.$host.jresources, themeOf(this) ?? this.$host.theme, id), (t) => { (this as { ownTheme?: JTheme }).ownTheme = t; });
  },
  "getPackageName()Ljava/lang/String;": function (this: JContext) { return this.$host.pkg; },
  "getAttributionSource()Landroid/content/AttributionSource;": contextAttributionSource,
  "createAttributionContext(Ljava/lang/String;)Landroid/content/Context;": function (this: JContext, tag: string | null) {
    const context = new JAttributionContext();
    attachBase.call(context, this);
    context.packageLoader = this.packageLoader;
    context.attributionTag = tag;
    return context;
  },
  "createPackageContext(Ljava/lang/String;I)Landroid/content/Context;": function (this: JContext, pkg: string, flags: number) {
    if (pkg === this.$host.pkg || pkg === this.$host.res.tbl(0x01000000)?.pkgName) return this;
    const record = packages.get(pkg);
    if (!record) throw rt.mkThrowable("android/content/pm/PackageManager$NameNotFoundException", pkg);
    const key = pkg + ":" + (flags & 1);
    let ready = packageContexts.get(key);
    if (!ready) {
      const caller = this.$host;
      ready = (async () => {
        const info = await vcall(getPM(), "getApplicationInfo", "(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;", pkg, 128);
        const jresources = await loadResources(record.path, await javaConfiguration(deviceConfiguration()));
        const theme = await newTheme(jresources, null, info.theme);
        const context = newContextImpl({ ...caller, pkg, res: nativeRes(jresources), zip: record.res.zip,
          jresources, theme, themeResId: info.theme, iconRes: info.icon, splits: [] });
        if (flags & 1) context.packageLoader = await newObj("webdroid/PackageClassLoader", "(Ljava/lang/String;)V", record.path);
        return context;
      })();
      packageContexts.set(key, ready);
      void ready.catch(() => packageContexts.delete(key));
    }
    return ready;
  },
  "getOpPackageName()Ljava/lang/String;": function (this: JContext) { return this.$host.pkg; },
  "getBasePackageName()Ljava/lang/String;": function (this: JContext) { return this.$host.pkg; },
  "getApplicationContext()Landroid/content/Context;": function (this: JContext) { return this.$host.application; },
  // API 31. Everything here draws into the one window, but the application context is not a
  // display context on a device and callers branch on that.
  "isUiContext()Z": function (this: JContext) { return this === this.$host.application ? 0 : 1; },
  "getDisplay()Landroid/view/Display;": function (this: JContext) {
    if (this === this.$host.application) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Context is not associated with a display");
    return display();
  },
  "createDisplayContext(Landroid/view/Display;)Landroid/content/Context;": function (this: JContext, display: unknown) { return contextForDisplay(this, display); },
  "createWindowContext(Landroid/view/Display;ILandroid/os/Bundle;)Landroid/content/Context;": function (this: JContext, display: unknown, type: number) { return contextForDisplay(this, display, type); },
  "createWindowContext(ILandroid/os/Bundle;)Landroid/content/Context;": driven(function* (this: JContext, type: number): Gen {
    return contextForDisplay(this, yield vcall(this, "getDisplay", "()Landroid/view/Display;"), type);
  }),
  "getApplicationInfo()Landroid/content/pm/ApplicationInfo;": function (this: JContext) {
    return this.$host === appHost ? getAppInfo(this.$host) : vcall(getPM(), "getApplicationInfo", "(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;", this.$host.pkg, 128);
  },
  "getPackageManager()Landroid/content/pm/PackageManager;": function () { return getPM(); },
  "getContentResolver()Landroid/content/ContentResolver;": function () { return contentResolver(); },
  "getMainLooper()Landroid/os/Looper;": () => mainLooper,
  "getMainExecutor()Ljava/util/concurrent/Executor;": mainExecutor,
  // API 34: the context stays on the default device, so its device id never changes
  "getDeviceId()I": () => 0,
  "registerDeviceIdChangeListener(Ljava/util/concurrent/Executor;Ljava/util/function/IntConsumer;)V": () => {},
  "unregisterDeviceIdChangeListener(Ljava/util/function/IntConsumer;)V": () => {},
  "createDeviceContext(I)Landroid/content/Context;": function (this: JContext, id: number) {
    if (id !== 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Not a valid ID of the default device or any virtual device: " + id);
    return this;
  },
  "getSystemService(Ljava/lang/String;)Ljava/lang/Object;": function (this: JContext, name: string) {
    return systemService(this, name);
  },
  // An unregistered class has no service name, and AOSP answers null for it
  "getSystemService(Ljava/lang/Class;)Ljava/lang/Object;": function (this: JContext, cls: { ci?: { name?: string } } | null) {
    const name = SERVICE_NAME.get(cls?.ci?.name ?? "");
    if (!name) { rt.noteMissing("systemService " + cls?.ci?.name); return null; }
    return vcall(this, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", name);
  },
  "getSystemServiceName(Ljava/lang/Class;)Ljava/lang/String;": (cls: { ci?: { name?: string } } | null) => {
    const name = cls?.ci?.name ?? "";
    return SERVICE_NAME.get(name) ?? null;
  },
  "getSharedPreferences(Ljava/lang/String;I)Landroid/content/SharedPreferences;": function (this: JContext, name: string) {
    return getPrefs(this.$host.pkg, name);
  },
  "deleteSharedPreferences(Ljava/lang/String;)Z": function (this: JContext, name: string) { return +deletePrefs(this.$host.pkg, name); },
  "moveSharedPreferencesFrom(Landroid/content/Context;Ljava/lang/String;)Z": function (this: JContext, source: JContext, name: string) {
    if (!source || name == null) throw rt.mkThrowable("java/lang/NullPointerException", null);
    return movePrefs(source.$host.pkg, this.$host.pkg, name) ? 1 : 0;
  },
  // Context's resource getters are getResources().getX(id[, getTheme()]) in AOSP: both calls are
  // virtual, so an app's Resources or ContextWrapper subclass (a string store, a skin engine) answers them.
  "getString(I)Ljava/lang/String;": viaResources("getString", "(I)Ljava/lang/String;"),
  "getString(I[Ljava/lang/Object;)Ljava/lang/String;": viaResources("getString", "(I[Ljava/lang/Object;)Ljava/lang/String;"),
  "getText(I)Ljava/lang/CharSequence;": viaResources("getText", "(I)Ljava/lang/CharSequence;"),
  "getColor(I)I": viaResources("getColor", "(ILandroid/content/res/Resources$Theme;)I", true),
  "getColorStateList(I)Landroid/content/res/ColorStateList;": viaResources("getColorStateList", "(ILandroid/content/res/Resources$Theme;)Landroid/content/res/ColorStateList;", true),
  "getDrawable(I)Landroid/graphics/drawable/Drawable;": viaResources("getDrawable", "(ILandroid/content/res/Resources$Theme;)Landroid/graphics/drawable/Drawable;", true),
  "getAssets()Landroid/content/res/AssetManager;": function (this: JContext) {
    return vcall(this.$host.jresources, "getAssets", "()Landroid/content/res/AssetManager;");
  },
  "getClassLoader()Ljava/lang/ClassLoader;": function (this: JContext) { return this.packageLoader ?? systemClassLoader(); },
  "getPackageResourcePath()Ljava/lang/String;": function (this: JContext) { return getAppInfo(this.$host).sourceDir; },
  "getPackageCodePath()Ljava/lang/String;": function (this: JContext) { return getAppInfo(this.$host).sourceDir; },
  // AOSP's ensurePrivateDirExists: the directory exists once asked for (native code stat()s it)
  "getFilesDir()Ljava/io/File;": function (this: JContext) { return privDir(`/data/data/${this.$host.pkg}/files`); },
  "getDataDir()Ljava/io/File;": function (this: JContext) { return privDir(`/data/data/${this.$host.pkg}`); },
  "getCacheDir()Ljava/io/File;": function (this: JContext) { return privDir(`/data/data/${this.$host.pkg}/cache`); },
  "getCodeCacheDir()Ljava/io/File;": function (this: JContext) { return privDir(`/data/data/${this.$host.pkg}/code_cache`); },
  "getNoBackupFilesDir()Ljava/io/File;": function (this: JContext) { return privDir(`/data/data/${this.$host.pkg}/no_backup`); },
  "getExternalFilesDir(Ljava/lang/String;)Ljava/io/File;": function (this: JContext, type: string | null) { return extFilesDir(this, type); },
  "getExternalCacheDir()Ljava/io/File;": function (this: JContext) { return extCacheDir(this); },
  "getObbDir()Ljava/io/File;": function (this: JContext) { return obbDir(this); },
  // the array forms: one emulated volume, so each is the singleton of its scalar form
  "getExternalFilesDirs(Ljava/lang/String;)[Ljava/io/File;": async function (this: JContext, type: string | null) { return jarray([await extFilesDir(this, type)], "Ljava/io/File;"); },
  "getExternalCacheDirs()[Ljava/io/File;": async function (this: JContext) { return jarray([await extCacheDir(this)], "Ljava/io/File;"); },
  "getObbDirs()[Ljava/io/File;": async function (this: JContext) { return jarray([await obbDir(this)], "Ljava/io/File;"); },
  "getDir(Ljava/lang/String;I)Ljava/io/File;": function (this: JContext, name: string) {
    return privDir(`/data/data/${this.$host.pkg}/app_${name}`);
  },
  "getDatabasePath(Ljava/lang/String;)Ljava/io/File;": function (this: JContext, name: string) {
    return newFile(dbPath(this.$host.pkg, name));
  },
  "openOrCreateDatabase(Ljava/lang/String;ILandroid/database/sqlite/SQLiteDatabase$CursorFactory;)Landroid/database/sqlite/SQLiteDatabase;": contextOpenDatabase,
  "openOrCreateDatabase(Ljava/lang/String;ILandroid/database/sqlite/SQLiteDatabase$CursorFactory;Landroid/database/DatabaseErrorHandler;)Landroid/database/sqlite/SQLiteDatabase;": contextOpenDatabase,
  "databaseList()[Ljava/lang/String;": function (this: JContext) {
    return jarray(vfs.list(`/data/data/${this.$host.pkg}/databases`), "Ljava/lang/String;");
  },
  "fileList()[Ljava/lang/String;": function (this: JContext) {
    return jarray(vfs.list(`/data/data/${this.$host.pkg}/files`), "Ljava/lang/String;");
  },
  "getFileStreamPath(Ljava/lang/String;)Ljava/io/File;": function (this: JContext, name: string) {
    privDir(`/data/data/${this.$host.pkg}/files`);
    return newFile(`/data/data/${this.$host.pkg}/files/${name}`);
  },
  "openFileInput(Ljava/lang/String;)Ljava/io/FileInputStream;": function (this: JContext, name: string) {
    return newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", `/data/data/${this.$host.pkg}/files/${name}`);
  },
  // ContextImpl creates the files directory on first use; MODE_APPEND is 0x8000
  "openFileOutput(Ljava/lang/String;I)Ljava/io/FileOutputStream;": function (this: JContext, name: string, mode: number) {
    vfs.mkdir(`/data/data/${this.$host.pkg}/files`);
    return newObj("java/io/FileOutputStream", "(Ljava/lang/String;Z)V", `/data/data/${this.$host.pkg}/files/${name}`, mode & 0x8000 ? 1 : 0);
  },
  "deleteFile(Ljava/lang/String;)Z": function (this: JContext, name: string) {
    return vfs.delete(`/data/data/${this.$host.pkg}/files/${name}`) ? 1 : 0;
  },
  "deleteDatabase(Ljava/lang/String;)Z": function (this: JContext, name: string) {
    return vfs.delete(dbPath(this.$host.pkg, name)) ? 1 : 0;
  },
  "checkSelfPermission(Ljava/lang/String;)I": permissionState,
  "checkUriPermission(Landroid/net/Uri;III)I": checkUriPermission,
  "checkCallingOrSelfUriPermission(Landroid/net/Uri;I)I": (uri: JUri, modes: number) =>
    checkUriPermission(uri, PROCESS_PID, PROCESS_UID, modes),
  "grantUriPermission(Ljava/lang/String;Landroid/net/Uri;I)V": grantUriPermission,
  "revokeUriPermission(Landroid/net/Uri;I)V": revokeUriPermission,
  "checkPermission(Ljava/lang/String;II)I": permissionState,
  "checkCallingPermission(Ljava/lang/String;)I": permissionState,
  "checkCallingOrSelfPermission(Ljava/lang/String;)I": permissionState,
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;)Landroid/content/Intent;": contextRegisterReceiver,
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;I)Landroid/content/Intent;": contextRegisterReceiver,
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;Ljava/lang/String;Landroid/os/Handler;)Landroid/content/Intent;": contextRegisterReceiverOn,
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;Ljava/lang/String;Landroid/os/Handler;I)Landroid/content/Intent;": contextRegisterReceiverOn,
  "unregisterReceiver(Landroid/content/BroadcastReceiver;)V": unregisterReceiver,
  "sendBroadcast(Landroid/content/Intent;)V": function (this: JContext, intent: JIntent) { sendBroadcast(this, intent); },
  "sendBroadcast(Landroid/content/Intent;Ljava/lang/String;)V": function (this: JContext, intent: JIntent, permission: string | null) { sendBroadcast(this, intent, permission); },
  "sendOrderedBroadcast(Landroid/content/Intent;Ljava/lang/String;)V": function (this: JContext, intent: JIntent, permission: string | null) { sendBroadcast(this, intent, permission, true); },
  "startService(Landroid/content/Intent;)Landroid/content/ComponentName;": function (this: JContext, intent: JIntent) {
    return svcStart(this, intent, false);
  },
  "startForegroundService(Landroid/content/Intent;)Landroid/content/ComponentName;": function (this: JContext, intent: JIntent) {
    return svcStart(this, intent, true);
  },
  "stopService(Landroid/content/Intent;)Z": (intent: JIntent) => svcStop(intent?.component),
  "bindService(Landroid/content/Intent;Landroid/content/ServiceConnection;I)Z": function (this: JContext, intent: JIntent, connection: unknown, flags: number) { return svcBind(this, intent, connection, flags); },
  "bindService(Landroid/content/Intent;ILjava/util/concurrent/Executor;Landroid/content/ServiceConnection;)Z": function (this: JContext, intent: JIntent, flags: number, executor: unknown, connection: unknown) {
    if (!executor) throw rt.mkThrowable("java/lang/NullPointerException", "executor");
    return svcBind(this, intent, connection, flags, executor);
  },
  "unbindService(Landroid/content/ServiceConnection;)V": svcUnbind,
  "startIntentSender(Landroid/content/IntentSender;Landroid/content/Intent;III)V": contextSender,
  "startIntentSender(Landroid/content/IntentSender;Landroid/content/Intent;IIILandroid/os/Bundle;)V": contextSender,
  "startActivity(Landroid/content/Intent;)V": contextStartActivity,
  "startActivity(Landroid/content/Intent;Landroid/os/Bundle;)V": contextStartActivity,
  "startActivities([Landroid/content/Intent;)V": contextStartActivities,
  "startActivities([Landroid/content/Intent;Landroid/os/Bundle;)V": contextStartActivities,
  "obtainStyledAttributes([I)Landroid/content/res/TypedArray;": function (this: JContext, attrs: Int32Array) { return contextStyled.call(this, null, attrs); },
  "obtainStyledAttributes(Landroid/util/AttributeSet;[I)Landroid/content/res/TypedArray;": contextStyled,
  "obtainStyledAttributes(Landroid/util/AttributeSet;[III)Landroid/content/res/TypedArray;": contextStyled,
  "obtainStyledAttributes(I[I)Landroid/content/res/TypedArray;": function (this: JContext, styleId: number, attrs: Int32Array) {
    return after(vcall(this, "getTheme", "()Landroid/content/res/Resources$Theme;"), (theme) =>
      vcall(theme, "obtainStyledAttributes", "(I[I)Landroid/content/res/TypedArray;", styleId, attrs));
  },
  "createConfigurationContext(Landroid/content/res/Configuration;)Landroid/content/Context;": function (this: JContext, config: unknown) {
    return configurationContext(this, config);
  },
  "createDeviceProtectedStorageContext()Landroid/content/Context;": function (this: JContext) { return this; },
  ...noops("registerComponentCallbacks(Landroid/content/ComponentCallbacks;)V",
    "unregisterComponentCallbacks(Landroid/content/ComponentCallbacks;)V", "<init>()V",
    "enforceCallingOrSelfPermission(Ljava/lang/String;Ljava/lang/String;)V"),
  "getAttributionTag()Ljava/lang/String;": function (this: JContext) { return this.attributionTag; },
  ...stubs(0, "isDeviceProtectedStorage()Z", "isRestricted()Z"),
  // ContextImpl's test; no context here is created with CONTEXT_IGNORE_SECURITY
  "canLoadUnsafeResources()Z": driven(function* (this: JContext): Gen {
    const pkg: string = yield vcall(this, "getPackageName", "()Ljava/lang/String;");
    return pkg === (yield vcall(this, "getOpPackageName", "()Ljava/lang/String;")) ? 1 : 0;
  }),
};

rt.register({ name: "android/content/Context", ctor: JContext, methods: contextMethods,
  statics: { LAYOUT_INFLATER_SERVICE: "layout_inflater", WINDOW_SERVICE: "window", INPUT_METHOD_SERVICE: "input_method", CONNECTIVITY_SERVICE: "connectivity", ACTIVITY_SERVICE: "activity", GAME_SERVICE: "game", ACCOUNT_SERVICE: "account", NOTIFICATION_SERVICE: "notification", ALARM_SERVICE: "alarm", POWER_SERVICE: "power", VIBRATOR_SERVICE: "vibrator", AUDIO_SERVICE: "audio", CLIPBOARD_SERVICE: "clipboard", USER_SERVICE: "user", LOCATION_SERVICE: "location", SENSOR_SERVICE: "sensor", MEDIA_ROUTER_SERVICE: "media_router", MEDIA_METRICS_SERVICE: "media_metrics", TELEPHONY_SERVICE: "phone", WIFI_SERVICE: "wifi", DISPLAY_SERVICE: "display", CAMERA_SERVICE: "camera", INPUT_SERVICE: "input", STORAGE_SERVICE: "storage", BATTERY_SERVICE: "batterymanager", KEYGUARD_SERVICE: "keyguard", ACCESSIBILITY_SERVICE: "accessibility", JOB_SCHEDULER_SERVICE: "jobscheduler", UI_MODE_SERVICE: "uimode", DOWNLOAD_SERVICE: "download", MODE_PRIVATE: 0, BIND_AUTO_CREATE: 1 } });

export class JContextWrapper extends JContext { base: JContext | null = null; }
class JAttributionContext extends JContextWrapper {}
const configurationContext = driven(function* (source: JContext, config: unknown): Gen<JContext> {
  const jresources = yield configuredResources(source.$host.jresources, config);
  const theme: JTheme = yield newTheme(jresources, themeOf(source) ?? source.$host.theme, 0);
  return newContextImpl(Object.assign(Object.create(source.$host), { res: nativeRes(jresources), jresources, theme }));
});
class JWindowContext extends JContextWrapper { windowType = 0; windowManager: unknown = null; }
rt.register({ name: "android/app/ContextImpl", ctor: JContextImpl, sup: "android/content/Context", fields: { mResources: "resources" }, methods: {
  "getResources()Landroid/content/res/Resources;": function (this: JContextImpl) { return this.resources; },
} });
rt.register({ name: "webdroid/DisplayContext", ctor: JDisplayContext, sup: "android/app/ContextImpl", methods: {
  "getDisplay()Landroid/view/Display;": function (this: JDisplayContext) { return this.display; },
  "isUiContext()Z": () => 0,
} });
rt.register({ name: "android/window/WindowContext", ctor: JWindowContext, sup: "android/content/ContextWrapper", methods: {
  "getDisplay()Landroid/view/Display;": function (this: JWindowContext) { return vcall(this.base, "getDisplay", "()Landroid/view/Display;"); },
  "isUiContext()Z": () => 1,
  "getSystemService(Ljava/lang/String;)Ljava/lang/Object;": function (this: JWindowContext, name: string) {
    return name === "window" ? this.windowManager ??= rt.make("android/view/WindowManagerImpl") : systemService(this, name);
  },
} });
function attachBase(this: JContextWrapper, base: JContext) {
  this.base = base;
  if (base) this.$host = base.$host;
}
// ContextWrapper/ContextThemeWrapper/Application/Service all delegate to a base context
/** ContextWrapper's entry for a getter AOSP forwards to mBase: the base's virtual entry answers when
 *  an app subclass overrides it there (a Resources proxy installed by attachBaseContext, a skin engine);
 *  the platform's own implementation is reached directly, without a second dispatch. */
const viaBase = (name: string, desc: string) => {
  const mangled = mangleMethod(name, desc), own = contextMethods[name + desc] as (...a: unknown[]) => unknown;
  return function (this: JContextWrapper, ...args: unknown[]) {
    const impl = (this.base as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined> | null)?.[mangled];
    return impl === undefined || impl === own ? own.apply(this, args) : impl.apply(this.base, args);
  };
};
export const wrapperMethods: NativeSpec["methods"] = {
  ...contextMethods,
  "attachBaseContext(Landroid/content/Context;)V": attachBase,
  "getBaseContext()Landroid/content/Context;": function (this: JContextWrapper) { return this.base; },
  ...Object.fromEntries(["getResources()Landroid/content/res/Resources;", "getAssets()Landroid/content/res/AssetManager;",
    "getSystemService(Ljava/lang/String;)Ljava/lang/Object;", "getClassLoader()Ljava/lang/ClassLoader;",
    "getApplicationContext()Landroid/content/Context;", "getPackageManager()Landroid/content/pm/PackageManager;",
    "getAttributionTag()Ljava/lang/String;", "getAttributionSource()Landroid/content/AttributionSource;",
    "getSharedPreferences(Ljava/lang/String;I)Landroid/content/SharedPreferences;"].map((sig) => {
    const i = sig.indexOf("(");
    return [sig, viaBase(sig.slice(0, i), sig.slice(i))];
  })),
};
rt.register({
  name: "android/content/ContextWrapper", ctor: JContextWrapper, sup: "android/content/Context",
  methods: { ...without(wrapperMethods, ["<init>()V"]), "<init>(Landroid/content/Context;)V": attachBase },
});
rt.register({ name: "webdroid/AttributionContext", ctor: JAttributionContext, sup: "android/content/ContextWrapper", methods: {
  ...wrapperMethods,
  "getAttributionTag()Ljava/lang/String;": function (this: JAttributionContext) { return this.attributionTag; },
  "getAttributionSource()Landroid/content/AttributionSource;": contextAttributionSource,
  "getDisplay()Landroid/view/Display;": function (this: JAttributionContext) { return vcall(this.base, "getDisplay", "()Landroid/view/Display;"); },
  "isUiContext()Z": function (this: JAttributionContext) { return vcall(this.base, "isUiContext", "()Z"); },
} });
rt.register({
  name: "android/content/MutableContextWrapper", ctor: class extends JContextWrapper {}, sup: "android/content/ContextWrapper",
  methods: { ...without(wrapperMethods, ["<init>()V"]), "<init>(Landroid/content/Context;)V": attachBase, "setBaseContext(Landroid/content/Context;)V": attachBase },
});
export class JContextThemeWrapper extends JContextWrapper { overrideResources: unknown = null; }
const resourcesViaBase = wrapperMethods["getResources()Landroid/content/res/Resources;"] as (this: JContextWrapper) => unknown;
/** ContextThemeWrapper's getResources: the override configuration's Resources once one is applied */
export const themeWrapperMethods: NativeSpec["methods"] = {
  ...wrapperMethods,
  "getResources()Landroid/content/res/Resources;": function (this: JContextThemeWrapper) { return this.overrideResources ?? resourcesViaBase.call(this); },
  "applyOverrideConfiguration(Landroid/content/res/Configuration;)V": function (this: JContextThemeWrapper, config: unknown) {
    return after(configurationContext(this, config), (context) => {
      this.$host = context.$host;
      this.overrideResources = this.$host.jresources;
    });
  },
};
rt.register({
  name: "android/view/ContextThemeWrapper", ctor: JContextThemeWrapper, sup: "android/content/ContextWrapper",
  methods: {
    ...themeWrapperMethods,
    "<init>(Landroid/content/Context;I)V": function (this: JContextWrapper, base: JContext, themeId: number) {
      attachBase.call(this, base);
      if (themeId) return callSelf(contextMethods, "setTheme(I)V", this, themeId);
    },
    "<init>(Landroid/content/Context;Landroid/content/res/Resources$Theme;)V": function (this: JContextWrapper, base: JContext, theme: unknown) {
      attachBase.call(this, base);
      if (theme) (this as { ownTheme?: unknown }).ownTheme = nativeTheme(theme);
    },
  },
});
