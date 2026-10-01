// IPackageManager and IPermissionManager, under AOSP's ApplicationPackageManager, PermissionManager
// and the android.content.pm data classes, answered from the package registry (packages.ts) as
// PackageManagerService's ComputerEngine answers from its parsed packages. The registry-level
// queries are exported for the shell, which plays system_server's part in resolving intents,
// providers and permissions. Intents and component names are read through their Java API only.
import { JObj, rt, noops, declaredField, driven, type Gen } from "../jvm/runtime";
import { jarray, hexBytes, sameBytes } from "../jvm/abi";
import { device } from "../shell/config";
import { uuidDefault, type JBundle } from "./os";
import { vcall, scall, construct, after } from "../jvm/natives/jlang";
import { type XmlNode, attrStr, attr, TV } from "./axml";
import { normRV, resString, type Resources } from "./res";
import { apkCertificates, parsePackageArchive, packageArchive, type PackageArchive } from "./packagearchive";
import { packedArchives } from "../shell/packedarchive";
import { verifyApkSignature } from "./apksignature";
import { persistPackage, restorePackages } from "../shell/packages";
import { appHost } from "./apphost";
import { vfs, apkPath } from "../shell/vfs";
import { DOCS_AUTHORITY } from "./documents";
import { newArrayList } from "../jvm/natives/jcoll";
import { systemActivity, SYSTEM_ACTIVITY, intentQuery$, type IntentQuery } from "./intent";
import { intentTarget$, manifestFilter$, matches$ } from "./intent-filter";
import { PackageRecord, packages, packageUid, qualifyComponent, signaturePermissions, componentState, installTime, type ComponentKind } from "./packages";
import { digestBytes } from "../jvm/natives/digest";
import { hostStub, hostedService } from "./binder";
import { permissionGranted } from "./context";
import { installerService } from "./packageinstaller";
import { javaResources, loadResources } from "./resources";

const PKG = "android/content/pm/";
const COMPONENT = PKG + "ComponentInfo", APP = PKG + "ApplicationInfo", ACTIVITY = PKG + "ActivityInfo";
const SERVICE = PKG + "ServiceInfo", PROVIDER = PKG + "ProviderInfo", PACKAGE = PKG + "PackageInfo", RESOLVE = PKG + "ResolveInfo";

/** sets `cls`'s instance fields (declared there or inherited) on a bytecode object */
function put(o: JObj, cls: string, values: Record<string, unknown>): void {
  const fields = o as unknown as Record<string, unknown>;
  for (const name in values) {
    const prop = declaredField(cls, name);
    if (!prop) throw new Error(`${cls}.${name} is not a field`);
    fields[prop] = values[name];
  }
}
export const field = <T = unknown>(o: unknown, cls: string, name: string): T => (o as Record<string, T>)[declaredField(cls, name)]!;
/** a copy for a caller that may mutate it, as each binder reply is (Object.clone's) */
const copy = <T extends object>(o: T): T => Object.assign(Object.create(Object.getPrototypeOf(o)), o);

// PackageManager flags, as IPackageManager receives them
const GET_ACTIVITIES = 1, GET_RECEIVERS = 2, GET_SERVICES = 4, GET_PROVIDERS = 8, GET_INSTRUMENTATION = 16, GET_SIGNATURES = 64;
const GET_META_DATA = 0x80, GET_SHARED_LIBRARY_FILES = 0x400, GET_PERMISSIONS = 0x1000, GET_CONFIGURATIONS = 0x4000;
const MATCH_DISABLED_COMPONENTS = 0x200, MATCH_DEFAULT_ONLY = 0x10000, MATCH_DIRECT_BOOT_UNAWARE = 0x40000, MATCH_DIRECT_BOOT_AWARE = 0x80000;
const MATCH_SYSTEM_ONLY = 0x100000, GET_SIGNING_CERTIFICATES = 0x8000000;
export const FLAG_IS_GAME = 0x02000000;
/** the GLES version the WebGL2 context offers, which getSystemAvailableFeatures and ConfigurationInfo report */
export const GL_ES_VERSION = 0x30000;

