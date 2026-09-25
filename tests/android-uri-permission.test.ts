import { expect, test } from "bun:test";
import "../src/natives";
import { checkUriPermission, grantUriPermission, revokeUriPermission } from "../src/android/contentresolver";
import { mkUri } from "../src/android/net";
import { packages, type PackageRecord } from "../src/android/packages";

test("tree URI grants cover descendants with the granted access mode", () => {
  const pkg = "org.webdroid.test.uri";
  const uid = 77123;
  const tree = mkUri("content://com.android.externalstorage.documents/tree/test%3A");
  packages.set(pkg, { uid } as PackageRecord);
  try {
    grantUriPermission(pkg, tree, 1 | 0x80);
    const child = mkUri(tree.uri + "/document/test%3Afile.txt");
    const sibling = mkUri("content://com.android.externalstorage.documents/tree/test%3Aother/document/test%3Aother");
    expect(checkUriPermission(child, 1, uid, 1)).toBe(0);
    expect(checkUriPermission(child, 1, uid, 2)).toBe(-1);
    expect(checkUriPermission(sibling, 1, uid, 1)).toBe(-1);
    revokeUriPermission(tree, 1);
    expect(checkUriPermission(child, 1, uid, 1)).toBe(-1);
  } finally {
    packages.delete(pkg);
    revokeUriPermission(tree, 3);
  }
});
