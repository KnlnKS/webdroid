import { E, O_ACCMODE, O_CREAT, O_TRUNC, S_IFMT, S_IFREG } from "../native/abi.ts";
import { javaCloseFd, javaDupFd, javaFcntlFd, localFdStat, javaPreadFd, javaPwriteFd, javaReadFd, javaLseekFd, javaSyncFd,
  javaTruncateFd, javaAllocateFd, javaWriteFd, openFd, javaChangeFdAttributes, type FdStat, type OpenFile } from "../native/fd.ts";
import { javaAnonymousFd, javaOpenFd } from "../native/fs.ts";
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
  stat(fd: number): Promise<number | FdStat & { ashmemProt?: number }>;
  sync(fd: number): Promise<number>;
  close(fd: number): Promise<number>;
  stage(fd: number): Promise<number>;
  unstage(fd: number): Promise<number>;
  take(fd: number): Promise<number>;
  ashmemProtect(fd: number, prot: number): Promise<number>;
  changeAttributes(fd: number, change: AttributeChange): Promise<number>;
  /** a lease on a range of the open file; `region` names the file, and an immutable one's bytes cannot change */
  mappingAcquire(fd: number, offset: number, length: number, prot: number): Promise<number | { lease: number; region: number; immutable: boolean }>;
  mappingRead(lease: number, offset: number, length: number): Promise<number | Uint8Array>;
  mappingWrite(lease: number, offset: number, bytes: Uint8Array): Promise<number>;
  mappingRelease(lease: number): Promise<number>;
};
/** What a realm does with a Parcel's descriptor rights: stages one of its descriptors for another process, takes a right
 *  sent to it as a descriptor of its own, and discards one it staged (`staged`) or received and will not take. */
