import { E } from "../native/abi";
import { vfs } from "./vfs";
import { mkdirPath, accessPath } from "../native/fs";
export type PathStat = { directory: boolean; size: number; mtime: number };
export type PathReply<T> = { errno: number; value: T };
export type FilePathCalls = {
  filePrepare(pkg: string): Promise<void>;
  fileStat(path: string): Promise<PathReply<PathStat | null>>;
  fileMkdir(path: string): Promise<number>;
  fileAccess(path: string, mode: number): Promise<number>;
  fileList(path: string): Promise<PathReply<string[] | null>>;
}
/** Only mutable app/shared paths cross; platform archives and procfs stay in their owning realm. */
export const isMutablePath = (path: string): boolean => /^\/(?:data\/(?:data|user\/0|user_de\/0)(?:\/|$)|sdcard(?:\/|$))/.test(vfs.norm(path));
export const filePathTransport: { calls?: () => FilePathCalls } = {};
export const remoteFilePath = (path: string): FilePathCalls | undefined => isMutablePath(path) ? filePathTransport.calls?.() : undefined;
export function canonicalFilePaths(authorize: (path: string, write: boolean) => number) {
  return {
    fileStat(path: string): PathReply<PathStat | null> {
      const p = vfs.norm(path), denied = authorize(p, false);
      if (denied) return {errno: denied, value: null};
      const directory = vfs.isDir(p), stat = directory ? null : vfs.stat(p);
      return {errno: directory || stat ? 0 : E.NOENT, value: directory || stat ? {directory, size: directory ? 0 : stat!.size, mtime: vfs.mtime(p)} : null};
    },
    fileMkdir(path: string): number { const p = vfs.norm(path), denied = authorize(p, true); return denied ? -denied : mkdirPath(null, p); },
    fileAccess(path: string, mode: number): number { const p = vfs.norm(path), denied = authorize(p, !!(mode & 2)); return denied ? -denied : accessPath(null, p, mode); },
    fileList(path: string): PathReply<string[] | null> {
      const p = vfs.norm(path), denied = authorize(p, false);
      if (denied) return {errno: denied, value: null};
      return vfs.isDir(p) ? {errno:0, value:vfs.list(p)} : {errno:vfs.exists(p) ? 20 : E.NOENT, value:null};
    },
  };
}
