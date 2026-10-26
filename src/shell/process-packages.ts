import { packageArchive, packageArchiveSource, type PackageArchive } from "../android/packagearchive.ts";
import { zipTree } from "../zip.ts";
import { PackedArchive, SYSTEM_PACKAGE_BASE, systemPackage, type PackedArchiveIndex } from "./packedarchive.ts";
import { SYSTEM_PACKAGES } from "./system-packages.ts";
import { rt } from "../jvm/runtime.ts";
import { openInstallApks, type Install } from "./install.ts";
import { RemoteFile } from "./remote-file.ts";
import { readFully } from "./lazyfile.ts";
import { installedPath } from "../android/packages.ts";
import { registerPackage } from "../android/installpackage.ts";
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
type PackageSnapshot = ProcessBootstrap["registry"][number];
/** another package's archive as the broker serves it: its system package's packed archive, or its served bytes */
async function openArchive({ source, certificates }: PackageSnapshot): Promise<{ archive: PackageArchive; base: Install["base"] }> {
  if ("index" in source) {
    const packed = await preparedArchive(source.index, source.base, false);
    return { archive: packageArchive(packed.zip, source.index.certificates.map(hexBytes)), base: packed };
  }
  const file = new RemoteFile(source);
  return { archive: await packageArchiveSource(file, certificates), base: file };
}
const register = (snapshot: PackageSnapshot, archive: PackageArchive, source: Install["base"]) =>
  registerPackage(archive, { path: installedPath(snapshot.pkg), source, uid: snapshot.uid, system: snapshot.system,
    grants: snapshot.grants, signatures: snapshot.signatures?.map((s) => u8(s)) ?? null });
/** a package installed after this process started */
export async function registerSnapshot(snapshot: PackageSnapshot): Promise<void> {
  const { archive, base } = await openArchive(snapshot);
  register(snapshot, archive, base);
}
/** Load a process registry from its transferred archive descriptors: archives open together, packages register in registry order. */
export async function loadProcessPackages(data: ProcessBootstrap): Promise<Install | null> {
  let boot: Install | null = null;
  const opened = await Promise.all(data.registry.map(async (snapshot) => {
    if (snapshot.pkg !== data.pkg) return { snapshot, ...await openArchive(snapshot) };
    const source = snapshot.source;
    let certificates, base: Pick<Install, "zip" | "base">;
    if ("index" in source) {
      const packed = await preparedArchive(source.index, source.base, true);
      certificates = source.index.certificates.map(hexBytes);
      rt.classpathSource = packed;
      base = { zip: packed.zip, base: packed };
    } else {
      const bytes = await readFully(new RemoteFile(source));
      certificates = snapshot.certificates;
      base = { zip: zipTree(bytes), base: bytes };
    }
    boot = await openInstallApks(snapshot.splits.map((split) => new RemoteFile(split)), base);
    // the record's apk is the one ApkAssets loads at sourceDir: the splits join it
    return { snapshot, archive: packageArchive(base.zip, certificates, boot), base: base.base };
  }));
  for (const { snapshot, archive, base } of opened) register(snapshot, archive, base);
  return boot;
}
