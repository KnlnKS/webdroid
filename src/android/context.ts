import { type JFile, vfs, mkFile } from "../jvm/natives/jio";
import { JObj, rt, type NativeSpec, callSelf, stubs, noops } from "../jvm/runtime";
import { type AppHost, appHost } from "./apphost";
import { resString, themeOf, JTheme, obtainStyled, resolveStyleValue, type JAttrSet, JTypedArray } from "./res";
import { newObj, vcall, systemClassLoader } from "../jvm/natives/jlang";
import { mangleMethod, jarray } from "../jvm/abi";
import { getInflater } from "./inflate";
import { getAppInfo, getPM } from "./pm";
import { contentResolver, checkUriPermission } from "./contentresolver";
import { mainLooper, mainExecutor, PROCESS_PID, PROCESS_UID } from "./os";
import { getPrefs, movePrefs, deletePrefs } from "./sharedprefs";
import { JAssetManager, type JConfiguration, scopedResources } from "./resnative";
import { dbPath, openDatabase } from "./sqlite";
import { type JIntent, launchIntent } from "./intent";
import { type JIntentSender, startIntentSender } from "./pendingintent";
import { svcStart, svcStop, svcBind, svcUnbind } from "./runningservices";
import { registerReceiver, unregisterReceiver, sendBroadcast } from "./broadcast";
import { packages } from "./packages";
import type { JClassLoader } from "../jvm/natives/jlang";
import { mkJResources } from "./resnative";

const privDir = (p: string): JFile => { vfs.mkdir(p); return mkFile(p); };

