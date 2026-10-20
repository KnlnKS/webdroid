// MAP_SHARED file mappings. Guest memory cannot alias one page at two addresses, so each mapping is
// a copy of its file range, made coherent where a program can observe the file: msync, munmap, a
// read of the file (which a new mapping is) and a write to it. A writable mapping keeps the bytes it
// last agreed on with the file, so a sync carries exactly the bytes stored through it to the file
// and into every other mapping of them, and never an older copy of bytes another mapping stored.
// The mappings live on their VfsFile, whose writeAt and reads drive them for every writer and reader.
// A file another process owns (a process Worker's) is mapped through its owner's lease instead, by
// native and Java code alike: the bytes are read in when mapped and stores go back through the lease at
// msync and munmap, reaching this process's other mappings of the file then, and before a descriptor
// leaves for another process; stores of other processes reach a mapping only when it is mapped again.
import { guestAt, mem } from "./mem.ts";
import { vfs, type VfsFile } from "../shell/vfs.ts";
import { E } from "./abi.ts";
import type { ProcessMapping } from "./process-fd.ts";
import { openFd } from "./fd.ts";

type SharedMapping = { va: bigint; n: number; off: number; base: Uint8Array | null };
const overlaps = (m: SharedMapping, va: bigint, end: bigint) => m.va < end && va < m.va + BigInt(m.n);

