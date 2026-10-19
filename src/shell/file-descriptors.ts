import { E } from "../native/abi.ts";
import { javaCloseFd, javaDupFd, javaFcntlFd, localFdStat, javaOpenFd, javaPreadFd, javaPwriteFd,
  javaReadFd, javaLseekFd, javaSyncFd, javaTruncateFd, javaAllocateFd, javaWriteFd, openFd, O_ACCMODE, O_CREAT, O_TRUNC,
  detachFdScope, fdBase, installFile, S_IFDIR, S_IFIFO, S_IFREG, type FdStat, type OpenFile } from "../native/fs.ts";
import { isFifo } from "../native/pipe.ts";
import { vfs, type VfsFile } from "./vfs.ts";
import { writable } from "./lazyfile.ts";

export type DescriptorRequest = { kind: "ashmemCreate"; size: number }
  | { kind: "ashmemProtect"; fd: number; prot: number }
  | { kind: "open"; path: string; flags: number }
  | { kind: "read"; fd: number; length: number }
  | { kind: "pread"; fd: number; length: number; offset: number }
  | { kind: "write"; fd: number; bytes: Uint8Array }
  | { kind: "pwrite"; fd: number; bytes: Uint8Array; offset: number }
  | { kind: "seek"; fd: number; offset: number; whence: number }
  | { kind: "truncate"; fd: number; length: number }
  | { kind: "allocate"; fd: number; offset: number; length: number }
  | { kind: "fcntl"; fd: number; command: number; arg: number }
  | { kind: "dup"; fd: number; cloexec: boolean }
  | { kind: "stage" | "unstage"; fd: number }
  | { kind: "take"; fd: number }
  | { kind: "mappingAcquire"; fd: number; offset: number; length: number; prot: number }
  | { kind: "mappingRead"; fd: number; offset: number; length: number }
  | { kind: "mappingWrite"; fd: number; offset: number; bytes: Uint8Array }
  | { kind: "mappingRelease"; fd: number }
  | { kind: "mappingSync"; fd: number }
  | { kind: "stat" | "sync" | "close"; fd: number };
/** `type`: an open's file type (S_IFMT bits) */
export type DescriptorReply = { result: number; type?: number; bytes?: Uint8Array; stat?: FdStat; ashmemProt?: number;
  mapping?: { region: number; offset: number; length: number; prot: number; immutable: boolean } };
