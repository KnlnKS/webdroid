// The page's side of each app process: the Worker it runs in, the canvas it presents to, the page's
// ends of its surfaces and its control port. The broker (processes.ts) registers the process and
// answers the host's bootstrap; the Worker itself is process-worker.ts.
import { bootstrapTransfers, closeProcessBootstrap, type ProcessBootstrap } from "./process-bootstrap-data.ts";
import { callProxy, methodsOf, processError, type ProcessFailure } from "./process-port.ts";
import type { WorkerControl } from "./worker-control.ts";
import type { WorkerTerminal } from "./worker-diagnostics.ts";
import { attachPointerInput } from "./pointer-input.ts";
import { createGuestClockPort } from "../guest-clock.ts";
import { serveTierPorts, type TierPorts } from "../jvm/tier.ts";
import { sendPlatformJars } from "../android/framework.ts";
import type { PackageRecord } from "../android/packages.ts";
import { is64BitPackage } from "../jvm/natives/jvmruntime.ts";
import { packedArchives } from "./packedarchive.ts";
import { displayRate } from "./display-rate.ts";
import { device, formatScreen } from "./config.ts";
import type { ClockBootstrap } from "./clock-port.ts";
import { receiveFrames, type FrameReceiver, type Mirror } from "./frame-port.ts";
import { inputMethods, receiveIme, type InputCalls } from "./input-port.ts";
import { receiveMedia } from "./media-port.ts";
import { receiveWebSurfaces } from "./web-surface-port.ts";
import { WORKER_SCRIPTS } from "../worker-scripts.ts";

/** what the page posts a process Worker: its prestart once spawned, the display's rate once
 *  measured, and its one start */
export type ProcessWorkerMessage = { kind: "prestart"; clock: ClockBootstrap; jars: MessagePort; tier: TierPorts }
  | { kind: "rate"; rate: number } | { kind: "start"; bootstrap: ProcessBootstrap; endpoint: MessagePort; control: MessagePort };
/** what a process Worker posts the page once its start succeeds or fails */
export type ProcessWorkerStatus = { kind: "ready" } | { kind: "failed"; error: ProcessFailure; logs: string[] };
const post = (worker: Worker, message: ProcessWorkerMessage, transfer: Transferable[] = []) => worker.postMessage(message, transfer);
export const workerControlMethods = methodsOf<WorkerControl>()(["snapshot", "aotProfile", "codeReadiness", "demandMark", "demandSince", "alive", "uiTree", "tap", "swipe", "type", "enter", "imeState", "back", "testFrame", "timeline"]);

export type SpareWorker = { pid: number; url: string; worker: Worker; release(): void; error?: string };
/** the URL of a process Worker; `wide` picks the bitness of the zygote it runs (process-worker.ts) */
function workerUrl(pid: number, wide: boolean): string {
  const params = new URLSearchParams(location.search);
  params.set("pid", String(pid)); params.set("screen", formatScreen(device)); params.set("statusBarDp", String(device.statusBarDp));
  if (!wide) params.set("abi", "32");
  return new URL(WORKER_SCRIPTS.process.url + "?" + params, location.href).href;
}
/** A process Worker that loads its runtime before the broker gives it a package; the Wasm tier's modules come from the page's store. */
function spawn(pid: number, wide: boolean): SpareWorker {
  const url = workerUrl(pid, wide), worker = new Worker(url, { type: "module" });
  const clock = createGuestClockPort(pid), jars = new MessageChannel(), tier = serveTierPorts();
  sendPlatformJars(jars.port1);
  const spare: SpareWorker = { pid, url, worker, release: () => { clock.close(); tier.close(); } };
  worker.onerror = event => { spare.error ??= event.message; };
  post(worker, { kind: "prestart", clock: clock.data, jars: jars.port2, tier: tier.ports },
    [jars.port2, ...Object.values(tier.ports), ...clock.data.port ? [clock.data.port] : []]);
  // the zygote it runs reads the display's rate
  void displayRate().then(() => post(worker, { kind: "rate", rate: device.refreshRate }));
  return spare;
}

/** what a host asks of the broker: its process's bootstrap, the endpoint its Worker serves once
 *  ready, and its failure */
export type HostOwner = {
  bootstrap(pid: number): Promise<ProcessBootstrap>;
  ready(pid: number, endpoint: MessagePort): void;
  failed(pid: number, message: string): void;
};

/** the process Workers: a spare one prestarted for the next process, and a host for each process
 *  that runs in one */
export class ProcessHosts {
  private nextPid = 1001;
  private spare: SpareWorker | undefined;
  /** what a new host's display mirrors */
  mirroring: Mirror = false;
  /** the hosts not yet closed */
  readonly live = new Set<ProcessHost>();
  readonly owner: HostOwner;
  constructor(owner: HostOwner) { this.owner = owner; }
  /** a Worker for the next process, loading its runtime and running the 64-bit zygote while the page boots, as the zygote's unspecialized app processes do */
  prestart(): void { this.spare ??= spawn(this.nextPid++, true); }
  /** a host for a new process of `owner`'s, in the spare Worker when it runs the zygote of the package's bitness */
  create(owner: PackageRecord): ProcessHost {
    const wide = is64BitPackage(packedArchives.get(owner.path)?.names() ?? Object.keys(owner.res.zip));
    let spare = this.spare;
    this.spare = undefined;
    if (spare && spare.url !== workerUrl(spare.pid, wide)) { spare.worker.terminate(); spare.release(); spare = undefined; }
    return this.adopt(spare ?? spawn(this.nextPid++, wide), owner.pkg);
  }
  /** a host for a process of `pkg` in `spare`, which the broker starts once it registers the process */
  adopt(spare: SpareWorker, pkg: string): ProcessHost {
    const host = new ProcessHost(spare, pkg, this);
    this.live.add(host);
    return host;
  }
  /** whether process Workers send the page a copy of each frame they show, or crops of its regions */
  mirror(on: Mirror): void {
    this.mirroring = on;
    for (const host of this.live) host.display?.mirror(on);
  }
}

