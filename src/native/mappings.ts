// File mappings. Guest memory cannot alias one page at two addresses, so each MAP_SHARED mapping is
// a copy of its file range, made coherent where a program can observe the file: msync, munmap, a
// read of the file (which a new mapping is) and a write to it. A writable mapping keeps the bytes it
// last agreed on with the file, so a sync carries exactly the bytes stored through it to the file
// and into every other mapping of them, and never an older copy of bytes another mapping stored.
// A file of this process tells its mappings of every write and read (VfsFile.sharedMaps).
// A file another process owns (a process Worker's) is mapped through its owner's lease instead, by
// native and Java code alike: the bytes are read in when mapped and stores go back through the lease at
// msync and munmap, reaching this process's other mappings of the file then, and before a descriptor
// leaves for another process; stores of other processes reach a mapping only when it is mapped again.
import { guestAt, mem } from "./mem.ts";
import { vfs, type VfsFile } from "../shell/vfs.ts";
import { E } from "./abi.ts";
import { remoteOf, type ProcessMapping } from "./process-fd.ts";

/** an owner's lease on another process's file, which covers the file from offset `start` */
type Lease = { lease: ProcessMapping; start: number };
/** A file mapping at va of [off, off + n) of its file: one of this process (`file`), or another's
 *  through `owner`. A shared one shares the file's page cache with the file's other shared mappings,
 *  and a writable one keeps the bytes it last agreed on with the file in `base`; a private one keeps
 *  only the range mremap's growth reads on from. */
type Mapping = { va: bigint; n: number; off: number; shared: boolean; base: Uint8Array | null } & ({ file: VfsFile; owner?: undefined } | { file?: undefined; owner: Lease });
let maps: Mapping[] = [];
const overlaps = (m: Mapping, va: bigint, end: bigint) => m.va < end && va < m.va + BigInt(m.n);
const mapAt = (va: bigint): Mapping | undefined => maps.find((m) => overlaps(m, va, va + 1n));
/** what names a shared mapping's page cache: its file here, or the owner's region */
const cacheOf = (m: Mapping): VfsFile | number | null => m.owner ? m.owner.lease.region : m.shared ? m.file : null;

/** bytes now at offset `at` of the file whose page cache is `cache`: into each of its mappings but
 *  `from`, which holds them already */
function propagate(cache: VfsFile | number, at: number, bytes: Uint8Array, from: Mapping | null): void {
  for (const m of maps) {
    if (m === from || cacheOf(m) !== cache) continue;
    const lo = Math.max(at, m.off), hi = Math.min(at + bytes.length, m.off + m.n);
    if (lo >= hi) continue;
    const part = bytes.subarray(lo - at, hi - at);
    mem.write(guestAt(m.va, lo - m.off), part);
    m.base?.set(part, lo - m.off);
  }
}
/** the mapping a flush is writing back to a file here, which holds its bytes already */
let writingBack: Mapping | null = null;
/** what a file's writes and syncs tell its shared mappings (vfs.ts) */
export class SharedMaps {
  readonly file: VfsFile;
  constructor(file: VfsFile) { this.file = file; }
  /** bytes now in the file at off */
  wrote(off: number, bytes: Uint8Array): void { propagate(this.file, off, bytes, writingBack); }
  flush(): void { for (const m of maps) if (m.shared && m.file === this.file) flush(m); }
}
/** The stores through writable shared mapping `m` since it last agreed with its file: into the file
 *  and the file's other mappings, as runs of exactly the changed bytes. The last page of a mapping
 *  of a file here holds bytes past its end, which are the page cache's and do not extend the file. */
function flush(m: Mapping): void {
  if (m.owner) {
    const owner = m.owner;
    stored(m, m.n, (i, bytes) => {
      leased(owner, () => owner.lease.write(m.off - owner.start + i, bytes));
      propagate(owner.lease.region, m.off + i, bytes, m);
    });
    return;
  }
  const file = m.file;
  stored(m, Math.max(0, Math.min(m.n, file.len - m.off)), (i, bytes) => {
    writingBack = m;
    try { vfs.writeAt(file, m.off + i, bytes); } finally { writingBack = null; }
  });
}
/** the runs of the first `length` bytes stored through writable mapping `m` since it last agreed with its file, which its base takes */
function stored(m: Mapping, length: number, write: (at: number, bytes: Uint8Array) => void): void {
  const base = m.base;
  if (!base) return;
  const at = guestAt(m.va), words = length >>> 2;
  const cur32 = new Uint32Array(mem.buf, at, words), base32 = new Uint32Array(base.buffer, 0, words);
  for (let i = 0; i < length;) {
    if (i < words << 2 && !(i & 3) && cur32[i >>> 2] === base32[i >>> 2]) { i += 4; continue; }
    if (mem.u8[at + i] === base[i]) { i++; continue; }
    let j = i + 1;
    while (j < length && mem.u8[at + j] !== base[j]) j++;
    const bytes = mem.u8.slice(at + i, at + j);
    base.set(bytes, i);
    write(i, bytes);
    i = j;
  }
}

/** a shared mapping of [off, off + n) of the file at va, holding the file's bytes */
export function trackSharedMap(va: bigint, n: number, off: number, file: VfsFile, writable: boolean): void {
  const at = guestAt(va);
  file.sharedMaps ??= new SharedMaps(file);
  maps.push({ va, n, off, file, shared: true, base: writable ? mem.u8.slice(at, at + n) : null });
}
export function trackPrivateMap(va: bigint, n: number, off: number, file: VfsFile): void {
  maps.push({ va, n, off, file, shared: false, base: null });
}