export class JContext extends JObj {
  declare $host: AppHost;
  packageLoader: JClassLoader | null = null;
}
class JDisplayContext extends JContext { display: unknown = null; }
function contextForDisplay(source: JContext, display: unknown, windowType?: number) {
  if (display == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Display must not be null");
  const context: JDisplayContext = rt.make("webdroid/DisplayContext");
  context.$host = source.$host; context.packageLoader = source.packageLoader; context.display = display;
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
/** a Context getter that is getResources().name(args[, getTheme()]) through the virtual entries */
const viaResources = (name: string, desc: string, themed = false) => async function (this: JContext, ...args: unknown[]) {
  const resources = await vcall(this, "getResources", "()Landroid/content/res/Resources;");
  if (themed) args.push(await vcall(this, "getTheme", "()Landroid/content/res/Resources$Theme;"));
  return vcall(resources, name, desc, ...args);
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
const permissionState = (name: string) => {
  const pkg = appHost?.pkg ?? "";
  return RUNTIME_PERMISSIONS.has(name) && !permissionStore.get(pkg).has(name) && !packages.get(pkg)?.grants.has(name) ? -1 : 0;
};
export function grantPermissions(names: string[]): Int32Array {
  permissionStore.grant(appHost?.pkg ?? "", names);
  return new Int32Array(names.length);
}

// Context.XXX_SERVICE name → the manager class; getSystemService(Class) walks it backwards.
const SERVICE_CLASS: Record<string, string> = {
  window: "android/view/WindowManagerImpl",
  input_method: "android/view/inputmethod/InputMethodManager",
  connectivity: "android/net/ConnectivityManager",
  activity: "android/app/ActivityManager",
  game: "android/app/GameManager",
  account: "android/accounts/AccountManager",
  power: "android/os/PowerManager",
  input: "android/hardware/input/InputManager",
  media_router: "android/media/MediaRouter",
  vibrator: "android/os/Vibrator",
  vibrator_manager: "android/os/VibratorManager",
  audio: "android/media/AudioManager",
  phone: "android/telephony/TelephonyManager",
  notification: "android/app/NotificationManager",
  alarm: "android/app/AlarmManager",
  clipboard: "android/content/ClipboardManager",
  uimode: "android/app/UiModeManager",
  accessibility: "android/view/accessibility/AccessibilityManager",
  captioning: "android/view/accessibility/CaptioningManager",
  keyguard: "android/app/KeyguardManager",
  jobscheduler: "android/app/job/JobScheduler",
  sensor: "android/hardware/SensorManager",
  camera: "android/hardware/camera2/CameraManager",
  fingerprint: "android/hardware/fingerprint/FingerprintManager",
  usb: "android/hardware/usb/UsbManager",
  location: "android/location/LocationManager",
  batterymanager: "android/os/BatteryManager",
  display: "android/hardware/display/DisplayManager",
  autofill: "android/view/autofill/AutofillManager",
  textservices: "android/view/textservice/TextServicesManager",
  user: "android/os/UserManager",
  restrictions: "android/content/RestrictionsManager",
  appwidget: "android/appwidget/AppWidgetManager",
  shortcut: "android/content/pm/ShortcutManager",
  appops: "android/app/AppOpsManager",
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
};
const SERVICE_NAME = new Map(Object.entries(SERVICE_CLASS).map(([n, c]) => [c, n]));
SERVICE_NAME.set("android/view/WindowManager", "window");
export function systemService(jctx: JContext | null, name: string): unknown {
  if (name === "layout_inflater") return getInflater(jctx);
  if (name === "storagestats") return null;
  let s = services.get(name);
  if (s) return s;
  const cls = SERVICE_CLASS[name];
  // A service we do not model is one this device does not have: AOSP returns null, and callers
  // handle that. Handing back a stand-in object instead only moved the failure to their cast.
  if (!cls) { rt.noteMissing("systemService " + name); return null; }
  s = rt.make(cls);
  services.set(name, s);
  return s;
}

// API 31: a context's own AttributionSource is this process; a provider's caller may be another
let attribution: unknown;
export class JAttributionSource extends JObj { uid = PROCESS_UID; pid = PROCESS_PID; pkg: string | null = null; }
rt.register({
  name: "android/content/AttributionSource", ctor: JAttributionSource, ifaces: ["android/os/Parcelable"],
  methods: {
    "getUid()I": function (this: JAttributionSource) { return this.uid; },
    "getPid()I": function (this: JAttributionSource) { return this.pid; },
    "getPackageName()Ljava/lang/String;": function (this: JAttributionSource) { return this.pkg ?? appHost!.pkg; },
    ...stubs(null, "getAttributionTag()Ljava/lang/String;", "getNext()Landroid/content/AttributionSource;"),
    ...stubs(1, "isTrusted(Landroid/content/Context;)Z"),
    ...stubs(0, "describeContents()I"),
  },
});

// ── Context methods (shared by Context/ContextWrapper/Activity/Application)
function contextOpenDatabase(this: JContext, name: string) {
  const path = dbPath(this.$host.pkg, name);
  vfs.mkdir(path.slice(0, path.lastIndexOf("/")));
  return openDatabase(path);
}
export const contextMethods: NativeSpec["methods"] = {
  "getResources()Landroid/content/res/Resources;": function (this: JContext) { return this.$host.jresources; },
  "getTheme()Landroid/content/res/Resources$Theme;": function (this: JContext) {
    return themeOf(this) ?? this.$host.theme;
  },
  // AOSP layers the style over whatever theme this context already resolves to, so a
  // ThemeOverlay on an already-themed context keeps everything underneath it
  "setTheme(I)V": function (this: JContext, id: number) {
    const t = new JTheme();
    t.res = this.$host.res;
    t.styles = (themeOf(this) ?? this.$host.theme).styles.slice();
    const applied = t.apply(id);
    (this as any).ownTheme = t;
    return applied;
  },
  "getPackageName()Ljava/lang/String;": function (this: JContext) { return this.$host.pkg; },
  "getAttributionSource()Landroid/content/AttributionSource;": function (this: JContext) { return attribution ??= newObj("android/content/AttributionSource", null); },
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
        const context = new JContext(), theme = new JTheme();
        theme.res = record.res;
        if (info.theme) await theme.apply(info.theme);
        context.$host = { ...caller, pkg, res: record.res, zip: record.res.zip,
          jresources: mkJResources(record.res, false), theme, themeResId: info.theme, iconRes: info.icon, splits: [] };
        if (flags & 1) context.packageLoader = await newObj("webdroid/PackageClassLoader", "(Ljava/lang/String;)V", record.path);
        return context;
      })();
      packageContexts.set(key, ready);
      void ready.catch(() => packageContexts.delete(key));
    }
    return ready;
  },
  "getOpPackageName()Ljava/lang/String;": function (this: JContext) { return this.$host.pkg; },
  "getApplicationContext()Landroid/content/Context;": function (this: JContext) { return this.$host.application; },
  // API 31. Everything here draws into the one window, but the application context is not a
  // display context on a device and callers branch on that.
  "isUiContext()Z": function (this: JContext) { return this === this.$host.application ? 0 : 1; },
  "getDisplay()Landroid/view/Display;": async function (this: JContext) {
    if (this === this.$host.application) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Context is not associated with a display");
    return display();
  },
  "createDisplayContext(Landroid/view/Display;)Landroid/content/Context;": function (this: JContext, display: unknown) { return contextForDisplay(this, display); },
  "createWindowContext(Landroid/view/Display;ILandroid/os/Bundle;)Landroid/content/Context;": function (this: JContext, display: unknown, type: number) { return contextForDisplay(this, display, type); },
  "createWindowContext(ILandroid/os/Bundle;)Landroid/content/Context;": async function (this: JContext, type: number) {
    return contextForDisplay(this, await vcall(this, "getDisplay", "()Landroid/view/Display;"), type);
  },
  "getApplicationInfo()Landroid/content/pm/ApplicationInfo;": function (this: JContext) {
    return this.$host === appHost ? getAppInfo(this.$host) : vcall(getPM(), "getApplicationInfo", "(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;", this.$host.pkg, 128);
  },
  "getPackageManager()Landroid/content/pm/PackageManager;": function () { return getPM(); },
  "getContentResolver()Landroid/content/ContentResolver;": function () { return contentResolver(); },
  "getMainLooper()Landroid/os/Looper;": () => mainLooper,
  "getMainExecutor()Ljava/util/concurrent/Executor;": mainExecutor,
  "getSystemService(Ljava/lang/String;)Ljava/lang/Object;": function (this: JContext, name: string) {
    return systemService(this, name);
  },
  "getSystemService(Ljava/lang/Class;)Ljava/lang/Object;": function (this: JContext, cls: any) {
    const n = cls?.ci?.name ?? "";
    return vcall(this, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", SERVICE_NAME.get(n) ?? n.split("/").pop() ?? "");
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
    const a = new JAssetManager();
    a.host = this.$host.res;
    return a;
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
  "getExternalFilesDir(Ljava/lang/String;)Ljava/io/File;": function (this: JContext, type: string | null) {
    return privDir(`/sdcard/Android/data/${this.$host.pkg}/files` + (type ? "/" + type : ""));
  },
  // the array forms: one emulated volume, so each is the singleton of its scalar form
  "getExternalFilesDirs(Ljava/lang/String;)[Ljava/io/File;": function (this: JContext, type: string | null) {
    return jarray([privDir(`/sdcard/Android/data/${this.$host.pkg}/files` + (type ? "/" + type : ""))], "Ljava/io/File;");
  },
  "getExternalCacheDir()Ljava/io/File;": function (this: JContext) {
    return privDir(`/sdcard/Android/data/${this.$host.pkg}/cache`);
  },
  "getExternalCacheDirs()[Ljava/io/File;": function (this: JContext) {
    return jarray([privDir(`/sdcard/Android/data/${this.$host.pkg}/cache`)], "Ljava/io/File;");
  },
  "getObbDir()Ljava/io/File;": function (this: JContext) { return privDir(`/sdcard/Android/obb/${this.$host.pkg}`); },
  "getObbDirs()[Ljava/io/File;": function (this: JContext) { return jarray([privDir(`/sdcard/Android/obb/${this.$host.pkg}`)], "Ljava/io/File;"); },
  "getDir(Ljava/lang/String;I)Ljava/io/File;": function (this: JContext, name: string) {
    return privDir(`/data/data/${this.$host.pkg}/app_${name}`);
  },
  "getDatabasePath(Ljava/lang/String;)Ljava/io/File;": function (this: JContext, name: string) {
    return mkFile(dbPath(this.$host.pkg, name));
  },
  "openOrCreateDatabase(Ljava/lang/String;ILandroid/database/sqlite/SQLiteDatabase$CursorFactory;)Landroid/database/sqlite/SQLiteDatabase;": contextOpenDatabase,
  "openOrCreateDatabase(Ljava/lang/String;ILandroid/database/sqlite/SQLiteDatabase$CursorFactory;Landroid/database/DatabaseErrorHandler;)Landroid/database/sqlite/SQLiteDatabase;": contextOpenDatabase,
  "databaseList()[Ljava/lang/String;": function (this: JContext) {
    return jarray(vfs.list(`/data/data/${this.$host.pkg}/databases`), "Ljava/lang/String;");
  },
  "getFileStreamPath(Ljava/lang/String;)Ljava/io/File;": function (this: JContext, name: string) {
    privDir(`/data/data/${this.$host.pkg}/files`);
    return mkFile(`/data/data/${this.$host.pkg}/files/${name}`);
  },
  "openFileInput(Ljava/lang/String;)Ljava/io/FileInputStream;": function (this: JContext, name: string) {
    return newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", `/data/data/${this.$host.pkg}/files/${name}`);
  },
  "openFileOutput(Ljava/lang/String;I)Ljava/io/FileOutputStream;": function (this: JContext, name: string) {
    return newObj("java/io/FileOutputStream", "(Ljava/lang/String;)V", `/data/data/${this.$host.pkg}/files/${name}`);
  },
  "deleteFile(Ljava/lang/String;)Z": function (this: JContext, name: string) {
    return vfs.delete(`/data/data/${this.$host.pkg}/files/${name}`) ? 1 : 0;
  },
  "deleteDatabase(Ljava/lang/String;)Z": function (this: JContext, name: string) {
    return vfs.delete(dbPath(this.$host.pkg, name)) ? 1 : 0;
  },
  "checkSelfPermission(Ljava/lang/String;)I": (p: string) => permissionState(p),
  "checkUriPermission(Landroid/net/Uri;III)I": checkUriPermission,
  "checkPermission(Ljava/lang/String;)I": (p: string) => permissionState(p),
  "checkPermission(Ljava/lang/String;II)I": (p: string) => permissionState(p),
  "checkCallingPermission(Ljava/lang/String;)I": (p: string) => permissionState(p),
  "checkCallingOrSelfPermission(Ljava/lang/String;)I": (p: string) => permissionState(p),
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;)Landroid/content/Intent;": function (this: JContext, receiver: JObj | null, filter: { actions: string[] }) { return registerReceiver(this, receiver, filter); },
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;I)Landroid/content/Intent;": function (this: JContext, receiver: JObj | null, filter: { actions: string[] }) { return registerReceiver(this, receiver, filter); },
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;Ljava/lang/String;Landroid/os/Handler;)Landroid/content/Intent;": function (this: JContext, receiver: JObj | null, filter: { actions: string[] }, _permission: string, handler: unknown) { return registerReceiver(this, receiver, filter, handler); },
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;Ljava/lang/String;Landroid/os/Handler;I)Landroid/content/Intent;": function (this: JContext, receiver: JObj | null, filter: { actions: string[] }, _permission: string, handler: unknown) { return registerReceiver(this, receiver, filter, handler); },
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
  "bindService(Landroid/content/Intent;Landroid/content/ServiceConnection;I)Z": async function (this: JContext, intent: JIntent, connection: unknown, flags: number) { return svcBind(this, intent, connection, flags); },
  "bindService(Landroid/content/Intent;ILjava/util/concurrent/Executor;Landroid/content/ServiceConnection;)Z": async function (this: JContext, intent: JIntent, flags: number, executor: unknown, connection: unknown) {
    if (!executor) throw rt.mkThrowable("java/lang/NullPointerException", "executor");
    return svcBind(this, intent, connection, flags, executor);
  },
  "unbindService(Landroid/content/ServiceConnection;)V": svcUnbind,
  "startIntentSender(Landroid/content/IntentSender;Landroid/content/Intent;III)V": function (this: JContext, sender: JIntentSender, fill: JIntent | null) { return startIntentSender(this, sender, fill); },
  "startIntentSender(Landroid/content/IntentSender;Landroid/content/Intent;IIILandroid/os/Bundle;)V": function (this: JContext, sender: JIntentSender, fill: JIntent | null) { return startIntentSender(this, sender, fill); },
  "startActivity(Landroid/content/Intent;)V": async function (this: JContext, intent: JIntent) {
    await launchIntent(this.$host, intent);
  },
  "startActivity(Landroid/content/Intent;Landroid/os/Bundle;)V": async function (this: JContext, intent: JIntent) {
    await launchIntent(this.$host, intent);
  },
  // AOSP's Context.obtainStyledAttributes delegates to getTheme(). Reading the application
  // theme instead loses every ThemeOverlay — which is how Material passes a widget its shape
  // and colours — and resolves `?attr` references against the wrong stack.
  "obtainStyledAttributes([I)Landroid/content/res/TypedArray;": function (this: JContext, attrs: Int32Array) {
    return obtainStyled(this.$host.res, themeOf(this) ?? this.$host.theme, null, attrs, 0, 0);
  },
  "obtainStyledAttributes(Landroid/util/AttributeSet;[I)Landroid/content/res/TypedArray;":
    function (this: JContext, set: JAttrSet | null, attrs: Int32Array) {
      return obtainStyled(this.$host.res, themeOf(this) ?? this.$host.theme, set, attrs, 0, 0);
    },
  "obtainStyledAttributes(Landroid/util/AttributeSet;[III)Landroid/content/res/TypedArray;":
    function (this: JContext, set: JAttrSet | null, attrs: Int32Array, dsa: number, dsr: number) {
      return obtainStyled(this.$host.res, themeOf(this) ?? this.$host.theme, set, attrs, dsa, dsr);
    },
  "obtainStyledAttributes(I[I)Landroid/content/res/TypedArray;": function (this: JContext, styleId: number, attrs: Int32Array) {
    const theme = themeOf(this) ?? this.$host.theme;
    const ta = new JTypedArray();
    ta.res = this.$host.res;
    ta.theme = theme;
    ta.attrIds = attrs;
    ta.vals = [...attrs].map(a => resolveStyleValue(ta.res, theme, ta.res.styleLookup(styleId, a)));
    return ta;
  },
  "createConfigurationContext(Landroid/content/res/Configuration;)Landroid/content/Context;": function (this: JContext, config: JConfiguration) {
    return configurationContext(this, config);
  },
  "createDeviceProtectedStorageContext()Landroid/content/Context;": function (this: JContext) { return this; },
  ...noops("registerComponentCallbacks(Landroid/content/ComponentCallbacks;)V",
    "unregisterComponentCallbacks(Landroid/content/ComponentCallbacks;)V", "<init>()V",
    "enforceCallingOrSelfPermission(Ljava/lang/String;Ljava/lang/String;)V"),
  ...stubs(null, "getAttributionTag()Ljava/lang/String;"),
  ...stubs(0, "isDeviceProtectedStorage()Z", "isRestricted()Z"),
};

