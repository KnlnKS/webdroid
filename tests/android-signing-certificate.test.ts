import { expect, test } from "bun:test";
import "../src/natives";
import { getPM } from "../src/android/pm";
import { packages, type PackageRecord } from "../src/android/packages";
import { vcall } from "../src/jvm/natives/jlang";

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
