import { expect, test } from "bun:test";
import { X509Certificate, createPrivateKey, constants, privateDecrypt, publicEncrypt } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import "../natives";
import { rt } from "./runtime";
import { mangleMethod } from "./abi";
import { newObj, vcall } from "./natives/jlang";
import { JKeyGenSpec } from "../android/security";

const staticCall = (name: string, method: string, descriptor: string, ...args: unknown[]) => rt.link(name).ctor[mangleMethod(method, descriptor)](...args);

test("RSA keystore generates real certificates and wraps keys with Android's mixed OAEP hashes after reload", async () => {
  const storage = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  const temp = mkdtempSync(join(tmpdir(), "webdroid-rsa-"));
  try {
    const spec = new JKeyGenSpec(); spec.alias = "test-rsa"; spec.purposes = 3; spec.keySize = 1024; spec.digests = ["SHA-256"]; spec.paddings = ["OAEPPadding"];
    spec.certificateSubject = await newObj("javax/security/auth/x500/X500Principal", "(Ljava/lang/String;)V", "CN=Key Test,O=Webdroid");
    spec.certificateNotBefore = await newObj("java/util/Date", "(J)V", 0n);
    spec.certificateNotAfter = await newObj("java/util/Date", "(J)V", 2461449600000n);
    const generator = staticCall("java/security/KeyPairGenerator", "getInstance", "(Ljava/lang/String;Ljava/lang/String;)Ljava/security/KeyPairGenerator;", "RSA", "AndroidKeyStore");
    await vcall(generator, "initialize", "(Ljava/security/spec/AlgorithmParameterSpec;)V", spec);
    const pair = await vcall(generator, "generateKeyPair", "()Ljava/security/KeyPair;");
    const privateKey = await vcall(pair, "getPrivate", "()Ljava/security/PrivateKey;");
    expect(await vcall(privateKey, "getEncoded", "()[B")).toBeNull();
    const store = new (rt.link("java/security/KeyStore").ctor)(); store.type = "AndroidKeyStore"; store.load();
    await vcall(store, "load", "(Ljava/security/KeyStore$LoadStoreParameter;)V", null);
    const restored = await vcall(store, "getKey", "(Ljava/lang/String;[C)Ljava/security/Key;", spec.alias, null);
    expect(restored).not.toBe(privateKey);
    const cert = await vcall(store, "getCertificate", "(Ljava/lang/String;)Ljava/security/cert/Certificate;", spec.alias);
    const x509 = new X509Certificate(Buffer.from(await vcall(cert, "getEncoded", "()[B")));
    expect(x509.verify(x509.publicKey)).toBe(true);
    expect(x509.subject).toBe("CN=Key Test\nO=Webdroid");
    const publicKey = await vcall(cert, "getPublicKey", "()Ljava/security/PublicKey;");
    const oaep = await newObj("javax/crypto/spec/OAEPParameterSpec", "(Ljava/lang/String;Ljava/lang/String;Ljava/security/spec/AlgorithmParameterSpec;Ljavax/crypto/spec/PSource;)V", "SHA-256", "MGF1", await newObj("java/security/spec/MGF1ParameterSpec", "(Ljava/lang/String;)V", "SHA-1"), await newObj("javax/crypto/spec/PSource$PSpecified", "([B)V", new Int8Array(0)));
    const secret = await newObj("javax/crypto/spec/SecretKeySpec", "([BLjava/lang/String;)V", new Int8Array(32).fill(37), "AES");
    const cipher = staticCall("javax/crypto/Cipher", "getInstance", "(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/Cipher;", "RSA/ECB/OAEPPadding", "AndroidKeyStoreBCWorkaround");
    await vcall(cipher, "init", "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V", 3, publicKey, oaep);
    const wrapped = await vcall(cipher, "wrap", "(Ljava/security/Key;)[B", secret);
    expect(wrapped.length).toBe(128);
    const privatePem = createPrivateKey({ key: Buffer.from(restored.encoded), format: "der", type: "pkcs8" }).export({ format: "pem", type: "pkcs8" });
    writeFileSync(join(temp, "key.pem"), privatePem, { mode: 0o600 }); writeFileSync(join(temp, "ciphertext"), wrapped);
    const openssl = spawnSync("openssl", ["pkeyutl", "-decrypt", "-inkey", join(temp, "key.pem"), "-in", join(temp, "ciphertext"), "-pkeyopt", "rsa_padding_mode:oaep", "-pkeyopt", "rsa_oaep_md:sha256", "-pkeyopt", "rsa_mgf1_md:sha1"]);
    expect(openssl.status).toBe(0);
    expect(new Int8Array(openssl.stdout)).toEqual(new Int8Array(32).fill(37));
    await vcall(cipher, "init", "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V", 4, restored, oaep);
    const unwrapped = await vcall(cipher, "unwrap", "([BLjava/lang/String;I)Ljava/security/Key;", wrapped, "AES", 3);
    expect(await vcall(unwrapped, "getEncoded", "()[B")).toEqual(new Int8Array(32).fill(37));
    wrapped[4] ^= 1;
    await expect(vcall(cipher, "unwrap", "([BLjava/lang/String;I)Ljava/security/Key;", wrapped, "AES", 3)).rejects.toMatchObject({ msg: "RSA OAEP operation failed" });
    const defaults = await newObj("javax/crypto/spec/OAEPParameterSpec");
    await vcall(cipher, "init", "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V", 1, publicKey, defaults);
    const standard = await vcall(cipher, "doFinal", "([B)[B", new Int8Array([1, 2, 3]));
    expect(privateDecrypt({ key: privatePem, padding: constants.RSA_PKCS1_OAEP_PADDING }, standard)).toEqual(Buffer.from([1, 2, 3]));
    await vcall(cipher, "init", "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V", 2, restored, defaults);
    expect(await vcall(cipher, "doFinal", "([B)[B", new Int8Array(publicEncrypt({ key: x509.publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from([4, 5]))))).toEqual(new Int8Array([4, 5]));
    spec.strongBox = true;
    await expect(vcall(generator, "initialize", "(Ljava/security/spec/AlgorithmParameterSpec;)V", spec)).rejects.toMatchObject({ msg: "Hardware-backed keys and user authentication are unavailable" });
  } finally {
    rmSync(temp, { recursive: true, force: true });
    if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
