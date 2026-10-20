// One descriptor namespace shared by files, pipes, and relay-backed sockets.

import { E } from "./abi.ts";
import { logLine } from "./kernel.ts";

const claimed = new Set<number>([0, 1, 2]);
let next = 3;

/** the lowest unclaimed descriptor at or above `min` */
export function allocateFd(min = 0): number {
  while (claimed.has(next)) next++;
  let fd = Math.max(next, min);
  while (claimed.has(fd)) fd++;
  if (fd === next) next++;
  claimed.add(fd);
  return fd;
}

export function releaseFd(fd: number): void {
  if (fd >= 0 && claimed.delete(fd)) next = Math.min(next, fd);
  ownerTags.delete(fd);
}

export function reserveFd(fd: number): void {
  if (fd >= 0) claimed.add(fd);
}

// bionic's fdsan: a descriptor's owner tag, which an ownership exchange or a tagged close checks.
// The first violation is reported and every operation goes on, as fdsan's warn-once level does.
const ownerTags = new Map<number, bigint>();
let fdsanReported = false;
const TAG_TYPES: Record<number, string> = {
  1: "FILE*", 2: "DIR*", 3: "unique_fd", 4: "sqlite", 5: "FileInputStream", 6: "FileOutputStream", 7: "RandomAccessFile",
  8: "ParcelFileDescriptor", 9: "ArtFdFile", 10: "DatagramSocketImpl", 11: "SocketImpl", 12: "ZipArchive", 13: "native_handle_t", 14: "Parcel",
};
export function fdsanTagType(tag: bigint): string {
  const bits = BigInt.asUintN(64, tag), type = Number(bits >> 56n);
  if (type === 255) return bits >> 48n === 0xffffn ? "native object of unknown type" : "Java object of unknown type";
  return TAG_TYPES[type] ?? "native object of unknown type";
}
/** the owner a tag names: its low 56 bits, sign-extended */
export const fdsanTagValue = (tag: bigint): bigint => BigInt.asIntN(56, tag);
const owner = (tag: bigint) => tag ? `owned by ${fdsanTagType(tag)} 0x${BigInt.asUintN(64, fdsanTagValue(tag)).toString(16)}` : "unowned";
function fdsanError(message: string): void {
  if (fdsanReported) return;
  fdsanReported = true;
  logLine(6, "fdsan", message);
}
export const fdsanOwnerTag = (fd: number): bigint => ownerTags.get(fd) ?? 0n;
export function fdsanExchangeOwnerTag(fd: number, expected: bigint, tag: bigint): void {
  if (fd < 0) return;
  const actual = fdsanOwnerTag(fd);
  if (actual !== expected) {
    fdsanError(`failed to exchange ownership of file descriptor: fd ${fd} is ${owner(actual)}, was expected to be ${owner(expected)}`);
  } else if (tag) ownerTags.set(fd, tag);
  else ownerTags.delete(fd);
}
/** android_fdsan_close_with_tag: `close` closes the descriptor and answers -errno */
export function fdsanClose(fd: number, expected: bigint, close: (fd: number) => number): number {
  const actual = fdsanOwnerTag(fd);
  if (fd >= 0 && actual !== expected) {
    fdsanError(`attempted to close file descriptor ${fd}, expected to be ${owner(expected)}, actually ${owner(actual)}`);
  }
  const result = close(fd);
  if (expected && result === -E.BADF) fdsanError(`double-close of file descriptor ${fd} detected`);
  return result;
}
