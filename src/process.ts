import "./natives";
import { processBroker, connectProcess } from "./shell/processes";
import { bootApk } from "./shell/device";
import { setProcessIdentity } from "./android/os";
import { parsePackageArchive, packageArchive } from "./android/packagearchive";
import { PackedArchive, packedArchives } from "./shell/packedarchive";
import { rt } from "./jvm/runtime";
import type { Install } from "./shell/install";
import { installedPath, registerPackage } from "./android/pm";
import { vfs } from "./jvm/natives/jio";
import { mountSystemCertificates } from "./shell/cacerts";

const pid = Number(new URLSearchParams(location.search).get("pid")), broker = processBroker();
try {
  const data = await broker.bootstrap(pid);
  setProcessIdentity(pid, data.uid);
  mountSystemCertificates();
  let boot: Uint8Array | Install | null = null;
  for (const snapshot of data.registry) {
    const path = installedPath(snapshot.pkg), source = snapshot.source;
    let archive;
    if ("index" in source) {
      const packed = new PackedArchive(source.index, source.base, source);
      await packed.prepare(snapshot.pkg === data.pkg);
      archive = packageArchive(packed.zip, source.index.certificates.map((c) => Uint8Array.from(c.match(/../g)!, (b) => parseInt(b, 16))));
      packedArchives.set(path, packed); vfs.mount(path, packed);
      if (snapshot.pkg === data.pkg) {
        boot = { zip: packed.zip, base: packed, lazyEntries: new Map(), splits: [] };
        rt.classpathSource = packed;
      }
    } else {
      const bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      archive = await parsePackageArchive(bytes); vfs.write(path, bytes);
      if (snapshot.pkg === data.pkg) boot = bytes;
    }
    const record = registerPackage(archive, path, snapshot.uid);
    record.system = snapshot.system;
    for (const grant of snapshot.grants) record.grants.add(grant);
    record.compatibilityCertificates = snapshot.signatures?.map((s) => new Uint8Array(s.buffer, s.byteOffset, s.byteLength)) ?? null;
  }
  const endpoint = connectProcess();
  if (!boot) throw new Error("Process package unavailable");
  await bootApk(boot, () => {}, "", data.process);
  broker.ready(pid, endpoint);
} catch (error) {
  console.error("[process]", pid, error);
  broker.fail(pid, error instanceof Error ? error.message : String(error));
}
