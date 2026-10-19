import { E } from "./abi.ts";
import { fdBase, installFile, openFd, javaOpenFd, javaCloseFd, javaFdBytes,
  O_ACCMODE, O_CLOEXEC, S_IFMT, S_IFDIR, S_IFREG, openRemoteFifo, type FdStat, type OpenFile } from "./fs.ts";
import type { FileSource } from "../shell/lazyfile.ts";
import { isMutablePath, type AttributeChange } from "../shell/file-path.ts";
import { vfs } from "../shell/vfs.ts";
import type { DescriptorCalls, DescriptorRights } from "../shell/file-descriptors.ts";
import { settleRemoteMaps } from "./mappings.ts";

/** Bound lazily after the process is registered; the page's kernel never installs this. */
export const descriptorTransport: {
  calls?: () => DescriptorCalls;
  importCalls?: () => DescriptorCalls;
  /** the page's own rights, which its kernel answers directly */
  local?: DescriptorRights;
} = {};

/** An open file another realm owns: its position, flags and bytes live there, so every operation is a request. */
export class RemoteDescriptor {
  token: number;
  calls: () => DescriptorCalls;
  /** the owner's close, requested when this realm's last descriptor for it closed */
  closing: Promise<number> | null = null;
  constructor(token: number, calls: () => DescriptorCalls) { this.token = token; this.calls = calls; }
  read(target: Uint8Array, offset?: number): Promise<number> {
    return this.calls().fileDescriptor({kind:"read",fd:this.token,length:target.length,offset}).then(reply => {
      if (typeof reply === "number") return reply;
      if (reply.length > target.length) throw new Error("Invalid descriptor read reply");
      target.set(reply);
      return reply.length;
    });
  }
  write(bytes: Uint8Array, offset?: number): Promise<number> {
    return this.calls().fileDescriptor({kind:"write",fd:this.token,bytes:bytes.slice(),offset});
  }
  seek(offset: number, whence: number): Promise<number> { return this.calls().fileDescriptor({kind:"seek",fd:this.token,offset,whence}); }
  truncate(length: number): Promise<number> { return this.calls().fileDescriptor({kind:"truncate",fd:this.token,length}); }
  allocate(offset: number, length: number): Promise<number> { return this.calls().fileDescriptor({kind:"allocate",fd:this.token,offset,length}); }
  sync(): Promise<number> { return this.calls().fileDescriptor({kind:"sync",fd:this.token}); }
  fcntl(command: number, arg: number): Promise<number> { return this.calls().fileDescriptor({kind:"fcntl",fd:this.token,command,arg}); }
  changeAttributes(change: AttributeChange): Promise<number> { return this.calls().fileDescriptor({kind:"changeAttributes",fd:this.token,change}); }
  stat(): Promise<FdStat | null> { return this.calls().fileDescriptor({kind:"stat",fd:this.token}).then(reply => typeof reply === "number" ? null : reply); }
  /** a lease on [offset, offset + length) of the open file */
  async map(offset: number, length: number, prot: number): Promise<ProcessMapping | number> {
    const calls = this.calls, acquired = await calls().fileDescriptor({kind:"mappingAcquire",fd:this.token,offset,length,prot});
    if (typeof acquired === "number") return acquired;
    const {lease, region, immutable} = acquired;
    return {
      size:length,
      region,
      immutable,
      async read(offset,length) {
        const bytes = await calls().fileDescriptor({kind:"mappingRead",lease,offset,length});
        if (typeof bytes === "number") throw new Error(`shared mapping read: ${-bytes}`);
        if (bytes.length !== length) throw new Error("short shared mapping read");
        return bytes;
      },
      async write(offset,bytes) {
        const n = await calls().fileDescriptor({kind:"mappingWrite",lease,offset,bytes:bytes.slice()});
        if (n !== bytes.length) throw new Error(`shared mapping write: ${n}`);
      },
      async close() {
        const n = await calls().fileDescriptor({kind:"mappingRelease",lease});
        if (n < 0 && n !== -E.BADF) throw new Error(`shared mapping release: ${-n}`);
      },
    };
  }
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
    remote.closing = calls().fileDescriptor({kind:"close",fd:token});
    void remote.closing.catch(() => {});
  };
  return installFile(file,cloexec);
}
const kernelCalls = () => descriptorTransport.calls ?? descriptorTransport.importCalls;
/** this realm's descriptor rights, which the page's kernel holds: the page's own locally, a process's through requests */
export const processRights: DescriptorRights = {
  stage(fd) {
    const remote = openFd(fd)?.remote;
    if (!remote) return descriptorTransport.local?.stage(fd) ?? null;
    // the receiver reads the file from its owner, which has only the stores of this process's mappings that reached it
    const settled = settleRemoteMaps(), stage = () => remote.calls().fileDescriptor({kind:"stage",fd:remote.token});
    return settled ? settled.then(stage) : stage();
  },
  async take(token) {
    if (descriptorTransport.local) return descriptorTransport.local.take(token);
    const calls = kernelCalls();
    if (!calls) return -E.BADF;
    const stat = await calls().fileDescriptor({kind:"stat",fd:token});
    if (typeof stat === "number") return stat;
    const flags = await calls().fileDescriptor({kind:"fcntl",fd:token,command:3,arg:0});
    if (flags < 0) { await calls().fileDescriptor({kind:"close",fd:token}); return flags; }
    const taken = await calls().fileDescriptor({kind:"take",fd:token});
    return taken < 0 ? taken : installRemote(token,calls,stat.path ?? "",flags,(stat.mode & S_IFMT) === S_IFDIR,true);
  },
  discard(token, staged) {
    const local = descriptorTransport.local, calls = kernelCalls();
    if (local) return local.discard(token, staged);
    return calls ? calls().fileDescriptor({kind:staged ? "unstage" : "close",fd:token}) : Promise.resolve(-E.BADF);
  },
};

