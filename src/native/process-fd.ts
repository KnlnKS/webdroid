// The open files another realm owns: a process Worker's descriptors on the page's mutable files,
// whose position, flags and bytes live with their owner, so every operation is a request to it.
import { E, O_CLOEXEC, S_IFMT, S_IFDIR, S_IFREG } from "./abi.ts";
import { ANON, installFile, isKind, newFile, openFd, closeFd, readRest, type FdStat, type FileOps } from "./fd.ts";
import { localOpen, listAt } from "./fs.ts";
import { openRemoteFifo } from "./pipe.ts";
import type { FileSource } from "../shell/lazyfile.ts";
import { pathOwner } from "../shell/file-path.ts";
import { vfs } from "../shell/vfs.ts";
import type { DescriptorCalls, DescriptorRights } from "../shell/file-descriptors.ts";
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
  stat(): Promise<FdStat | null> { return this.calls.stat(this.token).then(reply => typeof reply === "number" ? null : reply); }
  /** a lease on [offset, offset + length) of the open file */
  async map(offset: number, length: number, prot: number): Promise<ProcessMapping | number> {
    const calls = this.calls, acquired = await calls.mappingAcquire(this.token, offset, length, prot);
    if (typeof acquired === "number") return acquired;
    const {lease, region, immutable} = acquired;
    return {
      size:length,
      region,
      immutable,
      async read(offset,length) {
        const bytes = await calls.mappingRead(lease,offset,length);
        if (typeof bytes === "number") throw new Error(`shared mapping read: ${-bytes}`);
        if (bytes.length !== length) throw new Error("short shared mapping read");
        return bytes;
      },
      async write(offset,bytes) {
        const n = await calls.mappingWrite(lease,offset,bytes.slice());
        if (n !== bytes.length) throw new Error(`shared mapping write: ${n}`);
      },
      async close() {
        const n = await calls.mappingRelease(lease);
        if (n < 0 && n !== -E.BADF) throw new Error(`shared mapping release: ${-n}`);
      },
    };
  }
}
const offsetOf = (off: number) => off < 0 ? undefined : off;
/** a read of the bytes, which come when the owner answers */
function remoteRead(remote: RemoteDescriptor, length: number, off: number): Promise<Uint8Array | number> {
  return remote.calls.read(remote.token, length, offsetOf(off)).then(reply => {
    if (typeof reply !== "number" && reply.length > length) throw new Error("Invalid descriptor read reply");
    return reply;
  });
}
/** the open file's owner in another realm, which answers every operation on it, and a directory's
 *  entries, listed when reading starts */
type Remote = { remote: RemoteDescriptor; entries: string[] | null };
const REMOTE: FileOps<Remote> = {
  ...ANON,
  positional: true,
  read: (f, _target, _at, n, off) => remoteRead(f.state.remote, n, off),
  write: ({state: {remote}}, bytes, off) => remote.calls.write(remote.token, bytes.slice(), offsetOf(off)),
  // a directory's position indexes the entries listed here
  seek: (f, offset, whence) => !f.dir ? f.state.remote.calls.seek(f.state.remote.token, offset, whence) : whence === 0 && offset >= 0 ? f.pos = offset : -E.INVAL,
  stat: (f) => f.state.remote.stat(),
  sync: ({state: {remote}}) => remote.calls.sync(remote.token),
  available: ({state: {remote}}) => Promise.all([remote.stat(), remote.calls.seek(remote.token, 0, 1)])
    .then(([stat, position]) => !stat || position < 0 ? -E.BADF : Math.max(0, stat.size - position)),
  truncate: ({state: {remote}}, length) => remote.calls.truncate(remote.token, length),
  allocate: ({state: {remote}}, offset, length) => remote.calls.allocate(remote.token, offset, length),
  status: ({state: {remote}}, command, arg) => remote.calls.fcntl(remote.token, command, arg),
  change: ({state: {remote}}, change) => remote.calls.changeAttributes(remote.token, change),
  /** a regular file as a source of its size now, read through its owner */
  source(f) {
    const remote = f.state.remote;
    return remote.stat().then((stat): FileSource | null => stat && (stat.mode & S_IFMT) === S_IFREG ? { size: stat.size, read: (offset, length) =>
      remoteRead(remote, length, offset).then(bytes => { if (typeof bytes === "number") throw new Error("Bad file descriptor"); return bytes; }) } : null);
  },
  entries(f) {
    if (!f.dir) return -E.NOTDIR;
    if (f.pos && f.state.entries) return f.state.entries;
    return Promise.resolve(listAt(f.path)).then(entries => typeof entries === "number" ? entries : f.state.entries = entries);
  },
  close(f) {
    const closing = f.state.remote.calls.close(f.state.remote.token);
    void closing.catch(() => {});
    return closing;
  },
};
/** the owner of the open file `fd` names in another realm, if another realm owns it */
export const remoteOf = (fd: number): RemoteDescriptor | undefined => { const f = openFd(fd); return isKind(f, REMOTE) ? f.state.remote : undefined; };
export const isRemoteFd = (fd: number): boolean => !!remoteOf(fd);

