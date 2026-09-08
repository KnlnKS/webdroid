import { expect, test } from "bun:test";
import { zipSync } from "fflate";
import { apkSigningBlock, signingSequence, verifyApkSignature } from "./apksignature";

const mihon = new Uint8Array(await Bun.file(new URL("../../apks/mihon-v0.20.4.apk", import.meta.url)).arrayBuffer());

test("APK v2 verifies the real Mihon signature and multi-chunk contents", async () => {
  await expect(verifyApkSignature(mihon)).resolves.toBeUndefined();
});

test("APK verification rejects changes to entry bytes, directory, and EOCD", async () => {
  const block = apkSigningBlock(mihon)!;
  for (const offset of [100, block.central + 46, block.end + 8]) {
    const altered = mihon.slice(); altered[offset] ^= 1;
    await expect(verifyApkSignature(altered)).rejects.toThrow("digest mismatch");
  }
});

test("APK verification authenticates the signed data, signature, and public key", async () => {
  const block = apkSigningBlock(mihon)!, encoded = block.blocks.get(0x7109871a)!;
  const signer = signingSequence(signingSequence(encoded)[0])[0];
  const [signed, signatures, publicKey] = signingSequence(signer);
  const signature = signingSequence(signatures)[0];
  for (const field of [signed, signature, publicKey]) {
    const altered = mihon.slice(); altered[field.byteOffset - mihon.byteOffset + field.length - 1] ^= 1;
    await expect(verifyApkSignature(altered)).rejects.toThrow();
  }
});

test("APK verification fails closed for unsigned ZIPs and malformed block bounds", async () => {
  await expect(verifyApkSignature(zipSync({ "classes.dex": new Uint8Array([1, 2]) }))).rejects.toThrow("unsupported APK signature");
  const block = apkSigningBlock(mihon)!;
  for (const offset of [block.start, block.central - 24]) {
    const altered = mihon.slice(); altered[offset] ^= 1;
    await expect(verifyApkSignature(altered)).rejects.toThrow("signing block");
  }
  await expect(verifyApkSignature(mihon.subarray(0, mihon.length - 1))).rejects.toThrow("end record");
});
