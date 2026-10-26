// The kernel's memory mapping calls, which libcore's Os.mmap and FileChannel.map reach too. File
// mappings are copies of the file's bytes: a private one keeps its stores to itself, and a
// MAP_SHARED one is kept coherent with the file and its other mappings (mappings.ts), except
// that one of a region in the shared pool is the region itself, in an ARM32 process's window (shm.ts).

import { mem, guestAt } from "./mem.ts";
import type { HostFn } from "./host.ts";
import { E, PAGE_SIZE } from "./abi.ts";
import { invalidateRange } from "./cpu.ts";
import { offArg } from "./kernel.ts";
import { fdFile, contentAt } from "./fs.ts";
import { openFd, readFd, holdFile, dropFile } from "./fd.ts";
import { isRemoteFd, remoteOf } from "./process-fd.ts";
import { isShared, syncShared, trackSharedMap, trackPrivateMap, fileMapAt, growMap, mapLease, moveMaps } from "./mappings.ts";
import { mapWindow, protectWindow, unmapWindow } from "./shm.ts";
import { inWindow } from "./window.ts";

export const PROT_READ = 1, PROT_WRITE = 2, PROT_EXEC = 4, MAP_SHARED = 1, MAP_PRIVATE = 2, MAP_FIXED = 0x10, MAP_ANONYMOUS = 0x20;
const MREMAP_MAYMOVE = 1, MREMAP_FIXED = 2, MADV_DONTNEED = 4;
const pages = (n: number) => Math.ceil(n / PAGE_SIZE) * PAGE_SIZE;
type Mmap = (hint: bigint, n: number, prot: number, flags: number, fd: number, off: number) => number | bigint | Promise<number | bigint>;
/** mmap(2) for Java, whose direct memory is the core's own: the mapping's address, or -errno */
export const mmap: Mmap = (...args) => mapping(...args, false);
/** mmap(2) for native code, whose shared mappings of a pooled region are in the window */
export const nativeMmap: Mmap = (...args) => mapping(...args, true);
/** A descriptor's mapping is refused beyond an ashmem region's protection, and a writable shared one of
 *  a file whose stores could not reach it. */
function mapping(hint: bigint, n: number, prot: number, flags: number, fd: number, off: number, native: boolean): number | bigint | Promise<number | bigint> {
  const type = flags & 3, file = flags & MAP_ANONYMOUS ? null : openFd(fd);
  if (!Number.isSafeInteger(n) || n <= 0 || !Number.isSafeInteger(off) || off < 0 || off & (PAGE_SIZE - 1) || !type || (flags & MAP_FIXED && (hint & 4095n))) return -E.INVAL;
  if (file === undefined) return -E.BADF;
  if (file && prot & ~(file.content.ashmem?.prot ?? 7)) return -E.PERM;
  if (file && type !== MAP_PRIVATE && prot & PROT_WRITE && !fdFile(fd) && !isRemoteFd(fd)) return -E.NODEV;
  if (file && type !== MAP_PRIVATE) {
    const region = native ? file.content.ashmem?.pool : undefined;
    if (region !== undefined) {
      const va = inPool(region, file.content.len, n, prot, flags, off, () => dropFile(file));
      if (va !== null) { holdFile(file); return va; }
    }
    if (isRemoteFd(fd)) return mapRemote(hint, n, prot, flags, fd, off, native);
  }
  const p = place(hint, n, prot, flags, !file && prot === 0);
  if (!file || p === -E.NOMEM) return p;
  const content = fdFile(fd), track = (r: number): number | bigint => {
    if (r < 0) { mem.unmapVa(BigInt(p), n); return r; }
    if (content) { if (type !== MAP_PRIVATE) trackSharedMap(BigInt(p), n, off, content, (prot & PROT_WRITE) !== 0); else trackPrivateMap(BigInt(p), n, off, content); }
    return p;
  };
  const r = readFd(fd, guestAt(p), n, off);
  return r instanceof Promise ? r.then(track) : track(r);
}
/** where a new mapping goes, which MAP_FIXED's replaces what was at its hint; -ENOMEM where nothing can */
function place(hint: bigint, n: number, prot: number, flags: number, reserve: boolean): number | bigint {
  // The core executes only below 4 GiB: code (PROT_EXEC now, or a JIT's code range hinted
  // low and made executable later, as V8's is) must not land in a plane above it.
  const p = flags & MAP_FIXED ? hint : mem.mapVa(n, reserve, (prot & PROT_EXEC) !== 0 || (hint > 0n && hint < 0x1_0000_0000n), hint);
  if (!p || (flags & MAP_FIXED && !(mem.mapFixed(hint, pages(n)) && (reserve ? mem.reserveVa(hint, n) : mem.commitVa(hint, n))))) return -E.NOMEM;
  if (flags & MAP_FIXED) syncShared(hint, n, true);
  if (flags & MAP_FIXED && !reserve) { invalidateRange(mem.txVa(hint), n); mem.dropVa(hint, n); }
  return p;
}
/** a MAP_SHARED mapping of [off, off + n) of the region of `size` bytes at offset `region` of the shared pool:
 *  the region's own pages in the window, which hold it until unmapped; null where they cannot be (no window,
 *  a range past the region, or a MAP_FIXED address) */
function inPool(region: number, size: number, n: number, prot: number, flags: number, off: number, release: () => unknown): number | null {
  return off + n > pages(size) || flags & MAP_FIXED ? null : mapWindow(region, off, n, prot, release);
}
/** a MAP_SHARED mapping of a file another realm owns, through a lease on what the file holds of the range: the
 *  region itself where the file is in the shared pool, else a copy kept coherent with it (mappings.ts) whose
 *  bytes past EOF stay zero */
