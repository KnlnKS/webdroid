import { readFully, type WritableSource } from "./lazyfile";

export const SHARED_PAGE_SIZE = 4096, SHARED_GRANULE_SIZE = 64;
export type SharedFilePage = { offset: number; generation: number; state: SharedArrayBuffer; bytes: SharedArrayBuffer; versions: SharedArrayBuffer };
export type SharedFileLease = { state: SharedArrayBuffer; length: SharedArrayBuffer; pages: SharedFilePage[]; release(): void };
type Page = { bytes: Uint8Array; versions: BigUint64Array; state: BigUint64Array; generation: number; pins: number };

class MemoryFile implements WritableSource {
  size: number;
  constructor(private bytes: Uint8Array) { this.size = bytes.length; }
  read(offset: number, length: number): Uint8Array { return this.bytes.subarray(offset, Math.min(this.size, offset + length)); }
  write(offset: number, bytes: Uint8Array): void {
    const end = offset + bytes.length;
    if (end > this.bytes.length) {
      const grown = new Uint8Array(Math.max(end, this.bytes.length * 2, SHARED_PAGE_SIZE));
      grown.set(this.bytes.subarray(0, this.size)); this.bytes = grown;
    }
    if (offset > this.size) this.bytes.fill(0, this.size, offset);
    this.bytes.set(bytes, offset); this.size = Math.max(this.size, end);
  }
  truncate(size: number): void {
    if (size > this.size) this.write(size - 1, Uint8Array.of(0));
    else this.bytes.fill(0, size, this.size);
    this.size = size;
  }
}

/** Only pinned pages are resident. The backing source stores other bytes and persistence;
 * reads never expose its stale copy of a resident page as a writable alias. */
export class SharedFile implements WritableSource {
  private readonly length = new BigInt64Array(new SharedArrayBuffer(8));
  private readonly pages = new Map<number, Page>();
  private revision = 0;
  private generation = 0;
  constructor(private store: WritableSource) { this.size = store.size; }
  get backing(): WritableSource { return this.store; }
  static memory(bytes: Uint8Array): SharedFile { return new SharedFile(new MemoryFile(bytes.slice())); }
  get size(): number { return Number(Atomics.load(this.length, 0)); }
  set size(size: number) { Atomics.store(this.length, 0, BigInt(size)); }
  get pinned(): boolean { return this.pages.size !== 0; }
  get epoch(): number { return this.revision; }

