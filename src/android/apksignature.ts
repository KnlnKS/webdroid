// APK Signature Scheme v2 and v3 (source.android.com/docs/security/features/apksigning): the signing
// block before the ZIP central directory, its signers, and their verification.
import { sameBytes } from "../jvm/abi.ts";
import { endRecord } from "../zip.ts";
import { children, expect, parseOne, SEQUENCE } from "../crypto/der.ts";

class Fields {
  readonly bytes: Uint8Array;
  at = 0;
  view: DataView;
  constructor(bytes: Uint8Array) { this.bytes = bytes; this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length); }
  u32(): number {
    if (this.at + 4 > this.bytes.length) throw new Error("truncated APK signing field");
    const value = this.view.getUint32(this.at, true); this.at += 4; return value;
  }
  field(): Uint8Array {
    const size = this.u32(), at = this.at;
    if (size > this.bytes.length - at) throw new Error("invalid APK signing field length");
    this.at += size; return this.bytes.subarray(at, this.at);
  }
  end() { if (this.at !== this.bytes.length) throw new Error("trailing APK signing data"); }
}
function signingSequence(bytes: Uint8Array): Uint8Array[] {
  const fields = new Fields(bytes), out: Uint8Array[] = [];
  while (fields.at < bytes.length) out.push(fields.field());
  return out;
}
function apkSigningBlock(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length), end = endRecord(bytes);
  if (end < 0) throw new Error("APK has no valid ZIP end record");
  const central = view.getUint32(end + 16, true);
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true) || central + view.getUint32(end + 12, true) !== end)
    throw new Error("unsupported APK ZIP directory");
  if (central < 24 || central > end || new TextDecoder().decode(bytes.subarray(central - 16, central)) !== "APK Sig Block 42") return null;
  const size = Number(view.getBigUint64(central - 24, true)), start = central - size - 8;
  if (!Number.isSafeInteger(size) || size < 24 || start < 0 || view.getBigUint64(start, true) !== BigInt(size)) throw new Error("invalid APK signing block");
  const blocks = new Map<number, Uint8Array>();
  for (let at = start + 8; at < central - 24;) {
    if (at + 8 > central - 24) throw new Error("truncated APK signing entry");
    const length = Number(view.getBigUint64(at, true)); at += 8;
    if (!Number.isSafeInteger(length) || length < 4 || length > central - 24 - at) throw new Error("invalid APK signing entry");
    const id = view.getUint32(at, true);
    if (blocks.has(id)) throw new Error("duplicate APK signing block");
    blocks.set(id, bytes.subarray(at + 4, at + length)); at += length;
  }
  return { start, central, end, blocks };
}
function algorithms(bytes: Uint8Array) {
  return signingSequence(bytes).map((entry) => {
    const fields = new Fields(entry), id = fields.u32(), value = fields.field(); fields.end();
    return { id, value };
  });
}
/** a certificate's SubjectPublicKeyInfo */
function certificateKey(certificate: Uint8Array): Uint8Array {
  const tbs = children(expect(children(parseOne(certificate, SEQUENCE).body)[0], SEQUENCE).body);
  return expect(tbs[tbs[0]?.tag === 0xa0 ? 6 : 5], SEQUENCE).raw;
}
async function contentDigest(bytes: Uint8Array, block: NonNullable<ReturnType<typeof apkSigningBlock>>, hash: string) {
  const end = bytes.slice(block.end);
  new DataView(end.buffer).setUint32(16, block.start, true);
  const parts = [bytes.subarray(0, block.start), bytes.subarray(block.central, block.end), end];
  const count = parts.reduce((n, part) => n + Math.ceil(part.length / 1048576), 0), size = hash === "SHA-512" ? 64 : 32;
  const result = new Uint8Array(5 + count * size); result[0] = 0x5a;
  new DataView(result.buffer).setUint32(1, count, true);
  let output = 5;
  for (const part of parts) for (let at = 0; at < part.length; at += 1048576) {
    const chunk = part.subarray(at, at + 1048576), input = new Uint8Array(5 + chunk.length); input[0] = 0xa5;
    new DataView(input.buffer).setUint32(1, chunk.length, true); input.set(chunk, 5);
    result.set(new Uint8Array(await crypto.subtle.digest(hash, input)), output); output += size;
  }
  return new Uint8Array(await crypto.subtle.digest(hash, result));
}

