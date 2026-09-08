import { JObj, rt } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import type { JBundle } from "./os";
import { vcall, newObj } from "../jvm/natives/jlang";
import { type XmlNode, attrStr, attr, TV } from "./axml";
import { normRV } from "./res";
import { appHost, type AppHost, jclsNameOf } from "./apphost";
import { apkPath } from "../jvm/natives/jio";
import { DOCS_AUTHORITY } from "./documents";
import { type JList, newArrayList } from "../jvm/natives/jutil";
import { JIntent, type JComponentName, componentState } from "./intent";
import type { JActivity } from "./app";

class JFeatureInfo extends JObj {
  name: string | null = null;   // null on the glEsVersion entry, as AOSP leaves it
  version = 0;
  reqGlEsVersion = 0;
  flags = 0;
}
rt.register({
  name: "android/content/pm/FeatureInfo", ctor: JFeatureInfo, ifaces: ["android/os/Parcelable"],
  statics: { FLAG_REQUIRED: 1, GL_ES_VERSION_UNDEFINED: 0 },
  fields: { name: "name", version: "version", reqGlEsVersion: "reqGlEsVersion", flags: "flags" },
  methods: {
    "<init>()V": function () {},
    "getGlEsVersion()Ljava/lang/String;": function (this: JFeatureInfo) {
      return (this.reqGlEsVersion >> 16) + "." + (this.reqGlEsVersion & 0xffff);
    },
    "toString()Ljava/lang/String;": function (this: JFeatureInfo) {
      return this.name ? "FeatureInfo{" + this.name + "}" : "FeatureInfo{glEsVers=" + (this.reqGlEsVersion >> 16) + "}";
    },
  },
});
export const signatures = () => jarray([new (rt.link("android/content/pm/Signature").ctor)()], "Landroid/content/pm/Signature;");
rt.register({
  name: "android/content/pm/PackageManager$NameNotFoundException",
  ctor: (() => { const p = rt.link("java/lang/Exception").ctor; return class extends p {}; })(),
  sup: "java/lang/Exception",
});
export class JActivityInfo extends JObj {
  theme = 0; name = ""; packageName = ""; configChanges = 0; screenOrientation = -1; exported = 0;
  permission: string | null = null;
  parentActivityName: string | null = null; metaData: JBundle | null = null;
}
rt.register({
  name: "android/content/pm/ActivityInfo", ctor: JActivityInfo, ifaces: ["android/os/Parcelable"],
  fields: {
    theme: "theme", name: "name", packageName: "packageName", configChanges: "configChanges", screenOrientation: "screenOrientation",
    exported: "exported", permission: "permission",
    parentActivityName: "parentActivityName", metaData: "metaData",
  },
  statics: { SCREEN_ORIENTATION_PORTRAIT: 1, SCREEN_ORIENTATION_UNSPECIFIED: -1, SCREEN_ORIENTATION_LANDSCAPE: 0, SCREEN_ORIENTATION_USER: 2, SCREEN_ORIENTATION_BEHIND: 3,
    SCREEN_ORIENTATION_SENSOR: 4, SCREEN_ORIENTATION_NOSENSOR: 5, SCREEN_ORIENTATION_SENSOR_LANDSCAPE: 6, SCREEN_ORIENTATION_SENSOR_PORTRAIT: 7,
    SCREEN_ORIENTATION_REVERSE_LANDSCAPE: 8, SCREEN_ORIENTATION_REVERSE_PORTRAIT: 9, SCREEN_ORIENTATION_FULL_SENSOR: 10, SCREEN_ORIENTATION_USER_LANDSCAPE: 11,
    SCREEN_ORIENTATION_USER_PORTRAIT: 12, SCREEN_ORIENTATION_FULL_USER: 13, SCREEN_ORIENTATION_LOCKED: 14,
    CONFIG_MCC: 0x0001, CONFIG_MNC: 0x0002, CONFIG_LOCALE: 0x0004, CONFIG_TOUCHSCREEN: 0x0008,
    CONFIG_KEYBOARD: 0x0010, CONFIG_KEYBOARD_HIDDEN: 0x0020, CONFIG_NAVIGATION: 0x0040,
    CONFIG_ORIENTATION: 0x0080, CONFIG_SCREEN_LAYOUT: 0x0100, CONFIG_UI_MODE: 0x0200,
    CONFIG_SCREEN_SIZE: 0x0400, CONFIG_SMALLEST_SCREEN_SIZE: 0x0800, CONFIG_DENSITY: 0x1000,
    CONFIG_LAYOUT_DIRECTION: 0x2000, CONFIG_FONT_SCALE: 0x40000000 },
  methods: { "<init>()V": function () {} },
});
rt.register({
  name: "android/content/pm/ResolveInfo", ctor: class extends JObj {
    activityInfo = null; serviceInfo = null; providerInfo = null; filter = null; priority = 0; preferredOrder = 0;
    match = 0; specificIndex = -1; isDefault = 0; labelRes = 0; nonLocalizedLabel = null; icon = 0; resolvePackageName = null;
  },
  fields: { activityInfo: "activityInfo", serviceInfo: "serviceInfo", providerInfo: "providerInfo", filter: "filter",
    priority: "priority", preferredOrder: "preferredOrder", match: "match", specificIndex: "specificIndex", isDefault: "isDefault",
    labelRes: "labelRes", nonLocalizedLabel: "nonLocalizedLabel", icon: "icon", resolvePackageName: "resolvePackageName" },
  methods: {
    "<init>()V": function () {},
    "loadLabel(Landroid/content/pm/PackageManager;)Ljava/lang/CharSequence;": async function (this: any, pm: unknown) {
      if (this.nonLocalizedLabel !== null) return this.nonLocalizedLabel;
      const ci = this.activityInfo ?? this.serviceInfo ?? this.providerInfo;
      return ci ? vcall(ci, "loadLabel", "(Landroid/content/pm/PackageManager;)Ljava/lang/CharSequence;", pm) : "";
    },
    "loadIcon(Landroid/content/pm/PackageManager;)Landroid/graphics/drawable/Drawable;": async function (this: any, pm: unknown) {
      const ci = this.activityInfo ?? this.serviceInfo ?? this.providerInfo;
      return ci ? vcall(ci, "loadIcon", "(Landroid/content/pm/PackageManager;)Landroid/graphics/drawable/Drawable;", pm) : null;
    },
  },
});
rt.register({
  name: "android/content/pm/ProviderInfo", ctor: class extends JObj { applicationInfo = null; authority = ""; packageName = ""; metaData = null; name = ""; exported = 0; grantUriPermissions = 0; multiprocess = 0; },
  fields: { applicationInfo: "applicationInfo", authority: "authority", packageName: "packageName", metaData: "metaData", name: "name", exported: "exported", grantUriPermissions: "grantUriPermissions", multiprocess: "multiprocess" },
  methods: { "<init>()V": function () {} },
});
rt.register({
  name: "android/content/pm/ServiceInfo", ctor: class extends JObj { metaData = null; name = ""; packageName = ""; },
  fields: { metaData: "metaData", name: "name", packageName: "packageName" },
  methods: { "<init>()V": function () {} },
});
const FAKE_SIG = new Int8Array(64).fill(-0x55);
rt.register({
  name: "android/content/pm/Signature", ctor: class extends JObj {},
  methods: {
    "<init>()V": function () {},
    "toByteArray()[B": () => FAKE_SIG.slice(),
    "toCharsString()Ljava/lang/String;": () => "ab".repeat(64),
    "hashCode()I": () => 0xabab,
    "equals(Ljava/lang/Object;)Z": function (o: unknown) { return o === this ? 1 : 0; },
  },
});
rt.register({
  name: "android/content/pm/SigningInfo", ctor: class extends JObj {},
  methods: {
    "<init>()V": function () {},
    "hasMultipleSigners()Z": () => 0,
    "hasPastSigningCertificates()Z": () => 0,
    "getApkContentsSigners()[Landroid/content/pm/Signature;": signatures,
    "getSigningCertificateHistory()[Landroid/content/pm/Signature;": signatures,
  },
});
/** API 33 replaced every int flags parameter with a boxed long, one class per getter family.
 *  Registered from a loop, so the janitor's `name: "..."` grep cannot see these four. */
