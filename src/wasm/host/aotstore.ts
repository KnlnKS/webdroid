// The build's files in a page: the index and the modules a start of the process loads are fetched and compiled ahead of use, off the main thread, and read
// synchronously, the way World needs them, when the code that wants one runs. A page cannot fetch synchronously (a synchronous XMLHttpRequest on the main
// thread is deprecated and cannot return an arraybuffer), so a module nobody asked for ahead is a miss: its code is compiled on demand (link/aot.ts), and the module is
// fetched for the realms that ask later.
import type { AotStore } from "../link/aot.ts";
import { compileStream } from "../link/module.ts";

/** Requests in flight at once. Chrome fails a request with ERR_INSUFFICIENT_RESOURCES once about 1,600 are pending (fetching the 2,100 files of the build together lost a quarter
 *  of them), and a page reaches its server over a few connections, so more than a few dozen in flight only queue in the network stack. */
const WIDTH = 16;

export class FetchStore implements AotStore {
  readonly base: string; readonly remote?: MessagePort;
  private files = new Map<string, WebAssembly.Module | Uint8Array>();
  /** the files to fetch on this thread, next first */
  private queue: string[] = [];
  /** each file asked for, settling once it is held or has failed */
  private loads = new Map<string, Promise<void>>();
  private settle = new Map<string, () => void>();
  private active = 0;
  /** the files that could not be fetched or compiled */
  failed: string[] = [];
  /** settles once the modules a start wants are held (or known to be missing): code does not run before, or it compiles what it finds missing on demand */
  ready: Promise<void> = Promise.resolve();
  /** `remote`: another thread's store of the same build, which fetches and compiles for this one (serveStore) */
  constructor(base: string, remote?: MessagePort) {
    this.base = base; this.remote = remote;
    if (remote) remote.onmessage = ({ data }: MessageEvent<{ file: string; module?: WebAssembly.Module }>) => {
      if (data.module) this.put(data.file, data.module); else this.fail(data.file);
    };
  }
  /** the build's key: its directory's name */
  get key(): string { return this.base.split("/").filter(Boolean).pop()!; }
  /** marks `files` as asked for and returns those nobody had asked for yet, for the caller to fetch */
  claim(files: string[]): string[] {
    return files.filter((f) => {
      if (this.loads.has(f)) return false;
      this.loads.set(f, new Promise((done) => this.settle.set(f, done)));
      return true;
    });
  }
  /** settles once each of `files` is held or has failed */
  arrived(files: string[]): Promise<void> { return Promise.all(files.map((f) => this.loads.get(f))).then(() => undefined); }
  /** fetches `files` in order and compiles them as modules, and answers when all are in; a file that fails is left out, as if the build lacked it */
  prefetch(files: string[]): Promise<void> {
    this.load(this.claim(files));
    return this.arrived(files);
  }
  /** fetches claimed `files` on this thread, or asks the remote store for them */
  load(files: string[], first = false): void {
    if (this.remote) { if (files.length) this.remote.postMessage(files); return; }
    if (first) this.queue.unshift(...files); else this.queue.push(...files);
    while (this.active < WIDTH && this.queue.length) {
      const f = this.queue.shift()!;
      this.active++;
      void compileStream(fetch(this.base + f)).then((m) => this.put(f, m), () => this.fail(f)).then(() => { this.active--; this.load([]); });
    }
  }
  /** the file if it is here, without asking for it */
  held(file: string): Uint8Array | WebAssembly.Module | undefined { return this.files.get(file); }
  /** adds `file` as the module compiled elsewhere (a worker: aotload.ts) */
  put(file: string, module: WebAssembly.Module): void { this.files.set(file, module); this.done(file); }
  fail(file: string): void { this.failed.push(file); this.done(file); }
  private done(file: string): void { this.settle.get(file)?.(); this.settle.delete(file); }
  /** the bytes of `file` (the index, a list of a start's modules), once fetched */
  bytes(file: string): Uint8Array | undefined { const b = this.files.get(file); return b instanceof Uint8Array ? b : undefined; }
  /** the module `file`, once arrived */
  module(file: string): WebAssembly.Module | undefined { const m = this.files.get(file); return m instanceof WebAssembly.Module ? m : undefined; }
  /** fetches `file` as bytes: the index and the list of a start's modules */
  async fetchBytes(file: string): Promise<Uint8Array> {
    const res = await fetch(this.base + file);
    if (!res.ok) throw new Error(`${this.base + file}: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.files.set(file, bytes);
    return bytes;
  }
  /** the files wanted so far, in order of first request, whether or not the store had them: what a start should prefetch (scripts/wasm/aot-profile.ts) */
  readonly wanted = new Set<string>();
  /** the classes each realm's World has linked and called of the build's (scripts/wasm/aot-profile.ts) */
  readonly worlds = new Set<() => { linked: string[]; called: string[] }>();
  get(file: string): Uint8Array | WebAssembly.Module | undefined {
    this.wanted.add(file);
    const have = this.files.get(file);
    // a module nobody has asked for is a miss for the code that wants it now, and is next in line for the realms that want it later
    if (!have) this.load(this.claim([file]), true);
    return have;
  }
}
