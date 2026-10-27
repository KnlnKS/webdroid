// libcore.io.Linux, the syscalls behind android.system.Os and Libcore.os, over the descriptor
// table native code shares; its socket calls and the socket streams' natives go through the socket
// core (src/native/socket/), so a descriptor from either side is the same socket.
import { processEnv } from "../../shell/environment.ts";
import { appUserName, procIdentity, processTid, sysconf, uname } from "../../shell/procfs.ts";
import { filePaths } from "../../shell/file-path.ts";
import { awaited, rt, type JObj, getDeclared, setDeclared, driven, waits, ranged, type Gen } from "../runtime.ts";
import { jarray, u8 } from "../abi.ts";
import { vcall, scall, newObj, after, iof, curThread, mainThread, type JThread, linkClass } from "./jentry.ts";
import type { JThrowable } from "./jthrowable.ts";
import { checkFromIndexSize } from "./jlang.ts";
import { is64BitProcess } from "./jvmruntime.ts";
import { fdInt, setFdInt, mkFd, bytesOf } from "./jio.ts";
import { type JBuffer, isBuffer, readBufferBytes, writeBufferBytes, capacity, elementShift } from "./jnio.ts";
import { OS_CONSTANTS } from "../../android/os-constants.ts";
import { E, ERRSTR, POLLIN, POLLERR, strerror } from "../../native/abi.ts";
import { mmap, munmap } from "../../native/vm.ts";
import { processOpenFd } from "../../native/process-fd.ts";
import { linkTarget, statAt, statFd, storageStat } from "../../native/fs.ts";
import { openFd, dupFd, dup2Fd, dropFile, readFd, preadFd, writeFd, pwriteFd, seekFd, truncateFd, allocateFd, syncFd, fcntlFd, ioctlIntFd, fdsanOwnerTag } from "../../native/fd.ts";
import { fdsanClose, fdsanExchangeOwnerTag, fdsanTagType, fdsanTagValue } from "../../native/fdsan.ts";
import { pipeFds } from "../../native/pipe.ts";
import type { Stat } from "../../native/kernel.ts";
import { pollEntries, type PollEntry } from "../../native/poll.ts";
import { SOL_SOCKET, MSG_DONTWAIT, MSG_TRUNC, sunPath, sunPathBytes, unixAddress, type SocketAddress } from "../../native/socket/abi.ts";
import { SO_PEERCRED, SO_RCVTIMEO, SO_SNDTIMEO, SO_BINDTODEVICE, readSocket, socketOf, type Socket, type Received, type Accepted } from "../../native/socket/core.ts";
import { IPPROTO_IP, IP_ADD_MEMBERSHIP, MCAST_JOIN_GROUP } from "../../native/socket/inet.ts";
import { socketCreate, socketPair } from "../../native/socket/syscalls.ts";
import {
  AF_UNIX, AF_INET, AF_INET6, NI_NUMERICHOST, NI_NAMEREQD, EAI_NONAME, INTERFACES, hostOf, gaiText, endpointOf, addressText, parseIpv4, parseIpv6, type Endpoint,
} from "../../native/net-address.ts";

// android.system.Os: the libcore syscall surface over the same descriptor table native code uses
export const errno = (fn: string, e: number): JThrowable => setDeclared(rt.mkThrowable("android/system/ErrnoException", null), "android/system/ErrnoException", { functionName: fn, errno: e });
/** `then` once `path` exists in the realm that owns it (an app's private storage lives in the system realm), else `fn`'s ErrnoException */
const existing = <T>(fn: string, path: string, then: (st: Stat) => T) => after(statAt(path), (st) => { if (typeof st === "number") throw errno(fn, -st); return then(st); });
/** libcore's StructTimespec for a time in milliseconds */
const timespec = (ms: number): JObj => setDeclared(rt.make("android/system/StructTimespec"), "android/system/StructTimespec",
  { tv_sec: BigInt(Math.floor(ms / 1000)), tv_nsec: BigInt(Math.round((ms % 1000) * 1e6)) });
export const FD = "Ljava/io/FileDescriptor;";
/** a StructStat as libcore's JNI fills one from stat(2) */
function statOf(st: Stat): JObj {
  const seconds = BigInt(Math.floor(st.mtime / 1000)), time = timespec(st.mtime);
  return setDeclared(rt.make("android/system/StructStat"), "android/system/StructStat", {
    st_dev: BigInt(st.dev), st_ino: BigInt(st.ino), st_mode: st.mode, st_nlink: BigInt(st.nlink), st_uid: st.uid, st_gid: st.gid,
    st_size: BigInt(st.size), st_blksize: BigInt(st.blksize), st_blocks: BigInt(st.blocks), st_atime: seconds, st_mtime: seconds, st_ctime: seconds,
    st_atim: time, st_mtim: time, st_ctim: time,
  });
}
/** a StructStatVfs as statvfs(2) fills it */
const structStatVfs = () => after(storageStat(), (s) => newObj("android/system/StructStatVfs", "(JJJJJJJJJJJ)V",
  BigInt(s.bsize), BigInt(s.bsize), BigInt(s.blocks), BigInt(s.bfree), BigInt(s.bfree), BigInt(s.files), BigInt(s.ffree), BigInt(s.ffree), 0n, 0n, BigInt(s.namemax)));
