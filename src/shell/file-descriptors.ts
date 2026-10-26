import { E, O_ACCMODE, O_CREAT, O_TRUNC, S_IFMT, S_IFREG } from "../native/abi.ts";
import { closeFd, crossingOf, dupFd, fcntlFd, ioctlIntFd, localFdStat, preadFd, pwriteFd, readFd, seekFd, syncFd,
  truncateFd, allocateFd, writeFd, openFd, changeFdAttributes, type FdStat, type OpenFile } from "../native/fd.ts";
import { regionFd, regionOf, localOpen } from "../native/fs.ts";
import { closeCrossing, isPorted, portedFd, type CrossingSocket } from "../native/socket/bridge.ts";
import { importSocket } from "../native/socket/unix.ts";
import { detachFdScope } from "../android/fd-scope.ts";
import type { AttributeChange } from "./file-path.ts";
import { fifoOf, holdFifo, type Pipe } from "../native/pipe.ts";
import { vfs, type VfsFile } from "./vfs.ts";
import { writable } from "./lazyfile.ts";
import { releaseRights, type ParcelData } from "../android/binder.ts";
import { rt } from "../jvm/runtime.ts";

/** what a process asks of the page's kernel about the open files and leases it holds by token: each answers a
 *  result, or -errno */
export type DescriptorCalls = {
  ashmemCreate(size: number): Promise<number>;
  /** the process that holds a fifo keeps its own pipe behind its name */
  open(path: string, flags: number): Promise<number | { token: number; dir: boolean } | "fifo">;
  /** at the open file's position, or at `offset` without moving it */
  read(fd: number, length: number, offset?: number): Promise<number | Uint8Array>;
  write(fd: number, bytes: Uint8Array, offset?: number): Promise<number>;
  seek(fd: number, offset: number, whence: number): Promise<number>;
  truncate(fd: number, length: number): Promise<number>;
  allocate(fd: number, offset: number, length: number): Promise<number>;
  fcntl(fd: number, command: number, arg: number): Promise<number>;
  stat(fd: number): Promise<number | FdStat>;
  sync(fd: number): Promise<number>;
  close(fd: number): Promise<number>;
  /** a descriptor, or a socket end of the process crossing to another realm, staged for another process */
  stage(right: number | CrossingSocket): Promise<number>;
  unstage(fd: number): Promise<number>;
  /** an incoming right, which the process takes */
  take(fd: number): Promise<number | TakenRight>;
  /** what `stage` stages, parked for whichever process claims its ticket */
  park(right: number | CrossingSocket): Promise<number>;
  /** a parked right, taken */
  claim(ticket: number): Promise<number | TakenRight>;
  /** ioctl(2) with an int argument and result */
  ioctl(fd: number, request: number, arg: number): Promise<number>;
  changeAttributes(fd: number, change: AttributeChange): Promise<number>;
  /** a lease on a range of the open file */
  mappingAcquire(fd: number, offset: number, length: number, prot: number): Promise<number | MappingLease>;
  mappingRead(lease: number, offset: number, length: number): Promise<number | Uint8Array>;
  mappingWrite(lease: number, offset: number, bytes: Uint8Array): Promise<number>;
  mappingRelease(lease: number): Promise<number>;
};
/** a lease on a range of an open file: `region` names the file, an immutable one's bytes cannot change, and one in the
 *  shared pool is at offset `pool` of it (shm.ts) */
export type MappingLease = { lease: number; region: number; immutable: boolean; pool?: number };
/** an incoming right as its process takes it: a socket end's port, or the token of an open file the kernel keeps, with
 *  its path, status flags and kind */
export type TakenRight = CrossingSocket | { token: number; path: string; flags: number; dir: boolean };
/** What a realm does with its descriptor rights: stages one of its descriptors for another process (null for one the
 *  page's kernel cannot hold), takes a right sent to it as a descriptor of its own, and discards one it staged
 *  (`staged`) or received and will not take. A socket passes its rights parked, for whichever process claims them. */
