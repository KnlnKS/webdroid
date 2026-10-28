// Shared by the shell, the dev server's /asset route and the node scripts, so an xapk is an apk
// everywhere or nowhere.

import { parseAXML, attr, attrStr, type XmlNode } from "../android/axml.ts";
import { isDexEntry } from "../jvm/dex.ts";
import { centralDirOfSource, entryBytesOf, inflateEntry, localDataOffset, residentTree, zipTree, type ZEntry } from "../zip.ts";
import { BlobFile, BytesFile, SliceFile, readFully, type FileSource } from "./lazyfile.ts";

/** A split install (.xapk, .apks, an App Bundle's output) is a zip of apks rather than an
 *  apk: a base and its config/feature splits. Merge them into the one tree the rest of the
 *  boot expects — the base wins every conflict, exactly as the base's dex is first on a
 *  device's class path, and each split's dex keeps a distinct name so both survive. */
export interface Install {
  zip: Record<string, Uint8Array>;
  lazyEntries: Map<string, FileSource>;
  /** the base apk: what sourceDir names and what ZipFile(sourceDir) must open */
  base: Uint8Array | FileSource;
  /** each split, and a resident config split's own resource table: the entries for its configs only */
  splits: InstalledSplit[];
}
/** an open base apk that splits merge over */
export type InstallBase = Pick<Install, "zip" | "base"> & Partial<Pick<Install, "lazyEntries">>;
/** a split as ApkLiteParseUtils reads its manifest: its name, whether it is a feature split, the split its
 *  code uses and the one it configures */
export interface Split { name: string; manifest: XmlNode; feature: boolean; uses: string | null; configFor: string | null }
/** a split with its apk */
export type InstalledSplit = Split & { source: FileSource; bytes: Uint8Array | null; resources: Uint8Array | null };
type OpenedApk = { source: FileSource; manifest: XmlNode | null; split: Split | null } & (
  { kind: "resident"; bytes: Uint8Array; zip: Record<string, Uint8Array> }
  | { kind: "lazy"; bytes: null; zip: null; entries: Map<string, ZEntry>; resources: Uint8Array | null }
);

const flag = (manifest: XmlNode, name: string) => !!attr(manifest, name)?.data;
/** an apk's own manifest, resource table and signature, which a merged install takes from the base alone */
const isApkMeta = (path: string) => path === "AndroidManifest.xml" || path === "resources.arsc" || path.startsWith("META-INF/");
const NOT_AN_INSTALL = "no AndroidManifest.xml and no apks inside: not an apk or a split install";
function parseSplit(manifest: XmlNode | null): Split | null {
  const name = manifest && attrStr(manifest, "split");
  if (!manifest || !name) return null;
  const uses = manifest.children.find((n) => n.name === "uses-split");
  return { name, manifest, feature: flag(manifest, "isFeatureSplit"), uses: uses ? attrStr(uses, "name") : null, configFor: attrStr(manifest, "configForSplit") };
}
/** the apks merged over their base: the one among `opened`, or `base` when its tree is already open */
export function mergeInstall(opened: OpenedApk[], base?: InstallBase): Install {
  let manifest: XmlNode | null = null;
  if (!base) {
    const apk = opened.find((o) => o.manifest && !o.split);
    if (!apk || apk.kind !== "resident") throw new Error("split install has no resident base apk");
    base = { zip: apk.zip, base: apk.bytes };
    manifest = apk.manifest;
    opened = opened.filter((o) => o !== apk);
  }
  const merged = base.zip;
  // with isolatedSplits each feature split's code stays in its apk, for the class loader LoadedApk gives that split
  const isolated = flag(manifest ?? parseAXML(merged["AndroidManifest.xml"]), "isolatedSplits");
  const lazyEntries = new Map(base.lazyEntries);
  const splits: Install["splits"] = [];
  let extra = 0;
  for (const o of opened) {
    const ownCode = isolated && !!o.split?.feature;
    if (o.kind === "resident") zipTree(o.bytes, merged, (path) => {
      const target = isApkMeta(path) ? null
        : isDexEntry(path) ? ownCode ? null : `classes${1000 + extra++}.dex` : path;
      return target && !lazyEntries.has(target) ? target : null;
    });
    else for (const [path, entry] of o.entries) {
      if (isApkMeta(path) || path.endsWith("/")) continue;
      if (Object.hasOwn(merged, path) || lazyEntries.has(path)) continue;
      lazyEntries.set(path, new ZipEntryFile(o.source, entry));
    }
    if (o.split) splits.push({ ...o.split, source: o.source, bytes: o.bytes, resources: o.kind === "resident" ? o.zip["resources.arsc"] ?? null : o.resources });
    console.log("[webdroid] split", o.split?.name ?? "(unnamed)", o.kind === "resident" ? Object.keys(o.zip).length : "lazy", "entries");
  }
  return { zip: merged, lazyEntries, base: base.base, splits };
}

