import { attr, attrStr, TV, type XmlNode } from "./axml.ts";
import { normRV, resString, type Resources } from "./res.ts";
import { SHARED_LIBRARIES } from "../jvm/bootclasspath.ts";
import { device } from "../shell/config.ts";
import type { PackageState } from "../shell/packagedata.ts";
import { persisted } from "../shell/device-storage.ts";
import { vfs } from "../shell/vfs.ts";
import { PackedArchive, packedArchives } from "../shell/packedarchive.ts";
import type { FileSource } from "../shell/lazyfile.ts";
import type { PackageArchive } from "./packagearchive.ts";

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

/** what provisioning gives a system package: its grants and the signatures it presents in place of its own */
export type Provisioned = { system?: boolean; grants?: Iterable<string>; signatures?: Uint8Array[] | null };
export class PackageRecord {
  readonly root: XmlNode; readonly res: Resources; readonly path: string; readonly uid: number; readonly certificates: () => Promise<Uint8Array[]>;
  readonly pkg: string;
  readonly application: XmlNode | null;
  readonly components: Record<ComponentKind, Map<string, XmlNode>> = {
    activity: new Map(), service: new Map(), receiver: new Map(), provider: new Map(),
  };
  /** the permissions the package requests (PackageInfo.requestedPermissions) */
  readonly requested: Set<string>;
  readonly system: boolean;
  readonly grants: ReadonlySet<string>;
  readonly compatibilityCertificates: Uint8Array[] | null;

  constructor(root: XmlNode, res: Resources, path: string,
    uid: number, certificates: () => Promise<Uint8Array[]>, { system = false, grants = [], signatures = null }: Provisioned = {}) {
    this.root = root; this.res = res; this.path = path; this.uid = uid; this.certificates = certificates;
    this.system = system; this.grants = new Set(grants); this.compatibilityCertificates = signatures;
    this.pkg = attrStr(root, "package") ?? "";
    this.application = root.children.find((n) => n.name === "application") ?? null;
    for (const node of this.application?.children ?? []) {
      const kind = node.name === "activity-alias" ? "activity" : node.name;
      if (kind !== "activity" && kind !== "service" && kind !== "receiver" && kind !== "provider") continue;
      const name = attrStr(node, "name");
      if (name) this.components[kind].set(qualifyComponent(name, this.pkg), node);
    }
    this.requested = requestedPermissions(root, usesSdk(root).target);
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
    return (value.type === TV.REFERENCE ? this.res.resolveRefs(normRV({ t: value.type, d: value.data })).d : value.data) !== 0;
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
/** a package's manifest and resources, with its signing certificates or how to read them */
type PackageContents = Pick<PackageArchive, "root" | "res"> & { certificates: Uint8Array[] | (() => Promise<Uint8Array[]>) };
/** a package the package manager knows, its base apk at `path` (`source`'s bytes, when given) */
export function registerPackage({ root, res, certificates }: PackageContents, { path, uid, source, ...provisioned }: Provisioned &
  { path?: string; uid?: number; source?: Uint8Array | FileSource } = {}): PackageRecord {
  const pkg = attrStr(root, "package") ?? "";
  path ??= installedPath(pkg);
  if (source instanceof Uint8Array) vfs.write(path, source);
  else if (source) vfs.mount(path, source);
  if (source instanceof PackedArchive) packedArchives.set(path, source);
  const record = new PackageRecord(root, res, path, uid ?? packageUid(pkg), typeof certificates === "function" ? certificates : () => Promise.resolve(certificates), provisioned);
  packages.set(pkg, record);
  return record;
}
/** a removed package leaves this process's package manager, with the archive it would register again from */
export function unregisterPackage(pkg: string): void {
  packages.delete(pkg);
  packedArchives.delete(installedPath(pkg));
  vfs.delete(installedPath(pkg));
}
/** the uids packages were given (wd:package-uids) */
const savedUids = persisted("wd:", (saved) => Array.isArray(saved) ? saved.filter((entry): entry is [string, number] =>
  Array.isArray(entry) && typeof entry[0] === "string" && Number.isInteger(entry[1]) && entry[1] >= 10001) : null);
const uids = new Map<string, number>();
let nextUid = 10001;
for (const [pkg, uid] of savedUids.get("package-uids") ?? []) { uids.set(pkg, uid); nextUid = Math.max(nextUid, uid + 1); }

/** what is kept with an install, by pkg (+ ":" + more): its install time and component states */
const install = persisted("wd:install:", (saved) => typeof saved === "number" ? saved : null);
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
/** the packages installed or with an install kept, whose removal drops the install state (its
 *  install time and what is kept with it) */
export const installData: PackageState = {
  remove(pkg) { for (const key of install.keys(pkg)) if (key === pkg || key.startsWith(pkg + ":")) install.remove(key); },
  packages: () => [...packages.keys(), ...install.packages()],
};
export function packageUid(pkg: string): number {
  const old = uids.get(pkg);
  if (old !== undefined) return old;
  const uid = nextUid++;
  uids.set(pkg, uid);
  savedUids.set("package-uids", [...uids]);
  return uid;
}
