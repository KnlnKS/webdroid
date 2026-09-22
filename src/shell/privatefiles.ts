import type { vfs } from "../jvm/natives/jio";
import { openDb, txDone } from "./idb";

type FileValue = { kind: "file"; bytes: Uint8Array } | { kind: "directory" };
const privatePath = /^\/data\/(?:data|user\/0|user_de\/0)\/[^/]+(?:\/|$)/;
const disposablePath = /^\/data\/(?:data|user\/0|user_de\/0)\/[^/]+\/(?:cache|code_cache)(?:\/|$)/;
export class PrivateFiles {
  private values = new Map<string, FileValue>();
  private views = new Map<number, typeof vfs>();
  private loaded = new Map<string, Promise<void>>();
  private pending = new Map<string, FileValue | null>();
  private database: Promise<IDBDatabase> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;

  attach(pid: number, view: typeof vfs): void {
    if (this.views.get(pid) === view) return;
    this.views.set(pid, view);
    for (const [path, value] of this.values) this.install(view, path, value);
    view.prepare = (pkg) => this.prepare(pkg);
    view.flush = () => this.flush();
    view.onWrite = (path) => {
      if (!privatePath.test(path)) return;
      const bytes = view.files.get(path);
      const value: FileValue | null = bytes ? { kind: "file", bytes } : view.dirs.has(path) ? { kind: "directory" } : null;
      this.update(path, value);
      if (disposablePath.test(path)) return;
      this.pending.set(path, value);
      this.timer ??= setTimeout(() => { this.timer = null; void this.flush().catch((error) => console.error("[private files]", error)); }, 0);
    };
  }
  detach(pid: number): void { this.views.delete(pid); }
  private install(view: typeof vfs, path: string, value: FileValue | null): void {
    view.dirs.delete(path);
    if (value?.kind === "file") view.write(path, value.bytes, false);
    else { view.delete(path, false); if (value) view.dirs.add(path); }
  }
  private update(path: string, value: FileValue | null): void {
    if (value) this.values.set(path, value); else this.values.delete(path);
    for (const view of this.views.values()) this.install(view, path, value);
  }
  private db(): Promise<IDBDatabase> {
    return this.database ??= openDb("webdroid-private-files", "files");
  }
  prepare(pkg: string): Promise<void> {
    let loaded = this.loaded.get(pkg);
    if (!loaded) {
      loaded = this.db().then((db) => {
        const transaction = db.transaction("files"), store = transaction.objectStore("files");
        for (const root of ["/data/data/", "/data/user/0/", "/data/user_de/0/"]) {
          const prefix = root + pkg + "/", request = store.openCursor(IDBKeyRange.bound(prefix, prefix + "\uffff"));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            const path = cursor.key, value: unknown = cursor.value;
            if (typeof path === "string" && !this.values.has(path) && !this.pending.has(path) && value && typeof value === "object" && "kind" in value) {
              if (value.kind === "directory") this.update(path, { kind: "directory" });
              else if (value.kind === "file" && "bytes" in value && value.bytes instanceof Uint8Array) this.update(path, { kind: "file", bytes: value.bytes });
            }
            cursor.continue();
          };
        }
        return txDone(transaction);
      });
      this.loaded.set(pkg, loaded);
    }
    return loaded;
  }
  flush(): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (!this.pending.size) return this.writes;
    const pending = this.pending; this.pending = new Map();
    const write = this.writes.then(async () => {
      const transaction = (await this.db()).transaction("files", "readwrite"), store = transaction.objectStore("files");
      for (const [path, value] of pending) { if (value) store.put(value, path); else store.delete(path); }
      await txDone(transaction);
    });
    this.writes = write.catch(() => {
      for (const path of pending.keys()) if (!this.pending.has(path)) this.pending.set(path, this.values.get(path) ?? null);
    });
    return write;
  }
  async clear(): Promise<void> {
    await Promise.all(this.loaded.values());
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    this.pending.clear();
    for (const path of this.values.keys()) this.update(path, null);
    this.loaded.clear();
    const clear = this.writes.then(async () => {
      const transaction = (await this.db()).transaction("files", "readwrite");
      transaction.objectStore("files").clear();
      await txDone(transaction);
    });
    this.writes = clear.catch(() => {});
    await clear;
  }
}
