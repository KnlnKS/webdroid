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
type PackageContents = Pick<PackageArchive, "root" | "apk" | "splits"> & { certificates: Uint8Array[] | (() => Promise<Uint8Array[]>) };
/** a package the package manager knows, its base apk at `path` (`source`'s bytes, when given) */
export function registerPackage({ root, apk, certificates, splits }: PackageContents, { path, uid, source, ...provisioned }: Provisioned &
  { path?: string; uid?: number; source?: Uint8Array | FileSource } = {}): PackageRecord {
  const pkg = attrStr(root, "package") ?? "";
  path ??= installedPath(pkg);
  if (source) vfs.place(path, source);
  if (source instanceof PackedArchive) packedArchives.set(path, source);
  const record = new PackageRecord(root, apk, path, uid ?? packageUid(pkg), typeof certificates === "function" ? certificates : () => Promise.resolve(certificates), { ...provisioned, splits });
  packages.set(pkg, record);
  return record;
}

/** PackageManager's INSTALL_* codes */
export const INSTALL_SUCCEEDED = 1, INSTALL_FAILED_INVALID_APK = -2, INSTALL_FAILED_UPDATE_INCOMPATIBLE = -7,
  INSTALL_FAILED_VERSION_DOWNGRADE = -25, INSTALL_PARSE_FAILED_NO_CERTIFICATES = -103;
/** PackageManagerException: a failed install's INSTALL_* code */
export class InstallFailure extends Error {
  readonly code: number;
  constructor(code: number, message: string) { super(message); this.code = code; }
}
/** an install's outcome as PackageInstallerSession reports it: its INSTALL_* code, and the package installed */
export type InstallResult = { code: number; message: string | null; pkg: string | null };
/** a failed install's outcome: an InstallFailure's own code, else an invalid apk */
export const installFailed = (error: unknown): InstallResult => ({ code: error instanceof InstallFailure ? error.code : INSTALL_FAILED_INVALID_APK,
  message: error instanceof Error ? error.message : (error as { msg?: string } | null)?.msg ?? String(error), pkg: null });
/** a removed package leaves this process's package manager, with the archive it would register again from */
export function unregisterPackage(pkg: string): void {
  packages.delete(pkg);
  packedArchives.delete(installedPath(pkg));
  vfs.delete(installedPath(pkg));
}
