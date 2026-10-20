// The file tree every realm sees: in-memory bytes, lazy sources (apks, assets, disk-backed app
// files) and directories. Java streams, native descriptors and the shell all read and write it.
import { BytesFile, readFully, writable, type FileSource } from "./lazyfile.ts";
import { procIdentity, procList, procText } from "./procfs.ts";
import type { SharedMaps } from "../native/mappings.ts";
import { utf8 } from "../jvm/abi.ts";
import { knownUid } from "../android/packages.ts";
import { packageOfPath } from "./file-path.ts";

/** Where an installed apk lives, spelled once: the base, or one of its config/feature splits.
 *  ApplicationInfo.sourceDir/splitSourceDirs answer with these and ZipFile opens them. */
export const apkPath = (split?: string) => split ? `/data/app/split_${split}.apk` : "/data/app/base.apk";

export type FileAttributes = { uid: number; gid: number; mode: number };
/** an open file: its bytes in `data`, or behind `source` for a lazy or disk-backed file;
 *  `sharedMaps` are MAP_SHARED copies of its pages (Java and native), told of every
 *  write and flushed before a read */
export interface VfsFile { path: string | null; data: Uint8Array; len: number; source?: FileSource; sharedMaps?: SharedMaps; attributes?: FileAttributes; ashmem?: { prot: number } }
export const EMPTY = new Uint8Array(0);
/** room for `size` bytes, doubling so appends stay linear */
function reserve(file: VfsFile, size: number) {
  if (size <= file.data.length) return;
  const grown = new Uint8Array(Math.max(size, file.data.length * 2, 4096));
  grown.set(file.data.subarray(0, file.len));
  file.data = grown;
}
const openFiles = new Map<string, VfsFile>();
const volatileFiles = new Set<string>();
/** stores through native shared mappings of an open file reach its bytes before they are read */
const flushMapped = (path: string) => openFiles.get(path)?.sharedMaps?.flush();
const procBytes = (path: string): Uint8Array | null => {
  const text = procText(path);
  return text === null ? null : utf8.enc.encode(text);
};
/** the space every path's filesystem reports (one backs everything here): the browser's storage estimate */
export async function storageEstimate(): Promise<{ total: number; free: number }> {
  try {
    const e = await navigator.storage?.estimate?.();
    return { total: e?.quota ?? 0, free: Math.max(0, (e?.quota ?? 0) - (e?.usage ?? 0)) };
  } catch { return { total: 0, free: 0 }; /* no estimate available: report an empty filesystem */ }
}
export const vfs = {
  files: new Map<string, Uint8Array>(),
  lazyFiles: new Map<string, FileSource>(),
  dirs: new Set<string>(["/data", "/data/local", "/data/local/tmp", "/sdcard"]),
  /** each path's last modification, epoch ms: when its bytes last changed or it appeared */
  mtimes: new Map<string, number>(),
  metadata: new Map<string, FileAttributes>(),
  mtime(p: string): number { return this.mtimes.get(this.norm(p)) ?? 0; },
  attributes(p: string | null, directory?: boolean): FileAttributes {
    directory ??= p !== null && this.isDir(p);
    const path = p === null ? null : this.norm(p), stored = path === null ? undefined : this.metadata.get(path);
    if (stored) return stored;
    const pkg = path === null ? undefined : packageOfPath(path)?.pkg;
    const uid = path !== null && /^\/(?:system|apex|vendor|product|dev)(?:\/|$)/.test(path) ? 0 : (pkg ? knownUid(pkg) : undefined) ?? procIdentity.uid;
    const attributes = {uid, gid:uid, mode:directory ? 0o755 : 0o644};
    if (path !== null && this.exists(path)) this.metadata.set(path,attributes);
    return attributes;
  },
  setAttributes(p: string, change: Partial<FileAttributes>, notify = true): void {
    const path = this.norm(p);
    if (this.isDir(path)) this.dirs.add(path);
    Object.assign(this.attributes(path,this.isDir(path)),change);
    if (notify) this.onWrite(path,"modify");
  },
  /** the package's app data loaded from its owner */
  prepare: (_pkg: string): Promise<void> => Promise.resolve(),
  flush: (): Promise<void> => Promise.resolve(),
  onWrite: (_path: string, _change: "modify" | "write" | "create" | "delete" = "modify") => {},
  markVolatile(p: string) { volatileFiles.add(this.norm(p)); },
  norm(p: string): string {
    // already normal: absolute, with no empty, "." or ".." segment
    if (p.charCodeAt(0) !== 47 || /\/\.{0,2}(?:\/|$)/.test(p)) {
      const parts: string[] = [];
      for (const seg of p.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
      }
      p = "/" + parts.join("/");
    }
    return p.replace(/^\/storage\/(?:emulated\/0|self\/primary)(?=\/|$)/,"/sdcard");
  },
  canonical(p: string): string { return this.norm(p).replace(/^\/sdcard(?=\/|$)/,"/storage/emulated/0"); },
  read(p: string): Uint8Array | null {
    const path = this.norm(p); flushMapped(path);
    return this.files.get(path) ?? procBytes(path);
  },
  readFile(p: string): Uint8Array | Promise<Uint8Array> | null {
    const path = this.norm(p);
    flushMapped(path);
    const bytes = this.files.get(path);
    if (bytes) return bytes;
    const source = this.lazyFiles.get(path);
    return source ? readFully(source) : procBytes(path);
  },
  source(p: string): FileSource | null {
    const path = this.norm(p);
    flushMapped(path);
    const bytes = this.files.get(path) ?? procBytes(path);
    return bytes ? new BytesFile(bytes) : this.lazyFiles.get(path) ?? null;
  },
  stat(p: string): { size: number; source: FileSource } | null {
    const source = this.source(p);
    return source ? { size: source.size, source } : null;
  },
  open(p: string): VfsFile | null {
    const path = this.norm(p), data = this.files.get(path), source = data ? undefined : this.lazyFiles.get(path);
    if (!data && !source) return null;
    let file = openFiles.get(path);
    if (!file) { file = { path, data: data ?? EMPTY, len: data?.length ?? source!.size, source, attributes:this.attributes(path) }; openFiles.set(path, file); }
    return file;
  },
  /** before reading an open file's bytes directly */
  sync(file: VfsFile) { file.sharedMaps?.flush(); },
  opened(p: string): VfsFile | null { return openFiles.get(this.norm(p)) ?? null; },
  publish(file: VfsFile) {
    if (file.path === null || openFiles.get(file.path) !== file) return;
    this.mtimes.set(file.path, Date.now());
    if (!file.source) this.files.set(file.path, file.data.subarray(0, file.len));
    if (!volatileFiles.has(file.path)) this.onWrite(file.path, "modify");
  },
  /** write into an open file at `off`, zero-filling any gap past its end */
  writeAt(file: VfsFile, off: number, bytes: Uint8Array) {
    const end = off + bytes.length;
    if (writable(file.source)) file.source.write(off, bytes.slice());
    else {
      reserve(file, end);
      if (off > file.len) file.data.fill(0, file.len, off);
      file.data.set(bytes, off);
    }
    file.len = Math.max(file.len, end);
    file.sharedMaps?.wrote(off, bytes);
    this.publish(file);
  },
  resize(file: VfsFile, size: number) {
    if (writable(file.source)) file.source.truncate(size);
    else if (size > file.len) { reserve(file, size); file.data.fill(0, file.len, size); }
    file.len = size;
    this.publish(file);
  },
  /** the file's bytes now live in `source`; descriptors already open on it follow them there */
  adopt(p: string, source: FileSource) {
    const path = this.norm(p), file = openFiles.get(path);
    this.files.delete(path);
    this.lazyFiles.set(path, source);
    this.attributes(path);
    this.mtimes.set(path, Date.now());
    if (file) { file.data = EMPTY; file.len = source.size; file.source = source; }
  },
  write(p: string, data: Uint8Array, notify = true) {
    const path = this.norm(p);
    const existed = this.files.has(path) || this.lazyFiles.has(path);
    const file = openFiles.get(path);
    this.lazyFiles.delete(path); this.files.set(path, data);
    this.attributes(path);
    this.mtimes.set(path, Date.now());
    if (file) { file.len = data.length; file.data = data; file.source = undefined; }
    if (notify && !volatileFiles.has(path)) this.onWrite(path, existed ? "write" : "create");
  },
  mount(p: string, source: FileSource) {
    const path = this.norm(p);
    this.delete(path, false);
    this.lazyFiles.set(path, source);
    this.attributes(path);
    this.mtimes.set(path, Date.now());
  },
  under(p: string): boolean {
    if (this.dirs.has(p)) return true;
    const dir = p.endsWith("/") ? p : p + "/";
    for (const d of this.dirs) if (d.startsWith(dir)) return true;
    for (const m of [this.files, this.lazyFiles]) for (const k of m.keys()) if (k.startsWith(dir)) return true;
    return false;
  },
  exists(p: string): boolean {
    p = this.norm(p);
    return this.files.has(p) || this.lazyFiles.has(p) || this.under(p) || procText(p) !== null || procList(p) !== null;
  },
  isDir(p: string): boolean {
    p = this.norm(p);
    return !this.files.has(p) && !this.lazyFiles.has(p) && this.under(p) || procList(p) !== null;
  },
  delete(p: string, notify = true): boolean {
    const path = this.norm(p);
    const volatile = volatileFiles.delete(path);
    const file = openFiles.get(path);
    if (file) { file.path = null; openFiles.delete(path); }
    const removed = this.files.delete(path) || this.lazyFiles.delete(path);
    this.mtimes.delete(path);
    this.metadata.delete(path);
    if (removed && notify && !volatile) this.onWrite(path, "delete");
    return removed;
  },
  rename(from: string, to: string): boolean {
    from = this.norm(from); to = this.norm(to);
    if (!this.files.has(from) && !this.lazyFiles.has(from)) return false;
    if (from === to) return true;
    this.delete(to, false);
    for (const files of [this.files, this.lazyFiles, this.mtimes, this.metadata]) {
      const value = files.get(from);
      if (value) { files.delete(from); files.set(to, value as never); }
    }
    const file = openFiles.get(from);
    if (file) { openFiles.delete(from); file.path = to; openFiles.set(to, file); }
    this.onWrite(from, "delete"); this.onWrite(to, "create");
    return true;
  },
  /** directory `from` and everything under it, moved to `to` with their times and attributes */
  renameDir(from: string, to: string) {
    from = this.norm(from); to = this.norm(to);
    const prefix = from + "/", dest = (p: string) => to + p.slice(from.length);
    for (const m of [this.files, this.lazyFiles]) for (const k of [...m.keys()]) if (k.startsWith(prefix)) this.rename(k, dest(k));
    this.dirs.add(from);
    for (const d of [...this.dirs]) if (d === from || d.startsWith(prefix)) {
      const moved = dest(d), attributes = this.attributes(d, true), mtime = this.mtimes.get(d);
      this.dirs.delete(d); this.metadata.delete(d); this.mtimes.delete(d);
      this.dirs.add(moved); this.metadata.set(moved, attributes);
      if (mtime !== undefined) this.mtimes.set(moved, mtime);
      this.onWrite(d, "delete"); this.onWrite(moved, "create");
    }
  },
  mkdir(p: string) { const path = this.norm(p); if (!this.dirs.has(path)) { this.dirs.add(path); this.attributes(path,true); this.mtimes.set(path, Date.now()); this.onWrite(path, "create"); } },
  rmdir(p: string): boolean { const path = this.norm(p), removed = this.dirs.delete(path); if (removed) { this.mtimes.delete(path); this.metadata.delete(path); this.onWrite(path, "delete"); } return removed; },
  list(p: string): string[] {
    p = this.norm(p);
    const proc = procList(p);
    if (proc) return proc;
    const dir = p === "/" ? "/" : p + "/";
    const names = new Set<string>();
    for (const m of [this.files, this.lazyFiles]) for (const k of m.keys()) if (k.startsWith(dir)) names.add(k.slice(dir.length).split("/")[0]);
    for (const d of this.dirs) if (d.startsWith(dir)) names.add(d.slice(dir.length).split("/")[0]);
    names.delete("");
    return [...names];
  },
};
