// The page owns system services; application Java runs in its own process realm.
import { loadFramework, loadPlatformDex } from "../android/framework";
import { setProcessIdentity, setProcessName, PROCESS_PID } from "../android/os";
import { onMain } from "../android/mainloop";
import { applyDeviceConfiguration } from "../android/resources";
import { initDeviceLocales } from "../android/resnative";
import { scall } from "../jvm/natives/jentry";
import { fixProcessBitness } from "../jvm/natives/jvmruntime";
import { loadAppCode, loadTier } from "../jvm/tier";
import { startZygote, setSystemDisplayTarget, useDisplayRotation } from "./device";
import { connectProcess } from "./process-endpoint";
import { processBroker } from "./processes";
import { hostWindowManager } from "../android/server/wm";
import { loadSystemFontMap } from "../android/fonts";
import { rt } from "../jvm/runtime";

let booted: Promise<void> | undefined;
/** SystemServer's ActivityThread.systemMain creates the real system Context,
 * Instrumentation and Application. No application DEX belongs to this realm. */
export function bootSystemOwner(): Promise<void> {
  return booted ??= (async () => {
    setProcessIdentity(PROCESS_PID, 1000);
    setProcessName("system_server");
    fixProcessBitness([]);
    await loadTier();
    await Promise.all([loadFramework(), loadPlatformDex()]);
    // app processes start meanwhile: their calls to system services wait for its endpoint
    const broker = processBroker();
    broker.connect("android", "system_server", PROCESS_PID);
    await loadAppCode({ launch: [] });
    hostWindowManager();
    setSystemDisplayTarget();
    useDisplayRotation();
    await startZygote();
    await onMain(() => rt.drive(loadSystemFontMap()));
    await onMain(initDeviceLocales);
    await onMain(applyDeviceConfiguration);
    const endpoint = connectProcess();
    await onMain(() => scall("android/app/ActivityThread", "systemMain", "()Landroid/app/ActivityThread;"));
    broker.ready(PROCESS_PID, endpoint);
  })();
}

/** Install the selected package with its original archive and split sources;
 * loading its bytecode remains the application's Worker responsibility. */
export async function prepareWorkerInstall(install: import("./install").Install): Promise<{ pkg: string; label: string }> {
  const [{ apkCertificates, packageArchive }, { registerPackage, installedPath }, { readFully }, { vfs }] = await Promise.all([
    import("../android/packagearchive"), import("../android/pm"), import("./lazyfile"), import("./vfs"),
  ]);
  const bytes = install.base instanceof Uint8Array ? install.base : await readFully(install.base);
  const archive = packageArchive(install.zip, await apkCertificates(bytes, install.zip), install.lazyEntries);
  for (const split of install.splits) if (split.resources) archive.res.arsc?.add(split.resources);
  const record = registerPackage(archive);
  if (install.base instanceof Uint8Array) vfs.write(installedPath(record.pkg), install.base);
  else vfs.mount(installedPath(record.pkg), install.base);
  processBroker().setPackageSplits(record.pkg, install.splits.map(split => split.source));
  return { pkg: record.pkg, label: record.label() };
}
