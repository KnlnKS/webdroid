import { expect, test, describe } from "bun:test";
import "../src/natives";
import { getPM } from "../src/android/pm";
import { packages, type PackageRecord } from "../src/android/packages";
import { vcall, newObj, vcallAsync } from "../src/jvm/natives/jlang";
import { rt } from "../src/jvm/runtime";
import { scall } from "./java";

rt.linkNatives();
const messageDigest = (algorithm: string) => scall("java/security/MessageDigest", "getInstance", "(Ljava/lang/String;)Ljava/security/MessageDigest;", algorithm);

describe("android-signing-certificate", () => {
  test("PackageManager compares installed signing certificates in raw and SHA-256 form", async () => {
    const pkg = "org.webdroid.test.signing", uid = 77124;
    const certificate = new Uint8Array([48, 3, 2, 1, 5]);
    packages.set(pkg, { uid, visibleCertificates: async () => [certificate] } as PackageRecord);
    try {
      const pm = getPM();
      const has = (bytes: Int8Array, type: number) =>
        vcall(pm, "hasSigningCertificate", "(Ljava/lang/String;[BI)Z", pkg, bytes, type);
      const digest = new Int8Array(await crypto.subtle.digest("SHA-256", certificate));
      expect(await has(new Int8Array(certificate), 0)).toBe(1);
      expect(await has(digest, 1)).toBe(1);
      expect(await has(new Int8Array([1, 2, 3]), 0)).toBe(0);
      expect(await has(digest, 2)).toBe(0);
    } finally {
      packages.delete(pkg);
    }
  });
});

describe("cipher-output-stream", () => {
  test("cipher streams encrypt on close and decrypt through reads", async () => {
    const keyBytes = Int8Array.from({ length: 16 }, (_, i) => i);
    const key = await newObj("javax/crypto/spec/SecretKeySpec", "([BLjava/lang/String;)V", keyBytes, "AES");
    const iv = await newObj("javax/crypto/spec/IvParameterSpec", "([B)V", new Int8Array(16));
    const newCipher = () => scall("javax/crypto/Cipher", "getInstance", "(Ljava/lang/String;)Ljavax/crypto/Cipher;", "AES/CBC/PKCS5Padding");
    const cipher = await newCipher();
    await vcall(cipher, "init", "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V", 1, key, iv);
    const out = await newObj("java/io/ByteArrayOutputStream", "()V");
    const stream = await newObj("javax/crypto/CipherOutputStream", "(Ljava/io/OutputStream;Ljavax/crypto/Cipher;)V", out, cipher);
    await vcall(stream, "write", "([B)V", Int8Array.of(1, 2));
    await vcall(stream, "write", "(I)V", 3);
    await vcall(stream, "close", "()V");
    const ciphertext = await vcall(out, "toByteArray", "()[B") as Int8Array;
    const webKey = await crypto.subtle.importKey("raw", new Uint8Array(keyBytes), "AES-CBC", false, ["decrypt"]);
    expect(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, webKey, new Uint8Array(ciphertext)))).toEqual(Uint8Array.of(1, 2, 3));

    const decrypt = await newCipher();
    await vcall(decrypt, "init", "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V", 2, key, iv);
    const input = await newObj("java/io/ByteArrayInputStream", "([B)V", ciphertext);
    const plain = await newObj("javax/crypto/CipherInputStream", "(Ljava/io/InputStream;Ljavax/crypto/Cipher;)V", input, decrypt);
    const bytes = new Int8Array(4);
    expect(await vcall(plain, "read", "([BII)I", bytes, 1, 2)).toBe(2);
    expect(bytes).toEqual(Int8Array.of(0, 1, 2, 0));
    expect(await vcall(plain, "read", "()I")).toBe(3);
    expect(await vcall(plain, "read", "()I")).toBe(-1);
    await vcall(plain, "close", "()V");
  });
});

