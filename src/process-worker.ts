import { attachWorkerBootstrap, serveWorkerEndpoint } from "./shell/worker-bootstrap";
import { closeProcessBootstrap, type ProcessBootstrap } from "./shell/process-bootstrap-data";

// ProcessBroker selects this entry with processMode=worker while remaining boundaries are verified.
// Its URL carries the same screen/tier/coverage pins as an iframe before any JVM import runs.
let started = false;
globalThis.onmessage = async ({ data }: MessageEvent<{ bootstrap: ProcessBootstrap; endpoint: MessagePort; control: MessagePort }>) => {
  if (started) {
    closeProcessBootstrap(data.bootstrap); data.endpoint.close(); data.control.close();
    return;
  }
  started = true;
  const logs: string[] = [];
  let phase = "attaching", closeControl: (() => void) | undefined;
  const logError = console.error.bind(console);
  console.error = (...args: unknown[]) => { logError(...args); logs.push(args.map(String).join(" ")); };
  globalThis.addEventListener("unhandledrejection", event => {
    const error = (event as PromiseRejectionEvent).reason as { message?: string; msg?: string; stack?: string } | null;
    logs.push(`unhandledrejection: ${error?.message ?? error?.msg ?? String(error)}\n${error?.stack ?? ""}`);
  });
  try {
    await attachWorkerBootstrap(data.bootstrap);
    const { processPresentation } = await import("./shell/process-endpoint");
    processPresentation.visible = false;
    const [{ workerControl }, { serveCalls }, { strictThreadOwnership }, { jitStats }, { configureJvmCoverage },
      { mountPlatformData }, { mountSystemCertificates }, { loadProcessPackages }, device, { loadSkia }, tier] = await Promise.all([
      import("./shell/worker-control"), import("./shell/process-port"), import("./jvm/natives/jentry"), import("./native/core"),
      import("./jvm/coverage"), import("./shell/apex"), import("./shell/cacerts"), import("./shell/process-bootstrap"),
      import("./shell/device"), import("./android/skia"), import("./jvm/tier"),
    ]);
    closeControl = serveCalls(data.control, workerControl(logs, () => phase));
    strictThreadOwnership();
    const params = new URLSearchParams(location.search);
    jitStats.on = params.get("jit") !== "0";
    configureJvmCoverage(params.get("fuzzCoverage") === "1");
    phase = "packages";
    mountPlatformData(); mountSystemCertificates();
    const tierReady = tier.tier === "wasm" ? tier.loadTier() : Promise.resolve();
    const boot = await loadProcessPackages(data.bootstrap);
    if (!boot) throw new Error("Process package unavailable");
    phase = "platform";
    await Promise.all([loadSkia(), tierReady]);
    phase = "application";
    await device.bootApk(boot, status => { phase = status; }, data.bootstrap.launcher?.assetKey ?? "",
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
