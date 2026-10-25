// bionic's fdsan over the process's one descriptor table, which keeps each descriptor's owner tag
// (fd.ts): libcore's natives, the reference bionic (its table entries interposed) and the ARM32 libc
// check and exchange the same tags at the same error level.
import { closeFd, fdsanOwnerTag, setFdsanOwnerTag } from "./fd.ts";
import { E } from "./abi.ts";
import { kernelResult, logLine } from "./kernel.ts";
import { cstr, type HostFn } from "./host.ts";
import { abortThread } from "./signals.ts";
import { setAbortMessage } from "./crash.ts";
import type { Cpu } from "./cpu.ts";
import { procIdentity } from "../shell/procfs.ts";
import { abortProcess, never } from "../process-exit.ts";

const DISABLED = 0, WARN_ONCE = 1, FATAL = 3;
/** android_fdsan_error_level: __libc_init_fdsan's FATAL (debug.fdsan unset), which the zygote's
 *  ForkCommon restores in each app process it forks */
let level = FATAL;

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

/** fdsan_error: a warning (the first only, at WARN_ONCE), or an abort with the message, of the guest thread that
 *  called when one did */
function violation(message: string, cpu?: Cpu): Promise<never> | undefined {
  if (level === DISABLED) return;
  if (level !== FATAL) {
    if (level === WARN_ONCE) level = DISABLED;
    logLine(6, "fdsan", message);
    return;
  }
  setAbortMessage(message);
  if (cpu) return abortThread(cpu);
  abortProcess(procIdentity.pid, message);
  return never();
}

/** android_fdsan_exchange_owner_tag */
export function fdsanExchangeOwnerTag(fd: number, expected: bigint, tag: bigint, cpu?: Cpu): Promise<never> | undefined {
  if (fd < 0) return;
  const actual = fdsanOwnerTag(fd);
  if (actual !== expected) {
    return violation(`failed to exchange ownership of file descriptor: fd ${fd} is ${owner(actual)}, was expected to be ${owner(expected)}`, cpu);
  }
  setFdsanOwnerTag(fd, tag);
}
/** android_fdsan_close_with_tag */
export function fdsanClose(fd: number, expected: bigint, cpu?: Cpu): number | Promise<number> {
  const actual = fdsanOwnerTag(fd);
  const aborting = fd >= 0 && actual !== expected
    ? violation(`attempted to close file descriptor ${fd}, expected to be ${owner(expected)}, actually ${owner(actual)}`, cpu) : undefined;
  if (aborting) return aborting;
  const result = closeFd(fd);
  if (!expected) return result;
  const closed = (r: number) => r === -E.BADF ? violation(`double-close of file descriptor ${fd} detected`, cpu) ?? r : r;
  return result instanceof Promise ? result.then(closed) : closed(result);
}

/** android_fdsan_set_error_level: the level before */
function setLevel(next: number): number {
  const previous = level;
  level = next;
  return previous;
}

/** the entries of bionic's table, which the reference libc's own calls (close, stdio, dirent, fork) reach through its PLT */
export const FDSAN_TABLE: Record<string, HostFn> = {
  android_fdsan_exchange_owner_tag: (cpu, a) => fdsanExchangeOwnerTag(a.i(), a.l(), a.l(), cpu),
  android_fdsan_get_owner_tag: (_c, a) => fdsanOwnerTag(a.i()),
  android_fdsan_close_with_tag: (cpu, a) => kernelResult(cpu, fdsanClose(a.i(), a.l(), cpu)),
  android_fdsan_get_error_level: () => level,
  android_fdsan_set_error_level: (_c, a) => setLevel(a.i()),
};
/** the ARM32 libc's fdsan, whose close is a close with no owner as bionic's is */
export const FDSAN_LIBC32: Record<string, HostFn> = {
  ...FDSAN_TABLE,
  android_fdsan_create_owner_tag: (_c, a) => {
    const type = a.i(), tag = a.l();
    return tag ? BigInt.asIntN(64, BigInt(type & 0xff) << 56n | BigInt.asUintN(56, tag)) : 0n;
  },
  android_fdsan_get_tag_type: (_c, a) => cstr(fdsanTagType(a.l())),
  android_fdsan_get_tag_value: (_c, a) => fdsanTagValue(a.l()),
  close: (cpu, a) => kernelResult(cpu, fdsanClose(a.i(), 0n, cpu)),
};