rt.register({ name: "android/content/Context", ctor: JContext, methods: contextMethods,
  statics: { LAYOUT_INFLATER_SERVICE: "layout_inflater", WINDOW_SERVICE: "window", INPUT_METHOD_SERVICE: "input_method", CONNECTIVITY_SERVICE: "connectivity", ACTIVITY_SERVICE: "activity", GAME_SERVICE: "game", ACCOUNT_SERVICE: "account", NOTIFICATION_SERVICE: "notification", ALARM_SERVICE: "alarm", POWER_SERVICE: "power", VIBRATOR_SERVICE: "vibrator", AUDIO_SERVICE: "audio", CLIPBOARD_SERVICE: "clipboard", USER_SERVICE: "user", LOCATION_SERVICE: "location", SENSOR_SERVICE: "sensor", MEDIA_ROUTER_SERVICE: "media_router", TELEPHONY_SERVICE: "phone", WIFI_SERVICE: "wifi", DISPLAY_SERVICE: "display", CAMERA_SERVICE: "camera", INPUT_SERVICE: "input", STORAGE_SERVICE: "storage", BATTERY_SERVICE: "batterymanager", KEYGUARD_SERVICE: "keyguard", ACCESSIBILITY_SERVICE: "accessibility", JOB_SCHEDULER_SERVICE: "jobscheduler", UI_MODE_SERVICE: "uimode", DOWNLOAD_SERVICE: "download", MODE_PRIVATE: 0, BIND_AUTO_CREATE: 1 } });

