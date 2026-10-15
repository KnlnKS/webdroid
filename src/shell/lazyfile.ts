export interface FileSource {
  readonly size: number;
  read(offset: number, length: number): Uint8Array | Promise<Uint8Array>;
}

/** a source that also takes writes; they are ordered with its later reads */
export interface WritableSource extends FileSource {
  size: number;
  write(offset: number, bytes: Uint8Array): void;
  truncate(size: number): void;
}
export const writable = (source: FileSource | null | undefined): source is WritableSource => !!source && "write" in source;

export class BytesFile implements FileSource {
  readonly size: number;

  constructor(readonly bytes: Uint8Array) {
    this.size = bytes.length;
  }

  read(offset: number, length: number): Uint8Array {
    const start = Math.max(0, Math.min(this.size, offset));
    return this.bytes.subarray(start, Math.min(this.size, start + Math.max(0, length)));
  }
}

export class BlobFile implements FileSource {
  readonly size: number;

  constructor(private readonly blob: Blob) {
    this.size = blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(this.size, offset));
    return new Uint8Array(await this.blob.slice(start, start + Math.max(0, length)).arrayBuffer());
  }
}

export class SliceFile implements FileSource {
  readonly size: number;

  constructor(readonly source: FileSource, readonly offset: number, size: number) {
    this.size = size;
  }

  read(offset: number, length: number): Uint8Array | Promise<Uint8Array> {
    const start = Math.max(0, Math.min(this.size, offset));
    return this.source.read(this.offset + start, Math.min(Math.max(0, length), this.size - start));
  }
}

/** `length` bytes at `offset`, fewer only at the end: a source may answer one read in chunks */
export function readAt(source: FileSource, offset: number, length: number): Uint8Array | Promise<Uint8Array> {
  const complete = (first: Uint8Array): Uint8Array | Promise<Uint8Array> => first.length >= length || !first.length ? first
    : readFully(source, offset + first.length, length - first.length).then((rest) => {
      const out = new Uint8Array(first.length + rest.length);
      out.set(first); out.set(rest, first.length);
      return out;
    });
  const first = source.read(offset, length);
  return first instanceof Promise ? first.then(complete) : complete(first);
}

export async function readFully(source: FileSource, offset = 0, length = source.size - offset): Promise<Uint8Array> {
  const end = Math.min(source.size, offset + Math.max(0, length));
  const size = Math.max(0, end - offset);
  if (!size) return new Uint8Array(0);
  const first = await source.read(offset, size);
  // Media parsers pass .buffer directly, so a returned view must own its whole buffer.
  if (first.length >= size) return first.byteOffset === 0 && first.byteLength === first.buffer.byteLength && first.length === size
    ? first : first.slice(0, size);
  const out = new Uint8Array(size);
  out.set(first);
  let pos = first.length;
  while (offset + pos < end) {
    const chunk = await source.read(offset + pos, end - offset - pos);
    if (!chunk.length) break;
    out.set(chunk.subarray(0, end - offset - pos), pos);
    pos += chunk.length;
  }
  return pos === out.length ? out : out.slice(0, pos);
}

export class RangeFile implements FileSource {
  private readonly chunks = new Map<number, Uint8Array>();
  private readonly inflight = new Map<number, Promise<Uint8Array>>();
  private lastEnd = -1;

  constructor(
    readonly url: string,
    readonly size: number,
    private readonly chunkSize = 1 << 20,
    private readonly maxChunks = 32,
  ) {}

  static async open(url: string): Promise<FileSource> {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) throw new Error(`HEAD ${url}: ${response.status}`);
    const header = response.headers.get("content-length");
    if (header !== null && /^\d+$/.test(header) && Number.isSafeInteger(Number(header)))
      return new RangeFile(url, Number(header));
    const probe = await fetch(url, { headers: { Range: "bytes=0-0" } });
    if (probe.status === 206) {
      const match = /^bytes 0-0\/(\d+)$/.exec(probe.headers.get("content-range") ?? "");
      await probe.body?.cancel();
      if (match && Number.isSafeInteger(Number(match[1]))) return new RangeFile(url, Number(match[1]));
    }
    if (probe.status === 200) return new BytesFile(new Uint8Array(await probe.arrayBuffer()));
    throw new Error(`range probe ${url}: ${probe.status}`);
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(this.size, offset));
    const end = Math.min(this.size, start + Math.max(0, length));
    if (start === end) return Promise.resolve(new Uint8Array(0));
    if (end - start >= this.chunkSize * 8) {
      this.lastEnd = end;
      return this.range(start, end - 1);
    }
    const index = Math.floor(start / this.chunkSize);
    const within = start - index * this.chunkSize;
    const wanted = Math.min(end - start, this.chunkSize - within);
    const sequential = start === this.lastEnd;
    const readEnd = start + wanted;
    this.lastEnd = readEnd;
    return this.chunk(index).then((chunk) => {
      if (sequential && readEnd < this.size) void this.chunk(Math.floor(readEnd / this.chunkSize)).catch(() => {});
      return chunk.subarray(within, within + wanted);
    });
  }

  private chunk(index: number): Promise<Uint8Array> {
    const cached = this.chunks.get(index);
    if (cached) {
      this.chunks.delete(index);
      this.chunks.set(index, cached);
      return Promise.resolve(cached);
    }
    const pending = this.inflight.get(index);
    if (pending) return pending;
    const start = index * this.chunkSize;
    const end = Math.min(this.size, start + this.chunkSize) - 1;
    const request = this.range(start, end).then((bytes) => {
      this.chunks.set(index, bytes);
      while (this.chunks.size > this.maxChunks) {
        const oldest = this.chunks.keys().next();
        if (oldest.done) break;
        this.chunks.delete(oldest.value);
      }
      return bytes;
    }).finally(() => this.inflight.delete(index));
    this.inflight.set(index, request);
    return request;
  }

  private async range(start: number, end: number): Promise<Uint8Array> {
    const response = await fetch(this.url, { headers: { Range: `bytes=${start}-${end}` } });
    if (response.status !== 206) {
      await response.body?.cancel();
      throw new Error(`range ${start}-${end} from ${this.url}: ${response.status}`);
    }
    const contentRange = response.headers.get("content-range");
    const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (!match || Number(match[1]) !== start || Number(match[2]) !== end || Number(match[3]) !== this.size) {
      await response.body?.cancel();
      throw new Error(`range ${start}-${end} from ${this.url}: invalid Content-Range ${contentRange ?? "(missing)"}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== end - start + 1) throw new Error(`short range ${start}-${end} from ${this.url}: ${bytes.length}`);
    return bytes;
  }
}
