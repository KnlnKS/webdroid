// The open files another realm owns: a process Worker's descriptors on the page's mutable files,
// whose position, flags and bytes live with their owner, so every operation is a request to it; an
// fstat it answered stands while its count of the file's changes holds (vfs.ts).
import { E, O_CLOEXEC, S_IFMT, S_IFREG } from "./abi.ts";
import { ANON, crossingOf, fdSource, installFile, isKind, newFile, openFd, closeFd, readRest, type FdStat, type FileOps } from "./fd.ts";
import { localOpen, listAt } from "./fs.ts";
import { openRemoteFifo } from "./pipe.ts";
import type { FileSource } from "../shell/lazyfile.ts";
import { OwnerAnswers, ownerChange, pathOwner } from "../shell/file-path.ts";
import { vfs } from "../shell/vfs.ts";
import type { DescriptorCalls, DescriptorRights, MappingLease, TakenRight } from "../shell/file-descriptors.ts";
import { settleRemoteMaps } from "./mappings.ts";
import { importSocket } from "./socket/unix.ts";
import type { CrossingSocket } from "./socket/bridge.ts";

export const descriptorTransport: {
  /** the page's own rights, which its kernel answers directly */
  local?: DescriptorRights;
} = {};

/** An open file another realm owns, which answers each request on it by its token. */
export class RemoteDescriptor {
  token: number;
  calls: DescriptorCalls;
  /** the file's name as its owner last answered, whose fstat stands while the name is unchanged */
  private name: string | null;
  private readonly stats = new OwnerAnswers<FdStat | null>(1);
  /** `opened`: the fstat the owner answered the open with, when `name` had changed `count` times */
  constructor(token: number, calls: DescriptorCalls, name: string | null, opened?: { count: number | undefined; stat: FdStat }) {
    this.token = token; this.calls = calls; this.name = opened?.stat.path ?? name;
    if (name !== null && opened?.stat.path === name) this.stats.keep(name, opened.count, opened.stat);
  }
  stat(): FdStat | null | Promise<FdStat | null> {
    const name = this.name, ask = () => this.calls.stat(this.token).then(reply => typeof reply === "number" ? null : (this.name = reply.path, reply));
    return name === null ? ask() : this.stats.answer(name, ask, (stat) => stat?.path === name);
  }
  /** a lease on [offset, offset + length) of the open file */
  async map(offset: number, length: number, prot: number): Promise<ProcessMapping | number> {
    const calls = this.calls, acquired = await calls.mappingAcquire(this.token, offset, length, prot);
    if (typeof acquired === "number") return acquired;
    const {lease, ...shared} = acquired;
    return {
      size:length,
      ...shared,
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
  ioctl: ({state: {remote}}, request, arg) => remote.calls.ioctl(remote.token, request, arg),
  status: ({state: {remote}}, command, arg) => remote.calls.fcntl(remote.token, command, arg),
  change: ({state: {remote}}, change) => remote.calls.changeAttributes(remote.token, change),
  /** a regular file as a source of its size now, read through its owner */
  async source(f) {
    const remote = f.state.remote, stat = await remote.stat();
    return stat && (stat.mode & S_IFMT) === S_IFREG ? { size: stat.size, read: (offset, length) =>
      remoteRead(remote, length, offset).then(bytes => { if (typeof bytes === "number") throw new Error("Bad file descriptor"); return bytes; }) } : null;
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

function installRemote(remote: RemoteDescriptor, path: string, flags: number, dir = false, cloexec = !!(flags & O_CLOEXEC)): number {
  return installFile(newFile(REMOTE, path, flags, { remote, entries: null }, undefined, dir), cloexec);
}
const owner = () => pathOwner()?.descriptors;
/** `send` of what the page's kernel can hold of this realm's `fd`: a remote descriptor's token, or a socket end crossing to
 *  another realm; null for an open file the kernel cannot hold */
function handOver(fd: number, send: (calls: DescriptorCalls, right: number | CrossingSocket) => Promise<number>): PromiseOrVal<number> | null {
  const remote = remoteOf(fd);
  if (remote) {
    // the receiver reads the file from its owner, which has only the stores of this process's mappings that reached it
    const settled = settleRemoteMaps(), go = () => send(remote.calls, remote.token);
    return settled ? settled.then(go) : go();
  }
  const calls = owner(), socket = calls ? crossingOf(fd) : null;
  return calls && socket ? send(calls, socket) : null;
}
/** a right the page's kernel handed this realm, as a descriptor: a socket end connected across realms, or an open file its owner keeps */
const installTaken = (calls: DescriptorCalls, right: number | TakenRight): number =>
  typeof right === "number" ? right : "port" in right ? importSocket(right) : installRemote(new RemoteDescriptor(right.token, calls, right.path || null), right.path, right.flags, right.dir, true);
/** this realm's descriptor rights, which the page's kernel holds: the page's own locally, a process's through requests */
export const processRights: DescriptorRights = {
  stage(fd) {
    const local = descriptorTransport.local;
    return local ? local.stage(fd) : handOver(fd, (calls, right) => calls.stage(right));
  },
  take(token) {
    const local = descriptorTransport.local, calls = owner();
    return local ? local.take(token) : calls ? calls.take(token).then(right => installTaken(calls, right)) : -E.BADF;
  },
  discard(token, staged) {
    const local = descriptorTransport.local, calls = owner();
    if (local) return local.discard(token, staged);
    return calls ? (staged ? calls.unstage(token) : calls.close(token)) : Promise.resolve(-E.BADF);
  },
  park(fd) {
    const local = descriptorTransport.local;
    return local ? local.park(fd) : handOver(fd, (calls, right) => calls.park(right));
  },
  claim(ticket) {
    const local = descriptorTransport.local, calls = owner();
    return local ? local.claim(ticket) : calls ? calls.claim(ticket).then(right => installTaken(calls, right)) : -E.BADF;
  },
};

export function processOpenFd(path: string, flags: number): PromiseOrVal<number> {
  const normalized = vfs.norm(path), calls = pathOwner(normalized)?.descriptors;
  if (!calls) return localOpen(normalized,flags);
  const count = ownerChange(normalized);
  return calls.open(normalized, flags).then(reply => {
    if (typeof reply === "number") return reply;
    if (reply === "fifo") return openRemoteFifo(normalized,flags);
    return installRemote(new RemoteDescriptor(reply.token,calls,normalized,reply.stat ? {count,stat:reply.stat} : undefined),normalized,flags,reply.dir);
  });
}

/** `use` of `path` open for reading in the realm that owns it; null when it does not open */
async function withProcessFile<T>(path: string, use: (fd: number) => PromiseOrVal<T>): Promise<T | null> {
  const fd = await processOpenFd(path, 0);
  if (fd < 0) return null;
  try { return await use(fd); } finally { await closeFd(fd); }
}
/** a file's bytes, from the realm that owns its path */
export const processFileBytes = async (path: string): Promise<Uint8Array | null> => pathOwner(path) ? withProcessFile(path, readRest) : vfs.readFile(path);
/** `use` of a regular file's source, from the realm that owns its path; null when there is none */
export async function withProcessSource<T>(path: string, use: (source: FileSource) => Promise<T>): Promise<T | null> {
  if (!pathOwner(path)) { const source = vfs.source(path); return source ? use(source) : null; }
  return withProcessFile(path, async fd => { const source = await fdSource(fd); return source ? use(source) : null; });
}

/** An owner's lease on a range of a file, which outlives the descriptor that took it. */
export type ProcessMapping = Omit<MappingLease, "lease"> & { size: number; read(offset: number, length: number): Promise<Uint8Array>; write(offset: number, bytes: Uint8Array): Promise<void>; close(): Promise<void> };
export function processAshmemCreate(size: number): Promise<number> | null {
  const calls = owner();
  return calls ? calls.ashmemCreate(size).then(token => token < 0 ? token : installRemote(new RemoteDescriptor(token,calls,null),"",2,false,true)) : null;
}
