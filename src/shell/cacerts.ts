import { certificates } from "../../vendor/android-cacerts-index";
import { vfs } from "../jvm/natives/jio";
import { RangeFile, SliceFile, type FileSource } from "./lazyfile";

export function mountSystemCertificates(source: FileSource = new RangeFile(
  "/vendor/android-cacerts.pem", certificates.reduce((size, [, length]) => size + length, 0), 1 << 16, 4,
)): void {
  let offset = 0;
  for (const [name, length] of certificates) {
    vfs.mount(`/system/etc/security/cacerts/${name}`, new SliceFile(source, offset, length));
    offset += length;
  }
}
