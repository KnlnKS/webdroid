// The open files another realm owns: a process Worker's descriptors on the page's mutable files,
// whose position, flags and bytes live with their owner, so every operation is a request to it.
import { E, O_CLOEXEC, S_IFMT, S_IFDIR, S_IFREG } from "./abi.ts";
import { ANON, installFile, newFile, openFd, javaCloseFd, javaFdBytes, type FdStat, type FileOps } from "./fd.ts";
import { javaOpenFd, listProcess } from "./fs.ts";
import { openRemoteFifo } from "./pipe.ts";
import type { FileSource } from "../shell/lazyfile.ts";
import { pathOwner } from "../shell/file-path.ts";
import { vfs } from "../shell/vfs.ts";
import type { DescriptorCalls, DescriptorKind, DescriptorReply, DescriptorRequest, DescriptorRights } from "../shell/file-descriptors.ts";
import { settleRemoteMaps } from "./mappings.ts";

export const descriptorTransport: {
  /** the page's own rights, which its kernel answers directly */
  local?: DescriptorRights;
} = {};

/** An open file another realm owns, which answers each request on it by its token. */
export class RemoteDescriptor {
  token: number;
  calls: DescriptorCalls;
  constructor(token: number, calls: DescriptorCalls) { this.token = token; this.calls = calls; }
  request<K extends DescriptorKind>(kind: K, args: Omit<DescriptorRequest<K>, "kind" | "fd">): Promise<DescriptorReply<K>> {
    return this.calls.fileDescriptor({ kind, fd: this.token, ...args } as DescriptorRequest<K>);
  }
  stat(): Promise<FdStat | null> { return this.request("stat", {}).then(reply => typeof reply === "number" ? null : reply); }
  /** a lease on [offset, offset + length) of the open file */
  async map(offset: number, length: number, prot: number): Promise<ProcessMapping | number> {
    const calls = this.calls, acquired = await this.request("mappingAcquire", {offset,length,prot});
    if (typeof acquired === "number") return acquired;
    const {lease, region, immutable} = acquired;
    return {
      size:length,
      region,
      immutable,
      async read(offset,length) {
        const bytes = await calls.fileDescriptor({kind:"mappingRead",lease,offset,length});
        if (typeof bytes === "number") throw new Error(`shared mapping read: ${-bytes}`);
        if (bytes.length !== length) throw new Error("short shared mapping read");
        return bytes;
      },
      async write(offset,bytes) {
        const n = await calls.fileDescriptor({kind:"mappingWrite",lease,offset,bytes:bytes.slice()});
        if (n !== bytes.length) throw new Error(`shared mapping write: ${n}`);
      },
      async close() {
        const n = await calls.fileDescriptor({kind:"mappingRelease",lease});
        if (n < 0 && n !== -E.BADF) throw new Error(`shared mapping release: ${-n}`);
      },
    };
  }
}
const offsetOf = (off: number) => off < 0 ? undefined : off;
/** a read of the bytes, which come when the owner answers */
function remoteRead(remote: RemoteDescriptor, length: number, off: number): Promise<Uint8Array | number> {
  return remote.request("read", {length,offset:offsetOf(off)}).then(reply => {
    if (typeof reply !== "number" && reply.length > length) throw new Error("Invalid descriptor read reply");
    return reply;
  });
}
const REMOTE: FileOps = {
  ...ANON,
  positional: true,
  read: (f, _target, _at, n, off) => remoteRead(f.remote!, n, off),
  write: (f, bytes, off) => f.remote!.request("write", {bytes:bytes.slice(),offset:offsetOf(off)}),
  seek: (f, offset, whence) => f.remote!.request("seek", {offset,whence}),
  stat: (f) => f.remote!.stat(),
  sync: (f) => f.remote!.request("sync", {}),
  available: (f) => Promise.all([f.remote!.stat(), f.remote!.request("seek", {offset:0,whence:1})])
    .then(([stat, position]) => !stat || position < 0 ? -E.BADF : Math.max(0, stat.size - position)),
  truncate: (f, length) => f.remote!.request("truncate", {length}),
  allocate: (f, offset, length) => f.remote!.request("allocate", {offset,length}),
  status: (f, command, arg) => f.remote!.request("fcntl", {command,arg}),
  change: (f, change) => f.remote!.request("changeAttributes", {change}),
  /** a regular file as a source of its size now, read through its owner */
  source(f) {
    const remote = f.remote!;
    return remote.stat().then((stat): FileSource | null => stat && (stat.mode & S_IFMT) === S_IFREG ? { size: stat.size, read: (offset, length) =>
      remoteRead(remote, length, offset).then(bytes => { if (typeof bytes === "number") throw new Error("Bad file descriptor"); return bytes; }) } : null);
  },
  entries(f) {
    if (!f.dir) return -E.NOTDIR;
    if (f.pos && f.entries) return f.entries;
    return Promise.resolve(listProcess(f.path)).then(entries => typeof entries === "number" ? entries : f.entries = entries);
  },
  close(f) {
    const closing = f.remote!.request("close", {});
    void closing.catch(() => {});
    return closing;
  },
};
export const isRemoteFd = (fd: number): boolean => openFd(fd)?.ops === REMOTE;

