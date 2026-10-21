// The disk Worker of diskstore.ts: it holds the origin private file system's synchronous access handles, which
// exist only in workers, and runs requests in arrival order, so a read queued after a write sees it.
import { serveCalls } from "./rpc.ts";
import { gone, type DiskCalls } from "./diskstore.ts";

/** a file's synchronous access handle, which lib.dom does not type as only a worker opens one */
type SyncHandle = { read(into: Uint8Array, at: { at: number }): number; write(bytes: Uint8Array, at: { at: number }): number;
  truncate(size: number): void; flush(): void; close(): void };
const MAX_OPEN = 128;
const handles = new Map<string, Promise<SyncHandle>>();
const root = () => navigator.storage.getDirectory();
// resolved for each open rather than kept, so a directory removed under this worker is made again
const dir = async () => (await root()).getDirectoryHandle("webdroid-disk", { create: true });
const close = (handle: Promise<SyncHandle>) => handle.then((h) => h.close(), () => {});
/** a read opens only a file that exists: one the origin's storage lost is an error, not an empty file */
function open(id: string, create: boolean): Promise<SyncHandle> {
  const held = handles.get(id);
  if (held) { handles.delete(id); handles.set(id, held); return held; }
  const opened = dir().then((d) => d.getFileHandle(id, { create }))
    .then((f) => (f as FileSystemFileHandle & { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle());
  opened.catch(() => { if (handles.get(id) === opened) handles.delete(id); });
  handles.set(id, opened);
  if (handles.size > MAX_OPEN) { const [old, oldest] = handles.entries().next().value!; handles.delete(old); void close(oldest); }
  return opened;
}
let queue: Promise<unknown> = Promise.resolve();
/** `f`, run once every request that arrived before it has */
const queued = <A extends unknown[], R>(f: (...args: A) => R | Promise<R>) => (...args: A): Promise<R> => {
  const run = queue.then(() => f(...args));
  queue = run.catch(() => {});
  return run;
};
const disk: DiskCalls = {
  read: queued(async (id, at, size) => { const out = new Uint8Array(size); return out.subarray(0, (await open(id, false)).read(out, { at })); }),
  write: queued(async (id, at, bytes) => { (await open(id, true)).write(bytes, { at }); }),
  truncate: queued(async (id, size) => { (await open(id, true)).truncate(size); }),
  remove: queued(async (id) => {
    const h = handles.get(id);
    handles.delete(id);
    if (h) await close(h);
    await (await dir()).removeEntry(id).catch(gone);
  }),
  clear: queued(async () => {
    for (const h of handles.values()) await close(h);
    handles.clear();
    await (await root()).removeEntry("webdroid-disk", { recursive: true }).catch(gone);
  }),
  flush: queued(async () => { for (const h of handles.values()) await h.then((x) => x.flush(), () => {}); }),
  // a file another page holds open is kept; one the origin's storage lost or cut short is not
  holds: queued(async (id, size) => {
    try { return (await open(id, false)).read(new Uint8Array(1), { at: size - 1 }) === 1; }
    catch (e) { return !(e instanceof DOMException && e.name === "NotFoundError"); }
  }),
};
self.onmessage = ({ data }: MessageEvent<MessagePort>) => { serveCalls(data, disk, () => {}, {}, { read: (bytes) => [bytes.buffer] }); };
