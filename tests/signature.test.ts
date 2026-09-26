import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";
rt.linkNatives();

const vcallStatic = (cls: string, name: string, desc: string, ...args: unknown[]) => (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);
/** the Java class of what `f` throws, synchronously or as a rejection */
const thrown = async (f: () => unknown) => { try { await f(); } catch (e) { return javaClass(e); } return "nothing"; };

const bytes = (s: string) => Int8Array.from(new TextEncoder().encode(s));
const javaClass = (e: unknown) => (e as any)?.constructor?.$i?.name;

async function keyPair(algo: string, size: number) {
  const gen = await vcallStatic("java/security/KeyPairGenerator", "getInstance", "(Ljava/lang/String;)Ljava/security/KeyPairGenerator;", algo);
  await vcall(gen, "initialize", "(I)V", size);
  return vcall(gen, "generateKeyPair", "()Ljava/security/KeyPair;");
}
async function sign(algo: string, priv: unknown, data: Int8Array, spec?: unknown): Promise<Int8Array> {
  const s = await vcallStatic("java/security/Signature", "getInstance", "(Ljava/lang/String;)Ljava/security/Signature;", algo);
  await vcall(s, "initSign", "(Ljava/security/PrivateKey;)V", priv);
  if (spec) await vcall(s, "setParameter", "(Ljava/security/spec/AlgorithmParameterSpec;)V", spec);
  await vcall(s, "update", "([BII)V", data, 0, 3);
  await vcall(s, "update", "([B)V", data.subarray(3));
  return vcall(s, "sign", "()[B");
}
async function verify(algo: string, pub: unknown, data: Int8Array, sig: Int8Array, spec?: unknown): Promise<number> {
  const s = await vcallStatic("java/security/Signature", "getInstance", "(Ljava/lang/String;)Ljava/security/Signature;", algo);
  await vcall(s, "initVerify", "(Ljava/security/PublicKey;)V", pub);
  if (spec) await vcall(s, "setParameter", "(Ljava/security/spec/AlgorithmParameterSpec;)V", spec);
  await vcall(s, "update", "([B)V", data);
  return vcall(s, "verify", "([B)Z", sig);
}

test("SHA256withRSA signs and verifies; a changed message fails", async () => {
  const pair: any = await keyPair("RSA", 2048);
  const data = bytes("hello signature");
  const sig = await sign("SHA256withRSA", pair.privateKey, data);
  expect(sig.length).toBe(256);
  expect(await verify("SHA256withRSA", pair.publicKey, data, sig)).toBe(1);
  expect(await verify("SHA256withRSA", pair.publicKey, bytes("hello signaturf"), sig)).toBe(0);
  expect(await verify("SHA512withRSA", pair.publicKey, data, sig)).toBe(0);
});

test("RSA-PSS uses the digest-length salt by default and PSSParameterSpec otherwise", async () => {
  const pair: any = await keyPair("RSA", 2048);
  const data = bytes("pss message");
  const sig = await sign("SHA256withRSA/PSS", pair.privateKey, data);
  expect(await verify("SHA256withRSA/PSS", pair.publicKey, data, sig)).toBe(1);
  expect(await verify("SHA256withRSAandMGF1", pair.publicKey, data, sig)).toBe(1);
  const mgf = await newObj("java/security/spec/MGF1ParameterSpec", "(Ljava/lang/String;)V", "SHA-256");
  const spec = await newObj("java/security/spec/PSSParameterSpec", "(Ljava/lang/String;Ljava/lang/String;Ljava/security/spec/AlgorithmParameterSpec;II)V", "SHA-256", "MGF1", mgf, 20, 1);
  const salted = await sign("RSASSA-PSS", pair.privateKey, data, spec);
  expect(await verify("RSASSA-PSS", pair.publicKey, data, salted, spec)).toBe(1);
  expect(await verify("SHA256withRSA/PSS", pair.publicKey, data, salted)).toBe(0);
});

test("SHA256withECDSA produces DER signatures that verify", async () => {
  const pair: any = await keyPair("EC", 256);
  const data = bytes("ecdsa message");
  const sig = await sign("SHA256withECDSA", pair.privateKey, data);
  expect(sig[0]).toBe(0x30);
  expect(sig[1] + 2).toBe(sig.length);
  expect(await verify("SHA256withECDSA", pair.publicKey, data, sig)).toBe(1);
  expect(await verify("SHA256withECDSA", pair.publicKey, bytes("ecdsa messagf"), sig)).toBe(0);
  expect(await verify("SHA256withECDSA", pair.publicKey, data, sig.subarray(0, sig.length - 1))).toBe(0);
});

test("unknown algorithms, null providers and uninitialized use are rejected", async () => {
  expect(await thrown(() => vcallStatic("java/security/Signature", "getInstance", "(Ljava/lang/String;)Ljava/security/Signature;", "MD2withDSA"))).toBe("java/security/NoSuchAlgorithmException");
  expect(await thrown(() => vcallStatic("java/security/Signature", "getInstance", "(Ljava/lang/String;Ljava/security/Provider;)Ljava/security/Signature;", "SHA256withRSA", null))).toBe("java/lang/IllegalArgumentException");
  const s = await vcallStatic("java/security/Signature", "getInstance", "(Ljava/lang/String;Ljava/security/Provider;)Ljava/security/Signature;", "SHA256withRSA", await newObj("java/security/Provider"));
  expect(await thrown(() => vcall(s, "update", "([B)V", bytes("x")))).toBe("java/security/SignatureException");
  const pair: any = await keyPair("EC", 256);
  expect(await thrown(() => vcallAsync(s, "initSign", "(Ljava/security/PrivateKey;)V", pair.privateKey).then(() => vcall(s, "sign", "()[B")))).toBe("java/security/InvalidKeyException");
});
