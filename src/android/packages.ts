import { attr, attrStr, TV, type XmlNode } from "./axml";
import { normRV, type Resources } from "./res";
import { SHARED_LIBRARIES } from "../jvm/bootclasspath";

export type ComponentKind = "activity" | "service" | "receiver" | "provider";
export const qualifyComponent = (name: string, pkg: string): string => {
  name = name.replace(/\//g, ".");
  return name.startsWith(".") ? pkg + name : name.includes(".") ? name : pkg + "." + name;
};

/** CompatibilityPermissionInfo.COMPAT_PERMS: permissions later releases split out of default behaviour */
const COMPAT_PERMISSIONS: [string, number][] = [["android.permission.WRITE_EXTERNAL_STORAGE", 4],
  ["android.permission.READ_PHONE_STATE", 4], ["android.permission.POST_NOTIFICATIONS", 33]];
/** <uses-sdk>: targetSdkVersion defaults to minSdkVersion, which defaults to 1 */
export function usesSdk(root: XmlNode): { min: number; target: number } {
  const sdk = root.children.find((c) => c.name === "uses-sdk");
  const min = sdk && attr(sdk, "minSdkVersion")?.data || 1;
  return { min, target: sdk && attr(sdk, "targetSdkVersion")?.data || min };
}

export class PackageRecord {
  readonly pkg: string;
  readonly application: XmlNode | null;
  readonly components: Record<ComponentKind, Map<string, XmlNode>> = {
    activity: new Map(), service: new Map(), receiver: new Map(), provider: new Map(),
  };
  readonly permissions = new Set<string>();
  readonly grants = new Set<string>();
  system = false;
  compatibilityCertificates: Uint8Array[] | null = null;

  constructor(readonly root: XmlNode, readonly res: Resources, readonly path: string,
    readonly uid: number, readonly certificates: () => Promise<Uint8Array[]>) {
    this.pkg = attrStr(root, "package") ?? "";
    this.application = root.children.find((n) => n.name === "application") ?? null;
    for (const node of this.application?.children ?? []) {
      const kind = node.name === "activity-alias" ? "activity" : node.name;
      if (kind !== "activity" && kind !== "service" && kind !== "receiver" && kind !== "provider") continue;
      const name = attrStr(node, "name");
      if (name) this.components[kind].set(qualifyComponent(name, this.pkg), node);
    }
    for (const node of root.children) if (node.name === "uses-permission" || node.name === "uses-permission-sdk-23") {
      const name = attrStr(node, "name");
      if (name) this.permissions.add(name);
    }
    // ParsingPackageUtils: an app targeting below the release that introduced one of these requests it implicitly
    const { target } = usesSdk(root);
    for (const [name, since] of COMPAT_PERMISSIONS) if (target < since) this.permissions.add(name);
  }

  process(node: XmlNode): string {
    const name = attrStr(node, "process") ?? (this.application && attrStr(this.application, "process")) ?? this.pkg;
    return name.startsWith(":") ? this.pkg + name : name;
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
 * kept with that state (wd.reset wipes it along with the rest of the "install").
 */
export function installTime(pkg: string): bigint {
  const key = "wd:install:" + pkg;
  let ms = Number(globalThis.localStorage?.getItem(key) ?? 0);
  if (!ms) {
    ms = Date.now();
    try { globalThis.localStorage?.setItem(key, String(ms)); } catch { /* private mode */ }
  }
  return BigInt(ms);
}

export function packageUid(pkg: string): number {
  const old = uids.get(pkg);
  if (old !== undefined) return old;
  const uid = nextUid++;
  uids.set(pkg, uid);
  try { globalThis.localStorage?.setItem("wd:package-uids", JSON.stringify([...uids])); } catch { /* storage can be unavailable */ }
  return uid;
}
