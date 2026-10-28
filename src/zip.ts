// The zip reader apks, jars and packed archives load through: index the central directory, inflate
// an entry only when it is read.
import { inflate } from "./zlib.ts";
import { utf8 } from "./jvm/abi.ts";
import { readFully, type FileSource } from "./shell/lazyfile.ts";

export interface ZEntry { name: string; method: number; csize: number; size: number; time: number; off: number; }
function dosTime(date: number, time: number): number {
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
}
/** where the end-of-central-directory record starts, scanning back over any archive comment; -1 when there is none */
export function endRecord(z: Uint8Array): number {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  let e = z.length - 22;
  while (e >= 0 && (v.getUint32(e, true) !== 0x06054b50 || e + 22 + v.getUint16(e + 20, true) !== z.length)) e--;
  return e;
}
interface ZipDirectory { offset: number; size: number; entries: number }
function directoryFromTail(z: Uint8Array, fileSize: number): ZipDirectory {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength), e = endRecord(z);
  if (e < 0) throw new Error("End Of Central Directory signature not found");
  const entries = v.getUint16(e + 10, true);
  const size = v.getUint32(e + 12, true);
  const offset = v.getUint32(e + 16, true);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new Error("ZIP64 is not supported");
  if (offset + size > fileSize) throw new Error("Central Directory is outside the archive");
  return { offset, size, entries };
}
function centralDirRecords(z: Uint8Array, entries: number): Map<string, ZEntry> {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  const out = new Map<string, ZEntry>();
  let p = 0;
  for (let n = entries; n > 0; n--) {
    if (p + 46 > z.length || v.getUint32(p, true) !== 0x02014b50) throw new Error("Invalid Central Directory entry");
    const nl = v.getUint16(p + 28, true);
    const name = utf8.dec.decode(z.subarray(p + 46, p + 46 + nl));
    out.set(name, {
      name, method: v.getUint16(p + 10, true), time: dosTime(v.getUint16(p + 14, true), v.getUint16(p + 12, true)),
      csize: v.getUint32(p + 20, true), size: v.getUint32(p + 24, true), off: v.getUint32(p + 42, true),
    });
    p += 46 + nl + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return out;
}
/** the entries of an archive whose last `z.length` bytes are `z` */
function centralDirFromTail(z: Uint8Array, fileSize: number): Map<string, ZEntry> {
  const d = directoryFromTail(z, fileSize);
  const start = d.offset - (fileSize - z.length);
  if (start < 0 || start + d.size > z.length) throw new Error(`Central Directory needs range ${d.offset}-${d.offset + d.size - 1}`);
  return centralDirRecords(z.subarray(start, start + d.size), d.entries);
}
export const centralDir = (z: Uint8Array): Map<string, ZEntry> => centralDirFromTail(z, z.length);
export async function centralDirOfSource(source: FileSource): Promise<Map<string, ZEntry>> {
  const tailSize = Math.min(22 + 0xffff, source.size);
  const tail = await readFully(source, source.size - tailSize, tailSize);
  const info = directoryFromTail(tail, source.size);
  if (info.offset >= source.size - tail.length) return centralDirFromTail(tail, source.size);
  return centralDirRecords(await readFully(source, info.offset, info.size), info.entries);
}
/** where an entry's data begins: the local header carries its own name/extra lengths, which
 *  may differ from the central ones */
export function localStart(z: Uint8Array, e: ZEntry): number {
  const v = new DataView(z.buffer, z.byteOffset, z.byteLength);
  return e.off + 30 + v.getUint16(e.off + 26, true) + v.getUint16(e.off + 28, true);
}
export async function localDataOffset(source: FileSource, e: ZEntry): Promise<number> {
  const header = await readFully(source, e.off, 30);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length !== 30 || view.getUint32(0, true) !== 0x04034b50) throw new Error("Invalid local header: " + e.name);
  return e.off + 30 + view.getUint16(26, true) + view.getUint16(28, true);
}
/** an entry's bytes, reading only that entry of the archive */
export async function entryBytesOf(source: FileSource, e: ZEntry): Promise<Uint8Array> {
  return inflateEntry(await readFully(source, await localDataOffset(source, e), e.csize), e);
}
/** the path of an archive's entry, "base.apk!/lib/arm64-v8a/libx.so", as the linker and class loaders name it */
export const archivePath = (archive: string, entry: string): string => `${archive}!/${entry}`;
/** an archivePath's archive and entry, null for a path of a file of its own */
export function archiveEntry(path: string): { archive: string; entry: string } | null {
  const bang = path.indexOf("!/");
  return bang < 0 ? null : { archive: path.slice(0, bang), entry: path.slice(bang + 2) };
}
export function entryBytes(z: Uint8Array, e: ZEntry): Uint8Array {
  const start = localStart(z, e);
  return inflateEntry(z.subarray(start, start + e.csize), e);
}
export function inflateEntry(raw: Uint8Array, e: ZEntry): Uint8Array {
  if (e.method === 0) return raw;
  if (e.method === 8) return inflate(raw, e.size, -15);
  throw new Error("Invalid compression method " + e.method + ": " + e.name);
}

/** A zip as the file tree the rest of the boot reads, materialised one entry at a time: a
 *  stored entry is a view into bytes we already hold and costs nothing, a deflated one is
 *  inflated on first read and then replaces its own accessor, so a second read is a plain
 *  property. `Object.keys` stays free; `Object.entries` inflates the whole tree, which is why
 *  nothing on the boot path uses it. `rename` returns null to drop an entry. */
export function zipTree(z: Uint8Array, into: Record<string, Uint8Array> = {}, rename?: (n: string) => string | null): Record<string, Uint8Array> {
  let pending = lazyEntries.get(into);
  if (!pending) lazyEntries.set(into, pending = new Map());
  for (const e of centralDir(z).values()) {
    if (e.name.endsWith("/")) continue;
    const name = rename ? rename(e.name) : e.name;
    if (name === null || Object.prototype.hasOwnProperty.call(into, name)) continue;
    const pin = (value: Uint8Array) => {
      pending.delete(name);
      Object.defineProperty(into, name, { value, writable: true, enumerable: true, configurable: true });
      return value;
    };
    if (e.method === 8) pending.set(name, [z, e]);
    Object.defineProperty(into, name, {
      enumerable: true, configurable: true,
      get: () => pin(entryBytes(z, e)),
      set: pin,
    });
  }
  return into;
}
const lazyEntries = new WeakMap<Record<string, Uint8Array>, Map<string, [Uint8Array, ZEntry]>>();
/** the size of a tree's entry, without inflating it */
export const treeEntrySize = (tree: Record<string, Uint8Array>, name: string): number => lazyEntries.get(tree)?.get(name)?.[1].size ?? tree[name].length;
/** Inflate a tree's still-compressed entries that `wanted` names with the platform's native
 *  inflater, concurrently, ahead of the synchronous reads that would otherwise inflate in JS. */
export async function inflateTree(tree: Record<string, Uint8Array>, wanted: (name: string) => boolean): Promise<void> {
  const pending = lazyEntries.get(tree);
  if (!pending || typeof DecompressionStream === "undefined") return;
  await Promise.all([...pending].filter(([name]) => wanted(name)).map(async ([name, [z, e]]) => {
    const start = localStart(z, e);
    const stream = new Blob([z.subarray(start, start + e.csize) as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    if (pending.has(name)) tree[name] = bytes;
  }));
}
