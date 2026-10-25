import { E, O_ACCMODE, O_CREAT, O_TRUNC, S_IFMT, S_IFREG } from "../native/abi.ts";
import { closeFd, dupFd, fcntlFd, localFdStat, preadFd, pwriteFd, readFd, seekFd, syncFd,
  truncateFd, allocateFd, writeFd, openFd, changeFdAttributes, type FdStat, type OpenFile } from "../native/fd.ts";
import { anonymousFd, localOpen } from "../native/fs.ts";
import { detachFdScope } from "../android/fd-scope.ts";
import type { AttributeChange } from "./file-path.ts";
import { fifoOf, holdFifo, type Pipe } from "../native/pipe.ts";
import { vfs, type VfsFile } from "./vfs.ts";
import { writable } from "./lazyfile.ts";
import { releaseRights, type ParcelData } from "../android/binder.ts";
import { rt } from "../jvm/runtime.ts";

/** each descriptor operation's request, and what it answers other than a number (a result or -errno) */
type Operations = {
  ashmemCreate: [{ size: number }, never];
  /** the process that holds a fifo keeps its own pipe behind its name */
  open: [{ path: string; flags: number }, { token: number; dir: boolean } | "fifo"];
  /** at the open file's position, or at `offset` without moving it */
  read: [{ fd: number; length: number; offset?: number }, Uint8Array];
  write: [{ fd: number; bytes: Uint8Array; offset?: number }, never];
  seek: [{ fd: number; offset: number; whence: number }, never];
  truncate: [{ fd: number; length: number }, never];
  allocate: [{ fd: number; offset: number; length: number }, never];
  fcntl: [{ fd: number; command: number; arg: number }, never];
  stat: [{ fd: number }, FdStat & { ashmemProt?: number }];
  sync: [{ fd: number }, never];
  close: [{ fd: number }, never];
  stage: [{ fd: number }, never];
  unstage: [{ fd: number }, never];
  take: [{ fd: number }, never];
  ashmemProtect: [{ fd: number; prot: number }, never];
  changeAttributes: [{ fd: number; change: AttributeChange }, never];
  /** a lease on a range of the open file; `region` names the file, and an immutable one's bytes cannot change */
  mappingAcquire: [{ fd: number; offset: number; length: number; prot: number }, { lease: number; region: number; immutable: boolean }];
  mappingRead: [{ lease: number; offset: number; length: number }, Uint8Array];
  mappingWrite: [{ lease: number; offset: number; bytes: Uint8Array }, never];
  mappingRelease: [{ lease: number }, never];
};
export type DescriptorKind = keyof Operations;
export type DescriptorRequest<K extends DescriptorKind = DescriptorKind> = { kind: K } & Operations[K][0];
export type DescriptorReply<K extends DescriptorKind> = number | Operations[K][1];
/** What a realm does with a Parcel's descriptor rights: stages one of its descriptors for another process, takes a right
 *  sent to it as a descriptor of its own, and discards one it staged (`staged`) or received and will not take. */
