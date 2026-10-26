import { attr, attrStr, TV, type XmlNode } from "./axml.ts";
import { Resources, resString, resolved, type Apk } from "./res.ts";
import { deviceQualifiers } from "./configuration.ts";
import { SHARED_LIBRARIES } from "../jvm/bootclasspath.ts";
import { device } from "../shell/config.ts";
import type { PackageState } from "../shell/packagedata.ts";
import { persisted } from "../shell/device-storage.ts";
import type { InstalledSplit } from "../shell/install.ts";

export type ComponentKind = "activity" | "service" | "receiver" | "provider";
/** PackageManager's flags, which IPackageManager takes as a long */
export const GET_ACTIVITIES = 1, GET_RECEIVERS = 2, GET_SERVICES = 4, GET_PROVIDERS = 8, GET_INSTRUMENTATION = 16, GET_SIGNATURES = 64,
  GET_META_DATA = 0x80, MATCH_DISABLED_COMPONENTS = 0x200, GET_SHARED_LIBRARY_FILES = 0x400, GET_URI_PERMISSION_PATTERNS = 0x800,
  GET_PERMISSIONS = 0x1000, GET_CONFIGURATIONS = 0x4000, MATCH_DEFAULT_ONLY = 0x10000, MATCH_DIRECT_BOOT_UNAWARE = 0x40000,
  MATCH_DIRECT_BOOT_AWARE = 0x80000, MATCH_SYSTEM_ONLY = 0x100000, GET_SIGNING_CERTIFICATES = 0x8000000, MATCH_DIRECT_BOOT_AUTO = 0x10000000;