// libcore.io.Linux: the syscalls behind android.system.Os and Libcore.os, over the descriptor
// table native code shares
const files: Record<string, (...args: never[]) => unknown> = {
    "open(Ljava/lang/String;II)Ljava/io/FileDescriptor;": driven(function* (path: string, flags: number): Gen {
      if (path === null) rt.npe();
      const fd = yield* awaited(processOpenFd(path, flags));
      if (fd < 0) throw errno("open", -fd);
      return yield* awaited(mkFd(fd));
    }),
    [`fstat(${FD})Landroid/system/StructStat;`]: (d: JObj | null) => after(statFd(fdInt(d)), (st) => { if (typeof st === "number") throw errno("fstat", -st); return statOf(st); }),
    [`readBytes(${FD}Ljava/lang/Object;II)I`]: ranged(waits((d: JObj | null, buffer: IoBuffer, offset: number, count: number) =>
      readBytes("read", buffer, offset, count, (target) => readFd(fdInt(d), target, count))), [1, 2, 3]),
    [`preadBytes(${FD}Ljava/lang/Object;IIJ)I`]: ranged(waits((d: JObj | null, buffer: IoBuffer, offset: number, count: number, position: bigint) =>
      readBytes("pread", buffer, offset, count, (target) => preadFd(fdInt(d), target, count, Number(position)))), [1, 2, 3]),
    [`writeBytes(${FD}Ljava/lang/Object;II)I`]: ranged(waits((d: JObj | null, buffer: IoBuffer, offset: number, count: number) =>
      writeBytes(buffer, offset, count, (bytes) => after(writeFd(fdInt(d), bytes), n => ioResult("write", n)))), [1, 2, 3]),
    [`pwriteBytes(${FD}Ljava/lang/Object;IIJ)I`]: ranged(waits((d: JObj | null, buffer: IoBuffer, offset: number, count: number, position: bigint) =>
      writeBytes(buffer, offset, count, (bytes) => after(pwriteFd(fdInt(d), bytes, Number(position)), n => ioResult("pwrite", n)))), [1, 2, 3]),
    [`ftruncate(${FD}J)V`]: (d: JObj | null, length: bigint) => after(truncateFd(fdInt(d), Number(length)), n => sys("ftruncate", n)),
    [`posix_fallocate(${FD}JJ)V`]: (d: JObj | null, offset: bigint, length: bigint) =>
      after(allocateFd(fdInt(d), Number(offset), Number(length)), n => sys("posix_fallocate", n)),
    [`fsync(${FD})V`]: (d: JObj | null) => after(syncFd(fdInt(d)), n => sys("fsync", n)),
    [`fdatasync(${FD})V`]: (d: JObj | null) => after(syncFd(fdInt(d)), n => sys("fdatasync", n)),
    [`ioctlInt(${FD}I)I`]: (d: JObj | null, request: number) => after(ioctlIntFd(fdInt(d), request), n => ioResult("ioctl", n)),
    [`fcntlInt(${FD}II)I`]: (d: JObj | null, cmd: number, arg: number) => after(fcntlFd(fdInt(d), cmd, arg), n => ioResult("fcntl", n)),
    [`fcntlVoid(${FD}I)I`]: (d: JObj | null, cmd: number) => after(fcntlFd(fdInt(d), cmd, 0), n => ioResult("fcntl", n)),
    // a fatal violation never returns
    [`android_fdsan_exchange_owner_tag(${FD}JJ)V`]: waits((d: JObj | null, expected: bigint, tag: bigint) =>
      fdsanExchangeOwnerTag(fdInt(d), expected, tag)),
    [`android_fdsan_get_owner_tag(${FD})J`]: (d: JObj | null) => fdsanOwnerTag(fdInt(d)),
    "android_fdsan_get_tag_type(J)Ljava/lang/String;": (tag: bigint) => fdsanTagType(tag),
    "android_fdsan_get_tag_value(J)J": (tag: bigint) => fdsanTagValue(tag),
    // no descriptor here is a terminal
    [`isatty(${FD})Z`]: () => 0,
    "pipe2(I)[Ljava/io/FileDescriptor;": (flags: number) => {
      const [read, write] = pipeFds(flags);
      return after(mkFd(read), (r) => after(mkFd(write), (w) => jarray([r, w], FD)));
    },
    [`sendfile(${FD}${FD}Landroid/system/Int64Ref;J)J`]: (out: JObj | null, input: JObj | null, offset: JObj | null, count: bigint) => {
      const start = offset ? Number(getDeclared<bigint>(offset, "android/system/Int64Ref", "value")) : 0;
      const n = count < 0n ? -1 : Math.min(Number(count), SENDFILE_CHUNK);
      if (n < 0 || start < 0) throw errno("sendfile", E.INVAL);
      if (!openFd(fdInt(out))) throw errno("sendfile", E.BADF);
      const scratch = new Uint8Array(n), from = fdInt(input);
      return after(offset ? preadFd(from, scratch, n, start) : readFd(from, scratch, n), (read) => {
        sys("sendfile", read);
        return after(read ? writeFd(fdInt(out), scratch.subarray(0, read)) : 0, written => {
          sys("sendfile", written);
          if (offset) setDeclared(offset, "android/system/Int64Ref", { value: BigInt(start + written) });
          return BigInt(written);
        });
      });
    },
    [`lseek(${FD}JI)J`]: driven(function* (d: JObj | null, off: bigint, whence: number): Gen {
      const r = yield* awaited(seekFd(fdInt(d), Number(off), whence));
      if (r < 0) throw errno("lseek", -r);
      return BigInt(r);
    }),
    [`close(${FD})V`]: waits((d: JObj | null) => {
      if (d === null) return rt.npe();
      const fd = fdInt(d), owner = getDeclared<bigint | undefined>(d, "java/io/FileDescriptor", "ownerId");
      setFdInt(d, -1);
      return after(fdsanClose(fd, owner ?? 0n), n => sys("close", n));
    }),
    [`dup(${FD})${FD}`]: waits((d: JObj | null) => {
      const fd = dupFd(fdInt(d));
      if (fd < 0) throw errno("dup", -fd);
      return mkFd(fd);
    }),
    [`mmap(JJII${FD}J)J`]: waits((hint: bigint, count: bigint, prot: number, flags: number, d: JObj | null, offset: bigint) =>
      after(mmap(hint, Number(count), prot, flags, fdInt(d), Number(offset)), (r) => { if (typeof r === "number" && r < 0) throw errno("mmap", -r); return BigInt(r); })),
    "munmap(JJ)V": (address: bigint, count: bigint) => sys("munmap", munmap(address, Number(count))),
    "gettid()I": () => threadTid(curThread),
    "getenv(Ljava/lang/String;)Ljava/lang/String;": (key: string) => {
      if (key === null) rt.npe();
      return processEnv[key] ?? null;
    },
    "setenv(Ljava/lang/String;Ljava/lang/String;Z)V": (key: string, value: string, overwrite: number) => {
      if (key === null || value === null) rt.npe();
      if (!key || key.includes("=")) throw errno("setenv", 22);
      if (overwrite || !(key in processEnv)) processEnv[key] = value;
    },
    "unsetenv(Ljava/lang/String;)V": (key: string) => {
      if (key === null) rt.npe();
      if (!key || key.includes("=")) throw errno("unsetenv", 22);
      delete processEnv[key];
    },
    "getpid()I": () => procIdentity.pid,
    "getuid()I": () => zygoteRunning ? 0 : procIdentity.uid,
    // bionic's passwd entry: every id has one, named as appUserName names it
    "getpwuid(I)Landroid/system/StructPasswd;": waits((uid: number) =>
      newObj("android/system/StructPasswd", "(Ljava/lang/String;IILjava/lang/String;Ljava/lang/String;)V", appUserName(uid), uid, uid, "/data", "/system/bin/sh")),
    "uname()Landroid/system/StructUtsname;": () => setDeclared(rt.make("android/system/StructUtsname"), "android/system/StructUtsname",
      (({ domainname: _, ...fields }) => fields)(uname(is64BitProcess()))),
    "sysconf(I)J": (name: number) => BigInt(sysconf(name)),
    "strerror(I)Ljava/lang/String;": strerror,
    "stat(Ljava/lang/String;)Landroid/system/StructStat;": (path: string) => existing("stat", path, statOf),
    // the VFS has no symbolic links, so no path names one
    "lstat(Ljava/lang/String;)Landroid/system/StructStat;": (path: string) => existing("lstat", path, statOf),
    "chmod(Ljava/lang/String;I)V": (path: string, mode: number) => {
      if (path === null) rt.npe();
      return after(filePaths(path).fileSetAttributes(path,{mode}), result => { sys("chmod",result); });
    },
    "chown(Ljava/lang/String;II)V": (path: string, uid: number, gid: number) => {
      if (path === null) rt.npe();
      return after(filePaths(path).fileSetAttributes(path,{uid,gid}), result => { sys("chown",result); });
    },
    // the VFS keeps no extended attributes, as a filesystem without xattr support
    "setxattr(Ljava/lang/String;Ljava/lang/String;[BI)V": (path: string, name: string) => {
      if (path === null || name === null) rt.npe();
      return existing("setxattr", path, () => { throw errno("setxattr", E.NOTSUP); });
    },
    "statvfs(Ljava/lang/String;)Landroid/system/StructStatVfs;": (path: string) => existing("statvfs", path, () => structStatVfs()),
    [`fstatvfs(${FD})Landroid/system/StructStatVfs;`]: (d: JObj | null) => {
      if (fdInt(d) < 0) throw errno("fstatvfs", E.BADF);
      return structStatVfs();
    },
    "readlink(Ljava/lang/String;)Ljava/lang/String;": (path: string) => { if (path === null) rt.npe(); return after(linkTarget(path), (target) => { if (typeof target === "number") throw errno("readlink", -target); return target; }); },
    "access(Ljava/lang/String;I)Z": (path: string, mode: number) => {
      if (path === null) rt.npe();
      return after(filePaths(path).fileAccess(path, mode), result => { sys("access", result); return 1; });
    },
    "remove(Ljava/lang/String;)V": (path: string) => { if (path === null) rt.npe(); return after(filePaths(path).fileRemove(path), n => sys("remove", n)); },
    // a new directory takes the default mode, not `mode`
    "mkdir(Ljava/lang/String;I)V": (path: string) => {
      if (path === null) rt.npe();
      return after(filePaths(path).fileMkdir(path), result => { sys("mkdir", result); });
    },
    "rename(Ljava/lang/String;Ljava/lang/String;)V": (from: string, to: string) => {
      if (from === null || to === null) rt.npe();
      return after(filePaths(from, to).fileRename(from,to), n => sys("rename", n));
    },
};
/** a -errno result as the ErrnoException libcore's Os methods throw */
export function sys(fn: string, result: number): void { if (result < 0) throw errno(fn, -result); }
export const ioResult = (fn: string, result: number): number => { sys(fn, result); return result; };
/** sendfile moves at most this much a call, which its callers loop over as Linux allows */
const SENDFILE_CHUNK = 1 << 20;
/** the Object readBytes and its kin take: a byte[], or a direct ByteBuffer addressed from its start */
type IoBuffer = Int8Array | JBuffer | null;
function ioRegion(buffer: Int8Array | null, offset: number, count: number): Uint8Array {
  if (buffer === null) return rt.npe();
  checkFromIndexSize(offset, count, buffer.byteLength, "java/lang/ArrayIndexOutOfBoundsException");
  return new Uint8Array(buffer.buffer, buffer.byteOffset + offset, count);
}
/** Read a buffer's bytes through its canonical owner before writing them. */
export function writeBytes<T>(buffer: IoBuffer, offset: number, count: number, write: (bytes: Uint8Array) => T): PromiseOrVal<T> {
  if (!isBuffer(buffer)) return write(ioRegion(buffer, offset, count));
  checkFromIndexSize(offset,count,capacity(buffer) * 2 ** elementShift(buffer),"java/lang/ArrayIndexOutOfBoundsException");
  return after(readBufferBytes(buffer,offset,count),write);
}
/** A direct buffer may live in guest memory, which can move while a read waits: it takes the
 *  bytes once they have arrived. */
