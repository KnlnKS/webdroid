import { E } from "./abi.ts";
import { fdBase, installFile, openFd, javaOpenFd, javaCloseFd, javaReadFd, javaFdBytes,
  O_ACCMODE, O_CLOEXEC, S_IFMT, S_IFDIR, S_IFIFO, S_IFREG, openRemoteFifo, type FdStat, type OpenFile } from "./fs.ts";
import type { FileSource } from "../shell/lazyfile.ts";
import { isMutablePath } from "../shell/file-path.ts";
import { vfs } from "../shell/vfs.ts";
import type { DescriptorCalls, DescriptorReply, DescriptorRequest } from "../shell/file-descriptors.ts";

/** Bound lazily after the process is registered; the page's kernel never installs this. */
export const descriptorTransport: {
  calls?: () => DescriptorCalls;
  importCalls?: () => DescriptorCalls;
  stageLocal?: (fd: number) => number;
  takeLocal?: (token: number) => number;
  unstageLocal?: (token: number) => Promise<number>;
  discardLocal?: (token: number) => Promise<number>;
} = {};
type Operation = DescriptorRequest extends infer R ? R extends {fd:number} ? Omit<R,"fd"> : never : never;

/** An open file another realm owns: its position, flags and bytes live there, so every operation is a request. */
export class RemoteDescriptor {
  token: number;
  calls: () => DescriptorCalls;
  /** the owner's close, requested when this realm's last descriptor for it closed */
  closing: Promise<number> | null = null;
  constructor(token: number, calls: () => DescriptorCalls) { this.token = token; this.calls = calls; }
  request(operation: Operation): Promise<DescriptorReply> {
    return this.calls().fileDescriptor({...operation,fd:this.token} as DescriptorRequest);
  }
  result(operation: Operation): Promise<number> { return this.request(operation).then(reply => reply.result); }
  read(target: Uint8Array, offset?: number): Promise<number> {
    const length = target.length;
    return this.request(offset === undefined ? {kind:"read",length} : {kind:"pread",length,offset}).then(reply => {
      if (reply.result > 0) {
        if (!reply.bytes || reply.bytes.length !== reply.result || reply.result > length) throw new Error("Invalid descriptor read reply");
        target.set(reply.bytes);
      }
      return reply.result;
    });
  }
  write(bytes: Uint8Array, offset?: number): Promise<number> {
    return this.result(offset === undefined ? {kind:"write",bytes:bytes.slice()} : {kind:"pwrite",bytes:bytes.slice(),offset});
  }
  seek(offset: number, whence: number): Promise<number> { return this.result({kind:"seek",offset,whence}); }
  truncate(length: number): Promise<number> { return this.result({kind:"truncate",length}); }
  allocate(offset: number, length: number): Promise<number> { return this.result({kind:"allocate",offset,length}); }
  sync(): Promise<number> { return this.result({kind:"sync"}); }
  fcntl(command: number, arg: number): Promise<number> { return this.result({kind:"fcntl",command,arg}); }
  stat(): Promise<FdStat | null> { return this.request({kind:"stat"}).then(reply => reply.result < 0 ? null : reply.stat ?? null); }
  /** a regular file as a source of its size now, read through its owner */
  source(): Promise<FileSource | null> {
    return this.stat().then(stat => stat && (stat.mode & S_IFMT) === S_IFREG ? { size: stat.size, read: (offset, length) => {
      const target = new Uint8Array(length);
      return this.read(target, offset).then(n => { if (n < 0) throw new Error("Bad file descriptor"); return target.subarray(0, n); });
    } } : null);
  }
}
export const isRemoteFd = (fd: number): boolean => !!openFd(fd)?.remote;

function installRemote(token: number, calls: () => DescriptorCalls, path: string, flags: number, dir = false, cloexec = !!(flags & O_CLOEXEC)): number {
  const remote = new RemoteDescriptor(token,calls);
  const file: OpenFile = {...fdBase(path),write:!!(flags & O_ACCMODE),statusFlags:flags,remote,dir};
  file.onLastClose = () => {
    remote.closing = remote.result({kind:"close"});
    void remote.closing.catch(() => {});
  };
  return installFile(file,cloexec);
}
export function stageBinderFd(fd: number): number | Promise<number> | null {
  const remote = openFd(fd)?.remote;
  return remote ? remote.result({kind:"stage"}) : descriptorTransport.stageLocal?.(fd) ?? null;
}
export function unstageBinderFd(token: number): Promise<number> {
  const calls = descriptorTransport.calls ?? descriptorTransport.importCalls;
  return descriptorTransport.unstageLocal?.(token) ?? (calls ? calls().fileDescriptor({kind:"unstage",fd:token}).then(reply=>reply.result) : Promise.resolve(-E.BADF));
}
export function discardBinderFd(token: number): Promise<number> {
  const calls = descriptorTransport.importCalls ?? descriptorTransport.calls;
  return descriptorTransport.discardLocal?.(token) ?? (calls ? calls().fileDescriptor({kind:"close",fd:token}).then(reply=>reply.result) : Promise.resolve(-E.BADF));
}
export async function takeBinderFd(token: number): Promise<number> {
  if (descriptorTransport.takeLocal) return descriptorTransport.takeLocal(token);
  const calls = descriptorTransport.importCalls ?? descriptorTransport.calls;
  if (!calls) return -E.BADF;
  const stat = await calls().fileDescriptor({kind:"stat",fd:token});
  if (stat.result < 0 || !stat.stat) return stat.result < 0 ? stat.result : -E.BADF;
  const flags = await calls().fileDescriptor({kind:"fcntl",fd:token,command:3,arg:0});
  if (flags.result < 0) { await calls().fileDescriptor({kind:"close",fd:token}); return flags.result; }
  const taken = await calls().fileDescriptor({kind:"take",fd:token});
  if (taken.result < 0) return taken.result;
  return installRemote(token,calls,stat.stat.path ?? "",flags.result,(stat.stat.mode & 0xf000) === 0x4000,true);
}

