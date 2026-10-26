import { E, S_IFCHR, S_IFDIR, S_IFIFO, S_IFREG } from "../native/abi.ts";
import { vfs, type FileAttributes, type VfsFile } from "./vfs.ts";
import { procIdentity, procText } from "./procfs.ts";
import type { FdStat, FileStat } from "../native/fd.ts";
import { isFifo, moveRemoteFifo, nameFifo } from "../native/pipe.ts";
import { utf8 } from "../jvm/abi.ts";
import type { DescriptorCalls } from "./file-descriptors.ts";
import { broker, remoteSystem } from "./broker-access.ts";
type PathReply<T> = { errno: number; value: T };
/** a change to a file's owner, group (-1 keeps either), permission bits or modification time (epoch ms) */
export type AttributeChange = Partial<FileAttributes> & { mtime?: number };
export type FilePathCalls = {
  filePrepare(pkg: string): Promise<void>;
  fileStat(path: string): Promise<PathReply<FileStat | null>>;
  fileMkdir(path: string): Promise<number>;
  fileAccess(path: string, mode: number): Promise<number>;
  fileList(path: string): Promise<PathReply<string[] | null>>;
  fileRename(from: string, to: string): Promise<number>;
  fileRemove(path: string, directory?: boolean): Promise<number>;
  fileCreate(path: string): Promise<number>;
  fileFifo(path: string): Promise<number>;
  fileSetAttributes(path: string, change: AttributeChange): Promise<number>;
}
type Operations = Omit<FilePathCalls, "filePrepare">;
type Answering<T, Sync extends boolean> = { [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R> ? (...args: A) => Sync extends true ? R : R | Promise<R> : never };
/** the path operations, each answering -errno or 0 (fileStat and fileList an errno beside the value) */
export type FilePaths = Answering<Operations, false>;
/** The package a path belongs to, as Android 11+ scopes them: its internal data directories and its
 *  external Android/data and Android/obb directories are private to it (FuseDaemon's
 *  is_app_accessible_path), while Android/media/<pkg> is attributed to it but shared. `within` is
 *  the rest of the path under the package's directory. */
export function packageOfPath(path: string): { pkg: string; private: boolean; within: string } | undefined {
  const m = /^\/(?:data\/(?:data|user\/0|user_de\/0)|sdcard\/Android\/(data|obb|media))\/([^/]+)(?:\/(.*))?$/.exec(path);
  return m ? { pkg: m[2], private: m[1] !== "media", within: m[3] ?? "" } : undefined;
}
/** root and system_server act on every package's files, an app on its own */
export const sameUidOrSystem = (caller: number, owner: number | undefined): boolean => caller === 0 || caller === 1000 || caller === owner;
/** Only mutable app/shared paths cross; platform archives and procfs stay in their owning realm. */
export const isMutablePath = (path: string): boolean => /^\/(?:data\/(?:data|user\/0|user_de\/0)(?:\/|$)|sdcard(?:\/|$))/.test(vfs.norm(path));
/** the realm that owns the page's mutable files, as a process Worker reaches it through the broker: its path
 *  operations and the kernel of their descriptors */
export type PathOwner = { files: FilePaths; descriptors: DescriptorCalls };
/** the realm that owns `path`, or every mutable file when none is given, when this realm does not: in a process
 *  Worker a mutable path is the page's */
export const pathOwner = (path?: string): PathOwner | null => remoteSystem() && (path === undefined || isMutablePath(path)) ? broker() : null;
/** chmod, chown and utimes of `path` as process `uid` may make them: an owner changes its file's mode and times, and
 *  gives it to a group it is in (its own, or the cache and shared application gids ProcessList gives every app process) */
function changeFileAttributes(path: string, change: AttributeChange, uid = procIdentity.uid): number {
  for (const value of [change.uid,change.gid]) if (value !== undefined && (!Number.isInteger(value) || value < -1 || value > 0xffffffff)) return -E.INVAL;
  if (change.mode !== undefined && !Number.isInteger(change.mode) || change.mtime !== undefined && !Number.isFinite(change.mtime)) return -E.INVAL;
  const p = vfs.norm(path);
  if (!vfs.exists(p)) return -E.NOENT;
  const current = vfs.attributes(p,vfs.isDir(p)), app = uid % 100000 - 10000;
  if (uid !== 0 && (current.uid !== uid || change.uid !== undefined && change.uid !== -1 && change.uid !== uid ||
    change.gid !== undefined && change.gid !== -1 && change.gid !== current.gid && change.gid !== uid &&
    !(app >= 0 && (change.gid === uid - uid % 100000 + 20000 + app || change.gid === 50000 + app)))) return -E.PERM;
  vfs.setAttributes(p,{...(change.uid !== undefined && change.uid !== -1 ? {uid:change.uid} : {}),
    ...(change.gid !== undefined && change.gid !== -1 ? {gid:change.gid} : {}),...(change.mode !== undefined ? {mode:change.mode & 0o7777} : {}),
    ...(change.mtime !== undefined ? {mtime:change.mtime} : {})});
  return 0;
}
/** fstat(2) of an open file named `path` (null: it has no name now), of st_mode `mode` and `size` bytes */
export const openFileStat = (path: string | null, mode: number, size: number, { uid, gid } = vfs.attributes(path)): FdStat =>
  ({ mode, size, path, uid, gid, mtime: path ? vfs.mtime(path) : 0 });
/** fchmod, fchown and futimens of an open file named `path`: a file without a name keeps no attributes */
export const changeOpenFile = (path: string | null, change: AttributeChange, uid?: number): number =>
  path === null ? -E.NOTSUP : changeFileAttributes(path, change, uid);
// The path operations on this realm's own files, each answering -errno or 0
const pathType = (p: string): number => vfs.isDir(p) ? S_IFDIR : isFifo(p) ? S_IFIFO : S_IFREG;
/** the stat of a file this realm holds, of `size` bytes unless it is a directory */
function localStat(path: string, type: number, size: number, mtime: number, file: VfsFile | null = vfs.opened(path)): FileStat {
  const { mode, uid, gid } = file?.attributes ?? vfs.attributes(path, type === S_IFDIR);
  return { mode: type | mode, size: type === S_IFDIR ? 4096 : size, mtime, uid, gid };
}
/** the character devices every process can open */
const CHAR_DEVICES = ["/dev/null", "/dev/urandom", "/dev/random"] as const;
export type CharDevice = typeof CHAR_DEVICES[number];
export const isCharDevice = (path: string): path is CharDevice => (CHAR_DEVICES as readonly string[]).includes(path);
/** the ashmem driver's node, root's, whose device an ashmem region's fstat reports */
export const ASHMEM_DEVICE = "/dev/ashmem";
/** stat(2) of normalized `p`: a directory, a file (procfs included) or a device */
function pathStat(p: string): PathReply<FileStat | null> {
  if (p === ASHMEM_DEVICE) return { errno: 0, value: { mode: S_IFCHR | 0o666, size: 0, mtime: 0, uid: 0, gid: 0 } };
  if (isCharDevice(p)) return { errno: 0, value: localStat(p, S_IFCHR, 0, Date.now()) };
  const s = procText(p);
  if (s !== null) return { errno: 0, value: localStat(p, S_IFREG, utf8.enc.encode(s).length, Date.now()) };
  const directory = vfs.isDir(p), file = directory ? null : vfs.stat(p);
  return directory || file ? { errno: 0, value: localStat(p, pathType(p), file?.size ?? 0, vfs.mtime(p), null) } : { errno: E.NOENT, value: null };
}
function accessPath(path: string, mode: number): number {
  if (mode & ~7) return -E.INVAL;
  const p = vfs.norm(path);
  return vfs.exists(p) || vfs.isDir(p) || procText(p) !== null || isCharDevice(p) || p === ASHMEM_DEVICE ? 0 : -E.NOENT;
}
/** rename(2) over the vfs: a file keeps its lazy source, a directory carries its entries along */
export function renamePath(fromPath: string, toPath: string): number {
  const from = vfs.norm(fromPath), to = vfs.norm(toPath), parent = to.slice(0, to.lastIndexOf("/")) || "/";
  if (from === to) return vfs.exists(from) ? 0 : -E.NOENT;
  if (!vfs.isDir(parent)) return -(vfs.exists(parent) ? E.NOTDIR : E.NOENT);
  if (vfs.isDir(from)) {
    if (to.startsWith(from + "/")) return -E.INVAL;
    if (vfs.exists(to)) {
      if (!vfs.isDir(to)) return -E.NOTDIR;
      if (vfs.list(to).length) return -E.NOTEMPTY;
      vfs.rmdir(to);
    }
    vfs.renameDir(from, to);
    return 0;
  }
  const source = vfs.source(from);
  if (!source) return -E.NOENT;
  if (vfs.isDir(to)) return -E.ISDIR;
  vfs.rename(from, to);
  return 0;
}
/** a name for a new entry at normalized `p`: EEXIST if taken, ENOENT without its parent directory */
function newName(p: string): number {
  if (vfs.exists(p) || vfs.isDir(p)) return -E.EXIST;
  const parent = p.slice(0, p.lastIndexOf("/")) || "/";
  return parent !== "/" && !vfs.isDir(parent) ? -E.NOENT : 0;
}
function mkdirPath(path: string): number {
  const p = vfs.norm(path), taken = newName(p);
  if (taken) return taken;
  vfs.mkdir(p); return 0;
}
/** open(O_CREAT|O_EXCL) and close: an empty file where nothing was */
function createPath(path: string): number {
  const p = vfs.norm(path), taken = newName(p);
  if (taken) return taken;
  vfs.write(p, new Uint8Array(0)); return 0;
}
export function makeFifo(path: string): number {
  const p = vfs.norm(path), taken = newName(p);
  if (!taken) nameFifo(p);
  return taken;
}
/** unlink(2) with `directory` false, rmdir(2) with true, and remove(3) when it is omitted */
function removePath(path: string, directory?: boolean): number {
  const p = vfs.norm(path);
  if (!vfs.isDir(p)) return directory ? -(vfs.exists(p) ? E.NOTDIR : E.NOENT) : vfs.delete(p) ? 0 : -E.NOENT;
  if (directory === false) return -E.ISDIR;
  if (vfs.list(p).length) return -E.NOTEMPTY;
  vfs.rmdir(p); return 0;
}
/** this realm's path operations on its own files */
const localFilePaths: Answering<Operations, true> = {
  fileStat: path => pathStat(vfs.norm(path)),
  fileMkdir: mkdirPath,
  fileAccess: accessPath,
  fileList(path) {
    const p = vfs.norm(path);
    return vfs.isDir(p) ? {errno:0, value:vfs.list(p)} : {errno:vfs.exists(p) ? E.NOTDIR : E.NOENT, value:null};
  },
  fileRename: renamePath,
  fileRemove: removePath,
  fileCreate: createPath,
  fileFifo: makeFifo,
  fileSetAttributes: (path, change) => changeFileAttributes(path, change),
};
const owned = () => broker().files;
/** the owning realm's path operations; this process's pipes for its fifos follow their names (pipe.ts) */
const ownerFilePaths: FilePaths = {
  fileStat: path => owned().fileStat(path),
  fileMkdir: path => owned().fileMkdir(path),
  fileAccess: (path, mode) => owned().fileAccess(path, mode),
  fileList: path => owned().fileList(path),
  fileRename: (from, to) => Promise.resolve(owned().fileRename(from, to)).then(r => { if (!r) moveRemoteFifo(vfs.norm(from), vfs.norm(to)); return r; }),
  fileRemove: (path, directory) => Promise.resolve(owned().fileRemove(path, directory)).then(r => { if (!r) moveRemoteFifo(vfs.norm(path), null); return r; }),
  fileCreate: path => owned().fileCreate(path),
  fileFifo: path => owned().fileFifo(path),
  fileSetAttributes: (path, change) => owned().fileSetAttributes(path, change),
};
/** the path operations where `path` (with `other`, a rename's target) lives: the owner's, for every process, or
 *  this realm's */
export const filePaths = (path: string, other?: string): FilePaths =>
  pathOwner(path) || other !== undefined && pathOwner(other) ? ownerFilePaths : localFilePaths;
/** the page's path operations for process `uid`: what `authorize` allows of this realm's, a mutable path's changes
 *  only, and new entries its creator's */
export function canonicalFilePaths(authorize: (path: string, write: boolean) => number, uid?: number): Answering<Operations, true> {
  const local = localFilePaths;
  const changing = (p: string): number => isMutablePath(p) ? authorize(p, true) : E.ACCES;
  const creating = (path: string, create: (p: string) => number): number => {
    const p = vfs.norm(path), denied = changing(p), result = denied ? -denied : create(p);
    if (result === 0 && uid !== undefined) vfs.setAttributes(p,{uid,gid:uid});
    return result;
  };
  return {
    fileStat(path) { const p = vfs.norm(path), denied = authorize(p, false); return denied ? {errno: denied, value: null} : local.fileStat(p); },
    fileList(path) { const p = vfs.norm(path), denied = authorize(p, false); return denied ? {errno: denied, value: null} : local.fileList(p); },
    fileAccess(path, mode) { const p = vfs.norm(path), denied = authorize(p, !!(mode & 2)); return denied ? -denied : local.fileAccess(p, mode); },
    fileMkdir: path => creating(path, local.fileMkdir),
    fileCreate: path => creating(path, local.fileCreate),
    fileFifo: path => creating(path, local.fileFifo),
    fileRemove(path, directory) { const p = vfs.norm(path), denied = changing(p); return denied ? -denied : local.fileRemove(p, directory); },
    fileRename(from, to) {
      const a = vfs.norm(from), b = vfs.norm(to);
      if (!isMutablePath(a) || !isMutablePath(b)) return -18; // EXDEV: another owning filesystem.
      const denied = authorize(a,true) || authorize(b,true);
      return denied ? -denied : local.fileRename(a,b);
    },
    fileSetAttributes(path, change) { const p = vfs.norm(path), denied = authorize(p,true); return denied ? -denied : changeFileAttributes(p,change,uid); },
  };
}