describe("digest-output-stream", () => {
  test("DigestOutputStream forwards all writes and hashes only while enabled", async () => {
    const digest = await messageDigest("SHA-256");
    const out = await newObj("java/io/ByteArrayOutputStream", "()V");
    const stream = await newObj("java/security/DigestOutputStream", "(Ljava/io/OutputStream;Ljava/security/MessageDigest;)V", out, digest);
    await vcall(stream, "write", "([B)V", Int8Array.of(2, 3));
    await vcall(stream, "on", "(Z)V", 0);
    await vcall(stream, "write", "(I)V", 4);
    await vcall(stream, "on", "(Z)V", 1);
    await vcall(stream, "write", "(I)V", 5);
    expect(await vcall(out, "toByteArray", "()[B")).toEqual(Int8Array.of(2, 3, 4, 5));
    const expected = new Int8Array(await crypto.subtle.digest("SHA-256", Uint8Array.of(2, 3, 5)));
    expect(await vcall(digest, "digest", "()[B")).toEqual(expected);
  });

  test("DigestInputStream hashes only bytes read while enabled", async () => {
    const digest = await messageDigest("SHA-256");
    const input = await newObj("java/io/ByteArrayInputStream", "([B)V", Int8Array.of(1, 2, 3, 4, 5));
    const stream = await newObj("java/security/DigestInputStream", "(Ljava/io/InputStream;Ljava/security/MessageDigest;)V", input, digest);
    const bytes = new Int8Array(4);
    expect(await vcall(stream, "read", "([BII)I", bytes, 1, 2)).toBe(2);
    expect(bytes).toEqual(Int8Array.of(0, 1, 2, 0));
    await vcall(stream, "on", "(Z)V", 0);
    expect(await vcall(stream, "read", "()I")).toBe(3);
    await vcall(stream, "on", "(Z)V", 1);
    expect(await vcall(stream, "read", "([B)I", bytes)).toBe(2);
    expect(await vcall(stream, "read", "()I")).toBe(-1);
    const expected = new Int8Array(await crypto.subtle.digest("SHA-256", Uint8Array.of(1, 2, 4, 5)));
    expect(await vcall(digest, "digest", "()[B")).toEqual(expected);
  });
});

describe("digest-sha512", () => {
  test("SHA-512 and SHA-384 accept incremental input and reset after digest", async () => {
    for (const [algorithm, expected, empty] of [
      ["SHA-512", "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f", "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e"],
      ["SHA384", "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7", "38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b"],
    ]) {
      const digest = await messageDigest(algorithm);
      await vcall(digest, "update", "(B)V", 97);
      const value: Int8Array = await vcall(digest, "digest", "([B)[B", new Int8Array([98, 99]));
      expect(Buffer.from(value).toString("hex")).toBe(expected);
      expect(await vcall(digest, "getDigestLength", "()I")).toBe(expected.length / 2);
      expect(Buffer.from(await vcall(digest, "digest", "()[B")).toString("hex")).toBe(empty);
    }
  });
});

describe("key-generator", () => {
  test("Blowfish key generator returns fresh 128-bit raw keys by default", async () => {
    const generator = await scall("javax/crypto/KeyGenerator", "getInstance", "(Ljava/lang/String;)Ljavax/crypto/KeyGenerator;", "Blowfish");
    const first = await vcall(generator, "generateKey", "()Ljavax/crypto/SecretKey;");
    const second = await vcall(generator, "generateKey", "()Ljavax/crypto/SecretKey;");
    const bytes = await vcall(first, "getEncoded", "()[B") as Int8Array;
    expect(bytes.length).toBe(16);
    expect(await vcall(first, "getAlgorithm", "()Ljava/lang/String;")).toBe("Blowfish");
    expect(await vcall(second, "getEncoded", "()[B")).not.toEqual(bytes);
  });
});

describe("message-digest-buffer", () => {
  test("MessageDigest consumes only the remaining ByteBuffer bytes", async () => {
    const buffer = await scall("java/nio/ByteBuffer", "wrap", "([BII)Ljava/nio/ByteBuffer;", new Int8Array([1, 2, 3, 4]), 1, 2);
    const digest = await messageDigest("SHA-256");
    await vcall(digest, "update", "(Ljava/nio/ByteBuffer;)V", buffer);
    expect(await vcall(buffer, "position", "()I")).toBe(3);
    const actual = await vcall(digest, "digest", "()[B");
    const expected = await messageDigest("SHA-256");
    await vcall(expected, "update", "([B)V", new Int8Array([2, 3]));
    expect([...actual]).toEqual([...(await vcall(expected, "digest", "()[B"))]);
  });
});