export function openInstall(bytes: Uint8Array): Install {
  const outer = zipTree(bytes);
  if (outer["AndroidManifest.xml"]) return { zip: outer, lazyEntries: new Map(), base: bytes, splits: [] };
  const apks = Object.keys(outer).filter((n) => n.endsWith(".apk"));
  if (!apks.length) throw new Error(NOT_AN_INSTALL);
  const opened = apks.map((n) => outer[n]).map((b): OpenedApk => {
    const z = zipTree(b), m = z["AndroidManifest.xml"], manifest = m ? parseAXML(m) : null;
    return { kind: "resident", source: new BytesFile(b), bytes: b, zip: z, manifest, split: parseSplit(manifest) };
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
/** `lazy`: every entry stays in the apk, read when opened, its resource table aside */
async function openedApk(source: FileSource, entries: Map<string, ZEntry>, lazy: boolean): Promise<OpenedApk> {
  const manifestEntry = entries.get("AndroidManifest.xml");
  const manifest = manifestEntry ? await entryBytesOf(source, manifestEntry) : null;
  const xml = manifest ? parseAXML(manifest) : null;
  const assetPack = xml?.children.some((node) => node.name === "module" && attrStr(node, "type") === "asset-pack") ?? false;
  const split = parseSplit(xml), resident = !lazy && (!assetPack || !split || [...entries.keys()].some((name) =>
    isDexEntry(name) || name === "resources.arsc" || name.startsWith("lib/")));
  if (!resident) {
    const table = entries.get("resources.arsc"), resources = table ? await entryBytesOf(source, table) : null;
    return { kind: "lazy", source, bytes: null, zip: null, entries, resources, manifest: xml, split };
  }
  const bytes = await readFully(source);
  return { kind: "resident", source: new BytesFile(bytes), bytes, zip: zipTree(bytes), manifest: xml, split };
}

/** what a process reads of its apk synchronously as it boots, rather than through a stream when it is opened:
 *  all but the assets (save the dexopt profile) and the native libraries */
const bootEntry = (name: string) => !name.startsWith("lib/") && (!name.startsWith("assets/") || name.startsWith("assets/dexopt/"));
/** A plain apk over `source`: its boot entries resident, read in as few ranges as they lie in, and
 *  every other entry read from the archive when it is opened. */
export async function openApk(source: FileSource, entries?: Map<string, ZEntry>): Promise<Install> {
  entries ??= await centralDirOfSource(source);
  const zip: Record<string, Uint8Array> = {}, lazyEntries = new Map<string, FileSource>();
  for (const e of entries.values()) if (!e.name.endsWith("/") && !bootEntry(e.name)) lazyEntries.set(e.name, new ZipEntryFile(source, e));
  await residentTree(source, entries.values(), bootEntry, zip);
  return { zip, lazyEntries, base: source, splits: [] };
}
async function openInstallSource(source: FileSource): Promise<Install> {
  const entries = await centralDirOfSource(source);
  if (entries.has("AndroidManifest.xml")) return openApk(source, entries);
  const apks = [...entries.values()].filter((entry) => entry.name.endsWith(".apk"));
  if (!apks.length) throw new Error(NOT_AN_INSTALL);
  return openInstallApks(await Promise.all(apks.map((entry) => entrySource(source, entry))));
}

/** an install from its apks: the base among them, or given already open (a packed archive, a
 *  parsed apk) so that it is not read again */
export const openInstallApks = async (apks: FileSource[], base?: InstallBase): Promise<Install> => mergeInstall(await openApks(apks, false), base);
/** an installed package's splits over its open base, as a package manager that runs none of their code holds
 *  them: every entry read when it is opened, and a split's dex left in its own apk */
export const openInstalledSplits = async (apks: FileSource[], base: InstallBase): Promise<Install> => mergeInstall(await openApks(apks, true), base);
async function openApks(apks: FileSource[], lazy: boolean): Promise<OpenedApk[]> {
  const dirs = await Promise.all(apks.map(centralDirOfSource));
  return Promise.all(apks.map((apk, i) => openedApk(apk, dirs[i], lazy)));
}

/** an install downloaded whole: the browser holds its bytes, out of this realm's heap */
export async function openInstallRemote(url: string): Promise<Install> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
  return openInstallSource(new BlobFile(await response.blob()));
}

export async function openInstallLocal(file: File): Promise<Install> {
  return openInstallSource(new BlobFile(file));
}
