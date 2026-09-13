import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { getPM } from "../src/android/pm";
import { PackageRecord, packages, signaturePermissions } from "../src/android/packages";
import { Resources } from "../src/android/res";
import { TV, type XmlAttr, type XmlNode } from "../src/android/axml";

rt.linkNatives();
const attr = (name: string, str: string): XmlAttr => ({ name, str, ns: "", resId: 0, type: TV.STRING, data: 0 });

test("PackageInfo aligns requested permission flags with actual package grants", async () => {
  const pkg = "test.permissions", denied = "test.permissions.SIGNATURE";
  const root: XmlNode = { name: "manifest", attrs: [attr("package", pkg)], children: [
    { name: "application", attrs: [], children: [] },
    ...["android.permission.INTERNET", denied].map(name => ({ name: "uses-permission", attrs: [attr("name", name)], children: [] })),
  ] };
  const record = new PackageRecord(root, new Resources(null, {}), "/test.apk", 12345, async () => []);
  packages.set(pkg, record); signaturePermissions.add(denied);
  try {
    const info = await vcall(getPM(), "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", pkg, 0x1000);
    expect([...info.requestedPermissions]).toEqual(["android.permission.INTERNET", denied]);
    expect([...info.requestedPermissionsFlags]).toEqual([3, 1]);
    record.grants.add(denied);
    const granted = await vcall(getPM(), "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", pkg, 0x1000);
    expect([...granted.requestedPermissionsFlags]).toEqual([3, 3]);
    const omitted = await vcall(getPM(), "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", pkg, 0);
    expect(omitted.requestedPermissions).toBeNull();
    expect(omitted.requestedPermissionsFlags).toBeNull();
  } finally { packages.delete(pkg); signaturePermissions.delete(denied); }
});
