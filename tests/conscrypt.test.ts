import { expect, test, describe } from "vite-plus/test";
import { readFileSync } from "node:fs";
import "../src/natives.ts";
import { vcall, newObj } from "../src/jvm/natives/jentry.ts";
import { getInstance, mountApexData, thrown } from "./java.ts";

const hex = (b: Int8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => new Int8Array(Buffer.from(h, "hex"));

describe("conscrypt-natives", () => {
  test("HMAC and 3DES answer their reference vectors through the JCA", async () => {
    const mac = await getInstance("javax/crypto/Mac", "HmacSHA256");
    await vcall(mac, "init", "(Ljava/security/Key;)V", await newObj("javax/crypto/spec/SecretKeySpec", "([BLjava/lang/String;)V", new Int8Array(20).fill(0x0b), "HmacSHA256"));
    // RFC 4231 test case 1
    expect(hex(await vcall(mac, "doFinal", "([B)[B", new Int8Array(Buffer.from("Hi There"))))).toBe("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7");
    const des = await getInstance("javax/crypto/Cipher", "DESede/ECB/NoPadding");
    const key = await newObj("javax/crypto/spec/SecretKeySpec", "([BLjava/lang/String;)V", bytes("133457799bbcdff1".repeat(3)), "DESede");
    await vcall(des, "init", "(ILjava/security/Key;)V", 1, key);
    // with three equal keys EDE is single DES: FIPS 46's worked example
    expect(hex(await vcall(des, "doFinal", "([B)[B", bytes("0123456789abcdef")))).toBe("85e813540f0ab405");
  });

  test("AES-GCM matches WebCrypto and rejects a changed tag", async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32)), iv = crypto.getRandomValues(new Uint8Array(12)), data = crypto.getRandomValues(new Uint8Array(1000));
    const key = await newObj("javax/crypto/spec/SecretKeySpec", "([BLjava/lang/String;)V", new Int8Array(raw), "AES");
    const spec = await newObj("javax/crypto/spec/GCMParameterSpec", "(I[B)V", 128, new Int8Array(iv));
    const c = await getInstance("javax/crypto/Cipher", "AES/GCM/NoPadding");
    await vcall(c, "init", "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V", 1, key, spec);
    await vcall(c, "updateAAD", "([B)V", Int8Array.of(1, 2, 3));
    const sealed: Int8Array = await vcall(c, "doFinal", "([B)[B", new Int8Array(data));
    const web = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: Uint8Array.of(1, 2, 3) }, await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]), data);
    expect(hex(sealed)).toBe(Buffer.from(web).toString("hex"));
    const changed = Int8Array.from(sealed);
    changed[5] ^= 1;
    await vcall(c, "init", "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V", 2, key, spec);
    await vcall(c, "updateAAD", "([B)V", Int8Array.of(1, 2, 3));
    expect(await thrown(() => vcall(c, "doFinal", "([B)[B", changed))).toMatch(/^javax\/crypto\/AEADBadTagException:/);
  });

  test("a certificate parses, names its subject and verifies its own signature", async () => {
    await mountApexData();
    const pem = readFileSync(new URL("../vendor/android-cacerts.pem", import.meta.url), "utf8").match(/-----BEGIN CERTIFICATE-----[^]*?-----END CERTIFICATE-----/)![0];
    const factory = await getInstance("java/security/cert/CertificateFactory", "X.509");
    const cert = await vcall(factory, "generateCertificate", "(Ljava/io/InputStream;)Ljava/security/cert/Certificate;",
      await newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array(Buffer.from(pem))));
    const subject = await vcall(cert, "getSubjectX500Principal", "()Ljavax/security/auth/x500/X500Principal;");
    expect(await vcall(subject, "getName", "()Ljava/lang/String;")).toBe("CN=Microsoft ECC Root Certificate Authority 2017,O=Microsoft Corporation,C=US");
    expect(await vcall(cert, "getSigAlgName", "()Ljava/lang/String;")).toBe("SHA384withECDSA");
    await vcall(cert, "verify", "(Ljava/security/PublicKey;)V", await vcall(cert, "getPublicKey", "()Ljava/security/PublicKey;"));
  }, 30_000);

  test("the TS primitives match node:crypto's BoringSSL across sizes, modes and curves", async () => {
    const nc = await import("node:crypto");
    const { aes, ctr, AesGcm, ChaCha20Poly1305, Poly1305 } = await import("../src/jvm/natives/ciphers.ts");
    const { DIGESTS, deferred } = await import("../src/jvm/natives/digest.ts");
    const { curveByName, decodePoint, ecdsaVerify, ecdsaSign, mul, G } = await import("../src/jvm/natives/pkey.ts");
    const { modPow } = await import("../src/jvm/natives/jmath.ts");
    const { children, parseOne, bytesToBig } = await import("../src/jvm/natives/der.ts");
    const rnd = (n: number) => new Uint8Array(nc.randomBytes(n));
    const same = (a: Uint8Array, b: Uint8Array | Buffer) => expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    for (const keyLen of [16, 24, 32]) {
      const key = rnd(keyLen), iv = rnd(16), bits = keyLen * 8, bc = aes(key);
      for (const n of [0, 16, 48, 1024]) {
        const data = rnd(n), ecb = data.slice(), cbc = data.slice(), chain = iv.slice();
        for (let off = 0; off < n; off += 16) bc.encrypt(ecb, off);
        same(ecb, nc.createCipheriv(`aes-${bits}-ecb`, key, null).setAutoPadding(false).update(data));
        bc.cbc!(cbc, chain, true);
        same(cbc, nc.createCipheriv(`aes-${bits}-cbc`, key, iv).setAutoPadding(false).update(data));
        if (n) same(chain, cbc.subarray(n - 16));
        const back = cbc.slice();
        bc.cbc!(back, iv.slice(), false);
        same(back, data);
        for (let off = 0; off < n; off += 16) bc.decrypt(ecb, off);
        same(ecb, data);
      }
      for (const n of [1, 15, 17, 100]) {
        const data = rnd(n), out = data.slice(), counter = Uint8Array.from(iv);
        counter.fill(0xff, 8); // the whole-block increment carries past the low word
        const start = counter.slice();
        ctr(bc, counter, out, new Uint8Array(16), 16);
        same(out, nc.createCipheriv(`aes-${bits}-ctr`, key, start).update(data));
      }
      if (keyLen === 24) continue;
      for (const [n, nonceLen, tagLen, aadLen] of [[0, 12, 16, 0], [1, 12, 16, 3], [100, 12, 12, 20], [1024, 16, 16, 0], [33, 8, 16, 17]]) {
        const nonce = rnd(nonceLen), data = rnd(n), aad = rnd(aadLen);
        const c = nc.createCipheriv(`aes-${bits}-gcm` as import("node:crypto").CipherGCMTypes, key, nonce, { authTagLength: tagLen }).setAAD(aad);
        const expected = Buffer.concat([c.update(data), c.final(), c.getAuthTag()]);
        const sealed = new AesGcm(key).seal(nonce, data, aad, tagLen);
        same(sealed, expected);
        same(new AesGcm(key).open(nonce, sealed, aad, tagLen)!, data);
        sealed[sealed.length - 1] ^= 1;
        expect(new AesGcm(key).open(nonce, sealed, aad, tagLen)).toBeNull();
      }
    }
    // node:crypto here lacks ChaCha20-Poly1305: RFC 8439's AEAD vector (§2.8.2) and Poly1305's (§2.5.2)
    const sunscreen = new TextEncoder().encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");
    const cp = new ChaCha20Poly1305(Uint8Array.from({ length: 32 }, (_, i) => 0x80 + i)), cpNonce = Buffer.from("070000004041424344454647", "hex"), cpAad = Buffer.from("50515253c0c1c2c3c4c5c6c7", "hex");
    const sealed = cp.seal(cpNonce, sunscreen, cpAad, 16);
    expect(Buffer.from(sealed.subarray(0, 16)).toString("hex")).toBe("d31a8d34648e60db7b86afbc53ef7ec2");
    expect(Buffer.from(sealed.subarray(-16)).toString("hex")).toBe("1ae10b594f09e26a7e902ecbd0600691");
    same(cp.open(cpNonce, sealed, cpAad, 16)!, sunscreen);
    sealed[3] ^= 1;
    expect(cp.open(cpNonce, sealed, cpAad, 16)).toBeNull();
    const mac = new Poly1305(Buffer.from("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b", "hex"));
    mac.update(new TextEncoder().encode("Cryptographic Forum Research Group"));
    expect(Buffer.from(mac.digest()).toString("hex")).toBe("a8061dc1305136c6c22b8baf0c0127a9");
    // RFC 8439 A.3 #5 and #6: the accumulator ends at or above p
    for (const [key, msg] of [["02" + "00".repeat(31), "ff".repeat(16)], ["02" + "00".repeat(15) + "ff".repeat(16), "02" + "00".repeat(15)]]) {
      const m = new Poly1305(Buffer.from(key, "hex"));
      m.update(Buffer.from(msg, "hex"));
      expect(Buffer.from(m.digest()).toString("hex")).toBe("03" + "00".repeat(15));
    }
    for (const name of ["md5", "sha1", "sha224", "sha256", "sha384", "sha512"])
      for (const n of [0, 55, 56, 64, 111, 112, 129, 5000]) {
        const data = rnd(n), h = DIGESTS[name]();
        h.update(data.subarray(0, n >> 1)); h.update(data.subarray(n >> 1));
        same(h.digest(), nc.createHash(name).update(data).digest());
      }
    // held messages: the browser's digest past 64 KB, JS below it, after a clone and past the 64 MB hold
    for (const [name, n] of [["sha256", 70000], ["sha512", 100], ["sha224", 70000], ["sha1", (1 << 26) + 5]] as const) {
      const data = rnd(n), want = nc.createHash(name).update(data).digest(), h = deferred(name), c = deferred(name);
      h.update(data.subarray(0, 7)); h.update(data.subarray(7));
      same(await h.final(), want);
      c.update(data.subarray(0, n >> 1));
      const d = c.clone();
      c.update(data.subarray(n >> 1)); d.update(data.subarray(n >> 1));
      same(await c.final(), want);
      same(d.digest(), want);
    }
    for (const [ours, theirs] of [["prime256v1", "prime256v1"], ["secp384r1", "secp384r1"], ["secp521r1", "secp521r1"], ["secp224r1", "secp224r1"]]) {
      const c = curveByName(ours)!, { privateKey, publicKey } = nc.generateKeyPairSync("ec", { namedCurve: theirs });
      const Q = decodePoint(c, new Uint8Array(publicKey.export({ format: "der", type: "spki" })).subarray(-(1 + 2 * c.bytes)));
      // SEC 1 ECPrivateKey: SEQUENCE { version, OCTET STRING privateKey, ... }
      const d = bytesToBig(children(parseOne(new Uint8Array(privateKey.export({ format: "der", type: "sec1" }))).body)[1].body);
      expect(mul(c, d, G(c))).toEqual(Q);
      for (let i = 0; i < 3; i++) {
        const msg = rnd(40), digest = new Uint8Array(nc.createHash("sha256").update(msg).digest());
        const sig = new Uint8Array(nc.sign("sha256", msg, privateKey));
        expect(ecdsaVerify(c, Q, digest, sig)).toBe(true);
        digest[0] ^= 1;
        expect(ecdsaVerify(c, Q, digest, sig)).toBe(false);
        digest[0] ^= 1;
        expect(nc.verify("sha256", msg, publicKey, Buffer.from(ecdsaSign(c, d, digest)))).toBe(true);
      }
    }
    const binaryPow = (b: bigint, e: bigint, m: bigint) => { let r = 1n % m; for (b %= m; e > 0n; e >>= 1n, b = b * b % m) if (e & 1n) r = r * b % m; return r; };
    for (const bits of [8, 63, 64, 65, 200, 1024]) {
      const m = BigInt("0x" + nc.randomBytes(bits >> 3 || 1).toString("hex")) | 1n, e = BigInt("0x" + nc.randomBytes(bits >> 3 || 1).toString("hex"));
      const b = BigInt("0x" + nc.randomBytes(40).toString("hex"));
      expect(modPow(b, e, m)).toBe(binaryPow(b, e, m));
    }
  });

  test("ECDH agrees on one secret from either side", async () => {
    const gen = await getInstance("java/security/KeyPairGenerator", "EC");
    await vcall(gen, "initialize", "(I)V", 256);
    const [a, b] = [await vcall(gen, "generateKeyPair", "()Ljava/security/KeyPair;"), await vcall(gen, "generateKeyPair", "()Ljava/security/KeyPair;")];
    const secret = async (mine: unknown, theirs: unknown) => {
      const ka = await getInstance("javax/crypto/KeyAgreement", "ECDH");
      await vcall(ka, "init", "(Ljava/security/Key;)V", await vcall(mine, "getPrivate", "()Ljava/security/PrivateKey;"));
      await vcall(ka, "doPhase", "(Ljava/security/Key;Z)Ljava/security/Key;", await vcall(theirs, "getPublic", "()Ljava/security/PublicKey;"), 1);
      return hex(await vcall(ka, "generateSecret", "()[B"));
    };
    const s = await secret(a, b);
    expect(s.length).toBe(64);
    expect(await secret(b, a)).toBe(s);
  });

  test("PBKDF2 derives RFC 6070's key through PBEKeySpec", async () => {
    const spec = await newObj("javax/crypto/spec/PBEKeySpec", "([C[BII)V", Uint16Array.from("password", (c) => c.charCodeAt(0)), bytes("73616c74"), 1, 160);
    const factory = await getInstance("javax/crypto/SecretKeyFactory", "PBKDF2WithHmacSHA1");
    const key = await vcall(factory, "generateSecret", "(Ljava/security/spec/KeySpec;)Ljavax/crypto/SecretKey;", spec);
    expect(hex(await vcall(key, "getEncoded", "()[B"))).toBe("0c60c80f961f0e71f3a9b524af6012062fe037a6");
  });
});

