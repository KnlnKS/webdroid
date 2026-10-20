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
import { isShared, syncShared, trackSharedMap, trackPrivateMap, fileMapAt, mapRemoteShared } from "./mappings.ts";

const pages = (n: number) => Math.ceil(n / PAGE_SIZE) * PAGE_SIZE;
/** mmap, whose file offset `offOf` reads: an off_t, or mmap64's off64_t */
export const mmapWith = (offOf: (a: Parameters<HostFn>[1]) => number): HostFn => (_cpu, a) => {
  const hint = a.va(), n = Number(a.va()), prot = a.i(), flags = a.i(), fd = a.i(), off = offOf(a);
  if (!Number.isSafeInteger(n) || n <= 0 || (flags & 0x10 && (hint & 4095n))) return -E.INVAL;
  const reserve = (flags & 0x20) !== 0 && prot === 0;
  // The core executes only below 4 GiB: code (PROT_EXEC now, or a JIT's code range hinted
  // low and made executable later, as V8's is) must not land in a plane above it.
  const p = flags & 0x10 ? hint : mem.mapVa(n, reserve, (prot & 4) !== 0 || (hint > 0n && hint < 0x1_0000_0000n));
  if (!p || (flags & 0x10 && !(mem.mapFixed(hint, pages(n)) && (reserve ? mem.reserveVa(hint, n) : mem.commitVa(hint, n))))) return -E.NOMEM;
  if (flags & 0x10) syncShared(hint, n, true);
  if (flags & 0x10 && !reserve) { invalidateRange(mem.txVa(hint), n); mem.dropVa(hint, n); }
  if (fd !== -1 && !(flags & 0x20) && flags & 1 && isRemoteFd(fd))
    return mapRemoteShared(BigInt(p), n, off, fd, prot).then(e => { if (!e) return p; mem.unmapVa(BigInt(p), n); return -e; });
  if (fd !== -1 && !(flags & 0x20)) {
    const file = fdFile(fd), track = (r: number) => {
      if (r < 0) { mem.unmapVa(BigInt(p), n); return r; }
      if (file) { if (flags & 1) trackSharedMap(BigInt(p), n, off, file, (prot & 2) !== 0); else trackPrivateMap(BigInt(p), n, off, file); }
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
    if (prot & 7) return mem.commitVa(va, n) ? 0 : -E.NOMEM;
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
  // MREMAP_MAYMOVE moves (to new_address with MREMAP_FIXED). A shared file mapping keeps its file
  // range wherever it lands, and its new pages hold the file's bytes.
  mremap: (_c, a) => {
    const old = a.va(), oldSize = Number(a.va()), size = Number(a.va()), flags = a.i(), fixed = flags & 2 ? a.va() : 0n;
    const mask = BigInt(PAGE_SIZE - 1), result = (va: bigint) => PTR === 8 ? va : Number(va);
    if (old & mask || fixed & mask || !size || flags & ~3 || (flags & 2 && !(flags & 1))) return -E.INVAL;
    if (flags & 2 && fixed < old + BigInt(pages(oldSize)) && old < fixed + BigInt(pages(size))) return -E.INVAL;
    if (!(flags & 2) && pages(size) <= pages(oldSize)) {
      const tail = pages(oldSize) - pages(size);
      if (tail) { syncShared(old + BigInt(pages(size)), tail, true); mem.unmapVa(old + BigInt(pages(size)), tail); }
      return result(old);
    }
    const mapping = fileMapAt(old);
    let to = old;
    if (flags & 2 || !mem.extendVa(old, oldSize, size)) {
      if (!(flags & 1)) return -E.NOMEM;
      if (flags & 2) {
        syncShared(fixed, size, true);
        if (!mem.mapFixed(fixed, pages(size)) || !mem.commitVa(fixed, size)) return -E.NOMEM;
        invalidateRange(mem.txVa(fixed), size); mem.dropVa(fixed, size);
        to = fixed;
      } else {
        const moved = mem.mapVa(size, false, old < 0x1_0000_0000n);
        if (!moved) return -E.NOMEM;
        to = BigInt(moved);
      }
      syncShared(old, oldSize, true);
      mem.write(mem.txVa(to), mem.bytes(mem.txVa(old), Math.min(oldSize, size)));
      mem.unmapVa(old, pages(oldSize));
    } else syncShared(old, oldSize, true);
    if (!mapping) return result(to);
    const track = () => {
      if (mapping.shared) trackSharedMap(to, size, mapping.off, mapping.file, mapping.writable); else trackPrivateMap(to, size, mapping.off, mapping.file);
      return result(to);
    };
    if (size <= oldSize) return track();
    const tail = contentAt(mapping.file, mapping.off + oldSize, size - oldSize);
    const fill = (bytes: Uint8Array) => { mem.write(mem.txVa(to + BigInt(oldSize)), bytes); return track(); };
    return tail instanceof Promise ? tail.then(fill, () => -E.IO) : fill(tail);
  },
  // MADV_DONTNEED zero-fills anonymous memory; a shared file mapping refaults from the page
  // cache, which already holds its stores, so its contents stay
  madvise: (_c, a) => { const va = a.va(), n = Number(a.va()); if (a.i() === 4 && !isShared(va, n)) mem.dropVa(va, n); return 0; },
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
