import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("Blowfish key generator returns fresh 128-bit raw keys by default", async () => {
  const generator = (rt.link("javax/crypto/KeyGenerator").ctor as any)
    [mangleMethod("getInstance", "(Ljava/lang/String;)Ljavax/crypto/KeyGenerator;")]("Blowfish");
  const first = await vcall(generator, "generateKey", "()Ljavax/crypto/SecretKey;");
  const second = await vcall(generator, "generateKey", "()Ljavax/crypto/SecretKey;");
  const bytes = await vcall(first, "getEncoded", "()[B") as Int8Array;
  expect(bytes.length).toBe(16);
  expect(await vcall(first, "getAlgorithm", "()Ljava/lang/String;")).toBe("Blowfish");
  expect(await vcall(second, "getEncoded", "()[B")).not.toEqual(bytes);
});
