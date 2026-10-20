import type { vfs, FileAttributes } from "./vfs.ts";
import { packageOfPath } from "./file-path.ts";
import { openDb, txDone } from "./idb.ts";
import { DiskFile, DiskStore } from "./diskstore.ts";

type FileValue = ({ kind: "file"; bytes: Uint8Array } | { kind: "disk"; id: string; size: number } | { kind: "directory" }) & { mtime?: number; attributes?: FileAttributes };
type DiskValue = Extract<FileValue, { kind: "disk" }>;
/** where packageOfPath's private directories are: each package's are stored apart from shared storage */
const roots = ["/data/data/", "/data/user/0/", "/data/user_de/0/", "/sdcard/Android/data/", "/sdcard/Android/obb/"];
const appPath = (path: string) => { const owner = packageOfPath(path); return owner?.private ? owner : undefined; };
const FLUSH_SETTLE_MS = 100, FLUSH_MAX_MS = 2000;
const sharedPath = (path: string) => path.startsWith("/sdcard/") && !appPath(path);
/** a persisted file grown through an open descriptor past this moves to disk; whole-file writers
 *  (SQLite, preferences) keep their bytes in memory and read them back synchronously */
const SPILL_BYTES = 4 << 20;
const isOwnerId = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
/** a stored record as the value it persisted, or null for a shape no version wrote; one written
 *  before attributes were kept takes the VFS's default owner */
function decodeRecord(value: unknown): FileValue | null {
  if (!value || typeof value !== "object" || !("kind" in value)) return null;
  const mtime = "mtime" in value && typeof value.mtime === "number" ? value.mtime : undefined;
  const a = "attributes" in value ? value.attributes : null;
  let attributes: FileAttributes | undefined;
  if (a && typeof a === "object" && "uid" in a && "gid" in a && "mode" in a && isOwnerId(a.uid) && isOwnerId(a.gid) &&
    typeof a.mode === "number" && Number.isInteger(a.mode) && a.mode >= 0 && a.mode <= 0o7777)
    attributes = {uid:a.uid,gid:a.gid,mode:a.mode};
  if (value.kind === "directory") return { kind: "directory", mtime, attributes };
  if (value.kind === "disk" && "id" in value && typeof value.id === "string" && "size" in value && typeof value.size === "number") return { kind: "disk", id: value.id, size: value.size, mtime, attributes };
  if (value.kind === "file" && "bytes" in value && value.bytes instanceof Uint8Array) return { kind: "file", bytes: value.bytes, mtime, attributes };
  return null;
}
export class PrivateFiles {
  private values = new Map<string, FileValue>();
  /** the vfs of the process whose writes persist: system_server's, until it dies */
  private bound: { pid: number; view: typeof vfs } | null = null;
  private loaded = new Map<string, Promise<void>>();
  private pending = new Map<string, FileValue | null>();
  private database: Promise<IDBDatabase> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pendingSince = 0;
  private lastWrite = 0;
  private readonly disk = new DiskStore();
  /** disk files whose path changed, removed at the next flush unless another path took them */
  private orphans = new Set<string>();

