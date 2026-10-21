import { zipTree } from "../zip.ts";
import { ChunkCache, clampRange, type FileSource } from "./lazyfile.ts";
import { isDexEntry } from "../jvm/dex.ts";

type PackedFile = { file: string; size: number; sha256: string };
export type PackedArchiveIndex = {
  version: 1;
  pkg: string;
  sha256: string;
  size: number;
  certificates: string[];
  bootstrap: PackedFile;
  entries: Record<string, PackedFile>;
  spans: [number, number, string, number][];
};
export const packedArchives = new Map<string, PackedArchive>();
/** the app's own archives, whose dex the process loaded at boot: a loader over them (LoadedApk's) is
 *  the app's class loader, over the classes the process already holds */
export const appArchives = new Set<string>();
export async function sha256(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer instanceof ArrayBuffer ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input)).toHex();
}
/** a system package packed under /vendor/microg/, checked against the digests the build pinned, with its bootstrap read */
export async function systemPackage(spec: { file: string; sha256: string; indexSha256: string }): Promise<PackedArchive> {
  const response = await fetch(SYSTEM_PACKAGE_BASE + spec.file.replace(/\.apk$/, ".json"));
  if (!response.ok) throw new Error(`System package unavailable: ${spec.file}: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (await sha256(bytes) !== spec.indexSha256) throw new Error(`System package index digest mismatch: ${spec.file}`);
  const index: PackedArchiveIndex = JSON.parse(new TextDecoder().decode(bytes));
  if (index.version !== 1 || index.sha256 !== spec.sha256) throw new Error(`System package source mismatch: ${spec.file}`);
  const packed = new PackedArchive(index, SYSTEM_PACKAGE_BASE);
  await packed.prepare();
  return packed;
}
export const SYSTEM_PACKAGE_BASE = "/vendor/microg/";
export class PackedArchive implements FileSource {
  readonly index: PackedArchiveIndex; readonly base: string;
  readonly size: number;
  readonly zip: Record<string, Uint8Array> = {};
  private pending = new Map<string, Promise<Uint8Array>>();
  private raw = new ChunkCache<string>(32 << 20);

  constructor(index: PackedArchiveIndex, base: string) { this.index = index; this.base = base; this.size = index.size; }
  async prepare(code = false): Promise<void> {
    const bootstrap = await this.file(this.index.bootstrap);
    zipTree(bootstrap, this.zip);
    if (code) await Promise.all(Object.keys(this.index.entries).filter(isDexEntry).map((n) => this.entry(n)));
  }
  has(name: string): boolean { return Object.hasOwn(this.index.entries, name); }
  names(): string[] { return Object.keys(this.index.entries); }
  entrySize(name: string): number { return this.index.entries[name].size; }
  async entry(name: string): Promise<Uint8Array | null> {
    if (Object.hasOwn(this.zip, name)) return this.zip[name];
    const file = this.index.entries[name];
    if (!file) return null;
    return this.zip[name] = await this.file(file);
  }
  private file(file: PackedFile): Promise<Uint8Array> {
    let pending = this.pending.get(file.file);
    if (!pending) {
      pending = fetch(this.base + file.file).then(async (response) => {
        if (!response.ok) throw new Error(`Packed entry unavailable: ${file.file}: ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length !== file.size || await sha256(bytes) !== file.sha256) throw new Error("Packed entry digest mismatch: " + file.file);
        return bytes;
      }).catch((error: unknown) => { this.pending.delete(file.file); throw error; });
      this.pending.set(file.file, pending);
    }
    return pending;
  }
  private original(file: string): Promise<Uint8Array> {
    return this.raw.get(file, async () => {
      const response = await fetch(this.base + file + "?raw=1");
      if (!response.ok) throw new Error("Packed source unavailable: " + file);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (await sha256(bytes) !== file.split(".")[0]) throw new Error("Packed source digest mismatch: " + file);
      return bytes;
    });
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const [start, end] = clampRange(this.size, offset, length);
    const out = new Uint8Array(end - start), spans = this.index.spans;
    let lo = 0, hi = spans.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (spans[mid][0] + spans[mid][1] <= start) lo = mid + 1; else hi = mid; }
    for (let i = lo; i < spans.length && spans[i][0] < end; i++) {
      const [at, size, file, fileOffset] = spans[i], from = Math.max(start, at), to = Math.min(end, at + size);
      const bytes = await this.original(file);
      out.set(bytes.subarray(fileOffset + from - at, fileOffset + to - at), from - start);
    }
    return out;
  }
}
