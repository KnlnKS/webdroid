import { JObj, rt, stubs, fieldGetters, flagGetters } from "../jvm/runtime";
import { jarray, hexBytes } from "../jvm/abi";
import { device } from "../shell/config";
import type { JBundle } from "./os";
import { vcall, vcallOn, curThread, newObj } from "../jvm/natives/jlang";
import { type XmlNode, attrStr, attr, TV } from "./axml";
import { normRV, resString, type Resources } from "./res";
import { apkCertificates, parsePackageArchive, packageArchive, type PackageArchive } from "./packagearchive";
import { packedArchives } from "../shell/packedarchive";
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
import { matchesIntentFilter } from "./intent-filter";
import { csText } from "./text";
import type { JActivity } from "./app";
import { PackageRecord, packages, packageUid, qualifyComponent, signaturePermissions, type ComponentKind } from "./packages";
import { digestBytes } from "../jvm/natives/jsec";

class JFeatureInfo extends JObj {
  name: string | null = null;   // null on the glEsVersion entry, as AOSP leaves it
  version = 0;
  reqGlEsVersion = 0;
  flags = 0;
}
rt.register({
  name: "android/content/pm/FeatureInfo", ctor: JFeatureInfo, ifaces: ["android/os/Parcelable"],
  statics: { FLAG_REQUIRED: 1, GL_ES_VERSION_UNDEFINED: 0 },
  fields: ["name", "version", "reqGlEsVersion", "flags"],
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
const signatures = (certificates: Uint8Array[] = []) => {
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
  fields: ["name", "packageName", "labelRes", "nonLocalizedLabel", "icon", "metaData"],
  methods: {
    "<init>()V": function () {},
    "loadXmlMetaData(Landroid/content/pm/PackageManager;Ljava/lang/String;)Landroid/content/res/XmlResourceParser;": function (this: JPackageItemInfo, pm: JPackageManager, name: string) {
      const id = this.metaData?.map.get(name);
      if (typeof id !== "number" || !id) return null;
      const info = this instanceof JComponentInfo ? this.applicationInfo : this instanceof JApplicationInfo ? this : null;
      return vcall(pm, "getXml", "(Ljava/lang/String;ILandroid/content/pm/ApplicationInfo;)Landroid/content/res/XmlResourceParser;", this.packageName, id, info);
    },
    "loadLabel(Landroid/content/pm/PackageManager;)Ljava/lang/CharSequence;": function (this: JPackageItemInfo) { return applicationLabel(this); },
    "loadIcon(Landroid/content/pm/PackageManager;)Landroid/graphics/drawable/Drawable;": async function (this: JPackageItemInfo, pm: JPackageManager) {
      const info = this instanceof JComponentInfo ? this.applicationInfo : this instanceof JApplicationInfo ? this : null;
      const icon = this.icon ? await vcall(pm, "getDrawable", "(Ljava/lang/String;ILandroid/content/pm/ApplicationInfo;)Landroid/graphics/drawable/Drawable;", this.packageName, this.icon, info) : null;
      return icon ?? vcall(this, "loadDefaultIcon", "(Landroid/content/pm/PackageManager;)Landroid/graphics/drawable/Drawable;", pm);
    },
    "loadDefaultIcon(Landroid/content/pm/PackageManager;)Landroid/graphics/drawable/Drawable;": (pm: JPackageManager) => vcall(pm, "getDefaultActivityIcon", "()Landroid/graphics/drawable/Drawable;"),
  },
});
class JPermissionInfo extends JPackageItemInfo {
  group: string | null = null; protectionLevel = 0; flags = 0; descriptionRes = 0;
}
rt.register({
  name: "android/content/pm/PermissionInfo", ctor: JPermissionInfo, sup: "android/content/pm/PackageItemInfo", ifaces: ["android/os/Parcelable"],
  fields: ["group", "protectionLevel", "flags", "descriptionRes"],
  methods: {
    "<init>()V": function () {},
    "getProtection()I": function (this: JPermissionInfo) { return this.protectionLevel & 15; },
    "getProtectionFlags()I": function (this: JPermissionInfo) { return this.protectionLevel & ~15; },
    "describeContents()I": () => 0,
  },
});
class JComponentInfo extends JPackageItemInfo {
  applicationInfo: JApplicationInfo | null = null;
  processName = ""; permission: string | null = null; enabled = 1; exported = 0; directBootAware = 0;
}
export class JConfigurationInfo extends JObj { reqTouchScreen = 0; reqKeyboardType = 0; reqNavigation = 0; reqInputFeatures = 0; reqGlEsVersion = 0; }
rt.register({ name: "android/content/pm/ConfigurationInfo", ctor: JConfigurationInfo, fields: {
  reqTouchScreen: "reqTouchScreen", reqKeyboardType: "reqKeyboardType", reqNavigation: "reqNavigation", reqInputFeatures: "reqInputFeatures", reqGlEsVersion: "reqGlEsVersion",
}, methods: { "<init>()V": function () {}, "getGlEsVersion()Ljava/lang/String;": function (this: JConfigurationInfo) { return (this.reqGlEsVersion >>> 16) + "." + (this.reqGlEsVersion & 65535); } } });
rt.register({ name: "android/content/pm/ComponentInfo", ctor: JComponentInfo, sup: "android/content/pm/PackageItemInfo",
  fields: ["applicationInfo", "processName", "enabled", "exported", "directBootAware"],
  methods: {
    "<init>()V": function () {},
    "isEnabled()Z": function (this: JComponentInfo) { return this.enabled && (this.applicationInfo?.enabled ?? 1) ? 1 : 0; },
    "loadDefaultIcon(Landroid/content/pm/PackageManager;)Landroid/graphics/drawable/Drawable;": function (this: JComponentInfo, pm: JPackageManager) {
      return this.applicationInfo ? vcall(this.applicationInfo, "loadIcon", "(Landroid/content/pm/PackageManager;)Landroid/graphics/drawable/Drawable;", pm)
        : vcall(pm, "getDefaultActivityIcon", "()Landroid/graphics/drawable/Drawable;");
    },
  },
});
class JActivityInfo extends JComponentInfo {
  theme = 0; configChanges = 0; screenOrientation = -1; flags = 0;
  parentActivityName: string | null = null;
}
rt.register({
  name: "android/content/pm/ActivityInfo", ctor: JActivityInfo, sup: "android/content/pm/ComponentInfo", ifaces: ["android/os/Parcelable"],
  fields: ["theme", "configChanges", "screenOrientation", "permission", "parentActivityName", "flags"],
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
export class JResolveInfo extends JObj {
  activityInfo: JActivityInfo | null = null; serviceInfo: JServiceInfo | null = null; providerInfo: JProviderInfo | null = null;
  filter: unknown = null; priority = 0; preferredOrder = 0;
  match = 0; specificIndex = -1; isDefault = 0; labelRes = 0; nonLocalizedLabel: string | null = null; icon = 0; resolvePackageName: string | null = null;
}
rt.register({
  name: "android/content/pm/ResolveInfo", ctor: JResolveInfo,
  fields: ["activityInfo", "serviceInfo", "providerInfo", "filter", "priority", "preferredOrder", "match",
    "specificIndex", "isDefault", "labelRes", "nonLocalizedLabel", "icon", "resolvePackageName"],
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
class JProviderInfo extends JComponentInfo { authority = ""; grantUriPermissions = 0; multiprocess = 0; readPermission: string | null = null; writePermission: string | null = null; }
rt.register({
  name: "android/content/pm/ProviderInfo", sup: "android/content/pm/ComponentInfo", ctor: JProviderInfo,
  fields: ["authority", "grantUriPermissions", "multiprocess", "readPermission", "writePermission"],
  methods: { "<init>()V": function () {} },
});
class JServiceInfo extends JComponentInfo {
  flags = 0; foregroundServiceType = 0;
}
rt.register({
  name: "android/content/pm/ServiceInfo", ctor: JServiceInfo, sup: "android/content/pm/ComponentInfo",
  fields: ["permission", "flags", "foregroundServiceType"],
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
    "<init>(Ljava/lang/String;)V": function (this: JSignature, text: string) {
      if (text === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
      if (text.length % 2 || !/^[0-9a-f]*$/i.test(text)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "invalid hex signature");
      this.bytes = Int8Array.from({ length: text.length / 2 }, (_, i) => parseInt(text.slice(i * 2, i * 2 + 2), 16));
    },
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
class JInfoFlags extends JObj { value = 0n; }
for (const n of ["ApplicationInfoFlags", "ComponentInfoFlags", "PackageInfoFlags", "ResolveInfoFlags"]) {
  const name = "android/content/pm/PackageManager$" + n;
  rt.register({
    name, ctor: class extends JInfoFlags {},
    methods: {
      [`static of(J)L${name};`]: (v: bigint) => {
        const f = rt.make(name) as JInfoFlags;
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
let currentPackage: PackageRecord | null = null;
export function setManifest(root: XmlNode, activities: Map<string, XmlNode>, providers: Map<string, XmlNode>) {
  manifestRoot = root;
  manifestActivities = activities;
  manifestProviders = providers;
  cachedAppInfo = null;
  manifestServices.clear(); manifestReceivers.clear();
  const pkg = attrStr(root, "package") ?? "";
  if (currentPackage && packages.get(currentPackage.pkg) === currentPackage) packages.delete(currentPackage.pkg);
  if (appHost) {
    const host = appHost;
    currentPackage = packages.get(pkg) ?? new PackageRecord(root, host.res, apkPath(), packageUid(pkg), async () => {
      const bytes = await vfs.readFile(apkPath());
      if (!bytes) return [];
      let pending = certificateCache.get(bytes);
      if (!pending) certificateCache.set(bytes, pending = apkCertificates(bytes, host.zip));
      return pending;
    });
    packages.set(pkg, currentPackage);
  }
  for (const service of appNode()?.children ?? []) {
    const name = attrStr(service, "name");
    if (name && (service.name === "service" || service.name === "receiver"))
      (service.name === "service" ? manifestServices : manifestReceivers).set(qualifyComponent(name, pkg), service);
  }
}
const appNode = () => manifestRoot?.children.find((c) => c.name === "application") ?? null;
/** <meta-data> children → Bundle, typed the way aapt encoded them (string / boolean / int). */
function metaData(node: XmlNode | null | undefined, res = appHost?.res): JBundle {
  const b = rt.make("android/os/Bundle") as JBundle;
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
  deviceProtectedDataDir: string | null = null; storageUuid: unknown = null;
  flags = 0; targetSdkVersion = 33; minSdkVersion = 21; theme = 0; labelRes = 0; icon = 0;
  // AOSP fills exactly one of these from <application android:label>: the resource id when it
  // is a reference, the literal otherwise. Code that names the app reads whichever is set.
  nonLocalizedLabel: string | null = null;
  className: string | null = null; publicSourceDir = ""; uid = 10001; processName = "";
  enabled = 1; metaData: JBundle | null = null;
  category = -1;
  // a single base.apk install has no splits: null, as AOSP leaves them (library loaders null-check these)
  splitNames: string[] | null = null; splitSourceDirs: string[] | null = null; splitPublicSourceDirs: string[] | null = null;
  sharedLibraryFiles: string[] | null = null;
}
export const FLAG_IS_GAME = 0x02000000;
rt.register({
  name: "android/content/pm/ApplicationInfo", ctor: JApplicationInfo, sup: "android/content/pm/PackageItemInfo", ifaces: ["android/os/Parcelable"],
  fields: ["packageName", "sourceDir", "dataDir", "deviceProtectedDataDir", "storageUuid", "nativeLibraryDir", "flags", "targetSdkVersion", "minSdkVersion",
    "theme", "labelRes", "nonLocalizedLabel", "icon", "className", "publicSourceDir", "uid", "processName", "enabled",
    "metaData", "category", "splitNames", "splitSourceDirs", "splitPublicSourceDirs", "sharedLibraryFiles"],
  methods: { "<init>()V": function () {} },
});
let cachedAppInfo: JApplicationInfo | null = null;
export function getAppInfo(host: AppHost): JApplicationInfo {
  if (!cachedAppInfo) {
    cachedAppInfo = new JApplicationInfo();
    cachedAppInfo.packageName = host.pkg;
    cachedAppInfo.uid = packageUid(host.pkg);
    cachedAppInfo.flags = packages.get(host.pkg)?.system ? 1 : 0;
    cachedAppInfo.sourceDir = apkPath();
    cachedAppInfo.publicSourceDir = apkPath();
    // AOSP leaves these null for a base-only install, and library loaders null-check them
    if (host.splits.length) {
      cachedAppInfo.splitNames = host.splits.slice();
      cachedAppInfo.splitSourceDirs = host.splits.map((n) => apkPath(n));
      cachedAppInfo.splitPublicSourceDirs = cachedAppInfo.splitSourceDirs.slice();
    }
    cachedAppInfo.dataDir = `/data/data/${host.pkg}`;
    cachedAppInfo.deviceProtectedDataDir = `/data/user_de/0/${host.pkg}`;
    cachedAppInfo.processName = host.pkg;
    cachedAppInfo.theme = host.themeResId;
    if (manifestRoot) {
      const sdk = usesSdk(manifestRoot);
      cachedAppInfo.minSdkVersion = sdk.min; cachedAppInfo.targetSdkVersion = sdk.target;
    }
    cachedAppInfo.icon = host.iconRes;
    const node = appNode();
    fillManifestGameInfo(cachedAppInfo, node);
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
  requestedPermissions: string[] | null = null;
  requestedPermissionsFlags: Int32Array | null = null;
  activities: unknown = null; receivers: unknown = null; services: unknown = null; providers: unknown = null;
  installLocation = -1; instrumentation: JInstrumentationInfo[] | null = null;
}
class JInstrumentationInfo extends JPackageItemInfo {
  targetPackage = ""; targetProcesses: string | null = null;
  handleProfiling = 0; functionalTest = 0;
  sourceDir = ""; publicSourceDir = ""; dataDir = "";
}
rt.register({ name: "android/content/pm/InstrumentationInfo", ctor: JInstrumentationInfo, sup: "android/content/pm/PackageItemInfo",
  ifaces: ["android/os/Parcelable"], fields: ["targetPackage", "targetProcesses", "handleProfiling", "functionalTest", "sourceDir", "publicSourceDir", "dataDir"],
  methods: { "<init>()V": function () {} } });
/**
 * When this package was installed, epoch ms. An app's data directory IS its installation
 * here, so the first boot that has no persisted state is the install, and the timestamp is
 * kept with that state (wd.reset wipes it along with the rest of the "install").
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
function requestedPermissions(root = manifestRoot): string[] | null {
  const names = new Set<string>();
  for (const node of root?.children ?? []) {
    if (node.name !== "uses-permission" && node.name !== "uses-permission-sdk-23" && node.name !== "uses-permission-sdk-m") continue;
    if (node.name !== "uses-permission" && device.sdk < 23) continue;
    const max = attr(node, "maxSdkVersion")?.data ?? 0;
    if (max && max < device.sdk) continue;
    const name = attrStr(node, "name");
    if (name) names.add(name);
  }
  return names.size ? jarray([...names], "Ljava/lang/String;") : null;
}
async function fillRequestedPermissions(info: JPackageInfo, root = manifestRoot, installed = true): Promise<void> {
  info.requestedPermissions = requestedPermissions(root);
  if (!info.requestedPermissions) return;
  info.requestedPermissionsFlags = Int32Array.from(await Promise.all(info.requestedPermissions.map(async (name) =>
    1 | (installed && await vcall(getPM(), "checkPermission", "(Ljava/lang/String;Ljava/lang/String;)I", name, info.packageName) === 0 ? 2 : 0))));
}
rt.register({
  name: "android/content/pm/PackageInfo", ctor: JPackageInfo, ifaces: ["android/os/Parcelable"],
  fields: ["packageName", "versionName", "versionCode", "splitNames", "applicationInfo", "firstInstallTime",
    "lastUpdateTime", "signatures", "signingInfo", "reqFeatures", "requestedPermissions", "requestedPermissionsFlags", "activities", "receivers",
    "services", "providers", "installLocation", "instrumentation"],
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

/** the manifest's services answering `action`, with their <meta-data> */
export const servicesMatching = (action: string) => [...packages.values()].flatMap((owner) =>
  [...owner.components.service.values()].filter((n) => matchesAction(n, action)).map((node) => ({ node, meta: metaData(node, owner.res), owner })));

function providerInfo(cls: string, pkg: string, authority: string, n: XmlNode | null, flags = 0, owner = packages.get(pkg)): unknown {
  const pi = rt.make("android/content/pm/ProviderInfo") as JProviderInfo;
  pi.name = cls;
  pi.packageName = pkg;
  pi.authority = authority;
  pi.applicationInfo = appHost?.pkg === pkg ? getAppInfo(appHost) : null;
  pi.metaData = flags & 128 ? metaData(n) : null;
  pi.exported = !n || attr(n, "exported")?.data ? 1 : 0;
  pi.grantUriPermissions = !n || attr(n, "grantUriPermissions")?.data ? 1 : 0;
  if (n && owner) componentInfo(pi, cls, n, flags, owner);
  // PackageParser: an unset read/write permission falls back to the provider's own
  if (n) { pi.readPermission = attrStr(n, "readPermission") ?? pi.permission; pi.writePermission = attrStr(n, "writePermission") ?? pi.permission; }
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
    const ri = rt.make("android/content/pm/ResolveInfo") as Record<string, unknown>;
    ri.providerInfo = pi;
    return ri;
  }));
}

function resolveProvider(authority: string, flags = 0): unknown {
  const sys = systemProviders.find(([a]) => a === authority);
  if (sys) return sysProviderInfo(sys);
  for (const owner of packages.values()) for (const [c, n] of owner.components.provider)
    if (authoritiesOf(n).includes(authority) && visibleComponent(c, n, flags, owner)) return providerInfo(c, owner.pkg, authoritiesOf(n).join(";"), n, flags, owner);
  return null;
}

/** the manifest's launcher activity (dotted), the entry point PackageManager hands out */
function launcherActivity(): string | null {
  for (const [name, node] of manifestActivities) {
    const launcher = node.children.some((f) => f.name === "intent-filter" &&
      f.children.some((x) => x.name === "category" && attrStr(x, "name") === "android.intent.category.LAUNCHER"));
    if (launcher) return name.replace(/\//g, ".");
  }
  return null;
}
function resolveActivity(intent: JIntent | null, flags: number): unknown {
  return queryActivities(intent, flags).a[0] ?? null;
}
function queryActivities(intent: JIntent | null, flags: number): JList {
  return queryComponents(intent, flags, "activity");
}

function componentEnabled(name: string, node: XmlNode, owner = currentPackage): boolean {
  const state = componentState.get(mkComponentName(owner?.pkg ?? appHost?.pkg ?? "", name));
  return state === 1 || state === 0 && attr(node, "enabled")?.data !== 0;
}
function visibleComponent(name: string, node: XmlNode, flags: number, owner = currentPackage): boolean {
  if (flags & 0x100000 && !owner?.system) return false;
  if (!(flags & 0x200) && (owner?.enabled === false || !componentEnabled(name, node, owner))) return false;
  const directBoot = flags & 0xc0000;
  return !directBoot || !!(directBoot & (attr(node, "directBootAware")?.data ? 0x80000 : 0x40000));
}
function componentInfo(info: JComponentInfo, name: string, node: XmlNode, flags: number, owner = currentPackage) {
  const pkg = owner?.pkg ?? appHost?.pkg ?? "";
  info.name = name; info.packageName = pkg;
  info.applicationInfo = owner && owner !== currentPackage ? recordAppInfo(owner) : appHost ? getAppInfo(appHost) : null;
  info.archiveResources = owner?.res ?? null;
  info.enabled = componentEnabled(name, node, owner) ? 1 : 0;
  info.exported = (attr(node, "exported")?.data ?? (node.children.some((f) => f.name === "intent-filter") ? 1 : 0)) ? 1 : 0;
  info.permission = attrStr(node, "permission") ?? (owner?.application ? attrStr(owner.application, "permission") : null);
  info.processName = owner?.process(node) ?? pkg;
  info.directBootAware = attr(node, "directBootAware")?.data ? 1 : 0;
  info.metaData = flags & 0x80 ? metaData(node, owner?.res) : null;
}
function serviceInfo(name: string, node: XmlNode, flags: number, owner = currentPackage): JServiceInfo {
  const info = rt.make("android/content/pm/ServiceInfo") as JServiceInfo;
  componentInfo(info, name, node, flags, owner);
  info.foregroundServiceType = attr(node, "foregroundServiceType")?.data ?? 0;
  info.flags = (attr(node, "stopWithTask")?.data ? 1 : 0) | (attr(node, "isolatedProcess")?.data ? 2 : 0);
  return info;
}
function receiverInfo(name: string, node: XmlNode, flags: number, owner = currentPackage): JActivityInfo {
  const info = rt.make("android/content/pm/ActivityInfo") as JActivityInfo;
  componentInfo(info, name, node, flags, owner);
  return info;
}

const nameNotFound = (what: string): unknown => rt.mkThrowable("android/content/pm/PackageManager$NameNotFoundException", what);
function lookupComponent(c: JComponentName, kind: ComponentKind, flags: number): [string, XmlNode, PackageRecord] {
  const name = qualifyComponent(c.cls, c.pkg), owner = packages.get(c.pkg), node = owner?.components[kind].get(name);
  if (!owner || !node || !visibleComponent(name, node, flags, owner)) throw nameNotFound(c.pkg + "/" + name);
  return [name, node, owner];
}
function getServiceInfo(component: JComponentName, flags: number): JServiceInfo {
  const [name, node, owner] = lookupComponent(component, "service", flags);
  return serviceInfo(name, node, flags, owner);
}
function queryComponents(intent: JIntent | null, flags: number, kind: Exclude<ComponentKind, "provider"> = "service"): JList {
  const result = newArrayList();
  if (!intent) return result;
  for (const owner of packages.values()) {
    const pkg = owner.pkg;
    if (intent.pkg && intent.pkg !== pkg || intent.componentPkg && intent.componentPkg !== pkg) continue;
    for (const [name, node] of owner.components[kind]) {
    if (!visibleComponent(name, node, flags, owner)) continue;
    let priority = 0;
    if (intent.component) { if (qualifyComponent(intent.component, pkg) !== name) continue; }
    else {
      const filters = node.children.filter((filter) => filter.name === "intent-filter" && matchesIntentFilter(filter, intent, !!(flags & 0x10000)));
      if (!filters.length) continue;
      priority = Math.max(...filters.map((filter) => attr(filter, "priority")?.data ?? 0));
    }
    const info = rt.make("android/content/pm/ResolveInfo");
    if (kind === "activity") info.activityInfo = mkActivityInfo(name, flags, owner);
    else if (kind === "receiver") info.activityInfo = receiverInfo(name, node, flags, owner);
    else info.serviceInfo = serviceInfo(name, node, flags, owner);
    info.priority = priority;
    result.a.push(info);
    }
  }
  result.a.sort((a, b) => (b as { priority: number }).priority - (a as { priority: number }).priority);
  return result;
}

class JInstallSourceInfo extends JObj {}
rt.register({
  name: "android/content/pm/InstallSourceInfo", ctor: JInstallSourceInfo, ifaces: ["android/os/Parcelable"],
  // APK loading has no Android installer of record or installer-supplied source metadata.
  methods: {
    ...stubs(null, "getInitiatingPackageName()Ljava/lang/String;",
      "getInitiatingPackageSigningInfo()Landroid/content/pm/SigningInfo;",
      "getOriginatingPackageName()Ljava/lang/String;", "getInstallingPackageName()Ljava/lang/String;",
      "getUpdateOwnerPackageName()Ljava/lang/String;"),
    ...stubs(0, "getPackageSource()I", "describeContents()I"),
  },
});
class JApkChecksum extends JObj {
  splitName: string | null = null;
  type = 0;
  value = new Int8Array(0);
  installerPackageName: string | null = null;
}
rt.register({
  name: "android/content/pm/Checksum", ctor: class extends JObj {}, ifaces: ["android/os/Parcelable"],
  statics: {
    TYPE_WHOLE_MERKLE_ROOT_4K_SHA256: 1, TYPE_WHOLE_MD5: 2, TYPE_WHOLE_SHA1: 4, TYPE_WHOLE_SHA256: 8,
    TYPE_WHOLE_SHA512: 16, TYPE_PARTIAL_MERKLE_ROOT_1M_SHA256: 32, TYPE_PARTIAL_MERKLE_ROOT_1M_SHA512: 64,
  },
});
rt.register({
  name: "android/content/pm/ApkChecksum", ctor: JApkChecksum, ifaces: ["android/os/Parcelable"],
  methods: {
    "getSplitName()Ljava/lang/String;": function (this: JApkChecksum) { return this.splitName; },
    "getType()I": function (this: JApkChecksum) { return this.type; },
    "getValue()[B": function (this: JApkChecksum) { return this.value; },
    "getInstallerPackageName()Ljava/lang/String;": function (this: JApkChecksum) { return this.installerPackageName; },
    "getInstallerCertificate()Ljava/security/cert/Certificate;": () => null,
    "describeContents()I": () => 0,
  },
});
rt.markers("android/content/pm/PackageManager$OnChecksumsReadyListener");

const wholeChecksumAlgorithms: readonly [number, string][] = [[2, "MD5"], [4, "SHA-1"], [8, "SHA-256"]];
async function apkChecksums(pkg: string, includeSplits: boolean, required: number): Promise<JList> {
  if (!packages.has(pkg)) await installedPackage(pkg);
  const record = packages.get(pkg);
  if (!record) throw nameNotFound(pkg);
  const files: [string | null, string][] = [[null, record.path]];
  if (includeSplits && pkg === appHost?.pkg) files.push(...appHost.splits.map((name): [string, string] => [name, apkPath(name)]));
  const result = newArrayList();
  for (const [splitName, path] of files) {
    const bytes = await vfs.readFile(path);
    if (!bytes) continue;
    for (const [type, algorithm] of wholeChecksumAlgorithms) {
      if (!(required & type)) continue;
      const value = await digestBytes(algorithm, bytes);
      if (value) result.a.push(Object.assign(new JApkChecksum(), { splitName, type, value: new Int8Array(value) }));
    }
    if (required & 16) {
      const value = new Uint8Array(await crypto.subtle.digest("SHA-512", bytes.slice()));
      result.a.push(Object.assign(new JApkChecksum(), { splitName, type: 16, value: new Int8Array(value) }));
    }
  }
  return result;
}
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
    FEATURE_LOCATION_GPS: "android.hardware.location.gps", FEATURE_LOCATION_NETWORK: "android.hardware.location.network", FEATURE_MICROPHONE: "android.hardware.microphone", FEATURE_WIFI: "android.hardware.wifi", FEATURE_BLUETOOTH: "android.hardware.bluetooth",
    FEATURE_VR_MODE: "android.software.vr.mode", FEATURE_TELEPHONY: "android.hardware.telephony", FEATURE_LEANBACK: "android.software.leanback" },
  methods: {
    "requestChecksums(Ljava/lang/String;ZILjava/util/List;Landroid/content/pm/PackageManager$OnChecksumsReadyListener;)V":
      async (pkg: string | null, includeSplits: number, required: number, trustedInstallers: unknown, listener: unknown) => {
        if (pkg === null || trustedInstallers === null || listener === null) throw rt.mkThrowable("java/lang/NullPointerException", null);
        const checksums = await apkChecksums(pkg, includeSplits !== 0, required);
        await vcall(listener, "onChecksumsReady", "(Ljava/util/List;)V", checksums);
      },
    "getProviderInfo(Landroid/content/ComponentName;I)Landroid/content/pm/ProviderInfo;": (comp: JComponentName, flags: number) => {
      const [cls, node, owner] = lookupComponent(comp, "provider", flags);
      return providerInfo(cls, comp.pkg, authoritiesOf(node).join(";"), node, flags, owner);
    },
    "getResourcesForApplication(Ljava/lang/String;)Landroid/content/res/Resources;": async function (pkg: string) {
      const info = await vcall(this, "getApplicationInfo", "(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;", pkg, 0);
      return vcall(this, "getResourcesForApplication", "(Landroid/content/pm/ApplicationInfo;)Landroid/content/res/Resources;", info);
    },
    "getResourcesForApplication(Landroid/content/pm/ApplicationInfo;)Landroid/content/res/Resources;": async (info: JApplicationInfo) => {
      const res = info.archiveResources ?? (info.packageName === appHost?.pkg ? appHost.res : (await installedPackage(info.packageName))?.archive.res);
      if (!res) throw nameNotFound(info.packageName);
      return res.jobj ?? mkJResources(res, false);
    },
    "getXml(Ljava/lang/String;ILandroid/content/pm/ApplicationInfo;)Landroid/content/res/XmlResourceParser;": async (pkg: string, id: number, info: JApplicationInfo | null) => {
      const res = info?.archiveResources ?? (pkg === appHost?.pkg ? appHost.res : (await installedPackage(pkg))?.archive.res);
      if (!res) return null;
      try { return mkXmlParser(res, id); }
      catch (error) { if (error instanceof rt.link("android/content/res/Resources$NotFoundException").ctor) return null; throw error; }
    },
    "getDrawable(Ljava/lang/String;ILandroid/content/pm/ApplicationInfo;)Landroid/graphics/drawable/Drawable;": async (pkg: string, id: number, info: JApplicationInfo | null) => {
      const res = info?.archiveResources ?? (pkg === appHost?.pkg ? appHost.res : (await installedPackage(pkg))?.archive.res);
      return res?.tbl(id)?.entry(id) ? loadDrawable(res, id, null) : null;
    },
    "getDefaultActivityIcon()Landroid/graphics/drawable/Drawable;": () => {
      const res = appHost?.res, id = res?.idFor("drawable", "sym_def_app_icon", "android");
      if (!res || !id) throw rt.mkThrowable("android/content/res/Resources$NotFoundException", "Default application icon");
      return loadDrawable(res, id, null);
    },
    "getReceiverInfo(Landroid/content/ComponentName;I)Landroid/content/pm/ActivityInfo;": (component: JComponentName, flags: number) => {
      const [name, node, owner] = lookupComponent(component, "receiver", flags);
      return receiverInfo(name, node, flags, owner);
    },
    "getServiceInfo(Landroid/content/ComponentName;I)Landroid/content/pm/ServiceInfo;": getServiceInfo,
    "getServiceInfo(Landroid/content/ComponentName;Landroid/content/pm/PackageManager$ComponentInfoFlags;)Landroid/content/pm/ServiceInfo;": (c: JComponentName, f: JInfoFlags) => getServiceInfo(c, Number(f.value)),
    // API 33's boxed-long overloads carry the same flags to the same body, never a second one
    "getPackageInfo(Ljava/lang/String;Landroid/content/pm/PackageManager$PackageInfoFlags;)Landroid/content/pm/PackageInfo;": async function (pkg: string, f: JInfoFlags | null) {
      return vcall(this, "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", pkg, Number(f?.value ?? 0n));
    },
    "getPackageInfo(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;": async function (pkg: string, flags: number) {
      const record = packages.get(pkg);
      if (record && (record !== currentPackage || record.system)) return recordInfo(record, flags);
      const installed = await installedPackage(pkg);
      if (installed) return archiveInfo(installed.archive, installed.path, flags, true);
      if (appHost && pkg !== appHost.pkg) throw nameNotFound(pkg);
      const pi = new JPackageInfo();
      pi.packageName = pkg;
      pi.applicationInfo = appHost ? getAppInfo(appHost) : null;
      if (manifestRoot && appHost) fillPackageManifest(pi, manifestRoot, appHost.res, flags);
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
      if (flags & 0x1000) await fillRequestedPermissions(pi);
      if (flags & 2) pi.receivers = jarray([...manifestReceivers].filter(([name, node]) => visibleComponent(name, node, flags)).map(([name, node]) => receiverInfo(name, node, flags)), "Landroid/content/pm/ActivityInfo;");
      if (flags & 4) pi.services = jarray([...manifestServices].filter(([name, node]) => visibleComponent(name, node, flags)).map(([name, node]) => serviceInfo(name, node, flags)), "Landroid/content/pm/ServiceInfo;");
      if (flags & 1) pi.activities = jarray([...manifestActivities].filter(([name, node]) => visibleComponent(name, node, flags)).map(([name]) => mkActivityInfo(name.replace(/\//g, "."), flags)), "Landroid/content/pm/ActivityInfo;");
      return pi;
    },
    "getApplicationInfo(Ljava/lang/String;Landroid/content/pm/PackageManager$ApplicationInfoFlags;)Landroid/content/pm/ApplicationInfo;": async function (pkg: string, f: JInfoFlags | null) {
      return vcall(this, "getApplicationInfo", "(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;", pkg, Number(f?.value ?? 0n));
    },
    "getApplicationInfo(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;": async function (pkg: string, flags: number) {
      const record = packages.get(pkg);
      if (record && (record !== currentPackage || record.system)) return recordAppInfo(record, flags);
      const installed = await installedPackage(pkg);
      if (installed) return (await archiveInfo(installed.archive, installed.path, flags, true)).applicationInfo;
      if (appHost && pkg !== appHost.pkg) throw nameNotFound(pkg);
      return appHost ? getAppInfo(appHost) : new JApplicationInfo();
    },
    "getApplicationLabel(Landroid/content/pm/ApplicationInfo;)Ljava/lang/CharSequence;": applicationLabel,
    "getApplicationIcon(Landroid/content/pm/ApplicationInfo;)Landroid/graphics/drawable/Drawable;": function (info: JApplicationInfo) {
      return vcall(info, "loadIcon", "(Landroid/content/pm/PackageManager;)Landroid/graphics/drawable/Drawable;", this);
    },
    "getApplicationIcon(Ljava/lang/String;)Landroid/graphics/drawable/Drawable;": async function (pkg: string) {
      const info = await vcall(this, "getApplicationInfo", "(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;", pkg, 0x400);
      return vcall(this, "getApplicationIcon", "(Landroid/content/pm/ApplicationInfo;)Landroid/graphics/drawable/Drawable;", info);
    },
    "getPackageArchiveInfo(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;": async (path: string, flags: number) => { const archive = await readArchive(path); return archive ? archiveInfo(archive, path, flags) : null; },
    "getPackageArchiveInfo(Ljava/lang/String;Landroid/content/pm/PackageManager$PackageInfoFlags;)Landroid/content/pm/PackageInfo;": async (path: string, flags: JInfoFlags) => { const archive = await readArchive(path); return archive ? archiveInfo(archive, path, Number(flags.value)) : null; },
    "resolveActivity(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;": resolveActivity,
    "resolveActivity(Landroid/content/Intent;Landroid/content/pm/PackageManager$ResolveInfoFlags;)Landroid/content/pm/ResolveInfo;": (i: JIntent | null, f: JInfoFlags) => resolveActivity(i, Number(f.value)),
    "queryIntentActivities(Landroid/content/Intent;I)Ljava/util/List;": queryActivities,
    "queryIntentActivities(Landroid/content/Intent;Landroid/content/pm/PackageManager$ResolveInfoFlags;)Ljava/util/List;": (i: JIntent, f: JInfoFlags) => queryActivities(i, Number(f.value)),
    "queryIntentContentProviders(Landroid/content/Intent;I)Ljava/util/List;": queryProviders,
    "queryIntentContentProviders(Landroid/content/Intent;Landroid/content/pm/PackageManager$ComponentInfoFlags;)Ljava/util/List;": (i: { action?: string | null } | null, flags: JInfoFlags) => queryProviders(i, Number(flags.value)),
    "resolveContentProvider(Ljava/lang/String;I)Landroid/content/pm/ProviderInfo;": resolveProvider,
    "resolveContentProvider(Ljava/lang/String;Landroid/content/pm/PackageManager$ComponentInfoFlags;)Landroid/content/pm/ProviderInfo;": (a: string, flags: JInfoFlags) => resolveProvider(a, Number(flags.value)),
    "queryBroadcastReceivers(Landroid/content/Intent;I)Ljava/util/List;": (i: JIntent, f: number) => queryComponents(i, f, "receiver"),
    "queryBroadcastReceivers(Landroid/content/Intent;Landroid/content/pm/PackageManager$ResolveInfoFlags;)Ljava/util/List;": (i: JIntent, f: JInfoFlags) => queryComponents(i, Number(f.value), "receiver"),
    "queryIntentServices(Landroid/content/Intent;I)Ljava/util/List;": queryComponents,
    "queryIntentServices(Landroid/content/Intent;Landroid/content/pm/PackageManager$ResolveInfoFlags;)Ljava/util/List;": (i: JIntent, f: JInfoFlags) => queryComponents(i, Number(f.value)),
    "resolveService(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;": (i: JIntent, f: number) => queryComponents(i, f).a[0] ?? null,
    "resolveService(Landroid/content/Intent;Landroid/content/pm/PackageManager$ResolveInfoFlags;)Landroid/content/pm/ResolveInfo;": (i: JIntent, f: JInfoFlags) => queryComponents(i, Number(f.value)).a[0] ?? null,
    "getComponentEnabledSetting(Landroid/content/ComponentName;)I": (c: JComponentName) => componentState.get(c),
    "getApplicationEnabledSetting(Ljava/lang/String;)I": (pkg: string) => {
      if (!packages.has(pkg)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown package " + pkg);
      return 0;
    },
    "setComponentEnabledSetting(Landroid/content/ComponentName;II)V": (c: JComponentName, st: number) => componentState.set(c, st),
    "hasSystemFeature(Ljava/lang/String;)Z": (name: string) => device.features.includes(name) ? 1 : 0,
    "hasSystemFeature(Ljava/lang/String;I)Z": (name: string) => device.features.includes(name) ? 1 : 0,
    "getSystemAvailableFeatures()[Landroid/content/pm/FeatureInfo;": () =>
      jarray(device.features.map((name) => Object.assign(new JFeatureInfo(), { name })), "Landroid/content/pm/FeatureInfo;"),
    "getSystemSharedLibraryNames()[Ljava/lang/String;": () => jarray([], "Ljava/lang/String;"),
    "getPermissionInfo(Ljava/lang/String;I)Landroid/content/pm/PermissionInfo;": (name: string, flags: number) => {
      for (const owner of packages.values()) {
        const node = owner.root.children.find((n) => n.name === "permission" && attrStr(n, "name") === name);
        if (!node) continue;
        rt.link("android/content/pm/PermissionInfo");
        const info = new JPermissionInfo(), label = attr(node, "label");
        info.name = name; info.packageName = owner.pkg; info.archiveResources = owner.res;
        info.group = attrStr(node, "permissionGroup");
        info.protectionLevel = attr(node, "protectionLevel")?.data ?? 0;
        info.flags = attr(node, "permissionFlags")?.data ?? 0;
        info.descriptionRes = attr(node, "description")?.data ?? 0;
        info.icon = attr(node, "icon")?.data ?? 0;
        info.labelRes = label?.type === TV.REFERENCE ? label.data : 0;
        info.nonLocalizedLabel = label?.str ?? null;
        info.metaData = flags & 128 ? metaData(node, owner.res) : null;
        return info;
      }
      throw nameNotFound(name);
    },
    "checkPermission(Ljava/lang/String;Ljava/lang/String;)I": async (permission: string, pkg: string) => {
      const record = packages.get(pkg);
      if (record?.grants.has(permission)) return 0;
      if (!record?.permissions.has(permission)) return -1;
      if (!signaturePermissions.has(permission)) return 0;
      const certificates = await record.certificates();
      for (const owner of packages.values()) {
        if (!owner.root.children.some((n) => n.name === "permission" && attrStr(n, "name") === permission)) continue;
        const signers = await owner.certificates();
        if (certificates.length && certificates.length === signers.length && certificates.every((c, i) => c.length === signers[i].length && c.every((b, j) => b === signers[i][j]))) return 0;
      }
      return -1;
    },
    "getInstallSourceInfo(Ljava/lang/String;)Landroid/content/pm/InstallSourceInfo;": (pkg: string) => {
      if (!appHost || pkg !== appHost.pkg) throw nameNotFound(pkg);
      return new JInstallSourceInfo();
    },
    "getPackageInstaller()Landroid/content/pm/PackageInstaller;": getPackageInstaller,
    ...stubs(null, "getInstallerPackageName(Ljava/lang/String;)Ljava/lang/String;"),
    ...stubs(1, "canRequestPackageInstalls()Z"),
    ...stubs(0, "isInstantApp()Z", "isInstantApp(Ljava/lang/String;)Z", "isPackageSuspended()Z"),
    "getNameForUid(I)Ljava/lang/String;": (uid: number) => [...packages.values()].find((p) => p.uid === uid)?.pkg ?? null,
    "getPackagesForUid(I)[Ljava/lang/String;": (uid: number) => {
      const names = [...packages.values()].filter((p) => p.uid === uid).map((p) => p.pkg);
      return names.length ? jarray(names, "Ljava/lang/String;") : null;
    },
    "getPackageUid(Ljava/lang/String;I)I": (pkg: string) => {
      const record = packages.get(pkg);
      if (!record) throw nameNotFound(pkg);
      return record.uid;
    },
    "checkSignatures(Ljava/lang/String;Ljava/lang/String;)I": async (a: string, b: string) => {
      const x = packages.get(a), y = packages.get(b);
      if (!x || !y) return -4;
      const left = await x.visibleCertificates(), right = await y.visibleCertificates();
      if (!left.length || !right.length) return !left.length && !right.length ? 1 : !left.length ? -1 : -2;
      return left.length === right.length && left.every((cert) => right.some((other) => cert.length === other.length && cert.every((v, i) => v === other[i]))) ? 0 : -3;
    },
    "getInstalledPackages(I)Ljava/util/List;": installedPackages,
    "getInstalledApplications(I)Ljava/util/List;": async (flags: number) => {
      const list = await installedPackages(flags);
      list.a = list.a.map(info => (info as JPackageInfo).applicationInfo);
      return list;
    },
    "getInstalledPackages(Landroid/content/pm/PackageManager$PackageInfoFlags;)Ljava/util/List;": (flags: JInfoFlags) => installedPackages(Number(flags.value)),
    "getActivityInfo(Landroid/content/ComponentName;I)Landroid/content/pm/ActivityInfo;": (comp: JComponentName, flags: number) => {
      const [name, , owner] = lookupComponent(comp, "activity", flags);
      return mkActivityInfo(name, flags, owner);
    },
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
function mkActivityInfo(cls: string, flags: number, owner = currentPackage): JActivityInfo {
  const node = owner?.components.activity.get(cls.replace(/\//g, "."));
  const a = new JActivityInfo();
  if (node) componentInfo(a, cls, node, flags, owner);
  a.theme = (node && attr(node, "theme")?.data) ?? appHost?.themeResId ?? 0;
  a.configChanges = (node && attr(node, "configChanges")?.data) ?? 0;
  a.screenOrientation = (node && attr(node, "screenOrientation")?.data) ?? -1;
  a.parentActivityName = node ? attrStr(node, "parentActivityName") : null;
  return a;
}

class JShortcutInfo extends JObj {
  id = ""; pkg = ""; shortLabel = ""; longLabel: string | null = null; disabledMessage: string | null = null;
  intents: JIntent[] = []; icon: unknown = null; extras: JBundle | null = null;
  rank = 0; excluded = 0; longLived = false; dynamic = false;
}
async function copyShortcut(info: JShortcutInfo): Promise<JShortcutInfo> {
  const copy = Object.assign(rt.make("android/content/pm/ShortcutInfo"), info);
  copy.intents = await Promise.all(info.intents.map((intent) => newObj("android/content/Intent", "(Landroid/content/Intent;)V", intent)));
  if (info.extras) {
    copy.extras = Object.assign(rt.make("android/os/PersistableBundle"), info.extras);
    copy.extras.map = new Map(info.extras.map);
  }
  return copy;
}
rt.register({
  name: "android/content/pm/ShortcutInfo", ctor: JShortcutInfo, ifaces: ["android/os/Parcelable"],
  statics: { SURFACE_LAUNCHER: 1 },
  methods: {
    "getExtras()Landroid/os/PersistableBundle;": async function (this: JShortcutInfo) { return (await copyShortcut(this)).extras; },
    "getIntent()Landroid/content/Intent;": async function (this: JShortcutInfo) { return (await copyShortcut(this)).intents.at(-1) ?? null; },
    "getIntents()[Landroid/content/Intent;": async function (this: JShortcutInfo) { return jarray((await copyShortcut(this)).intents, "Landroid/content/Intent;"); },
    ...fieldGetters({ "getId()Ljava/lang/String;": "id", "getPackage()Ljava/lang/String;": "pkg",
      "getShortLabel()Ljava/lang/CharSequence;": "shortLabel", "getLongLabel()Ljava/lang/CharSequence;": "longLabel",
      "getDisabledMessage()Ljava/lang/CharSequence;": "disabledMessage", "getRank()I": "rank" }),
    ...flagGetters({ "isDynamic()Z": "dynamic", "isLongLived()Z": "longLived" }),
    "isExcludedFromSurfaces(I)Z": function (this: JShortcutInfo, surfaces: number) { return this.excluded & surfaces ? 1 : 0; },
    ...stubs(0, "isPinned()Z", "isDeclaredInManifest()Z"),
    ...stubs(1, "isEnabled()Z"),
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
    "getPinnedShortcuts()Ljava/util/List;": () => newArrayList(),
    "getShortcuts(I)Ljava/util/List;": async function (this: JShortcutManager, flags: number) {
      const list = newArrayList();
      if (flags & 2) list.a = await Promise.all([...(this.packages.get(appHost?.pkg ?? "")?.values() ?? [])].map(copyShortcut));
      return list;
    },
    "removeAllDynamicShortcuts()V": function (this: JShortcutManager) { this.packages.delete(appHost?.pkg ?? ""); },
    "getMaxShortcutCountPerActivity()I": () => 15,
    "isRateLimitingActive()Z": () => 0,
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
  const packed = packedArchives.get(path);
  if (packed) return packageArchive(packed.zip, packed.index.certificates.map(hexBytes));
  const bytes = await vfs.readFile(path);
  if (!bytes) return null;
  let archive = archiveCache.get(bytes);
  if (!archive) archiveCache.set(bytes, archive = parsePackageArchive(bytes));
  try { return await archive; } catch { return null; }
}
async function archiveInfo(archive: PackageArchive, path: string, flags: number, installed = false): Promise<JPackageInfo> {
  const { root, pkg, res, certificates } = archive;
  const app = root.children.find((c) => c.name === "application");
  rt.link("android/content/pm/PackageInfo"); rt.link("android/content/pm/ApplicationInfo");
  const info = new JPackageInfo(), ai = appInfoFrom(new JApplicationInfo(), pkg, path, res, root, app, flags);
  info.packageName = pkg;
  ai.processName = pkg;
  ai.className = app && attrStr(app, "name") || null;
  info.applicationInfo = ai; info.reqFeatures = reqFeatures(root);
  fillPackageManifest(info, root, res, flags);
  if (flags & 0x1000) await fillRequestedPermissions(info, root, installed);
  if (flags & 64) info.signatures = signatures(certificates);
  if (flags & 0x8000000) info.signingInfo = signingInfo(certificates);
  return info;
}
export const installedPath = (pkg: string) => `/data/app/${pkg}/base.apk`;
export function registerPackage(archive: PackageArchive, path = installedPath(archive.pkg), uid = packageUid(archive.pkg)): PackageRecord {
  const record = new PackageRecord(archive.root, archive.res, path, uid, () => Promise.resolve(archive.certificates));
  packages.set(record.pkg, record);
  for (const node of archive.root.children) if (node.name === "permission" && ((attr(node, "protectionLevel")?.data ?? 0) & 3) >= 2) {
    const name = attrStr(node, "name");
    if (name) signaturePermissions.add(name);
  }
  return record;
}
/** <uses-sdk>: targetSdkVersion defaults to minSdkVersion, which defaults to 1 */
export function usesSdk(root: XmlNode): { min: number; target: number } {
  const sdk = root.children.find((c) => c.name === "uses-sdk");
  const min = sdk && attr(sdk, "minSdkVersion")?.data || 1;
  return { min, target: sdk && attr(sdk, "targetSdkVersion")?.data || min };
}
function appInfoFrom(ai: JApplicationInfo, pkg: string, path: string, res: Resources, root: XmlNode, app: XmlNode | null | undefined, flags: number) {
  ai.packageName = pkg; ai.sourceDir = ai.publicSourceDir = path; ai.dataDir = `/data/data/${pkg}`; ai.archiveResources = res;
  ai.deviceProtectedDataDir = `/data/user_de/0/${pkg}`;
  fillManifestGameInfo(ai, app);
  const label = app && attr(app, "label");
  ai.labelRes = label?.type === TV.REFERENCE ? label.data : 0;
  ai.nonLocalizedLabel = label?.str ?? null;
  ai.icon = app && attr(app, "icon")?.data || 0;
  const sdk = usesSdk(root);
  ai.minSdkVersion = sdk.min;
  ai.targetSdkVersion = sdk.target;
  if (flags & 128) ai.metaData = metaData(app, res);
  return ai;
}
function fillManifestGameInfo(ai: JApplicationInfo, app: XmlNode | null | undefined): void {
  ai.category = app ? attr(app, "appCategory")?.data ?? -1 : -1;
  if (app && attr(app, "isGame")?.data) ai.flags |= FLAG_IS_GAME;
}
function fillPackageManifest(info: JPackageInfo, root: XmlNode, res: Resources, flags: number) {
  info.versionCode = attr(root, "versionCode")?.data ?? 0;
  info.longVersionCode = BigInt(info.versionCode >>> 0) | BigInt(attr(root, "versionCodeMajor")?.data ?? 0) << 32n;
  const version = attr(root, "versionName");
  info.versionName = version?.type === TV.REFERENCE ? resString(res, version.data) : version?.str ?? "";
  info.installLocation = attr(root, "installLocation")?.data ?? -1;
  if (flags & 16) {
    const nodes = root.children.filter(node => node.name === "instrumentation");
    if (nodes.length) info.instrumentation = jarray(nodes.map(node => {
      const item = new JInstrumentationInfo();
      item.name = qualifyComponent(attrStr(node, "name") ?? "", info.packageName); item.packageName = info.packageName;
      item.targetPackage = attrStr(node, "targetPackage") ?? ""; item.targetProcesses = attrStr(node, "targetProcesses") ?? null;
      item.handleProfiling = attr(node, "handleProfiling")?.data ? 1 : 0; item.functionalTest = attr(node, "functionalTest")?.data ? 1 : 0;
      item.sourceDir = item.publicSourceDir = info.applicationInfo?.sourceDir ?? ""; item.dataDir = info.applicationInfo?.dataDir ?? "";
      if (flags & 128) item.metaData = metaData(node, res);
      return item;
    }), "Landroid/content/pm/InstrumentationInfo;");
  }
}
function recordAppInfo(record: PackageRecord, flags = 0): JApplicationInfo {
  const app = record.application;
  const ai = appInfoFrom(new JApplicationInfo(), record.pkg, record.path, record.res, record.root, app, flags);
  ai.uid = record.uid; ai.processName = app ? record.process(app) : record.pkg;
  ai.enabled = record.enabled ? 1 : 0;
  if (record.system) ai.flags |= 1;
  ai.theme = app && attr(app, "theme")?.data || 0;
  const cls = app && attrStr(app, "name");
  ai.className = cls ? qualifyComponent(cls, record.pkg) : null;
  return ai;
}
async function recordInfo(record: PackageRecord, flags: number): Promise<JPackageInfo> {
  const pi = new JPackageInfo(), root = record.root;
  pi.packageName = record.pkg;
  pi.applicationInfo = recordAppInfo(record, flags);
  fillPackageManifest(pi, root, record.res, flags);
  pi.firstInstallTime = pi.lastUpdateTime = installTime(record.pkg);
  if (flags & 64) pi.signatures = signatures(await record.visibleCertificates());
  if (flags & 0x8000000) pi.signingInfo = signingInfo(await record.visibleCertificates());
  pi.reqFeatures = reqFeatures(root);
  if (flags & 0x1000) await fillRequestedPermissions(pi, root);
  if (flags & 1) pi.activities = jarray([...record.components.activity].filter(([n, node]) => visibleComponent(n, node, flags, record)).map(([n]) => mkActivityInfo(n, flags, record)), "Landroid/content/pm/ActivityInfo;");
  if (flags & 2) pi.receivers = jarray([...record.components.receiver].filter(([n, node]) => visibleComponent(n, node, flags, record)).map(([n, node]) => receiverInfo(n, node, flags, record)), "Landroid/content/pm/ActivityInfo;");
  if (flags & 4) pi.services = jarray([...record.components.service].filter(([n, node]) => visibleComponent(n, node, flags, record)).map(([n, node]) => serviceInfo(n, node, flags, record)), "Landroid/content/pm/ServiceInfo;");
  return pi;
}
async function installedPackage(pkg: string) {
  await restorePackages();
  const path = installedPath(pkg), archive = await readArchive(path);
  if (archive && !packages.has(pkg)) registerPackage(archive, path);
  return archive ? { path, archive } : null;
}
async function installedPackages(flags: number): Promise<JList> {
  const thread = curThread;
  await restorePackages();
  const result = newArrayList();
  for (const path of vfs.files.keys()) {
    if (!/^\/data\/app\/[^/]+\/base\.apk$/.test(path)) continue;
    const archive = await readArchive(path);
    if (archive && !packages.has(archive.pkg)) registerPackage(archive, path);
  }
  for (const record of packages.values()) result.a.push(await vcallOn(thread, getPM(), "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", record.pkg, flags));
  return result;
}
export async function installPackageArchive(bytes: Uint8Array, expectedPackage: string | null = null): Promise<string> {
  await verifyApkSignature(bytes);
  const archive = await parsePackageArchive(bytes);
  if (expectedPackage && expectedPackage !== archive.pkg) throw new Error("Session package name differs from APK");
  if (archive.pkg === appHost?.pkg) throw new Error("Replacing the running package is unsupported");
  if (!archive.certificates.length) throw new Error("APK is unsigned");
  const previous = await installedPackage(archive.pkg);
  if (previous && (await archiveInfo(archive, "", 0)).longVersionCode < (await archiveInfo(previous.archive, previous.path, 0)).longVersionCode)
    throw new Error("APK version is older than installed package");
  if (previous && (previous.archive.certificates.length !== archive.certificates.length || previous.archive.certificates.some((cert, i) => {
    const next = archive.certificates[i]; return !next || cert.length !== next.length || cert.some((b, j) => b !== next[j]);
  }))) throw new Error("APK signing certificate differs from installed package");
  await persistPackage(installedPath(archive.pkg), bytes);
  vfs.write(installedPath(archive.pkg), bytes);
  registerPackage(archive);
  return archive.pkg;
}
