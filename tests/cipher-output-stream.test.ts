import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("cipher streams encrypt on close and decrypt through reads", async () => {
  const keyBytes = Int8Array.from({ length: 16 }, (_, i) => i);
  const key = await newObj("javax/crypto/spec/SecretKeySpec", "([BLjava/lang/String;)V", keyBytes, "AES");
  const iv = await newObj("javax/crypto/spec/IvParameterSpec", "([B)V", new Int8Array(16));
  const cipher = (rt.link("javax/crypto/Cipher").ctor as any)
    [mangleMethod("getInstance", "(Ljava/lang/String;)Ljavax/crypto/Cipher;")]("AES/CBC/PKCS5Padding");
  await vcall(cipher, "init", "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V", 1, key, iv);
  const out = await newObj("java/io/ByteArrayOutputStream", "()V");
  const stream = await newObj("javax/crypto/CipherOutputStream", "(Ljava/io/OutputStream;Ljavax/crypto/Cipher;)V", out, cipher);
  await vcall(stream, "write", "([B)V", Int8Array.of(1, 2));
  await vcall(stream, "write", "(I)V", 3);
  await vcall(stream, "close", "()V");
  const ciphertext = await vcall(out, "toByteArray", "()[B") as Int8Array;
  const webKey = await crypto.subtle.importKey("raw", new Uint8Array(keyBytes), "AES-CBC", false, ["decrypt"]);
  expect(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, webKey, new Uint8Array(ciphertext)))).toEqual(Uint8Array.of(1, 2, 3));

  const decrypt = (rt.link("javax/crypto/Cipher").ctor as any)
    [mangleMethod("getInstance", "(Ljava/lang/String;)Ljavax/crypto/Cipher;")]("AES/CBC/PKCS5Padding");
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
