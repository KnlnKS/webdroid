import { certificates } from "../../vendor/android-cacerts-index.ts";
import { vfs } from "./vfs.ts";
import { RangeFile, SliceFile } from "./lazyfile.ts";

export function mountSystemCertificates(): void {
  const source = new RangeFile("/vendor/android-cacerts.pem", certificates.reduce((size, [, length]) => size + length, 0), 1 << 16, 4);
  let offset = 0;
  for (const [name, length] of certificates) {
    vfs.mount(`/system/etc/security/cacerts/${name}`, new SliceFile(source, offset, length));
    offset += length;
  }
}