export class JContextWrapper extends JContext { base: JContext | null = null; }
function configurationContext(source: JContext, config: JConfiguration): JContext {
  const jresources = scopedResources(source.$host.res, config), theme = new JTheme();
  theme.res = jresources.host;
  theme.styles = (themeOf(source) ?? source.$host.theme).styles.slice();
  const context = new JContext();
  context.$host = Object.assign(Object.create(source.$host), { res: jresources.host, jresources, theme });
  return context;
}
class JWindowContext extends JContextWrapper { windowType = 0; windowManager: unknown = null; }
rt.register({ name: "webdroid/DisplayContext", ctor: JDisplayContext, sup: "android/content/Context", methods: {
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
    "getSharedPreferences(Ljava/lang/String;I)Landroid/content/SharedPreferences;"].map((sig) => {
    const i = sig.indexOf("(");
    return [sig, viaBase(sig.slice(0, i), sig.slice(i))];
  })),
};
rt.register({
  name: "android/content/ContextWrapper", ctor: JContextWrapper, sup: "android/content/Context",
  methods: { ...wrapperMethods, "<init>(Landroid/content/Context;)V": attachBase },
});
rt.register({
  name: "android/content/MutableContextWrapper", ctor: class extends JContextWrapper {}, sup: "android/content/ContextWrapper",
  methods: { ...wrapperMethods, "<init>(Landroid/content/Context;)V": attachBase, "setBaseContext(Landroid/content/Context;)V": attachBase },
});
rt.register({
  name: "android/view/ContextThemeWrapper", ctor: class extends JContextWrapper {}, sup: "android/content/ContextWrapper",
  methods: {
    ...wrapperMethods,
    "<init>(Landroid/content/Context;)V": attachBase,
    "<init>(Landroid/content/Context;I)V": function (this: JContextWrapper, base: JContext, themeId: number) {
      attachBase.call(this, base);
      if (themeId) callSelf(contextMethods, "setTheme(I)V", this, themeId);
    },
    "<init>(Landroid/content/Context;Landroid/content/res/Resources$Theme;)V": function (this: JContextWrapper, base: JContext, theme: unknown) {
      attachBase.call(this, base);
      if (theme) (this as { ownTheme?: unknown }).ownTheme = theme;
    },
    "applyOverrideConfiguration(Landroid/content/res/Configuration;)V": function (this: JContextWrapper, config: JConfiguration) {
      this.$host = configurationContext(this, config).$host;
    },
  },
});
