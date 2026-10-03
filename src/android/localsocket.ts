// android_net_LocalSocketImpl.cpp: LocalSocket's AF_UNIX descriptors are the kernel's (native/fs.ts),
// whose names native sockets and libcore's Os share. A name's namespace makes its sockaddr_un
// path: ABSTRACT leads with NUL, RESERVED is under /dev/socket, FILESYSTEM is the path. Reads and
// writes carry SCM_RIGHTS as its recvmsg/sendmsg do: what arrives with the bytes becomes
// inboundFileDescriptors, and outboundFileDescriptors goes with each write.
import { rt, type JObj, awaited, driven, getDeclared, setDeclared, type Gen } from "../jvm/runtime";
import { newObj } from "../jvm/natives/jlang";
import { fdInt, mkFd } from "../jvm/natives/jio";
import { jarray, u8 } from "../jvm/abi";
import { strerror } from "../native/abi";
import { unixBind, unixReceive, unixSend, unixPeerCredentials, installPassed, type Received } from "../native/fs";
import { unixConnectPath } from "../native/unix";

const IMPL = "android/net/LocalSocketImpl", FD = "Ljava/io/FileDescriptor;";
const pathOf = (name: string, namespace: number) => namespace === 0 ? "\0" + name : namespace === 1 ? "/dev/socket/" + name : name;
/** jniThrowIOException: the errno's text */
const ioResult = (r: number): number => { if (r < 0) throw rt.mkThrowable("java/io/IOException", strerror(-r)); return r; };
/** socket_read_all: recvmsg with MSG_CMSG_CLOEXEC; the descriptors that came with the bytes replace
 *  inboundFileDescriptors */
function* read(self: JObj, fd: JObj | null, target: Uint8Array): Gen<number> {
  const from: Received = { name: "", rights: [] };
  const n = ioResult(yield* awaited(unixReceive(fdInt(fd), target, 0, from)));
  if (from.rights!.length) {
    const received: JObj[] = [];
    for (const p of from.rights!) received.push(yield* awaited(mkFd(installPassed(p, true))));
    setDeclared(self, IMPL, { inboundFileDescriptors: jarray(received, FD) });
  }
  return n;
}
/** socket_write_all: outboundFileDescriptors go with the first sendmsg of every write */
function write(self: JObj, fd: JObj | null, bytes: Uint8Array): void {
  const outbound = getDeclared<JObj[] | null>(self, IMPL, "outboundFileDescriptors");
  ioResult(unixSend(fdInt(fd), bytes, null, outbound?.map(fdInt) ?? []));
}
rt.registerJnis(IMPL, {
  "connectLocal(Ljava/io/FileDescriptor;Ljava/lang/String;I)V": (fd: JObj | null, name: string, namespace: number) => { ioResult(unixConnectPath(fdInt(fd), pathOf(name, namespace))); },
  "bindLocal(Ljava/io/FileDescriptor;Ljava/lang/String;I)V": (fd: JObj | null, name: string, namespace: number) => { ioResult(unixBind(fdInt(fd), pathOf(name, namespace))); },
  // end of stream is -1
  "read_native(Ljava/io/FileDescriptor;)I": driven(function* (this: JObj, fd: JObj | null): Gen {
    const b = new Uint8Array(1);
    return (yield* read(this, fd, b)) ? b[0] : -1;
  }),
  "readba_native([BIILjava/io/FileDescriptor;)I": driven(function* (this: JObj, b: Int8Array, off: number, len: number, fd: JObj | null): Gen {
    return len ? (yield* read(this, fd, u8(b, off, len))) || -1 : 0;
  }),
  "write_native(ILjava/io/FileDescriptor;)V": function (this: JObj, b: number, fd: JObj | null) { write(this, fd, Uint8Array.of(b)); },
  "writeba_native([BIILjava/io/FileDescriptor;)V": function (this: JObj, b: Int8Array, off: number, len: number, fd: JObj | null) { write(this, fd, u8(b, off, len)); },
  "getPeerCredentials_native(Ljava/io/FileDescriptor;)Landroid/net/Credentials;": (fd: JObj | null) => {
    const c = unixPeerCredentials(fdInt(fd));
    if (typeof c === "number") return ioResult(c);
    return newObj("android/net/Credentials", "(III)V", c.pid, c.uid, c.gid);
  },
});
