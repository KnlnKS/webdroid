import { packageArchive, packageArchiveSource } from "../android/packagearchive";
import { zipTree } from "../jvm/natives/jzip";
import { PackedArchive, packedArchives } from "./packedarchive";
import { rt } from "../jvm/runtime";
import { openInstallApks, type Install } from "./install";
import { RemoteFile } from "./remote-file";
import { readFully } from "./lazyfile";
import { installedPath, registerPackage } from "../android/pm";
import { vfs } from "./vfs";
import { hexBytes, u8 } from "../jvm/abi";
import type { ProcessBootstrap } from "./process-bootstrap-data";

/** Load a process registry from its transferred archive descriptors: archives open together, packages register in registry order. */
export async function loadProcessPackages(data: ProcessBootstrap): Promise<Install | null> {
  let boot: Install | null = null;
  const opened = await Promise.all(data.registry.map(async (snapshot) => {
    const path = installedPath(snapshot.pkg), source = snapshot.source, own = snapshot.pkg === data.pkg;
    let archive, base: Pick<Install, "zip" | "base">;
    if ("index" in source) {
      const packed = new PackedArchive(source.index, source.base);
      await packed.prepare(own);
      archive = packageArchive(packed.zip, source.index.certificates.map(hexBytes));
      packedArchives.set(path, packed); vfs.mount(path, packed);
      if (own) rt.classpathSource = packed;
      base = { zip: packed.zip, base: packed };
    } else if (!own) {
      const file = new RemoteFile(source);
      archive = await packageArchiveSource(file, snapshot.certificates);
      vfs.mount(path, file);
      base = {zip: archive.res.zip, base: file};
    } else {
      const bytes = await readFully(new RemoteFile(source)), zip = zipTree(bytes);
      archive = packageArchive(zip, snapshot.certificates); vfs.write(path, bytes);
      base = { zip, base: bytes };
    }
    if (own) {
      boot = await openInstallApks(snapshot.splits.map((split) => new RemoteFile(split)), base);
      // AssetManager may cache this package before bootApk constructs its resources.
      for (const split of boot.splits) if (split.resources) archive.res.arsc?.add(split.resources);
      for (const [name, source] of boot.lazyEntries) archive.res.lazyEntries.set(name, source);
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
