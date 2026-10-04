// The build's files in a page: the index and the modules a start of the process loads are fetched and compiled ahead of use, off the main thread, and read
// synchronously, the way World needs them, when the code that wants one runs. A page cannot fetch synchronously (a synchronous XMLHttpRequest on the main
// thread is deprecated and cannot return an arraybuffer), so a module nobody asked for ahead is a miss and its code is compiled on demand (aot.ts).
import type { AotStore } from "./aot";
import { compileStream } from "./module";

export class FetchStore implements AotStore {
  private files = new Map<string, WebAssembly.Module | Uint8Array>();
  /** the files that could not be fetched or compiled */
  failed: string[] = [];
  constructor(readonly base: string) {}
  /** the build's key: its directory's name */
  get key(): string { return this.base.split("/").filter(Boolean).pop()!; }
  /** fetches `files` and compiles them as modules; a file that fails is left out, as if the build lacked it */
  async prefetch(files: string[]): Promise<void> {
    await Promise.all(files.filter((f) => !this.files.has(f)).map(async (f) => {
      try { this.files.set(f, await compileStream(fetch(this.base + f))); } catch { this.failed.push(f); }
    }));
  }
  /** fetches `file` as bytes: the index and the list of a start's modules */
  async fetchBytes(file: string): Promise<Uint8Array> {
    const res = await fetch(this.base + file);
    if (!res.ok) throw new Error(`${this.base + file}: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.files.set(file, bytes);
    return bytes;
  }
  get(file: string): Uint8Array | WebAssembly.Module | undefined { return this.files.get(file); }
}
