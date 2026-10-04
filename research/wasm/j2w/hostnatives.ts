// Natives the Wasm tier answers itself: those of classes the production runtime replaces whole (libcore's class loaders are JS there), which run
// here as the AOSP bytecode over the native underneath, and the synchronous form of a production native that queues behind a Promise.
import { jarray } from "../../../src/jvm/abi";
import { BOOT_JAR_PATHS } from "../../../src/jvm/bootclasspath";
import { readBytes, FD, type IoBuffer } from "../../../src/android/os";
import { fdInt } from "../../../src/jvm/natives/jio";
import { fdFile, javaPreadFd, javaReadFd, javaSeekFd } from "../../../src/native/fs";
import { BytesFile } from "../../../src/shell/lazyfile";
import type { HostFn } from "./natives";

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
