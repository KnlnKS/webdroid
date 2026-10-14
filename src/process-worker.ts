import { attachWorkerBootstrap, serveWorkerEndpoint } from "./shell/worker-bootstrap";
import { closeProcessBootstrap, type ProcessBootstrap } from "./shell/process-bootstrap-data";
import type { ClockBootstrap } from "./shell/clock-port";

// The page spawns this Worker before it knows the package, as a zygote forks an unspecialized child: the
// clock comes first, then the runtime loads while the page opens the package the bootstrap carries.
// Its URL carries the screen and native pins before any JVM import runs.
type Start = { bootstrap: ProcessBootstrap; endpoint: MessagePort; control: MessagePort };
const logs: string[] = [];
const logError = console.error.bind(console);
console.error = (...args: unknown[]) => { logError(...args); logs.push(args.map(String).join(" ")); };
globalThis.addEventListener("unhandledrejection", event => {
  const error = (event as PromiseRejectionEvent).reason as { message?: string; msg?: string; stack?: string } | null;
  logs.push(`unhandledrejection: ${error?.message ?? error?.msg ?? String(error)}\n${error?.stack ?? ""}`);
});

type Prestart = { clock: ClockBootstrap; aot: MessagePort; jars: MessagePort; warm: boolean };
let rateKnown!: (hz: number) => void;
/** the display's rate, which the page sends once it has measured it */
const rate = new Promise<number>((resolve) => { rateKnown = resolve; });
async function prepare({ clock, aot, jars, warm }: Prestart) {
  (await import("./guest-clock")).attachGuestClockPort(clock);
  await import("./natives");
  (await import("./android/framework")).receivePlatformJars(jars);
  const [control, port, core, apex, cacerts, packages, device, skia, tier, config, jvmruntime] = await Promise.all([
    import("./shell/worker-control"), import("./shell/process-port"), import("./native/core"), import("./shell/apex"), import("./shell/cacerts"), import("./shell/process-bootstrap"),
    import("./shell/device"), import("./android/skia"), import("./jvm/tier"), import("./shell/config"), import("./jvm/natives/jvmruntime"),
  ]);
  apex.mountPlatformData(); cacerts.mountSystemCertificates(); packages.prepareSystemPackages();
  await tier.useAotPort(aot);
  const runtime = Promise.all([skia.loadSkia(), tier.loadTier()]);
  void runtime.catch(() => {});
  // the zygote this process is forked from runs before its package is known, of the bitness the page chose by the package
  jvmruntime.setZygoteBitness(new URLSearchParams(location.search).get("abi") !== "32");
  void runtime.then(() => device.startZygote(rate.then((hz) => { config.device.refreshRate = hz; }), warm ? () => globalThis.postMessage({ kind: "warmed" }) : undefined)).catch(() => {});
  return { control, port, core, packages, device, config, runtime };
}

let prepared: ReturnType<typeof prepare> | undefined, started = false;
globalThis.onmessage = async ({ data }: MessageEvent<Prestart | Start | { rate: number }>) => {
  if ("clock" in data) { prepared ??= prepare(data); void prepared.catch(() => {}); return; }
  if ("rate" in data) { rateKnown(data.rate); return; }
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
