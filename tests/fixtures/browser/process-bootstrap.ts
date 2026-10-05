import { processBroker } from "../../../src/shell/processes";
import { packages, PackageRecord } from "../../../src/android/packages";
import { Resources } from "../../../src/android/res";
import { TV } from "../../../src/android/axml";
import { vfs } from "../../../src/shell/vfs";
import { packedArchives } from "../../../src/shell/packedarchive";
import { RemoteFile } from "../../../src/shell/remote-file";
import { NOT_CRASHED } from "../../../src/android/server/appexitinfo";

export async function bootstrapOwnership() {
  let reads = 0, began!: () => void;
  const waiting = new Promise<void>(resolve => began = resolve);
  for (const [i, pkg] of ["test.archive.one", "test.archive.two"].entries()) {
    const path = `/data/app/${pkg}/base.apk`;
    const root = { name: "manifest", attrs: [{ ns: "", name: "package", resId: 0, type: TV.STRING, data: 0, str: pkg }], children: [] };
    packages.set(pkg, new PackageRecord(root, new Resources(null, {}), path, 12000 + i, async () => []));
    vfs.mount(path, { size: 64 << 20, read(offset) {
      reads++;
      if (offset === 7) { began(); return new Promise<Uint8Array>(() => {}); }
      return Uint8Array.of(i + 10);
    } });
  }
  const broker = processBroker();
  broker.connect("test.archive.one", "test.archive.one", 7001);
  broker.connect("test.archive.two", "test.archive.two", 7002);
  const file = (data: Awaited<ReturnType<typeof broker.bootstrap>>) => {
    const source = data.registry[0].source;
    if (!("port" in source)) throw new Error("expected lazy archive port");
    return new RemoteFile(source);
  };
  const first = file(await broker.bootstrap(7001)), other = file(await broker.bootstrap(7002));
  const eagerReads = reads;
  const replacement = file(await broker.bootstrap(7001));
  const superseded = await first.read(0, 1).catch(error => error.message);
  // A failed handoff must dispose its new exports while retaining the published owner set.
  const clone = globalThis.structuredClone;
  const unpublished: RemoteFile[] = [];
  let failed = false;
  try {
    globalThis.structuredClone = value => {
      const data = value as Awaited<ReturnType<typeof broker.bootstrap>>;
      for (const record of data.registry) if ("port" in record.source) unpublished.push(new RemoteFile(record.source));
      throw new DOMException("handoff failed", "DataCloneError");
    };
    await broker.bootstrap(7001);
  } catch (error) { failed = error instanceof DOMException && error.name === "DataCloneError"; }
  finally { globalThis.structuredClone = clone; }
  const discarded = await Promise.all(unpublished.map(file => file.read(0, 1).catch(error => error.message)));
  const retained = Array.from(await replacement.read(0, 1));
  const pending = replacement.read(7, 1).catch(error => error.message);
  await waiting;
  broker.fail(7001, "fixture process exit", NOT_CRASHED);
  const ended = await pending;
  const isolated = Array.from(await other.read(0, 1));
  broker.fail(7002, "fixture process exit", NOT_CRASHED);
  packages.clear(); packedArchives.clear();
  return { eagerReads, superseded, failed, discarded, retained, ended, isolated };
}
