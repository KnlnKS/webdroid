// A split install (.xapk, .apks, an App Bundle's output) is a zip of apks rather than an apk.
// Shared by the shell, the dev server's /asset route and the bun scripts, so an xapk is an apk
// everywhere or nowhere.

import { parseAXML, attrStr } from "../android/axml";
import { inflateSync } from "fflate";
import { centralDirFromTail, centralDirInfoFromTail, centralDirRecords, zipTree, type ZEntry } from "../jvm/natives/jzip";
import { BytesFile, RangeFile, SliceFile, readFully, type FileSource } from "./lazyfile";

/** A split install (.xapk, .apks, an App Bundle's output) is a zip of apks rather than an
 *  apk: a base and its config/feature splits. Merge them into the one tree the rest of the
 *  boot expects — the base wins every conflict, exactly as the base's dex is first on a
 *  device's class path, and each split's dex keeps a distinct name so both survive. */
export interface Install {
  zip: Record<string, Uint8Array>;
  lazyEntries: Map<string, FileSource>;
  /** the base apk's own bytes: what sourceDir names and what ZipFile(sourceDir) must open */
  base: Uint8Array;
  splits: { name: string; source: FileSource; bytes: Uint8Array | null }[];
}
type OpenedApk = { source: FileSource; split: string | null; hasManifest: boolean } & (
  { kind: "resident"; bytes: Uint8Array; zip: Record<string, Uint8Array> }
  | { kind: "lazy"; bytes: null; zip: null; entries: Map<string, ZEntry> }
);

function mergeInstall(opened: OpenedApk[]): Install {
  const base = opened.find((o) => o.hasManifest && !o.split);
  if (!base || base.kind !== "resident") throw new Error("split install has no resident base apk");
  const merged = base.zip;
  const lazyEntries = new Map<string, FileSource>();
  const splits: Install["splits"] = [];
  let extra = 0;
  for (const o of opened) {
    if (o === base) continue;
    if (o.kind === "resident") zipTree(o.bytes, merged, (path) => {
      const target = path === "AndroidManifest.xml" || path === "resources.arsc" || path.startsWith("META-INF/") ? null
        : /^classes\d*\.dex$/.test(path) ? `classes${1000 + extra++}.dex` : path;
      if (target) lazyEntries.delete(target);
      return target;
    });
    else for (const [path, entry] of o.entries) {
      if (path === "AndroidManifest.xml" || path === "resources.arsc" || path.startsWith("META-INF/") || path.endsWith("/")) continue;
      delete merged[path];
      lazyEntries.set(path, new ZipEntryFile(o.source, entry));
    }
    if (o.split) splits.push({ name: o.split, source: o.source, bytes: o.bytes });
    console.log("[webdroid] split", o.split ?? "(unnamed)", o.kind === "resident" ? Object.keys(o.zip).length : "lazy", "entries");
  }
  return { zip: merged, lazyEntries, base: base.bytes, splits };
}

export function openInstall(bytes: Uint8Array): Install {
  const outer = zipTree(bytes);
  if (outer["AndroidManifest.xml"]) return { zip: outer, lazyEntries: new Map(), base: bytes, splits: [] };
  const apks = Object.keys(outer).filter((n) => n.endsWith(".apk"));
  if (!apks.length) throw new Error("no AndroidManifest.xml and no apks inside: not an apk or a split install");
  const opened = apks.map((n) => outer[n]).map((b): OpenedApk => {
    const z = zipTree(b);
    const m = z["AndroidManifest.xml"];
    return { kind: "resident", source: new BytesFile(b), bytes: b, zip: z, split: m ? attrStr(parseAXML(m), "split") : null, hasManifest: !!m };
  });
  return mergeInstall(opened);
}

const TAIL = 22 + 0xffff;
async function zipEntries(source: FileSource): Promise<Map<string, ZEntry>> {
  const tailSize = Math.min(TAIL, source.size);
  const tail = await readFully(source, source.size - tailSize, tailSize);
  const info = centralDirInfoFromTail(tail, source.size);
  if (info.offset >= source.size - tail.length) return centralDirFromTail(tail, source.size);
  return centralDirRecords(await readFully(source, info.offset, info.size), info.entries);
}
async function entryDataOffset(source: FileSource, entry: ZEntry): Promise<number> {
  const header = await readFully(source, entry.off, 30);
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (header.length !== 30 || view.getUint32(0, true) !== 0x04034b50) throw new Error(`invalid local header for ${entry.name}`);
  return entry.off + 30 + view.getUint16(26, true) + view.getUint16(28, true);
}
async function entrySource(source: FileSource, entry: ZEntry): Promise<FileSource> {
  const offset = await entryDataOffset(source, entry);
  if (entry.method === 0) return new SliceFile(source, offset, entry.size);
  const compressed = await readFully(source, offset, entry.csize);
  if (entry.method === 8) return new BytesFile(inflateSync(compressed));
  throw new Error(`invalid compression method ${entry.method}: ${entry.name}`);
}
class ZipEntryFile implements FileSource {
  readonly size: number;
  private resolved: Promise<FileSource> | null = null;

  constructor(private readonly archive: FileSource, private readonly entry: ZEntry) {
    this.size = entry.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.resolved ??= entrySource(this.archive, this.entry);
    return (await this.resolved).read(offset, length);
  }
}
async function openedApk(source: FileSource): Promise<OpenedApk> {
  const entries = await zipEntries(source);
  const manifestEntry = entries.get("AndroidManifest.xml");
  const manifestSource = manifestEntry ? await entrySource(source, manifestEntry) : null;
  const manifest = manifestSource ? await readFully(manifestSource) : null;
  const xml = manifest ? parseAXML(manifest) : null;
  const split = xml ? attrStr(xml, "split") : null;
  const assetPack = xml?.children.some((node) => node.name === "module" && attrStr(node, "type") === "asset-pack") ?? false;
  const resident = !assetPack || !split || [...entries.keys()].some((name) =>
    /^classes\d*\.dex$/.test(name) || name === "resources.arsc" || name.startsWith("lib/"));
  if (!resident) return { kind: "lazy", source, bytes: null, zip: null, entries, split, hasManifest: !!manifest };
  const bytes = await readFully(source);
  return { kind: "resident", source: new BytesFile(bytes), bytes, zip: zipTree(bytes), split, hasManifest: !!manifest };
}

export async function openInstallRemote(url: string): Promise<Install> {
  const source = await RangeFile.open(url);
  const entries = await zipEntries(source);
  if (entries.has("AndroidManifest.xml")) return openInstall(await readFully(source));
  const apks = [...entries.values()].filter((entry) => entry.name.endsWith(".apk"));
  if (!apks.length) throw new Error("no AndroidManifest.xml and no apks inside: not an apk or a split install");
  const opened = await Promise.all(apks.map(async (entry) => openedApk(await entrySource(source, entry))));
  return mergeInstall(opened);
}