export type DescriptorRights = {
  stage(fd: number): number | Promise<number> | null;
  take(token: number): number | Promise<number>;
  discard(token: number, staged: boolean): Promise<number>;
  park(fd: number): number | Promise<number> | null;
  claim(ticket: number): number | Promise<number>;
};
/** a session's open file: its own, staged for another process, or received and not yet taken */
type Descriptor = { fd: number; file: OpenFile; state: "open" | "staged" | "incoming" };
type Mapping = { fd: number; file: OpenFile; offset: number; length: number; prot: number };
type Session = { pid: number; dead: boolean; descriptors: Map<number, Descriptor>; mappings: Map<number, Mapping>; fifos: Set<Pipe>; authorize(path: string, write: boolean): number; uid?: number };
export type RetainedDescriptor = { readonly fd:number; readonly file:OpenFile; closed:boolean; closing?:Promise<void> };
/** why [offset, offset + length) of a lease cannot be read (access 1) or written (2), or 0 */
function rangeError(mapping: Mapping, offset: number, length: number, access: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || offset > mapping.length - length) return E.INVAL;
  if (!(mapping.prot & access)) return E.ACCES;
  // the bytes of a mapping's last page past EOF are its own, not the file's
  return mapping.offset + offset + length > mapping.file.content.len ? E.NOTSUP : 0;
}

type ParcelObject = ParcelData["objects"][number][1];
/** a copy of `data` whose objects are what `map` makes of them; on failure `undo` gets the copy as far as it got,
 *  to release the rights it holds */
export async function mapRights(data: ParcelData, map: (object: ParcelObject, at: number) => ParcelObject | Promise<ParcelObject>,
  undo: (partial: ParcelData) => Promise<void>): Promise<ParcelData> {
  const mapped: ParcelData = { bytes: data.bytes.slice(), objects: [] };
  try {
    for (const [at, object] of data.objects) mapped.objects.push([at, await map(object, at)]);
    return mapped;
  } catch (error) { await undo(mapped); throw error; }
}

/** The page's kernel owns open files; process tokens never expose its descriptor numbers.
 * Duplication retains that open file (including position/status flags), rather than reopening
 * a path or copying bytes. Mapping transport is a separate kernel operation. */
export class FileDescriptors {
  private next = 1;
  private sessions = new Map<number, Session>();
  private queues = new WeakMap<VfsFile, Promise<void>>();
  private regions = new WeakMap<VfsFile, number>();
  private nextRegion = 1;
  /** rights parked by ticket, which belong to no process until one claims them */
  private parked = new Map<number, RetainedDescriptor>();

  /** A stored Parcel owns this reference independently of the originating PID. */
  async retain(pid:number,token:number): Promise<RetainedDescriptor | null> {
    const session=this.sessions.get(pid),descriptor=session?.descriptors.get(token);
    if (!session || session.dead || descriptor?.state !== "staged") return null;
    session.descriptors.delete(token);
    return this.ordered(descriptor.file,()=>{
      if (session.dead) {closeFd(descriptor.fd);return null;}
      return {fd:descriptor.fd,file:descriptor.file,closed:false};
    });
  }
  async replay(right:RetainedDescriptor,pid:number): Promise<number> {
    const target=this.sessions.get(pid);
    if (!target || target.dead || right.closed) return -E.BADF;
    return this.ordered(right.file,()=>right.closed || target.dead ? -E.BADF : this.put(target,dupFd(right.fd,true),"incoming"));
  }
  release(right:RetainedDescriptor): Promise<void> {
    if (right.closing) return right.closing;
    right.closed=true;
    return right.closing=this.ordered(right.file,()=>{closeFd(right.fd);});
  }
  /** `use` with `data`'s descriptor rights moved from `from` to `to`, which gives them back unless `use` succeeds;
   *  `from`'s staged rights are discarded either way. `check` throws once either process may not take part. */
  async withTransferred<T>(from: number, to: number, data: ParcelData, use: (moved: ParcelData) => Promise<T>, check: () => void): Promise<T> {
    let moved: ParcelData | null = null;
    try {
      check();
      this.ensureReceiver(to);
      moved = await mapRights(data, async object => {
        if (!object || !("descriptor" in object)) return object;
        const token = await this.receive(from, object.descriptor, to);
        if (token < 0) throw rt.mkThrowable("android/os/BadParcelableException", "Invalid Binder descriptor right: " + token);
        return { descriptor: token };
      }, partial => releaseRights(partial, this.rights(to), false));
      return await use(moved);
    } catch (error) {
      if (moved) await releaseRights(moved, this.rights(to), false);
      throw error;
    } finally { await releaseRights(data, this.rights(from), true); }
  }

