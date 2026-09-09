import { type JFile, vfs, mkFile } from "../jvm/natives/jio";
import { JObj, rt, type NativeSpec, callSelf, maySuspend } from "../jvm/runtime";
import { type AppHost, appHost } from "./apphost";
import { resString, themeOf, JTheme, rvColor, obtainStyled, type JAttrSet, JTypedArray } from "./res";
import { newObj, javaFormat } from "../jvm/natives/jlang";
import { mangleMethod, jarray } from "../jvm/abi";
import { getInflater } from "./inflate";
import { getAppInfo, getPM } from "./pm";
import { contentResolver } from "./contentresolver";
import { mainLooper, mainExecutor, PROCESS_PID, PROCESS_UID } from "./os";
import { getPrefs } from "./sharedprefs";
import { loadColorStateList, loadDrawable } from "./drawable";
import { JAssetManager, type JConfiguration, scopedResources } from "./resnative";
import { dbPath } from "./sqlite";
import { type JIntent, launchIntent } from "./intent";
import { svcStart, svcStop } from "./runningservices";
import { TV } from "./axml";
import { registerReceiver, unregisterReceiver, sendBroadcast } from "./broadcast";

const privDir = (p: string): JFile => { vfs.mkdir(p); return mkFile(p); };

export class JContext extends JObj {
  declare $host: AppHost;
}

// system service singletons (created lazily per name)
export const services = new Map<string, unknown>();
/** a string resource of the running app ("" before boot) */
export const appString = (id: number) => (appHost ? resString(appHost.res, id) : "");
function ctxString(this: JContext, id: number) { return resString(this.$host.res, id); }
// the one logical display (Display.DEFAULT_DISPLAY = 0); AOSP hands out one Display per id
let defaultDisplay: unknown;
export const display = () => defaultDisplay ??= newObj("android/view/Display", null);
export const displayListeners = new Set<unknown>();
/** the one loader Class.getClassLoader() hands out, so `ctx.getClassLoader() == X.class.getClassLoader()` holds */
let loader: unknown;
const bootLoader = () => loader ??= rt.link("java/lang/Class").ctor.prototype[mangleMethod("getClassLoader", "()Ljava/lang/ClassLoader;")]();
// Context.XXX_SERVICE name → the manager class; getSystemService(Class) walks it backwards.
const SERVICE_CLASS: Record<string, string> = {
  window: "android/view/WindowManagerImpl",
  input_method: "android/view/inputmethod/InputMethodManager",
  connectivity: "android/net/ConnectivityManager",
  activity: "android/app/ActivityManager",
  power: "android/os/PowerManager",
  input: "android/hardware/input/InputManager",
  media_router: "android/media/MediaRouter",
  vibrator: "android/os/Vibrator",
  audio: "android/media/AudioManager",
  phone: "android/telephony/TelephonyManager",
  notification: "android/app/NotificationManager",
  alarm: "android/app/AlarmManager",
  clipboard: "android/content/ClipboardManager",
  uimode: "android/app/UiModeManager",
  accessibility: "android/view/accessibility/AccessibilityManager",
  keyguard: "android/app/KeyguardManager",
  jobscheduler: "android/app/job/JobScheduler",
  sensor: "android/hardware/SensorManager",
  location: "android/location/LocationManager",
  batterymanager: "android/os/BatteryManager",
  display: "android/hardware/display/DisplayManager",
  autofill: "android/view/autofill/AutofillManager",
  textservices: "android/view/textservice/TextServicesManager",
  user: "android/os/UserManager",
  shortcut: "android/content/pm/ShortcutManager",
  permission_controller: "android/permission/PermissionControllerManager",
  locale: "android/app/LocaleManager",
};
const SERVICE_NAME = new Map(Object.entries(SERVICE_CLASS).map(([n, c]) => [c, n]));
SERVICE_NAME.set("android/view/WindowManager", "window");
export function systemService(jctx: JContext, name: string): unknown {
  if (name === "layout_inflater") return getInflater(jctx);
  let s = services.get(name);
  if (s) return s;
  const cls = SERVICE_CLASS[name];
  // A service we do not model is one this device does not have: AOSP returns null, and callers
  // handle that. Handing back a stand-in object instead only moved the failure to their cast.
  if (!cls) { rt.noteMissing("systemService " + name); return null; }
  s = new (rt.link(cls).ctor)();
  services.set(name, s);
  return s;
}