const V2 = 0x7109871a, V3 = 0xf05368c0, V31 = 0x1b93ad61;
type Algorithm = { id: number; value: Uint8Array };
type ApkSigner = {
  signed: Uint8Array; signatures: Algorithm[]; publicKey: Uint8Array;
  /** of the signed data: the content digests, the certificate chain and the attributes */
  digests: Algorithm[]; certificates: Uint8Array[]; attributes: Uint8Array[];
};
/** the signing block and the signers of its v3 and v2 schemes, v3 first as ApkSignatureVerifier
 *  prefers it; null without a signing block */
export function apkSigners(bytes: Uint8Array) {
  const block = apkSigningBlock(bytes);
  if (!block) return null;
  const schemes: { id: number; signers: ApkSigner[] }[] = [];
  for (const id of [V3, V2]) {
    const encoded = block.blocks.get(id); if (!encoded) continue;
    const top = new Fields(encoded), list = signingSequence(top.field()); top.end();
    if (!list.length) throw new Error("APK has no signers");
    schemes.push({ id, signers: list.map((entry) => {
      const fields = new Fields(entry), signed = fields.field(), min = id === V3 ? fields.u32() : 0, max = id === V3 ? fields.u32() : 0;
      const signatures = algorithms(fields.field()), publicKey = fields.field(); fields.end();
      const data = new Fields(signed), digests = algorithms(data.field()), certificates = signingSequence(data.field());
      if (!certificates.length) throw new Error("APK signer has no certificate");
      if (id === V3 && (data.u32() !== min || data.u32() !== max || min > max)) throw new Error("APK signer SDK range mismatch");
      return { signed, signatures, publicKey, digests, certificates, attributes: signingSequence(data.field()) };
    }) });
  }
  return { block, schemes };
}

// Android signs each signer's data and a two-level digest of ZIP data, directory, and patched EOCD.
/** the verified signers' certificates, each signer's first */
export async function verifyApkSignature(bytes: Uint8Array): Promise<Uint8Array[]> {
  const parsed = apkSigners(bytes);
  if (!parsed?.schemes.length) throw new Error("unsupported APK signature: v2 or v3 required");
  const { block, schemes } = parsed;
  if (block.blocks.has(V31)) throw new Error("unsupported APK v3.1 signature");
  const digests = new Map<string, Uint8Array>();
  for (const { signers } of schemes) for (const s of signers) {
    const supported = s.signatures.filter((a) => a.id >= 0x101 && a.id <= 0x104).sort((a, b) => (b.id % 2 === 0 ? 1 : 0) - (a.id % 2 === 0 ? 1 : 0));
    const signature = supported[0];
    if (!signature) throw new Error("unsupported APK signature algorithm");
    const hash = signature.id % 2 === 0 ? "SHA-512" : "SHA-256", pss = signature.id <= 0x102;
    const algorithm = pss ? { name: "RSA-PSS", saltLength: hash === "SHA-512" ? 64 : 32 } : { name: "RSASSA-PKCS1-v1_5" };
    const key = await crypto.subtle.importKey("spki", s.publicKey.slice(), { name: algorithm.name, hash }, false, ["verify"]);
    if (!await crypto.subtle.verify(algorithm, key, signature.value.slice(), s.signed.slice())) throw new Error("invalid APK signer signature");
    if (!sameBytes(certificateKey(s.certificates[0]), s.publicKey)) throw new Error("APK certificate public key mismatch");
    for (const attr of s.attributes) {
      const attribute = new Fields(attr), kind = attribute.u32();
      if (kind === 0x3ba06f8c) throw new Error("unsupported APK signing key rotation");
      if (kind === 0xbeeff00d && attribute.u32() === 3 && !block.blocks.has(V3)) throw new Error("APK v3 signature stripped");
    }
    if (s.digests.length !== s.signatures.length || s.digests.some((d, i) => d.id !== s.signatures[i].id)) throw new Error("APK signature algorithm list mismatch");
    const expected = s.digests.find((d) => d.id === signature.id)!;
    let digest = digests.get(hash);
    if (!digest) { digest = await contentDigest(bytes, block, hash); digests.set(hash, digest); }
    if (!sameBytes(digest, expected.value)) throw new Error("APK content digest mismatch");
  }
  const [first, ...others] = schemes.map((scheme) => scheme.signers.map((s) => s.certificates[0]));
  if (others.some((c) => c.length !== first.length || c.some((x, i) => !sameBytes(x, first[i])))) throw new Error("unsupported APK signer rotation between schemes");
  return first;
}
