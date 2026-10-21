// InstallPackageHelper's commit of a scanned package and RemovePackageHelper's removal: the record the
// package manager knows, with the base apk it reads mounted at the record's path. Apart from packages.ts,
// which the VFS reads uids from.
import { attrStr } from "./axml.ts";
import { installedPath, packageUid, packages, PackageRecord, type Provisioned } from "./packages.ts";
import type { PackageArchive } from "./packagearchive.ts";
import { vfs } from "../shell/vfs.ts";
import { PackedArchive, packedArchives } from "../shell/packedarchive.ts";
import type { FileSource } from "../shell/lazyfile.ts";

/** a package's manifest and apk, with its signing certificates or how to read them */
type PackageContents = Pick<PackageArchive, "root" | "apk"> & { certificates: Uint8Array[] | (() => Promise<Uint8Array[]>) };
/** a package the package manager knows, its base apk at `path` (`source`'s bytes, when given) */
export function registerPackage({ root, apk, certificates }: PackageContents, { path, uid, source, ...provisioned }: Provisioned &
  { path?: string; uid?: number; source?: Uint8Array | FileSource } = {}): PackageRecord {
  const pkg = attrStr(root, "package") ?? "";
  path ??= installedPath(pkg);
  if (source) vfs.place(path, source);
  if (source instanceof PackedArchive) packedArchives.set(path, source);
  const record = new PackageRecord(root, apk, path, uid ?? packageUid(pkg), typeof certificates === "function" ? certificates : () => Promise.resolve(certificates), provisioned);
  packages.set(pkg, record);
  return record;
}
/** a removed package leaves this process's package manager, with the archive it would register again from */
export function unregisterPackage(pkg: string): void {
  packages.delete(pkg);
  packedArchives.delete(installedPath(pkg));
  vfs.delete(installedPath(pkg));
}