// API 31: one process, one caller, so one AttributionSource describes every context
let attribution: unknown;
rt.register({
  name: "android/content/AttributionSource", ctor: class extends JObj {}, ifaces: ["android/os/Parcelable"],
  methods: {
    "getUid()I": () => PROCESS_UID,
    "getPid()I": () => PROCESS_PID,
    "getPackageName()Ljava/lang/String;": () => appHost!.pkg,
    "getAttributionTag()Ljava/lang/String;": () => null,
    "getNext()Landroid/content/AttributionSource;": () => null,
    "isTrusted(Landroid/content/Context;)Z": () => 1,
    "describeContents()I": () => 0,
  },
});

// ── Context methods (shared by Context/ContextWrapper/Activity/Application)
export const contextMethods: NativeSpec["methods"] = {
  "registerComponentCallbacks(Landroid/content/ComponentCallbacks;)V": () => {},
  "unregisterComponentCallbacks(Landroid/content/ComponentCallbacks;)V": () => {},
  "<init>()V": function () {},
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
    t.apply(id);
    (this as any).ownTheme = t;
  },
  "getPackageName()Ljava/lang/String;": function (this: JContext) { return this.$host.pkg; },
  "getAttributionTag()Ljava/lang/String;": () => null,
  "getAttributionSource()Landroid/content/AttributionSource;": maySuspend(function (this: JContext) { return attribution ??= newObj("android/content/AttributionSource", null); }),
  // only this package is installed, so its own name is the one context that exists; AOSP
  // throws NameNotFoundException for anything else (callers handle it — it is how they
  // discover an optional dependency is absent)
  // The framework package is loaded too, and one Resources answers for both, so a context on
  // "android" is this one. Material asks for it to read the platform palette.
  "createPackageContext(Ljava/lang/String;I)Landroid/content/Context;": function (this: JContext, pkg: string) {
    if (pkg !== this.$host.pkg && pkg !== this.$host.res.tbl(0x01000000)?.pkgName) {
      throw rt.mkThrowable("android/content/pm/PackageManager$NameNotFoundException", pkg);
    }
    return this;
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
  "getApplicationInfo()Landroid/content/pm/ApplicationInfo;": function (this: JContext) { return getAppInfo(this.$host); },
  "getPackageManager()Landroid/content/pm/PackageManager;": function () { return getPM(); },
  "getContentResolver()Landroid/content/ContentResolver;": function () { return contentResolver(); },
  "getMainLooper()Landroid/os/Looper;": () => mainLooper,
  "getMainExecutor()Ljava/util/concurrent/Executor;": mainExecutor,
  "getSystemService(Ljava/lang/String;)Ljava/lang/Object;": function (this: JContext, name: string) {
    return systemService(this, name);
  },
  "getSystemService(Ljava/lang/Class;)Ljava/lang/Object;": function (this: JContext, cls: any) {
    const n = cls?.ci?.name ?? "";
    return systemService(this, SERVICE_NAME.get(n) ?? n.split("/").pop() ?? "");
  },
  "getSystemServiceName(Ljava/lang/Class;)Ljava/lang/String;": (cls: any) => cls?.ci?.name?.split("/").pop() ?? null,
  "getSharedPreferences(Ljava/lang/String;I)Landroid/content/SharedPreferences;": function (this: JContext, name: string) {
    return getPrefs(this.$host.pkg, name);
  },
  "getString(I)Ljava/lang/String;": ctxString,
  "getString(I[Ljava/lang/Object;)Ljava/lang/String;": function (this: JContext, id: number, args: unknown[]) {
    return javaFormat(resString(this.$host.res, id), args);
  },
  "getText(I)Ljava/lang/CharSequence;": ctxString,
  "getColor(I)I": function (this: JContext, id: number) { return rvColor(this.$host.res, this.$host.res.ref(id), 0); },
  "getColorStateList(I)Landroid/content/res/ColorStateList;": async function (this: JContext, id: number) {
    return loadColorStateList(this.$host.res, id, themeOf(this));
  },
  "getDrawable(I)Landroid/graphics/drawable/Drawable;": maySuspend(function (this: JContext, id: number) {
    return loadDrawable(this.$host.res, id, themeOf(this));
  }),
  "getAssets()Landroid/content/res/AssetManager;": function (this: JContext) {
    const a = new JAssetManager();
    a.host = this.$host.res;
    return a;
  },
  "getClassLoader()Ljava/lang/ClassLoader;": bootLoader,
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
  "getFileStreamPath(Ljava/lang/String;)Ljava/io/File;": function (this: JContext, name: string) {
    privDir(`/data/data/${this.$host.pkg}/files`);
    return mkFile(`/data/data/${this.$host.pkg}/files/${name}`);
  },
  "openFileInput(Ljava/lang/String;)Ljava/io/FileInputStream;": maySuspend(function (this: JContext, name: string) {
    return newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", `/data/data/${this.$host.pkg}/files/${name}`);
  }),
  "openFileOutput(Ljava/lang/String;I)Ljava/io/FileOutputStream;": maySuspend(function (this: JContext, name: string) {
    return newObj("java/io/FileOutputStream", "(Ljava/lang/String;)V", `/data/data/${this.$host.pkg}/files/${name}`);
  }),
  "deleteFile(Ljava/lang/String;)Z": function (this: JContext, name: string) {
    return vfs.delete(`/data/data/${this.$host.pkg}/files/${name}`) ? 1 : 0;
  },
  "deleteDatabase(Ljava/lang/String;)Z": function (this: JContext, name: string) {
    return vfs.delete(dbPath(this.$host.pkg, name)) ? 1 : 0;
  },
  "checkSelfPermission(Ljava/lang/String;)I": () => 0,
  "checkPermission(Ljava/lang/String;)I": () => 0,
  "checkPermission(Ljava/lang/String;II)I": () => 0,
  "checkCallingPermission(Ljava/lang/String;)I": () => 0,
  "checkCallingOrSelfPermission(Ljava/lang/String;)I": () => 0,
  "enforceCallingOrSelfPermission(Ljava/lang/String;Ljava/lang/String;)V": () => {},
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;)Landroid/content/Intent;": function (this: JContext, receiver: JObj | null, filter: { actions: string[] }) { return registerReceiver(this, receiver, filter); },
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;I)Landroid/content/Intent;": function (this: JContext, receiver: JObj | null, filter: { actions: string[] }) { return registerReceiver(this, receiver, filter); },
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;Ljava/lang/String;Landroid/os/Handler;)Landroid/content/Intent;": function (this: JContext, receiver: JObj | null, filter: { actions: string[] }, _permission: string, handler: unknown) { return registerReceiver(this, receiver, filter, handler); },
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;Ljava/lang/String;Landroid/os/Handler;I)Landroid/content/Intent;": function (this: JContext, receiver: JObj | null, filter: { actions: string[] }, _permission: string, handler: unknown) { return registerReceiver(this, receiver, filter, handler); },
  "unregisterReceiver(Landroid/content/BroadcastReceiver;)V": unregisterReceiver,
  "sendBroadcast(Landroid/content/Intent;)V": function (this: JContext, intent: JIntent) { sendBroadcast(this, intent); },
  "startService(Landroid/content/Intent;)Landroid/content/ComponentName;": function (this: JContext, intent: JIntent) {
    return svcStart(this, intent, false);
  },
  "startForegroundService(Landroid/content/Intent;)Landroid/content/ComponentName;": function (this: JContext, intent: JIntent) {
    return svcStart(this, intent, true);
  },
  "stopService(Landroid/content/Intent;)Z": (intent: JIntent) => svcStop(intent?.component),
  "bindService(Landroid/content/Intent;Landroid/content/ServiceConnection;I)Z": () => 0,
  "unbindService(Landroid/content/ServiceConnection;)V": () => {},
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
    ta.vals = [...attrs].map((a) => {
      let v = this.$host.res.styleLookup(styleId, a);
      if (v && v.t === TV.ATTRIBUTE) v = theme.lookup(v.d);
      return v ? this.$host.res.resolveRefs(v) : null;
    });
    return ta;
  },
  "createConfigurationContext(Landroid/content/res/Configuration;)Landroid/content/Context;": function (this: JContext, config: JConfiguration) {
    const jresources = scopedResources(this.$host.res, config), theme = new JTheme();
    theme.res = jresources.host;
    theme.styles = (themeOf(this) ?? this.$host.theme).styles.slice();
    const context = new JContext();
    context.$host = Object.assign(Object.create(this.$host), { res: jresources.host, jresources, theme });
    return context;
  },
  "createDeviceProtectedStorageContext()Landroid/content/Context;": function (this: JContext) { return this; },
  "isDeviceProtectedStorage()Z": () => 0,
  "isRestricted()Z": () => 0,
};

