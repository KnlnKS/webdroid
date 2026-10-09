// The page's side of the compile worker (compile-serve.ts): the World's CompileService. A hot method's second-tier compile (World.upgradeJob) goes to the worker, one job at a time, and
// its unit is installed when it arrives, if the World can still take it (World.adoptUnit); the method runs its first-tier code meanwhile. Without a worker, or once the worker has
// failed or the Program has gained something it cannot follow, the World compiles inline as before.
import type { CompileService } from "../link/hostapi";
import type { AppIndex, Marks } from "../link/aot";
import type { UpgradeJob } from "../link/unit";
import type { ProxyDefinition } from "../link/proxy";
import type { World } from "../link/world";
import type { Loader, LoaderId } from "../compiler/program";
import type { DexFile } from "../../jvm/dex";
import type { CompileRequest, CompileResponse, Containers, Port } from "./compile-serve";

/** a worker, or anything that serves the protocol */
export interface WorkerPort extends Port { terminate(): void; onerror: ((e: ErrorEvent) => void) | null }
/** jobs waiting for the worker; a hot method that finds the queue full is compiled inline */
const MAX_QUEUE = 16, MAX_FAILURES = 3;

/** `dexes` as the archives they are views of, copied for the worker (the copies are transferred) */
export function containers(dexes: Iterable<DexFile>): Containers {
  const byBytes = new Map<Uint8Array, string>();
  for (const d of dexes) if (!byBytes.has(d.bytes)) byBytes.set(d.bytes, d.name.split("!")[0]);
  return [...byBytes].map(([bytes, name]) => [name, bytes.slice()]);
}

export class CompileClient implements CompileService {
  readonly stats = { jobs: 0, adopted: 0, stale: 0, failed: 0, workerMs: 0, adoptMs: 0, startMs: 0 };
  private state: "idle" | "starting" | "ready" | "retired" = "idle";
  private w?: World;
  /** what the worker has numbered, as numbers of the World's, and whether it kept the numbering of its last unit */
  private marks!: Marks;
  private keep = false;
  private queue: number[] = [];
  private busy?: { id: number; slot: number; job: UpgradeJob; epoch: number; from: Marks };
  private nextId = 0;

  private port?: WorkerPort;
  private setup?: { aotBase: string | undefined; app: AppIndex | undefined };
  constructor(private source: WorkerPort | (() => WorkerPort)) {
    if (typeof source !== "function") this.attach(source);
  }
  private attach(port: WorkerPort): void {
    this.port = port;
    port.onmessage = ({ data }: MessageEvent<CompileResponse>) => this.receive(data);
    port.onerror = (e) => this.retire(`the compile worker failed: ${e.message}`);
  }
  get ready(): boolean { return this.state === "ready"; }
  /** the reason the worker stopped serving, if it did */
  retired?: string;

  /** starts the worker over `w`'s Program as it is now: `aotBase` is where the platform build's files are fetched from, and `w` has `app` attached if it says so */
  start(w: World, aotBase: string | undefined, app: AppIndex | undefined): void {
    if (this.state === "retired") return;
    this.w = w; this.setup = { aotBase, app };
    if (!this.port) return;
    this.initialize();
  }
  // Capture current numbering and DEX only when real work arrives; an unused service owns no compiler World.
  private initialize(): void {
    const w = this.w!, { aotBase, app } = this.setup!;
    const loaders = w.prog.loaderSnapshot(), groups = new Map<LoaderId, DexFile[]>();
    for (const [dex, loader] of w.prog.loadedDexes()) {
      const id = w.prog.loaderId(loader);
      let list = groups.get(id);
      if (!list) groups.set(id, list = []);
      list.push(dex);
    }
    const scopes: [LoaderId, Containers][] = [...groups].filter(([id]) => id !== 0).map(([id, dexes]) => [id, containers(dexes)]);
    this.state = "starting";
    const t0 = performance.now(), sync = w.since(w.base), list = containers(groups.get(0) ?? []);
    this.marks = w.numbering();
    this.post({ type: "init", dexes: list, aot: aotBase === undefined ? undefined : { base: aotBase, app: w.appAttached ? app : undefined }, sync, initialized: w.newlyInitialized(), hostClasses: w.hostClassNames(), loaders, scopes, proxies: [...w.proxies.values()] }, [list, ...scopes.map(([, list]) => list)].flatMap(list => list.map(([, b]) => b.buffer as ArrayBuffer)));
    this.stats.startMs = t0;
  }
  private loaded = false;
  private waiting: [CompileRequest, Transferable[]][] = [];
  private post(m: CompileRequest, transfer: Transferable[] = []): void { if (this.loaded) this.port!.postMessage(m, transfer); else this.waiting.push([m, transfer]); }

