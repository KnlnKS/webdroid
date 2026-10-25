// The page's side of the compile worker (compile-serve.ts): the World's CompileService. A hot method's second-tier compile (Upgrades.job) goes to the worker, one job at a time, and
// its unit is installed when it arrives, if the World can still take it (Tiering.adopt); the method runs its first-tier code meanwhile. Without a worker, or once the worker has
// failed or the Program has gained something it cannot follow, the World compiles inline as before.
import { note, Ev } from "../../timeline.ts";
import { answeringFor } from "../../jvm/yield.ts";
import { compileBytes } from "../link/module.ts";
import type { CompileService } from "../link/hostapi.ts";
import type { AppIndex } from "../link/aot.ts";
import type { Marks } from "../link/numbers.ts";
import type { UnitJob } from "../link/unit.ts";
import type { ProxyDefinition } from "../link/proxy.ts";
import type { World } from "../link/world.ts";
import type { Loader, LoaderId, Program } from "../compiler/program.ts";
import type { DexFile } from "../../jvm/dex.ts";
import type { CompileRequest, CompileResponse, Containers, Port } from "./compile-serve.ts";
import type { WarmAnswer } from "./warm-worker.ts";

/** a worker, or anything that serves the protocol */
export interface WorkerPort extends Port { terminate(): void; onerror: ((e: ErrorEvent) => void) | null }
/** jobs waiting for the worker; a hot method that finds the queue full asks again after another budget */
const MAX_QUEUE = 16, MAX_FAILURES = 3;
/** a merge (Merges.job) is paced to leave the worker idle MERGE_REST times as long as it took: its compiling allocates fast enough to grow the worker's heap
 *  faster than collections shrink it, in the address space the page's compile workers share (compilehost.ts) */
const MERGE_REST = 2;

/** what starts a compile worker: the ports of its protocol, of its fetches and of its end (it posts a failure's message, and is terminated when sent anything) */
export interface CompileWorkerRequest { port: MessagePort; fetcher: MessagePort; ctl: MessagePort }
/** A compile worker. The page's compile host starts it in a process of its own (compilehost.ts) when `host` is that host's port; a realm without one starts
 *  it itself. Its fetches are this realm's, whose origin they are on. */
export function spawnCompileWorker(host: MessagePort | undefined, url: string): WorkerPort {
  const data = new MessageChannel(), fetcher = new MessageChannel(), ctl = new MessageChannel();
  const req: CompileWorkerRequest = { port: data.port2, fetcher: fetcher.port2, ctl: ctl.port2 };
  if (host) host.postMessage(req, [req.port, req.fetcher, req.ctl]); else startCompileWorker(url, req);
  fetcher.port1.onmessage = async ({ data: [id, url] }: MessageEvent<[number, string]>) => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      fetcher.port1.postMessage([id, bytes], [bytes.buffer]);
    } catch (e) { fetcher.port1.postMessage([id, null, String(e)]); }
  };
  const worker: WorkerPort = {
    onmessage: null, onerror: null,
    postMessage: (m, transfer = []) => data.port1.postMessage(m, transfer),
    terminate: () => { ctl.port1.postMessage(0); data.port1.close(); fetcher.port1.close(); },
  };
  data.port1.onmessage = (e) => worker.onmessage?.(e);
  // the worker's end of the port closes when it ends, or when its process does without a word (a renderer's crash)
  data.port1.addEventListener("close", () => worker.onerror?.({ message: "the compile worker ended" } as ErrorEvent));
  data.port1.onmessageerror = () => worker.onerror?.({ message: "a message from the compile worker could not be read" } as ErrorEvent);
  ctl.port1.onmessage = ({ data: message }) => worker.onerror?.({ message } as ErrorEvent);
  return worker;
}
/** starts the compile worker of script `url` for `req` in this realm, with the platform's `jars` for the compile host's workers to read (compilehost.ts). The compile
 *  host's document runs its source, so it uses nothing outside itself. */
export function startCompileWorker(url: string, req: CompileWorkerRequest, type: WorkerType = "module", jars?: Blob[]): void {
  const worker = new Worker(url, { type });
  worker.onerror = (e) => req.ctl.postMessage(e.message || "the compile worker failed");
  req.ctl.onmessage = () => { worker.terminate(); req.ctl.close(); };
  worker.postMessage({ port: req.port, fetcher: req.fetcher, jars }, [req.port, req.fetcher]);
}

/** `dexes` as the archives they are views of, copied for the worker (the copies are transferred) */
export function containers(dexes: Iterable<DexFile>): Containers {
  const byBytes = new Map<Uint8Array, string>();
  for (const d of dexes) if (!byBytes.has(d.bytes)) byBytes.set(d.bytes, d.name.split("!")[0]);
  return [...byBytes].map(([bytes, name]) => [name, bytes.slice()]);
}

