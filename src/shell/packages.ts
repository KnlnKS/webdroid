// The packages the package installer committed, which system_server's realm persists and registers
// again at boot.
import { openDb, txDone } from "./idb.ts";
import { BlobFile } from "./lazyfile.ts";
import { openInstalledSplits } from "./install.ts";
import { attrStr } from "../android/axml.ts";
import { parsePackageArchive, type PackageArchive } from "../android/packagearchive.ts";
import { verifyApkSignature } from "../android/apksignature.ts";
import { registerPackage, InstallFailure, INSTALL_FAILED_UPDATE_INCOMPATIBLE, INSTALL_FAILED_VERSION_DOWNGRADE,
  INSTALL_PARSE_FAILED_NO_CERTIFICATES } from "../android/installpackage.ts";
import { installedPath, packages, type PackageRecord } from "../android/packages.ts";
import { longVersionCode } from "../android/pm.ts";
import { sameBytes } from "../jvm/abi.ts";

/** a stored install: its base and split apks, as blobs the store may keep on disk */
type Saved = { base: Blob; splits: Blob[] };
const blob = (bytes: Uint8Array) => new Blob([bytes as Uint8Array<ArrayBuffer>]);
let database: Promise<IDBDatabase> | null = null;
const store = () => database ??= openDb("webdroid-packages", "apks");
/** `archive`'s package, its base `base`, with the stored splits over it */
async function register(archive: PackageArchive, base: Uint8Array, splits: Blob[], path?: string): Promise<PackageRecord> {
  const install = await openInstalledSplits(splits.map((split) => new BlobFile(split)), { zip: archive.apk.zip, base });
  return registerPackage(archive, { path, source: base, install });
}
let restored: Promise<void> | null = null;
/** the persisted installs, registered unless a package of the same name already is */
export function restorePackages(): Promise<void> {
  return restored ??= (async () => {
    if (typeof indexedDB === "undefined") return;
    const saved: [string, Saved | Uint8Array][] = [];
    const transaction = (await store()).transaction("apks", "readonly");
    const request = transaction.objectStore("apks").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (typeof cursor.key === "string") saved.push([cursor.key, cursor.value]);
      cursor.continue();
    };
    await txDone(transaction);
    // an earlier build stored a base's bytes alone; an install that no longer opens stays unregistered
    await Promise.all(saved.map(([path, value]) => (async () => {
      const { base, splits } = value instanceof Uint8Array ? { base: value, splits: [] } : { base: new Uint8Array(await value.base.arrayBuffer()), splits: value.splits };
      const archive = await parsePackageArchive(base);
      if (!packages.has(archive.pkg)) await register(archive, base, splits, path);
    })().catch(() => {})));
  })();
}
async function persistPackage(path: string, saved: Saved): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const transaction = (await store()).transaction("apks", "readwrite");
  transaction.objectStore("apks").put(saved, path);
  await txDone(transaction);
}
export async function forgetPackage(path: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const transaction = (await store()).transaction("apks", "readwrite");
  transaction.objectStore("apks").delete(path);
  await txDone(transaction);
}
const sameCertificates = (a: Uint8Array[], b: Uint8Array[]) => a.length === b.length && a.every((cert, i) => sameBytes(cert, b[i]));
/** InstallPackageHelper's commit of the signed apks `caller`'s package installs: one base and its splits, of
 *  one package, version and signer (PackageInstallerSession.validateApkInstallLocked), no older than the
 *  installed package and signed by its certificates, then persisted and registered with its splits */
export async function installPackage(apks: Uint8Array[], expected: string | null, caller: string): Promise<PackageRecord> {
  const opened = await Promise.all(apks.map(async (bytes) => {
    const certificates = await verifyApkSignature(bytes).catch((e: Error) => { throw new InstallFailure(INSTALL_PARSE_FAILED_NO_CERTIFICATES, e.message); });
    const archive = await parsePackageArchive(bytes, certificates);
    return { bytes, archive, split: attrStr(archive.root, "split") };
  }));
  const bases = opened.filter((apk) => apk.split === null), splits = opened.filter((apk) => apk.split !== null);
  if (bases.length !== 1) throw new Error("Full install must include one base package");
  const [{ bytes, archive }] = bases, version = longVersionCode(archive.root);
  for (const { archive: split, split: name } of splits) {
    if (split.pkg !== archive.pkg) throw new Error(`Split ${name} has inconsistent package name`);
    if (longVersionCode(split.root) !== version) throw new Error(`Split ${name} has mismatched version code`);
    if (!sameCertificates(split.certificates, archive.certificates)) throw new Error(`Split ${name} signed with different certificates`);
  }
  if (expected && expected !== archive.pkg) throw new Error("Session package name differs from APK");
  if (archive.pkg === caller) throw new Error("Replacing the running package is unsupported");
  const previous = packages.get(archive.pkg), certificates = await previous?.certificates();
  if (previous && version < longVersionCode(previous.root)) throw new InstallFailure(INSTALL_FAILED_VERSION_DOWNGRADE, "APK version is older than installed package");
  if (certificates && !sameCertificates(certificates, archive.certificates))
    throw new InstallFailure(INSTALL_FAILED_UPDATE_INCOMPATIBLE, "APK signing certificate differs from installed package");
  const saved = { base: blob(bytes), splits: splits.map((split) => blob(split.bytes)) };
  await persistPackage(installedPath(archive.pkg), saved);
  return register(archive, bytes, saved.splits);
}