  submit(_w: World, slot: number): boolean {
    if (this.state === "idle" && this.w) {
      try { this.attach((this.source as () => WorkerPort)()); this.initialize(); }
      catch (e) { this.retire(`the compile worker could not start: ${String(e)}`); }
    }
    if ((this.state !== "ready" && this.state !== "starting") || this.queue.length >= MAX_QUEUE) return false;
    this.queue.push(slot);
    this.pump();
    return true;
  }
  added(dexes: DexFile[] | null, loader?: Loader): void {
    if (this.state === "retired" || !this.w) return;
    if (!dexes) { this.retire("something the worker cannot follow was added"); return; }
    if (this.state === "idle") return;
    const list = containers(dexes);
    this.post({ type: "add", dexes: list, loader: this.w.prog.loaderId(loader ?? this.w.prog.root), loaders: this.w.prog.loaderSnapshot() }, list.map(([, b]) => b.buffer as ArrayBuffer));
  }
  proxy(definition: ProxyDefinition): void {
    if (this.state !== "ready" && this.state !== "starting") return;
    this.post({ type: "proxy", definition, loaders: this.w!.prog.loaderSnapshot() });
  }
  namespaces(): void {
    if (this.state === "ready" || this.state === "starting") this.post({ type: "namespaces", loaders: this.w!.prog.loaderSnapshot() });
  }
  private pump(): void {
    if (this.state !== "ready") return;
    const w = this.w!;
    while (!this.busy && this.queue.length) {
      const slot = this.queue.shift()!, job = w.upgradeJob(slot);
      if (!job) { w.release(slot); continue; }
      const from = w.numbering(), id = this.nextId++;
      this.busy = { id, slot, job, epoch: w.epoch, from };
      this.post({ type: "upgrade", id, keep: this.keep, sync: w.since(this.marks), job });
      this.marks = from; this.keep = false;
      this.stats.jobs++;
    }
  }
  private receive(m: CompileResponse): void {
    if (this.state === "retired") return;
    if (m.type === "loaded") { this.loaded = true; for (const [req, transfer] of this.waiting.splice(0)) this.port!.postMessage(req, transfer); return; }
    const w = this.w!;
    if (m.type === "ready") { this.state = "ready"; this.stats.startMs = performance.now() - this.stats.startMs; this.pump(); return; }
    if (m.type === "failed" && m.id === undefined) { this.retire(m.message); return; }
    if (m.type === "built") return;
    const busy = this.busy;
    if (!busy || m.id !== busy.id) return;
    this.busy = undefined;
    if (m.type === "failed") {
      if (busy.job.refresh !== undefined) {
        if (!this.queue.includes(busy.slot)) w.release(busy.slot);
        w.failedRefresh(busy.slot, busy.job.refresh);
      }
      // the method stays on its first-tier code and does not ask again; a worker that keeps failing has lost track of the numbering
      if (++this.stats.failed > MAX_FAILURES) this.retire(m.message); else this.pump();
      return;
    }
    if (m.type !== "unit") return;
    this.stats.workerMs += m.ms;
    const n = m.result.numbering, numbered = n.names.length + n.tail.length + n.selectors.length + n.gaps.length + n.links.length > 0;
    const t0 = performance.now(), taken = w.adoptUnit(busy.slot, busy.job, m.result, busy.epoch);
    this.stats.adoptMs += performance.now() - t0;
    if (taken) {
      this.stats.adopted++;
      if (numbered) { this.keep = true; this.marks = w.numbering(); }
    } else this.stats.stale++;
    this.pump();
  }
  /** stops serving: what was queued is compiled inline when its method asks again */
  private retire(reason: string): void {
    if (this.state === "retired") return;
    this.state = "retired"; this.retired = reason;
    for (const slot of [...this.queue, ...this.busy ? [this.busy.slot] : []]) this.w?.release(slot);
    this.queue = []; this.busy = undefined;
    this.waiting = []; this.w = undefined; this.setup = undefined;
    if (this.port) { this.port.onmessage = null; this.port.onerror = null; this.port.terminate(); this.port = undefined; }
  }
  close(): void { this.retire("closed"); }
}