  memoryBytes(): Uint8Array | null {
    return this.backing instanceof MemoryFile ? this.overlay(0, this.backing.read(0, this.size).slice()) : null;
  }
  replaceBacking(backing: WritableSource): void {
    if (backing.size !== this.size) throw new RangeError("shared file backing size");
    this.revision++; this.store = backing;
  }
  read(offset: number, length: number): Uint8Array | Promise<Uint8Array> {
    const start = Math.max(0, Math.min(this.size, offset)), count = Math.min(Math.max(0, length), this.size - start);
    const at = Math.floor(start / SHARED_PAGE_SIZE) * SHARED_PAGE_SIZE, page = this.pages.get(at);
    if (page && start + count <= at + SHARED_PAGE_SIZE) return page.bytes.slice(start - at, start - at + count);
    const result = this.backing.read(start, count);
    return result instanceof Uint8Array ? this.overlay(start, result.slice()) : result.then(bytes => this.overlay(start, bytes.slice()));
  }
  private overlay(offset: number, bytes: Uint8Array): Uint8Array {
    for (let at = Math.floor(offset / SHARED_PAGE_SIZE) * SHARED_PAGE_SIZE; at < offset + bytes.length; at += SHARED_PAGE_SIZE) {
      const page = this.pages.get(at);
      if (!page) continue;
      const lo = Math.max(offset, at), hi = Math.min(offset + bytes.length, at + SHARED_PAGE_SIZE);
      bytes.set(page.bytes.subarray(lo - at, hi - at), lo - offset);
    }
    return bytes;
  }
  private changed(page: Page, from: number, to: number): void {
    for (let granule = Math.floor(from / SHARED_GRANULE_SIZE); granule < Math.ceil(to / SHARED_GRANULE_SIZE); granule++) Atomics.add(page.versions, granule, 1n);
  }
  write(offset: number, bytes: Uint8Array): void {
    if (!bytes.length) return;
    this.revision++;
    if (offset > this.size) this.zero(this.size, offset);
    for (let at = Math.floor(offset / SHARED_PAGE_SIZE) * SHARED_PAGE_SIZE; at < offset + bytes.length; at += SHARED_PAGE_SIZE) {
      const page = this.pages.get(at);
      if (!page) continue;
      const lo = Math.max(offset, at), hi = Math.min(offset + bytes.length, at + SHARED_PAGE_SIZE);
      if (lo >= hi) continue;
      page.bytes.set(bytes.subarray(lo - offset, hi - offset), lo - at);
      this.changed(page, lo - at, hi - at);
    }
    this.backing.write(offset, bytes.slice());
    this.size = Math.max(this.size, offset + bytes.length);
  }
  truncate(size: number): void {
    this.revision++;
    this.zero(Math.min(size, this.size), Infinity);
    this.backing.truncate(size); this.size = size;
  }
  private zero(from: number, to: number): void {
    for (const [at, page] of this.pages) {
      const lo = Math.max(0, from - at), hi = Math.min(SHARED_PAGE_SIZE, to - at);
      if (lo >= hi) continue;
      page.bytes.fill(0, lo, hi); this.changed(page, lo, hi);
    }
  }
  async acquire(offset: number, length: number): Promise<SharedFileLease> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || offset > this.size - length) throw new RangeError("shared file range");
    const pinned: [number, Page][] = [];
    try {
      for (let at = Math.floor(offset / SHARED_PAGE_SIZE) * SHARED_PAGE_SIZE; at < offset + length; at += SHARED_PAGE_SIZE) {
        let page = this.pages.get(at);
        if (!page) {
          let bytes: Uint8Array, revision: number;
          do { revision = this.revision; bytes = await readFully(this.backing, at, SHARED_PAGE_SIZE); } while (revision !== this.revision);
          page = this.pages.get(at);
          if (!page) {
            const data = new Uint8Array(new SharedArrayBuffer(SHARED_PAGE_SIZE)); data.set(bytes);
            const generation = ++this.generation, state = new BigUint64Array(new SharedArrayBuffer(8)); Atomics.store(state, 0, BigInt(generation));
            page = {bytes:data, versions:new BigUint64Array(new SharedArrayBuffer(SHARED_PAGE_SIZE / SHARED_GRANULE_SIZE * 8)), state, generation, pins:0};
            this.pages.set(at, page);
          }
        }
        page.pins++; pinned.push([at, page]);
      }
    } catch (error) { this.release(pinned); throw error; }
    const state = new Int32Array(new SharedArrayBuffer(4)); Atomics.store(state, 0, 1);
    let released = false;
    return {state:state.buffer as SharedArrayBuffer,length:this.length.buffer as SharedArrayBuffer, pages:pinned.map(([offset, page]) => ({offset, generation:page.generation, state:page.state.buffer as SharedArrayBuffer, bytes:page.bytes.buffer as SharedArrayBuffer, versions:page.versions.buffer as SharedArrayBuffer})),
      release:() => { if (!released) { released = true; Atomics.store(state,0,0); this.release(pinned); } }};
  }
  private release(pages: [number, Page][]): void {
    for (const [at, page] of pages) {
      if (--page.pins) continue;
      this.revision++;
      Atomics.store(page.state, 0, 0n);
      const length = Math.min(SHARED_PAGE_SIZE, Math.max(0, this.size - at));
      this.pages.delete(at);
      if (length) this.backing.write(at, page.bytes.slice(0, length));
    }
  }
  flush(): void {
    this.revision++;
    for (const [at, page] of this.pages) {
      const length = Math.min(SHARED_PAGE_SIZE, Math.max(0, this.size - at));
      if (length) this.backing.write(at, page.bytes.slice(0, length));
    }
  }
}