function installRemote(token: number, calls: DescriptorCalls, path: string, flags: number, dir = false, cloexec = !!(flags & O_CLOEXEC)): number {
  const f = newFile(REMOTE, path, flags, undefined, dir);
  f.remote = new RemoteDescriptor(token, calls);
  return installFile(f, cloexec);
}
/** this realm's descriptor rights, which the page's kernel holds: the page's own locally, a process's through requests */
export const processRights: DescriptorRights = {
  stage(fd) {
    const remote = openFd(fd)?.remote;
    if (!remote) return descriptorTransport.local?.stage(fd) ?? null;
    // the receiver reads the file from its owner, which has only the stores of this process's mappings that reached it
    const settled = settleRemoteMaps(), stage = () => remote.request("stage", {});
    return settled ? settled.then(stage) : stage();
  },
  async take(token) {
    if (descriptorTransport.local) return descriptorTransport.local.take(token);
    const calls = pathOwner()?.descriptors;
    if (!calls) return -E.BADF;
    const stat = await calls.fileDescriptor({kind:"stat",fd:token});
    if (typeof stat === "number") return stat;
    const flags = await calls.fileDescriptor({kind:"fcntl",fd:token,command:3,arg:0});
    if (flags < 0) { await calls.fileDescriptor({kind:"close",fd:token}); return flags; }
    const taken = await calls.fileDescriptor({kind:"take",fd:token});
    return taken < 0 ? taken : installRemote(token,calls,stat.path ?? "",flags,(stat.mode & S_IFMT) === S_IFDIR,true);
  },
  discard(token, staged) {
    const local = descriptorTransport.local, calls = pathOwner()?.descriptors;
    if (local) return local.discard(token, staged);
    return calls ? calls.fileDescriptor({kind:staged ? "unstage" : "close",fd:token}) : Promise.resolve(-E.BADF);
  },
};

export function processOpenFd(path: string, flags: number): number | Promise<number> {
  const normalized = vfs.norm(path), calls = pathOwner(normalized)?.descriptors;
  if (!calls) return javaOpenFd(normalized,flags);
  return calls.fileDescriptor({kind:"open",path:normalized,flags}).then(reply =>
    typeof reply === "number" ? reply : reply === "fifo" ? openRemoteFifo(normalized,flags) : installRemote(reply.token,calls,normalized,flags,reply.dir));
}

/** a file's bytes, from the realm that owns its path */
export async function processFileBytes(path: string): Promise<Uint8Array | null> {
  if (!pathOwner(path)) return vfs.readFile(path);
  const fd = await processOpenFd(path, 0);
  if (fd < 0) return null;
  try { return await javaFdBytes(fd); } finally { await javaCloseFd(fd); }
}

/** An owner's lease on a range of a file, which outlives the descriptor that took it; `region` names the file. */
export type ProcessMapping = { size: number; region: number; immutable: boolean; read(offset: number, length: number): Promise<Uint8Array>; write(offset: number, bytes: Uint8Array): Promise<void>; close(): Promise<void> };
export function processAshmemCreate(size: number): Promise<number> | null {
  const calls = pathOwner()?.descriptors;
  return calls ? calls.fileDescriptor({kind:"ashmemCreate",size}).then(token => token < 0 ? token : installRemote(token,calls,"",2,false,true)) : null;
}
export function processAshmemProtect(fd: number, prot: number): Promise<number> | null {
  const remote = openFd(fd)?.remote;
  return remote ? remote.request("ashmemProtect", {prot}) : null;
}
export function processAshmemSize(fd: number): Promise<number> | null {
  const remote = openFd(fd)?.remote;
  return remote ? remote.request("stat", {}).then(stat => typeof stat === "number" || stat.ashmemProt === undefined ? -1 : stat.size) : null;
}