/** the lease operations not yet done on each file (by its owner's region), which run in order and a new mapping of the file waits for */
const queues = new Map<number, Promise<void>>();
const leased = (owner: Lease, operation: () => Promise<void>) => {
  const key = owner.lease.region;
  const done: Promise<void> = (queues.get(key) ?? Promise.resolve()).then(operation).catch((error) => console.error("[mmap]", error))
    .then(() => { if (queues.get(key) === done) queues.delete(key); });
  queues.set(key, done);
};
/** a shared mapping at va of `lease`, which covers the file from offset `start`. Like a read of the file, it
 *  holds what this process's other mappings of the file stored. */
export async function mapLease(va: bigint, lease: ProcessMapping, start: number, prot: number): Promise<void> {
  for (const m of maps) if (m.owner?.lease.region === lease.region) flush(m);
  await queues.get(lease.region);
  const bytes = await lease.read(0, lease.size);
  mem.write(guestAt(va), bytes);
  maps.push({ va, n: lease.size, off: start, owner: { lease, start }, shared: true, base: prot & 2 ? bytes.slice() : null });
}
/** a shared mapping at va of [off, off + n) of the file `fd` reaches in another process; an errno, or 0. File bytes past
 *  EOF are not the file's, so the lease covers what the file holds and the rest of the mapping stays zero. */
export async function mapRemoteShared(va: bigint, n: number, off: number, fd: number, prot: number): Promise<number> {
  const remote = remoteOf(fd), stat = await remote?.stat();
  if (!remote || !stat) return E.BADF;
  const length = Math.max(0, Math.min(n, stat.size - off));
  if (!length) return 0;
  const lease = await remote.map(off, length, prot);
  if (typeof lease === "number") return -lease;
  await mapLease(va, lease, off, prot);
  return 0;
}
/** this process's stores through remote mappings, on their way to their files, where another process sees them */
export function settleRemoteMaps(): Promise<unknown> | null {
  if (!maps.some((m) => m.owner)) return null;
  for (const m of maps) if (m.owner) flush(m);
  return Promise.all(queues.values());
}

/** msync or munmap of [va, va + n): the files mapped there are flushed; with `drop` the range stops
 *  being mapped, and a lease no mapping holds any more goes back to its owner */
export function syncShared(va: bigint, n: number, drop: boolean): void {
  const end = va + BigInt(n);
  if (!maps.some((m) => overlaps(m, va, end))) return;
  const hit = maps.filter((m) => overlaps(m, va, end)), files = new Set<VfsFile>(), owners = new Set<Lease>();
  for (const m of hit) if (m.owner) { flush(m); owners.add(m.owner); } else if (m.shared) files.add(m.file);
  for (const file of files) file.sharedMaps?.flush();
  if (!drop) return;
  maps = maps.flatMap((m) => cut(m, va, end));
  for (const file of files) if (!maps.some((m) => m.shared && m.file === file)) file.sharedMaps = undefined;
  for (const owner of owners) if (!maps.some((m) => m.owner === owner)) leased(owner, () => owner.lease.close());
}
/** the parts of a mapping outside [va, end), and the part inside */
function cut(m: Mapping, va: bigint, end: bigint, inside?: (part: Mapping) => void): Mapping[] {
  if (!overlaps(m, va, end)) return [m];
  const part = (from: number, to: number): Mapping => ({ ...m, va: m.va + BigInt(from), n: to - from, off: m.off + from, base: m.base?.slice(from, to) ?? null });
  const lo = m.va < va ? Number(va - m.va) : 0, hi = Math.min(m.n, Number(end - m.va)), kept: Mapping[] = [];
  if (lo) kept.push(part(0, lo));
  if (hi < m.n) kept.push(part(hi, m.n));
  inside?.(part(lo, hi));
  return kept;
}

/** mremap's move of [old, old + n), whose bytes are at `to` now: each file mapping there keeps its
 *  file range, its page cache and the stores it has not synced */
export function moveMaps(old: bigint, n: number, to: bigint): void {
  const end = old + BigInt(n), moved: Mapping[] = [];
  maps = maps.flatMap((m) => cut(m, old, end, (part) => moved.push({ ...part, va: to + (part.va - old) })));
  maps.push(...moved);
}
/** the file of this process the mapping at va maps, at the offset va holds, which mremap's growth
 *  reads on from; another process's file is leased only as far as it was mapped */
export function fileMapAt(va: bigint): { file: VfsFile; off: number } | null {
  const m = mapAt(va);
  return m?.file ? { file: m.file, off: m.off + Number(va - m.va) } : null;
}
/** mremap's growth of the mapping at va to `size` bytes from there, which hold the file's bytes now */
export function growMap(va: bigint, size: number): void {
  const m = mapAt(va), n = m ? Number(va - m.va) + size : 0;
  if (!m || n <= m.n) return;
  if (m.base) {
    const base = new Uint8Array(n);
    base.set(m.base); base.set(mem.bytes(guestAt(m.va, m.n), n - m.n), m.n);
    m.base = base;
  }
  m.n = n;
}

/** whether any byte of [va, va+n) is a shared file mapping */
export function isShared(va: bigint, n: number): boolean {
  const end = va + BigInt(n);
  return maps.some((m) => m.shared && overlaps(m, va, end));
}
