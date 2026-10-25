// The base APKs the package installer committed, which system_server's realm persists and registers
// again at boot.
import { openDb, txDone } from "./idb.ts";
import { parsePackageArchive } from "../android/packagearchive.ts";
import { verifyApkSignature } from "../android/apksignature.ts";
import { registerPackage } from "../android/installpackage.ts";
import { installedPath, packages, type PackageRecord } from "../android/packages.ts";
import { longVersionCode } from "../android/pm.ts";
import { sameBytes } from "../jvm/abi.ts";

let database: Promise<IDBDatabase> | null = null;
const store = () => database ??= openDb("webdroid-packages", "apks");
let restored: Promise<void> | null = null;
/** the persisted installs, registered unless a package of the same name already is */
export function restorePackages(): Promise<void> {
  return restored ??= (async () => {
    if (typeof indexedDB === "undefined") return;
    const saved: [string, Uint8Array][] = [];
    const transaction = (await store()).transaction("apks", "readonly");
    const request = transaction.objectStore("apks").openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if (typeof cursor.key === "string" && cursor.value instanceof Uint8Array) saved.push([cursor.key, cursor.value]);
      cursor.continue();
    };
    await txDone(transaction);
    for (const [path, bytes] of saved) {
      const archive = await parsePackageArchive(bytes).catch(() => null);
      if (archive && !packages.has(archive.pkg)) registerPackage(archive, { path, source: bytes });
    }
  })();
}
async function persistPackage(path: string, bytes: Uint8Array): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const transaction = (await store()).transaction("apks", "readwrite");
  transaction.objectStore("apks").put(bytes, path);
  await txDone(transaction);
}
export async function forgetPackage(path: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const transaction = (await store()).transaction("apks", "readwrite");
  transaction.objectStore("apks").delete(path);
  await txDone(transaction);
}
/** InstallPackageHelper's commit of a signed base APK that `caller`'s package installs: no older than
 *  the installed package and signed by its certificates, then persisted and registered */
export async function installPackage(bytes: Uint8Array, expected: string | null, caller: string): Promise<PackageRecord> {
  const archive = await parsePackageArchive(bytes, await verifyApkSignature(bytes));
  if (expected && expected !== archive.pkg) throw new Error("Session package name differs from APK");
  if (archive.pkg === caller) throw new Error("Replacing the running package is unsupported");
  if (!archive.certificates.length) throw new Error("APK is unsigned");
  const previous = packages.get(archive.pkg), certificates = await previous?.certificates();
  if (previous && longVersionCode(archive.root) < longVersionCode(previous.root)) throw new Error("APK version is older than installed package");
  if (certificates && (certificates.length !== archive.certificates.length ||
      certificates.some((cert, i) => !sameBytes(cert, archive.certificates[i])))) throw new Error("APK signing certificate differs from installed package");
  await persistPackage(installedPath(archive.pkg), bytes);
  return registerPackage(archive, { source: bytes });
}
