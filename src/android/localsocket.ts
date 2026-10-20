// android_net_LocalSocketImpl.cpp: LocalSocket's AF_UNIX descriptors are the kernel's (native/socket/),
// whose names native sockets and libcore's Os share. A name's namespace makes its sockaddr_un
// path: ABSTRACT leads with NUL, RESERVED is under /dev/socket, FILESYSTEM is the path. Reads and
// writes carry SCM_RIGHTS as its recvmsg/sendmsg do: what arrives with the bytes becomes
// inboundFileDescriptors, and outboundFileDescriptors goes with each write.
import { rt, type JObj, awaited, driven, getDeclared, setDeclared, type Gen } from "../jvm/runtime.ts";
import { newObj, after } from "../jvm/natives/jentry.ts";
import { fdInt, mkFd } from "../jvm/natives/jio.ts";
import { jarray, u8 } from "../jvm/abi.ts";
import { strerror } from "../native/abi.ts";
import { installFile } from "../native/fd.ts";
import { socketOf } from "../native/socket/core.ts";
import { unixAddress } from "../native/socket/abi.ts";
import type { Socket } from "../native/socket/core.ts";
import { rightsMessage } from "../native/socket/unix.ts";

const IMPL = "android/net/LocalSocketImpl", FD = "Ljava/io/FileDescriptor;";
const pathOf = (name: string, namespace: number) => namespace === 0 ? "\0" + name : namespace === 1 ? "/dev/socket/" + name : name;
/** jniThrowIOException: the errno's text */
const ioResult = (r: number): number => { if (r < 0) throw rt.mkThrowable("java/io/IOException", strerror(-r)); return r; };
const socket = (fd: JObj | null): Socket => { const s = socketOf(fdInt(fd)); if (typeof s === "number") ioResult(s); return s as Socket; };
/** socket_read_all: recvmsg with MSG_CMSG_CLOEXEC; the descriptors that came with the bytes replace
 *  inboundFileDescriptors */
function* read(self: JObj, fd: JObj | null, target: Uint8Array): Gen<number> {
  const r = yield* awaited(socket(fd).receive(fdInt(fd), target, 0));
  if (typeof r === "number") return ioResult(r);
  if (r.rights.length) {
    const received: JObj[] = [];
    for (const f of r.rights) received.push(yield* awaited(mkFd(installFile(f, true))));
    setDeclared(self, IMPL, { inboundFileDescriptors: jarray(received, FD) });
  }
  return r.length;
}
/** socket_write_all: outboundFileDescriptors go with the first sendmsg of every write */
function write(self: JObj, fd: JObj | null, bytes: Uint8Array): void {
  const outbound = getDeclared<JObj[] | null>(self, IMPL, "outboundFileDescriptors");
  ioResult(socket(fd).send(bytes, null, rightsMessage(outbound?.map(fdInt) ?? [])));
}
rt.registerJnis(IMPL, {
  "connectLocal(Ljava/io/FileDescriptor;Ljava/lang/String;I)V": (fd: JObj | null, name: string, namespace: number) => after(socket(fd).connect(unixAddress(pathOf(name, namespace))), (r) => { ioResult(r); }),
  "bindLocal(Ljava/io/FileDescriptor;Ljava/lang/String;I)V": (fd: JObj | null, name: string, namespace: number) => { ioResult(socket(fd).bind(unixAddress(pathOf(name, namespace)))); },
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
    const c = socket(fd).peerCredentials();
    if (typeof c === "number") return ioResult(c);
    return newObj("android/net/Credentials", "(III)V", c.pid, c.uid, c.gid);
  },
});
