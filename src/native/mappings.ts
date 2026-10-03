// MAP_SHARED file mappings. Guest memory cannot alias one page at two addresses, so each mapping is
// a copy of its file range, made coherent where a program can observe the file: msync, munmap, a
// read of the file (which a new mapping is) and a write to it. A writable mapping keeps the bytes it
// last agreed on with the file, so a sync carries exactly the bytes stored through it to the file
// and into every other mapping of them, and never an older copy of bytes another mapping stored.
// The mappings live on their VfsFile, whose writeAt and reads drive them for every writer and reader.
import { guestAt, mem } from "./mem";
import { vfs, type VfsFile } from "../shell/vfs";

type SharedMapping = { va: bigint; n: number; off: number; base: Uint8Array | null };
const overlaps = (m: SharedMapping, va: bigint, end: bigint) => m.va < end && va < m.va + BigInt(m.n);

/** the shared mappings of one file */
export class SharedMaps {
  maps: SharedMapping[] = [];
  /** the mapping a flush is writing back, which already holds its bytes */
  private from: SharedMapping | null = null;
  constructor(readonly file: VfsFile) {}
  /** bytes now in the file at off (the page cache, which every mapping of the file shares) */
  wrote(off: number, bytes: Uint8Array): void {
    for (const m of this.maps) {
      const lo = Math.max(off, m.off), hi = Math.min(off + bytes.length, m.off + m.n);
      if (m === this.from || lo >= hi) continue;
      const part = bytes.subarray(lo - off, hi - off);
      mem.write(guestAt(m.va, lo - m.off), part);
      m.base?.set(part, lo - m.off);
    }
  }
  /** the bytes stored through each writable mapping since it last agreed with the file: into the
   *  file and the other mappings, as runs of exactly the changed bytes */
  flush(): void {
    for (const m of this.maps) {
      const base = m.base;
      if (!base) continue;
      const at = guestAt(m.va), words = m.n >>> 2;
      const cur32 = new Uint32Array(mem.buf, at, words), base32 = new Uint32Array(base.buffer, 0, words);
      for (let i = 0; i < m.n;) {
        if (i < words << 2 && !(i & 3) && cur32[i >>> 2] === base32[i >>> 2]) { i += 4; continue; }
        if (mem.u8[at + i] === base[i]) { i++; continue; }
        let j = i + 1;
        while (j < m.n && mem.u8[at + j] !== base[j]) j++;
        const bytes = mem.u8.slice(at + i, at + j);
        base.set(bytes, i);
        this.from = m;
        try { vfs.writeAt(this.file, m.off + i, bytes); } finally { this.from = null; }
        i = j;
      }
    }
  }
}
const mapped = new Set<SharedMaps>();

/** a shared mapping of [off, off + n) of the file at va, holding the file's bytes */
export function trackSharedMap(va: bigint, n: number, off: number, file: VfsFile, writable: boolean): void {
  const at = guestAt(va), shared = file.sharedMaps ??= new SharedMaps(file);
  shared.maps.push({ va, n, off, base: writable ? mem.u8.slice(at, at + n) : null });
  mapped.add(shared);
}

/** msync or munmap of [va, va + n): the files mapped there are flushed; with `drop` the range stops
 *  being mapped */
export function syncShared(va: bigint, n: number, drop: boolean): void {
  const end = va + BigInt(n);
  for (const shared of mapped) {
    if (!shared.maps.some((m) => overlaps(m, va, end))) continue;
    shared.flush();
    if (!drop) continue;
    const kept: SharedMapping[] = [];
    for (const m of shared.maps) {
      const mEnd = m.va + BigInt(m.n);
      if (!overlaps(m, va, end)) { kept.push(m); continue; }
      const left = m.va < va ? Number(va - m.va) : 0, right = mEnd > end ? Number(mEnd - end) : 0;
      if (left) kept.push({ ...m, n: left, base: m.base?.slice(0, left) ?? null });
      if (right) kept.push({ ...m, va: end, n: right, off: m.off + m.n - right, base: m.base?.slice(m.n - right) ?? null });
    }
    shared.maps = kept;
    if (!kept.length) { mapped.delete(shared); shared.file.sharedMaps = undefined; }
  }
}

/** the file range the shared mapping at va holds from there, which mremap carries along */
export function sharedAt(va: bigint): { file: VfsFile; off: number; writable: boolean } | null {
  for (const shared of mapped) for (const m of shared.maps) {
    if (overlaps(m, va, va + 1n)) return { file: shared.file, off: m.off + Number(va - m.va), writable: !!m.base };
  }
  return null;
}

/** whether any byte of [va, va+n) is a shared file mapping */
export function isShared(va: bigint, n: number): boolean {
  const end = va + BigInt(n);
  for (const shared of mapped) if (shared.maps.some((m) => overlaps(m, va, end))) return true;
  return false;
}
