import { E } from "./abi";
import { fdBase, installFile, openFd, javaOpenFd, javaCloseFd, javaReadFd, javaPreadFd, javaWriteFd,
  javaPwriteFd, javaSeekFd, javaTruncateFd, javaSyncFd, javaFcntlFd, javaFdStat, javaIoctlIntFd, O_ACCMODE, O_CLOEXEC, type OpenFile } from "./fs";
import { isMutablePath } from "../shell/file-path";
import { vfs } from "../shell/vfs";
import type { DescriptorCalls, DescriptorReply, DescriptorRequest } from "../shell/file-descriptors";

export type RemoteDescriptor = { token: number; calls: () => DescriptorCalls; close: Promise<number> | null };
/** Bound lazily after the process is registered; the page's kernel never installs this. */
export const descriptorTransport: { calls?: () => DescriptorCalls } = {};
type Operation = DescriptorRequest extends infer R ? R extends {fd:number} ? Omit<R,"fd"> : never : never;
const request = (remote: RemoteDescriptor, operation: Operation) => remote.calls().fileDescriptor({...operation,fd:remote.token} as DescriptorRequest);
const result = (remote: RemoteDescriptor, operation: Operation) => request(remote,operation).then(reply => reply.result);
export const isRemoteFd = (fd: number): boolean => !!openFd(fd)?.remote;

export function processOpenFd(path: string, flags: number): number | Promise<number> {
  const normalized = vfs.norm(path), calls = isMutablePath(normalized) ? descriptorTransport.calls : undefined;
  if (!calls) return javaOpenFd(normalized,flags);
  return calls().fileDescriptor({kind:"open",path:normalized,flags}).then(reply => {
    if (reply.result < 0) return reply.result;
    const remote: RemoteDescriptor = {token:reply.result,calls,close:null};
    const file: OpenFile = {...fdBase(normalized),write:!!(flags & O_ACCMODE),statusFlags:flags,remote};
    file.onLastClose = () => {
      remote.close = result(remote,{kind:"close"});
      // Parcel/native owners can release a reference without waiting for close. Keep
      // rejection handled while an explicit syscall still receives the original Promise.
      void remote.close.catch(() => {});
    };
    return installFile(file,!!(flags & O_CLOEXEC));
  });
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
export function processIoctlIntFd(fd: number, command: number): number | Promise<number> {
  if (!isRemoteFd(fd)) return javaIoctlIntFd(fd,command);
  if (command !== 0x541b) return -E.NOTTY;
  return Promise.all([processFdStat(fd),processSeekFd(fd,0,1)]).then(([stat,position]) => !stat || position < 0 ? -E.BADF : Math.max(0,stat.size-position));
}