export function readBytes(fn: string, buffer: IoBuffer, offset: number, count: number, read: (target: Uint8Array) => PromiseOrVal<number>) {
  if (!isBuffer(buffer)) return after(read(ioRegion(buffer, offset, count)), (n) => ioResult(fn, n));
  checkFromIndexSize(offset,count,capacity(buffer) * 2 ** elementShift(buffer),"java/lang/ArrayIndexOutOfBoundsException");
  const scratch = new Uint8Array(count);
  return after(read(scratch),n => n > 0 ? after(writeBufferBytes(buffer,scratch.subarray(0,n),offset),() => ioResult(fn,n)) : ioResult(fn,n));
}
// System.getenv(): the environment as alternating name and value bytes
rt.registerJni("java/lang/ProcessEnvironment", "environ()[[B", () => jarray(Object.entries(processEnv).flat().map(bytesOf), "[B"));
// Android interrupts threads blocked on the descriptor; a reader parked on a pipe here stays parked
rt.registerJni("libcore/io/AsynchronousCloseMonitor", `signalBlockedThreads(${FD})V`, () => {});
// libcore's OsConstants fills its fields from native initConstants(); these are the reference
// device's values (pnpm gen-framework)
rt.registerJni("android/system/OsConstants", "initConstants()V", () => {
  const constants = linkClass("android/system/OsConstants");
  constants.setStatics(Object.entries(OS_CONSTANTS), "I");
});
/** set while the zygote initializes what every app inherits: it runs as root */
let zygoteRunning = false;
export async function asZygote(init: () => unknown): Promise<void> {
  zygoteRunning = true;
  try { await init(); } finally { zygoteRunning = false; }
}
/** the kernel thread id of a Java thread: the main thread's is the pid, as on a device */
export function threadTid(t: JThread): number {
  return processTid(t, t === mainThread);
}