export const qualifyComponent = (name: string, pkg: string): string => {
  name = name.replace(/\//g, ".");
  return name.startsWith(".") ? pkg + name : name.includes(".") ? name : pkg + "." + name;
};

/** CompatibilityPermissionInfo.COMPAT_PERMS: permissions later releases split out of default behaviour */
const COMPAT_PERMISSIONS: [string, number][] = [["android.permission.POST_NOTIFICATIONS", 33],
  ["android.permission.WRITE_EXTERNAL_STORAGE", 4], ["android.permission.READ_PHONE_STATE", 4]];
/** <uses-sdk>: targetSdkVersion defaults to minSdkVersion, which defaults to 1 */
export function usesSdk(root: XmlNode): { min: number; target: number } {
  const sdk = root.children.find((c) => c.name === "uses-sdk");
  const min = sdk && attr(sdk, "minSdkVersion")?.data || 1;
  return { min, target: sdk && attr(sdk, "targetSdkVersion")?.data || min };
}
/** ParsedActivityImpl.makeAlias: an <activity-alias> is its target declared earlier, but for the
 *  attributes AndroidManifestActivityAlias reads and those makeAlias leaves to the alias */
const ALIAS_OWN = new Set(["name", "label", "icon", "roundIcon", "logo", "banner", "description", "enabled", "exported", "permission",
  "targetActivity", "parentActivityName", "attributionTags"]);
const NOT_COPIED = new Set(["name", "enabled", "exported", "permission", "splitName", "persistableMode", "rotationAnimation", "colorMode", "attributionTags"]);
const alias = (node: XmlNode, target: XmlNode): XmlNode => ({ ...node,
  attrs: [...node.attrs.filter((a) => ALIAS_OWN.has(a.name)), ...target.attrs.filter((a) => !NOT_COPIED.has(a.name))] });
const USES_PERMISSION = new Set(["uses-permission", "uses-permission-sdk-23", "uses-permission-sdk-m"]);
/** parseMinOrMaxSdkVersion: an integer attribute, else `def` */
const sdkAttr = (node: XmlNode, name: string, def: number): number => {
  const value = attr(node, name);
  return value && value.type >= TV.INT_DEC && value.type <= TV.COLOR_RGB4 ? value.data : def;
};
/** ParsingPackageUtils.parseUsesPermission: what each <uses-permission> (-sdk-23, or its -sdk-m alias)
 *  requests on this release, within its minSdkVersion and maxSdkVersion, with its required features
 *  present and its required-not features absent; then the permissions convertCompatPermissions
 *  requests implicitly for an app targeting below their release */
function requestedPermissions(root: XmlNode, target: number): Set<string> {
  const requested = new Set<string>(), present = (feature: string) => device.features.includes(feature);
  for (const node of root.children) {
    const name = USES_PERMISSION.has(node.name) ? attrStr(node, "name") : null;
    if (!name || device.sdk < sdkAttr(node, "minSdkVersion", -Infinity) || device.sdk > sdkAttr(node, "maxSdkVersion", Infinity)) continue;
    const features = (tag: string, attribute: string) => [attrStr(node, attribute), ...node.children.filter((c) => c.name === tag).map((c) => attrStr(c, "name"))]
      .filter((feature) => feature !== null);
    if (features("required-feature", "requiredFeature").every(present) && !features("required-not-feature", "requiredNotFeature").some(present)) requested.add(name);
  }
  for (const [name, since] of COMPAT_PERMISSIONS) if (target < since) requested.add(name);
  return requested;
}

export const applicationOf = (manifest: XmlNode): XmlNode | null => manifest.children.find((n) => n.name === "application") ?? null;
/** what provisioning gives a system package: its grants and the signatures it presents in place of its own */
export type Provisioned = { system?: boolean; grants?: Iterable<string>; signatures?: Uint8Array[] | null };

export class PackageRecord {
  readonly root: XmlNode; readonly apk: Apk; readonly path: string; readonly uid: number; readonly certificates: () => Promise<Uint8Array[]>;
  readonly pkg: string;
  readonly application: XmlNode | null;
  readonly components: Record<ComponentKind, Map<string, XmlNode>> = {
    activity: new Map(), service: new Map(), receiver: new Map(), provider: new Map(),
  };
  /** the installed splits, sorted by name */
  readonly splits: readonly InstalledSplit[];
  /** the split a component loads from: the one declaring it, or its android:splitName */
  readonly splitOf = new Map<XmlNode, string>();
  /** the permissions the package requests (PackageInfo.requestedPermissions) */
  readonly requested: Set<string>;
  readonly system: boolean;
  readonly grants: ReadonlySet<string>;
  readonly compatibilityCertificates: Uint8Array[] | null;

  constructor(root: XmlNode, apk: Apk, path: string, uid: number, certificates: () => Promise<Uint8Array[]>,
    { system = false, grants = [], signatures = null, splits = [] }: Provisioned & { splits?: readonly InstalledSplit[] } = {}) {
    this.root = root; this.apk = apk; this.path = path; this.uid = uid; this.certificates = certificates;
    this.system = system; this.grants = new Set(grants); this.compatibilityCertificates = signatures; this.splits = splits;
    this.pkg = attrStr(root, "package") ?? "";
    this.application = applicationOf(root);
    // ParsingPackageUtils: each split's <application> adds its components to the base's
    for (const { name: split, manifest } of [{ name: null, manifest: root }, ...splits]) for (let node of applicationOf(manifest)?.children ?? []) {
      const kind = node.name === "activity-alias" ? "activity" : node.name;
      if (kind !== "activity" && kind !== "service" && kind !== "receiver" && kind !== "provider") continue;
      const name = attrStr(node, "name");
      if (!name) continue;
      const target = node.name === "activity-alias" && this.components.activity.get(qualifyComponent(attrStr(node, "targetActivity") ?? "", this.pkg));
      if (target) node = alias(node, target);
      this.components[kind].set(qualifyComponent(name, this.pkg), node);
      const splitName = attrStr(node, "splitName") ?? split;
      if (splitName) this.splitOf.set(node, splitName);
    }
    this.requested = requestedPermissions(root, usesSdk(root).target);
  }

  private resources: Resources | null = null;
  /** the package's resources over the framework's, under the device configuration, which
   *  PackageParser reads the manifest's references through */
  get res(): Resources {
    const framework = packages.get("android")?.apk ?? this.apk, q = deviceQualifiers();
    const r = this.resources ??= new Resources(framework === this.apk ? [this.apk] : [framework, this.apk], q);
    if (r.apks[0] !== framework) r.setApks([framework, this.apk]);
    if (r.qualifiers !== q) r.configure(q);
    return r;
  }

  process(node: XmlNode): string {
    const name = attrStr(node, "process") ?? (this.application && attrStr(this.application, "process")) ?? this.pkg;
    return name.startsWith(":") ? this.pkg + name : name;
  }

  /** the application's label as the launcher shows it, or the package name without one */
  label(): string {
    const value = this.application && attr(this.application, "label");
    return (value && (value.type === TV.REFERENCE ? resString(this.res, value.data) : value.str)) || this.pkg;
  }

  /** a boolean manifest attribute, read through this package's resources when it names one (@bool/...) */
  flag(node: XmlNode | null | undefined, name: string, def: boolean): boolean {
    const value = node ? attr(node, name) : undefined;
    if (!value) return def;
    return (value.type === TV.REFERENCE ? resolved(this.res, value.type, value.data).d : value.data) !== 0;
  }
  get enabled(): boolean { return this.flag(this.application, "enabled", true); }
  get sdk(): { min: number; target: number } { return usesSdk(this.root); }
  /** the device's libraries the package loads: those PackageBackwardCompatibility prefixes for older
   *  targets (OrgApacheHttpLegacyUpdater through O MR1, AndroidTestBaseUpdater through Q), then its
   *  own <uses-library> ones */
  get usesLibraries(): string[] {
    const { target } = this.sdk, names = [...target <= 29 ? ["android.test.base"] : [], ...target <= 27 ? ["org.apache.http.legacy"] : []];
    for (const node of this.application?.children ?? []) if (node.name === "uses-library") names.push(attrStr(node, "name") ?? "");
    return [...new Set(names)].filter((name) => Object.hasOwn(SHARED_LIBRARIES, name));
  }
  async visibleCertificates(): Promise<Uint8Array[]> { return this.compatibilityCertificates ?? this.certificates(); }
}

export const packages = new Map<string, PackageRecord>();
export const installedPath = (pkg: string): string => `/data/app/${pkg}/base.apk`;
/** the uids packages were given, which every process reads */
const savedUids = persisted("wd:package-uids", (saved) => Array.isArray(saved) ? saved.filter((entry): entry is [string, number] =>
  Array.isArray(entry) && typeof entry[0] === "string" && Number.isInteger(entry[1]) && entry[1] >= 10001) : null, { scope: "device-read" });
const uids = new Map<string, number>();
let nextUid = 10001;
for (const [pkg, uid] of savedUids.get("") ?? []) { uids.set(pkg, uid); nextUid = Math.max(nextUid, uid + 1); }

/** what is kept with an install, by pkg (+ ":" + more): its install time and component states, which
 *  every process reads */
const install = persisted("wd:install:", (saved) => typeof saved === "number" ? saved : null, { scope: "device-read" });
/** PackageManager component enabled states an app set (none, DEFAULT, until then); part of the
 *  install like firstInstallTime, so they survive a reboot and go with wd.reset */
type Component = { pkg: string; cls: string };
export const componentState = {
  get: (c: Component): number | null => install.get(c.pkg + ":component:" + c.cls) ?? null,
  set: (c: Component, st: number): void => { install.set(c.pkg + ":component:" + c.cls, st); },
};

/**
 * When this package was installed, epoch ms. An app's data directory IS its installation
 * here, so the first boot that has no persisted state is the install, and the timestamp is
 * kept with that state until the package is removed. A package this process no longer has
 * (a request in flight across its removal) records none.
 */
export function installTime(pkg: string): bigint {
  let ms = install.get(pkg);
  if (!ms) {
    ms = Date.now();
    if (packages.has(pkg)) install.set(pkg, ms);
  }
  return BigInt(ms);
}
/** `pkg` is installed under `uid`: a caller's claim to a package, as checkPackage verifies it */
export const ownedBy = (pkg: string | null, uid: number): boolean => pkg !== null && packages.get(pkg)?.uid === uid;
/** the installed packages under `uid`, as getPackagesForUid lists them */
export const uidPackages = (uid: number): PackageRecord[] => [...packages.values()].filter((p) => p.uid === uid);
/** the uid a package was given, without assigning one */
export const knownUid = (pkg: string): number | undefined => packages.get(pkg)?.uid ?? uids.get(pkg);
/** the packages installed or with an install kept, whose removal drops its install time and
 *  component states */
export const installData: PackageState = {
  remove(pkg) { for (const key of install.keys(pkg)) if (key === pkg || key.startsWith(pkg + ":")) install.remove(key); },
  packages: () => [...packages.keys(), ...install.packages()],
};
export function packageUid(pkg: string): number {
  const old = uids.get(pkg);
  if (old !== undefined) return old;
  const uid = nextUid++;
  uids.set(pkg, uid);
  savedUids.set("", [...uids]);
  return uid;
}