rt.register({ name: "android/content/Context", ctor: JContext, methods: contextMethods,
  statics: { LAYOUT_INFLATER_SERVICE: "layout_inflater", WINDOW_SERVICE: "window", INPUT_METHOD_SERVICE: "input_method", CONNECTIVITY_SERVICE: "connectivity", ACTIVITY_SERVICE: "activity", NOTIFICATION_SERVICE: "notification", ALARM_SERVICE: "alarm", POWER_SERVICE: "power", VIBRATOR_SERVICE: "vibrator", AUDIO_SERVICE: "audio", CLIPBOARD_SERVICE: "clipboard", USER_SERVICE: "user", LOCATION_SERVICE: "location", SENSOR_SERVICE: "sensor", MEDIA_ROUTER_SERVICE: "media_router", TELEPHONY_SERVICE: "phone", WIFI_SERVICE: "wifi", DISPLAY_SERVICE: "display", CAMERA_SERVICE: "camera", INPUT_SERVICE: "input", STORAGE_SERVICE: "storage", BATTERY_SERVICE: "batterymanager", KEYGUARD_SERVICE: "keyguard", ACCESSIBILITY_SERVICE: "accessibility", JOB_SCHEDULER_SERVICE: "jobscheduler", UI_MODE_SERVICE: "uimode", DOWNLOAD_SERVICE: "download", MODE_PRIVATE: 0, BIND_AUTO_CREATE: 1 } });