export type DescriptorRights = {
  stage(fd: number): number | Promise<number> | null;
  take(token: number): number | Promise<number>;
  discard(token: number, staged: boolean): Promise<number>;
};
export type DescriptorCalls = { fileDescriptor<K extends DescriptorKind>(request: DescriptorRequest<K>): Promise<DescriptorReply<K>> };
type Handlers = { [K in DescriptorKind]: (session: Session, request: DescriptorRequest<K>) => DescriptorReply<K> | Promise<DescriptorReply<K>> };
type Descriptor = { fd: number; file: OpenFile; staged?: boolean; incoming?: boolean };
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

  /** A stored Parcel owns this reference independently of the originating PID. */
  async retain(pid:number,token:number): Promise<RetainedDescriptor | null> {
    const session=this.sessions.get(pid),descriptor=session?.descriptors.get(token);
    if (!session || session.dead || !descriptor?.staged) return null;
    session.descriptors.delete(token);
    return this.ordered(descriptor.file,()=>{
      if (session.dead) {closeFd(descriptor.fd);return null;}
      return {fd:descriptor.fd,file:descriptor.file,closed:false};
    });
  }
  async replay(right:RetainedDescriptor,pid:number): Promise<number> {
    const target=this.sessions.get(pid);
    if (!target || target.dead || right.closed) return -E.BADF;
    return this.ordered(right.file,()=>{
      if (right.closed || target.dead) return -E.BADF;
      const token=this.put(target,dupFd(right.fd,true));
      if (token >= 0) target.descriptors.get(token)!.incoming=true;
      return token;
    });
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
    const owner = session;
    return {fileDescriptor: request => this.dispatch(owner, request)};
  }
  ensureReceiver(pid: number): void { if (!this.sessions.has(pid)) this.session(pid,()=>E.ACCES); }

  private put(session: Session, fd: number): number {
    if (fd < 0) return fd;
    detachFdScope(fd);
    const file = openFd(fd)!;
    // Pipes/sockets must not wait behind their own blocking read. They require their
    // existing independent readiness protocol, not this regular-file operation queue.
    if (!file.dir && (localFdStat(fd)!.mode & S_IFMT) !== S_IFREG) { closeFd(fd); return -E.NOTSUP; }
    const token = this.next++;
    session.descriptors.set(token, {fd,file});
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
    if (!descriptor || staged && !descriptor.staged) return -E.BADF;
    session.descriptors.delete(token);
    return this.ordered(descriptor.file, () => closeFd(descriptor.fd));
  }
  private stageIn(session: Session, fd: number): number {
    const token = this.put(session,dupFd(fd));
    if (token >= 0) session.descriptors.get(token)!.staged = true;
    return token;
  }
  /** fsync, and then the storage under the file system */
  private async synced(fd: number): Promise<number> {
    const result = await syncFd(fd);
    if (result === 0) await vfs.flush();
    return result;
  }

  private async dispatch<K extends DescriptorKind>(session: Session, request: DescriptorRequest<K>): Promise<DescriptorReply<K>> {
    return session.dead ? -E.BADF : this.handlers[request.kind](session, request);
  }
  private readonly handlers: Handlers = {
    ashmemCreate: (session, {size}) => {
      if (!Number.isSafeInteger(size) || size <= 0 || size > 0x7fffffff) return -E.INVAL;
      let data: Uint8Array;
      try { data = new Uint8Array(size); }
      catch { return -E.NOMEM; }
      return this.put(session,anonymousFd({path:null,data,len:size,ashmem:{prot:7}}));
    },
    open: (session, request) => {
      const path = vfs.norm(request.path), flags = request.flags;
      const denied = session.authorize(path, !!(flags & (O_ACCMODE | O_CREAT | O_TRUNC)));
      if (denied) return -denied;
      const fifo = fifoOf(vfs.open(path));
      if (fifo) {
        if (!holdFifo(fifo, session.pid)) return -E.NXIO;
        session.fifos.add(fifo);
        return "fifo";
      }
      const existed = vfs.exists(path), fd = localOpen(path,flags);
      if (fd >= 0 && !existed && session.uid !== undefined) vfs.setAttributes(path,{uid:session.uid,gid:session.uid});
      const dir = fd >= 0 && openFd(fd)!.dir, token = this.put(session,fd);
      return token < 0 ? token : {token,dir};
    },
    read: (session, {fd, length, offset}) => this.inOrder(session, session.descriptors.get(fd), async descriptor => {
      if (!Number.isSafeInteger(length) || length < 0) return -E.INVAL;
      const target = new Uint8Array(length), n = await (offset === undefined ? readFd(descriptor.fd,target,length) : preadFd(descriptor.fd,target,length,offset));
      return n < 0 ? n : target.slice(0,n);
    }),
    write: (session, {fd, bytes, offset}) => this.inOrder(session, session.descriptors.get(fd), descriptor =>
      offset === undefined ? writeFd(descriptor.fd,bytes) : pwriteFd(descriptor.fd,bytes,offset)),
    seek: (session, {fd, offset, whence}) => this.inOrder(session, session.descriptors.get(fd), descriptor => seekFd(descriptor.fd,offset,whence)),
    truncate: (session, {fd, length}) => this.inOrder(session, session.descriptors.get(fd), descriptor => truncateFd(descriptor.fd,length)),
    allocate: (session, {fd, offset, length}) => this.inOrder(session, session.descriptors.get(fd), descriptor => allocateFd(descriptor.fd,offset,length)),
    fcntl: (session, {fd, command, arg}) => this.inOrder(session, session.descriptors.get(fd), descriptor =>
      command >= 1 && command <= 4 ? fcntlFd(descriptor.fd,command,arg) : -E.INVAL),
    stat: (session, {fd}) => this.inOrder(session, session.descriptors.get(fd), descriptor => {
      const stat = localFdStat(descriptor.fd);
      return stat ? {...stat,ashmemProt:descriptor.file.content.ashmem?.prot} : -E.BADF;
    }),
    sync: (session, {fd}) => this.inOrder(session, session.descriptors.get(fd), descriptor => this.synced(descriptor.fd)),
    close: (session, {fd}) => this.retire(session, fd, false),
    unstage: (session, {fd}) => this.retire(session, fd, true),
    stage: (session, {fd}) => this.inOrder(session, session.descriptors.get(fd), descriptor => this.stageIn(session, descriptor.fd)),
    take: (session, {fd}) => {
      const descriptor = session.descriptors.get(fd);
      if (!descriptor?.incoming) return -E.BADF;
      descriptor.incoming = false;
      return 0;
    },
    changeAttributes: (session, {fd, change}) => this.inOrder(session, session.descriptors.get(fd), descriptor => changeFdAttributes(descriptor.fd, change, session.uid)),
    ashmemProtect: (session, {fd, prot}) => this.inOrder(session, session.descriptors.get(fd), ({file}) => {
      const region = file.content.ashmem;
      if (!region) return -E.NOTTY;
      if (!Number.isInteger(prot) || prot < 0 || prot & ~region.prot) return -E.INVAL;
      region.prot = prot;
      return 0;
    }),
    mappingAcquire: (session, {fd, offset, length, prot}) => this.inOrder(session, session.descriptors.get(fd), ({fd: local, file}) => {
      const mode = file.statusFlags & O_ACCMODE;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset + length) || !Number.isInteger(prot) || prot < 0 || prot > 7) return -E.INVAL;
      if (mode === 1 || prot & 2 && mode !== 2) return -E.ACCES;
      if (prot & ~(file.content.ashmem?.prot ?? 7)) return -E.PERM;
      if (offset + length > file.content.len) return -E.NOTSUP;
      const retained = dupFd(local,true);
      if (retained < 0) return retained;
      detachFdScope(retained);
      const lease = this.next++;
      session.mappings.set(lease,{fd:retained,file,offset,length,prot});
      let region = this.regions.get(file.content);
      if (region === undefined) this.regions.set(file.content,region = this.nextRegion++);
      // what the file holds cannot change, so the process may page it in once (jmemory.ts Region)
      return {lease,region,immutable:!(prot & 2) && !file.content.ashmem && !!file.content.source && !writable(file.content.source)};
    }),
    mappingRead: (session, {lease, offset, length}) => this.inOrder(session, session.mappings.get(lease), async mapping => {
      const error = rangeError(mapping, offset, length, 1);
      if (error) return -error;
      const target = new Uint8Array(length), n = await preadFd(mapping.fd,target,length,mapping.offset + offset);
      return n < 0 ? n : target.slice(0,n);
    }),
    mappingWrite: (session, {lease, offset, bytes}) => this.inOrder(session, session.mappings.get(lease), mapping => {
      const error = rangeError(mapping, offset, bytes.length, 2);
      return error ? -error : pwriteFd(mapping.fd,bytes,mapping.offset + offset);
    }),
    mappingRelease: (session, {lease}) => {
      const mapping = session.mappings.get(lease);
      if (!mapping) return -E.BADF;
      session.mappings.delete(lease);
      return this.ordered(mapping.file, async () => { await closeFd(mapping.fd); return 0; });
    },
  };

  /** A serialized transaction can consume only the sender's staged reference. The
   * driver's bound sender/receiver IDs, rather than wire-supplied PIDs, choose the tables. */
  async receive(from: number, token: number, to: number): Promise<number> {
    const source = this.sessions.get(from), target = this.sessions.get(to), descriptor = source?.descriptors.get(token);
    if (!source || source.dead || !target || target.dead || !descriptor?.staged) return -E.BADF;
    source.descriptors.delete(token);
    return this.ordered(descriptor.file, () => {
      try {
        if (source.dead || target.dead) return -E.BADF;
        const received = this.put(target,dupFd(descriptor.fd,true));
        if (received >= 0) target.descriptors.get(received)!.incoming = true;
        return received;
      }
      finally { closeFd(descriptor.fd); }
    });
  }

  /** process `pid`'s rights, which this kernel holds for it */
  rights(pid: number): DescriptorRights {
    return { stage: fd => this.stageLocal(pid, fd), take: token => this.takeLocal(pid, token), discard: (token, staged) => this.discard(pid, token, staged) };
  }
  stageLocal(pid: number, fd: number): number {
    const session = this.sessions.get(pid);
    return !session || session.dead ? -E.BADF : this.stageIn(session, fd);
  }
  takeLocal(pid: number, token: number): number {
    const session = this.sessions.get(pid), descriptor = session?.descriptors.get(token);
    if (!session || session.dead || !descriptor || descriptor.staged) return -E.BADF;
    session.descriptors.delete(token);
    return descriptor.fd;
  }
  async discard(pid: number, token: number, staged: boolean): Promise<number> {
    const session = this.sessions.get(pid);
    if (!session || session.dead || !staged && !session.descriptors.get(token)?.incoming) return -E.BADF;
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
