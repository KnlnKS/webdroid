// IPackageManager, under AOSP's ApplicationPackageManager and the android.content.pm data classes,
// answered from the package registry (packages.ts) as PackageManagerService's ComputerEngine answers
// from its parsed packages. The registry-level queries are exported for the shell, which plays
// system_server's part in resolving intents and providers; permissions.ts answers for permissions.
// Intents and component names are read through their Java API only.
import { awaited, JObj, rt, noops, setDeclared, driven, type Gen } from "../jvm/runtime.ts";
import { jarray, strArray, intBitsToFloat, sameBytes } from "../jvm/abi.ts";
import { device } from "../shell/config.ts";
import { uuidDefault } from "./os.ts";
import { vcall, after, newObj } from "../jvm/natives/jentry.ts";
import { logUncaught, detached } from "../jvm/natives/jthrowable.ts";
import { type XmlNode, attrStr, attr, TV } from "./axml.ts";
import { resolved, resString, type Resources } from "./res.ts";
import { appHost } from "./apphost.ts";
import { vfs, apkPath } from "../shell/vfs.ts";
import { systemProviders, systemProviderInfo$ } from "./systemproviders.ts";
import { newArrayList } from "../jvm/natives/jcoll.ts";
import { SHARED_LIBRARIES } from "../jvm/bootclasspath.ts";
import { once } from "../jvm/suspend.ts";
import { systemActivity, SYSTEM_ACTIVITY, intentQuery$, type IntentQuery } from "./intent.ts";
import { intentTarget$, manifestFilter$, matches$ } from "./intent-filter.ts";
import { type PackageRecord, packages, uidPackages, qualifyComponent, applicationOf, componentState, installTime, type ComponentKind,
  GET_ACTIVITIES, GET_RECEIVERS, GET_SERVICES, GET_PROVIDERS, GET_INSTRUMENTATION, GET_SIGNATURES, GET_META_DATA, GET_SHARED_LIBRARY_FILES,
  GET_PERMISSIONS, GET_CONFIGURATIONS, GET_SIGNING_CERTIFICATES, MATCH_DISABLED_COMPONENTS, MATCH_DEFAULT_ONLY, MATCH_DIRECT_BOOT_UNAWARE,
  MATCH_DIRECT_BOOT_AWARE, MATCH_SYSTEM_ONLY } from "./packages.ts";
import { digestBytes } from "../crypto/digest.ts";
import { hostService, oneway, parceledList } from "./binder.ts";
import { deleteVersioned, enforceDeletePackages } from "./appdata.ts";
import { installerService } from "./packageinstaller.ts";
import { checkPermission } from "./permissions.ts";
import { libraryAbi } from "../jvm/natives/jlang.ts";
import { archivePath, centralDirOfSource, inflateTree, localDataOffset, treeEntrySize, type ZEntry } from "../zip.ts";
import type { FileSource } from "../shell/lazyfile.ts";
import { ABIS_64 } from "../shell/properties.ts";
import { linkerHooks } from "../native/dl.ts";

const PKG = "android/content/pm/";
const COMPONENT = PKG + "ComponentInfo", APP = PKG + "ApplicationInfo", ACTIVITY = PKG + "ActivityInfo";
const SERVICE = PKG + "ServiceInfo", PROVIDER = PKG + "ProviderInfo", PACKAGE = PKG + "PackageInfo", RESOLVE = PKG + "ResolveInfo";

export const FLAG_IS_GAME = 0x02000000;
/** the GLES version the WebGL2 context offers, which getSystemAvailableFeatures and ConfigurationInfo report */
export const GL_ES_VERSION = 0x30000;

// ── the booted package
let currentPackage: PackageRecord | null = null;
/** the installed package this process booted, with its native libraries where the installer leaves them */
export function setManifest(root: XmlNode): void {
  currentPackage = packages.get(attrStr(root, "package") ?? "") ?? null;
  if (currentPackage) linkerHooks.appLib = extractNativeLibraries(currentPackage);
}
/** the splits installed beside the booted package's base; this process holds no other package's */
const ownSplits = (record: PackageRecord): PackageRecord["splits"] => record === currentPackage && appHost ? record.splits : [];
const splitNames = (record: PackageRecord) => ownSplits(record).map((split) => split.name);

// ── native libraries, laid out as PackageAbiHelper derives them for a cluster install
const INSTRUCTION_SETS: Record<string, string> = { "arm64-v8a": "arm64", "armeabi-v7a": "arm", armeabi: "arm", x86_64: "x86_64", x86: "x86" };
/** primaryCpuAbi: the ABI of the package's libraries a process here loads, null when it ships none */
const primaryAbi = (record: PackageRecord): string | null =>
  libraryAbi(record === currentPackage ? rt.classpathNames() : [...Object.keys(record.apk.zip), ...record.apk.lazyEntries.keys()]);
const nativeLibraryRoot = (record: PackageRecord): string => `${record.path.slice(0, record.path.lastIndexOf("/"))}/lib`;
/** <codePath>/lib/<instruction set>, the device's own when the package ships no libraries */
const nativeLibraryDir = (record: PackageRecord, abi: string | null): string => `${nativeLibraryRoot(record)}/${INSTRUCTION_SETS[abi ?? ABIS_64[0]]}`;
/** The installer's copy of the booted package's primary-ABI libraries into its nativeLibraryDir,
 *  which ClassLoader.findLibrary searches; extractNativeLibs="false" leaves them in the apk. The
 *  path the linker names lib/<abi>/<name> by: its extracted copy, else the entry of the apk holding
 *  it, mapped from there when stored uncompressed. */
