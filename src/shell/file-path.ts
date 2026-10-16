import { E } from "../native/abi";
import { vfs, type FileAttributes } from "./vfs";
import { procIdentity } from "./procfs";
import { mkdirPath, accessPath, renamePath, removePath, createPath, makeFifo } from "../native/fs";
import { isFifo } from "../native/pipe";
export type PathStat = { directory: boolean; fifo: boolean; size: number; mtime: number; uid: number; gid: number; mode: number };
export type PathReply<T> = { errno: number; value: T };
export type FilePathCalls = {
  filePrepare(pkg: string): Promise<void>;
  fileStat(path: string): Promise<PathReply<PathStat | null>>;
  fileMkdir(path: string): Promise<number>;
  fileAccess(path: string, mode: number): Promise<number>;
  fileList(path: string): Promise<PathReply<string[] | null>>;
  fileRename(from: string, to: string): Promise<number>;
  fileRemove(path: string, directory?: boolean): Promise<number>;
  fileCreate(path: string): Promise<number>;
  fileFifo(path: string): Promise<number>;
  fileSetAttributes(path: string, change: Partial<FileAttributes>): Promise<number>;
}
/** Only mutable app/shared paths cross; platform archives and procfs stay in their owning realm. */
export const isMutablePath = (path: string): boolean => /^\/(?:data\/(?:data|user\/0|user_de\/0)(?:\/|$)|sdcard(?:\/|$))/.test(vfs.norm(path));
export const filePathTransport: { calls?: () => FilePathCalls } = {};
export const remoteFilePath = (path: string): FilePathCalls | undefined => isMutablePath(path) ? filePathTransport.calls?.() : undefined;
/** stat of normalized `p` in this realm's VFS */
export function pathStat(p: string): PathReply<PathStat | null> {
  const directory = vfs.isDir(p), stat = directory ? null : vfs.stat(p);
  return {errno: directory || stat ? 0 : E.NOENT, value: directory || stat ? {directory, fifo: !directory && isFifo(p), size: directory ? 0 : stat!.size, mtime: vfs.mtime(p),...vfs.attributes(p,directory)} : null};
}
export function changeFileAttributes(path: string, change: Partial<FileAttributes>, uid = procIdentity.uid): number {
  for (const value of [change.uid,change.gid]) if (value !== undefined && (!Number.isInteger(value) || value < -1 || value > 0xffffffff)) return -E.INVAL;
  if (change.mode !== undefined && !Number.isInteger(change.mode)) return -E.INVAL;
  const p = vfs.norm(path);
  if (!vfs.exists(p)) return -E.NOENT;
  const current = vfs.attributes(p,vfs.isDir(p)), app = uid % 100000 - 10000;
  if (uid !== 0 && (current.uid !== uid || change.uid !== undefined && change.uid !== -1 && change.uid !== uid ||
    change.gid !== undefined && change.gid !== -1 && change.gid !== current.gid && change.gid !== uid &&
    !(app >= 0 && (change.gid === uid - uid % 100000 + 20000 + app || change.gid === 50000 + app)))) return -E.PERM;
  vfs.setAttributes(p,{...(change.uid !== undefined && change.uid !== -1 ? {uid:change.uid} : {}),
    ...(change.gid !== undefined && change.gid !== -1 ? {gid:change.gid} : {}),...(change.mode !== undefined ? {mode:change.mode & 0o7777} : {})});
  return 0;
}
export function canonicalFilePaths(authorize: (path: string, write: boolean) => number, uid?: number) {
  const created = (path: string, result: number): number => {
    if (result === 0 && uid !== undefined) vfs.setAttributes(path,{uid,gid:uid});
    return result;
  };
  return {
    fileSetAttributes(path: string, change: Partial<FileAttributes>): number {
      const p = vfs.norm(path), denied = authorize(p,true);
      return denied ? -denied : changeFileAttributes(p,change,uid);
    },
    fileStat(path: string): PathReply<PathStat | null> {
      const p = vfs.norm(path), denied = authorize(p, false);
      if (denied) return {errno: denied, value: null};
      return pathStat(p);
    },
    fileMkdir(path: string): number { const p = vfs.norm(path), denied = isMutablePath(p) ? authorize(p, true) : E.ACCES; return denied ? -denied : created(p,mkdirPath(null, p)); },
    fileRename(from: string, to: string): number {
      const a = vfs.norm(from), b = vfs.norm(to);
      if (!isMutablePath(a) || !isMutablePath(b)) return -18; // EXDEV: another owning filesystem.
      const denied = authorize(a,true) || authorize(b,true);
      return denied ? -denied : renamePath(null,a,b);
    },
    fileRemove(path: string, directory?: boolean): number { const p=vfs.norm(path), denied=isMutablePath(p) ? authorize(p,true) : E.ACCES; return denied ? -denied : removePath(null,p,directory); },
    fileCreate(path: string): number { const p=vfs.norm(path), denied=isMutablePath(p) ? authorize(p,true) : E.ACCES; return denied ? -denied : created(p,createPath(null,p)); },
    fileFifo(path: string): number { const p=vfs.norm(path), denied=isMutablePath(p) ? authorize(p,true) : E.ACCES; return denied ? -denied : created(p,makeFifo(null,p)); },
    fileAccess(path: string, mode: number): number { const p = vfs.norm(path), denied = authorize(p, !!(mode & 2)); return denied ? -denied : accessPath(null, p, mode); },
    fileList(path: string): PathReply<string[] | null> {
      const p = vfs.norm(path), denied = authorize(p, false);
      if (denied) return {errno: denied, value: null};
      return vfs.isDir(p) ? {errno:0, value:vfs.list(p)} : {errno:vfs.exists(p) ? 20 : E.NOENT, value:null};
    },
  };
}