const ISA = "java/net/InetSocketAddress", UNIX_ADDRESS = "android/system/UnixSocketAddress", ISA_HOLDER = "java/net/InetSocketAddress$InetSocketAddressHolder";
const INET = "Ljava/net/InetAddress;", SOCKADDR = "Ljava/net/SocketAddress;";
const IP_MULTICAST_IF = 32;

/** a bytecode throwable, thrown once made */
const thrown = (cls: string, desc: string, ...args: unknown[]): Promise<never> => after(newObj(cls, desc, ...args), (e) => { throw e; });
const socketClosed = () => rt.mkThrowable("java/net/SocketException", "Socket closed");
/** the descriptor a call waited on closed under it: libcore's AsynchronousCloseMonitor answer */
const closedUnder = (fn: string, r: number) => { if (r === -E.BADF) throw socketClosed(); sys(fn, r); return r; };
/** a result that may come after waiting */
const waited = <T>(fn: string, r: PromiseOrVal<T | number>, done: (v: T) => unknown = (v) => v) =>
  r instanceof Promise ? r.then((v) => typeof v === "number" && v < 0 ? closedUnder(fn, v) : done(v as T))
    : typeof r === "number" && r < 0 ? sys(fn, r) : done(r as T);
/** the socket a FileDescriptor names, else the call's ErrnoException */
function socket(fn: string, d: JObj | null): Socket {
  const s = socketOf(fdInt(d));
  if (typeof s === "number") throw errno(fn, -s);
  return s;
}

