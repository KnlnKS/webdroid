// android.content.Context / android.app.Activity / Window / services.

import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { device } from "../shell/config";
import { mangleMethod, jarray } from "../jvm/abi";
import { vcall, javaFormat, newObj } from "../jvm/natives/jlang";
import { newArrayList, mkIter, type JList } from "../jvm/natives/jutil";
import { vfs, mkFile, JFile } from "../jvm/natives/jio";
const privDir = (p: string): JFile => { vfs.mkdir(p); return mkFile(p); };
import { type Resources, JTheme, JAttrSet, JTypedArray, obtainStyled, rvColor, rvDimen, rvInt, rvString, resString, themeOf, themeByName } from "./res";
import { JResources, JAssetManager, mkAssetFd } from "./resnative";
import { signatures, JActivityInfo } from "./pm";
import { mkUri, type JUri } from "./net";
import { DOCS_AUTHORITY, isDocsUri, isChildrenUri, documentId, docRow, docChildren, docDelete, docRead, docWrite, docInputStream, docOutputStream, docCells, DOC_COLUMNS } from "./documents";
import { JView, JViewGroup, AID, requestLayout, invalidate, specSize, findById, attachView, detachView, dispatchConfigurationChanged, rootWindowInsets } from "./view";
import { JFrameLayout, JLinearLayout } from "./widget";
import { getInflater, inflateLayout } from "./inflate";
import { loadDrawable, loadDrawableRV, JColorDrawable, JDrawable, loadColorStateList } from "./drawable";
import { JBundle, mainLooper, reportUncaught, mkPfd } from "./os";
import { onMain } from "./mainloop";
import { isMusicActive } from "./media";
import { TV, attr, attrStr, type XmlNode, parseAXML } from "./axml";
import { csText } from "./text";
import { JCanvas, tfMedium } from "./graphics";
import { showPopupMenu, addOverlay, removeOverlay, showToast } from "./popup";
import { dbPath, mkCursor } from "./sqlite";

/** Host bundle shared by all contexts of the app */
export interface AppHost {
  res: Resources;
  theme: JTheme;
  pkg: string;
  /** the apk's file name under apks/ — what the dev server's /asset route keys on */
  apkFile: string;
  appLabel: string;
  themeResId: number;
  iconRes: number;
  zip: Record<string, Uint8Array>;
  application: any;
  jresources: JResources;
  statusBarColor: number;
  navBarColor: number;
  launch: (component: string, intent: any) => Promise<void>;
  finishActivity: (activity: any) => void;
  recreateActivity: (activity: any) => void;
  currentActivity: () => any;
  invalidateOptionsMenu: (activity: any) => void;
}
let appHost: AppHost | null = null;
export function setAppHost(h: AppHost) { appHost = h; }

export class JContext extends JObj {
  declare $host: AppHost;
}

// system service singletons (created lazily per name)
const services = new Map<string, unknown>();
/** a string resource of the running app ("" before boot) */
const appString = (id: number) => (appHost ? resString(appHost.res, id) : "");
function ctxString(this: JContext, id: number) { return resString(this.$host.res, id); }
// the one logical display (Display.DEFAULT_DISPLAY = 0); AOSP hands out one Display per id
let defaultDisplay: unknown;
const display = () => defaultDisplay ??= newObj("android/view/Display", null);
const displayListeners = new Set<unknown>();
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
  permission_controller: "android/permission/PermissionControllerManager",
};
const SERVICE_NAME = new Map(Object.entries(SERVICE_CLASS).map(([n, c]) => [c, n]));
SERVICE_NAME.set("android/view/WindowManager", "window");
function systemService(jctx: any, name: string): unknown {
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

// SharedPreferences
export class JSharedPrefs extends JObj {
  name = "";
  map = new Map<string, unknown>();
  listeners: unknown[] = [];
  persist() {
    try {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of this.map) obj[k] = typeof v === "bigint" ? { $l: v.toString() } : v;
      globalThis.localStorage?.setItem("wd:prefs:" + this.name, JSON.stringify(obj));
    } catch { /* quota */ }
  }
  load() {
    try {
      const raw = globalThis.localStorage?.getItem("wd:prefs:" + this.name);
      if (raw) {
        for (const [k, v] of Object.entries(JSON.parse(raw))) {
          this.map.set(k, v !== null && typeof v === "object" && "$l" in (v as object) ? BigInt((v as { $l: string }).$l) : v);
        }
      }
    } catch { /* corrupt */ }
  }
}
const prefsCache = new Map<string, JSharedPrefs>();
export function getPrefs(pkg: string, name: string): JSharedPrefs {
  const key = pkg + ":" + name;
  let p = prefsCache.get(key);
  if (!p) {
    p = new JSharedPrefs();
    p.name = key;
    p.load();
    prefsCache.set(key, p);
  }
  return p;
}
class JPrefsEditor extends JObj {
  prefs!: JSharedPrefs;
  changes = new Map<string, unknown>();
  cleared = false;
}
rt.register({
  name: "webdroid/PrefsEditor", ctor: JPrefsEditor, ifaces: ["android/content/SharedPreferences$Editor"],
  methods: (() => {
    const m: NativeSpec["methods"] = {
      "remove(Ljava/lang/String;)Landroid/content/SharedPreferences$Editor;": function (this: JPrefsEditor, k: string) {
        this.changes.set(k, undefined);
        return this;
      },
      "clear()Landroid/content/SharedPreferences$Editor;": function (this: JPrefsEditor) { this.cleared = true; return this; },
      "apply()V": function (this: JPrefsEditor) { commitEditor(this); },
      "commit()Z": function (this: JPrefsEditor) { commitEditor(this); return 1; },
    };
    for (const [t, d] of [["String", "Ljava/lang/String;"], ["Int", "I"], ["Long", "J"], ["Float", "F"], ["Boolean", "Z"], ["StringSet", "Ljava/util/Set;"]]) {
      m[`put${t}(Ljava/lang/String;${d})Landroid/content/SharedPreferences$Editor;`] = function (this: JPrefsEditor, k: string, v: unknown) {
        this.changes.set(k, v);
        return this;
      };
    }
    return m;
  })(),
});
async function commitEditor(e: JPrefsEditor) {
  if (e.cleared) e.prefs.map.clear();
  const changed: string[] = [];
  for (const [k, v] of e.changes) {
    if (v === undefined) e.prefs.map.delete(k);
    else e.prefs.map.set(k, v);
    changed.push(k);
  }
  e.changes.clear();
  e.cleared = false;
  e.prefs.persist();
  for (const l of e.prefs.listeners) {
    for (const k of changed) {
      try {
        await vcall(l, "onSharedPreferenceChanged", "(Landroid/content/SharedPreferences;Ljava/lang/String;)V", e.prefs, k);
      } catch (err) { console.error("[prefs listener]", err); }
    }
  }
}
rt.register({
  name: "webdroid/SharedPrefs", ctor: JSharedPrefs, ifaces: ["android/content/SharedPreferences"],
  methods: (() => {
    const m: NativeSpec["methods"] = {
      "edit()Landroid/content/SharedPreferences$Editor;": function (this: JSharedPrefs) {
        const e = new JPrefsEditor();
        e.prefs = this;
        return e;
      },
      "contains(Ljava/lang/String;)Z": function (this: JSharedPrefs, k: string) { return this.map.has(k) ? 1 : 0; },
      "getAll()Ljava/util/Map;": function (this: JSharedPrefs) {
        const info = rt.link("java/util/HashMap");
        const map = new info.ctor();
        for (const [k, v] of this.map) map.m.set(k, { k, v });
        return map;
      },
      "registerOnSharedPreferenceChangeListener(Landroid/content/SharedPreferences$OnSharedPreferenceChangeListener;)V":
        function (this: JSharedPrefs, l: unknown) { this.listeners.push(l); },
      "unregisterOnSharedPreferenceChangeListener(Landroid/content/SharedPreferences$OnSharedPreferenceChangeListener;)V":
        function (this: JSharedPrefs, l: unknown) {
          const i = this.listeners.indexOf(l);
          if (i >= 0) this.listeners.splice(i, 1);
        },
    };
    for (const [t, d] of [["String", "Ljava/lang/String;"], ["Int", "I"], ["Long", "J"], ["Float", "F"], ["Boolean", "Z"], ["StringSet", "Ljava/util/Set;"]] as const) {
      m[`get${t}(Ljava/lang/String;${d})${d}`] = function (this: JSharedPrefs, k: string, dv: unknown) {
        const v = this.map.get(k);
        if (v === undefined) return dv;
        if (t === "Boolean") return v ? 1 : 0;
        if (t === "Long" && typeof v !== "bigint") return BigInt(Math.trunc(v as number));
        return v;
      };
    }
    return m;
  })(),
});
rt.register({ name: "android/content/SharedPreferences", ctor: class extends JObj {} });
rt.register({ name: "android/content/SharedPreferences$Editor", ctor: class extends JObj {} });
rt.register({ name: "android/content/SharedPreferences$OnSharedPreferenceChangeListener", ctor: class extends JObj {} });

// ── Context methods (shared by Context/ContextWrapper/Activity/Application)
const contextMethods: NativeSpec["methods"] = {
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
  "getApplicationInfo()Landroid/content/pm/ApplicationInfo;": function (this: JContext) { return getAppInfo(this.$host); },
  "getPackageManager()Landroid/content/pm/PackageManager;": function () { return getPM(); },
  "getContentResolver()Landroid/content/ContentResolver;": function () { return contentResolver(); },
  "getMainLooper()Landroid/os/Looper;": () => mainLooper,
  "getMainExecutor()Ljava/util/concurrent/Executor;": () => new (rt.link("webdroid/Executor").ctor)(),
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
  "getDrawable(I)Landroid/graphics/drawable/Drawable;": function (this: JContext, id: number) {
    return loadDrawable(this.$host.res, id, themeOf(this));
  },
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
  "checkSelfPermission(Ljava/lang/String;)I": () => 0,
  "checkPermission(Ljava/lang/String;)I": () => 0,
  "checkPermission(Ljava/lang/String;II)I": () => 0,
  "checkCallingPermission(Ljava/lang/String;)I": () => 0,
  "checkCallingOrSelfPermission(Ljava/lang/String;)I": () => 0,
  "enforceCallingOrSelfPermission(Ljava/lang/String;Ljava/lang/String;)V": () => {},
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;)Landroid/content/Intent;": () => null,
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;I)Landroid/content/Intent;": () => null,
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;Ljava/lang/String;Landroid/os/Handler;)Landroid/content/Intent;": () => null,
  "registerReceiver(Landroid/content/BroadcastReceiver;Landroid/content/IntentFilter;Ljava/lang/String;Landroid/os/Handler;I)Landroid/content/Intent;": () => null,
  "unregisterReceiver(Landroid/content/BroadcastReceiver;)V": () => {},
  "sendBroadcast(Landroid/content/Intent;)V": () => {},
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
  "createConfigurationContext(Landroid/content/res/Configuration;)Landroid/content/Context;": function (this: JContext) { return this; },
  "createDeviceProtectedStorageContext()Landroid/content/Context;": function (this: JContext) { return this; },
  "isDeviceProtectedStorage()Z": () => 0,
  "isRestricted()Z": () => 0,
};

rt.register({ name: "android/content/Context", ctor: JContext, methods: contextMethods,
  statics: { LAYOUT_INFLATER_SERVICE: "layout_inflater", WINDOW_SERVICE: "window", INPUT_METHOD_SERVICE: "input_method", CONNECTIVITY_SERVICE: "connectivity", ACTIVITY_SERVICE: "activity", NOTIFICATION_SERVICE: "notification", ALARM_SERVICE: "alarm", POWER_SERVICE: "power", VIBRATOR_SERVICE: "vibrator", AUDIO_SERVICE: "audio", CLIPBOARD_SERVICE: "clipboard", USER_SERVICE: "user", MODE_PRIVATE: 0, BIND_AUTO_CREATE: 1 } });

export class JContextWrapper extends JContext { base: JContext | null = null; }
function attachBase(this: JContextWrapper, base: JContext) {
  this.base = base;
  if (base) this.$host = base.$host;
}
// ContextWrapper/ContextThemeWrapper/Application/Service all delegate to a base context
const wrapperMethods: NativeSpec["methods"] = {
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
    "<init>(Landroid/content/Context;I)V": function (this: JContextWrapper, base: JContext, themeId: number) {
      attachBase.call(this, base);
      if (themeId) (contextMethods["setTheme(I)V"] as any).call(this, themeId);
    },
  },
});

export class JIntent extends JObj {
  action: string | null = null;
  component: string | null = null; // class name dots
  dataUri: string | null = null;
  typeStr: string | null = null;
  pkg: string | null = null;
  extras = new JBundle();
  flags = 0;
  categories = new Set<string>();
}
const intentMethods: NativeSpec["methods"] = {
  "<init>()V": function () {},
  "<init>(Ljava/lang/String;)V": function (this: JIntent, a: string) { this.action = a; },
  "<init>(Ljava/lang/String;Landroid/net/Uri;)V": function (this: JIntent, a: string, u: any) {
    this.action = a;
    this.dataUri = u?.uri ?? null;
  },
  "<init>(Landroid/content/Context;Ljava/lang/Class;)V": function (this: JIntent, c: unknown, cls: any) {
    this.component = cls?.ci?.name?.replace(/\//g, ".") ?? null;
  },
  "<init>(Landroid/content/Intent;)V": function (this: JIntent, o: JIntent) {
    if (o) {
      this.action = o.action; this.component = o.component; this.dataUri = o.dataUri;
      this.extras = new JBundle();
      this.extras.map = new Map(o.extras.map);
      this.flags = o.flags;
    }
  },
  "setClass(Landroid/content/Context;Ljava/lang/Class;)Landroid/content/Intent;": function (this: JIntent, c: unknown, cls: any) {
    this.component = cls?.ci?.name?.replace(/\//g, ".") ?? null;
    return this;
  },
  "setClassName(Landroid/content/Context;Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, c: unknown, n: string) {
    this.component = n;
    return this;
  },
  "setClassName(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, p: string, n: string) {
    this.component = n;
    return this;
  },
  "setComponent(Landroid/content/ComponentName;)Landroid/content/Intent;": function (this: JIntent, cn: any) {
    this.component = cn?.cls ?? null;
    return this;
  },
  "getComponent()Landroid/content/ComponentName;": function (this: JIntent) {
    return this.component ? mkComponentName(appHost?.pkg ?? "", this.component) : null;
  },
  "setAction(Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, a: string) { this.action = a; return this; },
  "setPackage(Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, p: string) { this.pkg = p; return this; },
  "getPackage()Ljava/lang/String;": function (this: JIntent) { return this.pkg; },
  "getAction()Ljava/lang/String;": function (this: JIntent) { return this.action; },
  "setData(Landroid/net/Uri;)Landroid/content/Intent;": function (this: JIntent, u: any) { this.dataUri = u?.uri ?? null; return this; },
  "getData()Landroid/net/Uri;": function (this: JIntent) { return this.dataUri ? mkUri(this.dataUri) : null; },
  "getDataString()Ljava/lang/String;": function (this: JIntent) { return this.dataUri; },
  "setType(Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, t: string) { this.typeStr = t; return this; },
  "setDataAndType(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, u: any, t: string) {
    this.dataUri = u?.uri ?? null;
    this.typeStr = t;
    return this;
  },
  "getType()Ljava/lang/String;": function (this: JIntent) { return this.typeStr; },
  "addFlags(I)Landroid/content/Intent;": function (this: JIntent, f: number) { this.flags |= f; return this; },
  "setFlags(I)Landroid/content/Intent;": function (this: JIntent, f: number) { this.flags = f; return this; },
  "getFlags()I": function (this: JIntent) { return this.flags; },
  "addCategory(Ljava/lang/String;)Landroid/content/Intent;": function (this: JIntent, c: string) { this.categories.add(c); return this; },
  "getExtras()Landroid/os/Bundle;": function (this: JIntent) { return this.extras.map.size ? this.extras : null; },
  "putExtras(Landroid/os/Bundle;)Landroid/content/Intent;": function (this: JIntent, b: JBundle) {
    if (b) for (const [k, v] of b.map) this.extras.map.set(k, v);
    return this;
  },
  "hasExtra(Ljava/lang/String;)Z": function (this: JIntent, k: string) { return this.extras.map.has(k) ? 1 : 0; },
  "resolveActivity(Landroid/content/pm/PackageManager;)Landroid/content/ComponentName;": function (this: JIntent) {
    return this.component ? mkComponentName(appHost?.pkg ?? "", this.component) : null;
  },
  "toString()Ljava/lang/String;": function (this: JIntent) {
    return `Intent{act=${this.action} cmp=${this.component}}`;
  },
};
for (const [t, d, dflt] of [["String", "Ljava/lang/String;", null], ["Int", "I", 0], ["Long", "J", 0n],
  ["Boolean", "Z", 0], ["Float", "F", 0], ["Double", "D", 0], ["CharSequence", "Ljava/lang/CharSequence;", null],
  ["Parcelable", "Landroid/os/Parcelable;", null], ["Serializable", "Ljava/io/Serializable;", null],
  ["Bundle", "Landroid/os/Bundle;", null], ["StringArrayList", "Ljava/util/ArrayList;", null],
  ["IntArray", "[I", null], ["ByteArray", "[B", null], ["StringArray", "[Ljava/lang/String;", null]] as const) {
  intentMethods[`putExtra(Ljava/lang/String;${d})Landroid/content/Intent;`] = function (this: JIntent, k: string, v: unknown) {
    this.extras.map.set(k, v);
    return this;
  };
  intentMethods[`get${t}Extra(Ljava/lang/String;)${d}`] = function (this: JIntent, k: string) {
    return this.extras.map.get(k) ?? dflt;
  };
  if (d === "I" || d === "J" || d === "Z" || d === "F" || d === "D") {
    intentMethods[`get${t}Extra(Ljava/lang/String;${d})${d}`] = function (this: JIntent, k: string, dv: unknown) {
      const v = this.extras.map.get(k);
      return v === undefined ? dv : v;
    };
  }
  if (t === "Bundle") {
    intentMethods[`getBundleExtra(Ljava/lang/String;)Landroid/os/Bundle;`] = function (this: JIntent, k: string) {
      return this.extras.map.get(k) ?? null;
    };
  }
}
rt.register({
  name: "android/content/Intent", ctor: JIntent, ifaces: ["android/os/Parcelable", "java/lang/Cloneable"],
  statics: {
    ACTION_MAIN: "android.intent.action.MAIN", ACTION_VIEW: "android.intent.action.VIEW",
    ACTION_SEND: "android.intent.action.SEND", ACTION_EDIT: "android.intent.action.EDIT",
    ACTION_PICK: "android.intent.action.PICK", ACTION_GET_CONTENT: "android.intent.action.GET_CONTENT",
    ACTION_CREATE_DOCUMENT: "android.intent.action.CREATE_DOCUMENT", ACTION_OPEN_DOCUMENT: "android.intent.action.OPEN_DOCUMENT",
    ACTION_OPEN_DOCUMENT_TREE: "android.intent.action.OPEN_DOCUMENT_TREE",
    ACTION_BOOT_COMPLETED: "android.intent.action.BOOT_COMPLETED",
    CATEGORY_LAUNCHER: "android.intent.category.LAUNCHER", CATEGORY_DEFAULT: "android.intent.category.DEFAULT",
    FLAG_ACTIVITY_NEW_TASK: 0x10000000, FLAG_ACTIVITY_CLEAR_TOP: 0x04000000, FLAG_ACTIVITY_CLEAR_TASK: 0x00008000,
    FLAG_ACTIVITY_SINGLE_TOP: 0x20000000, FLAG_GRANT_READ_URI_PERMISSION: 1, FLAG_GRANT_WRITE_URI_PERMISSION: 2,
    FLAG_GRANT_PERSISTABLE_URI_PERMISSION: 64, FLAG_GRANT_PREFIX_URI_PERMISSION: 128,
    EXTRA_TEXT: "android.intent.extra.TEXT", EXTRA_STREAM: "android.intent.extra.STREAM",
    EXTRA_SUBJECT: "android.intent.extra.SUBJECT", EXTRA_TITLE: "android.intent.extra.TITLE",
  },
  methods: intentMethods,
});
class JComponentName extends JObj { pkg = ""; cls = ""; }
/** PackageManager component enabled states an app set (DEFAULT until then); part of the
 *  install like firstInstallTime, so they survive a reboot and go with wd.reset */