export class JInfoFlags extends JObj { value = 0n; }
for (const n of ["ApplicationInfoFlags", "ComponentInfoFlags", "PackageInfoFlags", "ResolveInfoFlags"]) {
  const name = "android/content/pm/PackageManager$" + n;
  rt.register({
    name, ctor: class extends JInfoFlags {},
    methods: {
      [`static of(J)L${name};`]: (v: bigint) => {
        const f = new (rt.link(name).ctor)() as JInfoFlags;
        f.value = v;
        return f;
      },
      "getValue()J": function (this: JInfoFlags) { return this.value; },
    },
  });
}

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
    const raw = attr(md, "value") ?? rsrc;
    if (!raw) {
      b.map.set(k, null);
      continue;
    }
    // PackageParser's TypedArray.peekValue resolves android:value references before choosing
    // the Bundle setter. Preserve that resolved type: @integer is an int, not its string
    // rendering. android:resource is deliberately different and stores the resource id.
    if (rsrc) {
      b.map.set(k, raw.data);
      continue;
    }
    const direct = normRV({ t: raw.type, d: raw.data, s: raw.str ?? undefined });
    const v = direct.t === TV.REFERENCE && appHost ? appHost.res.resolveRefs(direct) : direct;
    const value = v.t === TV.STRING ? v.s ?? null : v.t === TV.BOOLEAN ? (v.d ? 1 : 0) : v.d;
    b.map.set(k, value);
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
export function getAppInfo(host: AppHost): JApplicationInfo {
  if (!cachedAppInfo) {
    cachedAppInfo = new JApplicationInfo();
    cachedAppInfo.packageName = host.pkg;
    cachedAppInfo.sourceDir = apkPath();
    cachedAppInfo.publicSourceDir = apkPath();
    // AOSP leaves these null for a base-only install, and library loaders null-check them
    if (host.splits.length) {
      cachedAppInfo.splitNames = host.splits.slice();
      cachedAppInfo.splitSourceDirs = host.splits.map((n) => apkPath(n));
      cachedAppInfo.splitPublicSourceDirs = cachedAppInfo.splitSourceDirs.slice();
    }
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
  splitNames: string[] | null = null;
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
    packageName: "packageName", versionName: "versionName", versionCode: "versionCode", splitNames: "splitNames",
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
export function getPM(): JPackageManager {
  return cachedPM ?? (cachedPM = new JPackageManager());
}
rt.register({
  name: "android/content/pm/PackageManager", ctor: JPackageManager,
  statics: { PERMISSION_GRANTED: 0, PERMISSION_DENIED: -1, GET_ACTIVITIES: 1, GET_META_DATA: 128, GET_SIGNATURES: 64,
    COMPONENT_ENABLED_STATE_DEFAULT: 0, COMPONENT_ENABLED_STATE_ENABLED: 1, COMPONENT_ENABLED_STATE_DISABLED: 2,
    DONT_KILL_APP: 1,
    FEATURE_AUDIO_LOW_LATENCY: "android.hardware.audio.low_latency", FEATURE_AUDIO_PRO: "android.hardware.audio.pro", FEATURE_TOUCHSCREEN: "android.hardware.touchscreen",
    FEATURE_TOUCHSCREEN_MULTITOUCH: "android.hardware.touchscreen.multitouch", FEATURE_CAMERA: "android.hardware.camera", FEATURE_CAMERA_ANY: "android.hardware.camera.any",
    FEATURE_SENSOR_ACCELEROMETER: "android.hardware.sensor.accelerometer", FEATURE_SENSOR_GYROSCOPE: "android.hardware.sensor.gyroscope", FEATURE_LOCATION: "android.hardware.location",
    FEATURE_LOCATION_GPS: "android.hardware.location.gps", FEATURE_MICROPHONE: "android.hardware.microphone", FEATURE_WIFI: "android.hardware.wifi", FEATURE_BLUETOOTH: "android.hardware.bluetooth",
    FEATURE_VR_MODE: "android.software.vr.mode", FEATURE_TELEPHONY: "android.hardware.telephony", FEATURE_LEANBACK: "android.software.leanback" },
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
    // API 33's boxed-long overloads carry the same flags to the same body, never a second one
    "getPackageInfo(Ljava/lang/String;Landroid/content/pm/PackageManager$PackageInfoFlags;)Landroid/content/pm/PackageInfo;": function (pkg: string, f: JInfoFlags | null) {
      return vcall(this, "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", pkg, Number(f?.value ?? 0n));
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
      pi.splitNames = pi.applicationInfo?.splitNames ?? null;
      pi.firstInstallTime = pi.lastUpdateTime = installTime(pkg);
      pi.signatures = signatures();
      pi.signingInfo = new (rt.link("android/content/pm/SigningInfo").ctor)();
      pi.reqFeatures = reqFeatures();
      pi.activities = jarray([...manifestActivities.keys()].map((n) => mkActivityInfo(n.replace(/\//g, "."))), "Landroid/content/pm/ActivityInfo;");
      return pi;
    },
    "getApplicationInfo(Ljava/lang/String;Landroid/content/pm/PackageManager$ApplicationInfoFlags;)Landroid/content/pm/ApplicationInfo;": function (pkg: string, f: JInfoFlags | null) {
      return vcall(this, "getApplicationInfo", "(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;", pkg, Number(f?.value ?? 0n));
    },
    "getApplicationInfo(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;": function (pkg: string) {
      if (appHost && pkg !== appHost.pkg) throw rt.mkThrowable("android/content/pm/PackageManager$NameNotFoundException", pkg);
      return appHost ? getAppInfo(appHost) : new JApplicationInfo();
    },
    "getApplicationLabel(Landroid/content/pm/ApplicationInfo;)Ljava/lang/CharSequence;": () => appHost?.appLabel ?? "App",
    "resolveActivity(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;": (i: JIntent | null) => resolveActivity(i),
    "resolveActivity(Landroid/content/Intent;Landroid/content/pm/PackageManager$ResolveInfoFlags;)Landroid/content/pm/ResolveInfo;": (i: JIntent | null) => resolveActivity(i),
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
    // "Install unknown apps" is off until the user turns it on in Settings, which is what an
    // app checks before offering to sideload its own updates.
    "canRequestPackageInstalls()Z": () => 0,
    "isInstantApp()Z": () => 0,
    "isInstantApp(Ljava/lang/String;)Z": () => 0,
    // one package is installed and it owns every uid this process can ask about
    "getNameForUid(I)Ljava/lang/String;": () => appHost?.pkg ?? null,
    "getPackagesForUid(I)[Ljava/lang/String;": () => jarray([appHost?.pkg ?? ""], "Ljava/lang/String;"),
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
export function manifestActivityOrientation(cls: string): number {
  const node = manifestActivities.get(cls.replace(/\./g, "/"));
  return (node && attr(node, "screenOrientation")?.data) ?? -1;
}
/** ActivityInfo.CONFIG_UI_MODE: an activity that declares it handles a day/night change is told
 *  about it; one that does not is relaunched, which is the whole of AppCompat's day/night switch. */
export const CONFIG_UI_MODE = 0x0200;
export function activityHandlesConfig(act: JActivity, bits: number): boolean {
  const node = manifestActivities.get(jclsNameOf(act).replace(/\./g, "/"));
  return (((node && attr(node, "configChanges")?.data) ?? 0) & bits) === bits;
}

/** ActivityInfo for a dotted class name, read off that activity's own manifest node. */
function mkActivityInfo(cls: string): JActivityInfo {
  const node = manifestActivities.get(cls.replace(/\./g, "/"));
  const a = new JActivityInfo();
  a.name = cls;
  a.packageName = appHost?.pkg ?? "";
  a.theme = (node && attr(node, "theme")?.data) ?? appHost?.themeResId ?? 0;
  a.configChanges = (node && attr(node, "configChanges")?.data) ?? 0;
  a.screenOrientation = (node && attr(node, "screenOrientation")?.data) ?? -1;
  a.exported = node && attr(node, "exported")?.data ? 1 : 0;
  a.permission = node ? attrStr(node, "permission") : null;
  a.parentActivityName = node ? attrStr(node, "parentActivityName") : null;
  a.metaData = metaData(node);
  return a;
}