  session(pid: number, authorize: Session["authorize"], uid?: number): DescriptorCalls {
    let session = this.sessions.get(pid);
    if (!session) this.sessions.set(pid, session = {pid, dead:false, descriptors:new Map(), mappings:new Map(), fifos:new Set(), authorize,uid});
    else { session.authorize = authorize;session.uid = uid; }
    return this.calls(session);
  }
  ensureReceiver(pid: number): void { if (!this.sessions.has(pid)) this.session(pid,()=>E.ACCES); }

  private put(session: Session, fd: number, state: Descriptor["state"] = "open"): number {
    if (fd < 0) return fd;
    detachFdScope(fd);
    const file = openFd(fd)!;
    // Pipes/sockets must not wait behind their own blocking read. They require their
    // existing independent readiness protocol, not this regular-file operation queue; a
    // socket crossing between processes (bridge.ts) is only held here.
    if (!file.dir && (localFdStat(fd)!.mode & S_IFMT) !== S_IFREG && !isPorted(file)) { closeFd(fd); return -E.NOTSUP; }
    const token = this.next++;
    session.descriptors.set(token, {fd,file,state});
    return token;
  }

  private ordered<T>(file: OpenFile, operation: () => T | Promise<T>): Promise<T> {
    const pending = (this.queues.get(file.content) ?? Promise.resolve()).then(operation);
    this.queues.set(file.content, pending.then(() => {}, () => {}));
    return pending;
  }
  /** `operation` on a session's descriptor or lease, after the operations already queued on its open file */
  private inOrder<T extends { file: OpenFile }, R>(session: Session, entry: T | undefined, operation: (entry: T) => R | Promise<R>): number | Promise<number | R> {
    if (!entry) return -E.BADF;
    return this.ordered(entry.file, async () => {
      if (session.dead) return -E.BADF;
      const reply = await operation(entry);
      return session.dead ? -E.BADF : reply;
    });
  }
  /** Retire the public token at dispatch. Already-dispatched operations still own their
   *  descriptor until the ordered close, preventing reuse during an async read. */
  private retire(session: Session, token: number, staged: boolean): number | Promise<number> {
    const descriptor = session.descriptors.get(token);
    if (!descriptor || staged && descriptor.state !== "staged") return -E.BADF;
    session.descriptors.delete(token);
    return this.ordered(descriptor.file, () => closeFd(descriptor.fd));
  }
  /** the kernel's `fd` staged for the session: a socket end crossing to another realm goes as its port */
  private stageFd(session: Session, fd: number): number {
    const socket = crossingOf(fd);
    return this.put(session, socket ? portedFd(socket) : dupFd(fd), "staged");
  }
  /** a socket end of the session's process, crossing to another realm, as a staged right */
  private adopt(session: Session, socket: CrossingSocket): number {
    if (!session.dead) return this.put(session, portedFd(socket), "staged");
    closeCrossing(socket.port);
    return -E.BADF;
  }
  /** a staged right parked for whichever process claims its ticket */
  private async park(session: Session, staged: number | Promise<number>): Promise<number> {
    const token = await staged;
    if (token < 0) return token;
    const right = await this.retain(session.pid, token);
    if (!right) return -E.BADF;
    const ticket = this.next++;
    this.parked.set(ticket, right);
    return ticket;
  }
  /** a parked right as an incoming one of the session */
  private async claim(session: Session, ticket: number): Promise<number> {
    const right = this.parked.get(ticket);
    if (!right) return -E.BADF;
    this.parked.delete(ticket);
    try { return await this.replay(right, session.pid); } finally { await this.release(right); }
  }
  /** the session's incoming right, taken: a socket end crossing to its taker, or the descriptor, now the session's own */
  private take(session: Session, token: number): Descriptor | CrossingSocket | number {
    const descriptor = session.descriptors.get(token);
    if (session.dead || descriptor?.state !== "incoming") return -E.BADF;
    // a socket end crossing to another realm has one taker
    const socket = crossingOf(descriptor.fd);
    if (!socket && !isPorted(descriptor.file)) { descriptor.state = "open"; return descriptor; }
    session.descriptors.delete(token);
    closeFd(descriptor.fd);
    return socket ?? -E.BADF;
  }
  /** fsync, and then the storage under the file system */
  private async synced(fd: number): Promise<number> {
    const result = await syncFd(fd);
    if (result === 0) await vfs.flush();
    return result;
  }