/** an InetAddress's endpoint, as libcore's inetAddressToSockaddr reads it */
function endpoint(address: JObj | null, port: number): PromiseOrVal<Endpoint> {
  if (address === null) return rt.npe();
  return after(vcall(address, "getAddress", "()[B") as PromiseOrVal<Int8Array>, (bytes) => endpointOf(Uint8Array.from(bytes), port));
}
const inet = (ep: Endpoint): SocketAddress => ({ family: ep.address.length === 4 ? AF_INET : AF_INET6, ep });
/** a SocketAddress's sockaddr: an InetSocketAddress's endpoint, or a UnixSocketAddress's sun_path */
function socketAddress(fn: string, address: JObj | null): PromiseOrVal<SocketAddress> {
  if (address === null) return rt.npe();
  if (iof(address, UNIX_ADDRESS)) return unixAddress(sunPath(u8(getDeclared<Int8Array>(address, UNIX_ADDRESS, "sun_path"))));
  if (!iof(address, ISA)) throw errno(fn, E.AFNOSUPPORT);
  const holder = getDeclared(address, ISA, "holder") as JObj;
  const addr = getDeclared(holder, ISA_HOLDER, "addr") as JObj | null;
  if (addr === null) throw errno(fn, E.INVAL);
  return after(endpoint(addr, getDeclared(holder, ISA_HOLDER, "port") as number), inet);
}
/** sockaddrToInetAddress: InetAddress.getByAddress(null, bytes, scope) */
const inetAddress = (ep: { address: number[]; scope?: number }): PromiseOrVal<JObj> =>
  scall("java/net/InetAddress", "getByAddress", "(Ljava/lang/String;[BI)Ljava/net/InetAddress;", null, Int8Array.from(ep.address), ep.scope ?? 0);
/** a sockaddr as libcore's SocketAddress: an InetSocketAddress, or a UnixSocketAddress over its sun_path */
const javaSocketAddress = (addr: SocketAddress): PromiseOrVal<JObj> => addr.family === AF_UNIX
  ? newObj(UNIX_ADDRESS, "([B)V", new Int8Array(sunPathBytes(addr.path).buffer))
  : after(inetAddress(addr.ep), (a) => newObj(ISA, `(${INET}I)V`, a, addr.ep.port));
/** fillInetSocketAddress: a caller's InetSocketAddress takes an internet sender's address and port */
function fillSocketAddress(target: JObj | null, from: SocketAddress | null): PromiseOrVal<void> {
  if (target === null || from === null || from.family === AF_UNIX || !iof(target, ISA)) return;
  return after(inetAddress(from.ep), (a) => {
    const holder = getDeclared(target, ISA, "holder") as JObj;
    setDeclared(holder, ISA_HOLDER, { addr: a, port: from.ep.port });
  });
}

function connect(d: JObj | null, addr: SocketAddress) { return waited("connect", socket("connect", d).connect(addr), () => {}); }
function bind(d: JObj | null, addr: SocketAddress) { sys("bind", socket("bind", d).bind(addr)); }
function sendto(d: JObj | null, buffer: IoBuffer, offset: number, count: number, to: SocketAddress | null) {
  const s = socket("sendto", d);
  return writeBytes(buffer, offset, count, (bytes) => ioResult("sendto", s.send(bytes, to, null)));
}
const intOption = (fn: string, d: JObj | null, level: number, name: number) => ioResult(fn, socket(fn, d).getOption(level, name));
const setIntOption = (fn: string, d: JObj | null, level: number, name: number, value: number) => sys(fn, socket(fn, d).setOption(level, name, value));
/** getaddrinfo's EAI_* as android.system.GaiException */
const gaiError = (fn: string, code: number) => thrown("android/system/GaiException", "(Ljava/lang/String;I)V", fn, code);
/** getsockname/getpeername */
function socketAddressOf(fn: string, d: JObj | null, peer: boolean) {
  const name = socket(fn, d).name(peer);
  if (typeof name === "number") throw errno(fn, -name);
  return javaSocketAddress(name);
}
const iface = (name: string | null) => INTERFACES.find((i) => i.name === name) ?? null;

