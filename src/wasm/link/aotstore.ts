// The build's files in a page: the index and the modules a start of the process loads are fetched and compiled ahead of use, off the main thread, and read
// synchronously, the way World needs them, when the code that wants one runs. A page cannot fetch synchronously (a synchronous XMLHttpRequest on the main
// thread is deprecated and cannot return an arraybuffer), so a module nobody asked for ahead is a miss: its code is compiled on demand (aot.ts), and the module is
// fetched for the realms that ask later.
import type { AotStore } from "./aot";
import { compileStream } from "./module";

/** Requests in flight at once. Chrome fails a request with ERR_INSUFFICIENT_RESOURCES once about 1,600 are pending (fetching the 2,100 files of the build together lost a quarter
 *  of them), and a page reaches its server over a few connections, so more than a few dozen in flight only queue in the network stack. */
const WIDTH = 16;

export class FetchStore implements AotStore {
  private files = new Map<string, WebAssembly.Module | Uint8Array>();
  /** the files to fetch, next first */
  private queue: string[] = [];
  private asked = new Set<string>();
  private active = 0;
  private waiting = new Map<string, (() => void)[]>();
  /** the files that could not be fetched or compiled */
  failed: string[] = [];
  /** settles once the modules a start wants are held (or known to be missing): code does not run before, or it compiles what it finds missing on demand */
  ready: Promise<void> = Promise.resolve();
  constructor(readonly base: string) {}
  /** the build's key: its directory's name */
  get key(): string { return this.base.split("/").filter(Boolean).pop()!; }
  /** fetches `files` in order and compiles them as modules, and answers when all are in; a file that fails is left out, as if the build lacked it */
  prefetch(files: string[]): Promise<void> {
    const all = files.map((f) => new Promise<void>((done) => {
      if (this.files.has(f) || this.failed.includes(f)) return done();
      this.waiting.set(f, [...(this.waiting.get(f) ?? []), done]);
      if (!this.asked.has(f)) { this.asked.add(f); this.queue.push(f); }
    }));
    this.pump();
    return Promise.all(all).then(() => undefined);
  }
  private pump(): void {
    while (this.active < WIDTH && this.queue.length) {
      const f = this.queue.shift()!;
      this.active++;
      void compileStream(fetch(this.base + f)).then((m) => { this.files.set(f, m); }, () => { this.failed.push(f); }).then(() => {
        this.active--;
        for (const done of this.waiting.get(f) ?? []) done();
        this.waiting.delete(f);
        this.pump();
      });
    }
  }
  has(file: string): boolean { return this.files.has(file); }
  /** adds `file` as the module compiled elsewhere (a worker: host/aotload.ts) */
  put(file: string, module: WebAssembly.Module): void { this.files.set(file, module); }
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
    if (!have && !this.asked.has(file)) { this.asked.add(file); this.queue.unshift(file); this.pump(); }
    return have;
  }
}