/** the dex files `prog` has loaded, by the id of their defining loader: of every loader, or of those `keep` takes */
export function dexesByLoader(prog: Program, keep?: (loader: Loader) => boolean): Map<LoaderId, DexFile[]> {
  const groups = new Map<LoaderId, DexFile[]>();
  for (const [dex, loader] of prog.loadedDexes()) if (!keep || keep(loader)) {
    const id = prog.loaderId(loader);
    let list = groups.get(id);
    if (!list) groups.set(id, list = []);
    list.push(dex);
  }
  return groups;
}

export class CompileClient implements CompileService {
  private source: WorkerPort | (() => WorkerPort); private holdMerges: () => boolean;
  private warm?: (module: WebAssembly.Module, bytes: Uint8Array) => Promise<WarmAnswer | undefined>;
  readonly stats = { jobs: 0, adopted: 0, stale: 0, failed: 0, warmed: 0, workerMs: 0, adoptMs: 0, startMs: 0 };
  private state: "idle" | "starting" | "ready" | "retired" = "idle";
  private w?: World;
  /** what the worker has numbered, as numbers of the World's, and whether it kept the numbering of its last unit */
  private marks!: Marks;
  private keep = false;
  private queue: number[] = [];
  private busy?: { id: number; slot: number; job: UnitJob; epoch: number; from: Marks; sent: number };
  private mergeAfter = 0;
  private nextId = 0;

  private port?: WorkerPort;
  private setup?: { aotBase: string | undefined; app: AppIndex | undefined };
  /** `holdMerges`: whether merges wait, as while another worker's compiling takes the memory; `warm` has the page's warm Worker compile a merge's methods */
  constructor(source: WorkerPort | (() => WorkerPort), { holdMerges = () => false, warm }: { holdMerges?: () => boolean; warm?: (module: WebAssembly.Module, bytes: Uint8Array) => Promise<WarmAnswer | undefined> } = {}) {
    this.source = source; this.holdMerges = holdMerges; this.warm = warm;
    if (typeof source !== "function") this.attach(source);
  }
  private attach(port: WorkerPort): void {
    this.port = port;
    port.onmessage = ({ data }: MessageEvent<CompileResponse>) => {
      if (data.type !== "unit") { this.take(data); return; }
      // the engine compiles a unit's bytes off this thread: compiled in the handler, they kept a busy app from its frames for seconds. Bytes that do not compile fail the job
      const bytes = data.result.module as Uint8Array, merge = this.busy?.id === data.id && this.busy.job.kind === "merge";
      void compileBytes(bytes).then(async (module) => {
        data.result.module = module;
        if (merge && this.warm) this.stats.warmed += (await this.warm(module, bytes))?.warmed ?? 0;
        this.take(data);
      }, (e) => this.take({ type: "failed", id: data.id, message: `${this.busy?.job.installed[0]}: ${(e as Error).message}` }));
    };
    port.onerror = (e) => this.stop(`the compile worker failed: ${e.message}`);
  }
  private take(m: CompileResponse): void { note(Ev.Upgrade, this.busy?.slot ?? 0); try { this.receive(m); } finally { note(Ev.Upgraded); } }
  get ready(): boolean { return this.state === "ready"; }
  /** the reason the worker stopped serving, if it did */
  retired?: string;

  /** starts the worker over `w`'s Program as it is now: `aotBase` is where the platform build's files are fetched from, and `w` has `app` attached if it says so */
  start(w: World, aotBase: string | undefined, app: AppIndex | undefined): void {
    if (this.state === "retired") return;
    this.w = w; this.setup = { aotBase, app };
    if (this.port) this.initialize();
  }
  // Capture current numbering and DEX only when real work arrives; an unused service owns no compiler World.
  private initialize(): void {
    const w = this.w!, { aotBase, app } = this.setup!;
    const loaders = w.prog.loaderSnapshot(), groups = dexesByLoader(w.prog);
    const scopes: [LoaderId, Containers][] = [...groups].filter(([id]) => id !== 0).map(([id, dexes]) => [id, containers(dexes)]);
    this.state = "starting";
    const t0 = performance.now(), sync = w.numbers.since(w.base), list = containers(groups.get(0) ?? []);
    this.marks = w.numbers.marks();
    this.post({ type: "units", dexes: list, aot: aotBase === undefined ? undefined : { base: aotBase, app: w.appAttached ? app : undefined }, sync, hostClasses: w.hostClassNames(), loaders, scopes, proxies: [...w.proxies.values()] }, [list, ...scopes.map(([, list]) => list)].flatMap(list => list.map(([, b]) => b.buffer as ArrayBuffer)));
    this.stats.startMs = t0;
  }
  private loaded = false;
  private waiting: [CompileRequest, Transferable[]][] = [];
  private post(m: CompileRequest, transfer: Transferable[] = []): void { if (this.loaded) this.port!.postMessage(m, transfer); else this.waiting.push([m, transfer]); }