/** One process's Worker, as the page holds it. The JVM endpoint's ownership passes to the broker
 *  once the Worker is ready. */
export class ProcessHost {
  readonly pid: number;
  readonly url: string;
  readonly canvas = document.createElement("canvas");
  /** settles once the process has presented a frame, or has died */
  readonly presented = Promise.withResolvers<void>();
  readonly control: WorkerControl;
  display: FrameReceiver | undefined;
  ime: ReturnType<typeof receiveIme> | undefined;
  /** how the process ended, which diagnostics report once its Worker is gone */
  ended: { error: string; terminal: WorkerTerminal } | null = null;
  private readonly spare: SpareWorker;
  private readonly hosts: ProcessHosts;
  private readonly endpoint = new MessageChannel();
  private readonly controlPorts = new MessageChannel();
  private readonly ends: (() => void)[] = [];
  private closed = false;
  private published = false;
  private transferred = false;
  private focusTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pagehide = () => this.fail("Process page closed");

  constructor(spare: SpareWorker, pkg: string, hosts: ProcessHosts) {
    const canvas = this.canvas, worker = spare.worker;
    this.spare = spare; this.hosts = hosts; this.pid = spare.pid; this.url = spare.url;
    canvas.dataset.pid = String(spare.pid); canvas.dataset.pkg = pkg;
    canvas.hidden = true;
    canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border-radius:16px;z-index:1;touch-action:none";
    (document.getElementById("screen")?.parentElement ?? document.body).appendChild(canvas);
    const client = callProxy<WorkerControl>(this.controlPorts.port1, workerControlMethods, [], processError,
      error => this.fail(error.message ?? "Process Worker control closed"));
    this.control = client.endpoint;
    this.ends.push(client.close);
    window.addEventListener("pagehide", this.pagehide, { once: true });
    worker.onerror = event => this.fail(event.message);
    worker.onmessageerror = () => this.fail("Invalid process Worker message");
    worker.onmessage = ({ data }: MessageEvent<ProcessWorkerStatus>) => {
      if (this.closed) return;
      if (data.kind === "ready" && !this.published) {
        try { hosts.owner.ready(this.pid, this.endpoint.port2); this.published = true; }
        catch (error) { this.fail(String(error)); }
      } else if (data.kind === "failed") {
        for (const log of data.logs) console.error("[process Worker]", log);
        this.fail(data.error.message ?? "Process Worker startup failed");
      }
    };
  }
  /** sends the Worker its process's bootstrap, once the broker has registered the process */
  start(): void {
    void (async () => {
      if (this.spare.error) throw new Error(this.spare.error);
      const data = await this.hosts.owner.bootstrap(this.pid);
      if (this.closed) { closeProcessBootstrap(data); return; }
      try {
        post(this.spare.worker, { kind: "start", bootstrap: data, endpoint: this.endpoint.port1, control: this.controlPorts.port2 },
          [...bootstrapTransfers(data), this.endpoint.port1, this.controlPorts.port2]);
        this.transferred = true;
      } catch (error) { closeProcessBootstrap(data); throw error; }
    })().catch(error => this.fail(String(error)));
  }
  /** the bootstrap's ends of the process's display, input, web and media ports, once: the canvas
   *  hands its control to the display */
  surfaces(): Pick<ProcessBootstrap, "display" | "screen" | "input" | "ime" | "web" | "media"> {
    const display = new MessageChannel(), input = new MessageChannel(), ime = new MessageChannel(), web = new MessageChannel(), media = new MessageChannel();
    const canvas = this.canvas, frames = this.display = receiveFrames(display.port1, canvas, () => this.presented.resolve());
    if (this.hosts.mirroring) frames.mirror(this.hosts.mirroring);
    const calls = callProxy<InputCalls>(input.port1, inputMethods), text = this.ime = receiveIme(ime.port1, canvas, calls.endpoint);
    const pointers = attachPointerInput(canvas, () => device, calls.endpoint.pointer, () => {
      clearTimeout(this.focusTimer);
      this.focusTimer = setTimeout(() => { this.focusTimer = undefined; if (!this.closed) text.focus(); }, 0);
    });
    this.ends.push(pointers.close, calls.close, text.close, frames.close, receiveMedia(media.port1), receiveWebSurfaces(web.port1, canvas, () => device));
    return { display: display.port2, screen: canvas.transferControlToOffscreen(), input: input.port2, ime: ime.port2, web: web.port2, media: media.port2 };
  }
  private fail(message: string): void { if (!this.closed) this.hosts.owner.failed(this.pid, message); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.focusTimer); window.removeEventListener("pagehide", this.pagehide);
    for (const close of this.ends) close();
    this.spare.worker.terminate(); this.spare.release();
    if (!this.published) this.endpoint.port2.close();
    if (!this.transferred) { this.endpoint.port1.close(); this.controlPorts.port2.close(); }
    this.presented.resolve(); this.canvas.remove(); this.hosts.live.delete(this);
  }
}
