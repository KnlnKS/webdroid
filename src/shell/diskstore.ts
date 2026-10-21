// Files too large to keep in memory, stored in the origin private file system by the disk Worker
// (disk-worker.ts), which runs requests in arrival order: a read queued after a write sees it,
// which lets writes return before the Worker has run them.
import type { WritableSource } from "./lazyfile.ts";
import { callProxy, methodsOf } from "./rpc.ts";
import { WORKER_SCRIPTS } from "../worker-scripts.ts";

/** what the disk Worker answers, of the files it names by id */
export type DiskCalls = {
  read(id: string, at: number, size: number): Promise<Uint8Array>;
  write(id: string, at: number, bytes: Uint8Array): Promise<void>;
  truncate(id: string, size: number): Promise<void>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  flush(): Promise<void>;
  /** whether the file still holds `size` bytes */
  holds(id: string, size: number): Promise<boolean>;
};
const diskMethods = methodsOf<DiskCalls>()(["read", "write", "truncate", "remove", "clear", "flush", "holds"]);
/** an origin private file system entry already removed is what its removal wanted */
export const gone = (error: unknown): void => { if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error; };

const CHUNK = 1 << 20, CACHE_CHUNKS = 64;

export class DiskStore {
  private calls: DiskCalls | null = null;
  private readonly files = new Map<string, DiskFile>();
  /** recently read chunks of every file, least recently used first */
  readonly cache = new Map<string, Uint8Array>();

  /** the disk Worker, started on first use */
  get disk(): DiskCalls {
    if (this.calls) return this.calls;
    // best-effort storage may be evicted under disk pressure, which would lose downloaded data
    void navigator.storage.persist().catch(() => {});
    const worker = new Worker(WORKER_SCRIPTS.disk.url, { type: "module" }), { port1, port2 } = new MessageChannel();
    worker.postMessage(port2, [port2]);
    return this.calls = callProxy<DiskCalls>(port1, diskMethods, { transfer: { write: (_id, _at, bytes) => [bytes.buffer] } }).endpoint;
  }
  /** one instance per id, so every process sees the same size */
  file(id: string, size: number): DiskFile {
    let file = this.files.get(id);
    if (!file) this.files.set(id, file = new DiskFile(this, id, size));
    return file;
  }
  create(): DiskFile { return this.file(crypto.randomUUID(), 0); }
  remove(id: string): Promise<void> {
    this.files.get(id)?.drop(0);
    this.files.delete(id);
    return this.disk.remove(id);
  }
  clear(): Promise<void> {
    this.files.clear(); this.cache.clear();
    return this.disk.clear();
  }
  flush(): Promise<void> { return this.calls ? this.calls.flush() : Promise.resolve(); }
  holds(id: string, size: number): Promise<boolean> { return size ? this.disk.holds(id, size) : Promise.resolve(true); }
}

export class DiskFile implements WritableSource {
  private readonly store: DiskStore; readonly id: string; size: number;
  constructor(store: DiskStore, id: string, size: number) { this.store = store; this.id = id; this.size = size; }
  read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(this.size, offset)), end = Math.min(this.size, start + Math.max(0, length));
    if (start === end) return Promise.resolve(new Uint8Array(0));
    const index = Math.floor(start / CHUNK), within = start - index * CHUNK;
    return this.chunk(index).then((chunk) => chunk.subarray(within, Math.min(chunk.length, within + end - start)));
  }
  private async chunk(index: number): Promise<Uint8Array> {
    const key = this.id + ":" + index, cache = this.store.cache, cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
    const bytes = await this.store.disk.read(this.id, index * CHUNK, CHUNK);
    cache.set(key, bytes);
    if (cache.size > CACHE_CHUNKS) cache.delete(cache.keys().next().value!);
    return bytes;
  }
  /** queued in order behind earlier requests; `bytes` is transferred, so callers pass a copy */
  write(offset: number, bytes: Uint8Array): void {
    if (!bytes.length) return;
    this.drop(offset, offset + bytes.length);
    this.size = Math.max(this.size, offset + bytes.length);
    this.store.disk.write(this.id, offset, bytes).catch((error) => console.error("[disk]", this.id, error));
  }
  truncate(size: number): void {
    this.drop(Math.min(size, this.size));
    this.size = size;
    this.store.disk.truncate(this.id, size).catch((error) => console.error("[disk]", this.id, error));
  }
  /** forget cached chunks overlapping [from, to) */
  drop(from: number, to = Infinity): void {
    for (let index = Math.floor(from / CHUNK); index * CHUNK < Math.min(to, this.size); index++) this.store.cache.delete(this.id + ":" + index);
  }
}
