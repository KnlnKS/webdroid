import { E } from "./abi";
import { fdBase, installFile, openFd, javaOpenFd, javaCloseFd, javaReadFd, javaPreadFd, javaWriteFd, javaFdBytes,
  javaPwriteFd, javaSeekFd, javaTruncateFd, javaAllocateFd, javaSyncFd, javaFcntlFd, javaFdStat, javaIoctlIntFd, O_ACCMODE, O_CLOEXEC, S_IFDIR, S_IFIFO, openRemoteFifo, type OpenFile } from "./fs";
import { isMutablePath } from "../shell/file-path";
import { vfs } from "../shell/vfs";
import type { DescriptorCalls, DescriptorReply, DescriptorRequest } from "../shell/file-descriptors";

export type RemoteDescriptor = { token: number; calls: () => DescriptorCalls; close: Promise<number> | null };
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
const request = (remote: RemoteDescriptor, operation: Operation) => remote.calls().fileDescriptor({...operation,fd:remote.token} as DescriptorRequest);
const result = (remote: RemoteDescriptor, operation: Operation) => request(remote,operation).then(reply => reply.result);
export const isRemoteFd = (fd: number): boolean => !!openFd(fd)?.remote;

function installRemote(token: number, calls: () => DescriptorCalls, path: string, flags: number, dir = false, cloexec = !!(flags & O_CLOEXEC)): number {
  const remote: RemoteDescriptor = {token,calls,close:null};
  const file: OpenFile = {...fdBase(path),write:!!(flags & O_ACCMODE),statusFlags:flags,remote,dir};
  file.onLastClose = () => {
    remote.close = result(remote,{kind:"close"});
    void remote.close.catch(() => {});
  };
  return installFile(file,cloexec);
}
export function stageBinderFd(fd: number): number | Promise<number> | null {
  const remote = openFd(fd)?.remote;
  return remote ? result(remote,{kind:"stage"}) : descriptorTransport.stageLocal?.(fd) ?? null;
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
  try { return await processFdBytes(fd); } finally { await processCloseFd(fd); }
}
export function processCloseFd(fd: number): number | Promise<number> {
  const remote = openFd(fd)?.remote, closed = javaCloseFd(fd);
  return remote?.close ?? closed;
}
export function processReadFd(fd: number, target: Uint8Array): number | Promise<number> {
  const remote = openFd(fd)?.remote;
  if (!remote) return javaReadFd(fd,target);
  return request(remote,{kind:"read",length:target.length}).then(reply => land(reply,target));
}
export function processPreadFd(fd: number, target: Uint8Array, offset: number): number | Promise<number> {
  const remote = openFd(fd)?.remote;
  if (!remote) return javaPreadFd(fd,target,offset);
  return request(remote,{kind:"pread",length:target.length,offset}).then(reply => land(reply,target));
}
function land(reply: DescriptorReply, target: Uint8Array): number {
  if (reply.result > 0) {
    if (!reply.bytes || reply.bytes.length !== reply.result || reply.result > target.length) throw new Error("Invalid descriptor read reply");
    target.set(reply.bytes);
  }
  return reply.result;
}
export function processWriteFd(fd: number, bytes: Uint8Array): number | Promise<number> {
  const remote = openFd(fd)?.remote;
  return remote ? result(remote,{kind:"write",bytes:bytes.slice()}) : javaWriteFd(fd,bytes);
}
export function processPwriteFd(fd: number, bytes: Uint8Array, offset: number): number | Promise<number> {
  const remote = openFd(fd)?.remote;
  return remote ? result(remote,{kind:"pwrite",bytes:bytes.slice(),offset}) : javaPwriteFd(fd,bytes,offset);
}
export function processSeekFd(fd: number, offset: number, whence: number): number | Promise<number> {
  const remote = openFd(fd)?.remote;
  return remote ? result(remote,{kind:"seek",offset,whence}) : javaSeekFd(fd,offset,whence);
}
export function processTruncateFd(fd: number, length: number): number | Promise<number> {
  const remote = openFd(fd)?.remote;
  return remote ? result(remote,{kind:"truncate",length}) : javaTruncateFd(fd,length);
}
export function processAllocateFd(fd: number, offset: number, length: number): number | Promise<number> {
  const remote = openFd(fd)?.remote;
  return remote ? result(remote,{kind:"allocate",offset,length}) : javaAllocateFd(fd,offset,length);
}
export function processSyncFd(fd: number): number | Promise<number> {
  const remote = openFd(fd)?.remote;
  return remote ? result(remote,{kind:"sync"}) : javaSyncFd(fd);
}
export function processFcntlFd(fd: number, command: number, arg: number): number | Promise<number> {
  const remote = openFd(fd)?.remote;
  // Descriptor flags/duplication belong to this process's table. File flags belong
  // to the canonical open file and can be changed by a different descriptor owner.
  return remote && (command === 3 || command === 4) ? result(remote,{kind:"fcntl",command,arg}) : javaFcntlFd(fd,command,arg);
}
export function processFdStat(fd: number): ReturnType<typeof javaFdStat> | Promise<ReturnType<typeof javaFdStat>> {
  const remote = openFd(fd)?.remote;
  return remote ? request(remote,{kind:"stat"}).then(reply => reply.result < 0 ? null : reply.stat ?? null) : javaFdStat(fd);
}
const remoteRest = (fd: number) => Promise.all([processFdStat(fd),processSeekFd(fd,0,1)])
  .then(([stat,position]) => !stat || position < 0 ? null : {position,length:Math.max(0,stat.size-position)});
/** the bytes from `fd`'s position to its end, which stays where it was */
export async function processFdBytes(fd: number): Promise<Uint8Array | null> {
  if (!isRemoteFd(fd)) return javaFdBytes(fd);
  const rest = await remoteRest(fd);
  if (!rest) return null;
  const bytes = new Uint8Array(rest.length), n = await processPreadFd(fd,bytes,rest.position);
  return n < 0 ? null : bytes.subarray(0,n);
}
export function processIoctlIntFd(fd: number, command: number): number | Promise<number> {
  if (!isRemoteFd(fd)) return javaIoctlIntFd(fd,command);
  if (command !== 0x541b) return -E.NOTTY;
  return remoteRest(fd).then(rest => rest ? rest.length : -E.BADF);
}

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
  return remote ? result(remote,{kind:"ashmemProtect",prot}) : null;
}
export function processAshmemSize(fd: number): Promise<number> | null {
  const remote = openFd(fd)?.remote;
  return remote ? request(remote,{kind:"stat"}).then(reply => reply.result < 0 || reply.ashmemProt === undefined ? -1 : reply.stat!.size) : null;
}
