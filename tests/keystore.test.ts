import { expect, test, describe } from "vite-plus/test";
import "../src/natives.ts";
import { vcall, newObj } from "../src/jvm/natives/jentry.ts";
import { getInstance, scall } from "./java.ts";

describe("keystore2", () => {
  test("AndroidKeyStore keys stay in the service and round-trip AES-GCM", async () => {
    await scall("android/security/keystore2/AndroidKeyStoreProvider", "install", "()V");
    const builder = await newObj("android/security/keystore/KeyGenParameterSpec$Builder", "(Ljava/lang/String;I)V", "wdtest", 3);
    await vcall(builder, "setBlockModes", "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;", Object.assign(["GCM"], { $t: "Ljava/lang/String;" }));
    await vcall(builder, "setEncryptionPaddings", "([Ljava/lang/String;)Landroid/security/keystore/KeyGenParameterSpec$Builder;", Object.assign(["NoPadding"], { $t: "Ljava/lang/String;" }));
    const gen = await scall("javax/crypto/KeyGenerator", "getInstance", "(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/KeyGenerator;", "AES", "AndroidKeyStore");
    await vcall(gen, "init", "(Ljava/security/spec/AlgorithmParameterSpec;)V", await vcall(builder, "build", "()Landroid/security/keystore/KeyGenParameterSpec;"));
    const key = await vcall(gen, "generateKey", "()Ljavax/crypto/SecretKey;");
    expect(await vcall(key, "getEncoded", "()[B")).toBeNull();
    const c = await getInstance("javax/crypto/Cipher", "AES/GCM/NoPadding");
    await vcall(c, "init", "(ILjava/security/Key;)V", 1, key);
    const sealed = await vcall(c, "doFinal", "([B)[B", new Int8Array(Buffer.from("secret")));
    const spec = await newObj("javax/crypto/spec/GCMParameterSpec", "(I[B)V", 128, await vcall(c, "getIV", "()[B"));
    await vcall(c, "init", "(ILjava/security/Key;Ljava/security/spec/AlgorithmParameterSpec;)V", 2, key, spec);
    expect(Buffer.from(await vcall(c, "doFinal", "([B)[B", sealed)).toString()).toBe("secret");
    const store = await scall("java/security/KeyStore", "getInstance", "(Ljava/lang/String;)Ljava/security/KeyStore;", "AndroidKeyStore");
    await vcall(store, "load", "(Ljava/security/KeyStore$LoadStoreParameter;)V", null);
    expect(await vcall(store, "containsAlias", "(Ljava/lang/String;)Z", "wdtest")).toBe(1);
    await vcall(store, "deleteEntry", "(Ljava/lang/String;)V", "wdtest");
    expect(await vcall(store, "containsAlias", "(Ljava/lang/String;)Z", "wdtest")).toBe(0);
  }, 30_000);
});
