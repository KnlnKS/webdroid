import { sameBytes } from "../jvm/abi.ts";

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
export function signingSequence(bytes: Uint8Array): Uint8Array[] {
  const fields = new Fields(bytes), out: Uint8Array[] = [];
  while (fields.at < bytes.length) out.push(fields.field());
  return out;
}
export function apkSigningBlock(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  for (let end = bytes.length - 22; end >= Math.max(0, bytes.length - 65557); end--) {
    if (view.getUint32(end, true) !== 0x06054b50 || end + 22 + view.getUint16(end + 20, true) !== bytes.length) continue;
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
  throw new Error("APK has no valid ZIP end record");
}
function algorithms(bytes: Uint8Array) {
  return signingSequence(bytes).map((entry) => {
    const fields = new Fields(entry), id = fields.u32(), value = fields.field(); fields.end();
    return { id, value };
  });
}
function derFields(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.length;) {
    const start = at++;
    if (at >= bytes.length) throw new Error("truncated certificate DER");
    let length = bytes[at++];
    if (length & 128) {
      const count = length & 127; length = 0;
      if (!count || count > 4 || at + count > bytes.length) throw new Error("invalid certificate DER length");
      for (let i = 0; i < count; i++) length = length * 256 + bytes[at++];
    }
    if (length > bytes.length - at) throw new Error("truncated certificate DER value");
    at += length; out.push(bytes.subarray(start, at));
  }
  return out;
}
function derBody(bytes: Uint8Array): Uint8Array {
  if (derFields(bytes).length !== 1 || bytes[0] !== 0x30) throw new Error("invalid certificate DER sequence");
  return bytes.subarray(2 + ((bytes[1] & 128) ? bytes[1] & 127 : 0));
}
function certificateKey(certificate: Uint8Array): Uint8Array {
  const cert = derFields(derBody(certificate));
  if (cert.length !== 3) throw new Error("invalid APK signer certificate");
  const tbs = derFields(derBody(cert[0]));
  const key = tbs[tbs[0]?.[0] === 0xa0 ? 6 : 5];
  if (!key || key[0] !== 0x30) throw new Error("APK certificate has no public key");
  return key;
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

// Android signs each signer's data and a two-level digest of ZIP data, directory, and patched EOCD.
export async function verifyApkSignature(bytes: Uint8Array): Promise<void> {
  const block = apkSigningBlock(bytes);
  if (!block) throw new Error("unsupported APK signature: v2 or v3 required");
  if (block.blocks.has(0x1b93ad61)) throw new Error("unsupported APK v3.1 signature");
  const digests = new Map<string, Uint8Array>();
  let identities: Uint8Array[] | null = null;
  for (const id of [0x7109871a, 0xf05368c0]) {
    const encoded = block.blocks.get(id); if (!encoded) continue;
    const top = new Fields(encoded), signers = signingSequence(top.field()); top.end();
    if (!signers.length) throw new Error("APK has no signers");
    const certificates: Uint8Array[] = [];
    for (const signer of signers) {
      const fields = new Fields(signer), signed = fields.field();
      const min = id === 0xf05368c0 ? fields.u32() : 0, max = id === 0xf05368c0 ? fields.u32() : 0;
      const signatures = algorithms(fields.field()), publicKey = fields.field(); fields.end();
      const supported = signatures.filter((s) => s.id >= 0x101 && s.id <= 0x104).sort((a, b) => (b.id % 2 === 0 ? 1 : 0) - (a.id % 2 === 0 ? 1 : 0));
      const signature = supported[0];
      if (!signature) throw new Error("unsupported APK signature algorithm");
      const hash = signature.id % 2 === 0 ? "SHA-512" : "SHA-256", pss = signature.id <= 0x102;
      const algorithm = pss ? { name: "RSA-PSS", saltLength: hash === "SHA-512" ? 64 : 32 } : { name: "RSASSA-PKCS1-v1_5" };
      const key = await crypto.subtle.importKey("spki", publicKey.slice(), { name: algorithm.name, hash }, false, ["verify"]);
      if (!await crypto.subtle.verify(algorithm, key, signature.value.slice(), signed.slice())) throw new Error("invalid APK signer signature");
      const data = new Fields(signed), declared = algorithms(data.field()), chain = signingSequence(data.field());
      if (!chain.length || !sameBytes(certificateKey(chain[0]), publicKey)) throw new Error("APK certificate public key mismatch");
      certificates.push(chain[0]);
      if (id === 0xf05368c0 && (data.u32() !== min || data.u32() !== max || min > max)) throw new Error("APK signer SDK range mismatch");
      for (const attr of signingSequence(data.field())) {
        const attribute = new Fields(attr), kind = attribute.u32();
        if (kind === 0x3ba06f8c) throw new Error("unsupported APK signing key rotation");
        if (kind === 0xbeeff00d && attribute.u32() === 3 && !block.blocks.has(0xf05368c0)) throw new Error("APK v3 signature stripped");
      }
      if (declared.length !== signatures.length || declared.some((d, i) => d.id !== signatures[i].id)) throw new Error("APK signature algorithm list mismatch");
      const expected = declared.find((d) => d.id === signature.id)!;
      let digest = digests.get(hash);
      if (!digest) { digest = await contentDigest(bytes, block, hash); digests.set(hash, digest); }
      if (!sameBytes(digest, expected.value)) throw new Error("APK content digest mismatch");
    }
    if (identities && (identities.length !== certificates.length || identities.some((c, i) => !sameBytes(c, certificates[i])))) throw new Error("unsupported APK signer rotation between schemes");
    identities = certificates;
  }
  if (!identities) throw new Error("unsupported APK signature: v2 or v3 required");
}