const sockets: Record<string, (...args: never[]) => unknown> = {
  "socket(III)Ljava/io/FileDescriptor;": (domain: number, type: number, protocol: number) => {
    const fd = socketCreate(domain, type, protocol);
    sys("socket", fd);
    return mkFd(fd);
  },
  [`socketpair(III${FD}${FD})V`]: (domain: number, type: number, _protocol: number, a: JObj | null, b: JObj | null) => {
    if (domain !== AF_UNIX) throw errno("socketpair", E.AFNOSUPPORT);
    const pair = socketPair(type);
    if (typeof pair === "number") throw errno("socketpair", -pair);
    const [x, y] = pair;
    setDeclared(a!, "java/io/FileDescriptor", { descriptor: x });
    setDeclared(b!, "java/io/FileDescriptor", { descriptor: y });
  },
  [`dup2(${FD}I)${FD}`]: (d: JObj | null, to: number) => {
    const fd = dup2Fd(fdInt(d), to);
    sys("dup2", fd);
    return mkFd(fd);
  },
  [`connect(${FD}${INET}I)V`]: waits((d: JObj | null, address: JObj | null, port: number) => after(endpoint(address, port), (ep) => connect(d, inet(ep)))),
  [`connect(${FD}${SOCKADDR})V`]: (d: JObj | null, address: JObj | null) => after(socketAddress("connect", address), (addr) => connect(d, addr)),
  [`bind(${FD}${INET}I)V`]: (d: JObj | null, address: JObj | null, port: number) => after(endpoint(address, port), (ep) => bind(d, inet(ep))),
  [`bind(${FD}${SOCKADDR})V`]: (d: JObj | null, address: JObj | null) => after(socketAddress("bind", address), (addr) => bind(d, addr)),
  [`listen(${FD}I)V`]: (d: JObj | null) => { sys("listen", socket("listen", d).listen()); },
  // an AF_UNIX peer is unnamed: its UnixSocketAddress stays as the caller made it
  [`accept(${FD}${SOCKADDR})${FD}`]: (d: JObj | null, peer: JObj | null) =>
    waited("accept", socket("accept", d).accept(fdInt(d), 0), (r: Accepted) => after(fillSocketAddress(peer, r.peer), () => mkFd(r.fd))),
  [`shutdown(${FD}I)V`]: (d: JObj | null, how: number) => { sys("shutdown", socket("shutdown", d).shutdown(how)); },
  [`getsockname(${FD})${SOCKADDR}`]: (d: JObj | null) => socketAddressOf("getsockname", d, false),
  [`getpeername(${FD})${SOCKADDR}`]: (d: JObj | null) => socketAddressOf("getpeername", d, true),
  "poll([Landroid/system/StructPollfd;I)I": waits((fds: JObj[] | null, timeout: number) => {
    if (fds === null) return rt.npe();
    const P = "android/system/StructPollfd";
    const entries: PollEntry[] = fds.map((p) => ({ fd: p === null ? -1 : fdInt(getDeclared(p, P, "fd") as JObj | null), events: getDeclared(p, P, "events") as number, revents: 0 }));
    return after(pollEntries(entries, timeout), (n) => {
      fds.forEach((p, i) => { if (p !== null) setDeclared(p, P, { revents: entries[i].revents }); });
      return n;
    });
  }),
  [`getsockoptInt(${FD}II)I`]: (d: JObj | null, level: number, name: number) => intOption("getsockopt", d, level, name),
  [`setsockoptInt(${FD}III)V`]: (d: JObj | null, level: number, name: number, value: number) => setIntOption("setsockopt", d, level, name, value),
  [`getsockoptByte(${FD}II)I`]: (d: JObj | null, level: number, name: number) => intOption("getsockopt", d, level, name) & 255,
  [`setsockoptByte(${FD}III)V`]: (d: JObj | null, level: number, name: number, value: number) => setIntOption("setsockopt", d, level, name, value & 255),
  [`getsockoptLinger(${FD}II)Landroid/system/StructLinger;`]: (d: JObj | null, level: number, name: number) => {
    const linger = intOption("getsockopt", d, level, name);
    return newObj("android/system/StructLinger", "(II)V", linger ? 1 : 0, Math.max(0, linger - 1));
  },
  [`setsockoptLinger(${FD}IILandroid/system/StructLinger;)V`]: (d: JObj | null, level: number, name: number, linger: JObj | null) => {
    if (linger === null) return rt.npe();
    const L = "android/system/StructLinger";
    setIntOption("setsockopt", d, level, name, getDeclared(linger, L, "l_onoff") ? getDeclared(linger, L, "l_linger") as number : -1);
  },
  [`getsockoptTimeval(${FD}II)Landroid/system/StructTimeval;`]: (d: JObj | null, level: number, name: number) => {
    const ms = intOption("getsockopt", d, level, name);
    return newObj("android/system/StructTimeval", "(JJ)V", BigInt(Math.floor(ms / 1000)), BigInt(ms % 1000 * 1000));
  },
  [`setsockoptTimeval(${FD}IILandroid/system/StructTimeval;)V`]: (d: JObj | null, level: number, name: number, tv: JObj | null) => {
    if (tv === null) return rt.npe();
    const T = "android/system/StructTimeval", sec = getDeclared(tv, T, "tv_sec") as bigint, usec = getDeclared(tv, T, "tv_usec") as bigint;
    if (level !== SOL_SOCKET || name !== SO_RCVTIMEO && name !== SO_SNDTIMEO || sec < 0n || usec < 0n || usec >= 1_000_000n) throw errno("setsockopt", E.INVAL);
    setIntOption("setsockopt", d, level, name, Number(sec) * 1000 + Math.ceil(Number(usec) / 1000));
  },
  [`getsockoptUcred(${FD}II)Landroid/system/StructUcred;`]: (d: JObj | null, level: number, name: number) => {
    if (level !== SOL_SOCKET || name !== SO_PEERCRED) throw errno("getsockopt", E.NOPROTOOPT);
    const c = socket("getsockopt", d).peerCredentials();
    if (typeof c === "number") throw errno("getsockopt", -c);
    return newObj("android/system/StructUcred", "(III)V", c.pid, c.uid, c.gid);
  },
  [`getsockoptInAddr(${FD}II)${INET}`]: (d: JObj | null, level: number, name: number) => {
    const v = intOption("getsockopt", d, level, name);
    return inetAddress({ address: level === IPPROTO_IP && name === IP_MULTICAST_IF && v > 255 ? [v >>> 24, v >> 16 & 255, v >> 8 & 255, v & 255] : [0, 0, 0, 0] });
  },
  [`setsockoptIpMreqn(${FD}III)V`]: (d: JObj | null, level: number, name: number, index: number) => {
    if (index && !INTERFACES.some((i) => i.index === index)) throw errno("setsockopt", E.NODEV);
    setIntOption("setsockopt", d, level, name, index);
  },
  [`setsockoptGroupReq(${FD}IILandroid/system/StructGroupReq;)V`]: (d: JObj | null, _level: number, name: number, req: JObj | null) => {
    if (req === null) return rt.npe();
    const G = "android/system/StructGroupReq";
    const join = name === MCAST_JOIN_GROUP || name === IP_ADD_MEMBERSHIP;
    return after(endpoint(getDeclared(req, G, "gr_group") as JObj | null, 0), (ep) =>
      sys("setsockopt", socket("setsockopt", d).group(join, ep.address, getDeclared(req, G, "gr_interface") as number)));
  },
  [`setsockoptIfreq(${FD}IILjava/lang/String;)V`]: (d: JObj | null, level: number, name: number, ifname: string | null) => {
    socket("setsockopt", d);
    if (level !== SOL_SOCKET || name !== SO_BINDTODEVICE) throw errno("setsockopt", E.NOPROTOOPT);
    if (ifname && !iface(ifname)) throw errno("setsockopt", E.NODEV);
  },
  [`sendtoBytes(${FD}Ljava/lang/Object;III${INET}I)I`]: ranged((d: JObj | null, buffer: IoBuffer, offset: number, count: number, flags: number, address: JObj | null, port: number) =>
    address === null ? sendto(d, buffer, offset, count, null) : after(endpoint(address, port), (ep) => sendto(d, buffer, offset, count, inet(ep))), [1, 2, 3]),
  [`sendtoBytes(${FD}Ljava/lang/Object;III${SOCKADDR})I`]: ranged((d: JObj | null, buffer: IoBuffer, offset: number, count: number, flags: number, address: JObj | null) =>
    address === null ? sendto(d, buffer, offset, count, null) : after(socketAddress("sendto", address), (to) => sendto(d, buffer, offset, count, to)), [1, 2, 3]),
  [`recvfromBytes(${FD}Ljava/lang/Object;III${"Ljava/net/InetSocketAddress;"})I`]: ranged(waits((d: JObj | null, buffer: IoBuffer, offset: number, count: number, flags: number, source: JObj | null) => {
    const s = socket("recvfrom", d);
    let from: SocketAddress | null = null;
    const take = (r: Received | number) => {
      if (typeof r === "number") return r;
      r.rights.forEach(dropFile);
      from = r.from;
      return flags & MSG_TRUNC ? r.size : r.length;
    };
    const n = readBytes("recvfrom", buffer, offset, count, (target) => {
      const r = s.receive(fdInt(d), target, flags);
      return r instanceof Promise ? r.then((v) => closedUnder("recvfrom", take(v))) : take(r);
    });
    return after(n, (received) => after(fillSocketAddress(source, from), () => received));
  }), [1, 2, 3]),
  [`getnameinfo(${INET}I)Ljava/lang/String;`]: (address: JObj | null, flags: number) => after(endpoint(address, 0), (ep) => {
    const name = flags & NI_NUMERICHOST ? null : hostOf(ep.address);
    if (name === null && flags & NI_NAMEREQD) return gaiError("getnameinfo", EAI_NONAME);
    return name ?? addressText(ep.address);
  }),
  "gai_strerror(I)Ljava/lang/String;": (code: number) => gaiText(code),
  "inet_pton(ILjava/lang/String;)Ljava/net/InetAddress;": (family: number, text: string | null) => {
    if (text === null) return rt.npe();
    const bytes = family === AF_INET ? parseIpv4(text) : family === AF_INET6 ? parseIpv6(text) : null;
    return bytes ? inetAddress({ address: bytes }) : null;
  },
  "getifaddrs()[Landroid/system/StructIfaddrs;": driven(function* () {
    const list: JObj[] = [];
    for (const i of INTERFACES) for (const { address, prefix } of i.addresses) {
      const mask = Array.from({ length: address.length }, (_, k) => 255 & ~(255 >> Math.max(0, Math.min(8, prefix - 8 * k))));
      list.push(yield newObj("android/system/StructIfaddrs", `(Ljava/lang/String;I${INET}${INET}${INET}[B)V`, i.name, i.flags,
        yield* awaited(inetAddress({ address })), yield* awaited(inetAddress({ address: mask })), null, null));
    }
    return jarray(list, "Landroid/system/StructIfaddrs;");
  }),
  "if_nametoindex(Ljava/lang/String;)I": (name: string | null) => iface(name)?.index ?? 0,
  "if_indextoname(I)Ljava/lang/String;": (index: number) => INTERFACES.find((i) => i.index === index)?.name ?? null,
  [`ioctlFlags(${FD}Ljava/lang/String;)I`]: (_d: JObj | null, name: string | null) => { const i = iface(name); if (!i) throw errno("ioctl", E.NODEV); return i.flags; },
  [`ioctlMTU(${FD}Ljava/lang/String;)I`]: (_d: JObj | null, name: string | null) => { const i = iface(name); if (!i) throw errno("ioctl", E.NODEV); return i.mtu; },
  [`ioctlInetAddress(${FD}ILjava/lang/String;)${INET}`]: (_d: JObj | null, request: number, name: string | null) => {
    const i = iface(name);
    if (!i) throw errno("ioctl", E.NODEV);
    const v4 = i.addresses.find((a) => a.address.length === 4);
    if (!v4) throw errno("ioctl", E.ADDRNOTAVAIL);
    // SIOCGIFADDR, SIOCGIFNETMASK; loopback has no broadcast or destination address
    if (request === 0x8915) return inetAddress({ address: v4.address });
    if (request === 0x891b) return inetAddress({ address: [255, 0, 0, 0] });
    throw errno("ioctl", E.ADDRNOTAVAIL);
  },
};
rt.registerJnis("libcore/io/Linux", { ...files, ...sockets });