function extractNativeLibraries(record: PackageRecord): typeof linkerHooks.appLib {
  const abi = primaryAbi(record), extracted = !!abi && record.flag(record.application, "extractNativeLibs", true);
  const dir = nativeLibraryDir(record, abi), prefix = `lib/${abi}/`;
  if (extracted) for (const name of rt.classpathNames()) if (name.startsWith(prefix) && name.endsWith(".so") && !name.includes("/", prefix.length))
    vfs.mount(dir + name.slice(prefix.length - 1), classpathFile(name));
  const apks = [record.path, ...ownSplits(record).map((split) => apkPath(split.name))], dirs = new Map<string, Promise<Map<string, ZEntry>>>();
  return (entryAbi, name) => extracted && entryAbi === abi ? { path: `${dir}/${name}` } : (async () => {
    const entry = `lib/${entryAbi}/${name}`;
    for (const apk of apks) {
      const source = vfs.source(apk);
      if (!source) continue;
      let entries = dirs.get(apk);
      if (!entries) dirs.set(apk, entries = centralDirOfSource(source));
      const e = (await entries).get(entry);
      if (e) return { path: archivePath(apk, entry), mapped: e.method === 0 ? { path: apk, offset: await localDataOffset(source, e) } : undefined };
    }
    return { path: archivePath(record.path, entry) };
  })();
}
/** a class path entry as a file, sized without inflating or fetching it; reading it inflates natively */
function classpathFile(name: string): FileSource {
  const resident = Object.hasOwn(rt.classpath, name);
  return {
    size: resident ? treeEntrySize(rt.classpath, name) : rt.classpathSource!.entrySize(name),
    read: async (offset, length) => {
      if (resident) await inflateTree(rt.classpath, (entry) => entry === name);
      return (await rt.readClasspath(name))!.subarray(offset, offset + length);
    },
  };
}