// ── the booted package
let currentPackage: PackageRecord | null = null;
/** registers the package this process booted from its manifest, at /data/app/base.apk */
export function setManifest(root: XmlNode): void {
  const pkg = attrStr(root, "package") ?? "";
  if (currentPackage && packages.get(currentPackage.pkg) === currentPackage) packages.delete(currentPackage.pkg);
  loadedInfos.clear();
  if (!appHost) return;
  const host = appHost;
  currentPackage = packages.get(pkg) ?? new PackageRecord(root, host.res, apkPath(), packageUid(pkg), async () => {
    const bytes = await vfs.readFile(apkPath());
    return bytes ? cachedCertificates(bytes, host.zip) : [];
  });
  packages.set(pkg, currentPackage);
}
/** an attribute of the booted package's <activity> for a dotted or slashed class name */
function activityAttr(cls: string, name: string): number | undefined {
  const node = currentPackage?.components.activity.get(cls.replace(/\//g, "."));
  return node && attr(node, name)?.data;
}
/** The activity's own `android:theme`, or 0 when it just inherits the application's. */
export const manifestActivityTheme = (cls: string): number => activityAttr(cls, "theme") ?? 0;
export const manifestActivityOrientation = (cls: string): number => activityAttr(cls, "screenOrientation") ?? -1;
/** ActivityInfo.launchMode: LAUNCH_MULTIPLE (0) unless the manifest names another */
export const manifestLaunchMode = (cls: string): number => activityAttr(cls, "launchMode") ?? 0;
/** ActivityInfo.taskAffinity: the activity's own, else the application's, else the package name */
export function manifestTaskAffinity(cls: string): string {
  const record = currentPackage, node = record?.components.activity.get(cls.replace(/\//g, "."));
  return (node && attrStr(node, "taskAffinity")) ?? (record?.application && attrStr(record.application, "taskAffinity")) ?? record?.pkg ?? "";
}
/** ActivityInfo.CONFIG_UI_MODE: an activity that declares it handles a day/night change is told
 *  about it; one that does not is relaunched, which is the whole of AppCompat's day/night switch. */
export const CONFIG_UI_MODE = 0x0200;
export const activityHandlesConfig = (cls: string, bits: number): boolean => ((activityAttr(cls, "configChanges") ?? 0) & bits) === bits;


// ── the parsed manifest, read as ParsingPackageUtils reads it. The Java side is built in generators
// that Runtime.drive runs on the calling thread, synchronously until something suspends.
const resolvedLabel = (node: XmlNode | null | undefined) => {
  const label = node ? attr(node, "label") : undefined;
  return label?.type === TV.REFERENCE ? { labelRes: label.data, nonLocalizedLabel: null } : { labelRes: 0, nonLocalizedLabel: label?.str ?? null };
};
const intAttr = (node: XmlNode | null | undefined, name: string, def: number) => (node ? attr(node, name)?.data : undefined) ?? def;
const make = (cls: string, desc = "()V", ...args: unknown[]) => construct(cls, desc, ...args);
/** <meta-data> children → Bundle, typed the way aapt encoded them (string / boolean / int). */
function* metaData$(node: XmlNode | null | undefined, res: Resources): Gen<JBundle | null> {
  const items = node?.children.filter((md) => md.name === "meta-data") ?? [];
  if (!items.length) return null;
  const bundle: JBundle = yield make("android/os/Bundle");
  const put = (setter: string, desc: string, key: string, value: unknown) => vcall(bundle, setter, `(Ljava/lang/String;${desc})V`, key, value);
  for (const md of items) {
    const key = attrStr(md, "name");
    if (key === null) continue;
    // android:resource stays the id; android:value is read through the app's resources, as the
    // package parser's TypedArray.peekValue resolves references before choosing the setter
    const resource = attr(md, "resource"), raw = attr(md, "value") ?? resource;
    if (!raw) { yield put("putString", "Ljava/lang/String;", key, null); continue; }
    if (resource) { yield put("putInt", "I", key, raw.data); continue; }
    const direct = normRV({ t: raw.type, d: raw.data, s: raw.str ?? undefined });
    const v = direct.t === TV.REFERENCE ? res.resolveRefs(direct) : direct;
    if (v.t === TV.STRING) yield put("putString", "Ljava/lang/String;", key, v.s ?? null);
    else if (v.t === TV.BOOLEAN) yield put("putBoolean", "Z", key, v.d ? 1 : 0);
    else if (v.t === TV.FLOAT) yield put("putFloat", "F", key, new Float32Array(Int32Array.of(v.d).buffer)[0]);
    else yield put("putInt", "I", key, v.d);
  }
  return bundle;
}
const bitsOf = (record: PackageRecord, node: XmlNode | null | undefined, bits: [string, number, boolean][]) =>
  bits.reduce((flags, [name, bit, def]) => record.flag(node, name, def) ? flags | bit : flags, 0);

/** ApplicationInfo.flags: <application>'s attributes and defaults, then the installed state */
function applicationFlags(record: PackageRecord): number {
  const app = record.application, target = record.sdk.target;
  let flags = (record.system ? 1 : 0) | bitsOf(record, app, [
    ["debuggable", 0x2, false], ["hasCode", 0x4, true], ["persistent", 0x8, false], ["allowTaskReparenting", 0x20, false],
    ["allowClearUserData", 0x40, true], ["testOnly", 0x100, false], ["vmSafeMode", 0x4000, false], ["allowBackup", 0x8000, true],
    ["largeHeap", 0x100000, false], ["supportsRtl", 0x400000, false], ["isGame", FLAG_IS_GAME, false],
    ["usesCleartextTraffic", 0x8000000, target < 28], ["extractNativeLibs", 0x10000000, true],
    ["hardwareAccelerated", 0x20000000, target >= 14], ["multiArch", 0x80000000, false],
  ]);
  // the restore policy applies only to an app that names its own backup agent
  if (flags & 0x8000 && app && attrStr(app, "backupAgent"))
    flags |= bitsOf(record, app, [["killAfterRestore", 0x10000, true], ["restoreAnyVersion", 0x20000, false], ["fullBackupOnly", 0x4000000, false]]);
  // <supports-screens>: every size supported from DONUT, xlarge from GINGERBREAD
  flags |= bitsOf(record, record.root.children.find((n) => n.name === "supports-screens"), [["smallScreens", 0x200, target >= 4],
    ["normalScreens", 0x400, true], ["largeScreens", 0x800, target >= 4], ["xlargeScreens", 0x80000, target >= 9],
    ["resizeable", 0x1000, target >= 4], ["anyDensity", 0x2000, target >= 4]]);
  return flags | 0x800000; // FLAG_INSTALLED
}
const RESIZE_MODE_UNRESIZEABLE = 0, RESIZE_MODE_RESIZEABLE_VIA_SDK_VERSION = 1, RESIZE_MODE_RESIZEABLE = 2, RESIZE_MODE_FORCE_RESIZEABLE = 4;
function privateFlags(record: PackageRecord): number {
  const app = record.application, target = record.sdk.target;
  let flags = bitsOf(record, app, [
    ["defaultToDeviceProtectedStorage", 0x20, false], ["directBootAware", 0x40, false], ["backupInForeground", 0x2000, false],
    ["hasFragileUserData", 0x1000000, false], ["allowClearUserDataOnFailedRestore", 0x4000000, true],
    ["allowAudioPlaybackCapture", 0x8000000, target >= 29], ["requestLegacyExternalStorage", 0x20000000, target < 29],
    ["allowNativeHeapPointerTagging", 0x80000000, true],
  ]);
  const resizeable = app && attr(app, "resizeableActivity") ? record.flag(app, "resizeableActivity", true) : null;
  flags |= resizeable === null ? target >= 24 ? 0x1000 : 0 : resizeable ? 0x400 : 0x800;
  if (record.flag(app, "debuggable", false) || app?.children.some((n) => n.name === "profileable" && record.flag(n, "shell", false))) flags |= 0x800000;
  if (!record.flag(app, "directBootAware", false) && Object.values(record.components).some((kind) => [...kind.values()].some((n) => record.flag(n, "directBootAware", false))))
    flags |= 0x100; // PRIVATE_FLAG_PARTIALLY_DIRECT_BOOT_AWARE
  if ([...record.components.activity.values()].some((n) => n.children.some((f) => f.name === "intent-filter" && hasWebLinks(f)))) flags |= 0x10;
  return flags;
}
/** a filter a browser hands web links to: VIEW, BROWSABLE, and an http(s) scheme */
const hasWebLinks = (filter: XmlNode) => {
  const named = (kind: string, value: string) => filter.children.some((n) => n.name === kind && attrStr(n, "name") === value);
  return named("action", "android.intent.action.VIEW") && named("category", "android.intent.category.BROWSABLE") &&
    filter.children.some((n) => n.name === "data" && ["http", "https"].includes(attrStr(n, "scheme") ?? ""));
};
const privateFlagsExt = (record: PackageRecord) => {
  const app = record.application, profileable = app?.children.find((n) => n.name === "profileable");
  return (record.flag(profileable, "enabled", true) ? 1 : 0) | (record.flag(app, "enableOnBackInvokedCallback", false) ? 8 : 0);
};

/** the ApplicationInfo PackageInfoUtils.generateApplicationInfo makes for `flags` */
function* buildApplicationInfo$(record: PackageRecord, flags: number): Gen<JObj> {
  const ai: JObj = yield make(APP), app = record.application, pkg = record.pkg, { min, target } = record.sdk;
  const own = record === currentPackage && appHost?.pkg === pkg ? appHost : null;
  const splits = own?.splits.length ? own.splits : null;
  const qualified = (name: string) => { const value = app && attrStr(app, name); return value ? qualifyComponent(value, pkg) : null; };
  const className = qualified("name");
  put(ai, APP, {
    ...resolvedLabel(app), packageName: pkg, name: className, className,
    icon: intAttr(app, "icon", 0), logo: intAttr(app, "logo", 0), banner: intAttr(app, "banner", 0),
    iconRes: intAttr(app, "icon", 0), roundIconRes: intAttr(app, "roundIcon", 0),
    metaData: flags & GET_META_DATA ? yield* metaData$(app, record.res) : null,
    processName: app ? record.process(app) : pkg, taskAffinity: (app && attrStr(app, "taskAffinity")) ?? pkg,
    permission: app ? attrStr(app, "permission") : null, theme: intAttr(app, "theme", 0),
    flags: applicationFlags(record), privateFlags: privateFlags(record), privateFlagsExt: privateFlagsExt(record),
    uid: record.uid, minSdkVersion: min, targetSdkVersion: target,
    compileSdkVersion: intAttr(record.root, "compileSdkVersion", 0), compileSdkVersionCodename: attrStr(record.root, "compileSdkVersionCodename"),
    versionCode: intAttr(record.root, "versionCode", 0), longVersionCode: longVersionCode(record.root),
    sourceDir: record.path, publicSourceDir: record.path,
    splitNames: splits && jarray(splits.slice(), "Ljava/lang/String;"),
    splitSourceDirs: splits && jarray(splits.map((n) => apkPath(n)), "Ljava/lang/String;"),
    splitPublicSourceDirs: splits && jarray(splits.map((n) => apkPath(n)), "Ljava/lang/String;"),
    nativeLibraryDir: "/lib", dataDir: `/data/data/${pkg}`, credentialProtectedDataDir: `/data/data/${pkg}`,
    deviceProtectedDataDir: `/data/user_de/0/${pkg}`, storageUuid: uuidDefault(),
    enabled: record.enabled ? 1 : 0, enabledSetting: 0, category: intAttr(app, "appCategory", -1),
    networkSecurityConfigRes: intAttr(app, "networkSecurityConfig", 0),
    targetSandboxVersion: intAttr(record.root, "targetSandboxVersion", 1), installLocation: intAttr(record.root, "installLocation", -1),
    appComponentFactory: qualified("appComponentFactory"), backupAgentName: qualified("backupAgent"), manageSpaceActivityName: qualified("manageSpaceActivity"),
    zygotePreloadName: qualified("zygotePreloadName"), classLoaderName: app ? attrStr(app, "classLoader") : null,
    descriptionRes: intAttr(app, "description", 0), uiOptions: intAttr(app, "uiOptions", 0),
    fullBackupContent: intAttr(app, "fullBackupContent", 0), dataExtractionRulesRes: intAttr(app, "dataExtractionRules", 0),
    localeConfigRes: intAttr(app, "localeConfig", 0),
  });
  return ai;
}
const longVersionCode = (root: XmlNode) => BigInt((attr(root, "versionCode")?.data ?? 0) >>> 0) | BigInt(attr(root, "versionCodeMajor")?.data ?? 0) << 32n;

const appInfos = new WeakMap<PackageRecord, Map<number, JObj | Promise<JObj>>>();
/** the package's ApplicationInfo for these flags; equal answers share one, which each caller gets a copy of */
function applicationInfoOf(record: PackageRecord, flags: number): JObj | Promise<JObj> {
  const key = flags & (GET_META_DATA | GET_SHARED_LIBRARY_FILES);
  let cache = appInfos.get(record);
  if (!cache) appInfos.set(record, cache = new Map());
  let info = cache.get(key);
  if (!info) {
    info = rt.drive(buildApplicationInfo$(record, key));
    cache.set(key, info);
    if (info instanceof Promise) info.then((made) => cache.set(key, made), () => cache.delete(key));
  }
  return info;
}
function* applicationInfo$(record: PackageRecord, flags: number): Gen<JObj> {
  return copy((yield applicationInfoOf(record, flags)) as JObj);
}

const loadedInfos = new Map<string, JObj | Promise<JObj>>();
/** a LoadedApk's ApplicationInfo, which every Context of that package in this process shares: what
 *  the activity manager binds the process with, or ActivityThread.getPackageInfo asks for
 *  (GET_SHARED_LIBRARY_FILES, so no meta-data) */
export function loadedApplicationInfo(pkg: string): JObj | Promise<JObj> {
  const known = loadedInfos.get(pkg);
  if (known) return known;
  const record = packages.get(pkg);
  if (!record) throw rt.mkThrowable(PKG + "PackageManager$NameNotFoundException", pkg);
  const info = rt.drive(applicationInfo$(record, GET_SHARED_LIBRARY_FILES));
  loadedInfos.set(pkg, info);
  if (info instanceof Promise) info.then((made) => loadedInfos.set(pkg, made), () => loadedInfos.delete(pkg));
  return info;
}


// ── components
export interface Component { owner: PackageRecord; kind: ComponentKind; name: string; node: XmlNode }
export interface Match extends Component { priority: number; isDefault: boolean }
const hasFilters = (node: XmlNode) => node.children.some((n) => n.name === "intent-filter");
/** ComponentInfo.exported: declared, else whether it has an intent filter (a provider: below API 17) */
export const exported = (c: Component): boolean => c.owner.flag(c.node, "exported", c.kind === "provider" ? c.owner.sdk.target < 17 : hasFilters(c.node));
/** the component's own permission, else its application's */
export const componentPermission = (c: Component): string | null =>
  attrStr(c.node, "permission") ?? (c.kind !== "provider" && c.owner.application ? attrStr(c.owner.application, "permission") : null);
export const componentProcess = (c: Component): string => c.owner.process(c.node);
const directBootAware = (c: Component) => c.owner.flag(c.node, "directBootAware", c.owner.flag(c.owner.application, "directBootAware", false));

function componentEnabled(c: Component): boolean {
  const state = componentState.get({ pkg: c.owner.pkg, cls: c.name });
  return state === 1 || state === 0 && c.owner.flag(c.node, "enabled", true);
}
function visible(c: Component, flags: number): boolean {
  if (flags & MATCH_SYSTEM_ONLY && !c.owner.system) return false;
  if (!(flags & MATCH_DISABLED_COMPONENTS) && (!c.owner.enabled || !componentEnabled(c))) return false;
  const directBoot = flags & (MATCH_DIRECT_BOOT_AWARE | MATCH_DIRECT_BOOT_UNAWARE);
  return !directBoot || !!(directBoot & (directBootAware(c) ? MATCH_DIRECT_BOOT_AWARE : MATCH_DIRECT_BOOT_UNAWARE));
}
function components(owner: PackageRecord, kind: ComponentKind, flags: number): Component[] {
  const out: Component[] = [];
  for (const [name, node] of owner.components[kind]) {
    const c = { owner, kind, name, node };
    if (visible(c, flags)) out.push(c);
  }
  return out;
}
function lookup(pkg: string, cls: string, kind: ComponentKind, flags: number): Component | null {
  const owner = packages.get(pkg), name = qualifyComponent(cls, pkg), node = owner?.components[kind].get(name);
  const c = owner && node ? { owner, kind, name, node } : null;
  return c && visible(c, flags) ? c : null;
}

const NO_STRINGS: string[] = jarray([], "Ljava/lang/String;");
function* componentInfo$(o: JObj, c: Component, flags: number, app: JObj | null): Gen<void> {
  put(o, COMPONENT, {
    ...resolvedLabel(c.node), name: c.name, packageName: c.owner.pkg, icon: intAttr(c.node, "icon", 0),
    logo: intAttr(c.node, "logo", 0), banner: intAttr(c.node, "banner", 0),
    metaData: flags & GET_META_DATA ? yield* metaData$(c.node, c.owner.res) : null,
    applicationInfo: app ?? (yield* applicationInfo$(c.owner, flags)), processName: componentProcess(c),
    descriptionRes: intAttr(c.node, "description", 0), enabled: c.owner.flag(c.node, "enabled", true) ? 1 : 0,
    exported: exported(c) ? 1 : 0, directBootAware: directBootAware(c) ? 1 : 0, attributionTags: NO_STRINGS,
  });
}
const qualifiedAttr = (c: Component, name: string) => { const cls = attrStr(c.node, name); return cls ? qualifyComponent(cls, c.owner.pkg) : null; };
/** ActivityInfo.flags from <activity> or <receiver>, as ParsingPackageUtils reads them */
function activityFlags(c: Component): number {
  const app = c.owner.application, receiver = c.kind === "receiver";
  return bitsOf(c.owner, c.node, receiver ? [["singleUser", 0x40000000, false], ["canDisplayOnRemoteDevices", 0x10000, true]] : [
    ["multiprocess", 0x1, false], ["finishOnTaskLaunch", 0x2, false], ["clearTaskOnLaunch", 0x4, false], ["alwaysRetainTaskState", 0x8, false],
    ["stateNotNeeded", 0x10, false], ["excludeFromRecents", 0x20, false], ["allowTaskReparenting", 0x40, c.owner.flag(app, "allowTaskReparenting", false)],
    ["noHistory", 0x80, false], ["finishOnCloseSystemDialogs", 0x100, false], ["hardwareAccelerated", 0x200, c.owner.flag(app, "hardwareAccelerated", c.owner.sdk.target >= 14)],
    ["showForAllUsers", 0x400, false], ["immersive", 0x800, false], ["relinquishTaskIdentity", 0x1000, false], ["autoRemoveFromRecents", 0x2000, false],
    ["resumeWhilePausing", 0x4000, false], ["canDisplayOnRemoteDevices", 0x10000, true], ["supportsPictureInPicture", 0x400000, false],
    ["showWhenLocked", 0x800000, false], ["turnScreenOn", 0x1000000, false], ["preferMinimalPostProcessing", 0x2000000, false],
  ]);
}
/** ActivityInfo.resizeMode: the activity's or application's resizeableActivity, else what the target SDK implies */
function resizeMode(c: Component): number {
  const app = c.owner.application, declared = attr(c.node, "resizeableActivity") ? c.node : app && attr(app, "resizeableActivity") ? app : null;
  if (declared) return c.owner.flag(declared, "resizeableActivity", true) ? RESIZE_MODE_RESIZEABLE : RESIZE_MODE_UNRESIZEABLE;
  return c.owner.sdk.target >= 24 ? RESIZE_MODE_RESIZEABLE_VIA_SDK_VERSION : RESIZE_MODE_FORCE_RESIZEABLE;
}
const CONFIG_MCC = 1, CONFIG_MNC = 2;
function* activityInfo$(c: Component, flags: number, app: JObj | null): Gen<JObj> {
  const info: JObj = yield make(ACTIVITY);
  yield* componentInfo$(info, c, flags, app);
  put(info, ACTIVITY, { taskAffinity: manifestAffinity(c), permission: componentPermission(c), flags: activityFlags(c) });
  // an activity is relaunched for an MCC/MNC change only when it asks to be (recreateOnConfigChanges)
  if (c.kind === "activity") put(info, ACTIVITY, {
    theme: intAttr(c.node, "theme", 0), launchMode: intAttr(c.node, "launchMode", 0),
    screenOrientation: intAttr(c.node, "screenOrientation", -1),
    configChanges: intAttr(c.node, "configChanges", 0) | ~intAttr(c.node, "recreateOnConfigChanges", 0) & (CONFIG_MCC | CONFIG_MNC),
    softInputMode: intAttr(c.node, "windowSoftInputMode", 0), uiOptions: intAttr(c.node, "uiOptions", intAttr(c.owner.application, "uiOptions", 0)),
    privateFlags: c.owner.flag(c.node, "playHomeTransitionSound", true) ? 2 : 0, resizeMode: resizeMode(c),
    parentActivityName: qualifiedAttr(c, "parentActivityName"), targetActivity: qualifiedAttr(c, "targetActivity"),
    documentLaunchMode: intAttr(c.node, "documentLaunchMode", 0), maxRecents: intAttr(c.node, "maxRecents", DEFAULT_MAX_RECENTS),
  });
  return info;
}
/** ActivityTaskManager.getDefaultAppRecentsLimitStatic on a device that is not low-RAM: 48 / 6 */
const DEFAULT_MAX_RECENTS = 8;
const manifestAffinity = (c: Component) => (attrStr(c.node, "taskAffinity") ?? (c.owner.application && attrStr(c.owner.application, "taskAffinity")) ?? c.owner.pkg) || null;
function* serviceInfo$(c: Component, flags: number, app: JObj | null): Gen<JObj> {
  const info: JObj = yield make(SERVICE);
  yield* componentInfo$(info, c, flags, app);
  put(info, SERVICE, {
    permission: componentPermission(c), mForegroundServiceType: intAttr(c.node, "foregroundServiceType", 0),
    flags: bitsOf(c.owner, c.node, [["stopWithTask", 1, false], ["isolatedProcess", 2, false], ["externalService", 4, false],
      ["useAppZygote", 8, false], ["singleUser", 0x40000000, false]]),
  });
  return info;
}
export const authoritiesOf = (node: XmlNode) => (attrStr(node, "authorities") ?? "").split(";").filter(Boolean);
function* providerInfo$(c: Component, flags: number, app: JObj | null): Gen<JObj> {
  const info: JObj = yield make(PROVIDER), permission = attrStr(c.node, "permission");
  yield* componentInfo$(info, c, flags, app);
  put(info, PROVIDER, {
    authority: authoritiesOf(c.node).join(";") || null, readPermission: attrStr(c.node, "readPermission") ?? permission,
    writePermission: attrStr(c.node, "writePermission") ?? permission, grantUriPermissions: c.owner.flag(c.node, "grantUriPermissions", false) ? 1 : 0,
    forceUriPermissions: c.owner.flag(c.node, "forceUriPermissions", false) ? 1 : 0, multiprocess: c.owner.flag(c.node, "multiprocess", false) ? 1 : 0,
    initOrder: intAttr(c.node, "initOrder", 0), isSyncable: c.owner.flag(c.node, "syncable", false) ? 1 : 0,
    pathPermissions: jarray([], "Landroid/content/pm/PathPermission;"),
  });
  return info;
}
const infoOf$ = (c: Component, flags: number, app: JObj | null = null) =>
  c.kind === "service" ? serviceInfo$(c, flags, app) : c.kind === "provider" ? providerInfo$(c, flags, app) : activityInfo$(c, flags, app);
function* all$<T, R>(items: T[], each: (item: T) => Gen<R>): Gen<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(yield* each(item));
  return out;
}

// ── the platform's own providers and activities
const DOCS_PROVIDER_INTERFACE = "android.content.action.DOCUMENTS_PROVIDER";
/** Providers the *system* installs. A device answers for the storage authority out of
 *  ExternalStorageProvider, which no app can see in its own manifest, yet every SAF client
 *  (UniFile, DocumentFile) asks the package manager for it before trusting a tree URI. */
const SYSTEM_PROVIDERS: { authority: string; cls: string; action: string }[] =
  [{ authority: DOCS_AUTHORITY, cls: "com.android.externalstorage.ExternalStorageProvider", action: DOCS_PROVIDER_INTERFACE }];
export const isDocumentsProvider = (authority: string): boolean =>
  SYSTEM_PROVIDERS.some((p) => p.authority === authority && p.action === DOCS_PROVIDER_INTERFACE) ||
  [...packages.values()].some((owner) => [...owner.components.provider.values()].some((n) =>
    handlesAction(n, DOCS_PROVIDER_INTERFACE) && authoritiesOf(n).includes(authority)));
function* systemProviderInfo$(p: typeof SYSTEM_PROVIDERS[number]): Gen<JObj> {
  const pkg = p.cls.slice(0, p.cls.lastIndexOf(".")), info: JObj = yield make(PROVIDER), app: JObj = yield make(APP);
  put(app, APP, { packageName: pkg, processName: pkg, uid: 1000, flags: 1 | 0x800000, enabled: 1 });
  put(info, PROVIDER, { name: p.cls, packageName: pkg, authority: p.authority, applicationInfo: app, processName: pkg, exported: 1, grantUriPermissions: 1, enabled: 1 });
  return info;
}
const handlesAction = (node: XmlNode, action: string) => node.children.some((f) => f.name === "intent-filter" &&
  f.children.some((a) => a.name === "action" && attrStr(a, "name") === action));

/** the manifests' services answering `action` */
export const servicesMatching = (action: string) => [...packages.values()].flatMap((owner) =>
  [...owner.components.service.values()].filter((n) => handlesAction(n, action)).map((node) => ({ node, owner })));

// ── intent resolution, as ComputerEngine's queryIntent*Internal
/** the components answering `q`, best first; an explicit component is looked up without its filters */
function* queryComponents$(q: IntentQuery, flags: number, kind: ComponentKind): Gen<Match[]> {
  const result: Match[] = [];
  if (q.component) {
    const c = lookup(q.componentPkg ?? "", q.component, kind, flags);
    return c ? [{ ...c, priority: 0, isDefault: false }] : [];
  }
  const target = yield* intentTarget$(q), defaultOnly = !!(flags & MATCH_DEFAULT_ONLY);
  for (const owner of packages.values()) {
    if (q.pkg && q.pkg !== owner.pkg) continue;
    for (const c of components(owner, kind, flags)) {
      let priority = -Infinity, isDefault = false;
      for (const node of c.node.children) {
        if (node.name !== "intent-filter") continue;
        const filter: JObj = yield* manifestFilter$(node);
        if (!(yield* matches$(filter, target, defaultOnly))) continue;
        priority = Math.max(priority, yield vcall(filter, "getPriority", "()I"));
        isDefault ||= !!(yield vcall(filter, "hasCategory", "(Ljava/lang/String;)Z", "android.intent.category.DEFAULT"));
      }
      if (priority > -Infinity) result.push({ ...c, priority, isDefault });
    }
  }
  return result.sort((a, b) => b.priority - a.priority || +b.isDefault - +a.isDefault);
}
/** the platform's chooser or picker standing for a system activity, as ResolverActivity does */
function* systemResolveInfo$(): Gen<JObj> {
  const info: JObj = yield make(RESOLVE), activity: JObj = yield make(ACTIVITY), platform = packages.get("android");
  put(activity, ACTIVITY, { name: SYSTEM_ACTIVITY, packageName: "android", processName: "system", exported: 1, enabled: 1,
    applicationInfo: platform ? yield* applicationInfo$(platform, 0) : null });
  put(info, RESOLVE, { activityInfo: activity });
  return info;
}
const answersSystem = (q: IntentQuery) => !!systemActivity(q) && (!q.pkg || q.pkg === "android");
function* resolveInfo$(m: Match, flags: number): Gen<JObj> {
  const info: JObj = yield make(RESOLVE), component: JObj = yield* infoOf$(m, flags);
  put(info, RESOLVE, {
    [m.kind === "service" ? "serviceInfo" : m.kind === "provider" ? "providerInfo" : "activityInfo"]: component,
    priority: m.priority, isDefault: m.isDefault ? 1 : 0,
  });
  return info;
}
function* queryIntent$(intent: JObj | null, type: string | null, flags: number, kind: ComponentKind): Gen<JObj[]> {
  if (!intent) return [];
  const q = yield* intentQuery$(intent, type);
  const infos = yield* all$(yield* queryComponents$(q, flags, kind), (m) => resolveInfo$(m, flags));
  if (kind === "activity" && answersSystem(q)) infos.push(yield* systemResolveInfo$());
  if (kind === "provider") for (const p of SYSTEM_PROVIDERS) if (!q.action || p.action === q.action) {
    const info: JObj = yield make(RESOLVE);
    put(info, RESOLVE, { providerInfo: yield* systemProviderInfo$(p) });
    infos.push(info);
  }
  return infos;
}
/** what the activity manager starts for an intent: the best activity, or the system activity standing for one */
export const resolveActivity = driven(function* resolveActivity$(intent: JObj, flags: number = MATCH_DEFAULT_ONLY): Gen<Match | "system" | null> {
  const q = yield* intentQuery$(intent);
  return (yield* queryComponents$(q, flags, "activity"))[0] ?? (answersSystem(q) ? "system" : null);
});
export const resolveService = driven(function* resolveService$(intent: JObj, flags: number = 0): Gen<Match | null> {
  return (yield* queryComponents$(yield* intentQuery$(intent), flags, "service"))[0] ?? null;
});
export const queryReceivers = driven(function* queryReceivers$(intent: JObj, flags: number = 0): Gen<Match[]> {
  return yield* queryComponents$(yield* intentQuery$(intent), flags, "receiver");
});

/** the installed provider for an authority (ComputerEngine.resolveContentProvider) */
export function resolveProvider(authority: string, flags = 0): Component | null {
  for (const owner of packages.values()) for (const c of components(owner, "provider", flags))
    if (authoritiesOf(c.node).includes(authority)) return c;
  return null;
}
export const javaProviderInfo = (c: Component, flags = GET_META_DATA) => rt.drive(providerInfo$(c, flags, null));
/** the launcher activity of a package, as getLaunchIntentForPackage finds it */
export function launcherActivity(pkg: string): Component | null {
  const owner = packages.get(pkg);
  return owner ? components(owner, "activity", 0).find((c) => c.node.children.some((f) => f.name === "intent-filter" &&
    f.children.some((x) => x.name === "category" && attrStr(x, "name") === "android.intent.category.LAUNCHER"))) ?? null : null;
}

// ── permissions, as PermissionManagerService checks them
const declaredPermission = (name: string): [PackageRecord, XmlNode] | null => {
  for (const owner of packages.values()) {
    const node = owner.root.children.find((n) => n.name === "permission" && attrStr(n, "name") === name);
    if (node) return [owner, node];
  }
  return null;
};
/** PERMISSION_GRANTED (0) or PERMISSION_DENIED (-1) for a package */
export function checkPermission(permission: string, pkg: string): number | Promise<number> {
  const record = packages.get(pkg);
  if (record?.grants.has(permission)) return 0;
  if (!record?.permissions.has(permission)) return -1;
  if (signaturePermissions.has(permission)) return signerHolds(record, permission);
  return permissionGranted(pkg, permission) ? 0 : -1;
}
/** a signature permission: held when the package is signed as the one declaring it */
async function signerHolds(record: PackageRecord, permission: string): Promise<number> {
  const certificates = await record.certificates();
  for (const owner of packages.values()) {
    if (!owner.root.children.some((n) => n.name === "permission" && attrStr(n, "name") === permission)) continue;
    const signers = await owner.certificates();
    if (certificates.length && certificates.length === signers.length && certificates.every((c, i) => sameBytes(c, signers[i]))) return 0;
  }
  return -1;
}
/** a declared permission's protectionLevel, or null when no package declares it */
export const protectionLevel = (name: string): number | null => {
  const declared = declaredPermission(name);
  return declared ? attr(declared[1], "protectionLevel")?.data ?? 0 : null;
};
function* permissionInfo$(owner: PackageRecord, node: XmlNode, flags: number): Gen<JObj> {
  const info: JObj = yield make(PKG + "PermissionInfo");
  put(info, PKG + "PermissionInfo", {
    ...resolvedLabel(node), name: attrStr(node, "name"), packageName: owner.pkg, icon: intAttr(node, "icon", 0),
    group: attrStr(node, "permissionGroup"), protectionLevel: intAttr(node, "protectionLevel", 0),
    flags: intAttr(node, "permissionFlags", 0), descriptionRes: intAttr(node, "description", 0),
    metaData: flags & GET_META_DATA ? yield* metaData$(node, owner.res) : null,
  });
  return info;
}

// ── packages
function* signatureArray$(certificates: Uint8Array[]): Gen<JObj[]> {
  const signatures: JObj[] = [];
  for (const c of certificates) signatures.push(yield make(PKG + "Signature", "([B)V", new Int8Array(c)));
  return jarray(signatures, "Landroid/content/pm/Signature;");
}
/** SigningInfo over the signers, with no rotation history; which scheme signed is not tracked (UNKNOWN) */
function* signingInfo$(certificates: Uint8Array[]): Gen<JObj> {
  const details = yield make(PKG + "SigningDetails", "([Landroid/content/pm/Signature;I)V", yield* signatureArray$(certificates), 0);
  return yield make(PKG + "SigningInfo", "(Landroid/content/pm/SigningDetails;)V", details);
}
function requestedPermissions(root: XmlNode): string[] {
  const names = new Set<string>();
  for (const node of root.children) {
    if (node.name !== "uses-permission" && node.name !== "uses-permission-sdk-23" && node.name !== "uses-permission-sdk-m") continue;
    const max = attr(node, "maxSdkVersion")?.data ?? 0;
    if (max && max < device.sdk) continue;
    const name = attrStr(node, "name");
    if (name) names.add(name);
  }
  return [...names];
}
function* featureInfo$(name: string | null, flags = 0, glEs = 0): Gen<JObj> {
  const info: JObj = yield make(PKG + "FeatureInfo");
  put(info, PKG + "FeatureInfo", { name, flags, reqGlEsVersion: glEs });
  return info;
}
function* instrumentationInfo$(record: PackageRecord, node: XmlNode, flags: number): Gen<JObj> {
  const item: JObj = yield make(PKG + "InstrumentationInfo");
  put(item, PKG + "InstrumentationInfo", {
    ...resolvedLabel(node), name: qualifyComponent(attrStr(node, "name") ?? "", record.pkg), packageName: record.pkg,
    targetPackage: attrStr(node, "targetPackage"), targetProcesses: attrStr(node, "targetProcesses"),
    handleProfiling: record.flag(node, "handleProfiling", false) ? 1 : 0, functionalTest: record.flag(node, "functionalTest", false) ? 1 : 0,
    sourceDir: record.path, publicSourceDir: record.path, dataDir: `/data/data/${record.pkg}`,
    metaData: flags & GET_META_DATA ? yield* metaData$(node, record.res) : null,
  });
  return item;
}
function* packageInfo$(record: PackageRecord, flags: number): Gen<JObj> {
  const pi: JObj = yield make(PACKAGE), root = record.root, app: JObj = yield* applicationInfo$(record, flags);
  const version = attr(root, "versionName");
  const own = record === currentPackage && appHost?.pkg === record.pkg ? appHost : null;
  const time = installTime(record.pkg);
  put(pi, PACKAGE, {
    packageName: record.pkg, splitNames: jarray(own?.splits.slice() ?? [], "Ljava/lang/String;"), splitRevisionCodes: new Int32Array(own?.splits.length ?? 0),
    versionCode: intAttr(root, "versionCode", 0), versionCodeMajor: intAttr(root, "versionCodeMajor", 0),
    versionName: version?.type === TV.REFERENCE ? resString(record.res, version.data) : version?.str ?? null,
    sharedUserId: attrStr(root, "sharedUserId"), sharedUserLabel: intAttr(root, "sharedUserLabel", 0), applicationInfo: app,
    firstInstallTime: time, lastUpdateTime: time, installLocation: intAttr(root, "installLocation", -1),
    isStub: 0, coreApp: record.flag(root, "coreApp", false) ? 1 : 0,
    compileSdkVersion: intAttr(root, "compileSdkVersion", 0), compileSdkVersionCodename: attrStr(root, "compileSdkVersionCodename"),
  });
  const lists: [number, ComponentKind, string, string][] = [[GET_ACTIVITIES, "activity", "activities", ACTIVITY],
    [GET_RECEIVERS, "receiver", "receivers", ACTIVITY], [GET_SERVICES, "service", "services", SERVICE], [GET_PROVIDERS, "provider", "providers", PROVIDER]];
  for (const [bit, kind, name, cls] of lists) {
    const items = flags & bit ? components(record, kind, flags) : [];
    if (items.length) put(pi, PACKAGE, { [name]: jarray(yield* all$(items, (c) => infoOf$(c, flags, app)), `L${cls};`) });
  }
  const instrumentation = flags & GET_INSTRUMENTATION ? root.children.filter((n) => n.name === "instrumentation") : [];
  if (instrumentation.length) put(pi, PACKAGE, { instrumentation:
    jarray(yield* all$(instrumentation, (node) => instrumentationInfo$(record, node, flags)), "Landroid/content/pm/InstrumentationInfo;") });
  if (flags & GET_PERMISSIONS) {
    const declared = root.children.filter((n) => n.name === "permission");
    if (declared.length) put(pi, PACKAGE, { permissions: jarray(yield* all$(declared, (n) => permissionInfo$(record, n, flags)), "Landroid/content/pm/PermissionInfo;") });
    const requested = requestedPermissions(root), granted: number[] = [];
    for (const name of requested) granted.push(yield checkPermission(name, record.pkg));
    // REQUESTED_PERMISSION_REQUIRED, and REQUESTED_PERMISSION_GRANTED when held
    if (requested.length) put(pi, PACKAGE, { requestedPermissions: jarray(requested, "Ljava/lang/String;"),
      requestedPermissionsFlags: Int32Array.from(granted, (result) => 1 | (result === 0 ? 2 : 0)) });
  }
  const features = flags & GET_CONFIGURATIONS ? root.children.filter((n) => n.name === "uses-feature") : [];
  if (features.length) put(pi, PACKAGE, { reqFeatures: jarray(yield* all$(features, (n) =>
    featureInfo$(attrStr(n, "name"), record.flag(n, "required", true) ? 1 : 0, intAttr(n, "glEsVersion", 0))), "Landroid/content/pm/FeatureInfo;") });
  if (flags & (GET_SIGNATURES | GET_SIGNING_CERTIFICATES)) {
    const certificates: Uint8Array[] = yield record.visibleCertificates();
    if (flags & GET_SIGNATURES) put(pi, PACKAGE, { signatures: yield* signatureArray$(certificates) });
    if (flags & GET_SIGNING_CERTIFICATES) put(pi, PACKAGE, { signingInfo: yield* signingInfo$(certificates) });
  }
  return pi;
}

// ── installed archives under /data/app, registered when first asked for
const archiveCache = new WeakMap<Uint8Array, Promise<PackageArchive>>();
const certificateCache = new WeakMap<Uint8Array, Promise<Uint8Array[]>>();
function cachedCertificates(bytes: Uint8Array, zip: Parameters<typeof apkCertificates>[1]): Promise<Uint8Array[]> {
  let pending = certificateCache.get(bytes);
  if (!pending) certificateCache.set(bytes, pending = apkCertificates(bytes, zip));
  return pending;
}
async function readArchive(path: string): Promise<PackageArchive | null> {
  const packed = packedArchives.get(path);
  if (packed) return packageArchive(packed.zip, packed.index.certificates.map(hexBytes));
  const bytes = await vfs.readFile(path);
  if (!bytes) return null;
  let archive = archiveCache.get(bytes);
  if (!archive) archiveCache.set(bytes, archive = parsePackageArchive(bytes));
  try { return await archive; } catch { return null; }
}
// There is no IncFS: no file is incremental and none carries a v4 signature, so
// ApkSignatureVerifier reads the APK's v3/v2/v1 signatures
rt.registerJnis("android/os/incremental/IncrementalManager", {
  "nativeIsEnabled()Z": () => 0, "nativeIsV2Available()Z": () => 0,
  "nativeIsIncrementalFd(I)Z": () => 0, "nativeIsIncrementalPath(Ljava/lang/String;)Z": () => 0,
  "nativeUnsafeGetFileSignature(Ljava/lang/String;)[B": () => null,
});
export const installedPath = (pkg: string) => `/data/app/${pkg}/base.apk`;
export function registerPackage(archive: PackageArchive, path = installedPath(archive.pkg), uid = packageUid(archive.pkg)): PackageRecord {
  const record = new PackageRecord(archive.root, archive.res, path, uid, () => Promise.resolve(archive.certificates));
  packages.set(record.pkg, record);
  for (const node of archive.root.children) if (node.name === "permission" && (intAttr(node, "protectionLevel", 0) & 3) >= 2) {
    const name = attrStr(node, "name");
    if (name) signaturePermissions.add(name);
  }
  return record;
}
/** the package's record, registering its persisted install on first use; synchronous when known */
function packageRecord(pkg: string): PackageRecord | Promise<PackageRecord | null> {
  return packages.get(pkg) ?? (async () => {
    await restorePackages();
    const path = installedPath(pkg), archive = await readArchive(path);
    return archive ? packages.get(pkg) ?? registerPackage(archive, path) : null;
  })();
}
async function installedPackages(): Promise<PackageRecord[]> {
  await restorePackages();
  for (const path of vfs.files.keys()) {
    if (!/^\/data\/app\/[^/]+\/base\.apk$/.test(path)) continue;
    const archive = await readArchive(path);
    if (archive && !packages.has(archive.pkg)) registerPackage(archive, path);
  }
  return [...packages.values()];
}
export async function installPackageArchive(bytes: Uint8Array, expectedPackage: string | null = null): Promise<string> {
  await verifyApkSignature(bytes);
  const archive = await parsePackageArchive(bytes);
  if (expectedPackage && expectedPackage !== archive.pkg) throw new Error("Session package name differs from APK");
  if (archive.pkg === appHost?.pkg) throw new Error("Replacing the running package is unsupported");
  if (!archive.certificates.length) throw new Error("APK is unsigned");
  await restorePackages();
  const previous = await readArchive(installedPath(archive.pkg));
  if (previous && longVersionCode(archive.root) < longVersionCode(previous.root)) throw new Error("APK version is older than installed package");
  if (previous && (previous.certificates.length !== archive.certificates.length ||
      previous.certificates.some((cert, i) => !sameBytes(cert, archive.certificates[i])))) throw new Error("APK signing certificate differs from installed package");
  await persistPackage(installedPath(archive.pkg), bytes);
  vfs.write(installedPath(archive.pkg), bytes);
  registerPackage(archive);
  return archive.pkg;
}

// ── checksums and signatures
const wholeChecksumAlgorithms: readonly [number, string][] = [[2, "MD5"], [4, "SHA-1"], [8, "SHA-256"], [16, "SHA-512"]];
async function apkDigests(record: PackageRecord, includeSplits: boolean, required: number): Promise<[string | null, number, Uint8Array][]> {
  const files: [string | null, string][] = [[null, record.path]];
  if (includeSplits && record === currentPackage && appHost) files.push(...appHost.splits.map((name): [string, string] => [name, apkPath(name)]));
  const result: [string | null, number, Uint8Array][] = [];
  for (const [splitName, path] of files) {
    const bytes = await vfs.readFile(path);
    if (!bytes) continue;
    for (const [type, algorithm] of wholeChecksumAlgorithms) {
      if (!(required & type)) continue;
      const value = algorithm === "SHA-512" ? new Uint8Array(await crypto.subtle.digest("SHA-512", bytes.slice())) : await digestBytes(algorithm, bytes);
      if (value) result.push([splitName, type, value]);
    }
  }
  return result;
}
async function certificateMatches(certificates: Uint8Array[], expected: Int8Array, type: number): Promise<number> {
  if (type !== 0 && type !== 1) return 0;
  for (const certificate of certificates) {
    const bytes = type === 0 ? certificate : await digestBytes("SHA-256", certificate);
    if (bytes && bytes.length === expected.length && bytes.every((byte, index) => byte === (expected[index]! & 255))) return 1;
  }
  return 0;
}
/** SIGNATURE_MATCH (0), NEITHER_SIGNED (1), FIRST_NOT_SIGNED (-1), SECOND_NOT_SIGNED (-2), NO_MATCH (-3) */
function compareSignatures(left: Uint8Array[], right: Uint8Array[]): number {
  if (!left.length || !right.length) return !left.length && !right.length ? 1 : !left.length ? -1 : -2;
  return left.length === right.length && left.every((cert) => right.some((other) => sameBytes(cert, other))) ? 0 : -3;
}
const recordsForUid = (uid: number) => [...packages.values()].filter((p) => p.uid === uid);

const slice = (items: unknown[]) => make(PKG + "ParceledListSlice", "(Ljava/util/List;)V", newArrayList(items));
function* componentArgs$(component: JObj | null): Gen<[string, string]> {
  if (!component) throw rt.mkThrowable("java/lang/NullPointerException", null);
  return [yield vcall(component, "getPackageName", "()Ljava/lang/String;"), yield vcall(component, "getClassName", "()Ljava/lang/String;")];
}
const flag = (flags: bigint) => Number(BigInt.asIntN(32, flags));
const componentInfoFor = (kind: ComponentKind) => driven(function* componentInfoFor$(component: JObj | null, flags: bigint): Gen<JObj | null> {
  const [pkg, cls] = yield* componentArgs$(component), c = lookup(pkg, cls, kind, flag(flags));
  return c ? yield* infoOf$(c, flag(flags)) : null;
});
const queryFor = (kind: ComponentKind, best: boolean) => driven(function* queryFor$(intent: JObj | null, type: string | null, flags: bigint): Gen {
  const infos = yield* queryIntent$(intent, type, flag(flags), kind);
  return best ? infos[0] ?? null : slice(infos);
});
const unknownPackage = (pkg: string) => rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown package: " + pkg);

// PackageManager.Property: a manifest <property> of the application or a component, as the package
// parser reads it (a resource reference, else a boolean, integer, float or string value)
const COMPONENT_TYPES: [number, ComponentKind | null][] = [[1, null], [2, "activity"], [3, "provider"], [4, "receiver"], [5, "service"]];
function propertyOf(owner: PackageRecord, node: XmlNode, cls: string | null): JObj | Promise<JObj> | null {
  const name = attrStr(node, "name");
  if (!name) return null;
  const P = PKG + "PackageManager$Property", resource = attr(node, "resource"), value = attr(node, "value");
  if (resource) return make(P, `(${S}IZ${S}${S})V`, name, resource.data, 1, owner.pkg, cls);
  if (!value) return null;
  if (value.type === TV.BOOLEAN) return make(P, `(${S}Z${S}${S})V`, name, +!!value.data, owner.pkg, cls);
  if (value.type === TV.FLOAT) return make(P, `(${S}F${S}${S})V`, name, new Float32Array(new Int32Array([value.data]).buffer)[0], owner.pkg, cls);
  if (value.type >= TV.INT_DEC && value.type <= TV.COLOR_RGB4) return make(P, `(${S}I${S}${S})V`, name, value.data, owner.pkg, cls);
  return make(P, `(${S}${S}${S}${S})V`, name, value.str ?? attrStr(node, "value") ?? "", owner.pkg, cls);
}
/** every <property> named `name` under the nodes of a component type, across packages */
function* properties$(name: string, type: number): Gen<JObj[]> {
  const kind = COMPONENT_TYPES.find(([t]) => t === type);
  if (!kind) return [];
  const out: JObj[] = [];
  for (const owner of packages.values()) {
    const nodes: [XmlNode, string | null][] = kind[1] ? [...owner.components[kind[1]]].map(([cls, node]) => [node, cls])
      : owner.application ? [[owner.application, null]] : [];
    for (const [node, cls] of nodes) for (const child of node.children)
      if (child.name === "property" && attrStr(child, "name") === name) { const p = propertyOf(owner, child, cls); if (p) out.push(yield p); }
  }
  return out;
}
const S = "Ljava/lang/String;", INTENT = "Landroid/content/Intent;", CN = "Landroid/content/ComponentName;", SLICE = "Landroid/content/pm/ParceledListSlice;";
rt.register({ name: "webdroid/PackageManagerService", ctor: class extends JObj {}, sup: "android/content/pm/IPackageManager$Stub", methods: {
  [`getPackageInfo(${S}JI)Landroid/content/pm/PackageInfo;`]: driven(function* getPackageInfo$(pkg: string, flags: bigint): Gen {
    const record: PackageRecord | null = yield packageRecord(pkg);
    return record ? yield* packageInfo$(record, flag(flags)) : null;
  }),
  [`getApplicationInfo(${S}JI)Landroid/content/pm/ApplicationInfo;`]: driven(function* getApplicationInfo$(pkg: string, flags: bigint): Gen {
    const record: PackageRecord | null = yield packageRecord(pkg);
    return record ? yield* applicationInfo$(record, flag(flags)) : null;
  }),
  [`getPackageUid(${S}JI)I`]: (pkg: string) => after(packageRecord(pkg), (record) => record?.uid ?? -1),
  [`getTargetSdkVersion(${S})I`]: (pkg: string) => after(packageRecord(pkg), (record) => record?.sdk.target ?? -1),
  [`getActivityInfo(${CN}JI)Landroid/content/pm/ActivityInfo;`]: componentInfoFor("activity"),
  [`getReceiverInfo(${CN}JI)Landroid/content/pm/ActivityInfo;`]: componentInfoFor("receiver"),
  [`getServiceInfo(${CN}JI)Landroid/content/pm/ServiceInfo;`]: componentInfoFor("service"),
  [`getProviderInfo(${CN}JI)Landroid/content/pm/ProviderInfo;`]: componentInfoFor("provider"),
  [`resolveIntent(${INTENT}${S}JI)Landroid/content/pm/ResolveInfo;`]: queryFor("activity", true),
  [`resolveService(${INTENT}${S}JI)Landroid/content/pm/ResolveInfo;`]: queryFor("service", true),
  [`queryIntentActivities(${INTENT}${S}JI)${SLICE}`]: queryFor("activity", false),
  [`queryIntentServices(${INTENT}${S}JI)${SLICE}`]: queryFor("service", false),
  [`queryIntentReceivers(${INTENT}${S}JI)${SLICE}`]: queryFor("receiver", false),
  [`queryIntentContentProviders(${INTENT}${S}JI)${SLICE}`]: queryFor("provider", false),
  [`resolveContentProvider(${S}JI)Landroid/content/pm/ProviderInfo;`]: driven(function* resolveContentProvider$(authority: string, flags: bigint): Gen {
    const system = SYSTEM_PROVIDERS.find((p) => p.authority === authority);
    if (system) return yield* systemProviderInfo$(system);
    const c = resolveProvider(authority, flag(flags));
    return c ? yield* providerInfo$(c, flag(flags), null) : null;
  }),
  [`queryContentProviders(${S}IJ${S})${SLICE}`]: driven(function* queryContentProviders$(process: string | null, uid: number, flags: bigint, metaDataKey: string | null): Gen {
    const out: JObj[] = process === null ? yield* all$(SYSTEM_PROVIDERS, systemProviderInfo$) : [];
    const own: [number, JObj][] = [];
    for (const owner of packages.values()) for (const c of components(owner, "provider", flag(flags))) {
      if (!authoritiesOf(c.node).length || process !== null && (componentProcess(c) !== process || owner.uid !== uid)) continue;
      if (metaDataKey !== null && !c.node.children.some((n) => n.name === "meta-data" && attrStr(n, "name") === metaDataKey)) continue;
      own.push([attr(c.node, "initOrder")?.data ?? 0, yield* providerInfo$(c, flag(flags), null)]);
    }
    // sProviderInitOrderSorter: by descending initOrder, the order ActivityThread installs them in
    return slice([...out, ...own.sort((a, b) => b[0] - a[0]).map(([, info]) => info)]);
  }),
  [`getComponentEnabledSetting(${CN}I)I`]: driven(function* getComponentEnabledSetting$(c: JObj): Gen {
    const [pkg, cls] = yield* componentArgs$(c);
    return componentState.get({ pkg, cls: qualifyComponent(cls, pkg) });
  }),
  [`setComponentEnabledSetting(${CN}IIILjava/lang/String;)V`]: driven(function* setComponentEnabledSetting$(c: JObj, state: number): Gen {
    const [pkg, cls] = yield* componentArgs$(c);
    if (state < 0 || state > 4) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid new component state: " + state);
    if (!(yield packageRecord(pkg))) throw unknownPackage(pkg);
    componentState.set({ pkg, cls: qualifyComponent(cls, pkg) }, state);
  }),
  [`getApplicationEnabledSetting(${S}I)I`]: (pkg: string) => after(packageRecord(pkg), (record) => { if (!record) throw unknownPackage(pkg); return 0; }),
  [`hasSystemFeature(${S}I)Z`]: (name: string, version: number) => device.features.includes(name) && version <= 0 ? 1 : 0,
  "getSystemAvailableFeatures()Landroid/content/pm/ParceledListSlice;": driven(function* getSystemAvailableFeatures$(): Gen {
    return slice([...yield* all$(device.features, (name) => featureInfo$(name)), yield* featureInfo$(null, 0, GL_ES_VERSION)]);
  }),
  "getSystemSharedLibraryNames()[Ljava/lang/String;": () => jarray([], S),
  [`checkPermission(${S}${S}I)I`]: (permission: string, pkg: string) => checkPermission(permission, pkg),
  [`getInstallSourceInfo(${S}I)Landroid/content/pm/InstallSourceInfo;`]: driven(function* getInstallSourceInfo$(pkg: string): Gen {
    if (!(yield packageRecord(pkg))) return null;
    // APK loading has no Android installer of record or installer-supplied source metadata
    return make(PKG + "InstallSourceInfo", `(${S}Landroid/content/pm/SigningInfo;${S}${S}${S}I)V`, null, null, null, null, null, 0);
  }),
  [`getInstallerPackageName(${S})${S}`]: (pkg: string) => after(packageRecord(pkg), (record) => { if (!record) throw unknownPackage(pkg); return null; }),
  "getPackageInstaller()Landroid/content/pm/IPackageInstaller;": () => installerService(),
  // installs need no user approval here, so a package asking for the permission may request them
  [`canRequestPackageInstalls(${S}I)Z`]: (pkg: string) =>
    after(packageRecord(pkg), (record) => record?.permissions.has("android.permission.REQUEST_INSTALL_PACKAGES") ? 1 : 0),
  [`isInstantApp(${S}I)Z`]: () => 0,
  [`isPackageSuspendedForUser(${S}I)Z`]: (pkg: string) => after(packageRecord(pkg), (record) => {
    if (!record) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown target package: " + pkg);
    return 0;
  }),
  [`isPackageAvailable(${S}I)Z`]: (pkg: string) => after(packageRecord(pkg), (record) => record ? 1 : 0),
  "isSafeMode()Z": () => 0,
  [`queryProperty(${S}I)${SLICE}`]: driven(function* queryProperty$(name: string, type: number): Gen { return slice(yield* properties$(name, type)); }),
  [`getPropertyAsUser(${S}${S}${S}I)Landroid/content/pm/PackageManager$Property;`]: driven(function* getPropertyAsUser$(name: string, pkg: string, cls: string | null): Gen {
    const owner = packages.get(pkg);
    if (!owner) throw rt.mkThrowable(PKG + "PackageManager$NameNotFoundException", pkg);
    const node = cls ? Object.values(owner.components).map((m) => m.get(cls)).find(Boolean) : owner.application;
    if (!node) throw rt.mkThrowable(PKG + "PackageManager$NameNotFoundException", cls ?? pkg);
    const child = node.children.find((c) => c.name === "property" && attrStr(c, "name") === name);
    return child ? propertyOf(owner, child, cls) : null;
  }),
  // the package that provides SdkSandboxService on the reference AVD
  "getSdkSandboxPackageName()Ljava/lang/String;": () => "com.google.android.sdksandbox",
  // no PermissionController module is installed
  "getPermissionControllerPackageName()Ljava/lang/String;": () => null,
  "isDeviceUpgrading()Z": () => 0,
  [`getNameForUid(I)${S}`]: (uid: number) => recordsForUid(uid)[0]?.pkg ?? null,
  [`getNamesForUids([I)[${S}`]: (uids: Int32Array) => jarray([...uids].map((uid) => recordsForUid(uid)[0]?.pkg ?? null), S),
  [`getPackagesForUid(I)[${S}`]: (uid: number) => {
    const names = recordsForUid(uid).map((p) => p.pkg);
    return names.length ? jarray(names, S) : null;
  },
  [`checkSignatures(${S}${S}I)I`]: async (a: string, b: string) => {
    const x = await packageRecord(a), y = await packageRecord(b);
    return x && y ? compareSignatures(await x.visibleCertificates(), await y.visibleCertificates()) : -4;
  },
  "checkUidSignatures(II)I": async (a: number, b: number) => {
    const x = recordsForUid(a)[0], y = recordsForUid(b)[0];
    return x && y ? compareSignatures(await x.visibleCertificates(), await y.visibleCertificates()) : -4;
  },
  [`hasSigningCertificate(${S}[BI)Z`]: async (pkg: string, certificate: Int8Array, type: number) => {
    const record = await packageRecord(pkg);
    return record ? certificateMatches(await record.visibleCertificates(), certificate, type) : 0;
  },
  "hasUidSigningCertificate(I[BI)Z": async (uid: number, certificate: Int8Array, type: number) => {
    for (const record of recordsForUid(uid)) if (await certificateMatches(await record.visibleCertificates(), certificate, type)) return 1;
    return 0;
  },
  [`getInstalledPackages(JI)${SLICE}`]: driven(function* getInstalledPackages$(flags: bigint): Gen {
    return slice(yield* all$((yield installedPackages()) as PackageRecord[], (record) => packageInfo$(record, flag(flags))));
  }),
  [`getInstalledApplications(JI)${SLICE}`]: driven(function* getInstalledApplications$(flags: bigint): Gen {
    return slice(yield* all$((yield installedPackages()) as PackageRecord[], (record) => applicationInfo$(record, flag(flags))));
  }),
  [`requestPackageChecksums(${S}ZIILjava/util/List;Landroid/content/pm/IOnChecksumsReadyListener;I)V`]: driven(function* requestPackageChecksums$(
    pkg: string, includeSplits: number, _optional: number, required: number, _installers: unknown, listener: JObj): Gen {
    const record: PackageRecord | null = yield packageRecord(pkg);
    if (!record) throw rt.mkThrowable(PKG + "PackageManager$NameNotFoundException", pkg);
    const checksums: JObj[] = [];
    for (const [split, type, value] of (yield apkDigests(record, includeSplits !== 0, required)) as [string | null, number, Uint8Array][])
      checksums.push(yield make(PKG + "ApkChecksum", `(${S}I[B)V`, split, type, new Int8Array(value)));
    yield vcall(listener, "onChecksumsReady", "(Ljava/util/List;)V", newArrayList(checksums));
  }),
  ...noops(`notifyPackageUse(${S}I)V`, `notifyDexLoad(${S}Ljava/util/Map;${S})V`),
} });
hostStub("package", "webdroid/PackageManagerService");

/** SystemConfig's split permissions (a permission requested below a target SDK implies the newer
 *  one), as the reference AVD lists them through IPermissionManager.getSplitPermissions */
const permissionName = (name: string) => name.includes(".") ? name : "android.permission." + name;
const SPLIT_PERMISSIONS: [string, number, string][] = [
  ["ACCESS_FINE_LOCATION", 10001, "ACCESS_COARSE_LOCATION"], ["WRITE_EXTERNAL_STORAGE", 10001, "READ_EXTERNAL_STORAGE"],
  ["READ_CONTACTS", 16, "READ_CALL_LOG"], ["WRITE_CONTACTS", 16, "WRITE_CALL_LOG"],
  ["ACCESS_FINE_LOCATION", 29, "ACCESS_BACKGROUND_LOCATION"], ["ACCESS_COARSE_LOCATION", 29, "ACCESS_BACKGROUND_LOCATION"],
  ["READ_EXTERNAL_STORAGE", 29, "ACCESS_MEDIA_LOCATION"], ["WRITE_EXTERNAL_STORAGE", 29, "ACCESS_MEDIA_LOCATION"],
  ...["BLUETOOTH", "BLUETOOTH_ADMIN"].flatMap((name) => ["SCAN", "CONNECT", "ADVERTISE"].map((added): [string, number, string] => [name, 31, "BLUETOOTH_" + added])),
  ["BODY_SENSORS", 33, "BODY_SENSORS_BACKGROUND"],
  ...["READ_EXTERNAL_STORAGE", "WRITE_EXTERNAL_STORAGE"].flatMap((name) => ["AUDIO", "VIDEO", "IMAGES"].map((added): [string, number, string] => [name, 33, "READ_MEDIA_" + added])),
  ["READ_MEDIA_IMAGES", 10001, "READ_MEDIA_VISUAL_USER_SELECTED"], ["READ_MEDIA_VIDEO", 10001, "READ_MEDIA_VISUAL_USER_SELECTED"],
  ["ACCESS_MEDIA_LOCATION", 10001, "READ_MEDIA_VISUAL_USER_SELECTED"], ["com.google.android.gms.permission.ACTIVITY_RECOGNITION", 29, "ACTIVITY_RECOGNITION"],
];
rt.register({ name: "webdroid/PermissionManagerService", ctor: class extends JObj {}, sup: "android/permission/IPermissionManager$Stub", methods: {
  [`checkPermission(${S}${S}${S}I)I`]: (pkg: string, permission: string) => checkPermission(permission, pkg),
  [`checkUidPermission(I${S}I)I`]: async (uid: number, permission: string) => {
    for (const record of recordsForUid(uid)) if (await checkPermission(permission, record.pkg) === 0) return 0;
    return -1;
  },
  [`getPermissionInfo(${S}${S}I)Landroid/content/pm/PermissionInfo;`]: driven(function* getPermissionInfo$(name: string, _caller: string, flags: number): Gen {
    const declared = declaredPermission(name);
    return declared ? yield* permissionInfo$(declared[0], declared[1], flags) : null;
  }),
  // no device policy is installed to revoke anything
  [`isPermissionRevokedByPolicy(${S}${S}II)Z`]: () => 0,
  // PermissionManagerServiceImpl answers FLAG_PERMISSION_USER_SET for a permission not held; a
  // request is never denied here, so no permission carries it
  [`shouldShowRequestPermissionRationale(${S}${S}II)Z`]: () => 0,
  "getSplitPermissions()Ljava/util/List;": driven(function* getSplitPermissions$(): Gen {
    return newArrayList(yield* all$(SPLIT_PERMISSIONS, function* split$([name, target, added]): Gen<JObj> {
      return yield make("android/content/pm/permission/SplitPermissionInfoParcelable", `(${S}Ljava/util/List;I)V`, permissionName(name), newArrayList([permissionName(added)]), target);
    }));
  }),
  ...noops("addOnPermissionsChangeListener(Landroid/permission/IOnPermissionsChangeListener;)V",
    "removeOnPermissionsChangeListener(Landroid/permission/IOnPermissionsChangeListener;)V"),
} });
hostStub("permissionmgr", "webdroid/PermissionManagerService");
// PermissionManager holds a LegacyPermissionManager from construction; none of its identifier
// checks is answered yet, so each reports itself missing when reached
rt.register({ name: "webdroid/LegacyPermissionManagerService", ctor: class extends JObj {}, sup: "android/permission/ILegacyPermissionManager$Stub" });
hostStub("legacy_permission", "webdroid/LegacyPermissionManagerService");

// a single-user device with no managed profile: nothing to reach across
rt.register({ name: "webdroid/CrossProfileAppsService", ctor: class extends JObj {}, sup: "android/content/pm/ICrossProfileApps$Stub", methods: {
  [`getTargetUserProfiles(${S})Ljava/util/List;`]: () => newArrayList(),
  [`canInteractAcrossProfiles(${S})Z`]: () => 0,
  [`canRequestInteractAcrossProfiles(${S})Z`]: () => 0,
} });
hostStub("crossprofileapps", "webdroid/CrossProfileAppsService");

/** a hosted service as its AIDL interface (Stub.asInterface), made once */
function hostedInterface(name: string, stub: string, iface: string): () => JObj | Promise<JObj> {
  let made: JObj | Promise<JObj> | null = null;
  return () => made ??= after(rt.drive(function* asInterface$(): Gen<JObj> {
    return yield scall(stub, "asInterface", `(Landroid/os/IBinder;)L${iface};`, yield hostedService(name));
  }()), (service) => made = service);
}
/** what ActivityThread.getPackageManager and getPermissionManager answer */
export const packageManagerService = hostedInterface("package", "android/content/pm/IPackageManager$Stub", "android/content/pm/IPackageManager");
export const permissionManagerService = hostedInterface("permissionmgr", "android/permission/IPermissionManager$Stub", "android/permission/IPermissionManager");
/** ActivityThread.getTopLevelResources: the application's own Resources, or a package's by its APK path */
export function packageResources(path: string, config: unknown): unknown {
  const record = [...packages.values()].find((r) => r.path === path);
  if (appHost && !config && (path === apkPath() || record === currentPackage)) return appHost.jresources;
  if (!record) return null;
  return config ? loadResources(path, config) : javaResources(record.res, path);
}
/** ContextImpl.getPackageManager's ApplicationPackageManager, over the hosted service */
export const newPackageManager = driven(function* newPackageManager$(context: JObj): Gen<JObj> {
  return yield make("android/app/ApplicationPackageManager", "(Landroid/app/ContextImpl;Landroid/content/pm/IPackageManager;)V", context, yield packageManagerService());
});
