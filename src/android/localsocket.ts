// android_net_LocalSocketImpl.cpp: LocalSocket's AF_UNIX descriptors are the kernel's (native/fs.ts),
// so a LocalServerSocket's name is reachable from native code too. A name's namespace makes its
// sockaddr_un path: ABSTRACT leads with NUL, RESERVED is under /dev/socket, FILESYSTEM is the path.
import { rt, type JObj } from "../jvm/runtime";
import { newObj } from "../jvm/natives/jlang";
import { fdInt } from "../jvm/natives/jio";
import { u8 } from "../jvm/abi";
import { ERRSTR } from "../native/abi";
import { javaReadFd, javaWriteFd, unixBind } from "../native/fs";
import { unixConnectPath } from "../native/unix";
import { PROCESS_PID, PROCESS_UID } from "./os";

const pathOf = (name: string, namespace: number) => namespace === 0 ? "\0" + name : namespace === 1 ? "/dev/socket/" + name : name;
/** jniThrowIOException: the errno's text */
const ioResult = (r: number): number => { if (r < 0) throw rt.mkThrowable("java/io/IOException", ERRSTR[-r] ?? "Unknown error " + -r); return r; };
const read = (fd: JObj | null, target: Uint8Array, done: (n: number) => number): number | Promise<number> => {
  const r = javaReadFd(fdInt(fd), target);
  return r instanceof Promise ? r.then((n) => done(ioResult(n))) : done(ioResult(r));
};
const write = (fd: JObj | null, bytes: Uint8Array) => { for (let at = 0; at < bytes.length;) at += ioResult(javaWriteFd(fdInt(fd), bytes.subarray(at))); };
rt.registerJnis("android/net/LocalSocketImpl", {
  "connectLocal(Ljava/io/FileDescriptor;Ljava/lang/String;I)V": (fd: JObj | null, name: string, namespace: number) => { ioResult(unixConnectPath(fdInt(fd), pathOf(name, namespace))); },
  "bindLocal(Ljava/io/FileDescriptor;Ljava/lang/String;I)V": (fd: JObj | null, name: string, namespace: number) => { ioResult(unixBind(fdInt(fd), pathOf(name, namespace))); },
  // end of stream is -1
  "read_native(Ljava/io/FileDescriptor;)I": (fd: JObj | null) => { const b = new Uint8Array(1); return read(fd, b, (n) => n ? b[0] : -1); },
  "readba_native([BIILjava/io/FileDescriptor;)I": (b: Int8Array, off: number, len: number, fd: JObj | null) =>
    len ? read(fd, u8(b, off, len), (n) => n || -1) : 0,
  "write_native(ILjava/io/FileDescriptor;)V": (b: number, fd: JObj | null) => write(fd, Uint8Array.of(b)),
  "writeba_native([BIILjava/io/FileDescriptor;)V": (b: Int8Array, off: number, len: number, fd: JObj | null) => write(fd, u8(b, off, len).slice()),
  // both ends are this process
  "getPeerCredentials_native(Ljava/io/FileDescriptor;)Landroid/net/Credentials;": () =>
    newObj("android/net/Credentials", "(III)V", PROCESS_PID, PROCESS_UID, PROCESS_UID),
});
