import { attachWorkerBootstrap, serveWorkerEndpoint } from "./shell/worker-bootstrap";
import { closeProcessBootstrap, type ProcessBootstrap } from "./shell/process-bootstrap-data";
import type { ClockBootstrap } from "./shell/clock-port";

// The page spawns this Worker before it knows the package, as a zygote forks an unspecialized child: the
// clock comes first, then the runtime loads while the page opens the package the bootstrap carries.
// Its URL carries the screen/tier/coverage pins before any JVM import runs.
type Start = { bootstrap: ProcessBootstrap; endpoint: MessagePort; control: MessagePort };
const logs: string[] = [];
const logError = console.error.bind(console);
console.error = (...args: unknown[]) => { logError(...args); logs.push(args.map(String).join(" ")); };
globalThis.addEventListener("unhandledrejection", event => {
  const error = (event as PromiseRejectionEvent).reason as { message?: string; msg?: string; stack?: string } | null;
  logs.push(`unhandledrejection: ${error?.message ?? error?.msg ?? String(error)}\n${error?.stack ?? ""}`);
});

type Prestart = { clock: ClockBootstrap; aot: MessagePort; jars: MessagePort };
async function prepare({ clock, aot, jars }: Prestart) {
  (await import("./guest-clock")).attachGuestClockPort(clock);
  await import("./natives");
  (await import("./android/framework")).receivePlatformJars(jars);
  const [control, port, jentry, core, coverage, apex, cacerts, packages, device, skia, tier, config] = await Promise.all([
    import("./shell/worker-control"), import("./shell/process-port"), import("./jvm/natives/jentry"), import("./native/core"),
    import("./jvm/coverage"), import("./shell/apex"), import("./shell/cacerts"), import("./shell/process-bootstrap"),
    import("./shell/device"), import("./android/skia"), import("./jvm/tier"), import("./shell/config"),
  ]);
  apex.mountPlatformData(); cacerts.mountSystemCertificates();
  await tier.useAotPort(aot);
  const runtime = Promise.all([skia.loadSkia(), tier.tier === "wasm" ? tier.loadTier() : undefined]);
  void runtime.catch(() => {});
  return { control, port, jentry, core, coverage, packages, device, config, runtime };
}

let prepared: ReturnType<typeof prepare> | undefined, started = false;
globalThis.onmessage = async ({ data }: MessageEvent<Prestart | Start>) => {
  if ("clock" in data) { prepared ??= prepare(data); void prepared.catch(() => {}); return; }
  if (started || !prepared) {
    closeProcessBootstrap(data.bootstrap); data.endpoint.close(); data.control.close();
    return;
  }
  started = true;
  let phase = "attaching", closeControl: (() => void) | undefined;
  try {
    const p = await prepared;
    p.config.device.refreshRate = data.bootstrap.refreshRate;
    await attachWorkerBootstrap(data.bootstrap);
    const { processPresentation } = await import("./shell/process-endpoint");
    processPresentation.visible = false;
    closeControl = p.port.serveCalls(data.control, p.control.workerControl(logs, () => phase));
    p.jentry.strictThreadOwnership();
    const params = new URLSearchParams(location.search);
    p.core.jitStats.on = params.get("jit") !== "0";
    p.coverage.configureJvmCoverage(params.get("fuzzCoverage") === "1");
    phase = "packages";
    const boot = await p.packages.loadProcessPackages(data.bootstrap);
    if (!boot) throw new Error("Process package unavailable");
    phase = "platform";
    await p.runtime;
    phase = "application";
    await p.device.bootApk(boot, status => { phase = status; }, data.bootstrap.launcher?.assetKey ?? "",
      data.bootstrap.launcher ? null : data.bootstrap.process);
    await serveWorkerEndpoint(data.endpoint);
    phase = "ready";
    globalThis.postMessage({ kind: "ready", pid: data.bootstrap.pid });
  } catch (error) {
    phase = "failed";
    console.error("[process Worker]", data.bootstrap.pid, error);
    data.endpoint.close();
    closeProcessBootstrap(data.bootstrap);
    const { processFailure } = await import("./shell/process-port");
    globalThis.postMessage({ kind: "failed", pid: data.bootstrap.pid, error: processFailure(error), logs: logs.slice() });
    // Keep copied diagnostic state available until the page's explicit teardown.
    if (!closeControl) data.control.close();
  }
};
