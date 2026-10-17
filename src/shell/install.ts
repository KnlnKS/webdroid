// Shared by the shell, the dev server's /asset route and the node scripts, so an xapk is an apk
// everywhere or nowhere.

import { parseAXML, attrStr } from "../android/axml.ts";
import { isDexEntry } from "../jvm/dex.ts";
import { centralDirOfSource, inflateEntry, localDataOffset, zipTree, type ZEntry } from "../jvm/natives/jzip.ts";
import { BlobFile, BytesFile, RangeFile, SliceFile, readFully, type FileSource } from "./lazyfile.ts";

/** A split install (.xapk, .apks, an App Bundle's output) is a zip of apks rather than an
 *  apk: a base and its config/feature splits. Merge them into the one tree the rest of the
 *  boot expects — the base wins every conflict, exactly as the base's dex is first on a
 *  device's class path, and each split's dex keeps a distinct name so both survive. */
export interface Install {
  zip: Record<string, Uint8Array>;
  lazyEntries: Map<string, FileSource>;
  /** the base apk's own bytes: what sourceDir names and what ZipFile(sourceDir) must open */
  base: Uint8Array | FileSource;
  /** a resident config split keeps its own resource table: the entries for its configs only */
  splits: { name: string; source: FileSource; bytes: Uint8Array | null; resources: Uint8Array | null }[];
}
type OpenedApk = { source: FileSource; split: string | null; hasManifest: boolean } & (
  { kind: "resident"; bytes: Uint8Array; zip: Record<string, Uint8Array> }
  | { kind: "lazy"; bytes: null; zip: null; entries: Map<string, ZEntry> }
);

/** the apks merged over their base: the one among `opened`, or `base` when its tree is already open */
export function mergeInstall(opened: OpenedApk[], base?: Pick<Install, "zip" | "base">): Install {
  if (!base) {
    const apk = opened.find((o) => o.hasManifest && !o.split);
    if (!apk || apk.kind !== "resident") throw new Error("split install has no resident base apk");
    base = { zip: apk.zip, base: apk.bytes };
    opened = opened.filter((o) => o !== apk);
  }
  const merged = base.zip;
  const lazyEntries = new Map<string, FileSource>();
  const splits: Install["splits"] = [];
  let extra = 0;
  for (const o of opened) {
    if (o.kind === "resident") zipTree(o.bytes, merged, (path) => {
      const target = path === "AndroidManifest.xml" || path === "resources.arsc" || path.startsWith("META-INF/") ? null
        : isDexEntry(path) ? `classes${1000 + extra++}.dex` : path;
      return target && !lazyEntries.has(target) ? target : null;
    });
    else for (const [path, entry] of o.entries) {
      if (path === "AndroidManifest.xml" || path === "resources.arsc" || path.startsWith("META-INF/") || path.endsWith("/")) continue;
      if (Object.hasOwn(merged, path) || lazyEntries.has(path)) continue;
      lazyEntries.set(path, new ZipEntryFile(o.source, entry));
    }
    if (o.split) splits.push({ name: o.split, source: o.source, bytes: o.bytes, resources: o.kind === "resident" ? o.zip["resources.arsc"] ?? null : null });
    console.log("[webdroid] split", o.split ?? "(unnamed)", o.kind === "resident" ? Object.keys(o.zip).length : "lazy", "entries");
  }
  return { zip: merged, lazyEntries, base: base.base, splits };
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

async function entrySource(source: FileSource, entry: ZEntry): Promise<FileSource> {
  const offset = await localDataOffset(source, entry);
  if (entry.method === 0) return new SliceFile(source, offset, entry.size);
  return new BytesFile(inflateEntry(await readFully(source, offset, entry.csize), entry));
}
export class ZipEntryFile implements FileSource {
  private readonly archive: FileSource; private readonly entry: ZEntry;
  readonly size: number;
  private resolved: Promise<FileSource> | null = null;

  constructor(archive: FileSource, entry: ZEntry) {
    this.archive = archive; this.entry = entry;
    this.size = entry.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    this.resolved ??= entrySource(this.archive, this.entry);
    return (await this.resolved).read(offset, length);
  }
}
async function openedApk(source: FileSource, entries: Map<string, ZEntry>): Promise<OpenedApk> {
  const manifestEntry = entries.get("AndroidManifest.xml");
  const manifestSource = manifestEntry ? await entrySource(source, manifestEntry) : null;
  const manifest = manifestSource ? await readFully(manifestSource) : null;
  const xml = manifest ? parseAXML(manifest) : null;
  const split = xml ? attrStr(xml, "split") : null;
  const assetPack = xml?.children.some((node) => node.name === "module" && attrStr(node, "type") === "asset-pack") ?? false;
  const resident = !assetPack || !split || [...entries.keys()].some((name) =>
    isDexEntry(name) || name === "resources.arsc" || name.startsWith("lib/"));
  if (!resident) return { kind: "lazy", source, bytes: null, zip: null, entries, split, hasManifest: !!manifest };
  const bytes = await readFully(source);
  return { kind: "resident", source: new BytesFile(bytes), bytes, zip: zipTree(bytes), split, hasManifest: !!manifest };
}

async function openInstallSource(source: FileSource): Promise<Install> {
  const entries = await centralDirOfSource(source);
  if (entries.has("AndroidManifest.xml")) return openInstall(await readFully(source));
  const apks = [...entries.values()].filter((entry) => entry.name.endsWith(".apk"));
  if (!apks.length) throw new Error("no AndroidManifest.xml and no apks inside: not an apk or a split install");
  return openInstallApks(await Promise.all(apks.map((entry) => entrySource(source, entry))));
}

/** an install from its apks: the base among them, or given already open (a packed archive, a
 *  parsed apk) so that it is not read again */
export async function openInstallApks(apks: FileSource[], base?: Pick<Install, "zip" | "base">): Promise<Install> {
  const dirs = await Promise.all(apks.map(centralDirOfSource));
  return mergeInstall(await Promise.all(apks.map((apk, i) => openedApk(apk, dirs[i]))), base);
}

export async function openInstallRemote(url: string): Promise<Install> {
  return openInstallSource(await RangeFile.open(url));
}

export async function openInstallLocal(file: File): Promise<Install> {
  return openInstallSource(new BlobFile(file));
}