const componentState = {
  key: (c: JComponentName) => "wd:install:" + c.pkg + ":component:" + c.cls,
  get(c: JComponentName): number { return Number(globalThis.localStorage?.getItem(this.key(c)) ?? 0); },
  set(c: JComponentName, st: number) { try { globalThis.localStorage?.setItem(this.key(c), String(st)); } catch { /* private mode */ } },
};
function mkComponentName(pkg: string, cls: string): JComponentName {
  const c = new JComponentName();
  c.pkg = pkg; c.cls = cls;
  return c;
}
rt.register({
  name: "android/content/ComponentName", ctor: JComponentName, ifaces: ["android/os/Parcelable"],
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/String;)V": function (this: JComponentName, p: string, c: string) { this.pkg = p; this.cls = c; },
    "<init>(Landroid/content/Context;Ljava/lang/String;)V": function (this: JComponentName, ctx: JContext, cls: string) {
      this.pkg = ctx?.$host?.pkg ?? "";
      this.cls = cls ?? "";
    },
    "<init>(Landroid/content/Context;Ljava/lang/Class;)V": function (this: JComponentName, ctx: JContext, cls: any) {
      this.pkg = ctx?.$host?.pkg ?? "";
      this.cls = cls?.ci?.name?.replace(/\//g, ".") ?? "";
    },
    "getClassName()Ljava/lang/String;": function (this: JComponentName) { return this.cls; },
    "getPackageName()Ljava/lang/String;": function (this: JComponentName) { return this.pkg; },
    "flattenToString()Ljava/lang/String;": function (this: JComponentName) { return this.pkg + "/" + this.cls; },
  },
});
function contentResolver(): unknown {
  let s = services.get("$content");
  if (!s) {
    const info = rt.link("android/content/ContentResolver");
    s = new info.ctor();
    services.set("$content", s);
  }
  return s;
}
/** A persistable grant is app state that survives a reboot, so it lives with the install. */
const uriGrants = {
  key: () => "wd:install:" + (appHost?.pkg ?? "") + ":uriperms",
  all(): string[] { try { return JSON.parse(globalThis.localStorage?.getItem(this.key()) ?? "[]"); } catch { return []; } },
  set(v: string[]) { try { globalThis.localStorage?.setItem(this.key(), JSON.stringify(v)); } catch { /* private mode */ } },
};
const fileOf = (u: JUri) => u.uri.replace(/^file:\/\//, "");
/** A descriptor carries the document's current bytes and writes them back when it is closed. */
async function openPfd(u: JUri, mode: string) {
  if (!isDocsUri(u)) return mkPfd(vfs.read(fileOf(u)) ?? new Uint8Array(0), (b) => vfs.write(fileOf(u), b));
  const id = documentId(u, true);
  const write = (mode ?? "r").includes("w");
  return mkPfd(write && (mode ?? "").includes("t") ? new Uint8Array(0) : await docRead(id),
    write ? (b) => docWrite(id, b) : null);
}
const openAfd = async (u: JUri, mode: string) => {
  const pfd = await openPfd(u, mode);
  return mkAssetFd(pfd.bytes, pfd);
};
const resolverMethods: NativeSpec["methods"] = {
  "notifyChange(Landroid/net/Uri;Landroid/database/ContentObserver;)V": () => {},
  "registerContentObserver(Landroid/net/Uri;ZLandroid/database/ContentObserver;)V": () => {},
  "unregisterContentObserver(Landroid/database/ContentObserver;)V": () => {},
  "openInputStream(Landroid/net/Uri;)Ljava/io/InputStream;": (u: JUri) =>
    isDocsUri(u) ? docInputStream(documentId(u, true))
      : newObj("java/io/FileInputStream", "(Ljava/lang/String;)V", fileOf(u)),
  "openOutputStream(Landroid/net/Uri;)Ljava/io/OutputStream;": (u: JUri) =>
    isDocsUri(u) ? docOutputStream(documentId(u, true), false)
      : newObj("java/io/FileOutputStream", "(Ljava/lang/String;)V", fileOf(u)),
  // AOSP's modes: "w" truncates, "wa" appends, "rw"/"rwt" keep or truncate in place.
  "openOutputStream(Landroid/net/Uri;Ljava/lang/String;)Ljava/io/OutputStream;": (u: JUri, mode: string) =>
    isDocsUri(u) ? docOutputStream(documentId(u, true), (mode ?? "w").includes("a"))
      : newObj("java/io/FileOutputStream", "(Ljava/lang/String;Z)V", fileOf(u), (mode ?? "w").includes("a") ? 1 : 0),
  "getType(Landroid/net/Uri;)Ljava/lang/String;": async (u: JUri) =>
    isDocsUri(u) ? (await docRow(documentId(u, true)))?.mime ?? null : null,
  "query(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;":
    async (u: JUri, proj: string[] | null) => {
      if (!isDocsUri(u)) return null;
      const id = documentId(u, true);
      const row = isChildrenUri(u) ? null : await docRow(id);
      const rows = isChildrenUri(u) ? await docChildren(id) : row ? [row] : [];
      const cols = proj?.length ? [...proj] : DOC_COLUMNS;
      return mkCursor(cols, rows.map((r) => {
        const cells = docCells(r);
        return cols.map((c) => cells[DOC_COLUMNS.indexOf(c)] ?? null);
      }));
    },
  "openFileDescriptor(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;": openPfd,
  "openFileDescriptor(Landroid/net/Uri;Ljava/lang/String;Landroid/os/CancellationSignal;)Landroid/os/ParcelFileDescriptor;": openPfd,
  "openAssetFileDescriptor(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/res/AssetFileDescriptor;": openAfd,
  "openTypedAssetFile(Landroid/net/Uri;Ljava/lang/String;Landroid/os/Bundle;Landroid/os/CancellationSignal;)Landroid/content/res/AssetFileDescriptor;": openAfd,
  "insert(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;": () => null,
  "delete(Landroid/net/Uri;Ljava/lang/String;[Ljava/lang/String;)I": async (u: JUri) =>
    isDocsUri(u) && await docDelete(documentId(u, true)) ? 1 : 0,
  // A grant we cannot refuse: nothing here revokes URI access, so the app keeps what it took.
  "takePersistableUriPermission(Landroid/net/Uri;I)V": (u: JUri) => {
    const all = uriGrants.all();
    if (!all.includes(u.uri)) uriGrants.set([...all, u.uri]);
  },
  "releasePersistableUriPermission(Landroid/net/Uri;I)V": (u: JUri) =>
    uriGrants.set(uriGrants.all().filter((s) => s !== u.uri)),
  "getPersistedUriPermissions()Ljava/util/List;": () =>
    newArrayList(uriGrants.all().map((s) => { const p = new JUriPermission(); p.uriStr = s; return p; })),
};
rt.register({ name: "android/content/ContentResolver", ctor: class extends JObj {}, methods: resolverMethods });
class JUriPermission extends JObj { uriStr = ""; }
rt.register({
  name: "android/content/UriPermission", ctor: JUriPermission,
  methods: {
    "<init>()V": function () {},
    "getUri()Landroid/net/Uri;": function (this: JUriPermission) { return mkUri(this.uriStr); },
    "isReadPermission()Z": () => 1,
    "isWritePermission()Z": () => 1,
    "getPersistedTime()J": () => 0n,
  },
});

// android.provider.Settings — a read-only device with everything at its documented default.
// Reads go through a ContentResolver on a real device; nothing here is writable, so every
// getter simply hands back the caller's own default. AOSP splits the same table three ways.
const settingsUri = (table: string, name: string) => mkUri(`content://settings/${table}/${name}`);
for (const [cls, table] of [["Global", "global"], ["Secure", "secure"], ["System", "system"]] as const) {
  rt.register({
    name: `android/provider/Settings$${cls}`, ctor: class extends JObj {},
    statics: {
      ANIMATOR_DURATION_SCALE: "animator_duration_scale",
      TRANSITION_ANIMATION_SCALE: "transition_animation_scale",
      WINDOW_ANIMATION_SCALE: "window_animation_scale",
      ACCESSIBILITY_ENABLED: "accessibility_enabled",
      AIRPLANE_MODE_ON: "airplane_mode_on",
      DEVELOPMENT_SETTINGS_ENABLED: "development_settings_enabled",
      TEXT_SHOW_PASSWORD: "show_password",
      FONT_SCALE: "font_scale",
      CONTENT_URI: mkUri(`content://settings/${table}`),
    },
    methods: {
      "static getFloat(Landroid/content/ContentResolver;Ljava/lang/String;F)F": (_r: unknown, _n: string, d: number) => d,
      "static getInt(Landroid/content/ContentResolver;Ljava/lang/String;I)I": (_r: unknown, _n: string, d: number) => d,
      "static getLong(Landroid/content/ContentResolver;Ljava/lang/String;J)J": (_r: unknown, _n: string, d: bigint) => d,
      "static getString(Landroid/content/ContentResolver;Ljava/lang/String;)Ljava/lang/String;": () => null,
      "static getUriFor(Ljava/lang/String;)Landroid/net/Uri;": (n: string) => settingsUri(table, n),
      "static putFloat(Landroid/content/ContentResolver;Ljava/lang/String;F)Z": () => 0,
      "static putInt(Landroid/content/ContentResolver;Ljava/lang/String;I)Z": () => 0,
      "static putLong(Landroid/content/ContentResolver;Ljava/lang/String;J)Z": () => 0,
      "static putString(Landroid/content/ContentResolver;Ljava/lang/String;Ljava/lang/String;)Z": () => 0,
    },
  });
}
rt.register({ name: "android/provider/Settings", ctor: class extends JObj {},
  statics: { ACTION_APPLICATION_DETAILS_SETTINGS: "android.settings.APPLICATION_DETAILS_SETTINGS",
             ACTION_SETTINGS: "android.settings.SETTINGS" } });

// The manifest the booted apk was described by: PackageManager answers out of it rather
// than out of invented defaults, so meta-data/configChanges/uses-feature are the app's own.
let manifestRoot: XmlNode | null = null;
let manifestActivities = new Map<string, XmlNode>();
let manifestProviders = new Map<string, XmlNode>();
export function setManifest(root: XmlNode, activities: Map<string, XmlNode>, providers: Map<string, XmlNode>) {
  manifestRoot = root;
  manifestActivities = activities;
  manifestProviders = providers;
}
const appNode = () => manifestRoot?.children.find((c) => c.name === "application") ?? null;
/** <meta-data> children → Bundle, typed the way aapt encoded them (string / boolean / int). */
function metaData(node: XmlNode | null | undefined): JBundle {
  const b = new (rt.link("android/os/Bundle").ctor)() as JBundle;
  for (const md of node?.children ?? []) {
    if (md.name !== "meta-data") continue;
    const k = attrStr(md, "name");
    if (k === null) continue;
    // android:resource stays the id; android:value is read through the app's resources, as
    // PackageParser reads it — "@string/app_id" is the string, not its id
    const rsrc = attr(md, "resource");
    const v = attr(md, "value") ?? rsrc;
    const str = !rsrc && v && appHost && v.type === TV.REFERENCE ? rvString(appHost.res, { t: v.type, d: v.data }) : v?.str ?? null;
    b.map.set(k, !v ? null : str !== null ? str : v.type === TV.BOOLEAN ? (v.data ? 1 : 0) : v.data);
  }
  return b;
}

class JApplicationInfo extends JObj {
  packageName = ""; sourceDir = ""; dataDir = ""; nativeLibraryDir = "/lib";
  flags = 0; targetSdkVersion = 33; minSdkVersion = 21; theme = 0; labelRes = 0; icon = 0;
  // AOSP fills exactly one of these from <application android:label>: the resource id when it
  // is a reference, the literal otherwise. Code that names the app reads whichever is set.
  nonLocalizedLabel: string | null = null;
  className: string | null = null; publicSourceDir = ""; uid = 10001; processName = "";
  enabled = 1; metaData: JBundle | null = null;
  // a single base.apk install has no splits: null, as AOSP leaves them (library loaders null-check these)
  splitNames: string[] | null = null; splitSourceDirs: string[] | null = null; splitPublicSourceDirs: string[] | null = null;
  sharedLibraryFiles: string[] | null = null;
}
rt.register({
  name: "android/content/pm/ApplicationInfo", ctor: JApplicationInfo, ifaces: ["android/os/Parcelable"],
  fields: {
    packageName: "packageName", sourceDir: "sourceDir", dataDir: "dataDir", nativeLibraryDir: "nativeLibraryDir",
    flags: "flags", targetSdkVersion: "targetSdkVersion", minSdkVersion: "minSdkVersion", theme: "theme",
    labelRes: "labelRes", nonLocalizedLabel: "nonLocalizedLabel", icon: "icon", className: "className", publicSourceDir: "publicSourceDir",
    uid: "uid", processName: "processName", enabled: "enabled", metaData: "metaData",
    splitNames: "splitNames", splitSourceDirs: "splitSourceDirs", splitPublicSourceDirs: "splitPublicSourceDirs",
    sharedLibraryFiles: "sharedLibraryFiles",
  },
  methods: { "<init>()V": function () {}, "loadLabel(Landroid/content/pm/PackageManager;)Ljava/lang/CharSequence;": function (this: JApplicationInfo) { return appHost?.appLabel ?? this.packageName; } },
});
let cachedAppInfo: JApplicationInfo | null = null;
function getAppInfo(host: AppHost): JApplicationInfo {
  if (!cachedAppInfo) {
    cachedAppInfo = new JApplicationInfo();
    cachedAppInfo.packageName = host.pkg;
    cachedAppInfo.sourceDir = "/data/app/base.apk";
    cachedAppInfo.publicSourceDir = "/data/app/base.apk";
    cachedAppInfo.dataDir = `/data/data/${host.pkg}`;
    cachedAppInfo.processName = host.pkg;
    cachedAppInfo.theme = host.themeResId;
    cachedAppInfo.icon = host.iconRes;
    const node = appNode();
    const label = node ? attr(node, "label") : undefined;
    if (label?.type === TV.REFERENCE) cachedAppInfo.labelRes = label.data;
    else cachedAppInfo.nonLocalizedLabel = host.appLabel;
    cachedAppInfo.metaData = metaData(appNode());
  }
  return cachedAppInfo;
}
class JPackageInfo extends JObj {
  packageName = ""; versionName = "1.0"; versionCode = 1; longVersionCode = 1n;
  applicationInfo: JApplicationInfo | null = null;
  firstInstallTime = 0n; lastUpdateTime = 0n;
  signatures: unknown = null; signingInfo: unknown = null;
  reqFeatures: unknown = null;
  activities: unknown = null; services: unknown = null; providers: unknown = null;
}
/**
 * When this package was installed, epoch ms. An app's data directory IS its installation
 * here, so the first boot that has no persisted state is the install, and the timestamp is
 * kept with that state (wd.reset wipes it along with the rest of the "install").
 * Reporting 0 said "installed at the epoch", which is how mihon's donation campaign — gated
 * on `now >= firstInstallTime + 30 days` — greeted every fresh boot with a modal sheet.
 */
function installTime(pkg: string): bigint {
  const key = "wd:install:" + pkg;
  let ms = Number(globalThis.localStorage?.getItem(key) ?? 0);
  if (!ms) {
    ms = Date.now();
    try { globalThis.localStorage?.setItem(key, String(ms)); } catch { /* private mode */ }
  }
  return BigInt(ms);
}

/** The manifest's <uses-feature> set, as FeatureInfo[] — what PackageInfo.reqFeatures is. */
function reqFeatures(): unknown[] | null {
  const nodes = (manifestRoot?.children ?? []).filter((c) => c.name === "uses-feature");
  if (!nodes.length) return null;
  const fi = rt.link("android/content/pm/FeatureInfo").ctor;
  const out = nodes.map((c) => {
    const f = new fi() as { name: string | null; reqGlEsVersion: number; flags: number };
    f.name = attrStr(c, "name");
    f.reqGlEsVersion = attr(c, "glEsVersion")?.data ?? 0;
    f.flags = (attr(c, "required")?.data ?? 1) ? 1 : 0; // FLAG_REQUIRED; required defaults true
    return f;
  });
  (out as { $t?: string }).$t = "Landroid/content/pm/FeatureInfo;";
  return out;
}
rt.register({
  name: "android/content/pm/PackageInfo", ctor: JPackageInfo, ifaces: ["android/os/Parcelable"],
  fields: {
    packageName: "packageName", versionName: "versionName", versionCode: "versionCode",
    applicationInfo: "applicationInfo", firstInstallTime: "firstInstallTime", lastUpdateTime: "lastUpdateTime",
    signatures: "signatures", signingInfo: "signingInfo", reqFeatures: "reqFeatures",
    activities: "activities", services: "services", providers: "providers",
  },
  methods: {
    "<init>()V": function () {},
    "getLongVersionCode()J": function (this: JPackageInfo) { return this.longVersionCode; },
  },
});
// ── content providers from the manifest: what queryIntentContentProviders/resolveContentProvider
// answer, and what android.provider's DocumentsContract reads to decide who owns an authority.
/** The manifest <provider> nodes, as (dotted class name, node) pairs. */
const providerNodes = (): [string, XmlNode][] => [...manifestProviders];

const authoritiesOf = (n: XmlNode) => (attrStr(n, "authorities") ?? "").split(";");

const DOCS_PROVIDER_INTERFACE = "android.content.action.DOCUMENTS_PROVIDER";
/** Providers the *system* installs. A device answers for the storage authority out of
 *  ExternalStorageProvider, which no app can see in its own manifest — yet every SAF client
 *  (UniFile, DocumentFile) asks the package manager for it before trusting a tree URI. */
const systemProviders: [authority: string, cls: string, action: string][] =
  [[DOCS_AUTHORITY, "com.android.externalstorage.ExternalStorageProvider", DOCS_PROVIDER_INTERFACE]];

export const isDocumentsProvider = (auth: string) =>
  systemProviders.some(([a, , act]) => a === auth && act === DOCS_PROVIDER_INTERFACE) ||
  providerNodes().some(([, n]) => matchesAction(n, DOCS_PROVIDER_INTERFACE) && authoritiesOf(n).includes(auth));

// AOSP resolves an intent against each component's <intent-filter>; a provider declaring none
// is reachable by authority only. An action-less intent matches everything, as IntentFilter does.
function matchesAction(n: XmlNode, action: string | null): boolean {
  if (!action) return true;
  return n.children.some((f) => f.name === "intent-filter" &&
    f.children.some((a) => a.name === "action" && attrStr(a, "name") === action));
}

function providerInfo(cls: string, pkg: string, authority: string, n: XmlNode | null): unknown {
  const pi = new (rt.link("android/content/pm/ProviderInfo").ctor)() as Record<string, unknown>;
  pi.name = cls;
  pi.packageName = pkg;
  pi.authority = authority;
  pi.exported = !n || attr(n, "exported")?.data ? 1 : 0;
  pi.grantUriPermissions = !n || attr(n, "grantUriPermissions")?.data ? 1 : 0;
  return pi;
}
const mkProviderInfo = (cls: string, n: XmlNode) =>
  providerInfo(cls, appHost?.pkg ?? "", authoritiesOf(n).join(";"), n);
const sysProviderInfo = ([auth, cls]: [string, string, string]) =>
  providerInfo(cls, cls.slice(0, cls.lastIndexOf(".")), auth, null);

function queryProviders(intent: { action?: string | null } | null): JList {
  const action = intent?.action ?? null;
  return newArrayList([
    ...systemProviders.filter(([, , act]) => !action || act === action).map(sysProviderInfo),
    ...providerNodes().filter(([, n]) => matchesAction(n, action)).map(([c, n]) => mkProviderInfo(c, n)),
  ].map((pi) => {
    const ri = new (rt.link("android/content/pm/ResolveInfo").ctor)() as Record<string, unknown>;
    ri.providerInfo = pi;
    return ri;
  }));
}

function resolveProvider(authority: string): unknown {
  const sys = systemProviders.find(([a]) => a === authority);
  if (sys) return sysProviderInfo(sys);
  for (const [c, n] of providerNodes()) if (authoritiesOf(n).includes(authority)) return mkProviderInfo(c, n);
  return null;
}

/** An explicit intent resolves to its own manifest entry, as on any device; with nothing else
 *  installed an implicit one honestly resolves to nothing. */
/** the manifest's launcher activity (dotted), the entry point PackageManager hands out */
function launcherActivity(): string | null {
  for (const [name, node] of manifestActivities) {
    const launcher = node.children.some((f) => f.name === "intent-filter" &&
      f.children.some((x) => x.name === "category" && attrStr(x, "name") === "android.intent.category.LAUNCHER"));
    if (launcher) return name.replace(/\//g, ".");
  }
  return null;
}
function resolveActivity(intent: JIntent | null): unknown {
  const cls = intent?.component;
  if (!cls || !manifestActivities.has(cls.replace(/\./g, "/"))) return null;
  const ri = new (rt.link("android/content/pm/ResolveInfo").ctor)() as Record<string, unknown>;
  ri.activityInfo = mkActivityInfo(cls);
  return ri;
}

class JPackageManager extends JObj {}
let cachedPM: JPackageManager | null = null;
function getPM(): JPackageManager {
  return cachedPM ?? (cachedPM = new JPackageManager());
}
rt.register({
  name: "android/content/pm/PackageManager", ctor: JPackageManager,
  statics: { PERMISSION_GRANTED: 0, PERMISSION_DENIED: -1, GET_ACTIVITIES: 1, GET_META_DATA: 128, GET_SIGNATURES: 64,
    COMPONENT_ENABLED_STATE_DEFAULT: 0, COMPONENT_ENABLED_STATE_ENABLED: 1, COMPONENT_ENABLED_STATE_DISABLED: 2,
    DONT_KILL_APP: 1 },
  methods: {
    "getProviderInfo(Landroid/content/ComponentName;I)Landroid/content/pm/ProviderInfo;": (comp: any) => {
      const cls = String(comp?.cls ?? comp?.className ?? "");
      const node = manifestProviders.get(cls.replace(/\//g, "."));
      const info = new (rt.link("android/content/pm/ProviderInfo").ctor)() as any;
      info.packageName = appHost?.pkg ?? "";
      info.name = cls;
      info.metaData = metaData(node);
      return info;
    },
    "getServiceInfo(Landroid/content/ComponentName;I)Landroid/content/pm/ServiceInfo;": () => newObj("android/content/pm/ServiceInfo", null),
    "getPackageInfo(Ljava/lang/String;Landroid/content/pm/PackageManager$PackageInfoFlags;)Landroid/content/pm/PackageInfo;": function (pkg: string) {
      return vcall(this, "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", pkg, 0);
    },
    "getPackageInfo(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;": function (pkg: string) {
      if (appHost && pkg !== appHost.pkg) throw rt.mkThrowable("android/content/pm/PackageManager$NameNotFoundException", pkg);
      const pi = new JPackageInfo();
      pi.packageName = pkg;
      // the manifest's own version, not an invented one
      pi.versionName = (manifestRoot && attrStr(manifestRoot, "versionName")) ?? "1.0";
      pi.versionCode = (manifestRoot && attr(manifestRoot, "versionCode")?.data) ?? 1;
      pi.longVersionCode = BigInt(pi.versionCode);
      pi.applicationInfo = appHost ? getAppInfo(appHost) : null;
      pi.firstInstallTime = pi.lastUpdateTime = installTime(pkg);
      pi.signatures = signatures();
      pi.signingInfo = new (rt.link("android/content/pm/SigningInfo").ctor)();
      pi.reqFeatures = reqFeatures();
      pi.activities = jarray([...manifestActivities.keys()].map((n) => mkActivityInfo(n.replace(/\//g, "."))), "Landroid/content/pm/ActivityInfo;");
      return pi;
    },
    "getApplicationInfo(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;": function (pkg: string) {
      if (appHost && pkg !== appHost.pkg) throw rt.mkThrowable("android/content/pm/PackageManager$NameNotFoundException", pkg);
      return appHost ? getAppInfo(appHost) : new JApplicationInfo();
    },
    "getApplicationLabel(Landroid/content/pm/ApplicationInfo;)Ljava/lang/CharSequence;": () => appHost?.appLabel ?? "App",
    "resolveActivity(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;": (i: JIntent | null) => resolveActivity(i),
    "queryIntentActivities(Landroid/content/Intent;I)Ljava/util/List;": (i: JIntent | null) => {
      const ri = resolveActivity(i);
      return newArrayList(ri ? [ri] : []);
    },
    "queryIntentContentProviders(Landroid/content/Intent;I)Ljava/util/List;": (i: { action?: string | null } | null) => queryProviders(i),
    "queryIntentContentProviders(Landroid/content/Intent;Landroid/content/pm/PackageManager$ComponentInfoFlags;)Ljava/util/List;": (i: { action?: string | null } | null) => queryProviders(i),
    "resolveContentProvider(Ljava/lang/String;I)Landroid/content/pm/ProviderInfo;": (a: string) => resolveProvider(a),
    "resolveContentProvider(Ljava/lang/String;Landroid/content/pm/PackageManager$ComponentInfoFlags;)Landroid/content/pm/ProviderInfo;": (a: string) => resolveProvider(a),
    // Only <provider> nodes are cached at boot, so no <service> filter can be matched.
    "queryIntentServices(Landroid/content/Intent;I)Ljava/util/List;": () => newArrayList(),
    "getComponentEnabledSetting(Landroid/content/ComponentName;)I": (c: JComponentName) => componentState.get(c),
    "setComponentEnabledSetting(Landroid/content/ComponentName;II)V": (c: JComponentName, st: number) => componentState.set(c, st),
    "hasSystemFeature(Ljava/lang/String;)Z": () => 0,
    "checkPermission(Ljava/lang/String;Ljava/lang/String;)I": () => 0,
    "getInstallerPackageName(Ljava/lang/String;)Ljava/lang/String;": () => null,
    "getInstalledPackages(I)Ljava/util/List;": () => newArrayList(),
    "getInstalledPackages(Landroid/content/pm/PackageManager$PackageInfoFlags;)Ljava/util/List;": () => newArrayList(),
    "getActivityInfo(Landroid/content/ComponentName;I)Landroid/content/pm/ActivityInfo;": (comp: any) =>
      mkActivityInfo(String(comp?.cls ?? "")),
    // only this package is installed; its launcher activity is the one carrying the LAUNCHER category
    "getLaunchIntentForPackage(Ljava/lang/String;)Landroid/content/Intent;": (pkg: string) => {
      if (!appHost || pkg !== appHost.pkg) return null;
      const cls = launcherActivity();
      if (!cls) return null;
      const i = new JIntent();
      i.action = "android.intent.action.MAIN";
      i.categories.add("android.intent.category.LAUNCHER");
      i.pkg = pkg;
      i.component = cls;
      i.flags = 0x10000000; // FLAG_ACTIVITY_NEW_TASK, as PackageManager sets
      return i;
    },
  },
});
/** The activity's own `android:theme`, or 0 when it just inherits the application's. */
export function manifestActivityTheme(cls: string): number {
  const node = manifestActivities.get(cls.replace(/\./g, "/"));
  return (node && attr(node, "theme")?.data) ?? 0;
}
/** ActivityInfo for a dotted class name, read off that activity's own manifest node. */
function mkActivityInfo(cls: string): JActivityInfo {
  const node = manifestActivities.get(cls.replace(/\./g, "/"));
  const a = new JActivityInfo();
  a.name = cls;
  a.packageName = appHost?.pkg ?? "";
  a.theme = (node && attr(node, "theme")?.data) ?? appHost?.themeResId ?? 0;
  a.configChanges = (node && attr(node, "configChanges")?.data) ?? 0;
  a.parentActivityName = node ? attrStr(node, "parentActivityName") : null;
  a.metaData = metaData(node);
  return a;
}

// ── Window + decor + ActionBar-lite
/** PhoneWindow's own content handling, not the Dialog subclass's override: appcompat's
 *  setContentView override installs its sub-decor THROUGH Window.setContentView, so dispatching
 *  back to the override would recurse. */
const dialogNative = (name: string, desc: string) => rt.link("android/app/Dialog").ctor.prototype[mangleMethod(name, desc)] as (...a: unknown[]) => unknown;
export class JWindow extends JObj {
  activity: any = null;
  decor: JFrameLayout | null = null;
  contentParent: JFrameLayout | null = null;
  actionBarView: JActionBarView | null = null;
  callbackObj: unknown = null;
  /** a Dialog's window: content goes to the dialog, the context is the dialog's */
  dialog: unknown = null;
  features = new Set<number>();
  /** the window's OnBackInvokedDispatcher (AOSP: one per ViewRootImpl) */
  backD: JObj | null = null;
  backDispatcher(): JObj { return this.backD ??= new (rt.link("android/window/OnBackInvokedDispatcher").ctor)(); }
  /** WindowManager.LayoutParams flags; the shell reads FLAG_FULLSCREEN off the top activity. */
  flags = 0;
  /** WindowManager.LayoutParams width/height/gravity/dimAmount, which size and place a dialog
   *  window; `bg` is an explicit setBackgroundDrawable (a dialog window draws it as its frame). */
  layoutW = -2; layoutH = -2; gravity = 0; dimAmount = Number.NaN;
  bg: JDrawable | null = null; bgSet = false;
  /** WindowInsetsController appearance bits; `appearanceMask` = the bits the app has ever
   *  set or cleared, so the shell can tell "cleared" from "never asked" (device.ts). */
  appearance = 0;
  appearanceMask = 0;
  barsBehavior = 1;
  insetsController: JInsetsController | null = null;
}
export const APPEARANCE_LIGHT_STATUS_BARS = 8;
class JInsetsController extends JObj { w: JWindow = null!; }
/** FLAG_FULLSCREEN moves the window's top edge, so a flag change is a relayout of the decor. */
function setWindowFlags(w: JWindow, flags: number) {
  if (w.flags === flags) return;
  w.flags = flags;
  requestLayout(w.decor);
}
class JActionBarView extends JViewGroup {
  titleStr = "";
  subtitleStr: string | null = null;
  barH = 112;
  icon: JDrawable | null = null;
  /** The options menu, in menu order. The bar/overflow split is derived, never stored. */
  menuItems: JMenuItem[] = [];
  upDrawable: JDrawable | null = null;
  showUp = false;
  navMode = 0;
  navAdapter: unknown = null;
  navSelected = 0;
  navLabel = "";
  /** Holo action bar: 24dp icon at 13.5dp, title at 49.5dp, action slots 56dp apart. */
  slotX(i: number, n: number): number { return this.width() - 56 - (n - 1 - i) * 112; }
  /**
   * Which items get a bar slot and which fall to the overflow. SHOW_AS_ACTION_ALWAYS(2) always
   * gets one; IF_ROOM(1) gets whatever slots are left; NEVER(0) and the leftovers overflow.
   * Draw and hit-test both read this, so the affordance you see is the one you can tap.
   */
  layoutMenu(): { action: JMenuItem[]; overflow: JMenuItem[]; slots: number } {
    const vis = this.menuItems.filter((m) => m.visible);
    const max = Math.max(1, Math.floor(this.width() / 2 / 112));
    const chosen = new Set(vis.filter((m) => m.showAsAction & 2));
    for (const m of vis) if ((m.showAsAction & 3) === 1 && chosen.size < max) chosen.add(m);
    const action = vis.filter((m) => chosen.has(m));
    const overflow = vis.filter((m) => !chosen.has(m));
    return { action, overflow, slots: action.length + (overflow.length ? 1 : 0) };
  }
  onDrawSelf(cv: JCanvas) {
    const ctx = cv.ctx;
    const h = this.height();
    let x = 27;
    if (this.showUp && this.upDrawable) {
      const d = this.upDrawable;
      d.bounds.left = 2; d.bounds.top = h / 2 - 24;
      d.bounds.right = 50; d.bounds.bottom = h / 2 + 24;
      d.paint(cv);
    }
    if (this.icon) {
      this.icon.bounds.left = x; this.icon.bounds.top = h / 2 - 30;
      this.icon.bounds.right = x + 60; this.icon.bounds.bottom = h / 2 + 30;
      this.icon.paint(cv);
      x += 72;
    }
    const { action: shown, overflow, slots } = this.layoutMenu();
    // The title must stop before the first action slot; Android ellipsizes, it does not overlap.
    const titleMax = (slots ? this.slotX(0, slots) - 56 : this.width() - 24) - x - 16;
    ctx.fillStyle = "#ffffff";
    ctx.font = `500 36px ${tfMedium.family}`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const ell = (s: string, max: number) => {
      if (max <= 0 || ctx.measureText(s).width <= max) return s;
      let lo = 0, hi = s.length;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ctx.measureText(s.slice(0, mid) + "\u2026").width <= max) lo = mid; else hi = mid - 1;
      }
      return s.slice(0, lo) + "\u2026";
    };
    const mainLabel = this.navMode === 1 && this.navLabel ? this.navLabel : this.titleStr;
    const two = !!this.subtitleStr;
    ctx.fillText(ell(mainLabel, this.navMode === 1 ? titleMax - 72 : titleMax), x, h / 2 + (two ? -14 : 1));
    if (this.navMode === 1) {
      // list-navigation spinner caret, right of the label
      const lw = ctx.measureText(mainLabel).width;
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      ctx.moveTo(x + lw + 40, h / 2 + 24);
      ctx.lineTo(x + lw + 64, h / 2 + 24);
      ctx.lineTo(x + lw + 64, h / 2);
      ctx.closePath();
      ctx.fill();
    } else if (two) {
      ctx.font = "26px Roboto, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.8)";
      ctx.fillText(this.subtitleStr!, x, h / 2 + 20);
    }
    for (let i = 0; i < shown.length; i++) {
      const item = shown[i];
      const cx = this.slotX(i, slots);
      if (item.icon) {
        item.icon.tint = -1;
        item.icon.bounds.left = cx - 24; item.icon.bounds.top = h / 2 - 24;
        item.icon.bounds.right = cx + 24; item.icon.bounds.bottom = h / 2 + 24;
        item.icon.paint(cv);
      } else {
        ctx.font = "26px Roboto";
        ctx.textAlign = "center";
        ctx.fillStyle = "#fff";
        ctx.fillText(item.title.slice(0, 6), cx, h / 2 + 2);
        ctx.textAlign = "left";
      }
    }
    if (overflow.length) {
      const cx = this.slotX(shown.length, slots);
      ctx.fillStyle = "#fff";
      for (const dy of [-14, 0, 14]) {
        ctx.beginPath();
        ctx.arc(cx, h / 2 + dy, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
rt.register({
  name: "webdroid/ActionBarView", ctor: JActionBarView, sup: "android/view/ViewGroup",
  methods: {
    "onMeasure(II)V": function (this: JActionBarView, wSpec: number, hSpec: number) {
      this.measuredW = specSize(wSpec);
      this.measuredH = this.barH;
    },
    "onDraw(Landroid/graphics/Canvas;)V": function (this: JActionBarView, cv: JCanvas) { this.onDrawSelf(cv); },
    "onTouchEvent(Landroid/view/MotionEvent;)Z": async function (this: JActionBarView, ev: any) {
      if ((ev.action & 0xff) === 1) {
        if (this.showUp && ev.x < 80) {
          // AOSP's ActionBarView reports the Up affordance as the options item
          // android.R.id.home, so it reaches the activity's onOptionsItemSelected like any
          // other item. Finishing here directly would rob every app of that override.
          await performMenuItem(barAnchor(this), mkMenuItem(ID_HOME, ""));
          return 1;
        }
        // Action slots and the overflow affordance own the right end of the bar; they are
        // tested before the list-nav title area, whose hit box otherwise reaches under them.
        const { action, overflow, slots } = this.layoutMenu();
        for (let i = 0; i < action.length; i++) {
          const cx = this.slotX(i, slots);
          if (ev.x >= cx - 56 && ev.x <= cx + 56) { await performMenuItem(barAnchor(this), action[i]); return 1; }
        }
        if (overflow.length) {
          const cx = this.slotX(action.length, slots);
          if (ev.x >= cx - 56 && ev.x <= cx + 56) { await showMenuPopup(barAnchor(this), overflow); return 1; }
        }
        // list-nav spinner tap (title area)
        if (this.navMode === 1 && this.navAdapter && ev.x < this.width() - 200 && ev.x > (this.showUp ? 76 : 24)) {
          const n: number = await vcall(this.navAdapter, "getCount", "()I");
          const items: { id: number; title: string }[] = [];
          for (let i = 0; i < n; i++) {
            const view = await vcall(this.navAdapter, "getView", "(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;", i, null, this);
            items.push({ id: i, title: firstText(view) ?? "" });
          }
          const bar = this;
          showPopupMenu(this, items, (idx) => {
            bar.navSelected = idx;
            const ab = appHost?.currentActivity()?.actionBarObj;
            if (ab) void ab.fireNav(idx);
          });
          return 1;
        }
      }
      return 1;
    },
  },
});
/**
 * AOSP MenuBuilder.performItemAction: the item's own click listener first, then the Activity
 * callback (onMenuItemSelected → onOptionsItemSelected), honouring the boolean; an item that
 * carries a sub-menu then opens it. Every menu affordance — action slot, overflow, sub-menu
 * pick, openOptionsMenu — funnels through here, so there is one dispatch path, not four.
 */
async function performMenuItem(anchor: JView, item: JMenuItem): Promise<boolean> {
  if (!item.enabled) return false;
  let invoked = false;
  try {
    if (item.clickL) {
      invoked = !!(await vcall(item.clickL, "onMenuItemClick", "(Landroid/view/MenuItem;)Z", item));
    }
    const act = appHost?.currentActivity();
    if (!invoked && act) {
      invoked = !!(await vcall(act, "onMenuItemSelected", "(ILandroid/view/MenuItem;)Z", 0, item));
    }
    if (item.sub) await showMenuPopup(anchor, item.sub.items);
  } catch (e) { reportUncaught(e); }
  invalidate();
  return invoked;
}
/**
 * showPopupMenu drops its list 20px below the anchor's TOP edge; an action-bar menu drops from
 * the bar's BOTTOM edge, so anchor it to a zero-size point at the bar's bottom-right corner.
 */
function barAnchor(bar: JActionBarView): JView {
  const a = new JView();
  a.parent = bar;
  a.left = a.right = bar.width() - 8;
  a.top = a.bottom = bar.height() - 20;
  a.jres = bar.jres;
  a.theme = bar.theme;
  return a;
}
/**
 * Menu item ids are not unique (a sub-menu anchor usually carries none), so the popup is keyed
 * by position and the pick is mapped back to the item here.
 */
async function showMenuPopup(anchor: JView, items: JMenuItem[]) {
  const vis = items.filter((i) => i.visible);
  if (!vis.length) return;
  showPopupMenu(anchor, vis.map((it, i) => ({ id: i, title: it.title })),
    (i) => { void performMenuItem(anchor, vis[i]); });
}

// Menu natives (filled by MenuInflater)
export class JMenu extends JObj {
  bar: JActionBarView | null = null;
  items: JMenuItem[] = [];
}
class JMenuItem extends JObj {
  id = 0;
  title = "";
  icon: JDrawable | null = null;
  showAsAction = 0;
  visible = true;
  enabled = true;
  checked = false;
  checkable = false;
  clickL: unknown = null;
  sub: JMenu | null = null;
}
/** android.R.id.home — the id AOSP gives the action bar's Up/home affordance. */
const ID_HOME = 0x0102002c;
function mkMenuItem(id: number, title: string): JMenuItem {
  const m = new JMenuItem();
  m.id = id; m.title = title;
  return m;
}
const menuItemMethods: NativeSpec["methods"] = {
  "getItemId()I": function (this: JMenuItem) { return this.id; },
  "getTitle()Ljava/lang/CharSequence;": function (this: JMenuItem) { return this.title; },
  "setTitle(Ljava/lang/CharSequence;)Landroid/view/MenuItem;": function (this: JMenuItem, t: unknown) {
    this.title = String(t ?? "");
    return this;
  },
  "setTitle(I)Landroid/view/MenuItem;": function (this: JMenuItem, id: number) {
    this.title = appString(id);
    return this;
  },
  "setIcon(I)Landroid/view/MenuItem;": async function (this: JMenuItem, id: number) {
    if (appHost && id) this.icon = await loadDrawable(appHost.res, id, appHost.theme);
    return this;
  },
  "setIcon(Landroid/graphics/drawable/Drawable;)Landroid/view/MenuItem;": function (this: JMenuItem, d: JDrawable | null) {
    this.icon = d;
    return this;
  },
  "getIcon()Landroid/graphics/drawable/Drawable;": function (this: JMenuItem) { return this.icon; },
  "setVisible(Z)Landroid/view/MenuItem;": function (this: JMenuItem, v: number) { this.visible = !!v; invalidate(); return this; },
  "isVisible()Z": function (this: JMenuItem) { return this.visible ? 1 : 0; },
  "setEnabled(Z)Landroid/view/MenuItem;": function (this: JMenuItem, v: number) { this.enabled = !!v; return this; },
  "isEnabled()Z": function (this: JMenuItem) { return this.enabled ? 1 : 0; },
  "setChecked(Z)Landroid/view/MenuItem;": function (this: JMenuItem, v: number) { this.checked = !!v; return this; },
  "isChecked()Z": function (this: JMenuItem) { return this.checked ? 1 : 0; },
  "setCheckable(Z)Landroid/view/MenuItem;": function (this: JMenuItem, v: number) { this.checkable = !!v; return this; },
  "setShowAsAction(I)V": function (this: JMenuItem, v: number) { this.showAsAction = v; invalidate(); },
  "setOnActionExpandListener(Landroid/view/MenuItem$OnActionExpandListener;)Landroid/view/MenuItem;":
    function (this: JMenuItem) { return this; },
  "setOnMenuItemClickListener(Landroid/view/MenuItem$OnMenuItemClickListener;)Landroid/view/MenuItem;":
    function (this: JMenuItem, l: unknown) { this.clickL = l; return this; },
  "getSubMenu()Landroid/view/SubMenu;": function (this: JMenuItem) { return this.sub; },
  "hasSubMenu()Z": function (this: JMenuItem) { return this.sub ? 1 : 0; },
  "setTitleCondensed(Ljava/lang/CharSequence;)Landroid/view/MenuItem;": function (this: JMenuItem) { return this; },
  "setAlphabeticShortcut(C)Landroid/view/MenuItem;": function (this: JMenuItem) { return this; },
  "getOrder()I": () => 0,
  "getGroupId()I": () => 0,
  "setActionView(Landroid/view/View;)Landroid/view/MenuItem;": function (this: JMenuItem) { return this; },
  "getActionView()Landroid/view/View;": () => null,
  "expandActionView()Z": () => 0,
  "collapseActionView()Z": () => 0,
};
rt.register({ name: "webdroid/MenuItem", ctor: JMenuItem, ifaces: ["android/view/MenuItem"], methods: menuItemMethods });
rt.register({ name: "android/view/MenuItem", ctor: class extends JObj {} });
rt.register({ name: "android/view/SubMenu", ctor: class extends JObj {} });
// Callback interfaces a menu's owner implements. An unregistered one auto-stubs and poisons
// the app class declaring it, which takes the whole menu down with it.
rt.register({ name: "android/view/MenuItem$OnMenuItemClickListener", ctor: class extends JObj {} });
rt.register({ name: "android/view/MenuItem$OnActionExpandListener", ctor: class extends JObj {} });
rt.register({ name: "android/view/CollapsibleActionView", ctor: class extends JObj {} });
rt.register({ name: "android/view/ActionProvider$VisibilityListener", ctor: class extends JObj {} });
// ActionProvider is an abstract class an app subclasses; the base keeps the visibility
// listener and answers the queries AOSP's default implementation does.
class JActionProvider extends JObj { visL: unknown = null; }
rt.register({
  name: "android/view/ActionProvider", ctor: JActionProvider,
  methods: {
    "<init>(Landroid/content/Context;)V": function () {},
    "onCreateActionView()Landroid/view/View;": () => null,
    "onCreateActionView(Landroid/view/MenuItem;)Landroid/view/View;": function (this: JActionProvider) {
      return vcall(this, "onCreateActionView", "()Landroid/view/View;");
    },
    "onPerformDefaultAction()Z": () => 0,
    "hasSubMenu()Z": () => 0,
    "onPrepareSubMenu(Landroid/view/SubMenu;)V": () => {},
    "overridesItemVisibility()Z": () => 0,
    "isVisible()Z": () => 1,
    "refreshVisibility(Z)V": function (this: JActionProvider, v: number) {
      if (this.visL) void vcall(this.visL, "onActionProviderVisibilityChanged", "(Z)V", v);
    },
    "setVisibilityListener(Landroid/view/ActionProvider$VisibilityListener;)V": function (this: JActionProvider, l: unknown) { this.visL = l; },
  },
});
const menuMethods: NativeSpec["methods"] = {
  "add(Ljava/lang/CharSequence;)Landroid/view/MenuItem;": function (this: JMenu, t: unknown) {
    const m = mkMenuItem(0, String(t ?? ""));
    this.items.push(m);
    pushMenuToBar(this);
    return m;
  },
  "add(IIILjava/lang/CharSequence;)Landroid/view/MenuItem;": function (this: JMenu, g: number, id: number, o: number, t: unknown) {
    const m = mkMenuItem(id, String(t ?? ""));
    this.items.push(m);
    pushMenuToBar(this);
    return m;
  },
  "add(IIII)Landroid/view/MenuItem;": function (this: JMenu, g: number, id: number, o: number, tid: number) {
    const m = mkMenuItem(id, appString(tid));
    this.items.push(m);
    pushMenuToBar(this);
    return m;
  },
  "findItem(I)Landroid/view/MenuItem;": function (this: JMenu, id: number) {
    return this.items.find((i) => i.id === id) ?? null;
  },
  "removeItem(I)V": function (this: JMenu, id: number) {
    this.items = this.items.filter((i) => i.id !== id);
    pushMenuToBar(this);
  },
  "clear()V": function (this: JMenu) { this.items = []; pushMenuToBar(this); },
  "size()I": function (this: JMenu) { return this.items.length; },
  "getItem(I)Landroid/view/MenuItem;": function (this: JMenu, i: number) { return this.items[i] ?? null; },
  "addSubMenu(Ljava/lang/CharSequence;)Landroid/view/SubMenu;": function (this: JMenu, t: unknown) {
    const item = mkMenuItem(0, String(t ?? ""));
    item.sub = new JMenu();
    this.items.push(item);
    return item.sub;
  },
  "setGroupVisible(IZ)V": () => {},
  "hasVisibleItems()Z": function (this: JMenu) { return this.items.some((i) => i.visible) ? 1 : 0; },
};
export function pushMenuToBar(menu: JMenu) {
  if (!menu.bar) return;
  // The items themselves, not a snapshot: setVisible/setTitle/setShowAsAction after inflation
  // must reach the bar, and a pick has to be able to find the item's sub-menu and listener.
  menu.bar.menuItems = menu.items;
  invalidate();
}
rt.register({ name: "webdroid/Menu", ctor: JMenu, ifaces: ["android/view/Menu"], methods: menuMethods });
rt.register({ name: "android/view/Menu", ctor: class extends JObj {}, statics: { NONE: 0, FIRST: 1 } });

// MenuInflater: parse res/menu xml
class JMenuInflater extends JObj { jctx: any = null; }
rt.register({
  name: "android/view/MenuInflater", ctor: JMenuInflater,
  methods: {
    "<init>(Landroid/content/Context;)V": function (this: JMenuInflater, c: unknown) { this.jctx = c; },
    "inflate(ILandroid/view/Menu;)V": async function (this: JMenuInflater, id: number, menu: JMenu) {
      const host: AppHost = this.jctx.$host;
      const f = host.res.fileOf(id);
      if (!f) { rt.noteMissing("menu 0x" + id.toString(16)); return; }
      const root = parseAXML(f.bytes);
      const A_id = 0x010100d0, A_title = AID("title"), A_icon = AID("icon"), A_showAsAction = AID("showAsAction");
      const walk = async (node: typeof root, target: JMenu) => {
        for (const c of node.children) {
          if (c.name !== "item") { if (c.name === "group") await walk(c, target); continue; }
          const item = mkMenuItem(0, "");
          for (const a of c.attrs) {
            if (a.resId === A_id) item.id = a.data;
            else if (a.resId === A_title) {
              item.title = a.type === TV.STRING ? a.str ?? "" : rvString(host.res, host.res.resolveRefs({ t: a.type, d: a.data })) ?? "";
            } else if (a.resId === A_icon && a.data) {
              item.icon = await loadDrawableRV(host.res, { t: a.type, d: a.data }, host.theme);
            } else if (a.resId === A_showAsAction) item.showAsAction = a.data;
          }
          if (c.children.length && c.children[0]?.name === "menu") {
            item.sub = new JMenu();
            await walk(c.children[0], item.sub);
          }
          target.items.push(item);
        }
      };
      await walk(root, menu);
      pushMenuToBar(menu);
    },
  },
});

export class JActivity extends JContextWrapper {
  window = new JWindow();
  intent: JIntent | null = null;
  titleStr = "";
  finished = false;
  resumed = false;
  started = false;
  hasWindowFocus = false;
  actionBarObj: any = null;
  optionsMenu: JMenu | null = null;
  resultCode = 0;
  resultData: JIntent | null = null;
  /** who asked for this activity's result, and under which request code */
  resultTo: { act: JActivity; code: number } | null = null;
  lifecycleCbs: unknown[] | null = null;
  fragMgr: any = null;
  // set while a configuration-change relaunch is tearing this instance down, so androidx keeps
  // the ViewModelStore alive; the retained object is handed to the replacement instance.
  changingConfigurations = false;
  lastNonConfig: unknown = null;
}
/** Fire an ActivityLifecycleCallbacks event (both Pre/Post + the plain variant, API 29+ shapes).
 *  androidx ReportFragment.LifecycleCallbacks uses the Post* variants to advance the activity Lifecycle. */
export async function fireActivityLifecycle(act: JActivity, phase: "Created" | "Started" | "Resumed" | "Paused" | "Stopped" | "Destroyed", bundle: unknown = null) {
  // process-wide callbacks (Application.registerActivityLifecycleCallbacks) then this
  // activity's own (API 29 Activity.registerActivityLifecycleCallbacks) — one dispatch point.
  const app = act.$host?.application as JApplication | null | undefined;
  const cbs = [...(app?.lifecycleCbs ?? []), ...(act.lifecycleCbs ?? [])];
  if (!cbs.length) return;
  const withBundle = phase === "Created";
  const sig = withBundle ? "(Landroid/app/Activity;Landroid/os/Bundle;)V" : "(Landroid/app/Activity;)V";
  const args = withBundle ? [act, bundle] : [act];
  for (const cb of cbs) {
    for (const variant of [`onActivityPre${phase}`, `onActivity${phase}`, `onActivityPost${phase}`]) {
      // only call variants the callback actually implements (androidx impls vary by API level)
      const key = mangleMethod(variant, sig);
      const fn = (cb as Record<string, unknown>)[key];
      if (typeof fn !== "function") continue;
      try { const r = (fn as (...a: unknown[]) => unknown).apply(cb, args); if (r instanceof Promise) await r; }
      catch (e) { reportUncaught(e); }
    }
  }
}
/** Activity (API 29+) and Application both keep their own ActivityLifecycleCallbacks list */
const lifecycleCbMethods: NativeSpec["methods"] = {
  "registerActivityLifecycleCallbacks(Landroid/app/Application$ActivityLifecycleCallbacks;)V": function (this: { lifecycleCbs: unknown[] | null }, cb: unknown) {
    (this.lifecycleCbs ??= []).push(cb);
  },
  "unregisterActivityLifecycleCallbacks(Landroid/app/Application$ActivityLifecycleCallbacks;)V": function (this: { lifecycleCbs: unknown[] | null }, cb: unknown) {
    if (this.lifecycleCbs) this.lifecycleCbs = this.lifecycleCbs.filter((c) => c !== cb);
  },
};
const activityMethods: NonNullable<NativeSpec["methods"]> = {
  ...contextMethods,
  "<init>()V": function (this: JActivity) { this.window.activity = this; },
  "getWindow()Landroid/view/Window;": function (this: JActivity) { return this.window; },
  "getOnBackInvokedDispatcher()Landroid/window/OnBackInvokedDispatcher;": function (this: JActivity) { return this.window.backDispatcher(); },
  "getApplication()Landroid/app/Application;": function (this: JActivity) { return this.$host.application; },
  ...lifecycleCbMethods,
  "getWindowManager()Landroid/view/WindowManager;": function (this: JActivity) { return systemService(this, "window"); },
  "getIntent()Landroid/content/Intent;": function (this: JActivity) { return this.intent ?? (this.intent = new JIntent()); },
  "setIntent(Landroid/content/Intent;)V": function (this: JActivity, i: JIntent) { this.intent = i; },
  "getLayoutInflater()Landroid/view/LayoutInflater;": function (this: JActivity) { return getInflater(this); },
  "getMenuInflater()Landroid/view/MenuInflater;": function (this: JActivity) {
    const m = new JMenuInflater();
    m.jctx = this;
    return m;
  },
  "setContentView(I)V": async function (this: JActivity, layoutId: number) {
    await ensureDecor(this);
    this.window.contentParent!.children.length = 0;
    await inflateLayout(this, layoutId, this.window.contentParent, true);
    requestLayout();
  },
  "setContentView(Landroid/view/View;)V": async function (this: JActivity, v: JView) {
    await ensureDecor(this);
    this.window.contentParent!.children.length = 0;
    if (!v.lp) {
      const lp = new (rt.link("android/widget/FrameLayout$LayoutParams").ctor)();
      lp.width = -1; lp.height = -1;
      v.lp = lp;
    }
    attachView(this.window.contentParent!, v);
    requestLayout();
  },
  "setContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": async function (this: JActivity, v: JView, lp: any) {
    v.lp = lp;
    await (activityMethods["setContentView(Landroid/view/View;)V"] as any).call(this, v);
  },
  "addContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": async function (this: JActivity, v: JView, lp: any) {
    await ensureDecor(this);
    v.lp = lp;
    attachView(this.window.contentParent!, v);
  },
  "findViewById(I)Landroid/view/View;": function (this: JActivity, id: number) {
    return this.window.decor ? findById(this.window.decor, id) : null;
  },
  "onCreate(Landroid/os/Bundle;)V": function () {},
  "onPostCreate(Landroid/os/Bundle;)V": function () {},
  "onStart()V": function (this: JActivity) { this.started = true; return dispatchFragLifecycle(this, "onStart"); },
  "onRestart()V": function () {},
  "onResume()V": function (this: JActivity) { this.resumed = true; return dispatchFragLifecycle(this, "onResume"); },
  "onPostResume()V": function () {},
  "onPause()V": function (this: JActivity) { this.resumed = false; return dispatchFragLifecycle(this, "onPause"); },
  "onStop()V": function (this: JActivity) { this.started = false; return dispatchFragLifecycle(this, "onStop"); },
  "onDestroy()V": function (this: JActivity) { return dispatchFragLifecycle(this, "onDestroy"); },
  /**
   * AOSP Activity.onBackPressed: collapse an expanded action view, then pop the fragment
   * back stack, and only if neither consumed the press, finish. androidx apps land here as
   * the OnBackPressedDispatcher's fallback, after their own callbacks declined it.
   */
  "onBackPressed()V": async function (this: JActivity) {
    const bar = this.actionBarObj;
    if (bar && (await vcall(bar, "collapseActionView", "()Z"))) return;
    const fm = await vcall(this, "getFragmentManager", "()Landroid/app/FragmentManager;");
    if (fm && !(await vcall(fm, "isStateSaved", "()Z")) && (await vcall(fm, "popBackStackImmediate", "()Z"))) return;
    await vcall(this, "finish", "()V");
  },
  "onNewIntent(Landroid/content/Intent;)V": function () {},
  "onSaveInstanceState(Landroid/os/Bundle;)V": function () {},
  "onRestoreInstanceState(Landroid/os/Bundle;)V": function () {},
  "onCreateOptionsMenu(Landroid/view/Menu;)Z": () => 1,
  "onPrepareOptionsMenu(Landroid/view/Menu;)Z": () => 1,
  // Android routes the options panel through onCreatePanelMenu/onPreparePanel/onMenuItemSelected;
  // apps (and androidx) override those, so the panel entry points must exist and delegate.
  "onCreatePanelMenu(ILandroid/view/Menu;)Z": function (this: JActivity, f: number, menu: JMenu) {
    return f === 0 ? vcall(this, "onCreateOptionsMenu", "(Landroid/view/Menu;)Z", menu) : 1;
  },
  "onPreparePanel(ILandroid/view/View;Landroid/view/Menu;)Z": function (this: JActivity, f: number, _v: unknown, menu: JMenu) {
    return f === 0 ? vcall(this, "onPrepareOptionsMenu", "(Landroid/view/Menu;)Z", menu) : 1;
  },
  "onMenuItemSelected(ILandroid/view/MenuItem;)Z": async function (this: JActivity, f: number, item: JMenuItem) {
    if (f !== 0) return 0;
    if (await vcall(this, "onOptionsItemSelected", "(Landroid/view/MenuItem;)Z", item)) return 1;
    // AOSP: an android.R.id.home nobody claimed, with DISPLAY_HOME_AS_UP set, becomes Up
    // navigation. Apps that handle Up themselves (popping a fragment, collapsing a search)
    // never get here because their onOptionsItemSelected already returned true.
    const id: number = await vcall(item, "getItemId", "()I");
    if (id === ID_HOME && this.window.actionBarView?.showUp) {
      return (await vcall(this, "onNavigateUp", "()Z")) ? 1 : 0;
    }
    return 0;
  },
  "onOptionsItemSelected(Landroid/view/MenuItem;)Z": () => 0,
  /**
   * AOSP walks getParentActivityIntent() and either recreates the task or navigateUpTo()s.
   * We have one task and no affinities, so the parent is simply whatever sits below us on
   * the stack: Up on it is Back. Routed through finish() so an app override still runs.
   */
  "onNavigateUp()Z": async function (this: JActivity) {
    await vcall(this, "finish", "()V");
    return 1;
  },
  "onNavigateUpFromChild(Landroid/app/Activity;)Z": function (this: JActivity) {
    return vcall(this, "onNavigateUp", "()Z");
  },
  "onActivityResult(IILandroid/content/Intent;)V": function () {},
  "onRequestPermissionsResult(I[Ljava/lang/String;[I)V": function () {},
  /** AOSP forwards the new Configuration into the window's view hierarchy. */
  "onConfigurationChanged(Landroid/content/res/Configuration;)V": function (this: JActivity, cfg: unknown) {
    return this.window.decor ? dispatchConfigurationChanged(this.window.decor, cfg) : undefined;
  },
  "onWindowFocusChanged(Z)V": function () {},
  "onAttachedToWindow()V": function () {},
  // the rest of Window.Callback, as Activity's no-op defaults
  "onContentChanged()V": function () {},
  "onDetachedFromWindow()V": function () {},
  "onWindowAttributesChanged(Landroid/view/WindowManager$LayoutParams;)V": function () {},
  "onPanelClosed(ILandroid/view/Menu;)V": function () {},
  "onSearchRequested()Z": () => 0,
  "onSearchRequested(Landroid/view/SearchEvent;)Z": () => 0,
  "onActionModeStarted(Landroid/view/ActionMode;)V": function () {},
  "onActionModeFinished(Landroid/view/ActionMode;)V": function () {},
  "onWindowStartingActionMode(Landroid/view/ActionMode$Callback;)Landroid/view/ActionMode;": () => null,
  "onWindowStartingActionMode(Landroid/view/ActionMode$Callback;I)Landroid/view/ActionMode;": () => null,
  "onPointerCaptureChanged(Z)V": function () {},
  "onProvideKeyboardShortcuts(Ljava/util/List;Landroid/view/Menu;I)V": function () {},
  "onLowMemory()V": function () {},
  "onTrimMemory(I)V": function () {},
  "onUserInteraction()V": function () {},
  "onTitleChanged(Ljava/lang/CharSequence;I)V": function () {},
  "onChildTitleChanged(Landroid/app/Activity;Ljava/lang/CharSequence;)V": function () {},
  "onCreateView(Ljava/lang/String;Landroid/content/Context;Landroid/util/AttributeSet;)Landroid/view/View;": () => null,
  "onCreateView(Landroid/view/View;Ljava/lang/String;Landroid/content/Context;Landroid/util/AttributeSet;)Landroid/view/View;": () => null,
  "onKeyDown(ILandroid/view/KeyEvent;)Z": () => 0,
  "onKeyUp(ILandroid/view/KeyEvent;)Z": () => 0,
  "onTouchEvent(Landroid/view/MotionEvent;)Z": () => 0,
  "invalidateOptionsMenu()V": function (this: JActivity) { appHost?.invalidateOptionsMenu(this); },
  "supportInvalidateOptionsMenu()V": function (this: JActivity) { appHost?.invalidateOptionsMenu(this); },
  "openOptionsMenu()V": function (this: JActivity) {
    const bar = this.window.actionBarView;
    if (!bar) return;
    const { overflow } = bar.layoutMenu();
    void showMenuPopup(barAnchor(bar), overflow.length ? overflow : bar.menuItems);
  },
  "closeOptionsMenu()V": function () {},
  "setTitle(Ljava/lang/CharSequence;)V": function (this: JActivity, t: unknown) {
    this.titleStr = String(t ?? "");
    if (this.window.actionBarView) { this.window.actionBarView.titleStr = this.titleStr; invalidate(); }
  },
  "setTitle(I)V": function (this: JActivity, id: number) {
    (activityMethods["setTitle(Ljava/lang/CharSequence;)V"] as any).call(this, resString(this.$host.res, id));
  },
  "getTitle()Ljava/lang/CharSequence;": function (this: JActivity) { return this.titleStr; },
  "getActionBar()Landroid/app/ActionBar;": function (this: JActivity) {
    if (!this.actionBarObj) {
      const info = rt.link("webdroid/ActionBar");
      this.actionBarObj = new info.ctor();
      this.actionBarObj.act = this;
    }
    return this.actionBarObj;
  },
  "runOnUiThread(Ljava/lang/Runnable;)V": function (this: JActivity, r: unknown) {
    void onMain(() => vcall(r, "run", "()V").catch(reportUncaught));
  },
  "finish()V": function (this: JActivity) {
    if (!this.finished) {
      this.finished = true;
      appHost?.finishActivity(this);
    }
  },
  "finishAffinity()V": function (this: JActivity) { (activityMethods["finish()V"] as any).call(this); },
  "isFinishing()Z": function (this: JActivity) { return this.finished ? 1 : 0; },
  "isDestroyed()Z": function (this: JActivity) { return this.finished ? 1 : 0; },
  "isTaskRoot()Z": () => 1,
  // AOSP's startActivityForResult only *starts* something; the result arrives later through
  // onActivityResult. Awaiting a system activity here would hold the serialized main-looper
  // queue for as long as its (native, modal) UI is up, which reads as a wedge.
  "startActivityForResult(Landroid/content/Intent;I)V": async function (this: JActivity, intent: JIntent, code: number) {
    const sys = intent?.component ? null : systemActivities[intent?.action ?? ""];
    if (sys) {
      void sys(intent).then(
        (data) => deliverActivityResult(this, code, data ? RESULT_OK : RESULT_CANCELED, data),
        (e) => { reportUncaught(e); deliverActivityResult(this, code, RESULT_CANCELED, null); },
      );
      return;
    }
    await launchIntent(this.$host, intent);
    const started = this.$host.currentActivity();
    if (started && started !== this) started.resultTo = { act: this, code };
  },
  // ActivityCompat — and so every androidx ActivityResultRegistry launcher — calls the options
  // overload, which must funnel into the body above rather than carry a second copy of it.
  "startActivityForResult(Landroid/content/Intent;ILandroid/os/Bundle;)V": function (this: JActivity, intent: JIntent, code: number) {
    return (activityMethods["startActivityForResult(Landroid/content/Intent;I)V"] as any).call(this, intent, code);
  },
  "setResult(I)V": function (this: JActivity, c: number) { this.resultCode = c; },
  "setResult(ILandroid/content/Intent;)V": function (this: JActivity, c: number, d: JIntent) {
    this.resultCode = c;
    this.resultData = d;
  },
  "requestWindowFeature(I)Z": function (this: JActivity, f: number) { this.window.features.add(f); return 1; },
  "setRequestedOrientation(I)V": () => {},
  "getRequestedOrientation()I": () => 1,
  "getComponentName()Landroid/content/ComponentName;": function (this: JActivity) {
    return mkComponentName(this.$host.pkg, jclsNameOf(this));
  },
  "getLocalClassName()Ljava/lang/String;": function (this: JActivity) { return jclsNameOf(this); },
  "getCallingActivity()Landroid/content/ComponentName;": () => null,
  "overridePendingTransition(II)V": () => {},
  "getPreferences(I)Landroid/content/SharedPreferences;": function (this: JActivity) {
    return getPrefs(this.$host.pkg, jclsNameOf(this));
  },
  // One manager per activity: a fresh instance per call could never hold a back stack, and
  // onBackPressed asks it whether the press was consumed.
  "getFragmentManager()Landroid/app/FragmentManager;": function (this: JActivity) {
    if (!this.fragMgr) {
      this.fragMgr = new (rt.link("android/app/FragmentManager").ctor)();
      this.fragMgr.act = this;
    }
    return this.fragMgr;
  },
  "getCurrentFocus()Landroid/view/View;": () => null,
  "hasWindowFocus()Z": function (this: JActivity) { return this.hasWindowFocus ? 1 : 0; },
  "isChangingConfigurations()Z": function (this: JActivity) { return this.changingConfigurations ? 1 : 0; },
  // Activity.isChild is only true for the long-dead ActivityGroup embedding; AppCompat asks it
  // before relaunching for a night-mode change.
  "isChild()Z": () => 0,
  "recreate()V": function (this: JActivity) { appHost?.recreateActivity(this); },
  "reportFullyDrawn()V": () => {},
  "onRetainNonConfigurationInstance()Ljava/lang/Object;": () => null,
  "onRetainCustomNonConfigurationInstance()Ljava/lang/Object;": () => null,
  "getLastNonConfigurationInstance()Ljava/lang/Object;": function (this: JActivity) { return this.lastNonConfig; },
  "getChangingConfigurations()I": () => 0,
  "getTaskId()I": () => 1,
  "shouldShowRequestPermissionRationale(Ljava/lang/String;)Z": () => 0,
  "requestPermissions([Ljava/lang/String;I)V": async function (this: JActivity, perms: string[], code: number) {
    const granted = new Int32Array(perms.length); // all granted (0)
    setTimeout(() => {
      void vcall(this, "onRequestPermissionsResult", "(I[Ljava/lang/String;[I)V", code, perms, granted).catch(reportUncaught);
    }, 0);
  },
  "dispatchTouchEvent(Landroid/view/MotionEvent;)Z": () => 0,
  "setVolumeControlStream(I)V": () => {},
  "getVolumeControlStream()I": () => 3,
  "setDefaultKeyMode(I)V": () => {},
  "showDialog(I)V": () => {},
  "dismissDialog(I)V": () => {},
  "setFinishOnTouchOutside(Z)V": () => {},
  "isInMultiWindowMode()Z": () => 0,
  "getReferrer()Landroid/net/Uri;": () => null,
};
function jclsNameOf(o: unknown): string {
  return ((o as any)?.constructor?.$i?.name ?? "unknown").replace(/\//g, ".");
}
rt.register({
  name: "android/app/Activity", ctor: JActivity, sup: "android/view/ContextThemeWrapper",
  // AOSP's Activity implements these; a library that casts an activity to one of them
  // (ComponentCallbacks2 for trim-memory, KeyEvent.Callback for key dispatch) must not fail
  ifaces: ["android/view/Window$Callback", "android/view/LayoutInflater$Factory2",
    "android/content/ComponentCallbacks2", "android/content/ComponentCallbacks",
    "android/view/KeyEvent$Callback", "android/view/View$OnCreateContextMenuListener"],
  statics: { RESULT_OK: -1, RESULT_CANCELED: 0, DEFAULT_KEYS_DISABLE: 0 },
  methods: activityMethods,
});
rt.register({ name: "android/view/Window$Callback", ctor: class extends JObj {} });

/** Build the decor tree for an activity based on its theme */
export async function ensureDecor(act: JActivity) {
  if (act.window.decor) return;
  getInflater(act).privateFactory = act; // framework: the Activity is the private Factory2
  const host = act.$host;
  const theme: JTheme = themeOf(act) ?? host.theme;
  const decor = new JFrameLayout();
  decor.ctx = act;
  decor.jres = host.res;
  decor.theme = theme;
  const winBg = theme.lookup(AID("windowBackground"));
  if (winBg) decor.background = await loadDrawableRV(host.res, winBg, theme);
  else decor.background = (() => { const d = new JColorDrawable(); d.color = -328966; return d; })();
  const noTitle = rvInt(host.res, themeByName(host.res, theme, "windowNoTitle"), 0);
  const actionBar = rvInt(host.res, themeByName(host.res, theme, "windowActionBar"), noTitle ? 0 : 1);
  // a *.Fullscreen theme is the same request as Window.addFlags(FLAG_FULLSCREEN): no status bar
  if (rvInt(host.res, theme.lookup(AID("windowFullscreen")), 0)) act.window.flags |= 1024;
  const root = new JLinearLayout();
  root.orientation = 1;
  root.ctx = act;
  root.jres = host.res;
  root.theme = theme;
  {
    const lp = new (rt.link("android/widget/LinearLayout$LayoutParams").ctor)();
    lp.width = -1; lp.height = -1;
    root.lp = lp;
  }
  if (actionBar && !noTitle) {
    const bar = new JActionBarView();
    bar.ctx = act;
    bar.jres = host.res;
    bar.theme = theme;
    bar.titleStr = act.titleStr || host.appLabel;
    bar.barH = rvDimen(host.res, theme.lookup(AID("actionBarSize")), 112) || 112;
    const abStyle = theme.lookup(AID("actionBarStyle"));
    let bg: RVLike | null = null;
    if (abStyle && (abStyle.t === TV.REFERENCE)) {
      let bgv = host.res.styleLookup(abStyle.d, AID("background"));
      // Widget.Material.ActionBar.Solid#background is ?attr/colorPrimary — an ATTRIBUTE
      // reference, which only the theme can resolve; Holo's is a nine-patch we synthesise.
      if (bgv && bgv.t === TV.ATTRIBUTE) bgv = theme.lookup(bgv.d);
      if (bgv) bg = bgv;
    }
    const primary = theme.lookup(AID("colorPrimary"));
    // The bar paints whatever the style names -- Holo's is a nine-patch, Material's resolves
    // through ?attr/colorPrimary to a colour. Only a flat colour can tint the status bar.
    let bgD = bg ? await loadDrawableRV(host.res, bg as any, theme) : null;
    if (!bgD || (bgD instanceof JColorDrawable && !bgD.color)) {
      const c = new JColorDrawable();
      c.color = primary ? rvColor(host.res, primary, -12303292) : -12303292;
      bgD = c;
    }
    bar.background = bgD;
    if (host.iconRes) bar.icon = await loadDrawableRV(host.res, { t: TV.REFERENCE, d: host.iconRes }, theme);
    const upv = theme.lookup(AID("homeAsUpIndicator"));
    if (upv) bar.upDrawable = await loadDrawableRV(host.res, upv as any, theme);
    if (bgD instanceof JColorDrawable) host.statusBarColor = darken(bgD.color);
    const sbc = theme.lookup(AID("statusBarColor"));
    if (sbc) host.statusBarColor = rvColor(host.res, sbc, host.statusBarColor);
    const lp = new (rt.link("android/widget/LinearLayout$LayoutParams").ctor)();
    lp.width = -1; lp.height = -2;
    bar.lp = lp;
    attachView(root, bar);
    act.window.actionBarView = bar;
  } else {
    const sbc = theme.lookup(AID("statusBarColor"));
    host.statusBarColor = sbc ? rvColor(host.res, sbc, -16777216) : -16777216;
  }
  const content = new JFrameLayout();
  content.ctx = act;
  content.jres = host.res;
  content.theme = theme;
  content.idNum = 0x01020002; // android.R.id.content
  {
    const lp = new (rt.link("android/widget/LinearLayout$LayoutParams").ctor)();
    lp.width = -1; lp.height = 0;
    (lp as any).weight = 1;
    content.lp = lp;
  }
  attachView(root, content);
  {
    const lp2 = new (rt.link("android/widget/FrameLayout$LayoutParams").ctor)();
    lp2.width = -1; lp2.height = -1;
    root.lp = lp2;
  }
  attachView(decor, root);
  act.window.decor = decor;
  act.window.contentParent = content;
}
type RVLike = { t: number; d: number };
function firstText(v: any): string | null {
  if (v?.text) return String(v.text);
  for (const c of v?.children ?? []) { const t = firstText(c); if (t) return t; }
  return null;
}
function darken(c: number): number {
  const r = Math.max(0, ((c >> 16) & 0xff) * 0.8) | 0;
  const g = Math.max(0, ((c >> 8) & 0xff) * 0.8) | 0;
  const b = Math.max(0, (c & 0xff) * 0.8) | 0;
  return (0xff000000 | (r << 16) | (g << 8) | b) | 0;
}

// window natives
rt.register({
  name: "android/view/Window", ctor: JWindow,
  methods: {
    "setStatusBarContrastEnforced(Z)V": () => {},
    "setNavigationBarContrastEnforced(Z)V": () => {},
    "isStatusBarContrastEnforced()Z": () => 0,
    "isNavigationBarContrastEnforced()Z": () => 0,
    "getDecorView()Landroid/view/View;": async function (this: JWindow) {
      // AOSP installs the real decor on first access (appcompat asks for it before
      // setContentView); dialog windows materialize a bare one so insets helpers can operate
      if (!this.decor && this.activity instanceof JActivity) await ensureDecor(this.activity);
      return this.decor ??= await newObj("android/widget/FrameLayout", "(Landroid/content/Context;)V", this.activity);
    },
    "peekDecorView()Landroid/view/View;": function (this: JWindow) { return this.decor; },
    "findViewById(I)Landroid/view/View;": function (this: JWindow, id: number) {
      return this.decor ? findById(this.decor, id) : null;
    },
    "setContentView(I)V": function (this: JWindow, id: number) {
      if (this.dialog) return dialogNative("setContentView", "(I)V").call(this.dialog, id);
      return (activityMethods["setContentView(I)V"] as any).call(this.activity, id);
    },
    "setContentView(Landroid/view/View;)V": function (this: JWindow, v: unknown) {
      if (this.dialog) return dialogNative("setContentView", "(Landroid/view/View;)V").call(this.dialog, v);
      return (activityMethods["setContentView(Landroid/view/View;)V"] as any).call(this.activity, v);
    },
    "setContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": function (this: JWindow, v: unknown, lp: unknown) {
      if (this.dialog) return dialogNative("setContentView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V").call(this.dialog, v, lp);
      return (activityMethods["setContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V"] as any).call(this.activity, v, lp);
    },
    "addContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": function (this: JWindow, v: unknown, lp: unknown) {
      if (this.dialog) return dialogNative("addContentView", "(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V").call(this.dialog, v, lp);
      return (activityMethods["addContentView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V"] as any).call(this.activity, v, lp);
    },
    "setFlags(II)V": function (this: JWindow, flags: number, mask: number) { setWindowFlags(this, (this.flags & ~mask) | (flags & mask)); },
    "addFlags(I)V": function (this: JWindow, f: number) { setWindowFlags(this, this.flags | f); },
    "clearFlags(I)V": function (this: JWindow, f: number) { setWindowFlags(this, this.flags & ~f); },
    "requestFeature(I)Z": function (this: JWindow, f: number) { this.features.add(f); return 1; },
    "setStatusBarColor(I)V": function (this: JWindow, c: number) {
      if (appHost) appHost.statusBarColor = c;
      invalidate();
    },
    "getStatusBarColor()I": () => appHost?.statusBarColor ?? -16777216,
    "setNavigationBarColor(I)V": function (this: JWindow, c: number) { if (appHost) appHost.navBarColor = c; },
    "setSoftInputMode(I)V": () => {},
    "setBackgroundDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JWindow, d: JDrawable | null) {
      this.bg = d; this.bgSet = true;
      if (this.activity && this.decor) this.decor.background = d;
      invalidate();
    },
    "setBackgroundDrawableResource(I)V": async function (this: JWindow, id: number) {
      if (!appHost) return;
      this.bg = await loadDrawable(appHost.res, id, appHost.theme); this.bgSet = true;
      if (this.activity && this.decor) this.decor.background = this.bg;
      invalidate();
    },
    "getAttributes()Landroid/view/WindowManager$LayoutParams;": function (this: JWindow) {
      const lp = new (rt.link("android/view/WindowManager$LayoutParams").ctor)();
      lp.flags = this.flags;
      return lp;
    },
    "setAttributes(Landroid/view/WindowManager$LayoutParams;)V": function (this: JWindow, lp: { flags: number } | null) {
      if (lp) setWindowFlags(this, lp.flags);
    },
    "getCallback()Landroid/view/Window$Callback;": function (this: JWindow) { return this.callbackObj ?? this.activity; },
    "getOnBackInvokedDispatcher()Landroid/window/OnBackInvokedDispatcher;": function (this: JWindow) { return this.backDispatcher(); },
    "setCallback(Landroid/view/Window$Callback;)V": function (this: JWindow, cb: unknown) { this.callbackObj = cb; },
    "setTitle(Ljava/lang/CharSequence;)V": function (this: JWindow, t: unknown) {
      if (this.activity) (activityMethods["setTitle(Ljava/lang/CharSequence;)V"] as any).call(this.activity, t);
    },
    "getContext()Landroid/content/Context;": function (this: JWindow) { return this.activity ?? (this.dialog as { jctx?: unknown } | null)?.jctx ?? null; },
    "setWindowAnimations(I)V": () => {},
    "setLayout(II)V": function (this: JWindow, w: number, h: number) { this.layoutW = w; this.layoutH = h; requestLayout(this.decor); },
    "setGravity(I)V": function (this: JWindow, g: number) { this.gravity = g; requestLayout(this.decor); },
    "setDimAmount(F)V": function (this: JWindow, a: number) { this.dimAmount = a; invalidate(); },
    "getWindowManager()Landroid/view/WindowManager;": function (this: JWindow) { return systemService(this.activity, "window"); },
    "setFeatureInt(II)V": () => {},
    "hasFeature(I)Z": function (this: JWindow, f: number) { return this.features.has(f) ? 1 : 0; },
    "getInsetsController()Landroid/view/WindowInsetsController;": function (this: JWindow) {
      if (!this.insetsController) { this.insetsController = new JInsetsController(); this.insetsController.w = this; }
      return this.insetsController;
    },
    "setDecorFitsSystemWindows(Z)V": () => {},
    "getSharedElementEnterTransition()Landroid/transition/Transition;": () => null,
  },
});
// The API-30 controller: appearance/behavior are window state (the shell reads the
// light-status-bars bit); show/hide are no-ops until the shell has movable system bars.
rt.register({
  name: "android/view/WindowInsetsController", ctor: class extends JObj {},
  statics: { APPEARANCE_LOW_PROFILE_BARS: 4, APPEARANCE_LIGHT_STATUS_BARS, APPEARANCE_LIGHT_NAVIGATION_BARS: 16,
    BEHAVIOR_DEFAULT: 1, BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE: 2 },
});
rt.register({
  name: "webdroid/InsetsController", ctor: JInsetsController, ifaces: ["android/view/WindowInsetsController"],
  methods: {
    "setSystemBarsAppearance(II)V": function (this: JInsetsController, v: number, mask: number) {
      const w = this.w;
      w.appearance = (w.appearance & ~mask) | (v & mask);
      w.appearanceMask |= mask;
      invalidate();
    },
    "getSystemBarsAppearance()I": function (this: JInsetsController) { return this.w.appearance; },
    "setSystemBarsBehavior(I)V": function (this: JInsetsController, b: number) { this.w.barsBehavior = b; },
    "getSystemBarsBehavior()I": function (this: JInsetsController) { return this.w.barsBehavior; },
    "show(I)V": () => {},
    "hide(I)V": () => {},
    "addOnControllableInsetsChangedListener(Landroid/view/WindowInsetsController$OnControllableInsetsChangedListener;)V": () => {},
    "removeOnControllableInsetsChangedListener(Landroid/view/WindowInsetsController$OnControllableInsetsChangedListener;)V": () => {},
    "controlWindowInsetsAnimation(IJLandroid/view/animation/Interpolator;Landroid/os/CancellationSignal;Landroid/view/WindowInsetsAnimationControlListener;)V": () => {},
  },
});
rt.register({
  name: "android/view/WindowManager$LayoutParams", ctor: class extends JObj {
    width = -1; height = -1; gravity = 0; flags = 0; format = 1; type = 2; softInputMode = 0;
    x = 0; y = 0; windowAnimations = 0; dimAmount = 0.6; alpha = 1; layoutInDisplayCutoutMode = 0;
  },
  fields: { width: "width", height: "height", gravity: "gravity", flags: "flags", x: "x", y: "y",
    softInputMode: "softInputMode", windowAnimations: "windowAnimations", dimAmount: "dimAmount", alpha: "alpha", format: "format", type: "type",
    layoutInDisplayCutoutMode: "layoutInDisplayCutoutMode" },
  statics: { MATCH_PARENT: -1, WRAP_CONTENT: -2, FLAG_FULLSCREEN: 1024, FLAG_KEEP_SCREEN_ON: 128, TYPE_APPLICATION: 2, SOFT_INPUT_ADJUST_RESIZE: 16, SOFT_INPUT_STATE_HIDDEN: 3,
    // no real display cutout in a fixed-viewport screen — the field just stores/reports whatever the app sets.
    LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT: 0, LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES: 1,
    LAYOUT_IN_DISPLAY_CUTOUT_MODE_NEVER: 2, LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS: 3, LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS_ALLOWED: 4 },
  methods: {
    "<init>()V": function () {},
    "<init>(IIIII)V": function () {},
    "copyFrom(Landroid/view/WindowManager$LayoutParams;)I": () => 0,
  },
});
rt.register({ name: "android/view/WindowManager", ctor: class extends JObj {} });
class JWindowMetrics extends JObj {}
rt.register({
  name: "android/view/WindowMetrics", ctor: JWindowMetrics,
  methods: {
    "getBounds()Landroid/graphics/Rect;": () => newObj("android/graphics/Rect", "(IIII)V", 0, 0, device.width, device.height - device.statusBar),
    "getDensity()F": () => 2,
    "getWindowInsets()Landroid/view/WindowInsets;": () => rootWindowInsets(),
  },
});
rt.register({
  name: "android/view/WindowManagerImpl", ctor: class extends JObj {}, ifaces: ["android/view/WindowManager"],
  methods: {
    "getDefaultDisplay()Landroid/view/Display;": display,
    "getCurrentWindowMetrics()Landroid/view/WindowMetrics;": () => new JWindowMetrics(),
    "getMaximumWindowMetrics()Landroid/view/WindowMetrics;": () => new JWindowMetrics(),
    "addView(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": async (v: JView, lp: unknown) => {
      addOverlay(v);
    },
    "removeView(Landroid/view/View;)V": async (v: JView) => {
      removeOverlay(v);
    },
    "removeViewImmediate(Landroid/view/View;)V": async (v: JView) => {
      removeOverlay(v);
    },
    "updateViewLayout(Landroid/view/View;Landroid/view/ViewGroup$LayoutParams;)V": () => {},
  },
});

// ActionBar java object
class JActionBar extends JObj {
  act: JActivity | null = null;
  /** apply `f` to the activity's bar view, if it has one, then repaint (or relayout) */
  bar(f: (b: JActionBarView) => void, then: () => void = invalidate) {
    const b = this.act?.window.actionBarView;
    if (b) { f(b); then(); }
  }
  navMode = 0; // 0 standard, 1 list, 2 tabs
  navAdapter: unknown = null;
  navListener: unknown = null;
  navSelected = 0;
  navFired = false;
  async fireNav(i: number) {
    if (!this.navListener) return;
    let id = 0n;
    if (this.navAdapter) {
      try { id = await vcall(this.navAdapter, "getItemId", "(I)J", i); } catch { /* */ }
      await this.updateNavLabel(i);
    }
    try {
      await vcall(this.navListener, "onNavigationItemSelected", "(IJ)Z", i, id);
    } catch (e) { reportUncaught(e); }
    invalidate();
  }
  async updateNavLabel(i: number) {
    const bar = this.act?.window.actionBarView;
    if (!bar || !this.navAdapter) return;
    try {
      const view = await vcall(this.navAdapter, "getView", "(ILandroid/view/View;Landroid/view/ViewGroup;)Landroid/view/View;", i, null, bar);
      bar.navLabel = firstText(view) ?? "";
    } catch (e) { bar.navLabel = ""; }
  }
}
rt.register({
  name: "webdroid/ActionBar", ctor: JActionBar, sup: "android/app/ActionBar",
  methods: {
    "setTitle(Ljava/lang/CharSequence;)V": function (this: JActionBar, t: unknown) { this.bar((b) => { b.titleStr = String(t ?? ""); }); },
    "setTitle(I)V": function (this: JActionBar, id: number) { this.bar((b) => { b.titleStr = appString(id); }); },
    "setSubtitle(Ljava/lang/CharSequence;)V": function (this: JActionBar, t: unknown) { this.bar((b) => { b.subtitleStr = t ? String(t) : null; }); },
    "getTitle()Ljava/lang/CharSequence;": function (this: JActionBar) { return this.act?.window.actionBarView?.titleStr ?? ""; },
    "setHomeAsUpIndicator(Landroid/graphics/drawable/Drawable;)V": () => {},
    "setHomeAsUpIndicator(I)V": () => {},
    "setHomeActionContentDescription(I)V": () => {},
    "setHomeActionContentDescription(Ljava/lang/CharSequence;)V": () => {},
    "setDisplayHomeAsUpEnabled(Z)V": function (this: JActionBar, v: number) { this.bar((b) => { b.showUp = !!v; }); },
    "setHomeButtonEnabled(Z)V": () => {},
    "setDisplayShowHomeEnabled(Z)V": () => {},
    "setDisplayShowTitleEnabled(Z)V": () => {},
    "setDisplayShowCustomEnabled(Z)V": () => {},
    "setDisplayUseLogoEnabled(Z)V": () => {},
    "setElevation(F)V": () => {},
    "setBackgroundDrawable(Landroid/graphics/drawable/Drawable;)V": function (this: JActionBar, d: JDrawable | null) {
      this.bar((b) => { b.background = d; });
    },
    "hide()V": function (this: JActionBar) { this.bar((b) => { b.visibility = 8; }, requestLayout); },
    "show()V": function (this: JActionBar) { this.bar((b) => { b.visibility = 0; }, requestLayout); },
    "isShowing()Z": function (this: JActionBar) { return this.act?.window.actionBarView?.visibility === 0 ? 1 : 0; },
    "setNavigationMode(I)V": function (this: JActionBar, m: number) {
      this.navMode = m;
      this.bar((b) => { b.navMode = m; });
    },
    "getNavigationMode()I": function (this: JActionBar) { return this.navMode; },
    "setListNavigationCallbacks(Landroid/widget/SpinnerAdapter;Landroid/app/ActionBar$OnNavigationListener;)V":
      async function (this: JActionBar, adapter: unknown, listener: unknown) {
        this.navAdapter = adapter;
        this.navListener = listener;
        if (this.act?.window.actionBarView) {
          this.act.window.actionBarView.navAdapter = adapter;
        }
        // fire initial selection (real ActionBar does this once callbacks are set)
        if (listener && !this.navFired) {
          this.navFired = true;
          await this.fireNav(this.navSelected);
        }
      },
    "setSelectedNavigationItem(I)V": function (this: JActionBar, i: number) {
      this.navSelected = i;
      if (this.act?.window.actionBarView) this.act.window.actionBarView.navSelected = i;
      return this.fireNav(i);
    },
    "getSelectedNavigationIndex()I": function (this: JActionBar) { return this.navSelected; },
    "getNavigationItemCount()I": async function (this: JActionBar) {
      return this.navAdapter ? await vcall(this.navAdapter, "getCount", "()I") : 0;
    },
    "setCustomView(Landroid/view/View;)V": () => {},
    "setIcon(I)V": () => {},
    "setLogo(I)V": () => {},
    "getHeight()I": () => 112,
    "getThemedContext()Landroid/content/Context;": function (this: JActionBar) { return this.act; },
    "getCustomView()Landroid/view/View;": () => null,
    // No action view expands on our bar yet; onBackPressed asks first, as AOSP does.
    "collapseActionView()Z": () => 0,
    "getDisplayOptions()I": function (this: JActionBar) { return this.act?.window.actionBarView?.showUp ? 4 : 0; },
    "addTab(Landroid/app/ActionBar$Tab;)V": () => {},
    "newTab()Landroid/app/ActionBar$Tab;": () => null,
  },
});
rt.register({ name: "android/app/ActionBar", ctor: class extends JObj {} });
rt.register({ name: "android/app/ActionBar$OnNavigationListener", ctor: class extends JObj {} });

class JApplication extends JContextWrapper {
  lifecycleCbs: unknown[] | null = null;
}
rt.register({
  name: "android/app/Application", ctor: JApplication, sup: "android/content/ContextWrapper",
  ifaces: ["android/content/ComponentCallbacks2", "android/content/ComponentCallbacks"],
  methods: {
    ...wrapperMethods,
    "<init>()V": function () {},
    "static getProcessName()Ljava/lang/String;": () => appHost?.pkg ?? "app",
    "onCreate()V": function () {},
    "onTerminate()V": function () {},
    "onLowMemory()V": function () {},
    "onTrimMemory(I)V": function () {},
    "onConfigurationChanged(Landroid/content/res/Configuration;)V": function () {},
    ...lifecycleCbMethods,
    "registerComponentCallbacks(Landroid/content/ComponentCallbacks;)V": () => {},
  },
});
// Pure interface: implementors are dispatched dynamically by fireActivityLifecycle, which
// probes each of the plain/Pre*/Post* variants, so no default bodies belong here.
rt.register({ name: "android/app/Application$ActivityLifecycleCallbacks", ctor: class extends JObj {} });
rt.register({ name: "android/content/ComponentCallbacks", ctor: class extends JObj {} });
rt.register({ name: "android/content/ComponentCallbacks2", ctor: class extends JObj {} });

async function launchIntent(host: AppHost, intent: JIntent) {
  if (intent?.component) {
    await host.launch(intent.component.replace(/\./g, "/"), intent);
  } else {
    console.log("[webdroid] implicit intent ignored:", intent?.action, intent?.dataUri);
  }
}

export const RESULT_OK = -1, RESULT_CANCELED = 0;

/**
 * The activities the *system* provides, keyed by the action an app sends. On a device these are
 * DocumentsUI; here they are the browser's own pickers. Each answers with the result Intent, or
 * null for "the user backed out" — which is RESULT_CANCELED, not an error.
 */
const systemActivities: Record<string, (intent: JIntent) => Promise<JIntent | null>> = {};
export function registerSystemActivity(action: string, run: (intent: JIntent) => Promise<JIntent | null>) {
  systemActivities[action] = run;
}
export function mkResultIntent(uri: string): JIntent {
  const i = new JIntent();
  i.dataUri = uri;
  return i;
}

/** Post a result to the activity that asked for it. Scheduled, never inline: the caller is
 *  usually mid-click-handler, and androidx dispatches straight into app code from here. */
export function deliverActivityResult(act: JActivity, code: number, resultCode: number, data: JIntent | null) {
  setTimeout(() => void onMain(() =>
    vcall(act, "onActivityResult", "(IILandroid/content/Intent;)V", code, resultCode, data)
      .catch(reportUncaught)), 0);
}

class JToast extends JObj { text = ""; }
rt.register({
  name: "android/widget/Toast", ctor: JToast,
  statics: { LENGTH_SHORT: 0, LENGTH_LONG: 1 },
  methods: {
    "static makeText(Landroid/content/Context;Ljava/lang/CharSequence;I)Landroid/widget/Toast;": async (c: unknown, t: unknown) => {
      const toast = new JToast();
      toast.text = await csText(t);
      return toast;
    },
    "static makeText(Landroid/content/Context;II)Landroid/widget/Toast;": (c: any, id: number) => {
      const toast = new JToast();
      toast.text = c?.$host ? resString(c.$host.res, id) : "";
      return toast;
    },
    "show()V": async function (this: JToast) {
      showToast(this.text);
    },
    "setText(Ljava/lang/CharSequence;)V": async function (this: JToast, t: unknown) { this.text = await csText(t); },
    "setGravity(III)V": () => {},
    "setDuration(I)V": () => {},
    "cancel()V": () => {},
  },
});

// misc service stubs
for (const [name, methods, statics] of [
  ["android/app/ActivityManager", {
    "getMemoryClass()I": () => 256,
    "getLargeMemoryClass()I": () => 512,
    "isLowRamDevice()Z": () => 0,
    "getRunningAppProcesses()Ljava/util/List;": () => newArrayList([myProcess()]),
    "getHistoricalProcessExitReasons(Ljava/lang/String;II)Ljava/util/List;": () => newArrayList(),
    "getRunningServices(I)Ljava/util/List;": (max: number) => {
      const all = [...runningServices.values()];
      return newArrayList(max < all.length ? all.slice(0, max) : all);
    },
    "getMemoryInfo(Landroid/app/ActivityManager$MemoryInfo;)V": (mi: any) => {
      if (mi) { mi.totalMem = 4n * 1024n * 1024n * 1024n; mi.availMem = 2n * 1024n * 1024n * 1024n; mi.lowMemory = 0; mi.threshold = 128n * 1024n * 1024n; }
    },
    "static getMyMemoryState(Landroid/app/ActivityManager$RunningAppProcessInfo;)V": (info: JRunningAppProcessInfo) => {
      if (info) fillProc(info);
    },
  }],
  ["android/os/PowerManager", {
    "newWakeLock(ILjava/lang/String;)Landroid/os/PowerManager$WakeLock;": () => {
      const info = rt.link("android/os/PowerManager$WakeLock");
      return new info.ctor();
    },
    "isInteractive()Z": () => 1,
    "isPowerSaveMode()Z": () => 0,
  }],
  ["android/os/PowerManager$WakeLock", {
    "acquire()V": () => {}, "acquire(J)V": () => {}, "release()V": () => {},
    "isHeld()Z": () => 0, "setReferenceCounted(Z)V": () => {},
  }],
  // no radio here: getDefaultAdapter() is null, which is what a device without Bluetooth reports
  ["android/bluetooth/BluetoothAdapter", {
    "static getDefaultAdapter()Landroid/bluetooth/BluetoothAdapter;": () => null,
    "isEnabled()Z": () => 0,
  }],
  ["android/os/Vibrator", {
    "vibrate(J)V": (ms: bigint) => globalThis.navigator?.vibrate?.(Number(ms)),
    "vibrate(Landroid/os/VibrationEffect;)V": () => globalThis.navigator?.vibrate?.(30),
    "hasVibrator()Z": () => 1,
    "cancel()V": () => {},
    // navigator.vibrate is a bare on/off motor: no amplitude, no composed primitives
    "hasAmplitudeControl()Z": () => 0,
    "areAllPrimitivesSupported([I)Z": () => 0,
    "arePrimitivesSupported([I)[Z": (ids: Int32Array) => new Uint8Array(ids.length),
    "areAllEffectsSupported([I)I": () => 2,
    "areEffectsSupported([I)[I": (ids: Int32Array) => new Int32Array(ids.length).fill(2),
  }],
  ["android/media/AudioManager", {
    "getStreamVolume(I)I": () => 5,
    "getStreamMaxVolume(I)I": () => 10,
    "setStreamVolume(III)V": () => {},
    "requestAudioFocus(Landroid/media/AudioManager$OnAudioFocusChangeListener;II)I": () => 1,
    "abandonAudioFocus(Landroid/media/AudioManager$OnAudioFocusChangeListener;)I": () => 1,
    "getRingerMode()I": () => 2,
    "getMode()I": () => 0,
    "isSpeakerphoneOn()Z": () => 0,
    "isMusicActive()Z": isMusicActive,
    "isBluetoothA2dpOn()Z": () => 0,
    "isWiredHeadsetOn()Z": () => 0,
  }, {
    MODE_NORMAL: 0, MODE_RINGTONE: 1, MODE_IN_CALL: 2, MODE_IN_COMMUNICATION: 3,
    RINGER_MODE_SILENT: 0, RINGER_MODE_VIBRATE: 1, RINGER_MODE_NORMAL: 2,
  }],
  // A Wi-Fi-only device with no SIM: no operator, no radio, and the identifiers API 29+
  // withholds from ordinary apps are null.
  ["android/telephony/TelephonyManager", {
    "getNetworkOperator()Ljava/lang/String;": () => "",
    "getNetworkOperatorName()Ljava/lang/String;": () => "",
    "getSimOperator()Ljava/lang/String;": () => "",
    "getSimOperatorName()Ljava/lang/String;": () => "",
    "getSimCountryIso()Ljava/lang/String;": () => "",
    "getNetworkCountryIso()Ljava/lang/String;": () => "",
    "getPhoneType()I": () => 0,
    "getNetworkType()I": () => 0,
    "getDataNetworkType()I": () => 0,
    "getSimState()I": () => 1,
    "getCallState()I": () => 0,
    "getDataState()I": () => 0,
    "isNetworkRoaming()Z": () => 0,
    "hasIccCard()Z": () => 0,
    "getDeviceId()Ljava/lang/String;": () => null,
    "getLine1Number()Ljava/lang/String;": () => null,
    "getSubscriberId()Ljava/lang/String;": () => null,
    "getSimSerialNumber()Ljava/lang/String;": () => null,
    "listen(Landroid/telephony/PhoneStateListener;I)V": () => {},
  }, {
    PHONE_TYPE_NONE: 0, PHONE_TYPE_GSM: 1, PHONE_TYPE_CDMA: 2, PHONE_TYPE_SIP: 3,
    NETWORK_TYPE_UNKNOWN: 0,
    SIM_STATE_UNKNOWN: 0, SIM_STATE_ABSENT: 1, SIM_STATE_READY: 5,
    CALL_STATE_IDLE: 0, CALL_STATE_RINGING: 1, CALL_STATE_OFFHOOK: 2,
    DATA_DISCONNECTED: 0,
  }],
  ["android/os/ext/SdkExtensions", {
    "static getExtensionVersion(I)I": () => 0,
  }],
  ["android/webkit/CookieManager", {
    "static getInstance()Landroid/webkit/CookieManager;": () => {
      const i = rt.link("android/webkit/CookieManager");
      return ((i.ctor as any).$inst ??= new i.ctor());
    },
    // no cookie jar: a WebView frame's cookies live in the browser and are not readable here
    "getCookie(Ljava/lang/String;)Ljava/lang/String;": () => null,
    "setCookie(Ljava/lang/String;Ljava/lang/String;)V": () => {},
    "setCookie(Ljava/lang/String;Ljava/lang/String;Landroid/webkit/ValueCallback;)V": () => {},
    "setAcceptCookie(Z)V": () => {},
    "acceptCookie()Z": () => 1,
    "setAcceptThirdPartyCookies(Landroid/webkit/WebView;Z)V": () => {},
    "acceptThirdPartyCookies(Landroid/webkit/WebView;)Z": () => 0,
    "hasCookies()Z": () => 0,
    "removeAllCookies(Landroid/webkit/ValueCallback;)V": () => {},
    "removeSessionCookies(Landroid/webkit/ValueCallback;)V": () => {},
    "flush()V": () => {},
  }],
  ["android/view/accessibility/AccessibilityManager", {
    // No real accessibility service runs here — a device with accessibility off reports
    // both flags false. Listeners register (so `implements` links) but never fire, which
    // IS the correct behavior for this state, not a stub shortcut.
    "isEnabled()Z": () => 0,
    "isTouchExplorationEnabled()Z": () => 0,
    "addAccessibilityStateChangeListener(Landroid/view/accessibility/AccessibilityManager$AccessibilityStateChangeListener;)Z": () => 1,
    "removeAccessibilityStateChangeListener(Landroid/view/accessibility/AccessibilityManager$AccessibilityStateChangeListener;)Z": () => 1,
    "addTouchExplorationStateChangeListener(Landroid/view/accessibility/AccessibilityManager$TouchExplorationStateChangeListener;)Z": () => 1,
    "removeTouchExplorationStateChangeListener(Landroid/view/accessibility/AccessibilityManager$TouchExplorationStateChangeListener;)Z": () => 1,
    "getEnabledAccessibilityServiceList(I)Ljava/util/List;": () => newArrayList(),
  }],
  ["android/app/AlarmManager", {
    "set(IJLandroid/app/PendingIntent;)V": () => {},
    "setExact(IJLandroid/app/PendingIntent;)V": () => {},
    "setExactAndAllowWhileIdle(IJLandroid/app/PendingIntent;)V": () => {},
    "cancel(Landroid/app/PendingIntent;)V": () => {},
    "canScheduleExactAlarms()Z": () => 1,
  }],
  ["android/content/ClipboardManager", {
    "setPrimaryClip(Landroid/content/ClipData;)V": () => {},
    "getPrimaryClip()Landroid/content/ClipData;": () => null,
    "hasPrimaryClip()Z": () => 0,
  }],
  // UI_MODE_TYPE_NORMAL: a handset, not a car/desk/TV dock (Configuration.uiMode agrees)
  ["android/app/UiModeManager", { "getNightMode()I": () => 1, "setNightMode(I)V": () => {}, "getCurrentModeType()I": () => 1 }],
  ["android/app/KeyguardManager", { "isKeyguardLocked()Z": () => 0, "inKeyguardRestrictedInputMode()Z": () => 0 }],
  ["android/app/job/JobScheduler", { "schedule(Landroid/app/job/JobInfo;)I": () => 1, "cancel(I)V": () => {}, "cancelAll()V": () => {}, "getAllPendingJobs()Ljava/util/List;": () => null }],
  ["android/hardware/SensorManager", { "getDefaultSensor(I)Landroid/hardware/Sensor;": () => null, "registerListener(Landroid/hardware/SensorEventListener;Landroid/hardware/Sensor;I)Z": () => 0, "unregisterListener(Landroid/hardware/SensorEventListener;)V": () => {} }],
  // No location provider exists on this device, so requests register nothing and never fire.
  ["android/location/LocationManager", {
    "getLastKnownLocation(Ljava/lang/String;)Landroid/location/Location;": () => null,
    "getBestProvider(Landroid/location/Criteria;Z)Ljava/lang/String;": () => null,
    "getProvider(Ljava/lang/String;)Landroid/location/LocationProvider;": () => null,
    "getProviders(Z)Ljava/util/List;": () => newArrayList(),
    "getAllProviders()Ljava/util/List;": () => newArrayList(),
    "isProviderEnabled(Ljava/lang/String;)Z": () => 0,
    "requestLocationUpdates(Ljava/lang/String;JFLandroid/location/LocationListener;)V": () => {},
    "requestLocationUpdates(Ljava/lang/String;JFLandroid/location/LocationListener;Landroid/os/Looper;)V": () => {},
    "removeUpdates(Landroid/location/LocationListener;)V": () => {},
  }, { GPS_PROVIDER: "gps", NETWORK_PROVIDER: "network", PASSIVE_PROVIDER: "passive" }],
  ["android/os/BatteryManager", { "getIntProperty(I)I": () => 80, "isCharging()Z": () => 1 }],
  ["android/hardware/display/DisplayManager", {
    // one fixed built-in display: unknown ids are null as in AOSP, and registered listeners
    // never fire because no display is ever added, removed or reconfigured here
    "getDisplay(I)Landroid/view/Display;": (id: number) => (id === 0 ? display() : null),
    "getDisplays()[Landroid/view/Display;": () => jarray([display()], "Landroid/view/Display;"),
    "getDisplays(Ljava/lang/String;)[Landroid/view/Display;": (cat: string | null) => jarray(cat === null ? [display()] : [], "Landroid/view/Display;"),
    "registerDisplayListener(Landroid/hardware/display/DisplayManager$DisplayListener;Landroid/os/Handler;)V": (l: unknown) => {
      if (l === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "listener must not be null");
      displayListeners.add(l);
    },
    "unregisterDisplayListener(Landroid/hardware/display/DisplayManager$DisplayListener;)V": (l: unknown) => { displayListeners.delete(l); },
  }, { DISPLAY_CATEGORY_PRESENTATION: "android.hardware.display.category.PRESENTATION" }],
  ["android/os/Binder", { "<init>()V": function () {}, "static flushPendingCommands()V": () => {} }],
] as [string, NativeSpec["methods"], NativeSpec["statics"]?][]) {
  rt.register({ name, ctor: class extends JObj {}, methods, statics });
}
rt.register({ name: "android/telephony/PhoneStateListener", ctor: class extends JObj {}, methods: { "<init>()V": function () {} } });
// apps `implements` this to track refresh-rate / display changes; it must link even though it never fires here
rt.register({ name: "android/hardware/display/DisplayManager$DisplayListener", ctor: class extends JObj {} });
rt.register({ name: "android/os/IBinder", ctor: class extends JObj {} });
// AccessibilityManager callback interfaces — apps `implements` these to watch for a
// screen reader turning on; must link even though it never fires here (see above).
for (const n of ["AccessibilityStateChangeListener", "TouchExplorationStateChangeListener"]) {
  rt.register({ name: "android/view/accessibility/AccessibilityManager$" + n, ctor: class extends JObj {} });
}
rt.register({
  name: "android/app/ActivityManager$MemoryInfo",
  ctor: class extends JObj { totalMem = 4n * 1024n ** 3n; availMem = 2n * 1024n ** 3n; lowMemory = 0; threshold = 128n * 1024n * 1024n; },
  fields: { totalMem: "totalMem", availMem: "availMem", lowMemory: "lowMemory", threshold: "threshold" },
  methods: { "<init>()V": function () {} },
});
class JRunningServiceInfo extends JObj {
  service: JComponentName | null = null;
  pid = 1000; uid = 10001; process = ""; foreground = 0; started = 0; flags = 0;
  activeSince = 0n; lastActivityTime = 0n; restarting = 0n;
  activeCount = 0; clientCount = 0; crashCount = 0;
}
rt.register({
  name: "android/app/ActivityManager$RunningServiceInfo", ctor: JRunningServiceInfo, ifaces: ["android/os/Parcelable"],
  statics: { FLAG_STARTED: 1, FLAG_FOREGROUND: 2, FLAG_SYSTEM_PROCESS: 4, FLAG_PERSISTENT_PROCESS: 8 },
  fields: {
    service: "service", pid: "pid", uid: "uid", process: "process", foreground: "foreground",
    started: "started", flags: "flags", activeSince: "activeSince", lastActivityTime: "lastActivityTime",
    restarting: "restarting", activeCount: "activeCount", clientCount: "clientCount", crashCount: "crashCount",
  },
  methods: { "<init>()V": function () {} },
});
class JRunningAppProcessInfo extends JObj {
  processName = ""; pid = 1000; uid = 10001; pkgList: string[] = [];
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
  fields: {
    processName: "processName", pid: "pid", uid: "uid", pkgList: "pkgList", importance: "importance",
    lru: "lru", lastTrimLevel: "lastTrimLevel", importanceReasonCode: "importanceReasonCode",
    importanceReasonPid: "importanceReasonPid", importanceReasonComponent: "importanceReasonComponent",
  },
  methods: { "<init>()V": function () {} },
});

/** started-and-not-stopped services, keyed by dotted class name (matches Class.getName()) */
const runningServices = new Map<string, JRunningServiceInfo>();
function svcStart(ctx: JContext, intent: JIntent | null, fg: boolean): JComponentName | null {
  const cls = intent?.component;
  if (!cls) return null;
  let si = runningServices.get(cls);
  if (!si) {
    const pkg = ctx?.$host?.pkg ?? appHost?.pkg ?? "";
    si = new JRunningServiceInfo();
    si.service = mkComponentName(pkg, cls);
    si.process = pkg;
    si.started = 1;
    si.flags = 1;
    si.activeSince = BigInt(Date.now());
    runningServices.set(cls, si);
  }
  si.lastActivityTime = BigInt(Date.now());
  if (fg) { si.foreground = 1; si.flags |= 2; }
  return si.service;
}
function svcStop(cls: string | null | undefined): number { return cls && runningServices.delete(cls) ? 1 : 0; }
function svcFg(svc: unknown, fg: boolean) {
  const si = runningServices.get(jclsNameOf(svc));
  if (si) { si.foreground = fg ? 1 : 0; si.flags = fg ? si.flags | 2 : si.flags & ~2; }
}
let procInfo: JRunningAppProcessInfo | null = null;
function fillProc<T extends JRunningAppProcessInfo>(p: T): T {
  const pkg = appHost?.pkg ?? "";
  p.processName = pkg; p.pkgList = [pkg];
  p.importance = appHost?.currentActivity() ? 100 : runningServices.size ? 300 : 400;
  return p;
}
const myProcess = () => fillProc(procInfo ??= new JRunningAppProcessInfo());
// Back itself is still delivered through Activity.onBackPressed (the pre-33 route androidx's
// OnBackPressedDispatcher also serves), so the registry only has to hold the callbacks.
class JBackDispatcher extends JObj { cbs: { p: number; cb: unknown }[] = []; }
rt.register({
  name: "android/window/OnBackInvokedDispatcher", ctor: JBackDispatcher,
  statics: { PRIORITY_DEFAULT: 0, PRIORITY_OVERLAY: 1000000, PRIORITY_SYSTEM: -1 },
  methods: {
    "registerOnBackInvokedCallback(ILandroid/window/OnBackInvokedCallback;)V": function (this: JBackDispatcher, p: number, cb: unknown) {
      if (p < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Application registered OnBackInvokedCallback cannot have negative priority. Value: " + p);
      this.cbs = this.cbs.filter((e) => e.cb !== cb);
      this.cbs.push({ p, cb });
    },
    "unregisterOnBackInvokedCallback(Landroid/window/OnBackInvokedCallback;)V": function (this: JBackDispatcher, cb: unknown) { this.cbs = this.cbs.filter((e) => e.cb !== cb); },
  },
});
rt.register({ name: "android/window/OnBackInvokedCallback", ctor: class extends JObj {} });
rt.register({
  name: "android/net/http/X509TrustManagerExtensions", ctor: class extends JObj {},
  methods: {
    "<init>(Ljavax/net/ssl/X509TrustManager;)V": function () {},
    "checkServerTrusted([Ljava/security/cert/X509Certificate;Ljava/lang/String;Ljava/lang/String;)Ljava/util/List;":
      () => newArrayList(),
  },
});
rt.register({
  name: "android/content/ContentProvider", ctor: class extends JObj { $ctx: unknown = null; },
  methods: {
    "<init>()V": function () {},
    "onCreate()Z": () => 1,
    "getContext()Landroid/content/Context;": function (this: any) { return this.$ctx ?? appHost?.application ?? null; },
    "attachInfo(Landroid/content/Context;Landroid/content/pm/ProviderInfo;)V": function (this: any, c: unknown) { this.$ctx = c; },
  },
});

// BroadcastReceiver / IntentFilter
rt.register({
  name: "android/content/BroadcastReceiver", ctor: class extends JObj {},
  methods: { "<init>()V": function () {} },
});
rt.register({
  name: "android/content/IntentFilter", ctor: class extends JObj { actions: string[] = []; },
  methods: {
    "<init>()V": function () {},
    "<init>(Ljava/lang/String;)V": function (this: any, a: string) { this.actions.push(a); },
    "addAction(Ljava/lang/String;)V": function (this: any, a: string) { this.actions.push(a); },
    "countActions()I": function (this: any) { return this.actions.length; },
    "getAction(I)Ljava/lang/String;": function (this: any, i: number) { return this.actions[i] ?? null; },
    "hasAction(Ljava/lang/String;)Z": function (this: any, a: string) { return this.actions.includes(a) ? 1 : 0; },
    "actionsIterator()Ljava/util/Iterator;": function (this: any) { return mkIter(this.actions.slice()); },
    "addCategory(Ljava/lang/String;)V": () => {},
    "addDataScheme(Ljava/lang/String;)V": () => {},
  },
});
class JPendingIntent extends JObj {}
const pendingIntent = () => new JPendingIntent();
rt.register({
  name: "android/app/PendingIntent", ctor: JPendingIntent, ifaces: ["android/os/Parcelable"],
  methods: {
    "static getActivity(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": pendingIntent,
    "static getBroadcast(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": pendingIntent,
    "static getService(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;": pendingIntent,
    "cancel()V": () => {},
    "send()V": () => {},
  },
});
rt.register({ name: "android/app/Service", ctor: class extends JContextWrapper {}, sup: "android/content/ContextWrapper",
  ifaces: ["android/content/ComponentCallbacks2", "android/content/ComponentCallbacks"],
  methods: {
    ...contextMethods,
    "<init>()V": function () {},
    "onCreate()V": () => {},
    "onDestroy()V": function (this: JObj) { svcStop(jclsNameOf(this)); },
    "onStartCommand(Landroid/content/Intent;II)I": () => 1,
    "stopSelf()V": function (this: JObj) { svcStop(jclsNameOf(this)); },
    "stopSelf(I)V": function (this: JObj) { svcStop(jclsNameOf(this)); },
    "stopSelfResult(I)Z": function (this: JObj) { return svcStop(jclsNameOf(this)); },
    "startForeground(ILandroid/app/Notification;)V": function (this: JObj) { svcFg(this, true); },
    "startForeground(ILandroid/app/Notification;I)V": function (this: JObj) { svcFg(this, true); }, // the type is advisory
    "stopForeground(Z)V": function (this: JObj) { svcFg(this, false); },
  } });

// ── legacy android.app.FragmentManager/FragmentTransaction: actually attaches/detaches the
// fragment's view (unlike androidx's fragment library, which ships as bytecode inside the APK
// and needs no native support, `android.app.Fragment` is a platform class apps never bundle,
// so replace()/add()/commit() have to really run the lifecycle + view attach ourselves). ──
class JFragmentManager extends JObj {
  act: any = null;
  active: JFragment[] = [];
}
interface FragOp { kind: "add" | "replace" | "remove"; containerId: number; frag: JFragment | null; tag?: string | null; }
class JFragmentTransaction extends JObj {
  fm: JFragmentManager | null = null;
  ops: FragOp[] = [];
}
async function runFragmentAdd(fm: JFragmentManager, frag: JFragment, containerId: number) {
  const act = fm.act;
  frag.containerId = containerId;
  fm.active.push(frag);
  await vcall(frag, "onAttach", "(Landroid/app/Activity;)V", act);
  await vcall(frag, "onCreate", "(Landroid/os/Bundle;)V", null);
  const container = containerId && act?.window?.decor ? findById(act.window.decor, containerId) as JViewGroup | null : null;
  const view = await vcall(frag, "onCreateView", "(Landroid/view/LayoutInflater;Landroid/view/ViewGroup;Landroid/os/Bundle;)Landroid/view/View;",
    getInflater(act), container, null) as JView | null;
  frag.attachedView = view;
  if (view && container) {
    if (!view.lp) {
      const lp = new (rt.link("android/widget/FrameLayout$LayoutParams").ctor)();
      lp.width = -1; lp.height = -1;
      view.lp = lp;
    }
    attachView(container, view);
  }
  await vcall(frag, "onViewCreated", "(Landroid/view/View;Landroid/os/Bundle;)V", view, null);
  await vcall(frag, "onActivityCreated", "(Landroid/os/Bundle;)V", null);
  if (act?.started) await vcall(frag, "onStart", "()V");
  if (act?.resumed) await vcall(frag, "onResume", "()V");
}
async function runFragmentRemove(fm: JFragmentManager, frag: JFragment) {
  const i = fm.active.indexOf(frag);
  if (i >= 0) fm.active.splice(i, 1);
  await vcall(frag, "onPause", "()V");
  await vcall(frag, "onStop", "()V");
  await vcall(frag, "onDestroyView", "()V");
  if (frag.attachedView?.parent) detachView(frag.attachedView.parent as JViewGroup, frag.attachedView);
  frag.attachedView = null;
  await vcall(frag, "onDestroy", "()V");
  await vcall(frag, "onDetach", "()V");
}
async function runFragmentTransaction(tx: JFragmentTransaction): Promise<number> {
  const fm = tx.fm;
  if (!fm) return 0;
  for (const op of tx.ops) {
    if (!op.frag) continue;
    if (op.tag !== undefined) op.frag.tag = op.tag;
    if (op.kind === "replace") {
      const container = op.containerId && fm.act?.window?.decor ? findById(fm.act.window.decor, op.containerId) as JViewGroup | null : null;
      for (const old of [...fm.active]) if (old.containerId === op.containerId) await runFragmentRemove(fm, old);
      if (container) for (const v of [...container.children]) detachView(container, v);
      await runFragmentAdd(fm, op.frag, op.containerId);
    } else if (op.kind === "add") {
      await runFragmentAdd(fm, op.frag, op.containerId);
    } else {
      await runFragmentRemove(fm, op.frag);
    }
  }
  tx.ops.length = 0;
  requestLayout();
  return 0;
}
rt.register({
  name: "android/app/FragmentTransaction", ctor: JFragmentTransaction,
  methods: {
    "add(Landroid/app/Fragment;Ljava/lang/String;)Landroid/app/FragmentTransaction;":
      function (this: JFragmentTransaction, f: JFragment, tag: string | null) { this.ops.push({ kind: "add", containerId: 0, frag: f, tag }); return this; },
    "add(ILandroid/app/Fragment;)Landroid/app/FragmentTransaction;":
      function (this: JFragmentTransaction, id: number, f: JFragment) { this.ops.push({ kind: "add", containerId: id, frag: f }); return this; },
    "remove(Landroid/app/Fragment;)Landroid/app/FragmentTransaction;":
      function (this: JFragmentTransaction, f: JFragment) { this.ops.push({ kind: "remove", containerId: 0, frag: f }); return this; },
    "replace(ILandroid/app/Fragment;)Landroid/app/FragmentTransaction;":
      function (this: JFragmentTransaction, id: number, f: JFragment) { this.ops.push({ kind: "replace", containerId: id, frag: f }); return this; },
    "addToBackStack(Ljava/lang/String;)Landroid/app/FragmentTransaction;": function (this: JFragmentTransaction) { return this; },
    "commit()I": function (this: JFragmentTransaction) { return runFragmentTransaction(this); },
    "commitAllowingStateLoss()I": function (this: JFragmentTransaction) { return runFragmentTransaction(this); },
  },
});
rt.register({
  name: "android/app/FragmentManager", ctor: JFragmentManager,
  methods: {
    "beginTransaction()Landroid/app/FragmentTransaction;": function (this: JFragmentManager) {
      const tx = new (rt.link("android/app/FragmentTransaction").ctor)() as JFragmentTransaction;
      tx.fm = this;
      return tx;
    },
    "findFragmentByTag(Ljava/lang/String;)Landroid/app/Fragment;": function (this: JFragmentManager, tag: string | null) {
      return (tag !== null && this.active.find((f) => f.tag === tag)) || null;
    },
    "findFragmentById(I)Landroid/app/Fragment;": function (this: JFragmentManager, id: number) {
      return (id && this.active.find((f) => f.containerId === id)) || null;
    },
    "executePendingTransactions()Z": () => 0, // commit() ran the transaction inline: nothing is pending
    // Nothing pushes to the back stack yet (androidx apps keep their own separate one), but
    // Activity.onBackPressed consults it.
    "isStateSaved()Z": () => 0,
    "popBackStackImmediate()Z": () => 0,
  },
});
async function dispatchFragLifecycle(act: JActivity, method: string): Promise<void> {
  const active = act.fragMgr?.active as JFragment[] | undefined;
  if (!active?.length) return;
  for (const f of [...active]) {
    try { await vcall(f, method, "()V"); } catch (e) { reportUncaught(e); }
  }
}

// API-30 WindowInsetsAnimation: the APK ships desugar stubs whose <clinit> throws
// NoClassDefFoundError; real framework classes shadow them on-device, so must ours.
rt.register({ name: "android/view/WindowInsetsAnimation", ctor: class extends JObj {} });
rt.register({
  name: "android/view/WindowInsetsAnimation$Callback", ctor: class extends JObj {},
  methods: { "<init>(I)V": () => {} },
});

class JAppWidgetManager extends JObj {}
const theAppWidgetManager = new JAppWidgetManager();
rt.register({
  name: "android/appwidget/AppWidgetManager", ctor: JAppWidgetManager,
  methods: {
    "static getInstance(Landroid/content/Context;)Landroid/appwidget/AppWidgetManager;": () => theAppWidgetManager,
    "getAppWidgetIds(Landroid/content/ComponentName;)[I": () => new Int32Array(0),
    "getInstalledProviders()Ljava/util/List;": () => newArrayList(),
    "getInstalledProvidersForPackage(Ljava/lang/String;Landroid/os/UserHandle;)Ljava/util/List;": () => newArrayList(),
    "updateAppWidget([ILandroid/widget/RemoteViews;)V": () => {},
    "updateAppWidget(Landroid/content/ComponentName;Landroid/widget/RemoteViews;)V": () => {},
    "notifyAppWidgetViewDataChanged([II)V": () => {},
  },
});
class JAppWidgetProviderInfo extends JObj {
  provider: JComponentName | null = null;
  minWidth = 0; minHeight = 0; minResizeWidth = 0; minResizeHeight = 0;
  resizeMode = 0; updatePeriodMillis = 0; initialLayout = 0; icon = 0; label = "";
}
rt.register({
  name: "android/appwidget/AppWidgetProviderInfo", ctor: JAppWidgetProviderInfo, ifaces: ["android/os/Parcelable"],
  statics: {
    RESIZE_NONE: 0, RESIZE_HORIZONTAL: 1, RESIZE_VERTICAL: 2, RESIZE_BOTH: 3,
    WIDGET_CATEGORY_HOME_SCREEN: 1, WIDGET_CATEGORY_KEYGUARD: 2, WIDGET_CATEGORY_SEARCHBOX: 4,
  },
  fields: {
    provider: "provider", minWidth: "minWidth", minHeight: "minHeight",
    minResizeWidth: "minResizeWidth", minResizeHeight: "minResizeHeight",
    resizeMode: "resizeMode", updatePeriodMillis: "updatePeriodMillis",
    initialLayout: "initialLayout", icon: "icon", label: "label",
  },
  methods: {
    "<init>()V": function () {},
    "loadLabel(Landroid/content/pm/PackageManager;)Ljava/lang/String;": function (this: JAppWidgetProviderInfo) { return this.label; },
    "describeContents()I": () => 0,
    "writeToParcel(Landroid/os/Parcel;I)V": () => {},
  },
});

rt.register({
  name: "android/view/autofill/AutofillManager", ctor: class extends JObj {},
  methods: {
    "isEnabled()Z": () => 0,
    "isAutofillSupported()Z": () => 0,
    "notifyValueChanged(Landroid/view/View;)V": () => {},
    "notifyValueChanged(Landroid/view/View;ILandroid/view/autofill/AutofillValue;)V": () => {},
    "notifyViewEntered(Landroid/view/View;)V": () => {},
    "notifyViewExited(Landroid/view/View;)V": () => {},
    "notifyViewVisibilityChanged(Landroid/view/View;Z)V": () => {},
    "notifyViewVisibilityChanged(Landroid/view/View;IZ)V": () => {},
    "notifyViewEntered(Landroid/view/View;ILandroid/graphics/Rect;)V": () => {},
    "notifyViewExited(Landroid/view/View;I)V": () => {},
    "requestAutofill(Landroid/view/View;)V": () => {},
    "commit()V": () => {},
    "cancel()V": () => {},
    "registerCallback(Landroid/view/autofill/AutofillManager$AutofillCallback;)V": () => {},
    "unregisterCallback(Landroid/view/autofill/AutofillManager$AutofillCallback;)V": () => {},
    "hasEnabledAutofillServices()Z": () => 0,
    "getAutofillServiceComponentName()Landroid/content/ComponentName;": () => null,
    "disableAutofillServices()V": () => {},
  },
});
// no autofill service exists, so a registered callback never hears an event
rt.register({
  name: "android/view/autofill/AutofillManager$AutofillCallback", ctor: class extends JObj {},
  statics: { EVENT_INPUT_SHOWN: 1, EVENT_INPUT_HIDDEN: 2, EVENT_INPUT_UNAVAILABLE: 3 },
  methods: {
    "<init>()V": function () {},
    "onAutofillEvent(Landroid/view/View;II)V": () => {},
  },
});
class JAutofillValue extends JObj { v: unknown = null; }
rt.register({
  name: "android/view/autofill/AutofillValue", ctor: JAutofillValue,
  methods: {
    "static forToggle(Z)Landroid/view/autofill/AutofillValue;": (b: number) => { const a = new JAutofillValue(); a.v = b; return a; },
    "static forText(Ljava/lang/CharSequence;)Landroid/view/autofill/AutofillValue;": (t: unknown) => { const a = new JAutofillValue(); a.v = t; return a; },
    "isText()Z": function (this: JAutofillValue) { return typeof this.v === "string" ? 1 : 0; },
    "isToggle()Z": function (this: JAutofillValue) { return typeof this.v === "number" ? 1 : 0; },
    "getTextValue()Ljava/lang/CharSequence;": function (this: JAutofillValue) { return String(this.v ?? ""); },
    "getToggleValue()Z": function (this: JAutofillValue) { return this.v ? 1 : 0; },
  },
});

// ── framework (non-androidx) Fragment: real lifecycle surface, AOSP no-op bodies.
export class JFragment extends JObj {
  act: unknown = null;
  args: unknown = null;
  attachedView: JView | null = null;
  containerId = 0;
  tag: string | null = null;
}
export const fragMethods: NonNullable<NativeSpec["methods"]> = {
  "<init>()V": function () {},
  "onAttach(Landroid/app/Activity;)V": function (this: JFragment, a: unknown) { this.act = a; },
  "onAttach(Landroid/content/Context;)V": function (this: JFragment, a: unknown) { this.act = a; },
  "getActivity()Landroid/app/Activity;": function (this: JFragment) { return this.act; },
  "getContext()Landroid/content/Context;": function (this: JFragment) { return this.act; },
  "getResources()Landroid/content/res/Resources;": function (this: JFragment) {
    return this.act ? vcall(this.act, "getResources", "()Landroid/content/res/Resources;") : null;
  },
  "getString(I)Ljava/lang/String;": function (this: JFragment, id: number) {
    return this.act ? vcall(this.act, "getString", "(I)Ljava/lang/String;", id) : null;
  },
  "startActivity(Landroid/content/Intent;)V": function (this: JFragment, i: unknown) {
    return this.act ? vcall(this.act, "startActivity", "(Landroid/content/Intent;)V", i) : undefined;
  },
  "getFragmentManager()Landroid/app/FragmentManager;": function (this: JFragment) {
    return this.act ? vcall(this.act, "getFragmentManager", "()Landroid/app/FragmentManager;") : null;
  },
  "getArguments()Landroid/os/Bundle;": function (this: JFragment) { return this.args; },
  "setArguments(Landroid/os/Bundle;)V": function (this: JFragment, b: unknown) { this.args = b; },
  "onCreateView(Landroid/view/LayoutInflater;Landroid/view/ViewGroup;Landroid/os/Bundle;)Landroid/view/View;": () => null,
  "getView()Landroid/view/View;": function (this: JFragment) { return this.attachedView; },
  "getTag()Ljava/lang/String;": function (this: JFragment) { return this.tag; },
  "getId()I": function (this: JFragment) { return this.containerId; },
  "onActivityResult(IILandroid/content/Intent;)V": () => {},
  "dump(Ljava/lang/String;Ljava/io/FileDescriptor;Ljava/io/PrintWriter;[Ljava/lang/String;)V": () => {},
  "setHasOptionsMenu(Z)V": () => {}, "setRetainInstance(Z)V": () => {},
};
for (const k of ["isAdded()Z", "isRemoving()Z", "isDetached()Z", "isHidden()Z", "isVisible()Z", "isResumed()Z"]) {
  fragMethods[k] = () => 0;
}
for (const k of ["onCreate(Landroid/os/Bundle;)V", "onActivityCreated(Landroid/os/Bundle;)V",
  "onSaveInstanceState(Landroid/os/Bundle;)V", "onViewStateRestored(Landroid/os/Bundle;)V",
  "onViewCreated(Landroid/view/View;Landroid/os/Bundle;)V", "onStart()V", "onResume()V", "onPause()V",
  "onStop()V", "onDestroy()V", "onDestroyView()V", "onDetach()V", "onLowMemory()V"]) {
  fragMethods[k] = () => {};
}
rt.register({ name: "android/app/Fragment", ctor: JFragment, methods: fragMethods });
