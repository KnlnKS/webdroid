import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { dexesIn } from "../jvm/dex";
import { newObj, vcall } from "../jvm/natives/jlang";
import { readStreamFully, vfs } from "../jvm/natives/jio";
import { appHost, setAppHost, type AppHost } from "./apphost";
import { attrStr } from "./axml";
import { parsePackageArchive } from "./packagearchive";
import { setManifest } from "./pm";
import { JTheme } from "./res";
import { JResources } from "./resnative";
import { contentResolver } from "./contentresolver";
import { mkUri } from "./net";

test("ContentResolver opens the APK through Mihon's bundled FileProvider", async () => {
  const previous = appHost;
  const archive = await parsePackageArchive(new Uint8Array(await Bun.file(new URL("../../apks/mihon-v0.20.4.apk", import.meta.url)).arrayBuffer()));
  for (const [name, bytes] of Object.entries(archive.res.zip)) if (/^classes\d*\.dex$/.test(name)) for (const dex of dexesIn(bytes, name)) rt.loadDex(dex);
  const theme = new JTheme(), jresources = new JResources(); theme.res = archive.res; jresources.host = archive.res;
  const unused = () => { throw new Error("unexpected activity lifecycle"); };
  const host: AppHost = { res: archive.res, theme, jresources, pkg: archive.pkg, apkFile: "", appLabel: "Mihon", themeResId: 0, iconRes: 0,
    zip: archive.res.zip, splits: [], application: null, statusBarColor: 0, navBarColor: 0, launch: unused, roundTrip: unused, finishActivity: unused,
    recreateActivity: unused, setRequestedOrientation: unused, currentActivity: () => null, invalidateOptionsMenu: unused };
  const path = `/data/data/${archive.pkg}/cache/provider-test.apk`, bytes = new Uint8Array([80, 75, 3, 4, 7, 9]);
  try {
    setAppHost(host);
    const nodes = archive.root.children.find((child) => child.name === "application")!.children.filter((child) => child.name === "provider");
    setManifest(archive.root, new Map(), new Map(nodes.map((child) => [attrStr(child, "name")!, child])));
    host.application = await newObj("android/app/Application"); host.application!.$host = host;
    vfs.write(path, bytes);
    rt.link("android/net/Uri");
    const uri = mkUri("content://app.mihon.provider/cache_files/provider-test.apk");
    const resolver = contentResolver();
    const open = (uri: unknown) => vcall(resolver, "openInputStream", "(Landroid/net/Uri;)Ljava/io/InputStream;", uri);
    for (let i = 0; i < 2; i++) {
      const stream = await open(uri);
      expect(await readStreamFully(stream)).toEqual(bytes);
      await vcall(stream, "close", "()V");
    }
    const cursor = await vcall(resolver, "query", "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;", uri, null, null, null, null);
    expect(await vcall(cursor, "moveToFirst", "()Z")).toBe(1);
    expect(await vcall(cursor, "getString", "(I)Ljava/lang/String;", 0)).toBe("provider-test.apk");
    expect(await vcall(cursor, "getLong", "(I)J", 1)).toBe(BigInt(bytes.length));
    expect(await vcall(cursor, "getType", "(I)I", 1)).toBe(1);
    await vcall(cursor, "close", "()V");
    await expect(open(mkUri("content://app.mihon.provider/cache_files/../private.apk"))).rejects.toBeDefined();
    await expect(open(mkUri("content://absent.provider/file"))).rejects.toBeDefined();
    await expect(open(mkUri("content://app.mihon.provider/cache_files/missing.apk"))).rejects.toBeDefined();
  } finally { vfs.delete(path); setAppHost(previous); }
}, 15000);


test("MatrixCursor copies added rows and rejects a mismatched column count", async () => {
  const cursor = await newObj("android/database/MatrixCursor", "([Ljava/lang/String;)V", ["value"]);
  const row = ["original"];
  await vcall(cursor, "addRow", "([Ljava/lang/Object;)V", row);
  row[0] = "changed";
  await expect(vcall(cursor, "addRow", "([Ljava/lang/Object;)V", [])).rejects.toBeDefined();
  expect(await vcall(cursor, "getCount", "()I")).toBe(1);
  await vcall(cursor, "moveToFirst", "()Z");
  expect(await vcall(cursor, "getString", "(I)Ljava/lang/String;", 0)).toBe("original");
  await vcall(cursor, "close", "()V");
  expect(await vcall(cursor, "isClosed", "()Z")).toBe(1);
});