export type DescriptorRights = {
  stage(fd: number): number | Promise<number> | null;
  take(token: number): number | Promise<number>;
  discard(token: number, staged: boolean): Promise<number>;
};
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
      if (session.dead) {javaCloseFd(descriptor.fd);return null;}
      return {fd:descriptor.fd,file:descriptor.file,closed:false};
    });
  }
  async replay(right:RetainedDescriptor,pid:number): Promise<number> {
    const target=this.sessions.get(pid);
    if (!target || target.dead || right.closed) return -E.BADF;
    return this.ordered(right.file,()=>{
      if (right.closed || target.dead) return -E.BADF;
      const token=this.put(target,javaDupFd(right.fd,true));
      if (token >= 0) target.descriptors.get(token)!.incoming=true;
      return token;
    });
  }
  release(right:RetainedDescriptor): Promise<void> {
    if (right.closing) return right.closing;
    right.closed=true;
    return right.closing=this.ordered(right.file,()=>{javaCloseFd(right.fd);});
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

  private put(session: Session, fd: number): number {
    if (fd < 0) return fd;
    detachFdScope(fd);
    const file = openFd(fd)!;
    // Pipes/sockets must not wait behind their own blocking read. They require their
    // existing independent readiness protocol, not this regular-file operation queue.
    if (!file.dir && (localFdStat(fd)!.mode & S_IFMT) !== S_IFREG) { javaCloseFd(fd); return -E.NOTSUP; }
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
    return this.ordered(descriptor.file, () => javaCloseFd(descriptor.fd));
  }
  private stageIn(session: Session, fd: number): number {
    const token = this.put(session,javaDupFd(fd));
    if (token >= 0) session.descriptors.get(token)!.staged = true;
    return token;
  }
  /** fsync, and then the storage under the file system */
  private async synced(fd: number): Promise<number> {
    const result = await javaSyncFd(fd);
    if (result === 0) await vfs.flush();
    return result;
  }

  /** a session's requests; once it ends its tables are empty, and nothing new enters them */
  private calls(s: Session): DescriptorCalls {
    /** `operation` on the session's descriptor `fd`, after those queued on its open file */
    const on = <R>(fd: number, operation: (descriptor: Descriptor) => R | Promise<R>) => this.inOrder(s, s.descriptors.get(fd), operation);
    return {
      ashmemCreate: async size => {
        if (s.dead) return -E.BADF;
        if (!Number.isSafeInteger(size) || size <= 0 || size > 0x7fffffff) return -E.INVAL;
        let data: Uint8Array;
        try { data = new Uint8Array(size); }
        catch { return -E.NOMEM; }
        return this.put(s,javaAnonymousFd({path:null,data,len:size,ashmem:{prot:7}}));
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
        const existed = vfs.exists(path), fd = javaOpenFd(path,flags);
        if (fd >= 0 && !existed && s.uid !== undefined) vfs.setAttributes(path,{uid:s.uid,gid:s.uid});
        const dir = fd >= 0 && openFd(fd)!.dir, token = this.put(s,fd);
        return token < 0 ? token : {token,dir};
      },
      read: async (fd, length, offset) => on(fd, async descriptor => {
        if (!Number.isSafeInteger(length) || length < 0) return -E.INVAL;
        const target = new Uint8Array(length), n = await (offset === undefined ? javaReadFd(descriptor.fd,target) : javaPreadFd(descriptor.fd,target,offset));
        return n < 0 ? n : target.slice(0,n);
      }),
      write: async (fd, bytes, offset) => on(fd, descriptor => offset === undefined ? javaWriteFd(descriptor.fd,bytes) : javaPwriteFd(descriptor.fd,bytes,offset)),
      seek: async (fd, offset, whence) => on(fd, descriptor => javaLseekFd(descriptor.fd,offset,whence)),
      truncate: async (fd, length) => on(fd, descriptor => javaTruncateFd(descriptor.fd,length)),
      allocate: async (fd, offset, length) => on(fd, descriptor => javaAllocateFd(descriptor.fd,offset,length)),
      fcntl: async (fd, command, arg) => on(fd, descriptor => command >= 1 && command <= 4 ? javaFcntlFd(descriptor.fd,command,arg) : -E.INVAL),
      stat: async fd => on(fd, descriptor => {
        const stat = localFdStat(descriptor.fd);
        return stat ? {...stat,ashmemProt:descriptor.file.content.ashmem?.prot} : -E.BADF;
      }),
      sync: async fd => on(fd, descriptor => this.synced(descriptor.fd)),
      close: async fd => this.retire(s, fd, false),
      unstage: async fd => this.retire(s, fd, true),
      stage: async fd => on(fd, descriptor => this.stageIn(s, descriptor.fd)),
      take: async fd => {
        const descriptor = s.descriptors.get(fd);
        if (!descriptor?.incoming) return -E.BADF;
        descriptor.incoming = false;
        return 0;
      },
      changeAttributes: async (fd, change) => on(fd, descriptor => javaChangeFdAttributes(descriptor.fd, change, s.uid)),
      ashmemProtect: async (fd, prot) => on(fd, ({file}) => {
        const region = file.content.ashmem;
        if (!region) return -E.NOTTY;
        if (!Number.isInteger(prot) || prot < 0 || prot & ~region.prot) return -E.INVAL;
        region.prot = prot;
        return 0;
      }),
      mappingAcquire: async (fd, offset, length, prot) => on(fd, ({fd: local, file}) => {
        const mode = file.statusFlags & O_ACCMODE;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset + length) || !Number.isInteger(prot) || prot < 0 || prot > 7) return -E.INVAL;
        if (mode === 1 || prot & 2 && mode !== 2) return -E.ACCES;
        if (prot & ~(file.content.ashmem?.prot ?? 7)) return -E.PERM;
        if (offset + length > file.content.len) return -E.NOTSUP;
        const retained = javaDupFd(local,true);
        if (retained < 0) return retained;
        detachFdScope(retained);
        const lease = this.next++;
        s.mappings.set(lease,{fd:retained,file,offset,length,prot});
        let region = this.regions.get(file.content);
        if (region === undefined) this.regions.set(file.content,region = this.nextRegion++);
        // what the file holds cannot change, so the process may page it in once (jmemory.ts Region)
        return {lease,region,immutable:!(prot & 2) && !file.content.ashmem && !!file.content.source && !writable(file.content.source)};
      }),
      mappingRead: async (lease, offset, length) => this.inOrder(s, s.mappings.get(lease), async mapping => {
        const error = rangeError(mapping, offset, length, 1);
        if (error) return -error;
        const target = new Uint8Array(length), n = await javaPreadFd(mapping.fd,target,mapping.offset + offset);
        return n < 0 ? n : target.slice(0,n);
      }),
      mappingWrite: async (lease, offset, bytes) => this.inOrder(s, s.mappings.get(lease), mapping => {
        const error = rangeError(mapping, offset, bytes.length, 2);
        return error ? -error : javaPwriteFd(mapping.fd,bytes,mapping.offset + offset);
      }),
      mappingRelease: async lease => {
        const mapping = s.mappings.get(lease);
        if (!mapping) return -E.BADF;
        s.mappings.delete(lease);
        return this.ordered(mapping.file, async () => { await javaCloseFd(mapping.fd); return 0; });
      },
    };
  }

  /** A serialized transaction can consume only the sender's staged reference. The
   * driver's bound sender/receiver IDs, rather than wire-supplied PIDs, choose the tables. */
  async receive(from: number, token: number, to: number): Promise<number> {
    const source = this.sessions.get(from), target = this.sessions.get(to), descriptor = source?.descriptors.get(token);
    if (!source || source.dead || !target || target.dead || !descriptor?.staged) return -E.BADF;
    source.descriptors.delete(token);
    return this.ordered(descriptor.file, () => {
      try {
        if (source.dead || target.dead) return -E.BADF;
        const received = this.put(target,javaDupFd(descriptor.fd,true));
        if (received >= 0) target.descriptors.get(received)!.incoming = true;
        return received;
      }
      finally { javaCloseFd(descriptor.fd); }
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
        void this.ordered(resource.file, () => javaCloseFd(resource.fd)).catch(error => console.error("[descriptor cleanup]",error));
      table.clear();
    }
  }
}