// java.net.SocketInputStream/SocketOutputStream: OpenJDK's socketRead0 (NET_Timeout, then read)
// and socketWrite0 (write until done)
const readFailure = (e: number) => e === E.CONNRESET || e === E.PIPE
  ? thrown("sun/net/ConnectionResetException", "(Ljava/lang/String;)V", "Connection reset")
  : Promise.reject(e === E.BADF ? socketClosed() : rt.mkThrowable("java/net/SocketException", ERRSTR[e] ?? "Read failed"));
const readDone = (n: number) => n >= 0 ? n : readFailure(-n);
rt.registerJni("java/net/SocketInputStream", `socketRead0(${FD}[BIII)I`, ranged(waits((d: JObj | null, b: Int8Array, off: number, len: number, timeout: number) => {
  const fd = fdInt(d);
  if (fd < 0) throw socketClosed();
  const target = new Uint8Array(b.buffer, b.byteOffset + off, len);
  if (timeout <= 0) { const n = readSocket(fd, target); return n instanceof Promise ? n.then(readDone) : readDone(n); }
  const n = readSocket(fd, target, MSG_DONTWAIT);
  if (n !== -E.AGAIN) return readDone(n as number);
  const entry = { fd, events: POLLIN | POLLERR, revents: 0 };
  return after(pollEntries([entry], timeout), (ready) => {
    if (!ready) throw rt.mkThrowable("java/net/SocketTimeoutException", "Read timed out");
    return after(readSocket(fd, target, MSG_DONTWAIT), readDone);
  });
}), [1, 2, 3]));
rt.registerJni("java/net/SocketOutputStream", `socketWrite0(${FD}[BII)V`, ranged((d: JObj | null, b: Int8Array, off: number, len: number) => {
  const fd = fdInt(d);
  if (fd < 0) throw socketClosed();
  const s = socketOf(fd), n = typeof s === "number" ? s : s.send(new Uint8Array(b.buffer, b.byteOffset + off, len), null, null);
  if (n >= 0) return;
  if (n === -E.CONNRESET) return thrown("sun/net/ConnectionResetException", "(Ljava/lang/String;)V", "Connection reset");
  throw n === -E.BADF ? socketClosed() : rt.mkThrowable("java/net/SocketException", ERRSTR[-n] ?? "Write failed");
}, [1, 2, 3]));
