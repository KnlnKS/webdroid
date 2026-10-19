import { E } from "../native/abi.ts";
import { vfs, type FileAttributes } from "./vfs.ts";
import { procIdentity } from "./procfs.ts";
import { mkdirPath, accessPath, renamePath, removePath, createPath, makeFifo, pathStat, type FileStat } from "../native/fs.ts";
import { moveRemoteFifo } from "../native/pipe.ts";
export type PathReply<T> = { errno: number; value: T };
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
export const filePathTransport: { calls?: () => FilePathCalls } = {};
/** whether `path` lives in the page, which this realm is not: a process Worker's mutable path */
const ownersPath = (path: string): boolean => !!filePathTransport.calls && isMutablePath(path);
/** chmod, chown and utimes of `path` as process `uid` may make them: an owner changes its file's mode and times, and
 *  gives it to a group it is in (its own, or the cache and shared application gids ProcessList gives every app process) */
export function changeFileAttributes(path: string, change: AttributeChange, uid = procIdentity.uid): number {
  for (const value of [change.uid,change.gid]) if (value !== undefined && (!Number.isInteger(value) || value < -1 || value > 0xffffffff)) return -E.INVAL;
  if (change.mode !== undefined && !Number.isInteger(change.mode) || change.mtime !== undefined && !Number.isFinite(change.mtime)) return -E.INVAL;
  const p = vfs.norm(path);
  if (!vfs.exists(p)) return -E.NOENT;
  const current = vfs.attributes(p,vfs.isDir(p)), app = uid % 100000 - 10000;
  if (uid !== 0 && (current.uid !== uid || change.uid !== undefined && change.uid !== -1 && change.uid !== uid ||
    change.gid !== undefined && change.gid !== -1 && change.gid !== current.gid && change.gid !== uid &&
    !(app >= 0 && (change.gid === uid - uid % 100000 + 20000 + app || change.gid === 50000 + app)))) return -E.PERM;
  vfs.setAttributes(p,{...(change.uid !== undefined && change.uid !== -1 ? {uid:change.uid} : {}),
    ...(change.gid !== undefined && change.gid !== -1 ? {gid:change.gid} : {}),...(change.mode !== undefined ? {mode:change.mode & 0o7777} : {})});
  if (change.mtime !== undefined) vfs.mtimes.set(p, Math.floor(change.mtime));
  return 0;
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
const owner = () => filePathTransport.calls!();
/** the owning realm's path operations; this process's pipes for its fifos follow their names (pipe.ts) */
const ownerFilePaths: FilePaths = {
  fileStat: path => owner().fileStat(path),
  fileMkdir: path => owner().fileMkdir(path),
  fileAccess: (path, mode) => owner().fileAccess(path, mode),
  fileList: path => owner().fileList(path),
  fileRename: (from, to) => owner().fileRename(from, to).then(r => { if (!r) moveRemoteFifo(vfs.norm(from), vfs.norm(to)); return r; }),
  fileRemove: (path, directory) => owner().fileRemove(path, directory).then(r => { if (!r) moveRemoteFifo(vfs.norm(path), null); return r; }),
  fileCreate: path => owner().fileCreate(path),
  fileFifo: path => owner().fileFifo(path),
  fileSetAttributes: (path, change) => owner().fileSetAttributes(path, change),
};
/** the path operations where `path` (with `other`, a rename's target) lives: in a process Worker a mutable path is
 *  the page's, which answers for every process; any other path is this realm's */
export const filePaths = (path: string, other?: string): FilePaths =>
  ownersPath(path) || other !== undefined && ownersPath(other) ? ownerFilePaths : localFilePaths;
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