export function processOpenFd(path: string, flags: number): number | Promise<number> {
  const normalized = vfs.norm(path), calls = isMutablePath(normalized) ? descriptorTransport.calls : undefined;
  if (!calls) return javaOpenFd(normalized,flags);
  return calls().fileDescriptor({kind:"open",path:normalized,flags}).then(reply =>
    typeof reply === "number" ? reply : reply === "fifo" ? openRemoteFifo(normalized,flags) : installRemote(reply.token,calls,normalized,flags,reply.dir));
}

/** a file's bytes, from the realm that owns its path */
export async function processFileBytes(path: string): Promise<Uint8Array | null> {
  if (!isMutablePath(path) || !descriptorTransport.calls) return vfs.readFile(path);
  const fd = await processOpenFd(path, 0);
  if (fd < 0) return null;
  try { return await javaFdBytes(fd); } finally { await javaCloseFd(fd); }
}

/** An owner's lease on a range of a file, which outlives the descriptor that took it; `region` names the file. */
export type ProcessMapping = { size: number; region: number; immutable: boolean; read(offset: number, length: number): Promise<Uint8Array>; write(offset: number, bytes: Uint8Array): Promise<void>; close(): Promise<void> };
export function processAshmemCreate(size: number): Promise<number> | null {
  const calls = descriptorTransport.calls;
  return calls ? calls().fileDescriptor({kind:"ashmemCreate",size}).then(token => token < 0 ? token : installRemote(token,calls,"",2,false,true)) : null;
}
export function processAshmemProtect(fd: number, prot: number): Promise<number> | null {
  const remote = openFd(fd)?.remote;
  return remote ? remote.calls().fileDescriptor({kind:"ashmemProtect",fd:remote.token,prot}) : null;
}
export function processAshmemSize(fd: number): Promise<number> | null {
  const remote = openFd(fd)?.remote;
  return remote ? remote.calls().fileDescriptor({kind:"stat",fd:remote.token}).then(stat => typeof stat === "number" || stat.ashmemProt === undefined ? -1 : stat.size) : null;
}