export type DescriptorCalls = { fileDescriptor(request: DescriptorRequest): Promise<DescriptorReply> };
type Descriptor = { fd: number; file: OpenFile; staged?: boolean; incoming?: boolean };
type Mapping = { fd: number; file: OpenFile; offset: number; length: number; prot: number };
type Session = { dead: boolean; descriptors: Map<number, Descriptor>; mappings: Map<number, Mapping>; authorize(path: string, write: boolean): number; uid?: number };
export type RetainedDescriptor = { readonly fd:number; readonly file:OpenFile; closed:boolean; closing?:Promise<void> };

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

  session(pid: number, authorize: Session["authorize"], uid?: number): DescriptorCalls {
    let session = this.sessions.get(pid);
    if (!session) this.sessions.set(pid, session = {dead:false, descriptors:new Map(), mappings:new Map(), authorize,uid});
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
    if (!file.dir && (localFdStat(fd)!.mode & 0xf000) !== 0x8000) { javaCloseFd(fd); return -E.NOTSUP; }
    const token = this.next++;
    session.descriptors.set(token, {fd,file});
    return token;
  }

  private ordered<T>(file: OpenFile, operation: () => T | Promise<T>): Promise<T> {
    const pending = (this.queues.get(file.content) ?? Promise.resolve()).then(operation);
    this.queues.set(file.content, pending.then(() => {}, () => {}));
    return pending;
  }

  private async dispatch(session: Session, request: DescriptorRequest): Promise<DescriptorReply> {
    if (session.dead) return {result:-E.BADF};
    if (request.kind === "ashmemCreate") {
      if (!Number.isSafeInteger(request.size) || request.size <= 0 || request.size > 0x7fffffff) return {result:-E.INVAL};
      const file = {...fdBase(""),write:true,statusFlags:2};
      try { file.content = {path:null,data:new Uint8Array(request.size),len:request.size,ashmem:{prot:7}}; }
      catch { return {result:-E.NOMEM}; }
      return {result:this.put(session,installFile(file,true))};
    }
    if (request.kind === "mappingRead" || request.kind === "mappingWrite" || request.kind === "mappingRelease" || request.kind === "mappingSync") {
      const mapping = session.mappings.get(request.fd);
      if (!mapping) return {result:-E.BADF};
      if (request.kind === "mappingRelease") session.mappings.delete(request.fd);
      const bytes = request.kind === "mappingWrite" ? request.bytes.slice() : undefined;
      return this.ordered(mapping.file, async () => {
        if (request.kind === "mappingRelease") { javaCloseFd(mapping.fd); return {result:0}; }
        if (session.dead) return {result:-E.BADF};
        if (request.kind === "mappingSync") {
          const result = await javaSyncFd(mapping.fd);
          if (!result) await vfs.flush();
          return {result};
        }
        const length = request.kind === "mappingRead" ? request.length : bytes!.length;
        if (!Number.isSafeInteger(request.offset) || request.offset < 0 || !Number.isSafeInteger(length) || length < 0 || request.offset > mapping.length - length) return {result:-E.INVAL};
        if (!(mapping.prot & (request.kind === "mappingRead" ? 1 : 2))) return {result:-E.ACCES};
        // This is a live file-range lease, not a guest mmap bridge. EOF/page-cache
        // tails and raw cross-process loads need the separate shared-memory design.
        if (mapping.offset + request.offset + length > mapping.file.content.len) return {result:-E.NOTSUP};
        if (request.kind === "mappingWrite") return {result:await javaPwriteFd(mapping.fd,bytes!,mapping.offset + request.offset)};
        const target = new Uint8Array(length), result = await javaPreadFd(mapping.fd,target,mapping.offset + request.offset);
        return session.dead ? {result:-E.BADF} : {result,...(result >= 0 ? {bytes:target.slice(0,result)} : {})};
      });
    }
    if (request.kind === "open") {
      const path = vfs.norm(request.path);
      const denied = session.authorize(path, !!(request.flags & (O_ACCMODE | O_CREAT | O_TRUNC)));
      if (denied) return {result:-denied};
      // the name only: a process keeps its own pipe behind it
      if (isFifo(path)) return {result:0,type:S_IFIFO};
      const existed = vfs.exists(path), fd = javaOpenFd(path,request.flags);
      if (fd >= 0 && !existed && session.uid !== undefined) vfs.setAttributes(path,{uid:session.uid,gid:session.uid});
      const result = this.put(session,fd);
      return {result,type:result >= 0 && openFd(fd)!.dir ? S_IFDIR : S_IFREG};
    }
    const descriptor = session.descriptors.get(request.fd);
    if (!descriptor) return {result:-E.BADF};
    if (request.kind === "take") {
      if (!descriptor.incoming) return {result:-E.BADF};
      descriptor.incoming = false;
      return {result:0};
    }
    if (request.kind === "unstage" && !descriptor.staged) return {result:-E.BADF};
    // Retire the public token at dispatch. Already-dispatched operations still own
    // their descriptor until the ordered close, preventing reuse during an async read.
    if (request.kind === "close" || request.kind === "unstage") session.descriptors.delete(request.fd);
    const bytes = "bytes" in request ? request.bytes.slice() : undefined;
    const operation = request;
    return this.ordered(descriptor.file, async () => {
      const fd = descriptor.fd;
      if (operation.kind === "close" || operation.kind === "unstage") return {result:await javaCloseFd(fd)};
      if (session.dead) return {result:-E.BADF};
      let reply: DescriptorReply;
      switch (operation.kind) {
        case "ashmemProtect": {
          const region = descriptor.file.content.ashmem;
          if (!region) return {result:-E.NOTTY};
          if (!Number.isInteger(operation.prot) || operation.prot < 0 || operation.prot & ~region.prot) return {result:-E.INVAL};
          region.prot = operation.prot; reply = {result:0}; break;
        }
        case "mappingAcquire": {
          const {offset,length,prot} = operation, file = descriptor.file, mode = file.statusFlags & O_ACCMODE;
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset + length) || !Number.isInteger(prot) || prot < 0 || prot > 7) return {result:-E.INVAL};
          if (mode === 1 || prot & 2 && mode !== 2) return {result:-E.ACCES};
          if (prot & ~(file.content.ashmem?.prot ?? 7)) return {result:-E.PERM};
          if (offset + length > file.content.len) return {result:-E.NOTSUP};
          const retained = javaDupFd(fd,true);
          if (retained < 0) return {result:retained};
          detachFdScope(retained);
          const token = this.next++;
          session.mappings.set(token,{fd:retained,file,offset,length,prot});
          let region = this.regions.get(file.content);
          if (region === undefined) this.regions.set(file.content,region = this.nextRegion++);
          // what the file holds cannot change, so the process may page it in once (jmemory.ts Region)
          const immutable = !(prot & 2) && !file.content.ashmem && !!file.content.source && !writable(file.content.source);
          reply = {result:token,mapping:{region,offset,length,prot,immutable}}; break;
        }
        case "read": case "pread": {
          if (!Number.isSafeInteger(operation.length) || operation.length < 0) return {result:-E.INVAL};
          const target = new Uint8Array(operation.length);
          const result = operation.kind === "read" ? await javaReadFd(fd,target) : await javaPreadFd(fd,target,operation.offset);
          reply = {result, ...(result >= 0 ? {bytes:target.slice(0,result)} : {})}; break;
        }
        case "write": reply = {result:await javaWriteFd(fd,bytes!)}; break;
        case "pwrite": reply = {result:await javaPwriteFd(fd,bytes!,operation.offset)}; break;
        case "seek": reply = {result:await javaLseekFd(fd,operation.offset,operation.whence)}; break;
        case "truncate": reply = {result:await javaTruncateFd(fd,operation.length)}; break;
        case "allocate": reply = {result:await javaAllocateFd(fd,operation.offset,operation.length)}; break;
        case "sync": {
          const result = await javaSyncFd(fd);
          if (result === 0) await vfs.flush();
          reply = {result}; break;
        }
        case "stat": { const stat = localFdStat(fd); reply = stat ? {result:0,stat,ashmemProt:descriptor.file.content.ashmem?.prot} : {result:-E.BADF}; break; }
        case "dup": reply = {result:this.put(session,javaDupFd(fd,operation.cloexec))}; break;
        case "stage": {
          const token = this.put(session,javaDupFd(fd));
          if (token >= 0) session.descriptors.get(token)!.staged = true;
          reply = {result:token}; break;
        }
        case "fcntl": reply = {result:operation.command >= 1 && operation.command <= 4 ? await javaFcntlFd(fd,operation.command,operation.arg) : -E.INVAL}; break;
      }
      return session.dead ? {result:-E.BADF} : reply;
    });
  }

  /** Only an owning broker may grant an FD to another PID. A recipient's path authority
   * does not apply to an explicitly passed descriptor; its access mode still does. */
  async duplicateTo(from: number, token: number, to: number): Promise<number> {
    const source = this.sessions.get(from), target = this.sessions.get(to), descriptor = source?.descriptors.get(token);
    if (!source || source.dead || !target || target.dead || !descriptor) return -E.BADF;
    return this.ordered(descriptor.file, () => source.dead || target.dead ? -E.BADF : this.put(target,javaDupFd(descriptor.fd)));
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

  stageLocal(pid: number, fd: number): number {
    const session = this.sessions.get(pid);
    if (!session || session.dead) return -E.BADF;
    const token = this.put(session,javaDupFd(fd));
    if (token >= 0) session.descriptors.get(token)!.staged = true;
    return token;
  }
  takeLocal(pid: number, token: number): number {
    const session = this.sessions.get(pid), descriptor = session?.descriptors.get(token);
    if (!session || session.dead || !descriptor || descriptor.staged) return -E.BADF;
    session.descriptors.delete(token);
    return descriptor.fd;
  }
  async discard(pid: number, token: number, staged: boolean): Promise<number> {
    const session = this.sessions.get(pid);
    if (!session || !staged && !session.descriptors.get(token)?.incoming) return -E.BADF;
    return (await this.dispatch(session,{kind:staged ? "unstage" : "close",fd:token})).result;
  }

  close(pid: number): void {
    const session = this.sessions.get(pid);
    if (!session) return;
    this.sessions.delete(pid); session.dead = true;
    for (const table of [session.descriptors,session.mappings]) {
      for (const resource of table.values())
        void this.ordered(resource.file, () => javaCloseFd(resource.fd)).catch(error => console.error("[descriptor cleanup]",error));
      table.clear();
    }
  }
}
