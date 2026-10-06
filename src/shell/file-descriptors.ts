import { E } from "../native/abi";
import { javaCloseFd, javaDupFd, javaFcntlFd, javaFdStat, javaOpenFd, javaPreadFd, javaPwriteFd,
  javaReadFd, javaSeekFd, javaSyncFd, javaTruncateFd, javaWriteFd, openFd, O_ACCMODE, O_CREAT, O_TRUNC,
  type OpenFile } from "../native/fs";
import { vfs } from "./vfs";

export type DescriptorRequest = { kind: "open"; path: string; flags: number }
  | { kind: "read"; fd: number; length: number }
  | { kind: "pread"; fd: number; length: number; offset: number }
  | { kind: "write"; fd: number; bytes: Uint8Array }
  | { kind: "pwrite"; fd: number; bytes: Uint8Array; offset: number }
  | { kind: "seek"; fd: number; offset: number; whence: number }
  | { kind: "truncate"; fd: number; length: number }
  | { kind: "fcntl"; fd: number; command: number; arg: number }
  | { kind: "dup"; fd: number; cloexec: boolean }
  | { kind: "stat" | "sync" | "close"; fd: number };
export type DescriptorReply = { result: number; bytes?: Uint8Array; stat?: NonNullable<ReturnType<typeof javaFdStat>> };
export type DescriptorCalls = { fileDescriptor(request: DescriptorRequest): Promise<DescriptorReply> };
type Descriptor = { fd: number; file: OpenFile };
type Session = { dead: boolean; descriptors: Map<number, Descriptor>; authorize(path: string, write: boolean): number };

/** The page's kernel owns open files; process tokens never expose its descriptor numbers.
 * Duplication retains that open file (including position/status flags), rather than reopening
 * a path or copying bytes. Mapping transport is a separate kernel operation. */
export class FileDescriptors {
  private next = 1;
  private sessions = new Map<number, Session>();
  private queues = new WeakMap<OpenFile, Promise<void>>();

  session(pid: number, authorize: Session["authorize"]): DescriptorCalls {
    let session = this.sessions.get(pid);
    if (!session) this.sessions.set(pid, session = {dead:false, descriptors:new Map(), authorize});
    const owner = session;
    return {fileDescriptor: request => this.dispatch(owner, request)};
  }

  private put(session: Session, fd: number): number {
    if (fd < 0) return fd;
    const file = openFd(fd)!;
    // Pipes/sockets must not wait behind their own blocking read. They require their
    // existing independent readiness protocol, not this regular-file operation queue.
    if ((javaFdStat(fd)!.mode & 0xf000) !== 0x8000) { javaCloseFd(fd); return -E.NOTSUP; }
    const token = this.next++;
    session.descriptors.set(token, {fd,file});
    return token;
  }

  private ordered<T>(file: OpenFile, operation: () => T | Promise<T>): Promise<T> {
    const pending = (this.queues.get(file) ?? Promise.resolve()).then(operation);
    this.queues.set(file, pending.then(() => {}, () => {}));
    return pending;
  }

  private async dispatch(session: Session, request: DescriptorRequest): Promise<DescriptorReply> {
    if (session.dead) return {result:-E.BADF};
    if (request.kind === "open") {
      const path = vfs.norm(request.path);
      const denied = session.authorize(path, !!(request.flags & (O_ACCMODE | O_CREAT | O_TRUNC)));
      return {result: denied ? -denied : this.put(session, javaOpenFd(path,request.flags))};
    }
    const descriptor = session.descriptors.get(request.fd);
    if (!descriptor) return {result:-E.BADF};
    // Retire the public token at dispatch. Already-dispatched operations still own
    // their descriptor until the ordered close, preventing reuse during an async read.
    if (request.kind === "close") session.descriptors.delete(request.fd);
    const bytes = "bytes" in request ? request.bytes.slice() : undefined;
    return this.ordered(descriptor.file, async () => {
      const fd = descriptor.fd;
      if (request.kind === "close") return {result:javaCloseFd(fd)};
      if (session.dead) return {result:-E.BADF};
      let reply: DescriptorReply;
      switch (request.kind) {
        case "read": case "pread": {
          if (!Number.isSafeInteger(request.length) || request.length < 0) return {result:-E.INVAL};
          const target = new Uint8Array(request.length);
          const result = request.kind === "read" ? await javaReadFd(fd,target) : await javaPreadFd(fd,target,request.offset);
          reply = {result, ...(result >= 0 ? {bytes:target.slice(0,result)} : {})}; break;
        }
        case "write": reply = {result:javaWriteFd(fd,bytes!)}; break;
        case "pwrite": reply = {result:javaPwriteFd(fd,bytes!,request.offset)}; break;
        case "seek": reply = {result:javaSeekFd(fd,request.offset,request.whence)}; break;
        case "truncate": reply = {result:javaTruncateFd(fd,request.length)}; break;
        case "sync": {
          const result = javaSyncFd(fd);
          if (result === 0) await vfs.flush();
          reply = {result}; break;
        }
        case "stat": { const stat = javaFdStat(fd); reply = stat ? {result:0,stat} : {result:-E.BADF}; break; }
        case "dup": reply = {result:this.put(session, request.cloexec ? javaFcntlFd(fd,0x406,0) : javaDupFd(fd))}; break;
        case "fcntl": reply = {result:request.command >= 1 && request.command <= 4 ? javaFcntlFd(fd,request.command,request.arg) : -E.INVAL}; break;
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

  close(pid: number): void {
    const session = this.sessions.get(pid);
    if (!session) return;
    this.sessions.delete(pid); session.dead = true;
    for (const descriptor of session.descriptors.values())
      void this.ordered(descriptor.file, () => javaCloseFd(descriptor.fd)).catch(error => console.error("[descriptor cleanup]",error));
    session.descriptors.clear();
  }
}
