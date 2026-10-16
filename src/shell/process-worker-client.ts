import { bootstrapTransfers, closeProcessBootstrap, type ProcessBootstrap } from "./process-bootstrap-data.ts";
import { callProxy, processError, type ProcessFailure } from "./process-port.ts";
import type { WorkerControl } from "./worker-control.ts";
import { workerControlMethods } from "./worker-control-methods.ts";
import { attachPointerInput } from "./pointer-input.ts";
import { createGuestClockPort } from "../guest-clock.ts";
import { serveAot, serveCompileWorkers } from "../jvm/tier.ts";
import { sendPlatformJars } from "../android/framework.ts";
import { displayRate } from "./display-rate.ts";
import { device } from "./config.ts";

export type SpareWorker = { pid: number; url: string; worker: Worker; release(): void; error?: string };
/** whether a Worker's zygote has had the engine compile the platform code launches use: the code is the tab's, so no later Worker warms it again */
let warmed = false;
export const platformWarmed = (): boolean => warmed;
/** A process Worker that loads its runtime before the broker gives it a package; the Wasm tier's modules come from the page's store. */
export function spawnProcessWorker(url: string, pid: number): SpareWorker {
  const worker = new Worker(url, { type: "module" }), clock = createGuestClockPort(pid), aot = new MessageChannel(), jars = new MessageChannel(), compile = new MessageChannel();
  serveAot(aot.port1);
  sendPlatformJars(jars.port1);
  serveCompileWorkers(compile.port1);
  const spare: SpareWorker = { pid, url: new URL(url, location.href).href, worker, release: () => { clock.close(); aot.port1.close(); compile.port1.close(); } };
  worker.onerror = event => { spare.error ??= event.message; };
  worker.addEventListener("message", ({ data }: MessageEvent<{ kind?: string }>) => { if (data.kind === "warmed") warmed = true; });
  worker.postMessage({ clock: clock.data, aot: aot.port2, jars: jars.port2, compile: compile.port2, warm: !warmed }, [aot.port2, jars.port2, compile.port2, ...clock.data.port ? [clock.data.port] : []]);
  // the zygote it runs reads the display's rate
  void displayRate().then(() => worker.postMessage({ rate: device.refreshRate }));
  return spare;
}

/** Page-owned Worker, input and control ports. JVM endpoint ownership passes to the broker on ready. */
export function startProcessWorker(spare: SpareWorker, canvas: HTMLCanvasElement,
  bootstrap: () => Promise<ProcessBootstrap>, ready: (port: MessagePort) => void, failed: (message: string) => void, focusInput: () => void) {
  const { worker } = spare;
  const endpoint = new MessageChannel(), control = new MessageChannel();
  let closed = false, published = false, transferred = false;
  const client = callProxy<WorkerControl>(control.port1, workerControlMethods, [], processError,
    error => { if (!closed) failed(error.message ?? "Process Worker control closed"); });
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const pointers = attachPointerInput(canvas, () => device, client.endpoint.pointer, () => {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => { focusTimer = undefined; if (!closed) focusInput(); }, 0);
  });
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(focusTimer); window.removeEventListener("pagehide", pagehide); pointers.close(); client.close(); worker.terminate(); spare.release();
    if (!published) endpoint.port2.close();
    if (!transferred) { endpoint.port1.close(); control.port2.close(); }
  };
  const pagehide = () => { if (!closed) failed("Process page closed"); };
  window.addEventListener("pagehide", pagehide, {once:true});
  worker.onerror = event => { if (!closed) failed(event.message); };
  worker.onmessageerror = () => { if (!closed) failed("Invalid process Worker message"); };
  worker.onmessage = ({data}: MessageEvent<{kind:string;error?:ProcessFailure;logs?:string[]}>) => {
    if (closed) return;
    if (data.kind === "ready" && !published) {
      try { ready(endpoint.port2); published = true; }
      catch (error) { failed(String(error)); }
    } else if (data.kind === "failed") {
      for (const log of data.logs ?? []) console.error("[process Worker]", log);
      failed(data.error?.message ?? "Process Worker startup failed");
    }
  };
  // launch() assigns the launcher after connect(), before this bootstrap reads the entry.
  queueMicrotask(() => { void (async () => {
    try {
      if (closed) return;
      if (spare.error) throw new Error(spare.error);
      const data = await bootstrap();
      if (closed) { closeProcessBootstrap(data); return; }
      try {
        worker.postMessage({bootstrap:data,endpoint:endpoint.port1,control:control.port2},
          [...bootstrapTransfers(data),endpoint.port1,control.port2]);
        transferred = true;
      } catch (error) { closeProcessBootstrap(data); throw error; }
    } catch (error) { if (!closed) failed(String(error)); }
  })(); });
  return { url: spare.url, control: client.endpoint, close };
}