describe("signature", () => {
  /** the Java class of what `f` throws, synchronously or as a rejection */
  const thrown = async (f: () => unknown) => { try { await f(); } catch (e) { return javaClass(e); } return "nothing"; };

  const bytes = (s: string) => Int8Array.from(new TextEncoder().encode(s));
  const javaClass = (e: unknown) => (e as any)?.constructor?.$i?.name;

  async function keyPair(algo: string, size: number) {
    const gen = await scall("java/security/KeyPairGenerator", "getInstance", "(Ljava/lang/String;)Ljava/security/KeyPairGenerator;", algo);
    await vcall(gen, "initialize", "(I)V", size);
    return vcall(gen, "generateKeyPair", "()Ljava/security/KeyPair;");
  }
  async function sign(algo: string, priv: unknown, data: Int8Array, spec?: unknown): Promise<Int8Array> {
    const s = await scall("java/security/Signature", "getInstance", "(Ljava/lang/String;)Ljava/security/Signature;", algo);
    await vcall(s, "initSign", "(Ljava/security/PrivateKey;)V", priv);
    if (spec) await vcall(s, "setParameter", "(Ljava/security/spec/AlgorithmParameterSpec;)V", spec);
    await vcall(s, "update", "([BII)V", data, 0, 3);
    await vcall(s, "update", "([B)V", data.subarray(3));
    return vcall(s, "sign", "()[B");
  }
  async function verify(algo: string, pub: unknown, data: Int8Array, sig: Int8Array, spec?: unknown): Promise<number> {
    const s = await scall("java/security/Signature", "getInstance", "(Ljava/lang/String;)Ljava/security/Signature;", algo);
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

  test("RSA/ECB/PKCS1Padding encrypts with the public key and decrypts with the private key", async () => {
    const pair: any = await keyPair("RSA", 2048);
    const cipher = async (mode: number, key: unknown, data: Int8Array): Promise<Int8Array> => {
      const c = await scall("javax/crypto/Cipher", "getInstance", "(Ljava/lang/String;)Ljavax/crypto/Cipher;", "RSA/ECB/PKCS1Padding");
      await vcall(c, "init", "(ILjava/security/Key;)V", mode, key);
      return vcall(c, "doFinal", "([B)[B", data);
    };
    const encrypted = await cipher(1, pair.publicKey, bytes("password"));
    expect(encrypted.length).toBe(256);
    expect(await cipher(2, pair.privateKey, encrypted)).toEqual(bytes("password"));
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
    expect(await thrown(() => scall("java/security/Signature", "getInstance", "(Ljava/lang/String;)Ljava/security/Signature;", "MD2withDSA"))).toBe("java/security/NoSuchAlgorithmException");
    expect(await thrown(() => scall("java/security/Signature", "getInstance", "(Ljava/lang/String;Ljava/security/Provider;)Ljava/security/Signature;", "SHA256withRSA", null))).toBe("java/lang/IllegalArgumentException");
    const s = await scall("java/security/Signature", "getInstance", "(Ljava/lang/String;Ljava/security/Provider;)Ljava/security/Signature;", "SHA256withRSA", await newObj("java/security/Provider"));
    expect(await thrown(() => vcall(s, "update", "([B)V", bytes("x")))).toBe("java/security/SignatureException");
    const pair: any = await keyPair("EC", 256);
    expect(await thrown(() => vcallAsync(s, "initSign", "(Ljava/security/PrivateKey;)V", pair.privateKey).then(() => vcall(s, "sign", "()[B")))).toBe("java/security/InvalidKeyException");
  });
});

describe("ssl-parameters", () => {
  test("SSL sockets copy application protocols and report no selection before handshake", async () => {
    const socket = await newObj("javax/net/ssl/SSLSocket");
    const parameters = await vcall(socket, "getSSLParameters", "()Ljavax/net/ssl/SSLParameters;");
    const protocols = ["h2", "http/1.1"];
    await vcall(parameters, "setApplicationProtocols", "([Ljava/lang/String;)V", protocols);
    protocols[0] = "changed";
    await vcall(socket, "setSSLParameters", "(Ljavax/net/ssl/SSLParameters;)V", parameters);
    await vcall(parameters, "setApplicationProtocols", "([Ljava/lang/String;)V", ["changed"]);
    const stored = await vcall(socket, "getSSLParameters", "()Ljavax/net/ssl/SSLParameters;");
    expect(await vcall(stored, "getApplicationProtocols", "()[Ljava/lang/String;")).toEqual(["h2", "http/1.1"]);
    expect(await vcall(socket, "getApplicationProtocol", "()Ljava/lang/String;")).toBeNull();
    await expect(vcallAsync(parameters, "setApplicationProtocols", "([Ljava/lang/String;)V", [""])).rejects.toBeDefined();
  });

  test("SSLContext retains the selected protocol and provider", async () => {
    const cls = rt.link("javax/net/ssl/SSLContext").ctor;
    const initial = await vcall(cls, "getDefault", "()Ljavax/net/ssl/SSLContext;");
    const provider = await vcall(initial, "getProvider", "()Ljava/security/Provider;");
    const context = await vcall(cls, "getInstance", "(Ljava/lang/String;Ljava/security/Provider;)Ljavax/net/ssl/SSLContext;", "TLS", provider);
    expect(await vcall(context, "getProvider", "()Ljava/security/Provider;")).toBe(provider);
    expect(await vcall(context, "getProtocol", "()Ljava/lang/String;")).toBe("TLS");
    const engine = await vcall(context, "createSSLEngine", "()Ljavax/net/ssl/SSLEngine;");
    expect(await vcall(engine, "getApplicationProtocol", "()Ljava/lang/String;")).toBeNull();
  });
});
