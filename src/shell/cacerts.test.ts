import { expect, test } from "bun:test";
import { X509Certificate, createHash } from "node:crypto";
import { certificates } from "../../vendor/android-cacerts-index";
import { vfs } from "../jvm/natives/jio";
import { mountSystemCertificates } from "./cacerts";
import { BytesFile, readFully } from "./lazyfile";

test("Android CA files preserve the pinned certificates and mount without reads", async () => {
  const bytes = new Uint8Array(await Bun.file("vendor/android-cacerts.pem").arrayBuffer());
  const file = new BytesFile(bytes);
  let reads = 0;
  mountSystemCertificates({ size: file.size, read: (offset, length) => { reads++; return file.read(offset, length); } });
  expect(reads).toBe(0);
  expect(vfs.isDir("/system/etc/security/cacerts")).toBe(true);
  let length = 0;
  for (const [name, size] of certificates) {
    const path = `/system/etc/security/cacerts/${name}`, source = vfs.source(path)!;
    expect(source.size).toBe(size);
    const pem = await readFully(source);
    const certificate = new X509Certificate(pem);
    expect(certificate.ca).toBe(true);
    expect(pem).toEqual(bytes.subarray(length, length + size));
    length += size;
    vfs.lazyFiles.delete(path);
  }
  expect(length).toBe(bytes.length);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("e5800ec5bfb94f7c4dc138886e2a27c3aa3f9f5c81299f7229c71250d35d1fb1");
});
