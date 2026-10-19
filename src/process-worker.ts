import { attachWorkerBootstrap, serveWorkerEndpoint } from "./shell/worker-bootstrap.ts";
import { closeProcessBootstrap } from "./shell/process-bootstrap-data.ts";
import type { ProcessWorkerMessage, ProcessWorkerStatus } from "./shell/process-host.ts";

// The page spawns this Worker before it knows the package, as a zygote forks an unspecialized child: the
// clock comes first, then the runtime loads while the page opens the package the bootstrap carries.
// Its URL carries the screen and native pins before any JVM import runs.
const logs: string[] = [];
const logError = console.error.bind(console);
console.error = (...args: unknown[]) => { logError(...args); logs.push(args.map(String).join(" ")); };
globalThis.addEventListener("unhandledrejection", event => {
  const error = (event as PromiseRejectionEvent).reason as { message?: string; msg?: string; stack?: string } | null;
  logs.push(`unhandledrejection: ${error?.message ?? error?.msg ?? String(error)}\n${error?.stack ?? ""}`);
});

const post = (status: ProcessWorkerStatus) => globalThis.postMessage(status);
let rateKnown!: (hz: number) => void;
/** the display's rate, which the page sends once it has measured it */
const rate = new Promise<number>((resolve) => { rateKnown = resolve; });
async function prepare({ clock, aot, jars, compile, warm }: Extract<ProcessWorkerMessage, { kind: "prestart" }>) {
  (await import("./guest-clock.ts")).attachGuestClockPort(clock);
  await import("./natives.ts");
  (await import("./android/framework.ts")).receivePlatformJars(jars);
  const [control, port, core, apex, cacerts, packages, device, skia, tier, config, jvmruntime] = await Promise.all([
    import("./shell/worker-control.ts"), import("./shell/process-port.ts"), import("./native/core.ts"), import("./shell/apex.ts"), import("./shell/cacerts.ts"), import("./shell/process-bootstrap.ts"),
    import("./shell/device.ts"), import("./android/skia.ts"), import("./jvm/tier.ts"), import("./shell/config.ts"), import("./jvm/natives/jvmruntime.ts"),
  ]);
  apex.mountPlatformData(); cacerts.mountSystemCertificates(); packages.prepareSystemPackages();
  await tier.usePagePorts(aot, compile, warm);
  const runtime = Promise.all([skia.loadSkia(), tier.loadTier()]);
  void runtime.catch(() => {});
  // the zygote this process is forked from runs before its package is known, of the bitness the page chose by the package
  jvmruntime.setZygoteBitness(new URLSearchParams(location.search).get("abi") !== "32");
  void runtime.then(() => device.startZygote(rate.then((hz) => { config.device.refreshRate = hz; }))).catch(() => {});
  return { control, port, core, packages, device, config, runtime };
}

let prepared: ReturnType<typeof prepare> | undefined, started = false;
globalThis.onmessage = async ({ data }: MessageEvent<ProcessWorkerMessage>) => {
  if (data.kind === "prestart") { prepared ??= prepare(data); void prepared.catch(() => {}); return; }
  if (data.kind === "rate") { rateKnown(data.rate); return; }
  let phase = "attaching", closeControl: (() => void) | undefined;
  try {
    if (!prepared || started) throw new Error("Process Worker started without its prestart, or twice");
    started = true;
    const p = await prepared;
    await attachWorkerBootstrap(data.bootstrap);
    const { processPresentation } = await import("./shell/process-endpoint.ts");
    processPresentation.visible = false;
    closeControl = p.port.serveCalls(data.control, p.control.workerControl(logs, () => phase));
    p.core.jitStats.on = new URLSearchParams(location.search).get("jit") !== "0";
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
    post({ kind: "ready" });
  } catch (error) {
    phase = "failed";
    console.error("[process Worker]", data.bootstrap.pid, error);
    data.endpoint.close();
    closeProcessBootstrap(data.bootstrap);
    const { processFailure } = await import("./shell/process-port.ts");
    post({ kind: "failed", error: processFailure(error), logs: logs.slice() });
    // Keep copied diagnostic state available until the page's explicit teardown.
    if (!closeControl) data.control.close();
  }
};
