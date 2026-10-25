// The file tree every realm sees: in-memory bytes, lazy sources (apks, assets, disk-backed app
// files) and directories. Java streams, native descriptors and the shell all read and write it.
import { BytesFile, readFully, writable, type FileSource } from "./lazyfile.ts";
import { procIdentity, procList, procText } from "./procfs.ts";
import type { SharedMaps } from "../native/mappings.ts";
import { utf8 } from "../jvm/abi.ts";
import { knownUid } from "../android/packages.ts";
import { packageOfPath, type AttributeChange } from "./file-path.ts";

/** Where an installed apk lives, spelled once: the base, or one of its config/feature splits.
 *  ApplicationInfo.sourceDir/splitSourceDirs answer with these and ZipFile opens them. */
export const apkPath = (split?: string) => split ? `/data/app/split_${split}.apk` : "/data/app/base.apk";

export type FileAttributes = { uid: number; gid: number; mode: number };
/** an open file: its bytes in `data`, or behind `source` for a lazy or disk-backed file;
 *  `sharedMaps` are MAP_SHARED copies of its pages (Java and native), told of every
 *  write and flushed before a read */
export interface VfsFile { path: string | null; data: Uint8Array; len: number; source?: FileSource; sharedMaps?: SharedMaps; attributes?: FileAttributes; ashmem?: { prot: number } }
/** one path of the tree: a file's bytes or lazy source, or (content null) a directory. A directory
 *  without a node is implicit: it has entries under it. */
interface VfsNode {
  content: Uint8Array | FileSource | null;
  /** the last modification, epoch ms: when its bytes last changed or it appeared */
  mtime: number;
  /** the creator's default owner until a change sets them */
  attributes?: FileAttributes;
  /** a fifo's or a descriptor backing's name: none of its changes persist */
  volatile?: boolean;
  /** the one open file of its name, which every descriptor on it shares */
  open?: VfsFile;
}
type VfsChange = "modify" | "write" | "create" | "delete";
/** what persists the tree's changes: it loads a package's data before the package runs, and flushes on fsync */
type FileOwner = { prepare(pkg: string): Promise<void>; flush(): Promise<void> };
export const EMPTY = new Uint8Array(0);
export const contentSize = (content: Uint8Array | FileSource): number => content instanceof Uint8Array ? content.length : content.size;
/** room for `size` bytes, doubling so appends stay linear */
function reserve(file: VfsFile, size: number) {
  if (size <= file.data.length) return;
  const grown = new Uint8Array(Math.max(size, file.data.length * 2, 4096));
  grown.set(file.data.subarray(0, file.len));
  file.data = grown;
}
const nodes = new Map<string, VfsNode>(["/data", "/data/local", "/data/local/tmp", "/sdcard"].map(path => [path, { content: null, mtime: 0 }]));
let watchers: readonly ((path: string, change: VfsChange) => void)[] = [];
const notify = (path: string, change: VfsChange) => { for (const watcher of watchers) watcher(path, change); };
const UNOWNED: FileOwner = { prepare: () => Promise.resolve(), flush: () => Promise.resolve() };
let owner = UNOWNED;
/** stores through native shared mappings of an open file reach its bytes before they are read */
const flushMapped = (node: VfsNode | undefined) => node?.open?.sharedMaps?.flush();
const procBytes = (path: string): Uint8Array | null => {
  const text = procText(path);
  return text === null ? null : utf8.enc.encode(text);
};
function defaultAttributes(path: string | null, directory: boolean): FileAttributes {
  const pkg = path === null ? undefined : packageOfPath(path)?.pkg;
  const uid = path !== null && /^\/(?:system|apex|vendor|product|dev)(?:\/|$)/.test(path) ? 0 : (pkg ? knownUid(pkg) : undefined) ?? procIdentity.uid;
  return { uid, gid: uid, mode: directory ? 0o755 : 0o644 };
}
const created = (path: string, content: Uint8Array | FileSource | null): VfsNode =>
  ({ content, mtime: Date.now(), attributes: defaultAttributes(path, content === null) });
