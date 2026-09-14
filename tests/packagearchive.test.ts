import { expect, test } from "bun:test";
import { apkCertificates } from "../src/android/packagearchive";
import { zipTree } from "../src/jvm/natives/jzip";

test("v1 APK certificate discovery leaves unrelated ZIP entries lazy", async () => {
  const bytes = new Uint8Array(await Bun.file("apks/flappybird.apk").arrayBuffer());
  const zip = zipTree(bytes), descriptors = Object.getOwnPropertyDescriptors(zip);
  const certificates = await apkCertificates(bytes, zip);
  expect(certificates).toHaveLength(1);
  expect(new Bun.CryptoHasher("sha256").update(certificates[0]).digest("hex"))
    .toBe("91cc0cfca44abfc55f7974e68fb4bcaa9684d6e222d44f3393b5c4bcdbc95654");
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!/^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(name)) {
      expect(Object.getOwnPropertyDescriptor(zip, name)?.get).toBe(descriptor.get);
    }
  }
});
