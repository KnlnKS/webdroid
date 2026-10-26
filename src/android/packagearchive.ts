import { parseAXML, attrStr, type XmlNode } from "./axml.ts";
import { zipTree, centralDirOfSource } from "../zip.ts";
import { ZipEntryFile, type Install, type InstalledSplit } from "../shell/install.ts";
import { readFully, type FileSource } from "../shell/lazyfile.ts";
import { Arsc } from "./arsc.ts";
import type { Apk } from "./res.ts";
import { apkSigners } from "./apksignature.ts";

export interface PackageArchive {
  root: XmlNode;
  pkg: string;
  apk: Apk;
  certificates: Uint8Array[];
  /** the installed splits, sorted by name as ApkLiteParseUtils sorts them */
  splits: InstalledSplit[];
}

/** the certificates Android's Signature API exposes: each v3 (else v2) signer's first, else those of
 *  the v1 signature blocks' PKCS #7 SignedData */
export async function apkCertificates(bytes: Uint8Array, zip: Record<string, Uint8Array>): Promise<Uint8Array[]> {
  const signers = apkSigners(bytes)?.schemes[0]?.signers;
  if (signers) return signers.map((s) => s.certificates[0].slice());
  const names = Object.keys(zip).filter((name) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(name));
  if (!names.length) return [];
  const { signedDataCertificates } = await import("../crypto/x509.ts");
  return names.flatMap((name) => signedDataCertificates(zip[name]).map((c) => c.slice()));
}
export async function parsePackageArchive(bytes: Uint8Array, certificates?: Uint8Array[]): Promise<PackageArchive> {
  const zip = zipTree(bytes);
  return packageArchive(zip, certificates ?? await apkCertificates(bytes, zip));
}
/** the package in `zip`, with `install`'s splits merged over it: their entries and resource tables join the base's */
export function packageArchive(zip: Record<string, Uint8Array>, certificates: Uint8Array[],
  { lazyEntries = new Map(), splits = [] }: Partial<Pick<Install, "lazyEntries" | "splits">> = {}): PackageArchive {
  if (!zip["AndroidManifest.xml"]) throw new Error("APK has no AndroidManifest.xml");
  const root = parseAXML(zip["AndroidManifest.xml"]);
  const pkg = attrStr(root, "package");
  if (!pkg || !/^[\w]+(?:\.[\w]+)+$/.test(pkg)) throw new Error("invalid APK package name");
  const table = zip["resources.arsc"] ? new Arsc(zip["resources.arsc"], (path) => zip[path] ?? null) : null;
  for (const split of splits) if (split.resources) table?.add(split.resources);
  return { root, pkg, apk: { table, zip, lazyEntries }, certificates, splits: [...splits].sort((a, b) => a.name < b.name ? -1 : +(a.name > b.name)) };
}

/** An installed package read over `source`: its manifest and table resident, every other entry
 *  read when ApkAssets opens it. Certificates come from the installed record. */
export async function packageArchiveSource(source: FileSource, certificates: Uint8Array[]): Promise<PackageArchive> {
  const entries = await centralDirOfSource(source), lazy = new Map<string, FileSource>();
  for (const [name, entry] of entries) if (!name.endsWith("/")) lazy.set(name, new ZipEntryFile(source, entry));
  const zip: Record<string, Uint8Array> = {};
  await Promise.all(["AndroidManifest.xml", "resources.arsc"].map(async (name) => {
    const file = lazy.get(name);
    if (file) { zip[name] = await readFully(file); lazy.delete(name); }
  }));
  return packageArchive(zip, certificates, { lazyEntries: lazy });
}
