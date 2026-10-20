import { parseAXML, attrStr, type XmlNode } from "./axml.ts";
import { zipTree, centralDirOfSource } from "../zip.ts";
import { ZipEntryFile } from "../shell/install.ts";
import { readFully, type FileSource } from "../shell/lazyfile.ts";
import { Arsc } from "./arsc.ts";
import { Resources } from "./res.ts";
import { apkSigningBlock, signingSequence as sequence } from "./apksignature.ts";

export interface PackageArchive {
  root: XmlNode;
  pkg: string;
  res: Resources;
  certificates: Uint8Array[];
}

// APK v2/v3 encodes nested length-prefixed sequences; certificates are DER, not the
// signature over signedData. Android's Signature API exposes those certificate bytes.
function first(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4) throw new Error("truncated APK signing field");
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (size > bytes.length - 4) throw new Error("invalid APK signing field length");
  return bytes.subarray(4, 4 + size);
}
export async function apkCertificates(bytes: Uint8Array, zip: Record<string, Uint8Array>): Promise<Uint8Array[]> {
  const block = apkSigningBlock(bytes);
  for (const id of [0x7109871a, 0xf05368c0, 0x1b93ad61]) {
    const encoded = block?.blocks.get(id);
    if (!encoded) continue;
    const signers = first(encoded);
    return sequence(signers).map((signer) => {
      const signedData = first(signer), digests = first(signedData);
      const certificate = sequence(first(signedData.subarray(digests.length + 4)))[0];
      if (!certificate) throw new Error("APK signer has no certificate");
      return certificate.slice();
    });
  }
  const entries = Object.keys(zip).filter((name) => /^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(name));
  if (!entries.length) return [];
  const forge = (await import("../forge.ts")).default;
  return entries.flatMap((name) => {
    const block = zip[name];
    let binary = "";
    for (const byte of block) binary += String.fromCharCode(byte);
    const message = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(binary));
    if (!("certificates" in message) || !Array.isArray(message.certificates)) return [];
    return message.certificates.map((cert) => Uint8Array.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), (c) => c.charCodeAt(0)));
  });
}
export async function parsePackageArchive(bytes: Uint8Array): Promise<PackageArchive> {
  const zip = zipTree(bytes);
  return packageArchive(zip, await apkCertificates(bytes, zip));
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
