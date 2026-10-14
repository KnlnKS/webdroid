import { zipTree } from "../jvm/natives/jzip";
import type { FileSource } from "./lazyfile";
import { isDexEntry } from "../jvm/dex";

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
  readonly size: number;
  readonly zip: Record<string, Uint8Array> = {};
  private pending = new Map<string, Promise<Uint8Array>>();
  private raw = new Map<string, Uint8Array>();
  private rawPending = new Map<string, Promise<Uint8Array>>();
  private resident = 0;

  constructor(readonly index: PackedArchiveIndex, readonly base: string) { this.size = index.size; }
  async prepare(code = false): Promise<void> {
    const bootstrap = await this.file(this.index.bootstrap);
    zipTree(bootstrap, this.zip);
    if (code) await Promise.all(Object.keys(this.index.entries).filter(isDexEntry).map((n) => this.entry(n)));
  }
  has(name: string): boolean { return Object.hasOwn(this.index.entries, name); }
  names(): string[] { return Object.keys(this.index.entries); }
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
  private async original(file: string): Promise<Uint8Array> {
    const cached = this.raw.get(file);
    if (cached) { this.raw.delete(file); this.raw.set(file, cached); return cached; }
    let pending = this.rawPending.get(file);
    if (!pending) {
      pending = fetch(this.base + file + "?raw=1").then(async (response) => {
        if (!response.ok) throw new Error("Packed source unavailable: " + file);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (await sha256(bytes) !== file.split(".")[0]) throw new Error("Packed source digest mismatch: " + file);
        this.raw.set(file, bytes); this.resident += bytes.length;
        while (this.resident > 32 * 1024 * 1024 && this.raw.size > 1) {
          const oldest = this.raw.entries().next().value!;
          this.raw.delete(oldest[0]); this.resident -= oldest[1].length;
        }
        return bytes;
      }).finally(() => this.rawPending.delete(file));
      this.rawPending.set(file, pending);
    }
    return pending;
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    const start = Math.max(0, Math.min(this.size, offset)), end = Math.min(this.size, start + Math.max(0, length));
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