function installRemote(token: number, calls: DescriptorCalls, path: string, flags: number, dir = false, cloexec = !!(flags & O_CLOEXEC)): number {
  return installFile(newFile(REMOTE, path, flags, { remote: new RemoteDescriptor(token, calls), entries: null }, undefined, dir), cloexec);
}
/** this realm's descriptor rights, which the page's kernel holds: the page's own locally, a process's through requests */
export const processRights: DescriptorRights = {
  stage(fd) {
    const remote = remoteOf(fd);
    if (!remote) return descriptorTransport.local?.stage(fd) ?? null;
    // the receiver reads the file from its owner, which has only the stores of this process's mappings that reached it
    const settled = settleRemoteMaps(), stage = () => remote.calls.stage(remote.token);
    return settled ? settled.then(stage) : stage();
  },
  async take(token) {
    if (descriptorTransport.local) return descriptorTransport.local.take(token);
    const calls = pathOwner()?.descriptors;
    if (!calls) return -E.BADF;
    const stat = await calls.stat(token);
    if (typeof stat === "number") return stat;
    const flags = await calls.fcntl(token, 3, 0);
    if (flags < 0) { await calls.close(token); return flags; }
    const taken = await calls.take(token);
    return taken < 0 ? taken : installRemote(token,calls,stat.path ?? "",flags,(stat.mode & S_IFMT) === S_IFDIR,true);
  },
  discard(token, staged) {
    const local = descriptorTransport.local, calls = pathOwner()?.descriptors;
    if (local) return local.discard(token, staged);
    return calls ? (staged ? calls.unstage(token) : calls.close(token)) : Promise.resolve(-E.BADF);
  },
};

export function processOpenFd(path: string, flags: number): number | Promise<number> {
  const normalized = vfs.norm(path), calls = pathOwner(normalized)?.descriptors;
  if (!calls) return localOpen(normalized,flags);
  return calls.open(normalized, flags).then(reply =>
    typeof reply === "number" ? reply : reply === "fifo" ? openRemoteFifo(normalized,flags) : installRemote(reply.token,calls,normalized,flags,reply.dir));
}

/** a file's bytes, from the realm that owns its path */
export async function processFileBytes(path: string): Promise<Uint8Array | null> {
  if (!pathOwner(path)) return vfs.readFile(path);
  const fd = await processOpenFd(path, 0);
  if (fd < 0) return null;
  try { return await readRest(fd); } finally { await closeFd(fd); }
}

/** An owner's lease on a range of a file, which outlives the descriptor that took it; `region` names the file. */
export type ProcessMapping = { size: number; region: number; immutable: boolean; read(offset: number, length: number): Promise<Uint8Array>; write(offset: number, bytes: Uint8Array): Promise<void>; close(): Promise<void> };
export function processAshmemCreate(size: number): Promise<number> | null {
  const calls = pathOwner()?.descriptors;
  return calls ? calls.ashmemCreate(size).then(token => token < 0 ? token : installRemote(token,calls,"",2,false,true)) : null;
}
export function processAshmemProtect(fd: number, prot: number): Promise<number> | null {
  const remote = remoteOf(fd);
  return remote ? remote.calls.ashmemProtect(remote.token, prot) : null;
}
export function processAshmemSize(fd: number): Promise<number> | null {
  const remote = remoteOf(fd);
  return remote ? remote.calls.stat(remote.token).then(stat => typeof stat === "number" || stat.ashmemProt === undefined ? -1 : stat.size) : null;
}