export class JContextWrapper extends JContext { base: JContext | null = null; }
function attachBase(this: JContextWrapper, base: JContext) {
  this.base = base;
  if (base) this.$host = base.$host;
}
// ContextWrapper/ContextThemeWrapper/Application/Service all delegate to a base context
export const wrapperMethods: NativeSpec["methods"] = {
  ...contextMethods,
  "attachBaseContext(Landroid/content/Context;)V": attachBase,
  "getBaseContext()Landroid/content/Context;": function (this: JContextWrapper) { return this.base; },
};
rt.register({
  name: "android/content/ContextWrapper", ctor: JContextWrapper, sup: "android/content/Context",
  methods: { ...wrapperMethods, "<init>(Landroid/content/Context;)V": attachBase },
});
rt.register({
  name: "android/view/ContextThemeWrapper", ctor: class extends JContextWrapper {}, sup: "android/content/ContextWrapper",
  methods: {
    ...wrapperMethods,
    "<init>(Landroid/content/Context;)V": attachBase,
    "<init>(Landroid/content/Context;I)V": maySuspend(function (this: JContextWrapper, base: JContext, themeId: number) {
      attachBase.call(this, base);
      if (themeId) callSelf(contextMethods, "setTheme(I)V", this, themeId);
    }),
  },
});
