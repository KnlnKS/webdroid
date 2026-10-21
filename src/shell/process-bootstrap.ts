import { packageArchive, packageArchiveSource } from "../android/packagearchive.ts";
import { zipTree } from "../zip.ts";
import { PackedArchive, packedArchives, SYSTEM_PACKAGE_BASE, systemPackage, type PackedArchiveIndex } from "./packedarchive.ts";
import { SYSTEM_PACKAGES } from "./system-packages.ts";
import { rt } from "../jvm/runtime.ts";
import { openInstallApks, type Install } from "./install.ts";
import { RemoteFile } from "./remote-file.ts";
import { readFully } from "./lazyfile.ts";
import { installedPath, registerPackage } from "../android/pm.ts";
import { vfs } from "./vfs.ts";
import { hexBytes, u8 } from "../jvm/abi.ts";
import type { ProcessBootstrap } from "./process-bootstrap-data.ts";

/** system packages' archives prepared before a process's package arrives, by source digest: every process registers them,
 *  and preparing one fetches and reads its bootstrap file (11 MB for GMS) */
const prepared = new Map<string, Promise<PackedArchive>>();
export function prepareSystemPackages(): void {
  for (const spec of SYSTEM_PACKAGES) prepared.set(spec.sha256, systemPackage(spec));
}
async function preparedArchive(index: PackedArchiveIndex, base: string, own: boolean): Promise<PackedArchive> {
  const ready = own || base !== SYSTEM_PACKAGE_BASE ? undefined : prepared.get(index.sha256);
  prepared.delete(index.sha256);
  const packed = await ready?.catch(() => undefined);
  if (packed && packed.index.bootstrap.file === index.bootstrap.file) return packed;
  const opened = new PackedArchive(index, base);
  await opened.prepare(own);
  return opened;
}
/** Load a process registry from its transferred archive descriptors: archives open together, packages register in registry order. */
export async function loadProcessPackages(data: ProcessBootstrap): Promise<Install | null> {
  let boot: Install | null = null;
  const opened = await Promise.all(data.registry.map(async (snapshot) => {
    const path = installedPath(snapshot.pkg), source = snapshot.source, own = snapshot.pkg === data.pkg;
    let archive, base: Pick<Install, "zip" | "base">;
    if ("index" in source) {
      const packed = await preparedArchive(source.index, source.base, own);
      archive = packageArchive(packed.zip, source.index.certificates.map(hexBytes));
      packedArchives.set(path, packed); vfs.mount(path, packed);
      if (own) rt.classpathSource = packed;
      base = { zip: packed.zip, base: packed };
    } else if (!own) {
      const file = new RemoteFile(source);
      archive = await packageArchiveSource(file, snapshot.certificates);
      vfs.mount(path, file);
      base = {zip: archive.apk.zip, base: file};
    } else {
      const bytes = await readFully(new RemoteFile(source)), zip = zipTree(bytes);
      archive = packageArchive(zip, snapshot.certificates); vfs.write(path, bytes);
      base = { zip, base: bytes };
    }
    if (own) {
      boot = await openInstallApks(snapshot.splits.map((split) => new RemoteFile(split)), base);
      // AssetManager may cache this package before bootApk constructs its resources.
      for (const split of boot.splits) if (split.resources) archive.apk.table?.add(split.resources);
      for (const [name, source] of boot.lazyEntries) archive.apk.lazyEntries.set(name, source);
    }
    return { snapshot, archive, path };
  }));
  for (const { snapshot, archive, path } of opened) {
    const record = registerPackage(archive, path, snapshot.uid);
    record.system = snapshot.system;
    for (const grant of snapshot.grants) record.grants.add(grant);
    record.compatibilityCertificates = snapshot.signatures?.map((s) => u8(s)) ?? null;
  }
  return boot;
}
