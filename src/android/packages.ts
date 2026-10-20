import { attr, attrStr, TV, type XmlNode } from "./axml.ts";
import { normRV, resString, type Resources } from "./res.ts";
import { SHARED_LIBRARIES } from "../jvm/bootclasspath.ts";
import { device } from "../shell/config.ts";
import type { PackageState } from "../shell/packagedata.ts";

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

export class PackageRecord {
  readonly root: XmlNode; readonly res: Resources; readonly path: string; readonly uid: number; readonly certificates: () => Promise<Uint8Array[]>;
  readonly pkg: string;
  readonly application: XmlNode | null;
  readonly components: Record<ComponentKind, Map<string, XmlNode>> = {
    activity: new Map(), service: new Map(), receiver: new Map(), provider: new Map(),
  };
  /** the permissions the package requests (PackageInfo.requestedPermissions) */
  readonly requested: Set<string>;
  readonly grants = new Set<string>();
  system = false;
  compatibilityCertificates: Uint8Array[] | null = null;

  constructor(root: XmlNode, res: Resources, path: string,
    uid: number, certificates: () => Promise<Uint8Array[]>) {
    this.root = root; this.res = res; this.path = path; this.uid = uid; this.certificates = certificates;
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
export const signaturePermissions = new Set<string>();
const uids = new Map<string, number>();
let nextUid = 10001;
try {
  const saved: unknown = JSON.parse(globalThis.localStorage?.getItem("wd:package-uids") ?? "[]");
  if (Array.isArray(saved)) for (const entry of saved) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !Number.isInteger(entry[1]) || entry[1] < 10001) continue;
    uids.set(entry[0], entry[1]); nextUid = Math.max(nextUid, entry[1] + 1);
  }
} catch { /* storage can be unavailable */ }


/** PackageManager component enabled states an app set (DEFAULT until then); part of the
 *  install like firstInstallTime, so they survive a reboot and go with wd.reset */
type Component = { pkg: string; cls: string };
export const componentState = {
  key: (c: Component) => "wd:install:" + c.pkg + ":component:" + c.cls,
  get(c: Component): number { return Number(globalThis.localStorage?.getItem(this.key(c)) ?? 0); },
  set(c: Component, st: number) { try { globalThis.localStorage?.setItem(this.key(c), String(st)); } catch { /* private mode */ } },
};

/**
 * When this package was installed, epoch ms. An app's data directory IS its installation
 * here, so the first boot that has no persisted state is the install, and the timestamp is
 * kept with that state until the package is removed. A package this process no longer has
 * (a request in flight across its removal) records none.
 */
export function installTime(pkg: string): bigint {
  const key = "wd:install:" + pkg;
  let ms = Number(globalThis.localStorage?.getItem(key) ?? 0);
  if (!ms) {
    ms = Date.now();
    try { if (packages.has(pkg)) globalThis.localStorage?.setItem(key, String(ms)); } catch { /* private mode */ }
  }
  return BigInt(ms);
}

/** the packages named by the persisted keys `prefix` + pkg (+ ":" + more) */
export function storedPackages(prefix: string): string[] {
  const names = new Set<string>(), storage = globalThis.localStorage;
  try {
    for (let i = 0; storage && i < storage.length; i++) {
      const key = storage.key(i)!, pkg = key.startsWith(prefix) ? key.slice(prefix.length).split(":")[0] : "";
      if (pkg) names.add(pkg);
    }
  } catch { /* storage can be unavailable */ }
  return [...names];
}
/** the uid a package was given, without assigning one */
export const knownUid = (pkg: string): number | undefined => packages.get(pkg)?.uid ?? uids.get(pkg);
/** the packages installed or with an install kept, whose removal drops the install state (its
 *  install time and what is kept with it) */
export const installData: PackageState = {
  remove(pkg) {
    const storage = globalThis.localStorage, key = "wd:install:" + pkg;
    try {
      for (let i = storage?.length ?? 0; i--;) { const k = storage!.key(i)!; if (k === key || k.startsWith(key + ":")) storage!.removeItem(k); }
    } catch { /* storage can be unavailable */ }
  },
  packages: () => [...packages.keys(), ...storedPackages("wd:install:")],
};
export function packageUid(pkg: string): number {
  const old = uids.get(pkg);
  if (old !== undefined) return old;
  const uid = nextUid++;
  uids.set(pkg, uid);
  try { globalThis.localStorage?.setItem("wd:package-uids", JSON.stringify([...uids])); } catch { /* storage can be unavailable */ }
  return uid;
}
