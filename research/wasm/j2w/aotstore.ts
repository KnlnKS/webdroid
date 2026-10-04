// The build's files in a page or worker: fetched and compiled ahead of use, off the main thread, and read synchronously, the way World needs them, when the code that wants one runs. A file nobody asked for ahead is
// fetched synchronously, which only a worker may do.
import type { AotStore } from "./aot";
import { COMPILE_OPTIONS } from "./lazy";

export class FetchStore implements AotStore {
  private modules = new Map<string, WebAssembly.Module>();
  private bytes = new Map<string, Uint8Array>();
  constructor(private base: string) {}
  /** starts fetching and compiling `files`; resolves when all are ready */
  prefetch(files: string[]): Promise<void> {
    return Promise.all(files.filter((f) => !this.modules.has(f)).map(async (f) => {
      this.modules.set(f, await WebAssembly.compileStreaming(fetch(this.base + f), COMPILE_OPTIONS as never));
    })).then(() => undefined);
  }
  /** fetches a file that is data (the index) */
  async fetchBytes(file: string): Promise<void> { this.bytes.set(file, new Uint8Array(await (await fetch(this.base + file)).arrayBuffer())); }
  get(file: string): Uint8Array | WebAssembly.Module {
    const ready = this.modules.get(file) ?? this.bytes.get(file);
    if (ready) return ready;
    const x = new XMLHttpRequest();
    x.open("GET", this.base + file, false);
    x.responseType = "arraybuffer";
    x.send();
    return new Uint8Array(x.response as ArrayBuffer);
  }
}
