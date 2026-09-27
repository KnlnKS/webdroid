// Files too large to keep in memory, stored in the origin private file system. Synchronous access
// handles exist only in workers, so one worker owns them and serves requests in arrival order: a
// read queued after a write sees it, which lets writes return before the worker has run them.

import type { WritableSource } from "./lazyfile";

const WORKER = `
let root;
const handles = new Map(), MAX_OPEN = 128;
function open(id) {
  let h = handles.get(id);
  if (h) { handles.delete(id); handles.set(id, h); return h; }
  h = (async () => {
    root ??= await (await navigator.storage.getDirectory()).getDirectoryHandle("webdroid-disk", {create: true});
    return (await root.getFileHandle(id, {create: true})).createSyncAccessHandle();
  })();
  handles.set(id, h);
  if (handles.size > MAX_OPEN) { const [old, oldest] = handles.entries().next().value; handles.delete(old); oldest.then(x => x.close(), () => {}); }
  return h;
}
let queue = Promise.resolve();
onmessage = ({data: {seq, op, id, at, size, bytes}}) => { queue = queue.then(async () => {
  try {
    if (op === "remove") {
      const h = handles.get(id); handles.delete(id);
      if (h) (await h).close();
      await (root ??= await (await navigator.storage.getDirectory()).getDirectoryHandle("webdroid-disk", {create: true})).removeEntry(id).catch(() => {});
      return postMessage({seq});
    }
    if (op === "clear") {
      for (const h of handles.values()) (await h).close();
      handles.clear(); root = undefined;
      await (await navigator.storage.getDirectory()).removeEntry("webdroid-disk", {recursive: true}).catch(() => {});
      return postMessage({seq});
    }
    if (op === "flush") { for (const h of handles.values()) (await h).flush(); return postMessage({seq}); }
    const h = await open(id);
    if (op === "read") { const out = new Uint8Array(size); const n = h.read(out, {at}); return postMessage({seq, bytes: out.subarray(0, n)}, [out.buffer]); }
    if (op === "write") h.write(bytes, {at});
    else if (op === "truncate") h.truncate(size);
    postMessage({seq});
  } catch (e) { postMessage({seq, error: String(e)}); }
}); };`;

const CHUNK = 1 << 20, CACHE_CHUNKS = 64;

export class DiskStore {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (bytes?: Uint8Array) => void; reject: (error: Error) => void }>();
  private readonly files = new Map<string, DiskFile>();
  /** recently read chunks of every file, least recently used first */
  readonly cache = new Map<string, Uint8Array>();

  call(op: string, id: string, at = 0, size = 0, bytes?: Uint8Array): Promise<Uint8Array | undefined> {
    const worker = this.worker ??= this.start();
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      worker.postMessage({ seq, op, id, at, size, bytes }, bytes ? [bytes.buffer] : []);
    });
  }
  private start(): Worker {
    // best-effort storage may be evicted under disk pressure, which would lose downloaded data
    void navigator.storage.persist().catch(() => {});
    const worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" })));
    worker.onmessage = ({ data }: MessageEvent<{ seq: number; bytes?: Uint8Array; error?: string }>) => {
      const request = this.pending.get(data.seq);
      this.pending.delete(data.seq);
      if (data.error) request?.reject(new Error(data.error)); else request?.resolve(data.bytes);
    };
    return worker;
  }
  /** one instance per id, so every process sees the same size */
  file(id: string, size: number): DiskFile {
    let file = this.files.get(id);
    if (!file) this.files.set(id, file = new DiskFile(this, id, size));
    return file;
  }
  create(): DiskFile { return this.file(crypto.randomUUID(), 0); }
  remove(id: string): Promise<unknown> {
    this.files.get(id)?.drop(0);
    this.files.delete(id);
    return this.call("remove", id);
  }
  clear(): Promise<unknown> {
    this.files.clear(); this.cache.clear();
    return this.call("clear", "");
  }
  flush(): Promise<unknown> { return this.worker ? this.call("flush", "") : Promise.resolve(); }
}

export class DiskFile implements WritableSource {
  constructor(private readonly store: DiskStore, readonly id: string, public size: number) {}
  read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(this.size, offset)), end = Math.min(this.size, start + Math.max(0, length));
    if (start === end) return Promise.resolve(new Uint8Array(0));
    const index = Math.floor(start / CHUNK), within = start - index * CHUNK;
    return this.chunk(index).then((chunk) => chunk.subarray(within, Math.min(chunk.length, within + end - start)));
  }
  private async chunk(index: number): Promise<Uint8Array> {
    const key = this.id + ":" + index, cache = this.store.cache, cached = cache.get(key);
    if (cached) { cache.delete(key); cache.set(key, cached); return cached; }
    const bytes = (await this.store.call("read", this.id, index * CHUNK, CHUNK)) ?? new Uint8Array(0);
    cache.set(key, bytes);
    if (cache.size > CACHE_CHUNKS) cache.delete(cache.keys().next().value!);
    return bytes;
  }
  /** queued in order behind earlier requests; `bytes` is transferred, so callers pass a copy */
  write(offset: number, bytes: Uint8Array): void {
    if (!bytes.length) return;
    this.drop(offset, offset + bytes.length);
    this.size = Math.max(this.size, offset + bytes.length);
    void this.store.call("write", this.id, offset, 0, bytes).catch((error) => console.error("[disk]", this.id, error));
  }
  truncate(size: number): void {
    this.drop(Math.min(size, this.size));
    this.size = size;
    void this.store.call("truncate", this.id, 0, size).catch((error) => console.error("[disk]", this.id, error));
  }
  /** forget cached chunks overlapping [from, to) */
  drop(from: number, to = Infinity): void {
    for (let index = Math.floor(from / CHUNK); index * CHUNK < Math.min(to, this.size); index++) this.store.cache.delete(this.id + ":" + index);
  }
}
