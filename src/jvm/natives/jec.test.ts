import { expect, test } from "bun:test";
import { rt } from "../runtime";
import { linkInit, newObj, vcall } from "./jlang";
import "./jmath";
import "./jsec";
import "./jcrypto";
import "./jec";

const gen = async (curve: string) => {
  const g = await vcall((await linkInit("java/security/KeyPairGenerator")).ctor, "getInstance", "(Ljava/lang/String;)Ljava/security/KeyPairGenerator;", "EC");
  await vcall(g, "initialize", "(Ljava/security/spec/AlgorithmParameterSpec;)V", await newObj("java/security/spec/ECGenParameterSpec", "(Ljava/lang/String;)V", curve));
  return vcall(g, "generateKeyPair", "()Ljava/security/KeyPair;");
};
const secret = async (priv: unknown, pub: unknown) => {
  const ka = await vcall((await linkInit("javax/crypto/KeyAgreement")).ctor, "getInstance", "(Ljava/lang/String;)Ljavax/crypto/KeyAgreement;", "ECDH");
  await vcall(ka, "init", "(Ljava/security/Key;)V", priv);
  await vcall(ka, "doPhase", "(Ljava/security/Key;Z)Ljava/security/Key;", pub, 1);
  return vcall(ka, "generateSecret", "()[B") as Promise<Int8Array>;
};

test("ECDH agrees with WebCrypto and survives an X.509 / PKCS#8 round trip", async () => {
  await linkInit("java/lang/Class");
  const a = await gen("secp256r1"), b = await gen("P-256");
  const aPub = await vcall(a, "getPublic", "()Ljava/security/PublicKey;"), aPriv = await vcall(a, "getPrivate", "()Ljava/security/PrivateKey;");
  const bPub = await vcall(b, "getPublic", "()Ljava/security/PublicKey;"), bPriv = await vcall(b, "getPrivate", "()Ljava/security/PrivateKey;");
  const ab = await secret(aPriv, bPub), ba = await secret(bPriv, aPub);
  expect([...ab]).toEqual([...ba]);
  expect(ab.length).toBe(32);

  const spkiA = new Uint8Array(await vcall(aPub, "getEncoded", "()[B") as Int8Array), pkcs8B = new Uint8Array(await vcall(bPriv, "getEncoded", "()[B") as Int8Array);
  const webA = await crypto.subtle.importKey("spki", spkiA, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const webB = await crypto.subtle.importKey("pkcs8", pkcs8B, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: webA }, webB, 256));
  expect([...new Uint8Array(ab.buffer, ab.byteOffset, ab.length)]).toEqual([...bits]);

  const kf = await vcall((await linkInit("java/security/KeyFactory")).ctor, "getInstance", "(Ljava/lang/String;)Ljava/security/KeyFactory;", "EC");
  const pub2 = await vcall(kf, "generatePublic", "(Ljava/security/spec/KeySpec;)Ljava/security/PublicKey;", await newObj("java/security/spec/X509EncodedKeySpec", "([B)V", new Int8Array(spkiA)));
  expect(await vcall(pub2, "equals", "(Ljava/lang/Object;)Z", aPub)).toBe(1);
  const priv2 = await vcall(kf, "generatePrivate", "(Ljava/security/spec/KeySpec;)Ljava/security/PrivateKey;", await newObj("java/security/spec/PKCS8EncodedKeySpec", "([B)V", new Int8Array(pkcs8B)));
  expect([...await secret(priv2, pub2)]).toEqual([...ab]);

  // a public key rebuilt from its point and the parameters the key itself reports
  const spec = await newObj("java/security/spec/ECPublicKeySpec", "(Ljava/security/spec/ECPoint;Ljava/security/spec/ECParameterSpec;)V",
    await vcall(aPub, "getW", "()Ljava/security/spec/ECPoint;"), await vcall(aPub, "getParams", "()Ljava/security/spec/ECParameterSpec;"));
  expect(await vcall(await vcall(kf, "generatePublic", "(Ljava/security/spec/KeySpec;)Ljava/security/PublicKey;", spec), "equals", "(Ljava/lang/Object;)Z", aPub)).toBe(1);
  expect(rt.iof(aPub, "java/security/interfaces/ECPublicKey")).toBe(1);
});

test("a point off the curve is rejected", async () => {
  const kf = await vcall((await linkInit("java/security/KeyFactory")).ctor, "getInstance", "(Ljava/lang/String;)Ljava/security/KeyFactory;", "EC");
  const a = await gen("secp256r1");
  const aPub = await vcall(a, "getPublic", "()Ljava/security/PublicKey;");
  const spki = new Int8Array(await vcall(aPub, "getEncoded", "()[B") as Int8Array);
  spki[spki.length - 1] ^= 1;
  const thrown = await vcall(kf, "generatePublic", "(Ljava/security/spec/KeySpec;)Ljava/security/PublicKey;", await newObj("java/security/spec/X509EncodedKeySpec", "([B)V", spki)).then(() => null, (e: { msg?: string; message?: string }) => e.msg ?? e.message);
  expect(thrown).toContain("not on the curve");
});

test("an RSA public key built from its numbers is a valid SubjectPublicKeyInfo", async () => {
  const kf = await vcall((await linkInit("java/security/KeyFactory")).ctor, "getInstance", "(Ljava/lang/String;)Ljava/security/KeyFactory;", "RSA");
  const g = await vcall((await linkInit("java/security/KeyPairGenerator")).ctor, "getInstance", "(Ljava/lang/String;)Ljava/security/KeyPairGenerator;", "RSA");
  await vcall(g, "initialize", "(I)V", 1024);
  const pub = await vcall(await vcall(g, "generateKeyPair", "()Ljava/security/KeyPair;"), "getPublic", "()Ljava/security/PublicKey;");
  const n = await vcall(pub, "getModulus", "()Ljava/math/BigInteger;"), e = await vcall(pub, "getPublicExponent", "()Ljava/math/BigInteger;");
  const spec = await newObj("java/security/spec/RSAPublicKeySpec", "(Ljava/math/BigInteger;Ljava/math/BigInteger;)V", n, e);
  const rebuilt = await vcall(kf, "generatePublic", "(Ljava/security/spec/KeySpec;)Ljava/security/PublicKey;", spec);
  expect(await vcall(rebuilt, "equals", "(Ljava/lang/Object;)Z", pub)).toBe(1);
  await crypto.subtle.importKey("spki", new Uint8Array(await vcall(rebuilt, "getEncoded", "()[B") as Int8Array), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
});
