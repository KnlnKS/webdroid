// Files too large to keep in memory, stored in the origin private file system. Synchronous access
// handles exist only in workers, so one worker owns them and serves requests in arrival order: a
// read queued after a write sees it, which lets writes return before the worker has run them.

import type { WritableSource } from "./lazyfile.ts";

const WORKER = `
const handles = new Map(), MAX_OPEN = 128;
// resolved for each open rather than kept, so a directory removed under this worker is made again
const dir = async () => (await navigator.storage.getDirectory()).getDirectoryHandle("webdroid-disk", {create: true});
/** a read opens only a file that exists: one the origin's storage lost is an error, not an empty file */
function open(id, create) {
  let h = handles.get(id);
  if (h) { handles.delete(id); handles.set(id, h); return h; }
  h = dir().then((d) => d.getFileHandle(id, {create})).then((f) => f.createSyncAccessHandle());
  h.catch(() => { if (handles.get(id) === h) handles.delete(id); });
  handles.set(id, h);
  if (handles.size > MAX_OPEN) { const [old, oldest] = handles.entries().next().value; handles.delete(old); oldest.then(x => x.close(), () => {}); }
  return h;
}
let queue = Promise.resolve();
onmessage = ({data: {seq, op, id, at, size, bytes}}) => { queue = queue.then(async () => {
  try {
    if (op === "remove") {
      const h = handles.get(id); handles.delete(id);
      if (h) await h.then(x => x.close(), () => {});
      await (await dir()).removeEntry(id).catch(() => {});
      return postMessage({seq});
    }
    if (op === "clear") {
      for (const h of handles.values()) await h.then(x => x.close(), () => {});
      handles.clear();
      await (await navigator.storage.getDirectory()).removeEntry("webdroid-disk", {recursive: true}).catch(() => {});
      return postMessage({seq});
    }
    if (op === "flush") { for (const h of handles.values()) await h.then(x => x.flush(), () => {}); return postMessage({seq}); }
    if (op === "holds") {
      // a file another page holds open is kept; one the origin's storage lost or cut short is not
      try { return postMessage({seq, value: (await open(id, false)).read(new Uint8Array(1), {at: size - 1}) === 1}); }
      catch (e) { return postMessage({seq, value: e.name !== "NotFoundError"}); }
    }
    const h = await open(id, op !== "read");
    if (op === "read") { const out = new Uint8Array(size); const n = h.read(out, {at}); return postMessage({seq, value: out.subarray(0, n)}, [out.buffer]); }
    if (op === "write") h.write(bytes, {at});
    else if (op === "truncate") h.truncate(size);
    postMessage({seq});
  } catch (e) { postMessage({seq, error: String(e)}); }
}); };`;

const CHUNK = 1 << 20, CACHE_CHUNKS = 64;
/** what each of the worker's operations answers */
type Results = { read: Uint8Array; holds: boolean; write: void; truncate: void; remove: void; clear: void; flush: void };

export class DiskStore {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  private readonly files = new Map<string, DiskFile>();
  /** recently read chunks of every file, least recently used first */
  readonly cache = new Map<string, Uint8Array>();

  call<Op extends keyof Results>(op: Op, id: string, at = 0, size = 0, bytes?: Uint8Array): Promise<Results[Op]> {
    const worker = this.worker ??= this.start();
    const seq = ++this.seq;
    return new Promise<Results[Op]>((resolve, reject) => {
      this.pending.set(seq, { resolve, reject });
      worker.postMessage({ seq, op, id, at, size, bytes }, bytes ? [bytes.buffer] : []);
    });
  }
  private start(): Worker {
    // best-effort storage may be evicted under disk pressure, which would lose downloaded data
    void navigator.storage.persist().catch(() => {});
    const worker = new Worker(URL.createObjectURL(new Blob([WORKER], { type: "text/javascript" })));
    worker.onmessage = ({ data }: MessageEvent<{ seq: number; value?: unknown; error?: string }>) => {
      const request = this.pending.get(data.seq);
      this.pending.delete(data.seq);
      // the answer of the operation this sequence number asked for
      if (data.error) request?.reject(new Error(data.error)); else request?.resolve(data.value as never);
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
  /** whether file `id` still holds `size` bytes */
  holds(id: string, size: number): Promise<boolean> {
    return size ? this.call("holds", id, 0, size) : Promise.resolve(true);
  }
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
    const bytes = await this.store.call("read", this.id, index * CHUNK, CHUNK);
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
