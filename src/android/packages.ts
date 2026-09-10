import { attr, attrStr, type XmlNode } from "./axml";
import type { Resources } from "./res";

export type ComponentKind = "activity" | "service" | "receiver" | "provider";
export const qualifyComponent = (name: string, pkg: string): string => {
  name = name.replace(/\//g, ".");
  return name.startsWith(".") ? pkg + name : name.includes(".") ? name : pkg + "." + name;
};

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
  }

  process(node: XmlNode): string {
    const name = attrStr(node, "process") ?? (this.application && attrStr(this.application, "process")) ?? this.pkg;
    return name.startsWith(":") ? this.pkg + name : name;
  }

  get enabled(): boolean { return !this.application || attr(this.application, "enabled")?.data !== 0; }
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

export function packageUid(pkg: string): number {
  const old = uids.get(pkg);
  if (old !== undefined) return old;
  const uid = nextUid++;
  uids.set(pkg, uid);
  try { globalThis.localStorage?.setItem("wd:package-uids", JSON.stringify([...uids])); } catch { /* storage can be unavailable */ }
  return uid;
}
