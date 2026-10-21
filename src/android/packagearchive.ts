import { parseAXML, attrStr, type XmlNode } from "./axml.ts";
import { zipTree, centralDirOfSource } from "../zip.ts";
import { ZipEntryFile } from "../shell/install.ts";
import { readFully, type FileSource } from "../shell/lazyfile.ts";
import { Arsc } from "./arsc.ts";
import { Resources } from "./res.ts";
import { apkSigners } from "./apksignature.ts";

export interface PackageArchive {
  root: XmlNode;
  pkg: string;
  res: Resources;
  certificates: Uint8Array[];
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
export function packageArchive(zip: Record<string, Uint8Array>, certificates: Uint8Array[], lazyEntries?: Map<string, FileSource>): PackageArchive {
  if (!zip["AndroidManifest.xml"]) throw new Error("APK has no AndroidManifest.xml");
  const root = parseAXML(zip["AndroidManifest.xml"]);
  const pkg = attrStr(root, "package");
  if (!pkg || !/^[\w]+(?:\.[\w]+)+$/.test(pkg)) throw new Error("invalid APK package name");
  return { root, pkg, res: new Resources(zip["resources.arsc"] ? new Arsc(zip["resources.arsc"], (path) => zip[path] ?? null) : null, zip, lazyEntries, true), certificates };
}

/** Certificates come from the installed record. Resource-table files stay synchronous for
 *  Resources.fileOf; unrelated archive entries retain the normal lazy file path. */
export async function packageArchiveSource(source: FileSource, certificates: Uint8Array[]): Promise<PackageArchive> {
  const entries = await centralDirOfSource(source), lazy = new Map<string, FileSource>();
  for (const [name, entry] of entries) if (!name.endsWith("/")) lazy.set(name, new ZipEntryFile(source, entry));
  const zip: Record<string, Uint8Array> = {};
  for (const name of ["AndroidManifest.xml", "resources.arsc"]) {
    const file = lazy.get(name);
    if (file) { zip[name] = await readFully(file); lazy.delete(name); }
  }
  const archive = packageArchive(zip, certificates, lazy), pool = archive.res.arsc?.values;
  for (let i = 0; pool && i < pool.length; i++) {
    const name = pool.get(i), file = lazy.get(name);
    if (file) { zip[name] = await readFully(file); lazy.delete(name); }
  }
  return archive;
}
