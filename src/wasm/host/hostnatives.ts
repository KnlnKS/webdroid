// Natives the Wasm tier answers itself: those of classes the production runtime replaces whole (libcore's class loaders are JS there), which run
// here as the AOSP bytecode over the native underneath, and the synchronous form of a production native that queues behind a Promise.
import { jarray } from "../../jvm/abi";
import { BOOT_JAR_PATHS } from "../../jvm/bootclasspath";
import { readBytes, FD, type IoBuffer } from "../../android/os";
import { fdInt } from "../../jvm/natives/jio";
import { fdFile, javaPreadFd, javaReadFd, javaSeekFd } from "../../native/fs";
import { BytesFile } from "../../shell/lazyfile";
import type { HostFn } from "../link/hostapi";

/** a read of a file held in memory: production queues every read of a file that has a source behind a Promise, so here it is a positional
 *  read at the file's position, which such a source answers at once */
function readResident(fd: number, target: Uint8Array): number | Promise<number> {
  if (!(fdFile(fd)?.source instanceof BytesFile)) return javaReadFd(fd, target);
  const at = javaSeekFd(fd, 0, 1), n = javaPreadFd(fd, target, at);
  if (typeof n === "number" && n > 0) javaSeekFd(fd, at + n, 0);
  return n;
}

export const hostNatives = new Map<string, HostFn>([
  // the archives of the boot class path, which BootClassLoader looks resources up in
  ["java/lang/VMClassLoader.getBootClassPathEntries()[Ljava/lang/String;", () => jarray([...BOOT_JAR_PATHS], "Ljava/lang/String;")],
  [`libcore/io/Linux.readBytes(${FD}Ljava/lang/Object;II)I`, (d: object | null, buffer: IoBuffer, offset: number, count: number) =>
    readBytes("read", buffer, offset, count, (target) => readResident(fdInt(d as never), target))],
]);

/** Natives whose production implementation may answer a Promise although the work has a synchronous form, as the same function over the production one */
export const syncVariants = new Map<string, (production: HostFn) => HostFn>([
  // a digest of 64 KB or more is the browser's (crypto.subtle, asynchronous); without it the digest is the JS one, with the same bytes
  ["com/android/org/conscrypt/NativeCrypto.EVP_DigestFinal_ex(Lcom/android/org/conscrypt/NativeRef$EVP_MD_CTX;[BI)I", (production) => (...args) => {
    const own = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true });
    try { return production(...args); } finally { if (own) Object.defineProperty(globalThis, "crypto", own); else delete (globalThis as { crypto?: unknown }).crypto; }
  }],
]);