  /** whether the worker serves, starting it if it has not been */
  private serving(): boolean {
    if (this.state === "idle" && this.w) {
      try { this.attach((this.source as () => WorkerPort)()); this.initialize(); }
      catch (e) { this.stop(`the compile worker could not start: ${String(e)}`); }
    }
    return this.started;
  }
  private get started(): boolean { return this.state === "ready" || this.state === "starting"; }
  submit(_w: World, slot: number): boolean | "later" {
    if (!this.serving()) return false;
    if (this.queue.length >= MAX_QUEUE) return "later";
    this.queue.push(slot);
    this.pump();
    return true;
  }
  merge(_w: World): void { if (this.serving()) this.pump(); }
  added(dexes: DexFile[], loader?: Loader): void {
    if (!this.started) return;
    const list = containers(dexes);
    this.post({ type: "add", dexes: list, loader: this.w!.prog.loaderId(loader ?? this.w!.prog.root), loaders: this.w!.prog.loaderSnapshot() }, list.map(([, b]) => b.buffer as ArrayBuffer));
  }
  proxy(definition: ProxyDefinition): void {
    if (this.started) this.post({ type: "proxy", definition, loaders: this.w!.prog.loaderSnapshot() });
  }
  namespaces(): void {
    if (this.started) this.post({ type: "namespaces", loaders: this.w!.prog.loaderSnapshot() });
  }
  private pump(): void {
    if (this.state !== "ready" || this.holding()) return;
    const w = this.w!;
    while (!this.busy && this.queue.length) {
      const slot = this.queue.shift()!, job = w.upgrades.job(slot);
      if (job) this.send(slot, job); else w.upgrades.release(slot);
    }
    if (!this.busy && performance.now() >= this.mergeAfter && !this.holdMerges()) { const job = w.merges.job(); if (job) this.send(-1, job); }
  }
  private send(slot: number, job: UnitJob): void {
    const w = this.w!, from = w.numbers.marks(), id = this.nextId++;
    this.busy = { id, slot, job, epoch: w.epoch, from, sent: performance.now() };
    this.post({ type: "upgrade", id, keep: this.keep, sync: w.numbers.since(this.marks), job });
    this.marks = from; this.keep = false;
    this.stats.jobs++;
  }
  private receive(m: CompileResponse): void {
    if (this.state === "retired") return;
    if (m.type === "loaded") { this.loaded = true; for (const [req, transfer] of this.waiting.splice(0)) this.port!.postMessage(req, transfer); return; }
    const w = this.w!;
    if (m.type === "ready") { this.state = "ready"; this.stats.startMs = performance.now() - this.stats.startMs; this.pump(); return; }
    if (m.type === "failed" && m.id === undefined) { this.stop(m.message); return; }
    if (m.type === "built") return;
    const busy = this.busy;
    if (!busy || m.id !== busy.id) return;
    if (m.type === "unit" && this.holding(m)) return;
    this.busy = undefined;
    if (busy.job.kind === "merge") this.mergeAfter = performance.now() * (1 + MERGE_REST) - busy.sent * MERGE_REST;
    if (m.type === "failed") {
      // the method stays on its first-tier code and does not ask again; a worker that keeps failing has lost track of the numbering
      if (++this.stats.failed > MAX_FAILURES) this.stop(m.message); else this.pump();
      return;
    }
    if (m.type !== "unit") return;
    this.stats.workerMs += m.ms;
    const n = m.result.numbering, numbered = n.names.length + n.tail.length + n.selectors.length + n.gaps.length + n.links.length > 0;
    const t0 = performance.now(), taken = w.tiers.adopt(busy.slot, busy.job, m.result, busy.epoch);
    this.stats.adoptMs += performance.now() - t0;
    if (taken) {
      this.stats.adopted++;
      if (numbered) { this.keep = true; this.marks = w.numbers.marks(); }
    } else this.stats.stale++;
    this.pump();
  }
  private held?: { timer: ReturnType<typeof setTimeout>; unit?: CompileResponse };
  /** Planning a job and taking a unit (`unit`) wait while the app answers input: either would spend main-thread time in the response, and a unit replaces
   *  code the engine has compiled, which the methods that run next compile again. Answers whether the work was put off until then. */
  private holding(unit?: CompileResponse): boolean {
    const wait = answeringFor();
    if (!wait) return false;
    this.held ??= { timer: setTimeout(() => {
      const held = this.held!;
      this.held = undefined;
      if (held.unit) this.receive(held.unit); else this.pump();
    }, wait) };
    if (unit) this.held.unit = unit;
    return true;
  }
  // before start, the worker is given everything the World has when it starts
  retire(reason: string): void { if (this.w) this.stop(reason); }
  /** stops serving: what was queued is compiled inline when its method asks again */
  private stop(reason: string): void {
    if (this.state === "retired") return;
    this.state = "retired"; this.retired = reason;
    if (this.held) { clearTimeout(this.held.timer); this.held = undefined; }
    for (const slot of [...this.queue, ...this.busy ? [this.busy.slot] : []]) this.w?.upgrades.release(slot);
    this.queue = []; this.busy = undefined;
    this.waiting = []; this.w = undefined; this.setup = undefined;
    if (this.port) { this.port.onmessage = null; this.port.onerror = null; this.port.terminate(); this.port = undefined; }
  }
  close(): void { this.stop("closed"); }
}