describe("signature", () => {
  const text = (s: string) => Int8Array.from(new TextEncoder().encode(s));
  async function keyPair(algo: string, size: number) {
    const gen = await getInstance("java/security/KeyPairGenerator", algo);
    await vcall(gen, "initialize", "(I)V", size);
    const pair = await vcall(gen, "generateKeyPair", "()Ljava/security/KeyPair;");
    return { priv: await vcall(pair, "getPrivate", "()Ljava/security/PrivateKey;"), pub: await vcall(pair, "getPublic", "()Ljava/security/PublicKey;") };
  }
  let rsa: Promise<{ priv: unknown; pub: unknown }> | null = null;
  const rsaPair = () => rsa ??= keyPair("RSA", 2048);
  async function sign(algo: string, priv: unknown, data: Int8Array, spec?: unknown): Promise<Int8Array> {
    const s = await getInstance("java/security/Signature", algo);
    await vcall(s, "initSign", "(Ljava/security/PrivateKey;)V", priv);
    if (spec) await vcall(s, "setParameter", "(Ljava/security/spec/AlgorithmParameterSpec;)V", spec);
    await vcall(s, "update", "([BII)V", data, 0, 3);
    await vcall(s, "update", "([B)V", data.subarray(3));
    return vcall(s, "sign", "()[B");
  }
  async function verify(algo: string, pub: unknown, data: Int8Array, sig: Int8Array, spec?: unknown): Promise<number> {
    const s = await getInstance("java/security/Signature", algo);
    await vcall(s, "initVerify", "(Ljava/security/PublicKey;)V", pub);
    if (spec) await vcall(s, "setParameter", "(Ljava/security/spec/AlgorithmParameterSpec;)V", spec);
    await vcall(s, "update", "([B)V", data);
    return vcall(s, "verify", "([B)Z", sig);
  }

  test("SHA256withRSA signs and verifies; a changed message fails", async () => {
    const pair = await rsaPair(), data = text("hello signature");
    const sig = await sign("SHA256withRSA", pair.priv, data);
    expect(sig.length).toBe(256);
    expect(await verify("SHA256withRSA", pair.pub, data, sig)).toBe(1);
    expect(await verify("SHA256withRSA", pair.pub, text("hello signaturf"), sig)).toBe(0);
    expect(await verify("SHA512withRSA", pair.pub, data, sig)).toBe(0);
  });

  test("RSA/ECB/PKCS1Padding encrypts with the public key and decrypts with the private key", async () => {
    const pair = await rsaPair();
    const cipher = async (mode: number, key: unknown, data: Int8Array): Promise<Int8Array> => {
      const c = await getInstance("javax/crypto/Cipher", "RSA/ECB/PKCS1Padding");
      await vcall(c, "init", "(ILjava/security/Key;)V", mode, key);
      return vcall(c, "doFinal", "([B)[B", data);
    };
    const encrypted = await cipher(1, pair.pub, text("password"));
    expect(encrypted.length).toBe(256);
    expect(await cipher(2, pair.priv, encrypted)).toEqual(text("password"));
  });

  test("RSA-PSS uses the digest-length salt by default and PSSParameterSpec otherwise", async () => {
    const pair = await rsaPair(), data = text("pss message");
    const sig = await sign("SHA256withRSA/PSS", pair.priv, data);
    expect(await verify("SHA256withRSA/PSS", pair.pub, data, sig)).toBe(1);
    expect(await verify("SHA256withRSAandMGF1", pair.pub, data, sig)).toBe(1);
    const mgf = await newObj("java/security/spec/MGF1ParameterSpec", "(Ljava/lang/String;)V", "SHA-256");
    const spec = await newObj("java/security/spec/PSSParameterSpec", "(Ljava/lang/String;Ljava/lang/String;Ljava/security/spec/AlgorithmParameterSpec;II)V", "SHA-256", "MGF1", mgf, 20, 1);
    const salted = await sign("SHA256withRSA/PSS", pair.priv, data, spec);
    expect(await verify("SHA256withRSA/PSS", pair.pub, data, salted, spec)).toBe(1);
    expect(await verify("SHA256withRSA/PSS", pair.pub, data, salted)).toBe(0);
  });

  test("SHA256withECDSA produces DER signatures that verify", async () => {
    const pair = await keyPair("EC", 256), data = text("ecdsa message");
    const sig = await sign("SHA256withECDSA", pair.priv, data);
    expect(sig[0]).toBe(0x30);
    expect(sig[1] + 2).toBe(sig.length);
    expect(await verify("SHA256withECDSA", pair.pub, data, sig)).toBe(1);
    expect(await verify("SHA256withECDSA", pair.pub, text("ecdsa messagf"), sig)).toBe(0);
    expect(await verify("SHA256withECDSA", pair.pub, data, sig.subarray(0, sig.length - 1))).toBe(0);
  });
});
