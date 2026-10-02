import { certificates } from "../../vendor/android-cacerts-index";
import { vfs } from "./vfs";
import { RangeFile, SliceFile } from "./lazyfile";

export function mountSystemCertificates(): void {
  const source = new RangeFile("/vendor/android-cacerts.pem", certificates.reduce((size, [, length]) => size + length, 0), 1 << 16, 4);
  let offset = 0;
  for (const [name, length] of certificates) {
    vfs.mount(`/system/etc/security/cacerts/${name}`, new SliceFile(source, offset, length));
    offset += length;
  }
}
