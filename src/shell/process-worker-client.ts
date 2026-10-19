import { bootstrapTransfers, closeProcessBootstrap, type ProcessBootstrap } from "./process-bootstrap-data.ts";
import { callProxy, methodsOf, processError, type ProcessFailure } from "./process-port.ts";
import type { WorkerControl } from "./worker-control.ts";
import { attachPointerInput } from "./pointer-input.ts";
import { createGuestClockPort } from "../guest-clock.ts";
import { serveAot, serveCompileWorkers, serveWarm } from "../jvm/tier.ts";
import { sendPlatformJars } from "../android/framework.ts";
import { displayRate } from "./display-rate.ts";
import { device } from "./config.ts";
import type { ClockBootstrap } from "./clock-port.ts";

/** what the page posts a process Worker (process-worker.ts): its prestart once spawned, the display's
 *  rate once measured, and its one start */
export type ProcessWorkerMessage = { kind: "prestart"; clock: ClockBootstrap; aot: MessagePort; jars: MessagePort; compile: MessagePort; warm: MessagePort }
  | { kind: "rate"; rate: number } | { kind: "start"; bootstrap: ProcessBootstrap; endpoint: MessagePort; control: MessagePort };
/** what a process Worker posts the page once its start succeeds or fails */
export type ProcessWorkerStatus = { kind: "ready" } | { kind: "failed"; error: ProcessFailure; logs: string[] };
const post = (worker: Worker, message: ProcessWorkerMessage, transfer: Transferable[] = []) => worker.postMessage(message, transfer);
export const workerControlMethods = methodsOf<WorkerControl>()(["snapshot", "aotProfile", "codeReadiness", "demandMark", "demandSince", "alive", "uiTree", "tap", "swipe", "type", "enter", "imeState", "pointer", "back", "testFrame", "timeline"]);

export type SpareWorker = { pid: number; url: string; worker: Worker; release(): void; error?: string };
/** A process Worker that loads its runtime before the broker gives it a package; the Wasm tier's modules come from the page's store. */
export function spawnProcessWorker(url: string, pid: number): SpareWorker {
  const worker = new Worker(url, { type: "module" }), clock = createGuestClockPort(pid), aot = new MessageChannel(), jars = new MessageChannel(), compile = new MessageChannel(), warm = new MessageChannel();
  serveAot(aot.port1);
  sendPlatformJars(jars.port1);
  serveCompileWorkers(compile.port1);
  serveWarm(warm.port1);
  const spare: SpareWorker = { pid, url: new URL(url, location.href).href, worker, release: () => { clock.close(); aot.port1.close(); compile.port1.close(); } };
  worker.onerror = event => { spare.error ??= event.message; };
  post(worker, { kind: "prestart", clock: clock.data, aot: aot.port2, jars: jars.port2, compile: compile.port2, warm: warm.port2 },
    [aot.port2, jars.port2, compile.port2, warm.port2, ...clock.data.port ? [clock.data.port] : []]);
  // the zygote it runs reads the display's rate
  void displayRate().then(() => post(worker, { kind: "rate", rate: device.refreshRate }));
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
  worker.onmessage = ({data}: MessageEvent<ProcessWorkerStatus>) => {
    if (closed) return;
    if (data.kind === "ready" && !published) {
      try { ready(endpoint.port2); published = true; }
      catch (error) { failed(String(error)); }
    } else if (data.kind === "failed") {
      for (const log of data.logs) console.error("[process Worker]", log);
      failed(data.error.message ?? "Process Worker startup failed");
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
        post(worker, {kind:"start",bootstrap:data,endpoint:endpoint.port1,control:control.port2},
          [...bootstrapTransfers(data),endpoint.port1,control.port2]);
        transferred = true;
      } catch (error) { closeProcessBootstrap(data); throw error; }
    } catch (error) { if (!closed) failed(String(error)); }
  })(); });
  return { url: spare.url, control: client.endpoint, close };
}