/** the shared mappings of one file */
export class SharedMaps {
  readonly file: VfsFile;
  maps: SharedMapping[] = [];
  /** the mapping a flush is writing back, which already holds its bytes */
  private from: SharedMapping | null = null;
  constructor(file: VfsFile) { this.file = file; }
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
      // The last mapped page includes bytes past EOF. Stores there belong to the
      // mapping/page cache and must not extend the backing file when flushed.
      stored(m, Math.max(0, Math.min(m.n, this.file.len - m.off)), (i, bytes) => {
        this.from = m;
        try { vfs.writeAt(this.file, m.off + i, bytes); } finally { this.from = null; }
      });
    }
  }
}
/** the runs of the first `length` bytes stored through writable mapping `m` since it last agreed with its file, which its base takes */
function stored(m: SharedMapping, length: number, write: (at: number, bytes: Uint8Array) => void): void {
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
const mapped = new Set<SharedMaps>();

/** a shared mapping of [off, off + n) of the file at va, holding the file's bytes */
export function trackSharedMap(va: bigint, n: number, off: number, file: VfsFile, writable: boolean): void {
  const at = guestAt(va), shared = file.sharedMaps ??= new SharedMaps(file);
  shared.maps.push({ va, n, off, base: writable ? mem.u8.slice(at, at + n) : null });
  mapped.add(shared);
}

/** `off` of a remote mapping is its offset in the lease, which starts at offset `start` of the file */
type Lease = { lease: ProcessMapping; start: number };
type RemoteMapping = SharedMapping & { owner: Lease };
let remoteMaps: RemoteMapping[] = [];
/** the lease operations not yet done on each file (by its owner's region), which run in order and a new mapping of the file waits for */
const queues = new Map<number, Promise<void>>();
const leased = (owner: Lease, operation: () => Promise<void>) => {
  const key = owner.lease.region;
  const done: Promise<void> = (queues.get(key) ?? Promise.resolve()).then(operation).catch((error) => console.error("[mmap]", error))
    .then(() => { if (queues.get(key) === done) queues.delete(key); });
  queues.set(key, done);
};
/** The stores through remote mapping `m` go to its file, and into this process's other mappings of that
 *  file, which one page cache would share */
function flushRemote(m: RemoteMapping): void {
  const { owner } = m, { region } = owner.lease;
  stored(m, m.n, (i, bytes) => {
    leased(owner, () => owner.lease.write(m.off + i, bytes));
    const at = owner.start + m.off + i;
    for (const o of remoteMaps) {
      if (o === m || o.owner.lease.region !== region) continue;
      const from = o.owner.start + o.off, lo = Math.max(at, from), hi = Math.min(at + bytes.length, from + o.n);
      if (lo >= hi) continue;
      const part = bytes.subarray(lo - at, hi - at);
      mem.write(guestAt(o.va, lo - from), part);
      o.base?.set(part, lo - from);
    }
  });
}
/** a shared mapping at va of `lease`, which covers the file from offset `start`. Like a read of the file, it
 *  holds what this process's other mappings of the file stored. */
export async function mapLease(va: bigint, lease: ProcessMapping, start: number, prot: number): Promise<void> {
  for (const m of remoteMaps) if (m.owner.lease.region === lease.region) flushRemote(m);
  await queues.get(lease.region);
  const bytes = await lease.read(0, lease.size);
  mem.write(guestAt(va), bytes);
  remoteMaps.push({ va, n: lease.size, off: 0, base: prot & 2 ? bytes.slice() : null, owner: { lease, start } });
}
/** a shared mapping at va of [off, off + n) of the file `fd` reaches in another process; an errno, or 0. File bytes past
 *  EOF are not the file's, so the lease covers what the file holds and the rest of the mapping stays zero. */
export async function mapRemoteShared(va: bigint, n: number, off: number, fd: number, prot: number): Promise<number> {
  const remote = openFd(fd)?.remote, stat = await remote?.stat();
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
  if (!remoteMaps.length) return null;
  for (const m of remoteMaps) flushRemote(m);
  return Promise.all(queues.values());
}

/** private file mappings: the file range each copied, which mremap's growth reads on from */
type PrivateMapping = SharedMapping & { file: VfsFile };
let privateMaps: PrivateMapping[] = [];
export function trackPrivateMap(va: bigint, n: number, off: number, file: VfsFile): void {
  privateMaps.push({ va, n, off, file, base: null });
}

/** msync or munmap of [va, va + n): the files mapped there are flushed; with `drop` the range stops
 *  being mapped */
export function syncShared(va: bigint, n: number, drop: boolean): void {
  const end = va + BigInt(n);
  if (drop && privateMaps.some((m) => overlaps(m, va, end))) privateMaps = privateMaps.flatMap((m) => cut(m, va, end));
  if (remoteMaps.some((m) => overlaps(m, va, end))) {
    for (const m of remoteMaps) if (overlaps(m, va, end)) flushRemote(m);
    if (drop) {
      const before = remoteMaps;
      remoteMaps = remoteMaps.flatMap((m) => cut(m, va, end));
      const live = new Set(remoteMaps.map((m) => m.owner));
      for (const { owner } of before) if (!live.has(owner)) { live.add(owner); leased(owner, () => owner.lease.close()); }
    }
  }
  for (const shared of mapped) {
    if (!shared.maps.some((m) => overlaps(m, va, end))) continue;
    shared.flush();
    if (!drop) continue;
    shared.maps = shared.maps.flatMap((m) => cut(m, va, end));
    if (!shared.maps.length) { mapped.delete(shared); shared.file.sharedMaps = undefined; }
  }
}
/** what is left of a mapping once [va, end) stops being mapped */
function cut<M extends SharedMapping>(m: M, va: bigint, end: bigint): M[] {
  if (!overlaps(m, va, end)) return [m];
  const mEnd = m.va + BigInt(m.n), left = m.va < va ? Number(va - m.va) : 0, right = mEnd > end ? Number(mEnd - end) : 0, kept: M[] = [];
  if (left) kept.push({ ...m, n: left, base: m.base?.slice(0, left) ?? null });
  if (right) kept.push({ ...m, va: end, n: right, off: m.off + m.n - right, base: m.base?.slice(m.n - right) ?? null });
  return kept;
}

/** the file range the file mapping at va holds from there, which mremap carries along */
export function fileMapAt(va: bigint): { file: VfsFile; off: number; shared: boolean; writable: boolean } | null {
  for (const shared of mapped) for (const m of shared.maps) {
    if (overlaps(m, va, va + 1n)) return { file: shared.file, off: m.off + Number(va - m.va), shared: true, writable: !!m.base };
  }
  const m = privateMaps.find((m) => overlaps(m, va, va + 1n));
  return m ? { file: m.file, off: m.off + Number(va - m.va), shared: false, writable: false } : null;
}

/** whether any byte of [va, va+n) is a shared file mapping */
export function isShared(va: bigint, n: number): boolean {
  const end = va + BigInt(n);
  for (const shared of mapped) if (shared.maps.some((m) => overlaps(m, va, end))) return true;
  return remoteMaps.some((m) => overlaps(m, va, end));
}
