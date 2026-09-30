import { expect, test, describe } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall, newObj } from "../src/jvm/natives/jlang";
import { scall, mountApexData } from "./java";

rt.linkNatives();
const hex = (b: Int8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => new Int8Array(Buffer.from(h, "hex"));
const getInstance = (cls: string, algo: string) => scall(cls, "getInstance", `(Ljava/lang/String;)L${cls};`, algo);

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
    sealed[5] ^= 1;
    await vcall(c, "init", "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V", 2, key, spec);
    await vcall(c, "updateAAD", "([B)V", Int8Array.of(1, 2, 3));
    await expect((async () => vcall(c, "doFinal", "([B)[B", sealed))()).rejects.toMatchObject({ constructor: rt.link("javax/crypto/AEADBadTagException").ctor });
  });

  test("a certificate parses, names its subject and verifies its own signature", async () => {
    await mountApexData();
    const pem = (await Bun.file(new URL("../vendor/android-cacerts.pem", import.meta.url)).text()).match(/-----BEGIN CERTIFICATE-----[^]*?-----END CERTIFICATE-----/)![0];
    const factory = await getInstance("java/security/cert/CertificateFactory", "X.509");
    const cert = await vcall(factory, "generateCertificate", "(Ljava/io/InputStream;)Ljava/security/cert/Certificate;",
      await newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array(Buffer.from(pem))));
    const subject = await vcall(cert, "getSubjectX500Principal", "()Ljavax/security/auth/x500/X500Principal;");
    expect(await vcall(subject, "getName", "()Ljava/lang/String;")).toBe("CN=Microsoft ECC Root Certificate Authority 2017,O=Microsoft Corporation,C=US");
    expect(await vcall(cert, "getSigAlgName", "()Ljava/lang/String;")).toBe("SHA384withECDSA");
    await vcall(cert, "verify", "(Ljava/security/PublicKey;)V", await vcall(cert, "getPublicKey", "()Ljava/security/PublicKey;"));
  }, 30_000);

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
});
