// The page owns system services; application Java runs in its own process realm.
import { loadFramework, mountPlatformJars } from "../android/framework.ts";
import { setProcessIdentity, setProcessName } from "../android/os.ts";
import { onMain } from "../android/mainloop.ts";
import { applyDeviceConfiguration, initDeviceLocales } from "../android/configuration.ts";
import { scall } from "../jvm/natives/jentry.ts";
import { fixProcessBitness } from "../jvm/natives/jvmruntime.ts";
import { loadAppCode, loadTier } from "../jvm/tier.ts";
import { startZygote, setSystemDisplayTarget, useDisplayRotation } from "./device.ts";
import { connectProcess } from "./process-endpoint.ts";
import { processBroker } from "./processes.ts";
import { loadSystemFontMap } from "../android/fonts.ts";
import { rt } from "../jvm/runtime.ts";
import { procIdentity } from "./procfs.ts";

let booted: Promise<void> | undefined;
/** SystemServer's ActivityThread.systemMain creates the real system Context,
 * Instrumentation and Application. No application DEX belongs to this realm. */
export function bootSystemOwner(): Promise<void> {
  return booted ??= (async () => {
    setProcessIdentity(procIdentity.pid, 1000);
    setProcessName("system_server");
    fixProcessBitness([]);
    await loadTier();
    await Promise.all([loadFramework(), mountPlatformJars()]);
    // app processes start meanwhile: their calls to system services wait for its endpoint
    const broker = processBroker();
    broker.registerSystemServer();
    await loadAppCode();
    setSystemDisplayTarget();
    useDisplayRotation();
    await startZygote();
    await onMain(() => rt.drive(loadSystemFontMap()));
    await onMain(initDeviceLocales);
    await onMain(applyDeviceConfiguration);
    const endpoint = connectProcess(broker);
    await onMain(() => scall("android/app/ActivityThread", "systemMain", "()Landroid/app/ActivityThread;"));
    broker.ready(procIdentity.pid, endpoint);
  })();
}

/** Install the selected package with its original archive and split sources;
 * loading its bytecode remains the application's Worker responsibility. */
export async function prepareWorkerInstall(install: import("./install.ts").Install): Promise<{ pkg: string; label: string }> {
  const [{ apkCertificates, packageArchive }, { registerPackage }, { readFully }] = await Promise.all([
    import("../android/packagearchive.ts"), import("../android/installpackage.ts"), import("./lazyfile.ts"),
  ]);
  const bytes = install.base instanceof Uint8Array ? install.base : await readFully(install.base);
  const archive = packageArchive(install.zip, await apkCertificates(bytes, install.zip));
  const record = registerPackage(archive, { source: install.base, install });
  return { pkg: record.pkg, label: record.label() };
}