async function mapRemote(hint: bigint, n: number, prot: number, flags: number, fd: number, off: number, native: boolean): Promise<number | bigint> {
  const remote = remoteOf(fd)!, stat = await remote.stat();
  if (!stat) return -E.BADF;
  const length = Math.max(0, Math.min(n, stat.size - off)), lease = length ? await remote.map(off, length, prot) : null;
  if (typeof lease === "number") return -lease;
  const va = lease?.pool === undefined || !native ? null : inPool(lease.pool, stat.size, n, prot, flags, off, () => lease.close());
  if (va !== null) return va;
  const p = place(hint, n, prot, flags, false);
  if (p === -E.NOMEM) { await lease?.close(); return p; }
  if (lease) await mapLease(BigInt(p), lease, off, prot);
  return p;
}
/** munmap(2) of whole pages, as the kernel unmaps */
export function munmap(va: bigint, size: number): number {
  const n = pages(size);
  if (va & BigInt(PAGE_SIZE - 1) || !n) return -E.INVAL;
  if (inWindow(Number(va))) { unmapWindow(Number(va), n); return 0; }
  syncShared(va, n, true);
  return mem.unmapVa(va, n) ? 0 : -E.INVAL;
}

export const VM_SYSCALLS: Record<string, HostFn> = {
  // a protection change moves no byte: a block stays valid until a write or a cache flush says otherwise
  mprotect: (_c, a) => {
    const va = a.va(), n = Number(a.va()), prot = a.i();
    if (inWindow(Number(va))) { protectWindow(Number(va), pages(n), prot); return 0; }
    mem.protectVa(va, n, (prot & PROT_WRITE) !== 0);
    if (prot & (PROT_READ | PROT_WRITE | PROT_EXEC)) return mem.commitVa(va, n) ? 0 : -E.NOMEM;
    mem.decommitVa(va, n);
    return 0;
  },
  mmap: (_c, a) => nativeMmap(a.va(), Number(a.va()), a.i(), a.i(), a.i(), offArg(a)),
  munmap: (_c, a) => munmap(a.va(), Number(a.va())),
  // A mapping shrinks in place, grows in place when the address space after it is free, and with
  // MREMAP_MAYMOVE moves (to new_address with MREMAP_FIXED). A file mapping keeps its file range
  // and page cache wherever it lands, and its new pages hold the file's bytes.
  mremap: (_c, a) => {
    const old = a.va(), oldSize = Number(a.va()), size = Number(a.va()), flags = a.i(), fixed = flags & MREMAP_FIXED ? a.va() : 0n;
    const mask = BigInt(PAGE_SIZE - 1);
    if (old & mask || fixed & mask || !size || inWindow(Number(old)) || flags & ~(MREMAP_MAYMOVE | MREMAP_FIXED) || (flags & MREMAP_FIXED && !(flags & MREMAP_MAYMOVE))) return -E.INVAL;
    if (flags & MREMAP_FIXED && fixed < old + BigInt(pages(oldSize)) && old < fixed + BigInt(pages(size))) return -E.INVAL;
    if (pages(size) < pages(oldSize)) {
      const tail = pages(oldSize) - pages(size);
      syncShared(old + BigInt(pages(size)), tail, true); mem.unmapVa(old + BigInt(pages(size)), tail);
    }
    if (!(flags & MREMAP_FIXED) && pages(size) <= pages(oldSize)) return old;
    const have = Math.min(oldSize, size);
    let to = old;
    if (flags & MREMAP_FIXED || !mem.extendVa(old, oldSize, size)) {
      if (!(flags & MREMAP_MAYMOVE)) return -E.NOMEM;
      if (flags & MREMAP_FIXED) {
        syncShared(fixed, size, true);
        if (!mem.mapFixed(fixed, pages(size)) || !mem.commitVa(fixed, size)) return -E.NOMEM;
        invalidateRange(mem.txVa(fixed), size); mem.dropVa(fixed, size);
        to = fixed;
      } else {
        const moved = mem.mapVa(size, false, old < 0x1_0000_0000n);
        if (!moved) return -E.NOMEM;
        to = BigInt(moved);
      }
      mem.write(mem.txVa(to), mem.bytes(mem.txVa(old), have));
      moveMaps(old, have, to);
      mem.unmapVa(old, pages(have));
    }
    const mapping = size > have ? fileMapAt(to) : null;
    if (!mapping) return to;
    const tail = contentAt(mapping.file, mapping.off + have, size - have);
    const fill = (bytes: Uint8Array) => { mem.write(mem.txVa(to + BigInt(have)), bytes); growMap(to, size); return to; };
    return tail instanceof Promise ? tail.then(fill, () => -E.IO) : fill(tail);
  },
  // MADV_DONTNEED zero-fills anonymous memory; a shared file mapping refaults from the page
  // cache, which already holds its stores, so its contents stay
  madvise: (_c, a) => { const va = a.va(), n = Number(a.va()); if (a.i() === MADV_DONTNEED && !isShared(va, n) && !inWindow(Number(va))) mem.dropVa(va, n); return 0; },
  msync: (_c, a) => { const va = a.va(), n = Number(a.va()); if (va & 4095n) return -E.INVAL; syncShared(va, n, false); return 0; },
  mlock: () => 0, munlock: () => 0,
  mincore: (_c, a) => {
    const addr = a.va(), len = Number(a.va()), vec = a.p();
    if (addr & BigInt(PAGE_SIZE - 1) || !Number.isSafeInteger(len) || len <= 0) return -E.INVAL;
    for (let i = 0; i < Math.ceil(len / PAGE_SIZE); i++) {
      const resident = mem.residentVa(addr + BigInt(i * PAGE_SIZE));
      if (resident < 0) return -E.NOMEM;
      mem.st8(vec + i, resident);
    }
    return 0;
  },
};