// ── the parsed manifest, read as ParsingPackageUtils reads it. The Java side is built in generators
// that Runtime.drive runs on the calling thread, synchronously until something suspends.
const resolvedLabel = (node: XmlNode | null | undefined) => {
  const label = node ? attr(node, "label") : undefined;
  return label?.type === TV.REFERENCE ? { labelRes: label.data, nonLocalizedLabel: null } : { labelRes: 0, nonLocalizedLabel: label?.str ?? null };
};
const intAttr = (node: XmlNode | null | undefined, name: string, def: number) => (node ? attr(node, name)?.data : undefined) ?? def;
/** <meta-data> children → Bundle, typed the way aapt encoded them (string / boolean / int). */
function* metaData$(node: XmlNode | null | undefined, res: Resources): Gen<JObj | null> {
  const items = node?.children.filter((md) => md.name === "meta-data") ?? [];
  if (!items.length) return null;
  const bundle: JObj = yield newObj("android/os/Bundle");
  const put = (setter: string, desc: string, key: string, value: unknown) => vcall(bundle, setter, `(Ljava/lang/String;${desc})V`, key, value);
  for (const md of items) {
    const key = attrStr(md, "name");
    if (key === null) continue;
    // android:resource stays the id; android:value is read through the app's resources, as the
    // package parser's TypedArray.peekValue resolves references before choosing the setter
    const resource = attr(md, "resource"), raw = attr(md, "value") ?? resource;
    if (!raw) { yield put("putString", "Ljava/lang/String;", key, null); continue; }
    if (resource) { yield put("putInt", "I", key, raw.data); continue; }
    const v = resolved(res, raw.type, raw.data);
    if (v.t === TV.STRING) yield put("putString", "Ljava/lang/String;", key, v.pkg < 0 ? raw.str : res.string(v));
    else if (v.t === TV.BOOLEAN) yield put("putBoolean", "Z", key, v.d ? 1 : 0);
    else if (v.t === TV.FLOAT) yield put("putFloat", "F", key, intBitsToFloat(v.d));
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
  if (record.flag(record.root, "isolatedSplits", false)) flags |= 0x8000; // PRIVATE_FLAG_ISOLATED_SPLIT_LOADING
  if (record.flag(app, "debuggable", false) || app?.children.some((n) => n.name === "profileable" && record.flag(n, "shell", false))) flags |= 0x800000;
  if (!record.flag(app, "directBootAware", false) && Object.values(record.components).some((kind) => [...kind.values()].some((n) => record.flag(n, "directBootAware", false))))
    flags |= 0x100; // PRIVATE_FLAG_PARTIALLY_DIRECT_BOOT_AWARE
  if ([...record.components.activity.values()].some((n) => anyFilter(n, hasWebLinks))) flags |= 0x10;
  return flags;
}
/** an intent filter's <action> or <category> of that name */
const filterHas = (filter: XmlNode, kind: string, name: string) => filter.children.some((n) => n.name === kind && attrStr(n, "name") === name);
/** a component node with an intent filter `test` accepts */
const anyFilter = (node: XmlNode, test: (filter: XmlNode) => boolean) => node.children.some((f) => f.name === "intent-filter" && test(f));
/** a filter a browser hands web links to: VIEW, BROWSABLE, and an http(s) scheme */
const hasWebLinks = (filter: XmlNode) => filterHas(filter, "action", "android.intent.action.VIEW") && filterHas(filter, "category", "android.intent.category.BROWSABLE") &&
  filter.children.some((n) => n.name === "data" && ["http", "https"].includes(attrStr(n, "scheme") ?? ""));
const privateFlagsExt = (record: PackageRecord) => {
  const app = record.application, profileable = app?.children.find((n) => n.name === "profileable");
  return (record.flag(profileable, "enabled", true) ? 1 : 0) | (record.flag(app, "enableOnBackInvokedCallback", false) ? 8 : 0);
};

/** SplitAssetDependencyLoader.createDependenciesFromPackage: the base is index 0 and split i is i + 1. A feature split
 *  depends on the split it uses, else the base; each config split follows the split it configures */
function* splitDependencies$({ splits }: PackageRecord): Gen<JObj> {
  const index = (name: string | null) => name ? splits.findIndex((split) => split.name === name) + 1 : 0;
  const dependencies = new Map<number, number[]>([[0, [-1]]]);
  splits.forEach(({ feature, uses }, i) => { if (feature) dependencies.set(i + 1, [index(uses)]); });
  splits.forEach(({ feature, configFor }, i) => {
    if (feature) return;
    const target = index(configFor);
    dependencies.set(target, [...dependencies.get(target) ?? [], i + 1]);
  });
  const array: JObj = yield newObj("android/util/SparseArray", "()V");
  for (const [split, on] of dependencies) yield vcall(array, "put", "(ILjava/lang/Object;)V", split, Int32Array.from(on));
  return array;
}
/** the ApplicationInfo PackageInfoUtils.generateApplicationInfo makes for `flags` */
function* buildApplicationInfo$(record: PackageRecord, flags: number): Gen<JObj> {
  const ai: JObj = yield newObj(APP), app = record.application, pkg = record.pkg, { min, target } = record.sdk;
  const own = ownSplits(record), splits = own.length ? own.map((split) => split.name) : null;
  const abi = primaryAbi(record);
  const qualified = (name: string) => { const value = app && attrStr(app, name); return value ? qualifyComponent(value, pkg) : null; };
  const className = qualified("name");
  setDeclared(ai, APP, {
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
    splitNames: splits && strArray(splits),
    splitSourceDirs: splits && jarray(splits.map((n) => apkPath(n)), "Ljava/lang/String;"),
    splitPublicSourceDirs: splits && jarray(splits.map((n) => apkPath(n)), "Ljava/lang/String;"),
    splitClassLoaderNames: splits && jarray(own.map(({ manifest }) => { const split = applicationOf(manifest); return split && attrStr(split, "classLoader"); }), "Ljava/lang/String;"),
    splitDependencies: splits && record.flag(record.root, "isolatedSplits", false) ? yield* splitDependencies$(record) : null,
    primaryCpuAbi: abi, nativeLibraryRootDir: nativeLibraryRoot(record), nativeLibraryRootRequiresIsa: 1,
    nativeLibraryDir: nativeLibraryDir(record, abi), dataDir: `/data/data/${pkg}`, credentialProtectedDataDir: `/data/data/${pkg}`,
    deviceProtectedDataDir: `/data/user_de/0/${pkg}`, storageUuid: yield uuidDefault(),
    enabled: record.enabled ? 1 : 0, enabledSetting: 0, category: intAttr(app, "appCategory", -1),
    networkSecurityConfigRes: intAttr(app, "networkSecurityConfig", 0),
    targetSandboxVersion: intAttr(record.root, "targetSandboxVersion", 1), installLocation: intAttr(record.root, "installLocation", -1),
    appComponentFactory: qualified("appComponentFactory"), backupAgentName: qualified("backupAgent"), manageSpaceActivityName: qualified("manageSpaceActivity"),
    zygotePreloadName: qualified("zygotePreloadName"), classLoaderName: app ? attrStr(app, "classLoader") : null,
    descriptionRes: intAttr(app, "description", 0), uiOptions: intAttr(app, "uiOptions", 0),
    fullBackupContent: intAttr(app, "fullBackupContent", 0), dataExtractionRulesRes: intAttr(app, "dataExtractionRules", 0),
    localeConfigRes: intAttr(app, "localeConfig", 0),
  });
  if (flags & GET_SHARED_LIBRARY_FILES && record.usesLibraries.length) {
    // SystemConfig's builtin libraries, which the platform package declares; each code path after its dependencies'
    const infos = new Map<string, JObj>(), files: string[] = [];
    const library$ = function* (name: string): Gen<JObj> {
      const known = infos.get(name);
      if (known) return known;
      const { path, dependencies } = SHARED_LIBRARIES[name];
      const info: JObj = yield newObj("android/content/pm/SharedLibraryInfo", "(Ljava/lang/String;Ljava/lang/String;Ljava/util/List;Ljava/lang/String;JILandroid/content/pm/VersionedPackage;Ljava/util/List;Ljava/util/List;Z)V",
        path, null, null, name, -1n, 0, yield newObj("android/content/pm/VersionedPackage", "(Ljava/lang/String;J)V", "android", 0n), null, null, 0);
      infos.set(name, info);
      for (const dependency of dependencies) yield vcall(info, "addDependency", "(Landroid/content/pm/SharedLibraryInfo;)V", yield* library$(dependency));
      files.push(path);
      return info;
    };
    const used: JObj[] = [];
    for (const name of record.usesLibraries) used.push(yield* library$(name));
    setDeclared(ai, APP, { sharedLibraryFiles: strArray(files), sharedLibraryInfos: yield newArrayList(used) });
  }
  return ai;
}
export const longVersionCode = (root: XmlNode) => BigInt((attr(root, "versionCode")?.data ?? 0) >>> 0) | BigInt(attr(root, "versionCodeMajor")?.data ?? 0) << 32n;

const appInfos = new WeakMap<PackageRecord, Map<number, () => PromiseOrVal<JObj>>>();
/** the package's ApplicationInfo for these flags; equal answers share one, which each caller gets a
 *  copy of. A build in flight is shared through `once`: its pending drive is a suspension that
 *  another caller's frames would join, resuming inside the first caller's stack. */
function applicationInfoOf(record: PackageRecord, flags: number): PromiseOrVal<JObj> {
  const key = flags & (GET_META_DATA | GET_SHARED_LIBRARY_FILES);
  let cache = appInfos.get(record);
  if (!cache) appInfos.set(record, cache = new Map());
  let info = cache.get(key);
  if (!info) cache.set(key, info = once(() => rt.drive(buildApplicationInfo$(record, key))));
  return info();
}
function* applicationInfo$(record: PackageRecord, flags: number): Gen<JObj> {
  return yield newObj("android/content/pm/ApplicationInfo", "(Landroid/content/pm/ApplicationInfo;)V", yield* awaited(applicationInfoOf(record, flags)));
}

// ── components
interface Component { owner: PackageRecord; kind: ComponentKind; name: string; node: XmlNode }
interface Match extends Component { priority: number; isDefault: boolean }
const hasFilters = (node: XmlNode) => node.children.some((n) => n.name === "intent-filter");
/** ComponentInfo.exported: declared, else whether it has an intent filter (a provider: below API 17) */
export const exported = (c: Component): boolean => c.owner.flag(c.node, "exported", c.kind === "provider" ? c.owner.sdk.target < 17 : hasFilters(c.node));
/** the component's own permission, else its application's */
export const componentPermission = (c: Component): string | null =>
  attrStr(c.node, "permission") ?? (c.kind !== "provider" && c.owner.application ? attrStr(c.owner.application, "permission") : null);
export const componentProcess = (c: Component): string => c.owner.process(c.node);
const directBootAware = (c: Component) => c.owner.flag(c.node, "directBootAware", c.owner.flag(c.owner.application, "directBootAware", false));

function componentEnabled(c: Component): boolean {
  const state = componentState.get({ pkg: c.owner.pkg, cls: c.name }) ?? 0;
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
  setDeclared(o, COMPONENT, {
    ...resolvedLabel(c.node), name: c.name, packageName: c.owner.pkg, icon: intAttr(c.node, "icon", 0),
    logo: intAttr(c.node, "logo", 0), banner: intAttr(c.node, "banner", 0),
    metaData: flags & GET_META_DATA ? yield* metaData$(c.node, c.owner.res) : null,
    applicationInfo: app ?? (yield* applicationInfo$(c.owner, flags)), processName: componentProcess(c),
    descriptionRes: intAttr(c.node, "description", 0), enabled: c.owner.flag(c.node, "enabled", true) ? 1 : 0,
    exported: exported(c) ? 1 : 0, directBootAware: directBootAware(c) ? 1 : 0, attributionTags: NO_STRINGS,
    splitName: c.owner.splitOf.get(c.node) ?? null,
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
  const info: JObj = yield newObj(ACTIVITY);
  yield* componentInfo$(info, c, flags, app);
  setDeclared(info, ACTIVITY, { taskAffinity: manifestAffinity(c), permission: componentPermission(c), flags: activityFlags(c) });
  // an activity is relaunched for an MCC/MNC change only when it asks to be (recreateOnConfigChanges)
  if (c.kind === "activity") setDeclared(info, ACTIVITY, {
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
  const info: JObj = yield newObj(SERVICE);
  yield* componentInfo$(info, c, flags, app);
  setDeclared(info, SERVICE, {
    permission: componentPermission(c), mForegroundServiceType: intAttr(c.node, "foregroundServiceType", 0),
    flags: bitsOf(c.owner, c.node, [["stopWithTask", 1, false], ["isolatedProcess", 2, false], ["externalService", 4, false],
      ["useAppZygote", 8, false], ["singleUser", 0x40000000, false]]),
  });
  return info;
}
const authoritiesOf = (node: XmlNode) => (attrStr(node, "authorities") ?? "").split(";").filter(Boolean);
function* providerInfo$(c: Component, flags: number, app: JObj | null): Gen<JObj> {
  const info: JObj = yield newObj(PROVIDER), permission = attrStr(c.node, "permission");
  yield* componentInfo$(info, c, flags, app);
  setDeclared(info, PROVIDER, {
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
const handlesAction = (node: XmlNode, action: string) => anyFilter(node, (f) => filterHas(f, "action", action));

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
        const filter: JObj = yield* manifestFilter$(node, owner.res);
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
  const info: JObj = yield newObj(RESOLVE), activity: JObj = yield newObj(ACTIVITY), platform = packages.get("android");
  setDeclared(activity, ACTIVITY, { name: SYSTEM_ACTIVITY, packageName: "android", processName: "system", exported: 1, enabled: 1,
    applicationInfo: platform ? yield* applicationInfo$(platform, 0) : null });
  setDeclared(info, RESOLVE, { activityInfo: activity });
  return info;
}
const answersSystem = (q: IntentQuery) => !!systemActivity(q) && (!q.pkg || q.pkg === "android");
function* resolveInfo$(m: Match, flags: number): Gen<JObj> {
  const info: JObj = yield newObj(RESOLVE), component: JObj = yield* infoOf$(m, flags);
  setDeclared(info, RESOLVE, {
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
  if (kind === "provider") for (const [authority, p] of systemProviders) if (p.action && (!q.action || p.action === q.action))
    infos.push(setDeclared(yield newObj(RESOLVE), RESOLVE, { providerInfo: yield* systemProviderInfo$(authority) }));
  return infos;
}
export const resolveService = driven(function* resolveService$(intent: JObj): Gen<Match | null> {
  return (yield* queryComponents$(yield* intentQuery$(intent), 0, "service"))[0] ?? null;
});
export const queryReceivers = driven(function* queryReceivers$(intent: JObj): Gen<Match[]> {
  return yield* queryComponents$(yield* intentQuery$(intent), 0, "receiver");
});

/** the installed provider for an authority (ComputerEngine.resolveContentProvider) */
export function resolveProvider(authority: string, flags = 0): Component | null {
  for (const owner of packages.values()) for (const c of components(owner, "provider", flags))
    if (authoritiesOf(c.node).includes(authority)) return c;
  return null;
}
/** the launcher activity of a package, as getLaunchIntentForPackage finds it */
export function launcherActivity(pkg: string): Component | null {
  const owner = packages.get(pkg);
  return owner ? components(owner, "activity", 0).find((c) => anyFilter(c.node, (f) => filterHas(f, "category", "android.intent.category.LAUNCHER"))) ?? null : null;
}

/** a declared permission's PermissionInfo */
export function* permissionInfo$(owner: PackageRecord, node: XmlNode, flags: number): Gen<JObj> {
  const info: JObj = yield newObj(PKG + "PermissionInfo");
  setDeclared(info, PKG + "PermissionInfo", {
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
  for (const c of certificates) signatures.push(yield newObj(PKG + "Signature", "([B)V", new Int8Array(c)));
  return jarray(signatures, "Landroid/content/pm/Signature;");
}
/** SigningInfo over the signers, with no rotation history; which scheme signed is not tracked (UNKNOWN) */
function* signingInfo$(certificates: Uint8Array[]): Gen<JObj> {
  const details = yield newObj(PKG + "SigningDetails", "([Landroid/content/pm/Signature;I)V", yield* signatureArray$(certificates), 0);
  return yield newObj(PKG + "SigningInfo", "(Landroid/content/pm/SigningDetails;)V", details);
}
function* featureInfo$(name: string | null, flags = 0, glEs = 0): Gen<JObj> {
  const info: JObj = yield newObj(PKG + "FeatureInfo");
  setDeclared(info, PKG + "FeatureInfo", { name, flags, reqGlEsVersion: glEs });
  return info;
}
function* instrumentationInfo$(record: PackageRecord, node: XmlNode, flags: number): Gen<JObj> {
  const item: JObj = yield newObj(PKG + "InstrumentationInfo");
  setDeclared(item, PKG + "InstrumentationInfo", {
    ...resolvedLabel(node), name: qualifyComponent(attrStr(node, "name") ?? "", record.pkg), packageName: record.pkg,
    targetPackage: attrStr(node, "targetPackage"), targetProcesses: attrStr(node, "targetProcesses"),
    handleProfiling: record.flag(node, "handleProfiling", false) ? 1 : 0, functionalTest: record.flag(node, "functionalTest", false) ? 1 : 0,
    sourceDir: record.path, publicSourceDir: record.path, dataDir: `/data/data/${record.pkg}`,
    metaData: flags & GET_META_DATA ? yield* metaData$(node, record.res) : null,
  });
  return item;
}
function* packageInfo$(record: PackageRecord, flags: number): Gen<JObj> {
  const pi: JObj = yield newObj(PACKAGE), root = record.root, app: JObj = yield* applicationInfo$(record, flags);
  const version = attr(root, "versionName");
  const splits = splitNames(record);
  const time = installTime(record.pkg);
  setDeclared(pi, PACKAGE, {
    packageName: record.pkg, splitNames: strArray(splits), splitRevisionCodes: new Int32Array(splits.length),
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
    if (items.length) setDeclared(pi, PACKAGE, { [name]: jarray(yield* all$(items, (c) => infoOf$(c, flags, app)), `L${cls};`) });
  }
  const instrumentation = flags & GET_INSTRUMENTATION ? root.children.filter((n) => n.name === "instrumentation") : [];
  if (instrumentation.length) setDeclared(pi, PACKAGE, { instrumentation:
    jarray(yield* all$(instrumentation, (node) => instrumentationInfo$(record, node, flags)), "Landroid/content/pm/InstrumentationInfo;") });
  if (flags & GET_PERMISSIONS) {
    const declared = root.children.filter((n) => n.name === "permission");
    if (declared.length) setDeclared(pi, PACKAGE, { permissions: jarray(yield* all$(declared, (n) => permissionInfo$(record, n, flags)), "Landroid/content/pm/PermissionInfo;") });
    const requested = [...record.requested], granted: number[] = [];
    for (const name of requested) granted.push(yield* awaited(checkPermission(name, record.pkg)));
    // REQUESTED_PERMISSION_REQUIRED, and REQUESTED_PERMISSION_GRANTED when held
    if (requested.length) setDeclared(pi, PACKAGE, { requestedPermissions: jarray(requested, "Ljava/lang/String;"),
      requestedPermissionsFlags: Int32Array.from(granted, (result) => 1 | (result === 0 ? 2 : 0)) });
  }
  const features = flags & GET_CONFIGURATIONS ? root.children.filter((n) => n.name === "uses-feature") : [];
  if (features.length) setDeclared(pi, PACKAGE, { reqFeatures: jarray(yield* all$(features, (n) =>
    featureInfo$(attrStr(n, "name"), record.flag(n, "required", true) ? 1 : 0, intAttr(n, "glEsVersion", 0))), "Landroid/content/pm/FeatureInfo;") });
  if (flags & (GET_SIGNATURES | GET_SIGNING_CERTIFICATES)) {
    const certificates = yield* awaited(record.visibleCertificates());
    if (flags & GET_SIGNATURES) setDeclared(pi, PACKAGE, { signatures: yield* signatureArray$(certificates) });
    if (flags & GET_SIGNING_CERTIFICATES) setDeclared(pi, PACKAGE, { signingInfo: yield* signingInfo$(certificates) });
  }
  return pi;
}

// There is no IncFS: no file is incremental and none carries a v4 signature, so
// ApkSignatureVerifier reads the APK's v3/v2/v1 signatures
rt.registerJnis("android/os/incremental/IncrementalManager", {
  "nativeIsEnabled()Z": () => 0, "nativeIsV2Available()Z": () => 0,
  "nativeIsIncrementalFd(I)Z": () => 0, "nativeIsIncrementalPath(Ljava/lang/String;)Z": () => 0,
  "nativeUnsafeGetFileSignature(Ljava/lang/String;)[B": () => null,
});
// ── checksums and signatures
const wholeChecksumAlgorithms: readonly [number, string][] = [[2, "MD5"], [4, "SHA-1"], [8, "SHA-256"], [16, "SHA-512"]];
async function apkDigests(record: PackageRecord, includeSplits: boolean, required: number): Promise<[string | null, number, Uint8Array][]> {
  const files: [string | null, string][] = [[null, record.path]];
  if (includeSplits) files.push(...splitNames(record).map((name): [string, string] => [name, apkPath(name)]));
  const result: [string | null, number, Uint8Array][] = [];
  for (const [splitName, path] of files) {
    const bytes = await vfs.readFile(path);
    if (!bytes) continue;
    for (const [type, algorithm] of wholeChecksumAlgorithms) {
      if (!(required & type)) continue;
      const value = await digestBytes(algorithm, bytes);
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

function* componentArgs$(component: JObj | null): Gen<[string, string]> {
  if (!component) rt.npe();
  return [yield vcall(component, "getPackageName", "()Ljava/lang/String;"), yield vcall(component, "getClassName", "()Ljava/lang/String;")];
}
const flag = (flags: bigint) => Number(BigInt.asIntN(32, flags));
const componentInfoFor = (kind: ComponentKind) => driven(function* componentInfoFor$(component: JObj | null, flags: bigint): Gen<JObj | null> {
  const [pkg, cls] = yield* componentArgs$(component), c = lookup(pkg, cls, kind, flag(flags));
  return c ? yield* infoOf$(c, flag(flags)) : null;
});
const queryFor = (kind: ComponentKind, best: boolean) => driven(function* queryFor$(intent: JObj | null, type: string | null, flags: bigint): Gen {
  const infos = yield* queryIntent$(intent, type, flag(flags), kind);
  return best ? infos[0] ?? null : parceledList(infos);
});
const unknownPackage = (pkg: string) => rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown package: " + pkg);

// PackageManager.Property: a manifest <property> of the application or a component, as the package
// parser reads it (a resource reference, else a boolean, integer, float or string value)
const COMPONENT_TYPES: [number, ComponentKind | null][] = [[1, null], [2, "activity"], [3, "provider"], [4, "receiver"], [5, "service"]];
function propertyOf(owner: PackageRecord, node: XmlNode, cls: string | null): PromiseOrVal<JObj> | null {
  const name = attrStr(node, "name");
  if (!name) return null;
  const P = PKG + "PackageManager$Property", resource = attr(node, "resource"), value = attr(node, "value");
  if (resource) return newObj(P, `(${S}IZ${S}${S})V`, name, resource.data, 1, owner.pkg, cls);
  if (!value) return null;
  if (value.type === TV.BOOLEAN) return newObj(P, `(${S}Z${S}${S})V`, name, +!!value.data, owner.pkg, cls);
  if (value.type === TV.FLOAT) return newObj(P, `(${S}F${S}${S})V`, name, intBitsToFloat(value.data), owner.pkg, cls);
  if (value.type >= TV.INT_DEC && value.type <= TV.COLOR_RGB4) return newObj(P, `(${S}I${S}${S})V`, name, value.data, owner.pkg, cls);
  return newObj(P, `(${S}${S}${S}${S})V`, name, value.str ?? attrStr(node, "value") ?? "", owner.pkg, cls);
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
      if (child.name === "property" && attrStr(child, "name") === name) { const p = propertyOf(owner, child, cls); if (p) out.push(yield* awaited(p)); }
  }
  return out;
}
const S = "Ljava/lang/String;", INTENT = "Landroid/content/Intent;", CN = "Landroid/content/ComponentName;", SLICE = "Landroid/content/pm/ParceledListSlice;";
hostService("package", "webdroid/PackageManagerService", "android/content/pm/IPackageManager$Stub", {
  [`getPackageInfo(${S}JI)Landroid/content/pm/PackageInfo;`]: driven(function* getPackageInfo$(pkg: string, flags: bigint): Gen {
    const record = packages.get(pkg);
    return record ? yield* packageInfo$(record, flag(flags)) : null;
  }),
  [`getApplicationInfo(${S}JI)Landroid/content/pm/ApplicationInfo;`]: driven(function* getApplicationInfo$(pkg: string, flags: bigint): Gen {
    const record = packages.get(pkg);
    return record ? yield* applicationInfo$(record, flag(flags)) : null;
  }),
  [`getPackageUid(${S}JI)I`]: (pkg: string) => packages.get(pkg)?.uid ?? -1,
  [`getTargetSdkVersion(${S})I`]: (pkg: string) => packages.get(pkg)?.sdk.target ?? -1,
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
    if (systemProviders.has(authority)) return yield* systemProviderInfo$(authority);
    const c = resolveProvider(authority, flag(flags));
    return c ? yield* providerInfo$(c, flag(flags), null) : null;
  }),
  [`queryContentProviders(${S}IJ${S})${SLICE}`]: driven(function* queryContentProviders$(process: string | null, uid: number, flags: bigint, metaDataKey: string | null): Gen {
    const out = process === null && metaDataKey === null ? yield* all$([...systemProviders.keys()], systemProviderInfo$) : [];
    const own: [number, JObj][] = [];
    for (const owner of packages.values()) for (const c of components(owner, "provider", flag(flags))) {
      if (!authoritiesOf(c.node).length || process !== null && (componentProcess(c) !== process || owner.uid !== uid)) continue;
      if (metaDataKey !== null && !c.node.children.some((n) => n.name === "meta-data" && attrStr(n, "name") === metaDataKey)) continue;
      own.push([attr(c.node, "initOrder")?.data ?? 0, yield* providerInfo$(c, flag(flags), null)]);
    }
    // sProviderInitOrderSorter: by descending initOrder, the order ActivityThread installs them in
    return parceledList([...out, ...own.sort((a, b) => b[0] - a[0]).map(([, info]) => info)]);
  }),
  [`getComponentEnabledSetting(${CN}I)I`]: driven(function* getComponentEnabledSetting$(c: JObj): Gen {
    const [pkg, cls] = yield* componentArgs$(c);
    return componentState.get({ pkg, cls: qualifyComponent(cls, pkg) }) ?? 0;
  }),
  [`setComponentEnabledSetting(${CN}IIILjava/lang/String;)V`]: driven(function* setComponentEnabledSetting$(c: JObj, state: number): Gen {
    const [pkg, cls] = yield* componentArgs$(c);
    if (state < 0 || state > 4) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid new component state: " + state);
    if (!packages.has(pkg)) throw unknownPackage(pkg);
    componentState.set({ pkg, cls: qualifyComponent(cls, pkg) }, state);
  }),
  [`getApplicationEnabledSetting(${S}I)I`]: (pkg: string) => { if (!packages.has(pkg)) throw unknownPackage(pkg); return 0; },
  [`hasSystemFeature(${S}I)Z`]: (name: string, version: number) => device.features.includes(name) && version <= 0 ? 1 : 0,
  "getSystemAvailableFeatures()Landroid/content/pm/ParceledListSlice;": driven(function* getSystemAvailableFeatures$(): Gen {
    return parceledList([...yield* all$(device.features, (name) => featureInfo$(name)), yield* featureInfo$(null, 0, GL_ES_VERSION)]);
  }),
  "getSystemSharedLibraryNames()[Ljava/lang/String;": () => jarray([], S),
  [`checkPermission(${S}${S}I)I`]: (permission: string, pkg: string) => checkPermission(permission, pkg),
  [`getInstallSourceInfo(${S}I)Landroid/content/pm/InstallSourceInfo;`]: driven(function* getInstallSourceInfo$(pkg: string): Gen {
    if (!packages.has(pkg)) return null;
    // APK loading has no Android installer of record or installer-supplied source metadata
    return newObj(PKG + "InstallSourceInfo", `(${S}Landroid/content/pm/SigningInfo;${S}${S}${S}I)V`, null, null, null, null, null, 0);
  }),
  [`getInstallerPackageName(${S})${S}`]: (pkg: string) => { if (!packages.has(pkg)) throw unknownPackage(pkg); return null; },
  "getPackageInstaller()Landroid/content/pm/IPackageInstaller;": () => installerService(),
  // DELETE_PACKAGES deletes without asking; the observer hears the result once the package is gone
  [`deletePackageAsUser(${S}ILandroid/content/pm/IPackageDeleteObserver;II)V`]: (pkg: string, version: number, observer: JObj | null) =>
    after(enforceDeletePackages(), () => detached(() => after(deleteVersioned(pkg, BigInt(version)), (code) => observer && oneway(observer, "packageDeleted", `(${S}I)V`, pkg, code)), logUncaught)),
  [`deletePackageVersioned(Landroid/content/pm/VersionedPackage;Landroid/content/pm/IPackageDeleteObserver2;II)V`]: driven(function* deletePackageVersioned$(versioned: JObj, observer: JObj | null): Gen {
    yield enforceDeletePackages();
    const pkg: string = yield vcall(versioned, "getPackageName", `()${S}`), version: bigint = yield vcall(versioned, "getLongVersionCode", "()J");
    detached(() => after(deleteVersioned(pkg, version), (code) => observer && oneway(observer, "onPackageDeleted", `(${S}I${S})V`, pkg, code, null)), logUncaught);
  }),
  // installs need no user approval here, so a package asking for the permission may request them
  [`canRequestPackageInstalls(${S}I)Z`]: (pkg: string) =>
    packages.get(pkg)?.requested.has("android.permission.REQUEST_INSTALL_PACKAGES") ? 1 : 0,
  [`isInstantApp(${S}I)Z`]: () => 0,
  [`isPackageSuspendedForUser(${S}I)Z`]: (pkg: string) => {
    if (!packages.has(pkg)) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown target package: " + pkg);
    return 0;
  },
  [`isPackageAvailable(${S}I)Z`]: (pkg: string) => packages.has(pkg) ? 1 : 0,
  "isSafeMode()Z": () => 0,
  [`queryProperty(${S}I)${SLICE}`]: driven(function* queryProperty$(name: string, type: number): Gen { return parceledList(yield* properties$(name, type)); }),
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
  [`getNameForUid(I)${S}`]: (uid: number) => uidPackages(uid)[0]?.pkg ?? null,
  [`getNamesForUids([I)[${S}`]: (uids: Int32Array) => jarray([...uids].map((uid) => uidPackages(uid)[0]?.pkg ?? null), S),
  [`getPackagesForUid(I)[${S}`]: (uid: number) => {
    const names = uidPackages(uid).map((p) => p.pkg);
    return names.length ? jarray(names, S) : null;
  },
  [`checkSignatures(${S}${S}I)I`]: async (a: string, b: string) => {
    const x = packages.get(a), y = packages.get(b);
    return x && y ? compareSignatures(await x.visibleCertificates(), await y.visibleCertificates()) : -4;
  },
  "checkUidSignatures(II)I": async (a: number, b: number) => {
    const x = uidPackages(a)[0], y = uidPackages(b)[0];
    return x && y ? compareSignatures(await x.visibleCertificates(), await y.visibleCertificates()) : -4;
  },
  [`hasSigningCertificate(${S}[BI)Z`]: async (pkg: string, certificate: Int8Array, type: number) => {
    const record = packages.get(pkg);
    return record ? certificateMatches(await record.visibleCertificates(), certificate, type) : 0;
  },
  "hasUidSigningCertificate(I[BI)Z": async (uid: number, certificate: Int8Array, type: number) => {
    for (const record of uidPackages(uid)) if (await certificateMatches(await record.visibleCertificates(), certificate, type)) return 1;
    return 0;
  },
  [`getInstalledPackages(JI)${SLICE}`]: driven(function* getInstalledPackages$(flags: bigint): Gen {
    return parceledList(yield* all$([...packages.values()], (record) => packageInfo$(record, flag(flags))));
  }),
  [`getInstalledApplications(JI)${SLICE}`]: driven(function* getInstalledApplications$(flags: bigint): Gen {
    return parceledList(yield* all$([...packages.values()], (record) => applicationInfo$(record, flag(flags))));
  }),
  [`requestPackageChecksums(${S}ZIILjava/util/List;Landroid/content/pm/IOnChecksumsReadyListener;I)V`]: driven(function* requestPackageChecksums$(
    pkg: string, includeSplits: number, _optional: number, required: number, _installers: unknown, listener: JObj): Gen {
    const record = packages.get(pkg);
    if (!record) throw rt.mkThrowable(PKG + "PackageManager$NameNotFoundException", pkg);
    const checksums: JObj[] = [];
    for (const [split, type, value] of yield* awaited(apkDigests(record, includeSplits !== 0, required)))
      checksums.push(yield newObj(PKG + "ApkChecksum", `(${S}I[B)V`, split, type, new Int8Array(value)));
    yield vcall(listener, "onChecksumsReady", "(Ljava/util/List;)V", yield newArrayList(checksums));
  }),
  ...noops(`notifyPackageUse(${S}I)V`, `notifyDexLoad(${S}Ljava/util/Map;${S})V`),
});

// a single-user device with no managed profile: nothing to reach across
hostService("crossprofileapps", "webdroid/CrossProfileAppsService", "android/content/pm/ICrossProfileApps$Stub", {
  [`getTargetUserProfiles(${S})Ljava/util/List;`]: () => newArrayList(),
  [`canInteractAcrossProfiles(${S})Z`]: () => 0,
  [`canRequestInteractAcrossProfiles(${S})Z`]: () => 0,
});

