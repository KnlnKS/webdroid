import { expect, test } from "bun:test";
import "../src/natives";
import { JObj, rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { parsePackageArchive } from "../src/android/packagearchive";
import { getPM, registerPackage } from "../src/android/pm";
import { vfs } from "../src/jvm/natives/jio";
import { newArrayList, toJsArray } from "../src/jvm/natives/jutil";

class ChecksumListener extends JObj { checksums: unknown = null; }
rt.register({
  name: "test/ChecksumListener", ctor: ChecksumListener, ifaces: ["android/content/pm/PackageManager$OnChecksumsReadyListener"],
  methods: { "onChecksumsReady(Ljava/util/List;)V": function (this: ChecksumListener, checksums: unknown) { this.checksums = checksums; } },
});
rt.linkNatives();

test("PackageManager reports installed APK checksums and signing certificates", async () => {
  const bytes = new Uint8Array(await Bun.file("apks/FitNotes.apk").arrayBuffer());
  const archive = await parsePackageArchive(bytes);
  const path = "/data/app/checksum-test/base.apk";
  vfs.write(path, bytes);
  registerPackage(archive, path);
  const listener = new ChecksumListener();
  await vcall(getPM(), "requestChecksums", "(Ljava/lang/String;ZILjava/util/List;Landroid/content/pm/PackageManager$OnChecksumsReadyListener;)V", archive.pkg, 0, 8, newArrayList(), listener);
  const checksums = await toJsArray(listener.checksums);
  expect(checksums).toHaveLength(1);
  expect(await vcall(checksums[0], "getSplitName", "()Ljava/lang/String;")).toBeNull();
  expect(await vcall(checksums[0], "getType", "()I")).toBe(8);
  expect(await vcall(checksums[0], "getValue", "()[B")).toHaveLength(32);
  const cert = archive.certificates[0];
  const hash = new Int8Array(await crypto.subtle.digest("SHA-256", cert.slice()));
  const hasCertificate = (bytes: Int8Array, type: number) =>
    vcall(getPM(), "hasSigningCertificate", "(Ljava/lang/String;[BI)Z", archive.pkg, bytes, type);
  expect(await hasCertificate(new Int8Array(cert), 0)).toBe(1);
  expect(await hasCertificate(hash, 1)).toBe(1);
  hash[0] ^= 1;
  expect(await hasCertificate(hash, 1)).toBe(0);
  expect(await hasCertificate(new Int8Array(cert), 2)).toBe(0);
});
