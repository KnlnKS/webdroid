// The kernel's memory mapping calls. File mappings are copies of the file's bytes: a private one
// keeps its stores to itself, and a MAP_SHARED one is kept coherent with the file and its other
// mappings (mappings.ts).

import { mem, guestAt } from "./mem.ts";
import { PTR, type HostFn } from "./host.ts";
import { E, PAGE_SIZE } from "./abi.ts";
import { invalidateRange } from "./cpu.ts";
import { offArg } from "./kernel.ts";
import { fdRead, fdFile, contentAt } from "./fs.ts";
import { isRemoteFd } from "./process-fd.ts";
import { isShared, syncShared, trackSharedMap, trackPrivateMap, fileMapAt, growMap, mapRemoteShared, moveMaps } from "./mappings.ts";

const PROT_READ = 1, PROT_WRITE = 2, PROT_EXEC = 4, MAP_SHARED = 1, MAP_FIXED = 0x10, MAP_ANONYMOUS = 0x20;
const MREMAP_MAYMOVE = 1, MREMAP_FIXED = 2, MADV_DONTNEED = 4;
const pages = (n: number) => Math.ceil(n / PAGE_SIZE) * PAGE_SIZE;
/** mmap, whose file offset `offOf` reads: an off_t, or mmap64's off64_t */
export const mmapWith = (offOf: (a: Parameters<HostFn>[1]) => number): HostFn => (_cpu, a) => {
  const hint = a.va(), n = Number(a.va()), prot = a.i(), flags = a.i(), fd = a.i(), off = offOf(a);
  if (!Number.isSafeInteger(n) || n <= 0 || (flags & MAP_FIXED && (hint & 4095n))) return -E.INVAL;
  const reserve = (flags & MAP_ANONYMOUS) !== 0 && prot === 0;
  // The core executes only below 4 GiB: code (PROT_EXEC now, or a JIT's code range hinted
  // low and made executable later, as V8's is) must not land in a plane above it.
  const p = flags & MAP_FIXED ? hint : mem.mapVa(n, reserve, (prot & PROT_EXEC) !== 0 || (hint > 0n && hint < 0x1_0000_0000n));
  if (!p || (flags & MAP_FIXED && !(mem.mapFixed(hint, pages(n)) && (reserve ? mem.reserveVa(hint, n) : mem.commitVa(hint, n))))) return -E.NOMEM;
  if (flags & MAP_FIXED) syncShared(hint, n, true);
  if (flags & MAP_FIXED && !reserve) { invalidateRange(mem.txVa(hint), n); mem.dropVa(hint, n); }
  if (fd !== -1 && !(flags & MAP_ANONYMOUS) && flags & MAP_SHARED && isRemoteFd(fd))
    return mapRemoteShared(BigInt(p), n, off, fd, prot).then(e => { if (!e) return p; mem.unmapVa(BigInt(p), n); return -e; });
  if (fd !== -1 && !(flags & MAP_ANONYMOUS)) {
    const file = fdFile(fd), track = (r: number) => {
      if (r < 0) { mem.unmapVa(BigInt(p), n); return r; }
      if (file) { if (flags & MAP_SHARED) trackSharedMap(BigInt(p), n, off, file, (prot & PROT_WRITE) !== 0); else trackPrivateMap(BigInt(p), n, off, file); }
      return p;
    };
    const r = fdRead(fd, guestAt(p), n, off); return r instanceof Promise ? r.then(track) : track(r);
  }
  return p;
};

export const VM_SYSCALLS: Record<string, HostFn> = {
  // a protection change moves no byte: a block stays valid until a write or a cache flush says otherwise
  mprotect: (_c, a) => {
    const va = a.va(), n = Number(a.va()), prot = a.i();
    if (prot & (PROT_READ | PROT_WRITE | PROT_EXEC)) return mem.commitVa(va, n) ? 0 : -E.NOMEM;
    mem.decommitVa(va, n);
    return 0;
  },
  mmap: mmapWith(offArg),
  munmap: (_c, a) => {
    const va = a.va(), n = pages(Number(a.va())); // whole pages, as the kernel unmaps
    if (va & BigInt(PAGE_SIZE - 1) || !n) return -E.INVAL;
    syncShared(va, n, true);
    return mem.unmapVa(va, n) ? 0 : -E.INVAL;
  },
  // A mapping shrinks in place, grows in place when the address space after it is free, and with
  // MREMAP_MAYMOVE moves (to new_address with MREMAP_FIXED). A file mapping keeps its file range
  // and page cache wherever it lands, and its new pages hold the file's bytes.
  mremap: (_c, a) => {
    const old = a.va(), oldSize = Number(a.va()), size = Number(a.va()), flags = a.i(), fixed = flags & MREMAP_FIXED ? a.va() : 0n;
    const mask = BigInt(PAGE_SIZE - 1), result = (va: bigint) => PTR === 8 ? va : Number(va);
    if (old & mask || fixed & mask || !size || flags & ~(MREMAP_MAYMOVE | MREMAP_FIXED) || (flags & MREMAP_FIXED && !(flags & MREMAP_MAYMOVE))) return -E.INVAL;
    if (flags & MREMAP_FIXED && fixed < old + BigInt(pages(oldSize)) && old < fixed + BigInt(pages(size))) return -E.INVAL;
    if (pages(size) < pages(oldSize)) {
      const tail = pages(oldSize) - pages(size);
      syncShared(old + BigInt(pages(size)), tail, true); mem.unmapVa(old + BigInt(pages(size)), tail);
    }
    if (!(flags & MREMAP_FIXED) && pages(size) <= pages(oldSize)) return result(old);
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
    if (!mapping) return result(to);
    const tail = contentAt(mapping.file, mapping.off + have, size - have);
    const fill = (bytes: Uint8Array) => { mem.write(mem.txVa(to + BigInt(have)), bytes); growMap(to, size); return result(to); };
    return tail instanceof Promise ? tail.then(fill, () => -E.IO) : fill(tail);
  },
  // MADV_DONTNEED zero-fills anonymous memory; a shared file mapping refaults from the page
  // cache, which already holds its stores, so its contents stay
  madvise: (_c, a) => { const va = a.va(), n = Number(a.va()); if (a.i() === MADV_DONTNEED && !isShared(va, n)) mem.dropVa(va, n); return 0; },
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
