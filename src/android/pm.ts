import { JObj, rt } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import type { JBundle } from "./os";
import { vcall, newObj } from "../jvm/natives/jlang";
import { type XmlNode, attrStr, attr, TV } from "./axml";
import { normRV, resString, type Resources } from "./res";
import { apkCertificates, parsePackageArchive, type PackageArchive } from "./packagearchive";
import { loadDrawable } from "./drawable";
import { mkJResources, mkXmlParser } from "./resnative";
import { getPackageInstaller } from "./packageinstaller";
import { verifyApkSignature } from "./apksignature";
import { persistPackage, restorePackages } from "../shell/packages";
import { appHost, type AppHost, jclsNameOf } from "./apphost";
import { apkPath, vfs } from "../jvm/natives/jio";
import { DOCS_AUTHORITY } from "./documents";
import { type JList, newArrayList, toJsArray } from "../jvm/natives/jutil";
import { JIntent, type JComponentName, componentState, mkComponentName } from "./intent";
import { csText } from "./text";
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
export const signatures = (certificates: Uint8Array[] = []) => {
  rt.link("android/content/pm/Signature");
  return jarray(certificates.map((bytes) => Object.assign(new JSignature(), { bytes: new Int8Array(bytes) })), "Landroid/content/pm/Signature;");
};
rt.register({
  name: "android/content/pm/PackageManager$NameNotFoundException",
  ctor: (() => { const p = rt.link("java/lang/Exception").ctor; return class extends p {}; })(),
  sup: "java/lang/Exception",
});
class JPackageItemInfo extends JObj {
  archiveResources: Resources | null = null;
  name = ""; packageName = ""; labelRes = 0; nonLocalizedLabel: string | null = null; icon = 0; metaData: JBundle | null = null;
}
rt.register({
  name: "android/content/pm/PackageItemInfo", ctor: JPackageItemInfo,
  fields: { name: "name", packageName: "packageName", labelRes: "labelRes", nonLocalizedLabel: "nonLocalizedLabel", icon: "icon", metaData: "metaData" },
  methods: {
    "<init>()V": function () {},
    "loadXmlMetaData(Landroid/content/pm/PackageManager;Ljava/lang/String;)Landroid/content/res/XmlResourceParser;": function (this: JPackageItemInfo, pm: JPackageManager, name: string) {
      const id = this.metaData?.map.get(name);
      if (typeof id !== "number" || !id) return null;
      const info = this instanceof JComponentInfo ? this.applicationInfo : this instanceof JApplicationInfo ? this : null;
      return vcall(pm, "getXml", "(Ljava/lang/String;ILandroid/content/pm/ApplicationInfo;)Landroid/content/res/XmlResourceParser;", this.packageName, id, info);
    },
    "loadLabel(Landroid/content/pm/PackageManager;)Ljava/lang/CharSequence;": function (this: JPackageItemInfo) { return applicationLabel(this); },
    "loadIcon(Landroid/content/pm/PackageManager;)Landroid/graphics/drawable/Drawable;": function (this: JPackageItemInfo) { return this.archiveResources && this.icon ? loadDrawable(this.archiveResources, this.icon, null) : null; },
  },
});
class JComponentInfo extends JPackageItemInfo {
  applicationInfo: JApplicationInfo | null = null;
  processName = ""; permission: string | null = null; enabled = 1; exported = 0; directBootAware = 0;
}
rt.register({ name: "android/content/pm/ComponentInfo", ctor: JComponentInfo, sup: "android/content/pm/PackageItemInfo",
  fields: { applicationInfo: "applicationInfo", processName: "processName", enabled: "enabled", exported: "exported", directBootAware: "directBootAware" },
  methods: { "<init>()V": function () {} },
});
export class JActivityInfo extends JComponentInfo {
  theme = 0; configChanges = 0; screenOrientation = -1;
  parentActivityName: string | null = null;
}
rt.register({
  name: "android/content/pm/ActivityInfo", ctor: JActivityInfo, sup: "android/content/pm/ComponentInfo", ifaces: ["android/os/Parcelable"],
  fields: {
    theme: "theme", configChanges: "configChanges", screenOrientation: "screenOrientation",
    permission: "permission", parentActivityName: "parentActivityName",
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
  name: "android/content/pm/ProviderInfo", sup: "android/content/pm/ComponentInfo", ctor: class extends JComponentInfo { authority = ""; grantUriPermissions = 0; multiprocess = 0; },
  fields: { authority: "authority", grantUriPermissions: "grantUriPermissions", multiprocess: "multiprocess" },
  methods: { "<init>()V": function () {} },
});
class JServiceInfo extends JComponentInfo {
  flags = 0; foregroundServiceType = 0;
}
rt.register({
  name: "android/content/pm/ServiceInfo", ctor: JServiceInfo, sup: "android/content/pm/ComponentInfo",
  fields: { permission: "permission", flags: "flags", foregroundServiceType: "foregroundServiceType" },
  methods: { "<init>()V": function () {} },
});
class JSignature extends JObj { bytes = new Int8Array(0); }
class JSigningInfo extends JObj { certificates: Uint8Array[] = []; }
function signingInfo(certificates: Uint8Array[]): JSigningInfo {
  rt.link("android/content/pm/SigningInfo");
  return Object.assign(new JSigningInfo(), { certificates });
}
rt.register({
  name: "android/content/pm/Signature", ctor: JSignature,
  methods: {
    "<init>([B)V": function (this: JSignature, bytes: Int8Array) { this.bytes = bytes.slice(); },
    "toByteArray()[B": function (this: JSignature) { return this.bytes.slice(); },
    "toCharsString()Ljava/lang/String;": function (this: JSignature) { return [...this.bytes].map((b) => (b & 255).toString(16).padStart(2, "0")).join(""); },
    "hashCode()I": function (this: JSignature) { return this.bytes.reduce((hash, byte) => Math.imul(hash, 31) + byte | 0, 1); },
    "equals(Ljava/lang/Object;)Z": function (this: JSignature, o: unknown) { return o instanceof JSignature && o.bytes.length === this.bytes.length && o.bytes.every((b, i) => b === this.bytes[i]) ? 1 : 0; },
  },
});
rt.register({
  name: "android/content/pm/SigningInfo", ctor: JSigningInfo,
  methods: {
    "<init>()V": function () {},
    "hasMultipleSigners()Z": function (this: JSigningInfo) { return this.certificates.length > 1 ? 1 : 0; },
    "hasPastSigningCertificates()Z": () => 0,
    "getApkContentsSigners()[Landroid/content/pm/Signature;": function (this: JSigningInfo) { return signatures(this.certificates); },
    "getSigningCertificateHistory()[Landroid/content/pm/Signature;": function (this: JSigningInfo) { return this.certificates.length > 1 ? null : signatures(this.certificates); },
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
const manifestServices = new Map<string, XmlNode>();
const manifestReceivers = new Map<string, XmlNode>();
const qualifyComponent = (name: string, pkg: string) => {
  name = name.replace(/\//g, ".");
  return name.startsWith(".") ? pkg + name : name.includes(".") ? name : pkg + "." + name;
};
export function setManifest(root: XmlNode, activities: Map<string, XmlNode>, providers: Map<string, XmlNode>) {
  manifestRoot = root;
  manifestActivities = activities;
  manifestProviders = providers;
  cachedAppInfo = null;
  manifestServices.clear(); manifestReceivers.clear();
  const pkg = attrStr(root, "package") ?? "";
  for (const service of appNode()?.children ?? []) {
    const name = attrStr(service, "name");
    if (name && (service.name === "service" || service.name === "receiver"))
      (service.name === "service" ? manifestServices : manifestReceivers).set(qualifyComponent(name, pkg), service);
  }
}
const appNode = () => manifestRoot?.children.find((c) => c.name === "application") ?? null;
/** <meta-data> children → Bundle, typed the way aapt encoded them (string / boolean / int). */
function metaData(node: XmlNode | null | undefined, res = appHost?.res): JBundle {
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
    const v = direct.t === TV.REFERENCE && res ? res.resolveRefs(direct) : direct;
    const value = v.t === TV.STRING ? v.s ?? null : v.t === TV.BOOLEAN ? (v.d ? 1 : 0) : v.d;
    b.map.set(k, value);
  }
  return b;
}

class JApplicationInfo extends JPackageItemInfo {
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
  name: "android/content/pm/ApplicationInfo", ctor: JApplicationInfo, sup: "android/content/pm/PackageItemInfo", ifaces: ["android/os/Parcelable"],
  fields: {
    packageName: "packageName", sourceDir: "sourceDir", dataDir: "dataDir", nativeLibraryDir: "nativeLibraryDir",
    flags: "flags", targetSdkVersion: "targetSdkVersion", minSdkVersion: "minSdkVersion", theme: "theme",
    labelRes: "labelRes", nonLocalizedLabel: "nonLocalizedLabel", icon: "icon", className: "className", publicSourceDir: "publicSourceDir",
    uid: "uid", processName: "processName", enabled: "enabled", metaData: "metaData",
    splitNames: "splitNames", splitSourceDirs: "splitSourceDirs", splitPublicSourceDirs: "splitPublicSourceDirs",
    sharedLibraryFiles: "sharedLibraryFiles",
  },
  methods: { "<init>()V": function () {} },
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
    cachedAppInfo.metaData = metaData(node);
    cachedAppInfo.enabled = node && attr(node, "enabled")?.data === 0 ? 0 : 1;
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
  activities: unknown = null; receivers: unknown = null; services: unknown = null; providers: unknown = null;
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
function reqFeatures(root = manifestRoot): unknown[] | null {
  const nodes = (root?.children ?? []).filter((c) => c.name === "uses-feature");
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
    activities: "activities", receivers: "receivers", services: "services", providers: "providers",
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

function providerInfo(cls: string, pkg: string, authority: string, n: XmlNode | null, flags = 0): unknown {
  const pi = new (rt.link("android/content/pm/ProviderInfo").ctor)() as Record<string, unknown>;
  pi.name = cls;
  pi.packageName = pkg;
  pi.authority = authority;
  pi.applicationInfo = appHost?.pkg === pkg ? getAppInfo(appHost) : null;
  pi.metaData = flags & 128 ? metaData(n) : null;
  pi.exported = !n || attr(n, "exported")?.data ? 1 : 0;
  pi.grantUriPermissions = !n || attr(n, "grantUriPermissions")?.data ? 1 : 0;
  return pi;
}
const mkProviderInfo = (cls: string, n: XmlNode, flags = 0) =>
  providerInfo(cls, appHost?.pkg ?? "", authoritiesOf(n).join(";"), n, flags);
const sysProviderInfo = ([auth, cls]: [string, string, string]) =>
  providerInfo(cls, cls.slice(0, cls.lastIndexOf(".")), auth, null);

function queryProviders(intent: { action?: string | null } | null, flags = 0): JList {
  const action = intent?.action ?? null;
  return newArrayList([
    ...systemProviders.filter(([, , act]) => !action || act === action).map(sysProviderInfo),
    ...providerNodes().filter(([, n]) => matchesAction(n, action)).map(([c, n]) => mkProviderInfo(c, n, flags)),
  ].map((pi) => {
    const ri = new (rt.link("android/content/pm/ResolveInfo").ctor)() as Record<string, unknown>;
    ri.providerInfo = pi;
    return ri;
  }));
}

function resolveProvider(authority: string, flags = 0): unknown {
  const sys = systemProviders.find(([a]) => a === authority);
  if (sys) return sysProviderInfo(sys);
  for (const [c, n] of providerNodes()) if (authoritiesOf(n).includes(authority)) return mkProviderInfo(c, n, flags);
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

function queryActivities(intent: JIntent | null): JList {
  const info = resolveActivity(intent);
  return newArrayList(info ? [info] : []);
}

function componentEnabled(name: string, node: XmlNode): boolean {
  const state = componentState.get(mkComponentName(appHost?.pkg ?? "", name));
  return state === 1 || state === 0 && attr(node, "enabled")?.data !== 0;
}
function visibleComponent(name: string, node: XmlNode, flags: number): boolean {
  if (flags & 0x100000) return false; // MATCH_SYSTEM_ONLY: the APK is a user-installed package.
  if (!(flags & 0x200) && (attr(appNode()!, "enabled")?.data === 0 || !componentEnabled(name, node))) return false;
  const directBoot = flags & 0xc0000;
  return !directBoot || !!(directBoot & (attr(node, "directBootAware")?.data ? 0x80000 : 0x40000));
}
function componentInfo(info: JServiceInfo | JActivityInfo, name: string, node: XmlNode, flags: number) {
  const pkg = appHost?.pkg ?? "";
  info.name = name; info.packageName = pkg; info.applicationInfo = appHost ? getAppInfo(appHost) : null;
  info.enabled = componentEnabled(name, node) ? 1 : 0;
  info.exported = (attr(node, "exported")?.data ?? (node.children.some((f) => f.name === "intent-filter") ? 1 : 0)) ? 1 : 0;
  info.permission = attrStr(node, "permission") ?? (appNode() ? attrStr(appNode()!, "permission") : null);
  const process = attrStr(node, "process") ?? (appNode() ? attrStr(appNode()!, "process") : null) ?? pkg;
  info.processName = process.startsWith(":") ? pkg + process : process;
  info.directBootAware = attr(node, "directBootAware")?.data ? 1 : 0;
  info.metaData = flags & 0x80 ? metaData(node) : null;
}
function serviceInfo(name: string, node: XmlNode, flags: number): JServiceInfo {
  const info = new (rt.link("android/content/pm/ServiceInfo").ctor)() as JServiceInfo;
  componentInfo(info, name, node, flags);
  info.foregroundServiceType = attr(node, "foregroundServiceType")?.data ?? 0;
  info.flags = (attr(node, "stopWithTask")?.data ? 1 : 0) | (attr(node, "isolatedProcess")?.data ? 2 : 0);
  return info;
}
function receiverInfo(name: string, node: XmlNode, flags: number): JActivityInfo {
  const info = new (rt.link("android/content/pm/ActivityInfo").ctor)() as JActivityInfo;
  componentInfo(info, name, node, flags);
  return info;
}

function getServiceInfo(component: JComponentName, flags: number): JServiceInfo {
  const pkg = appHost?.pkg ?? "", name = qualifyComponent(component.cls, component.pkg);
  const node = manifestServices.get(name);
  if (component.pkg !== pkg || !node || !visibleComponent(name, node, flags)) throw rt.mkThrowable("android/content/pm/PackageManager$NameNotFoundException", component.pkg + "/" + name);
  return serviceInfo(name, node, flags);
}
function queryComponents(intent: JIntent | null, flags: number, receiver = false): JList {
  const result = newArrayList(), pkg = appHost?.pkg ?? "";
  if (!intent || intent.pkg && intent.pkg !== pkg || intent.componentPkg && intent.componentPkg !== pkg) return result;
  for (const [name, node] of receiver ? manifestReceivers : manifestServices) {
    if (!visibleComponent(name, node, flags)) continue;
    let priority = 0;
    if (intent.component) { if (qualifyComponent(intent.component, pkg) !== name) continue; }
    else {
      if (!matchesAction(node, intent.action)) continue;
      const filters = node.children.filter((filter) => filter.name === "intent-filter" &&
        (!intent.action || filter.children.some((a) => a.name === "action" && attrStr(a, "name") === intent.action)) &&
        [...intent.categories, ...(flags & 0x10000 ? ["android.intent.category.DEFAULT"] : [])].every((category) => filter.children.some((a) => a.name === "category" && attrStr(a, "name") === category)) &&
        !intent.dataUri && !intent.typeStr && !filter.children.some((a) => a.name === "data"));
      if (!filters.length) continue;
      priority = Math.max(...filters.map((filter) => attr(filter, "priority")?.data ?? 0));
    }
    const info = new (rt.link("android/content/pm/ResolveInfo").ctor)();
    if (receiver) info.activityInfo = receiverInfo(name, node, flags);
    else info.serviceInfo = serviceInfo(name, node, flags);
    info.priority = priority;
    result.a.push(info);
  }
  result.a.sort((a, b) => (b as { priority: number }).priority - (a as { priority: number }).priority);
  return result;
}

class JInstallSourceInfo extends JObj {}
rt.register({
  name: "android/content/pm/InstallSourceInfo", ctor: JInstallSourceInfo, ifaces: ["android/os/Parcelable"],
  // APK loading has no Android installer of record or installer-supplied source metadata.
  methods: {
    "getInitiatingPackageName()Ljava/lang/String;": () => null,
    "getInitiatingPackageSigningInfo()Landroid/content/pm/SigningInfo;": () => null,
    "getOriginatingPackageName()Ljava/lang/String;": () => null,
    "getInstallingPackageName()Ljava/lang/String;": () => null,
    "getUpdateOwnerPackageName()Ljava/lang/String;": () => null,
    "getPackageSource()I": () => 0,
    "describeContents()I": () => 0,
  },
});
class JPackageManager extends JObj {}
let cachedPM: JPackageManager | null = null;
export function getPM(): JPackageManager {
  if (!cachedPM) { rt.link("android/content/pm/PackageManager"); cachedPM = new JPackageManager(); }
  return cachedPM;
}
rt.register({
  name: "android/content/pm/PackageManager", ctor: JPackageManager,
  statics: { PERMISSION_GRANTED: 0, PERMISSION_DENIED: -1, GET_ACTIVITIES: 1, GET_RECEIVERS: 2, GET_SERVICES: 4, MATCH_DISABLED_COMPONENTS: 0x200, MATCH_SYSTEM_ONLY: 0x100000, MATCH_DIRECT_BOOT_AWARE: 0x80000, MATCH_DIRECT_BOOT_UNAWARE: 0x40000, GET_META_DATA: 128, GET_SIGNATURES: 64,
    COMPONENT_ENABLED_STATE_DEFAULT: 0, COMPONENT_ENABLED_STATE_ENABLED: 1, COMPONENT_ENABLED_STATE_DISABLED: 2,
    DONT_KILL_APP: 1,
    FEATURE_AUDIO_LOW_LATENCY: "android.hardware.audio.low_latency", FEATURE_AUDIO_PRO: "android.hardware.audio.pro", FEATURE_TOUCHSCREEN: "android.hardware.touchscreen",
    FEATURE_TOUCHSCREEN_MULTITOUCH: "android.hardware.touchscreen.multitouch", FEATURE_CAMERA: "android.hardware.camera", FEATURE_CAMERA_ANY: "android.hardware.camera.any",
    FEATURE_SENSOR_ACCELEROMETER: "android.hardware.sensor.accelerometer", FEATURE_SENSOR_GYROSCOPE: "android.hardware.sensor.gyroscope", FEATURE_LOCATION: "android.hardware.location",
    FEATURE_LOCATION_GPS: "android.hardware.location.gps", FEATURE_MICROPHONE: "android.hardware.microphone", FEATURE_WIFI: "android.hardware.wifi", FEATURE_BLUETOOTH: "android.hardware.bluetooth",
    FEATURE_VR_MODE: "android.software.vr.mode", FEATURE_TELEPHONY: "android.hardware.telephony", FEATURE_LEANBACK: "android.software.leanback" },
  methods: {
    "getProviderInfo(Landroid/content/ComponentName;I)Landroid/content/pm/ProviderInfo;": (comp: JComponentName, flags: number) => {
      const cls = qualifyComponent(comp.cls, comp.pkg), node = manifestProviders.get(cls);
      if (comp.pkg !== appHost?.pkg || !node) throw rt.mkThrowable("android/content/pm/PackageManager$NameNotFoundException", comp.pkg + "/" + cls);
      return mkProviderInfo(cls, node, flags);
    },
    "getResourcesForApplication(Ljava/lang/String;)Landroid/content/res/Resources;": async function (pkg: string) {
      const info = await vcall(this, "getApplicationInfo", "(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;", pkg, 0);
      return vcall(this, "getResourcesForApplication", "(Landroid/content/pm/ApplicationInfo;)Landroid/content/res/Resources;", info);
    },
    "getResourcesForApplication(Landroid/content/pm/ApplicationInfo;)Landroid/content/res/Resources;": async (info: JApplicationInfo) => {
      const res = info.archiveResources ?? (info.packageName === appHost?.pkg ? appHost.res : (await installedPackage(info.packageName))?.archive.res);
      if (!res) throw rt.mkThrowable("android/content/pm/PackageManager$NameNotFoundException", info.packageName);
      return res.jobj ?? mkJResources(res, false);
    },
    "getXml(Ljava/lang/String;ILandroid/content/pm/ApplicationInfo;)Landroid/content/res/XmlResourceParser;": async (pkg: string, id: number, info: JApplicationInfo | null) => {
      const res = info?.archiveResources ?? (pkg === appHost?.pkg ? appHost.res : (await installedPackage(pkg))?.archive.res);
      if (!res) return null;
      try { return mkXmlParser(res, id); }
      catch (error) { if (error instanceof rt.link("android/content/res/Resources$NotFoundException").ctor) return null; throw error; }
    },
    "getReceiverInfo(Landroid/content/ComponentName;I)Landroid/content/pm/ActivityInfo;": (component: JComponentName, flags: number) => {
      const name = qualifyComponent(component.cls, component.pkg), node = manifestReceivers.get(name);
      if (component.pkg !== appHost?.pkg || !node || !visibleComponent(name, node, flags))
        throw rt.mkThrowable("android/content/pm/PackageManager$NameNotFoundException", component.pkg + "/" + name);
      return receiverInfo(name, node, flags);
    },
    "getServiceInfo(Landroid/content/ComponentName;I)Landroid/content/pm/ServiceInfo;": getServiceInfo,
    "getServiceInfo(Landroid/content/ComponentName;Landroid/content/pm/PackageManager$ComponentInfoFlags;)Landroid/content/pm/ServiceInfo;": (c: JComponentName, f: JInfoFlags) => getServiceInfo(c, Number(f.value)),
    // API 33's boxed-long overloads carry the same flags to the same body, never a second one
    "getPackageInfo(Ljava/lang/String;Landroid/content/pm/PackageManager$PackageInfoFlags;)Landroid/content/pm/PackageInfo;": async function (pkg: string, f: JInfoFlags | null) {
      return vcall(this, "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", pkg, Number(f?.value ?? 0n));
    },
    "getPackageInfo(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;": async function (pkg: string, flags: number) {
      const installed = await installedPackage(pkg);
      if (installed) return archiveInfo(installed.archive, installed.path, flags);
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
      if (flags & (64 | 0x8000000)) {
        const bytes = await vfs.readFile(apkPath());
        let certificates: Uint8Array[] = [];
        if (bytes) {
          let pending = certificateCache.get(bytes);
          if (!pending) certificateCache.set(bytes, pending = apkCertificates(bytes, appHost?.zip ?? {}));
          certificates = await pending;
        }
        if (flags & 64) pi.signatures = signatures(certificates);
        if (flags & 0x8000000) pi.signingInfo = signingInfo(certificates);
      }
      pi.reqFeatures = reqFeatures();
      if (flags & 2) pi.receivers = jarray([...manifestReceivers].filter(([name, node]) => visibleComponent(name, node, flags)).map(([name, node]) => receiverInfo(name, node, flags)), "Landroid/content/pm/ActivityInfo;");
      if (flags & 4) pi.services = jarray([...manifestServices].filter(([name, node]) => visibleComponent(name, node, flags)).map(([name, node]) => serviceInfo(name, node, flags)), "Landroid/content/pm/ServiceInfo;");
      pi.activities = jarray([...manifestActivities.keys()].map((n) => mkActivityInfo(n.replace(/\//g, "."))), "Landroid/content/pm/ActivityInfo;");
      return pi;
    },
    "getApplicationInfo(Ljava/lang/String;Landroid/content/pm/PackageManager$ApplicationInfoFlags;)Landroid/content/pm/ApplicationInfo;": async function (pkg: string, f: JInfoFlags | null) {
      return vcall(this, "getApplicationInfo", "(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;", pkg, Number(f?.value ?? 0n));
    },
    "getApplicationInfo(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;": async function (pkg: string, flags: number) {
      const installed = await installedPackage(pkg);
      if (installed) return archiveInfo(installed.archive, installed.path, flags).applicationInfo;
      if (appHost && pkg !== appHost.pkg) throw rt.mkThrowable("android/content/pm/PackageManager$NameNotFoundException", pkg);
      return appHost ? getAppInfo(appHost) : new JApplicationInfo();
    },
    "getApplicationLabel(Landroid/content/pm/ApplicationInfo;)Ljava/lang/CharSequence;": applicationLabel,
    "getPackageArchiveInfo(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;": async (path: string, flags: number) => { const archive = await readArchive(path); return archive ? archiveInfo(archive, path, flags) : null; },
    "getPackageArchiveInfo(Ljava/lang/String;Landroid/content/pm/PackageManager$PackageInfoFlags;)Landroid/content/pm/PackageInfo;": async (path: string, flags: JInfoFlags) => { const archive = await readArchive(path); return archive ? archiveInfo(archive, path, Number(flags.value)) : null; },
    "resolveActivity(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;": (i: JIntent | null) => resolveActivity(i),
    "resolveActivity(Landroid/content/Intent;Landroid/content/pm/PackageManager$ResolveInfoFlags;)Landroid/content/pm/ResolveInfo;": (i: JIntent | null) => resolveActivity(i),
    "queryIntentActivities(Landroid/content/Intent;I)Ljava/util/List;": queryActivities,
    "queryIntentActivities(Landroid/content/Intent;Landroid/content/pm/PackageManager$ResolveInfoFlags;)Ljava/util/List;": queryActivities,
    "queryIntentContentProviders(Landroid/content/Intent;I)Ljava/util/List;": queryProviders,
    "queryIntentContentProviders(Landroid/content/Intent;Landroid/content/pm/PackageManager$ComponentInfoFlags;)Ljava/util/List;": (i: { action?: string | null } | null, flags: JInfoFlags) => queryProviders(i, Number(flags.value)),
    "resolveContentProvider(Ljava/lang/String;I)Landroid/content/pm/ProviderInfo;": resolveProvider,
    "resolveContentProvider(Ljava/lang/String;Landroid/content/pm/PackageManager$ComponentInfoFlags;)Landroid/content/pm/ProviderInfo;": (a: string, flags: JInfoFlags) => resolveProvider(a, Number(flags.value)),
    "queryBroadcastReceivers(Landroid/content/Intent;I)Ljava/util/List;": (i: JIntent, f: number) => queryComponents(i, f, true),
    "queryBroadcastReceivers(Landroid/content/Intent;Landroid/content/pm/PackageManager$ResolveInfoFlags;)Ljava/util/List;": (i: JIntent, f: JInfoFlags) => queryComponents(i, Number(f.value), true),
    "queryIntentServices(Landroid/content/Intent;I)Ljava/util/List;": queryComponents,
    "queryIntentServices(Landroid/content/Intent;Landroid/content/pm/PackageManager$ResolveInfoFlags;)Ljava/util/List;": (i: JIntent, f: JInfoFlags) => queryComponents(i, Number(f.value)),
    "resolveService(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;": (i: JIntent, f: number) => queryComponents(i, f).a[0] ?? null,
    "resolveService(Landroid/content/Intent;Landroid/content/pm/PackageManager$ResolveInfoFlags;)Landroid/content/pm/ResolveInfo;": (i: JIntent, f: JInfoFlags) => queryComponents(i, Number(f.value)).a[0] ?? null,
    "getComponentEnabledSetting(Landroid/content/ComponentName;)I": (c: JComponentName) => componentState.get(c),
    "setComponentEnabledSetting(Landroid/content/ComponentName;II)V": (c: JComponentName, st: number) => componentState.set(c, st),
    "hasSystemFeature(Ljava/lang/String;)Z": () => 0,
    "getSystemAvailableFeatures()[Landroid/content/pm/FeatureInfo;": () => jarray([], "Landroid/content/pm/FeatureInfo;"),
    "checkPermission(Ljava/lang/String;Ljava/lang/String;)I": () => 0,
    "getInstallerPackageName(Ljava/lang/String;)Ljava/lang/String;": () => null,
    "getInstallSourceInfo(Ljava/lang/String;)Landroid/content/pm/InstallSourceInfo;": (pkg: string) => {
      if (!appHost || pkg !== appHost.pkg) throw rt.mkThrowable("android/content/pm/PackageManager$NameNotFoundException", pkg);
      return new JInstallSourceInfo();
    },
    "getPackageInstaller()Landroid/content/pm/PackageInstaller;": getPackageInstaller,
    "canRequestPackageInstalls()Z": () => 1,
    "isInstantApp()Z": () => 0,
    "isInstantApp(Ljava/lang/String;)Z": () => 0,
    // one package is installed and it owns every uid this process can ask about
    "getNameForUid(I)Ljava/lang/String;": () => appHost?.pkg ?? null,
    "getPackagesForUid(I)[Ljava/lang/String;": () => jarray([appHost?.pkg ?? ""], "Ljava/lang/String;"),
    "getInstalledPackages(I)Ljava/util/List;": installedPackages,
    "getInstalledPackages(Landroid/content/pm/PackageManager$PackageInfoFlags;)Ljava/util/List;": (flags: JInfoFlags) => installedPackages(Number(flags.value)),
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

class JShortcutInfo extends JObj {
  id = ""; pkg = ""; shortLabel = ""; longLabel: string | null = null; disabledMessage: string | null = null;
  intents: JIntent[] = []; icon: unknown = null; extras: JBundle | null = null;
  rank = 0; excluded = 0; longLived = false; dynamic = false;
}
async function copyShortcut(info: JShortcutInfo): Promise<JShortcutInfo> {
  const copy = Object.assign(new (rt.link("android/content/pm/ShortcutInfo").ctor)(), info);
  copy.intents = await Promise.all(info.intents.map((intent) => newObj("android/content/Intent", "(Landroid/content/Intent;)V", intent)));
  if (info.extras) {
    copy.extras = Object.assign(new (rt.link("android/os/PersistableBundle").ctor)(), info.extras);
    copy.extras.map = new Map(info.extras.map);
  }
  return copy;
}
rt.register({
  name: "android/content/pm/ShortcutInfo", ctor: JShortcutInfo, ifaces: ["android/os/Parcelable"],
  statics: { SURFACE_LAUNCHER: 1 },
  methods: {
    "getId()Ljava/lang/String;": function (this: JShortcutInfo) { return this.id; },
    "getPackage()Ljava/lang/String;": function (this: JShortcutInfo) { return this.pkg; },
    "getShortLabel()Ljava/lang/CharSequence;": function (this: JShortcutInfo) { return this.shortLabel; },
    "getLongLabel()Ljava/lang/CharSequence;": function (this: JShortcutInfo) { return this.longLabel; },
    "getDisabledMessage()Ljava/lang/CharSequence;": function (this: JShortcutInfo) { return this.disabledMessage; },
    "getRank()I": function (this: JShortcutInfo) { return this.rank; },
    "getExtras()Landroid/os/PersistableBundle;": async function (this: JShortcutInfo) { return (await copyShortcut(this)).extras; },
    "getIntent()Landroid/content/Intent;": async function (this: JShortcutInfo) { return (await copyShortcut(this)).intents.at(-1) ?? null; },
    "getIntents()[Landroid/content/Intent;": async function (this: JShortcutInfo) { return jarray((await copyShortcut(this)).intents, "Landroid/content/Intent;"); },
    "isDynamic()Z": function (this: JShortcutInfo) { return this.dynamic ? 1 : 0; },
    "isLongLived()Z": function (this: JShortcutInfo) { return this.longLived ? 1 : 0; },
    "isExcludedFromSurfaces(I)Z": function (this: JShortcutInfo, surfaces: number) { return this.excluded & surfaces ? 1 : 0; },
    "isPinned()Z": () => 0,
    "isDeclaredInManifest()Z": () => 0,
    "isEnabled()Z": () => 1,
  },
});
class JShortcutBuilder extends JObj { info = new JShortcutInfo(); }
const shortcutBuilder = "Landroid/content/pm/ShortcutInfo$Builder;";
rt.register({
  name: "android/content/pm/ShortcutInfo$Builder", ctor: JShortcutBuilder,
  methods: {
    "<init>(Landroid/content/Context;Ljava/lang/String;)V": async function (this: JShortcutBuilder, context: unknown, id: string) {
      if (context == null || id == null) throw rt.mkThrowable("java/lang/NullPointerException", "Shortcut context and id required");
      if (!id) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Shortcut id must not be empty");
      this.info.id = id; this.info.pkg = await vcall(context, "getPackageName", "()Ljava/lang/String;");
    },
    [`setShortLabel(Ljava/lang/CharSequence;)${shortcutBuilder}`]: async function (this: JShortcutBuilder, label: unknown) {
      const text = await csText(label);
      if (!text) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Shortcut label must not be empty");
      this.info.shortLabel = text; return this;
    },
    [`setLongLabel(Ljava/lang/CharSequence;)${shortcutBuilder}`]: async function (this: JShortcutBuilder, label: unknown) { this.info.longLabel = await csText(label); return this; },
    [`setDisabledMessage(Ljava/lang/CharSequence;)${shortcutBuilder}`]: async function (this: JShortcutBuilder, label: unknown) { this.info.disabledMessage = await csText(label); return this; },
    [`setIntent(Landroid/content/Intent;)${shortcutBuilder}`]: function (this: JShortcutBuilder, intent: JIntent) { this.info.intents = [intent]; return this; },
    [`setIntents([Landroid/content/Intent;)${shortcutBuilder}`]: function (this: JShortcutBuilder, intents: JIntent[]) { this.info.intents = intents.slice(); return this; },
    [`setIcon(Landroid/graphics/drawable/Icon;)${shortcutBuilder}`]: function (this: JShortcutBuilder, icon: unknown) { this.info.icon = icon; return this; },
    [`setExtras(Landroid/os/PersistableBundle;)${shortcutBuilder}`]: function (this: JShortcutBuilder, extras: JBundle) { this.info.extras = extras; return this; },
    [`setRank(I)${shortcutBuilder}`]: function (this: JShortcutBuilder, rank: number) {
      if (rank < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Rank must not be negative");
      this.info.rank = rank; return this;
    },
    [`setLongLived(Z)${shortcutBuilder}`]: function (this: JShortcutBuilder, value: number) { this.info.longLived = !!value; return this; },
    [`setExcludedFromSurfaces(I)${shortcutBuilder}`]: function (this: JShortcutBuilder, value: number) { this.info.excluded = value; return this; },
    "build()Landroid/content/pm/ShortcutInfo;": async function (this: JShortcutBuilder) {
      if (!this.info.shortLabel || !this.info.intents.length || this.info.intents.some((intent) => !intent?.action)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Shortcut label and intents with actions are required");
      return copyShortcut(this.info);
    },
  },
});
class JShortcutManager extends JObj { packages = new Map<string, Map<string, JShortcutInfo>>(); }
rt.register({
  name: "android/content/pm/ShortcutManager", ctor: JShortcutManager,
  methods: {
    "setDynamicShortcuts(Ljava/util/List;)Z": async function (this: JShortcutManager, list: unknown) {
      const pkg = appHost?.pkg ?? "", shortcuts = new Map<string, JShortcutInfo>();
      for (const info of await toJsArray(list)) {
        if (!(info instanceof JShortcutInfo) || info.pkg !== pkg) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Shortcut belongs to another package");
        const copy = await copyShortcut(info); copy.dynamic = true; shortcuts.set(copy.id, copy);
      }
      this.packages.set(pkg, shortcuts); return 1;
    },
    "getDynamicShortcuts()Ljava/util/List;": async function (this: JShortcutManager) {
      const list = newArrayList(); list.a = await Promise.all([...(this.packages.get(appHost?.pkg ?? "")?.values() ?? [])].map(copyShortcut)); return list;
    },
    "removeAllDynamicShortcuts()V": function (this: JShortcutManager) { this.packages.delete(appHost?.pkg ?? ""); },
    "reportShortcutUsed(Ljava/lang/String;)V": (id: string) => { if (id == null) throw rt.mkThrowable("java/lang/NullPointerException", "shortcutId"); },
    "isRequestPinShortcutSupported()Z": () => 0,
  },
});

function applicationLabel(info: JPackageItemInfo): string {
  return info.nonLocalizedLabel ?? (info.labelRes && info.archiveResources ? resString(info.archiveResources, info.labelRes) : null) ?? (info.packageName === appHost?.pkg ? appHost.appLabel : info.packageName);
}
const archiveCache = new WeakMap<Uint8Array, Promise<PackageArchive>>();
const certificateCache = new WeakMap<Uint8Array, Promise<Uint8Array[]>>();
async function readArchive(path: string): Promise<PackageArchive | null> {
  const bytes = await vfs.readFile(path);
  if (!bytes) return null;
  let archive = archiveCache.get(bytes);
  if (!archive) archiveCache.set(bytes, archive = parsePackageArchive(bytes));
  try { return await archive; } catch { return null; }
}
function archiveInfo(archive: PackageArchive, path: string, flags: number): JPackageInfo {
  const { root, pkg, res, certificates } = archive;
  const app = root.children.find((c) => c.name === "application");
  rt.link("android/content/pm/PackageInfo"); rt.link("android/content/pm/ApplicationInfo");
  const info = new JPackageInfo(), ai = new JApplicationInfo();
  info.packageName = ai.packageName = pkg;
  info.versionCode = attr(root, "versionCode")?.data ?? 0;
  info.longVersionCode = BigInt(info.versionCode >>> 0) | BigInt(attr(root, "versionCodeMajor")?.data ?? 0) << 32n;
  const version = attr(root, "versionName");
  info.versionName = version?.type === TV.REFERENCE ? resString(res, version.data) : version?.str ?? "";
  ai.sourceDir = ai.publicSourceDir = path; ai.dataDir = `/data/data/${pkg}`;
  ai.archiveResources = res; ai.processName = pkg;
  const label = app && attr(app, "label");
  ai.labelRes = label?.type === TV.REFERENCE ? label.data : 0;
  ai.nonLocalizedLabel = label?.str ?? null;
  ai.icon = app && attr(app, "icon")?.data || 0;
  ai.className = app && attrStr(app, "name") || null;
  const sdk = root.children.find((c) => c.name === "uses-sdk");
  ai.minSdkVersion = sdk && attr(sdk, "minSdkVersion")?.data || 1;
  ai.targetSdkVersion = sdk && attr(sdk, "targetSdkVersion")?.data || ai.minSdkVersion;
  if (flags & 128) ai.metaData = metaData(app, res);
  info.applicationInfo = ai; info.reqFeatures = reqFeatures(root);
  if (flags & 64) info.signatures = signatures(certificates);
  if (flags & 0x8000000) info.signingInfo = signingInfo(certificates);
  return info;
}
const installedPath = (pkg: string) => `/data/app/${pkg}/base.apk`;
async function installedPackage(pkg: string) {
  await restorePackages();
  const path = installedPath(pkg), archive = await readArchive(path);
  return archive ? { path, archive } : null;
}
async function installedPackages(flags: number): Promise<JList> {
  await restorePackages();
  const result = newArrayList();
  if (appHost) result.a.push(await vcall(getPM(), "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", appHost.pkg, flags));
  for (const path of vfs.files.keys()) {
    if (!/^\/data\/app\/[^/]+\/base\.apk$/.test(path)) continue;
    const archive = await readArchive(path);
    if (archive && archive.pkg !== appHost?.pkg) result.a.push(archiveInfo(archive, path, flags));
  }
  return result;
}
export async function installPackageArchive(bytes: Uint8Array, expectedPackage: string | null = null): Promise<string> {
  await verifyApkSignature(bytes);
  const archive = await parsePackageArchive(bytes);
  if (expectedPackage && expectedPackage !== archive.pkg) throw new Error("Session package name differs from APK");
  if (archive.pkg === appHost?.pkg) throw new Error("Replacing the running package is unsupported");
  if (!archive.certificates.length) throw new Error("APK is unsigned");
  const previous = await installedPackage(archive.pkg);
  if (previous && archiveInfo(archive, "", 0).longVersionCode < archiveInfo(previous.archive, previous.path, 0).longVersionCode)
    throw new Error("APK version is older than installed package");
  if (previous && (previous.archive.certificates.length !== archive.certificates.length || previous.archive.certificates.some((cert, i) => {
    const next = archive.certificates[i]; return !next || cert.length !== next.length || cert.some((b, j) => b !== next[j]);
  }))) throw new Error("APK signing certificate differs from installed package");
  await persistPackage(installedPath(archive.pkg), bytes);
  vfs.write(installedPath(archive.pkg), bytes);
  return archive.pkg;
}
