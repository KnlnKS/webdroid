import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { FLAG_IS_GAME, getPM } from "../src/android/pm";
import { PackageRecord, packages } from "../src/android/packages";
import { Resources } from "../src/android/res";
import { TV, type XmlNode } from "../src/android/axml";

rt.linkNatives();

test("installed game metadata survives the PackageManager ApplicationInfo path", async () => {
  const pkg = "test.game.info";
  const root: XmlNode = { name: "manifest", attrs: [{ name: "package", str: pkg, ns: "", resId: 0, type: TV.STRING, data: 0 }], children: [
    { name: "application", attrs: [
      { name: "appCategory", str: null, ns: "", resId: 0, type: TV.INT_DEC, data: 0 },
      { name: "isGame", str: null, ns: "", resId: 0, type: TV.BOOLEAN, data: 1 },
    ], children: [] },
  ] };
  const record = new PackageRecord(root, new Resources(null, {}), "/test-game.apk", 12345, async () => []);
  record.system = true;
  packages.set(pkg, record);
  try {
    const info = await vcall(getPM(), "getApplicationInfo", "(Ljava/lang/String;I)Landroid/content/pm/ApplicationInfo;", pkg, 0);
    expect([info.category, info.flags & (FLAG_IS_GAME | 1)]).toEqual([0, FLAG_IS_GAME | 1]);
  } finally { packages.delete(pkg); }
});