  /** a session's requests; once it ends its tables are empty, and nothing new enters them */
  private calls(s: Session): DescriptorCalls {
    /** `operation` on the session's descriptor `fd`, after those queued on its open file */
    const on = <R>(fd: number, operation: (descriptor: Descriptor) => R | Promise<R>) => this.inOrder(s, s.descriptors.get(fd), operation);
    const stage = (right: number | CrossingSocket) => typeof right === "number" ? on(right, descriptor => this.stageFd(s, descriptor.fd)) : this.adopt(s, right);
    /** what the process takes: an open file the kernel keeps, named by its token */
    const taken = (token: number, right: Descriptor | CrossingSocket | number): number | TakenRight => typeof right === "number" || "port" in right ? right :
      { token, path: localFdStat(right.fd)?.path ?? "", flags: right.file.statusFlags, dir: right.file.dir };
    return {
      ashmemCreate: async size => {
        if (s.dead) return -E.BADF;
        if (!Number.isSafeInteger(size) || size <= 0 || size > 0x7fffffff) return -E.INVAL;
        let fd: number;
        try { fd = regionFd(size); }
        catch { return -E.NOMEM; }
        return this.put(s,fd);
      },
      open: async (requested, flags) => {
        if (s.dead) return -E.BADF;
        const path = vfs.norm(requested);
        const denied = s.authorize(path, !!(flags & (O_ACCMODE | O_CREAT | O_TRUNC)));
        if (denied) return -denied;
        const fifo = fifoOf(vfs.open(path));
        if (fifo) {
          if (!holdFifo(fifo, s.pid)) return -E.NXIO;
          s.fifos.add(fifo);
          return "fifo";
        }
        const existed = vfs.exists(path), fd = localOpen(path,flags);
        if (fd >= 0 && !existed && s.uid !== undefined) vfs.setAttributes(path,{uid:s.uid,gid:s.uid});
        const dir = fd >= 0 && openFd(fd)!.dir, token = this.put(s,fd);
        return token < 0 ? token : {token,dir};
      },
      read: async (fd, length, offset) => on(fd, async descriptor => {
        if (!Number.isSafeInteger(length) || length < 0) return -E.INVAL;
        const target = new Uint8Array(length), n = await (offset === undefined ? readFd(descriptor.fd,target,length) : preadFd(descriptor.fd,target,length,offset));
        return n < 0 ? n : target.slice(0,n);
      }),
      write: async (fd, bytes, offset) => on(fd, descriptor => offset === undefined ? writeFd(descriptor.fd,bytes) : pwriteFd(descriptor.fd,bytes,offset)),
      seek: async (fd, offset, whence) => on(fd, descriptor => seekFd(descriptor.fd,offset,whence)),
      truncate: async (fd, length) => on(fd, descriptor => truncateFd(descriptor.fd,length)),
      allocate: async (fd, offset, length) => on(fd, descriptor => allocateFd(descriptor.fd,offset,length)),
      fcntl: async (fd, command, arg) => on(fd, descriptor => command >= 1 && command <= 4 ? fcntlFd(descriptor.fd,command,arg) : -E.INVAL),
      stat: async fd => on(fd, descriptor => localFdStat(descriptor.fd) ?? -E.BADF),
      sync: async fd => on(fd, descriptor => this.synced(descriptor.fd)),
      close: async fd => this.retire(s, fd, false),
      unstage: async fd => this.retire(s, fd, true),
      stage: async right => stage(right),
      take: async fd => taken(fd, this.take(s, fd)),
      park: async right => this.park(s, stage(right)),
      claim: async ticket => {
        const token = await this.claim(s, ticket);
        return token < 0 ? token : taken(token, this.take(s, token));
      },
      changeAttributes: async (fd, change) => on(fd, descriptor => changeFdAttributes(descriptor.fd, change, s.uid)),
      ioctl: async (fd, request, arg) => on(fd, descriptor => ioctlIntFd(descriptor.fd, request, arg)),
      mappingAcquire: async (fd, offset, length, prot) => on(fd, ({fd: local, file}) => {
        const mode = file.statusFlags & O_ACCMODE;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset + length) || !Number.isInteger(prot) || prot < 0 || prot > 7) return -E.INVAL;
        if (mode === 1 || prot & 2 && mode !== 2) return -E.ACCES;
        const ashmem = regionOf(file);
        if (ashmem && prot & ~ashmem.prot) return -E.PERM;
        if (offset + length > file.content.len) return -E.NOTSUP;
        const retained = dupFd(local,true);
        if (retained < 0) return retained;
        detachFdScope(retained);
        const lease = this.next++;
        s.mappings.set(lease,{fd:retained,file,offset,length,prot});
        let region = this.regions.get(file.content);
        if (region === undefined) this.regions.set(file.content,region = this.nextRegion++);
        // what the file holds cannot change, so the process may page it in once (jmemory.ts Region)
        return {lease,region,immutable:!(prot & 2) && !ashmem && !!file.content.source && !writable(file.content.source),pool:ashmem?.pool};
      }),
      mappingRead: async (lease, offset, length) => this.inOrder(s, s.mappings.get(lease), async mapping => {
        const error = rangeError(mapping, offset, length, 1);
        if (error) return -error;
        const target = new Uint8Array(length), n = await preadFd(mapping.fd,target,length,mapping.offset + offset);
        return n < 0 ? n : target.slice(0,n);
      }),
      mappingWrite: async (lease, offset, bytes) => this.inOrder(s, s.mappings.get(lease), mapping => {
        const error = rangeError(mapping, offset, bytes.length, 2);
        return error ? -error : pwriteFd(mapping.fd,bytes,mapping.offset + offset);
      }),
      mappingRelease: async lease => {
        const mapping = s.mappings.get(lease);
        if (!mapping) return -E.BADF;
        s.mappings.delete(lease);
        return this.ordered(mapping.file, async () => { await closeFd(mapping.fd); return 0; });
      },
    };
  }

  /** A serialized transaction can consume only the sender's staged reference. The
   * driver's bound sender/receiver IDs, rather than wire-supplied PIDs, choose the tables. */
  async receive(from: number, token: number, to: number): Promise<number> {
    const source = this.sessions.get(from), target = this.sessions.get(to), descriptor = source?.descriptors.get(token);
    if (!source || source.dead || !target || target.dead || descriptor?.state !== "staged") return -E.BADF;
    source.descriptors.delete(token);
    return this.ordered(descriptor.file, () => {
      try { return source.dead || target.dead ? -E.BADF : this.put(target,dupFd(descriptor.fd,true),"incoming"); }
      finally { closeFd(descriptor.fd); }
    });
  }

  /** process `pid`'s rights, which this kernel holds for it: the page's own, whose descriptors are the kernel's */
  rights(pid: number): DescriptorRights {
    const live = () => { const session = this.sessions.get(pid); return session && !session.dead ? session : null; };
    const take = (session: Session, token: number) => {
      const right = this.take(session, token);
      if (typeof right === "number") return right;
      if ("port" in right) return importSocket(right);
      session.descriptors.delete(token);
      return right.fd;
    };
    return {
      stage: fd => { const session = live(); return session ? this.stageFd(session, fd) : -E.BADF; },
      take: token => { const session = live(); return session ? take(session, token) : -E.BADF; },
      discard: (token, staged) => this.discard(pid, token, staged),
      park: fd => { const session = live(); return session ? this.park(session, this.stageFd(session, fd)) : -E.BADF; },
      claim: async ticket => {
        const session = live();
        if (!session) return -E.BADF;
        const token = await this.claim(session, ticket);
        return token < 0 ? token : take(session, token);
      },
    };
  }
  async discard(pid: number, token: number, staged: boolean): Promise<number> {
    const session = this.sessions.get(pid);
    if (!session || session.dead || !staged && session.descriptors.get(token)?.state !== "incoming") return -E.BADF;
    return this.retire(session, token, staged);
  }

  close(pid: number): void {
    const session = this.sessions.get(pid);
    if (!session) return;
    this.sessions.delete(pid); session.dead = true;
    for (const fifo of session.fifos) fifo.holder = undefined;
    for (const table of [session.descriptors,session.mappings]) {
      for (const resource of table.values())
        void this.ordered(resource.file, () => closeFd(resource.fd)).catch(error => console.error("[descriptor cleanup]",error));
      table.clear();
    }
  }
}