/** `node`'s content is now `content`; its open file follows it there */
function fill(node: VfsNode, content: Uint8Array | FileSource): void {
  node.content = content; node.mtime = Date.now();
  const file = node.open;
  if (!file) return;
  if (content instanceof Uint8Array) { file.data = content; file.len = content.length; file.source = undefined; }
  else { file.data = EMPTY; file.len = content.size; file.source = content; }
}
/** descriptors open on `node` keep a file without a name */
function detach(node: VfsNode): void {
  if (node.open) { node.open.path = null; node.open = undefined; }
}
function drop(path: string, node: VfsNode): void { nodes.delete(path); detach(node); }
/** `node` named `to` now, in place of anything there */
function move(from: string, to: string, node: VfsNode): void {
  const there = nodes.get(to);
  if (there) drop(to, there);
  nodes.delete(from); nodes.set(to, node);
  if (node.open) node.open.path = to;
  if (!node.volatile) { notify(from, "delete"); notify(to, "create"); }
}
function under(p: string): boolean {
  const dir = p.endsWith("/") ? p : p + "/";
  for (const path of nodes.keys()) if (path.startsWith(dir)) return true;
  return false;
}
function publish(file: VfsFile) {
  const node = file.path === null ? undefined : nodes.get(file.path);
  if (!node || node.open !== file) return;
  node.mtime = Date.now();
  if (!file.source) node.content = file.data.subarray(0, file.len);
  if (!node.volatile) notify(file.path!, "modify");
}
/** the space every path's filesystem reports (one backs everything here): the browser's storage estimate */
export async function storageEstimate(): Promise<{ total: number; free: number }> {
  try {
    const e = await navigator.storage?.estimate?.();
    return { total: e?.quota ?? 0, free: Math.max(0, (e?.quota ?? 0) - (e?.usage ?? 0)) };
  } catch { return { total: 0, free: 0 }; /* no estimate available: report an empty filesystem */ }
}
export const vfs = {
  node(p: string): Readonly<VfsNode> | undefined { return nodes.get(this.norm(p)); },
  /** each node at or under `prefix`, a directory's path with its trailing slash */
  *entries(prefix = "/"): Generator<[string, Readonly<VfsNode>]> {
    for (const entry of nodes) if (entry[0].startsWith(prefix)) yield entry;
  },
  mtime(p: string): number { return nodes.get(this.norm(p))?.mtime ?? 0; },
  attributes(p: string | null, directory?: boolean): FileAttributes {
    const path = p === null ? null : this.norm(p), node = path === null ? undefined : nodes.get(path);
    return node?.attributes ?? defaultAttributes(path, directory ?? (node ? node.content === null : path !== null && this.isDir(path)));
  },
  /** a change of `p`'s owner, mode or time; an implicit directory becomes a node that keeps them */
  setAttributes(p: string, { mtime, ...change }: AttributeChange, notifies = true): void {
    const path = this.norm(p);
    let node = nodes.get(path);
    if (!node) {
      if (!under(path)) return;
      nodes.set(path, node = { content: null, mtime: 0 });
    }
    if (node.attributes) Object.assign(node.attributes, change);
    else node.attributes = { ...defaultAttributes(path, node.content === null), ...change };
    if (mtime !== undefined) node.mtime = Math.floor(mtime);
    if (notifies && !node.volatile) notify(path, "modify");
  },
  /** `watch` hears each change from now on, until the returned function stops it */
  watch(watch: (path: string, change: VfsChange) => void): () => void {
    watchers = [...watchers, watch];
    return () => { watchers = watchers.filter(w => w !== watch); };
  },
  /** `next` persists this realm's files until the returned function hands them back */
  useOwner(next: Partial<FileOwner>): () => void {
    const previous = owner, used = owner = { ...UNOWNED, ...next };
    return () => { if (owner === used) owner = previous; };
  },
  /** the package's app data loaded from its owner */
  prepare(pkg: string): Promise<void> { return owner.prepare(pkg); },
  flush(): Promise<void> { return owner.flush(); },
  /** the existing file `p` is volatile: none of its changes persist */
  markVolatile(p: string) { const node = nodes.get(this.norm(p)); if (node) node.volatile = true; },
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
    const path = this.norm(p), node = nodes.get(path);
    flushMapped(node);
    return node?.content instanceof Uint8Array ? node.content : procBytes(path);
  },
  readFile(p: string): Uint8Array | Promise<Uint8Array> | null {
    const path = this.norm(p), node = nodes.get(path), content = node?.content;
    flushMapped(node);
    return content instanceof Uint8Array ? content : content ? readFully(content) : procBytes(path);
  },
  source(p: string): FileSource | null {
    const path = this.norm(p), node = nodes.get(path), content = node?.content;
    flushMapped(node);
    if (content) return content instanceof Uint8Array ? new BytesFile(content) : content;
    const bytes = procBytes(path);
    return bytes ? new BytesFile(bytes) : null;
  },
  stat(p: string): { size: number; source: FileSource } | null {
    const source = this.source(p);
    return source ? { size: source.size, source } : null;
  },
  open(p: string): VfsFile | null {
    const path = this.norm(p), node = nodes.get(path), content = node?.content;
    if (!node || !content) return null;
    const bytes = content instanceof Uint8Array;
    return node.open ??= { path, data: bytes ? content : EMPTY, len: contentSize(content), source: bytes ? undefined : content, attributes: node.attributes };
  },
  /** before reading an open file's bytes directly */
  sync(file: VfsFile) { file.sharedMaps?.flush(); },
  opened(p: string): VfsFile | null { return nodes.get(this.norm(p))?.open ?? null; },
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
    publish(file);
  },
  resize(file: VfsFile, size: number) {
    if (writable(file.source)) file.source.truncate(size);
    else if (size > file.len) { reserve(file, size); file.data.fill(0, file.len, size); }
    file.len = size;
    publish(file);
  },
  /** the file's bytes now live in `source`; descriptors already open on it follow them there */
  adopt(p: string, source: FileSource) {
    const path = this.norm(p), node = nodes.get(path);
    if (node) fill(node, source); else nodes.set(path, created(path, source));
  },
  write(p: string, data: Uint8Array, notifies = true) {
    const path = this.norm(p), node = nodes.get(path), existed = !!node?.content;
    if (node) fill(node, data); else nodes.set(path, created(path, data));
    if (notifies && !node?.volatile) notify(path, existed ? "write" : "create");
  },
  /** a new file at `p` over `source`, unheard; descriptors open on what was there keep it */
  mount(p: string, source: FileSource) {
    const path = this.norm(p), node = nodes.get(path);
    if (node) drop(path, node);
    nodes.set(path, created(path, source));
  },
  /** `content` at `p`: bytes written, a source mounted */
  place(p: string, content: Uint8Array | FileSource) {
    if (content instanceof Uint8Array) this.write(p, content); else this.mount(p, content);
  },
  /** `p` as the owner of its persisted state has it, unheard: content null is a directory, and no entry removes it.
   *  A file's open descriptors follow new content; content it holds already stays, as refilling its open file
   *  would trim the spare capacity that keeps appends linear. */
  restore(p: string, entry: { content: Uint8Array | FileSource | null; mtime?: number; attributes?: FileAttributes } | null) {
    const path = this.norm(p);
    let node = nodes.get(path);
    if (!entry) { if (node) drop(path, node); return; }
    const { content, mtime, attributes } = entry;
    if (!node) nodes.set(path, node = created(path, content));
    else if (node.content !== content) {
      if (content) fill(node, content);
      else { detach(node); node.content = null; }
    }
    if (attributes) { if (node.attributes) Object.assign(node.attributes, attributes); else node.attributes = { ...attributes }; }
    if (mtime !== undefined) node.mtime = mtime;
  },
  exists(p: string): boolean {
    p = this.norm(p);
    return nodes.has(p) || under(p) || procText(p) !== null || procList(p) !== null;
  },
  isDir(p: string): boolean {
    p = this.norm(p);
    const node = nodes.get(p);
    return (node ? node.content === null : under(p)) || procList(p) !== null;
  },
  delete(p: string, notifies = true): boolean {
    const path = this.norm(p), node = nodes.get(path);
    if (!node?.content) return false;
    drop(path, node);
    if (notifies && !node.volatile) notify(path, "delete");
    return true;
  },
  rename(from: string, to: string): boolean {
    from = this.norm(from); to = this.norm(to);
    const node = nodes.get(from);
    if (!node?.content) return false;
    if (from !== to) {
      // what a volatile file replaces is gone once the page reloads
      if (node.volatile) this.delete(to);
      move(from, to, node);
    }
    return true;
  },
  /** directory `from` and everything under it, moved to `to` with their times and attributes */
  renameDir(from: string, to: string) {
    from = this.norm(from); to = this.norm(to);
    const prefix = from + "/";
    if (!nodes.has(from)) nodes.set(from, { content: null, mtime: 0, attributes: defaultAttributes(from, true) });
    for (const [path, node] of [...nodes]) if (path === from || path.startsWith(prefix)) move(path, to + path.slice(from.length), node);
  },
  mkdir(p: string, notifies = true) {
    const path = this.norm(p);
    if (nodes.has(path)) return;
    nodes.set(path, created(path, null));
    if (notifies) notify(path, "create");
  },
  rmdir(p: string, notifies = true): boolean {
    const path = this.norm(p), node = nodes.get(path);
    if (!node || node.content !== null) return false;
    nodes.delete(path);
    if (notifies) notify(path, "delete");
    return true;
  },
  list(p: string): string[] {
    p = this.norm(p);
    const proc = procList(p);
    if (proc) return proc;
    const dir = p === "/" ? "/" : p + "/";
    const names = new Set<string>();
    for (const path of nodes.keys()) if (path.startsWith(dir)) names.add(path.slice(dir.length).split("/")[0]);
    names.delete("");
    return [...names];
  },
};
