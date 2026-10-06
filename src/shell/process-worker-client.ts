import { bootstrapTransfers, closeProcessBootstrap, type ProcessBootstrap } from "./process-bootstrap-data";
import { callProxy, processError, type ProcessFailure } from "./process-port";
import type { WorkerControl } from "./worker-control";
import { workerControlMethods } from "./worker-control-methods";
import { attachPointerInput, type PointerGeometry } from "./pointer-input";

/** Page-owned Worker, input and control ports. JVM endpoint ownership passes to the broker on ready. */
export function startProcessWorker(url: string, canvas: HTMLCanvasElement, geometry: () => PointerGeometry,
  bootstrap: () => Promise<ProcessBootstrap>, ready: (port: MessagePort) => void, failed: (message: string) => void, focusInput: () => void = () => {}) {
  const worker = new Worker(url, { type: "module" });
  const endpoint = new MessageChannel(), control = new MessageChannel();
  let closed = false, published = false, transferred = false, ticking = false, frame = 0;
  const client = callProxy<WorkerControl>(control.port1, workerControlMethods, [], processError,
    error => { if (!closed) failed(error.message ?? "Process Worker control closed"); });
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const pointers = attachPointerInput(canvas, geometry, client.endpoint.pointer, () => {
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => { focusTimer = undefined; if (!closed) focusInput(); }, 0);
  });
  const close = () => {
    if (closed) return;
    closed = true; clearTimeout(focusTimer); window.removeEventListener("pagehide", pagehide); cancelAnimationFrame(frame); pointers.close(); client.close(); worker.terminate();
    if (!published) endpoint.port2.close();
    if (!transferred) { endpoint.port1.close(); control.port2.close(); }
  };
  const pagehide = () => { if (!closed) failed("Process page closed"); };
  window.addEventListener("pagehide", pagehide, {once:true});
  const tick = (time: number) => {
    if (closed) return;
    pointers.drain();
    if (!ticking) {
      ticking = true;
      void client.endpoint.frame(time).catch(error => { if (!closed) failed(String(error)); }).finally(() => { ticking = false; });
    }
    frame = requestAnimationFrame(tick);
  };
  worker.onerror = event => { if (!closed) failed(event.message); };
  worker.onmessageerror = () => { if (!closed) failed("Invalid process Worker message"); };
  worker.onmessage = ({data}: MessageEvent<{kind:string;error?:ProcessFailure;logs?:string[]}>) => {
    if (closed) return;
    if (data.kind === "ready" && !published) {
      try { ready(endpoint.port2); published = true; frame = requestAnimationFrame(tick); }
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
      const data = await bootstrap();
      if (closed) { closeProcessBootstrap(data); return; }
      try {
        worker.postMessage({bootstrap:data,endpoint:endpoint.port1,control:control.port2},
          [...bootstrapTransfers(data),endpoint.port1,control.port2]);
        transferred = true;
      } catch (error) { closeProcessBootstrap(data); throw error; }
    } catch (error) { if (!closed) failed(String(error)); }
  })(); });
  return { url: new URL(url, location.href).href, control: client.endpoint, close };
}