  attach(pid: number, view: typeof vfs): void {
    const bound = this.bound = { pid, view };
    for (const [path, value] of this.values) this.install(view, path, value);
    view.prepare = (pkg) => this.prepare(pkg);
    view.flush = () => this.flush();
    view.onWrite = (path, change) => {
      // a process that has died writes nothing more
      if (this.bound !== bound) return;
      const app = appPath(path);
      if (!app && !sharedPath(path)) return;
      const cache = !!app && /^(?:cache|code_cache)(?:\/|$)/.test(app.within);
      const value = this.valueOf(view, path, change === "modify" && !cache);
      this.update(path, value);
      if (cache) return;
      this.pending.set(path, value);
      this.schedule();
    };
  }
  detach(pid: number): void { if (this.bound?.pid === pid) this.bound = null; }
  /** what `view` holds at `path`; a file grown through a descriptor past SPILL_BYTES moves to disk */
  private valueOf(view: typeof vfs, path: string, streamed: boolean): FileValue | null {
    const backing = view.lazyFiles.get(path), bytes = view.files.get(path), mtime = view.mtimes.get(path);
    const attributes = {...view.attributes(path,view.dirs.has(path))};
    if (bytes && streamed && bytes.length >= SPILL_BYTES) {
      const disk = this.disk.create();
      disk.write(0, bytes.slice());
      return { kind: "disk", id: disk.id, size: disk.size, mtime,attributes };
    }
    if (bytes) return { kind: "file", bytes, mtime,attributes };
    if (backing instanceof DiskFile) return { kind: "disk", id: backing.id, size: backing.size, mtime,attributes };
    return view.dirs.has(path) ? { kind: "directory", mtime,attributes } : null;
  }
  /** A burst of writes (a download's chunks) settles into one transaction, and a steady stream
   *  still persists every FLUSH_MAX_MS: each flush stores whole files, so per-write flushing is
   *  quadratic in a growing file's size. */
  private schedule(): void {
    this.lastWrite = Date.now();
    if (this.timer === null) { this.pendingSince = this.lastWrite; this.arm(FLUSH_SETTLE_MS); }
  }
  /** the timer is re-armed when it fires rather than on every write */
  private arm(delay: number): void {
    this.timer = setTimeout(() => {
      const wait = Math.min(this.lastWrite + FLUSH_SETTLE_MS, this.pendingSince + FLUSH_MAX_MS) - Date.now();
      if (wait > 0) return this.arm(wait);
      this.timer = null;
      void this.flush().catch((error) => console.error("[private files]", error));
    }, delay);
  }
  private install(view: typeof vfs, path: string, value: FileValue | null): void {
    // the writing view already holds these bytes; reinstalling would trim its open file's
    // spare capacity, so every append would copy the whole file
    if (value?.kind === "file" && view.files.get(path) === value.bytes) {
      if (value.attributes) view.setAttributes(path,value.attributes,false);
      return;
    }
    view.dirs.delete(path);
    if (value?.kind === "file") view.write(path, value.bytes, false);
    else if (value?.kind === "disk") view.adopt(path, this.disk.file(value.id, value.size));
    else { view.delete(path, false); if (value) view.dirs.add(path); }
    if (value?.mtime !== undefined) view.mtimes.set(path, value.mtime);
    if (value?.attributes) view.setAttributes(path,value.attributes,false);
  }
  private update(path: string, value: FileValue | null): void {
    const previous = this.values.get(path);
    if (previous?.kind === "disk" && (value?.kind !== "disk" || value.id !== previous.id)) this.orphans.add(previous.id);
    if (value) this.values.set(path, value); else this.values.delete(path);
    if (this.bound) this.install(this.bound.view, path, value);
  }
  private db(): Promise<IDBDatabase> {
    return this.database ??= openDb("webdroid-private-files", "files");
  }
  private load(key: string, prefixes: string[], include: (path: string) => boolean): Promise<void> {
    let loaded = this.loaded.get(key);
    if (!loaded) {
      loaded = this.db().then(async (db) => {
        const transaction = db.transaction("files"), store = transaction.objectStore("files"), disks: [string, DiskValue][] = [];
        for (const prefix of prefixes) {
          const request = store.openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            const path = cursor.key;
            if (typeof path === "string" && include(path) && !this.values.has(path) && !this.pending.has(path)) {
              const value = decodeRecord(cursor.value);
              if (value?.kind === "disk") disks.push([path, value]);
              else if (value) this.update(path, value);
            }
            cursor.continue();
          };
        }
        await txDone(transaction);
        // a file whose bytes the origin's storage lost is absent, as after a restore without it
        await Promise.all(disks.map(async ([path, value]) => {
          const held = await this.disk.holds(value.id, value.size);
          if (this.values.has(path) || this.pending.has(path)) return;
          if (held) return this.update(path, value);
          this.orphans.add(value.id);
          this.pending.set(path, null);
          this.schedule();
        }));
      });
      this.loaded.set(key, loaded);
    }
    return loaded;
  }
  async prepare(pkg: string): Promise<void> {
    await Promise.all([
      this.load("@shared", ["/sdcard/"], sharedPath),
      this.load(pkg, roots.map((root) => root + pkg + "/"), () => true),
    ]);
  }
  /** installd's clearAppData: the package's data directories and its Android/data and Android/media
   *  ones; its OBBs go only when it is uninstalled */
  async clear(pkg: string): Promise<void> {
    await this.prepare(pkg);
    const dirs = [...roots.filter((root) => !root.endsWith("/obb/")), "/sdcard/Android/media/"].map((root) => root + pkg);
    for (const path of new Set([...dirs, ...this.values.keys()])) {
      if (!dirs.some((dir) => path === dir || path.startsWith(dir + "/"))) continue;
      this.update(path, null);
      this.pending.set(path, null);
    }
    await this.flush();
  }
  flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (!this.pending.size) return this.writes;
    const pending = this.pending; this.pending = new Map();
    const live = new Set([...this.values.values()].flatMap((value) => value.kind === "disk" ? [value.id] : []));
    const orphans = [...this.orphans].filter((id) => !live.has(id));
    this.orphans.clear();
    const write = this.writes.then(async () => {
      // a record names a disk file's size only once its bytes are on disk: a page closed in
      // between keeps the previous record rather than one over a partly written file
      await this.disk.flush();
      const transaction = (await this.db()).transaction("files", "readwrite"), store = transaction.objectStore("files");
      // a view into a larger growing buffer would otherwise clone the whole buffer
      for (const [path, value] of pending) {
        if (!value) store.delete(path);
        else store.put(value.kind === "file" && value.bytes.byteLength !== value.bytes.buffer.byteLength ? { ...value, bytes: value.bytes.slice() } : value, path);
      }
      await txDone(transaction);
      await Promise.all(orphans.map((id) => this.disk.remove(id)));
    });
    this.writes = write.catch(() => {
      for (const path of pending.keys()) if (!this.pending.has(path)) this.pending.set(path, this.values.get(path) ?? null);
    });
    return write;
  }
  async clearAll(): Promise<void> {
    await Promise.all(this.loaded.values());
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.pending.clear();
    for (const path of this.values.keys()) this.update(path, null);
    this.loaded.clear();
    const clear = this.writes.then(async () => {
      const transaction = (await this.db()).transaction("files", "readwrite");
      transaction.objectStore("files").clear();
      await Promise.all([txDone(transaction), this.disk.clear()]);
      this.orphans.clear();
    });
    this.writes = clear.catch(() => {});
    await clear;
  }
}