export function processOpenFd(path: string, flags: number): number | Promise<number> {
  const normalized = vfs.norm(path), calls = isMutablePath(normalized) ? descriptorTransport.calls : undefined;
  if (!calls) return javaOpenFd(normalized,flags);
  return calls().fileDescriptor({kind:"open",path:normalized,flags}).then(reply => {
    if (reply.result < 0) return reply.result;
    if (reply.type === S_IFIFO) return openRemoteFifo(normalized,flags);
    return installRemote(reply.result,calls,normalized,flags,reply.type === S_IFDIR);
  });
}

/** a file's bytes, from the realm that owns its path */
export async function processFileBytes(path: string): Promise<Uint8Array | null> {
  if (!isMutablePath(path) || !descriptorTransport.calls) return vfs.readFile(path);
  const fd = await processOpenFd(path, 0);
  if (fd < 0) return null;
  try { return await javaFdBytes(fd); } finally { await javaCloseFd(fd); }
}
/** hostnatives' name for javaReadFd, which reads every kind of open file */
export const processReadFd = javaReadFd;

/** A live owner lease; a mapping outlives the descriptor that acquired it. */
export type ProcessMapping = { size: number; immutable: boolean; read(offset: number, length: number): Promise<Uint8Array>; write(offset: number, bytes: Uint8Array): Promise<void>; force(): Promise<void>; close(): Promise<void> };
export async function processMapping(fd: number, offset: number, length: number, prot: number): Promise<ProcessMapping | number> {
  const remote = openFd(fd)?.remote, calls = remote?.calls ?? descriptorTransport.importCalls;
  if (!calls) return -E.NOTSUP;
  const token = remote?.token ?? descriptorTransport.stageLocal?.(fd);
  if (token === undefined) return -E.NOTSUP;
  let reply: DescriptorReply;
  try { reply = await calls().fileDescriptor({kind:"mappingAcquire",fd:token,offset,length,prot}); }
  finally { if (!remote) await unstageBinderFd(token); }
  if (reply.result < 0) return reply.result;
  const lease = reply.result;
  return {
    size:length,
    immutable:!!reply.mapping?.immutable,
    async read(offset,length) {
      const reply = await calls().fileDescriptor({kind:"mappingRead",fd:lease,offset,length});
      if (reply.result < 0) throw new Error(`shared mapping read: ${-reply.result}`);
      if (reply.result !== length || reply.bytes?.length !== length) throw new Error("short shared mapping read");
      return reply.bytes;
    },
    async write(offset,bytes) {
      const reply = await calls().fileDescriptor({kind:"mappingWrite",fd:lease,offset,bytes:bytes.slice()});
      if (reply.result !== bytes.length) throw new Error(`shared mapping write: ${reply.result}`);
    },
    async force() {
      const reply = await calls().fileDescriptor({kind:"mappingSync",fd:lease});
      if (reply.result < 0) throw new Error(`shared mapping sync: ${-reply.result}`);
    },
    async close() {
      const reply = await calls().fileDescriptor({kind:"mappingRelease",fd:lease});
      if (reply.result < 0 && reply.result !== -E.BADF) throw new Error(`shared mapping release: ${-reply.result}`);
    },
  };
}
export function processAshmemCreate(size: number): Promise<number> | null {
  const calls = descriptorTransport.calls;
  return calls ? calls().fileDescriptor({kind:"ashmemCreate",size}).then(reply => reply.result < 0 ? reply.result : installRemote(reply.result,calls,"",2,false,true)) : null;
}
export function processAshmemProtect(fd: number, prot: number): Promise<number> | null {
  const remote = openFd(fd)?.remote;
  return remote ? remote.result({kind:"ashmemProtect",prot}) : null;
}
export function processAshmemSize(fd: number): Promise<number> | null {
  const remote = openFd(fd)?.remote;
  return remote ? remote.request({kind:"stat"}).then(reply => reply.result < 0 || reply.ashmemProt === undefined ? -1 : reply.stat!.size) : null;
}
