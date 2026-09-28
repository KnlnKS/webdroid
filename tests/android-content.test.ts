import { expect, test, describe } from "bun:test";
import { zipSync } from "fflate";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { checkUriPermission, grantUriPermission, revokeUriPermission, providerOperations } from "../src/android/contentresolver";
import { mkUri } from "../src/android/net";
import { packages, PackageRecord, signaturePermissions } from "../src/android/packages";
import { mangleMethod } from "../src/jvm/abi";
import { JContext, JContextWrapper, display } from "../src/android/context";
import { vfs } from "../src/shell/vfs";
import { pickFiles } from "../src/shell/hostfs";
import { centralDir, zipTree } from "../src/jvm/natives/jzip";
import { mergeInstall } from "../src/shell/install";
import { BytesFile, readFully } from "../src/shell/lazyfile";
import { parsePackageArchive, apkCertificates } from "../src/android/packagearchive";
import { getPM, registerPackage, FLAG_IS_GAME } from "../src/android/pm";
import { newArrayList, toJsArray } from "../src/jvm/natives/jutil";
import { Resources, JTheme, T_STR, themeOf } from "../src/android/res";
import { TV, type XmlNode, type XmlAttr } from "../src/android/axml";
import { JIntent } from "../src/android/intent";
import { encodeIntent } from "../src/android/intentipc";
import { PendingIntents } from "../src/shell/pendingintents";
import { mkPfd } from "../src/android/os";
import { decodeProviderValue, encodeProviderValue } from "../src/android/provideripc";
import { javaReadFd } from "../src/native/stdio";
import { Arsc } from "../src/android/arsc";
import { mkJResources } from "../src/android/resnative";
import { JTypedValue } from "../src/android/util";
import { locationTransport } from "../src/android/locationmanager";
import { getInflater } from "../src/android/inflate";
import { JFrameLayout } from "../src/android/layouts";
import { JWindow } from "../src/android/window";
import { resolveSystemBars } from "../src/shell/systembars";
import { device } from "../src/shell/config";
import { JView, dispatchAttached, uiState } from "../src/android/view";
import { addOverlay, overlays, detachContextOverlays, removeOverlay } from "../src/android/popup";
import { JActivity } from "../src/android/app";
import { scall } from "./java";

describe("adservices", () => {
  rt.linkNatives();

  test("disabled measurement service reports its unavailable state", async () => {
    const context = await newObj("android/content/Context");
    const cls = rt.classFor("android/adservices/measurement/MeasurementManager");
    expect(await vcall(context, "getSystemServiceName", "(Ljava/lang/Class;)Ljava/lang/String;", cls)).toBe("measurement_service");
    const manager = await vcall(context, "getSystemService", "(Ljava/lang/Class;)Ljava/lang/Object;", cls);
    expect(rt.iof(manager, "android/adservices/measurement/MeasurementManager")).toBe(1);
    await expect(vcallAsync(manager, "registerTrigger", "(Landroid/net/Uri;Ljava/util/concurrent/Executor;Landroid/os/OutcomeReceiver;)V", null, null, null))
      .rejects.toMatchObject({ constructor: rt.link("java/lang/UnsupportedOperationException").ctor });
  });
});

describe("android-uri-permission", () => {
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
});

describe("app-ops", () => {
  rt.linkNatives();

  test("AppOpsManager accepts and removes active-operation watchers", async () => {
    const manager = await newObj("android/app/AppOpsManager");
    const executor = new JObj();
    const listener = await newObj("android/app/AppOpsManager$OnOpActiveChangedListener");
    await vcall(manager, "startWatchingActive", "([Ljava/lang/String;Ljava/util/concurrent/Executor;Landroid/app/AppOpsManager$OnOpActiveChangedListener;)V", ["android:camera"], executor, listener);
    await vcall(manager, "stopWatchingActive", "(Landroid/app/AppOpsManager$OnOpActiveChangedListener;)V", listener);
    await expect(vcallAsync(manager, "startWatchingActive", "([Ljava/lang/String;Ljava/util/concurrent/Executor;Landroid/app/AppOpsManager$OnOpActiveChangedListener;)V", null, executor, listener)).rejects.toBeDefined();
  });
});

describe("clip-data", () => {
  rt.linkNatives();

  test("ClipData.newIntent retains its description and intent item", async () => {
    const intent = await newObj("android/content/Intent");
    const clip = await (rt.link("android/content/ClipData").ctor as any)[mangleMethod("newIntent", "(Ljava/lang/CharSequence;Landroid/content/Intent;)Landroid/content/ClipData;")]("label", intent);
    expect(await vcall(clip, "getItemCount", "()I")).toBe(1);
    const item = await vcall(clip, "getItemAt", "(I)Landroid/content/ClipData$Item;", 0);
    expect(await vcall(item, "getIntent", "()Landroid/content/Intent;")).toBe(intent);
    const description = await vcall(clip, "getDescription", "()Landroid/content/ClipDescription;");
    expect(await vcall(description, "getMimeType", "(I)Ljava/lang/String;", 0)).toBe("text/vnd.android.intent");
  });

  test("ClipData carries nested intents across a Parcel boundary", async () => {
    const inner = await newObj("android/content/Intent", "(Ljava/lang/String;)V", "test.action");
    const clip = await vcall(rt.link("android/content/ClipData").ctor, "newIntent", "(Ljava/lang/CharSequence;Landroid/content/Intent;)Landroid/content/ClipData;", "label", inner);
    const outer = await newObj("android/content/Intent");
    await vcall(outer, "setClipData", "(Landroid/content/ClipData;)V", clip);
    const parcel = await newObj("android/os/Parcel");
    await vcall(outer, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
    await vcall(parcel, "setDataPosition", "(I)V", 0);
    const restored = await newObj("android/content/Intent", "(Landroid/os/Parcel;)V", parcel);
    const result = await vcall(restored, "getClipData", "()Landroid/content/ClipData;");
    expect(result).not.toBe(clip);
    const desc = await vcall(result, "getDescription", "()Landroid/content/ClipDescription;");
    expect(await vcall(desc, "getLabel", "()Ljava/lang/CharSequence;")).toBe("label");
    expect(await vcall(desc, "hasMimeType", "(Ljava/lang/String;)Z", "text/*")).toBe(1);
    const item = await vcall(result, "getItemAt", "(I)Landroid/content/ClipData$Item;", 0);
    const intent = await vcall(item, "getIntent", "()Landroid/content/Intent;");
    expect(await vcall(intent, "getAction", "()Ljava/lang/String;")).toBe("test.action");
    expect(await vcall(parcel, "dataAvail", "()I")).toBe(0);
  });
});

describe("content-uris", () => {
  rt.linkNatives();

  test("ContentUris appends and parses signed and full-width long IDs", async () => {
    const base = scall("android/net/Uri", "parse", "(Ljava/lang/String;)Landroid/net/Uri;", "content://media/items?sort=new");
    const appended = await scall("android/content/ContentUris", "withAppendedId", "(Landroid/net/Uri;J)Landroid/net/Uri;", base, -42n);
    expect(await vcall(appended, "toString", "()Ljava/lang/String;")).toBe("content://media/items/-42?sort=new");
    expect(await scall("android/content/ContentUris", "parseId", "(Landroid/net/Uri;)J", appended)).toBe(-42n);
    const max = await scall("android/content/ContentUris", "withAppendedId", "(Landroid/net/Uri;J)Landroid/net/Uri;", base, 9223372036854775807n);
    expect(await scall("android/content/ContentUris", "parseId", "(Landroid/net/Uri;)J", max)).toBe(9223372036854775807n);
  });

  test("ContentUris rejects a path without a decimal long ID", async () => {
    const uri = scall("android/net/Uri", "parse", "(Ljava/lang/String;)Landroid/net/Uri;", "content://media/items/not-an-id");
    await expect((async () => Promise.resolve().then(() => scall("android/content/ContentUris", "parseId", "(Landroid/net/Uri;)J", uri)))())
      .rejects.toMatchObject({ constructor: { $i: { name: "java/lang/NumberFormatException" } } });
  });
});

describe("context-process-state", () => {
  rt.linkNatives();

  test("Context.databaseList returns private database directory entries", async () => {
    const context = rt.make("android/content/Context") as JContext;
    context.$host = { pkg: "database-list-test" } as JContext["$host"];
    const dir = "/data/data/database-list-test/databases";
    const paths = [`${dir}/main.db`, `${dir}/main.db-wal`];
    for (const path of paths) vfs.write(path, new Uint8Array(0));
    try {
      const names = await vcall(context, "databaseList", "()[Ljava/lang/String;") as string[];
      expect([...names].sort()).toEqual(["main.db", "main.db-wal"]);
    } finally {
      for (const path of paths) vfs.delete(path);
    }
  });
});

describe("file-system-provider", () => {
  rt.linkNatives();

  test("FileSystemProvider performs file operations through the VFS", async () => {
    const provider = await newObj("java/nio/file/spi/FileSystemProvider", "()V");
    const file = await newObj("java/io/File", "(Ljava/lang/String;)V", "/data/provider-test.txt");
    const path = await vcall(file, "toPath", "()Ljava/nio/file/Path;");
    const output = await vcall(provider, "newOutputStream", "(Ljava/nio/file/Path;[Ljava/nio/file/OpenOption;)Ljava/io/OutputStream;", path, []);
    await vcall(output, "write", "([B)V", new Int8Array([10, 20, 30]));
    await vcall(output, "close", "()V");
    await vcall(provider, "checkAccess", "(Ljava/nio/file/Path;[Ljava/nio/file/AccessMode;)V", path, []);
    const attrs = await vcall(provider, "readAttributes", "(Ljava/nio/file/Path;Ljava/lang/Class;[Ljava/nio/file/LinkOption;)Ljava/nio/file/attribute/BasicFileAttributes;", path, null, []);
    expect(await vcall(attrs, "size", "()J")).toBe(3n);
    expect(await vcall(provider, "deleteIfExists", "(Ljava/nio/file/Path;)Z", path)).toBe(1);
    expect(await vcall(provider, "deleteIfExists", "(Ljava/nio/file/Path;)Z", path)).toBe(0);
  });
});

describe("hostfs-picker-gesture", () => {
  test("a save picker waits for a fresh gesture when activation expires", async () => {
    const oldWindow = globalThis.window;
    const oldAdd = globalThis.addEventListener;
    let press: (() => void) | undefined;
    let calls = 0;
    const handle = { kind: "file", name: "backup.zip" } as FileSystemFileHandle;
    Object.assign(globalThis, {
      window: { showSaveFilePicker: async () => {
        if (++calls === 1) throw Object.assign(new Error(), { name: "SecurityError" });
        return handle;
      } },
      addEventListener: (_name: string, callback: () => void) => { press = callback; },
    });
    try {
      const picked = pickFiles({ save: "backup.zip" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(calls).toBe(1);
      expect(press).toBeDefined();
      press!();
      expect(await picked).toEqual([handle]);
      expect(calls).toBe(2);
    } finally {
      Object.assign(globalThis, { window: oldWindow, addEventListener: oldAdd });
    }
  });
});

describe("install-merge", () => {
  test("split assets keep first-wins precedence across resident and lazy entries", async () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const base = zipSync({ "assets/shared.txt": encode("base") });
    const lazy = zipSync({ "assets/shared.txt": encode("lazy"), "assets/unique.txt": encode("lazy unique") });
    const resident = zipSync({ "assets/unique.txt": encode("resident"), "assets/last.txt": encode("last") });
    const install = mergeInstall([
      { kind: "resident", source: new BytesFile(base), bytes: base, zip: zipTree(base), split: null, hasManifest: true },
      { kind: "lazy", source: new BytesFile(lazy), bytes: null, zip: null, entries: centralDir(lazy), split: "asset_pack", hasManifest: true },
      { kind: "resident", source: new BytesFile(resident), bytes: resident, zip: zipTree(resident), split: "feature", hasManifest: true },
    ]);

    expect(new TextDecoder().decode(install.zip["assets/shared.txt"])).toBe("base");
    expect(install.lazyEntries.has("assets/shared.txt")).toBe(false);
    expect(new TextDecoder().decode(await readFully(install.lazyEntries.get("assets/unique.txt")!))).toBe("lazy unique");
    expect(install.zip["assets/unique.txt"]).toBeUndefined();
    expect(new TextDecoder().decode(install.zip["assets/last.txt"])).toBe("last");
  });
});

describe("intent-chooser", () => {
  rt.linkNatives();
  test("createChooser retains the send intent behind ACTION_CHOOSER", async () => {
    const send = await newObj("android/content/Intent", "(Ljava/lang/String;)V", "android.intent.action.SEND_MULTIPLE");
    await vcall(send, "addFlags", "(I)Landroid/content/Intent;", 1);
    const chooser = await vcall(rt.link("android/content/Intent").ctor, "createChooser",
      "(Landroid/content/Intent;Ljava/lang/CharSequence;)Landroid/content/Intent;", send, "Share track");
    expect(await vcall(chooser, "getAction", "()Ljava/lang/String;")).toBe("android.intent.action.CHOOSER");
    expect(await vcall(chooser, "getParcelableExtra", "(Ljava/lang/String;)Landroid/os/Parcelable;", "android.intent.extra.INTENT")).toBe(send);
    expect(await vcall(chooser, "getFlags", "()I")).toBe(1);
  });
});

describe("intent-typed-extras", () => {
  rt.linkNatives();
  test("typed extras keep their type through a Parcel and reach Bundle.readFromParcel", async () => {
    const intent = await newObj("android/content/Intent", "()V");
    const component = await newObj("android/content/ComponentName", "(Ljava/lang/String;Ljava/lang/String;)V", "p", "p.C");
    const values: [string, string, unknown][] = [["J", "[J", new BigInt64Array([1n, -2n])], ["C", "[C", new Uint16Array([65, 66])],
      ["S", "[S", new Int16Array([-3])], ["Z", "[Z", new Uint8Array([1, 0])], ["F", "[F", new Float32Array([0.5])],
      ["D", "[D", new Float64Array([0.25])], ["b", "B", -7], ["s", "S", 300], ["r", "[Landroid/os/Parcelable;", Object.assign([component], { $t: "Landroid/os/Parcelable;" })]];
    for (const [k, d, v] of values) await vcall(intent, "putExtra", `(Ljava/lang/String;${d})Landroid/content/Intent;`, k, v);
    const parcel = await newObj("android/os/Parcel", "()V");
    await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", intent, 0);
    await vcall(parcel, "setDataPosition", "(I)V", 0);
    const back = await vcall(parcel, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
    expect([...await vcall(back, "getLongArrayExtra", "(Ljava/lang/String;)[J", "J")]).toEqual([1n, -2n]);
    expect([...await vcall(back, "getCharArrayExtra", "(Ljava/lang/String;)[C", "C")]).toEqual([65, 66]);
    expect([...await vcall(back, "getBooleanArrayExtra", "(Ljava/lang/String;)[Z", "Z")]).toEqual([1, 0]);
    expect(await vcall(back, "getShortExtra", "(Ljava/lang/String;S)S", "s", 0)).toBe(300);
    expect(await vcall(back, "getByteExtra", "(Ljava/lang/String;B)B", "s", 9)).toBe(9);
    const components = await vcall(back, "getParcelableArrayExtra", "(Ljava/lang/String;Ljava/lang/Class;)[Ljava/lang/Object;", "r", rt.classFor("android/content/ComponentName"));
    expect(await vcall(components[0], "equals", "(Ljava/lang/Object;)Z", component)).toBe(1);

    const extras = await vcall(back, "getExtras", "()Landroid/os/Bundle;");
    const bundleParcel = await newObj("android/os/Parcel", "()V");
    await vcall(extras, "writeToParcel", "(Landroid/os/Parcel;I)V", bundleParcel, 0);
    await vcall(bundleParcel, "setDataPosition", "(I)V", 0);
    const bundle = await newObj("android/os/Bundle", "()V");
    await vcall(bundle, "readFromParcel", "(Landroid/os/Parcel;)V", bundleParcel);
    expect((await vcall(bundle, "getByte", "(Ljava/lang/String;B)Ljava/lang/Byte;", "b", 0)).v).toBe(-7);
    expect([...await vcall(bundle, "getDoubleArray", "(Ljava/lang/String;)[D", "D")]).toEqual([0.25]);
    expect(await vcall(bundle, "getParcelable", "(Ljava/lang/String;Ljava/lang/Class;)Ljava/lang/Object;", "r", rt.classFor("android/content/ComponentName"))).toBeNull();
    await vcall(bundle, "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", "p", component);
    expect(await vcall(bundle, "getParcelable", "(Ljava/lang/String;Ljava/lang/Class;)Ljava/lang/Object;", "p", rt.classFor("android/content/ComponentName"))).toBe(component);
    expect(await vcall(bundle, "getSerializable", "(Ljava/lang/String;Ljava/lang/Class;)Ljava/io/Serializable;", "p", rt.classFor("java/lang/String"))).toBeNull();
  });
});

describe("intent-filter-path", () => {
  rt.linkNatives();

  test("IntentFilter requires a matching authority before applying decoded path patterns", async () => {
    const filter = await newObj("android/content/IntentFilter");
    await vcall(filter, "addDataScheme", "(Ljava/lang/String;)V", "https");
    await vcall(filter, "addDataAuthority", "(Ljava/lang/String;Ljava/lang/String;)V", "*.example.com", "443");
    await vcall(filter, "addDataPath", "(Ljava/lang/String;I)V", "/place/.*", 2);
    const match = (uri: string) => vcall(filter, "matchData", "(Ljava/lang/String;Ljava/lang/String;Landroid/net/Uri;)I", null, "https", mkUri(uri));
    expect(await match("https://a.example.com:443/place/a%20b")).toBe(0x508000);
    expect(await match("https://a.example.com:442/place/a")).toBe(-2);
    expect(await match("https://elsewhere.test:443/place/a")).toBe(-2);
    expect(await match("https://a.example.com:443/other")).toBe(-2);
  });

  test("IntentFilter parcels retain data matching and Android field order", async () => {
    const filter = await newObj("android/content/IntentFilter", "(Ljava/lang/String;)V", "test.action");
    await vcall(filter, "addCategory", "(Ljava/lang/String;)V", "test.category");
    await vcall(filter, "addDataScheme", "(Ljava/lang/String;)V", "https");
    await vcall(filter, "addDataAuthority", "(Ljava/lang/String;Ljava/lang/String;)V", "*.example.com", null);
    await vcall(filter, "addDataPath", "(Ljava/lang/String;I)V", "/place/", 1);
    await vcall(filter, "setPriority", "(I)V", 17);
    const parcel = await newObj("android/os/Parcel");
    await vcall(filter, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
    await vcall(parcel, "setDataPosition", "(I)V", 0);
    expect(await vcall(parcel, "createStringArray", "()[Ljava/lang/String;")).toEqual(["test.action"]);
    expect(await vcall(parcel, "readInt", "()I")).toBe(1);
    expect(await vcall(parcel, "createStringArray", "()[Ljava/lang/String;")).toEqual(["test.category"]);
    await vcall(parcel, "setDataPosition", "(I)V", 0);
    const restored = await vcall(rt.link("android/content/IntentFilter").ctor.s$CREATOR, "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", parcel);
    expect(await vcall(restored, "getPriority", "()I")).toBe(17);
    expect(await vcall(restored, "matchData", "(Ljava/lang/String;Ljava/lang/String;Landroid/net/Uri;)I", null, "https", mkUri("https://a.example.com/place/a"))).toBe(0x508000);
    expect(await vcall(parcel, "dataAvail", "()I")).toBe(0);
  });
});

describe("package-checksums", () => {
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
});

describe("package-game-info", () => {
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
});

describe("package-permissions", () => {
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
});

describe("packagearchive", () => {
  test("v1 APK certificate discovery leaves unrelated ZIP entries lazy", async () => {
    const bytes = new Uint8Array(await Bun.file("apks/flappybird.apk").arrayBuffer());
    const zip = zipTree(bytes), descriptors = Object.getOwnPropertyDescriptors(zip);
    const certificates = await apkCertificates(bytes, zip);
    expect(certificates).toHaveLength(1);
    expect(new Bun.CryptoHasher("sha256").update(certificates[0]).digest("hex"))
      .toBe("91cc0cfca44abfc55f7974e68fb4bcaa9684d6e222d44f3393b5c4bcdbc95654");
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (!/^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(name)) {
        expect(Object.getOwnPropertyDescriptor(zip, name)?.get).toBe(descriptor.get);
      }
    }
  });
});

describe("pending-intents", () => {

  rt.linkNatives();

  test("activity-stack pending intents match on the final intent and retain the preceding stack", async () => {
    const root = new JIntent(); root.component = "RootActivity";
    const detail = new JIntent(); detail.component = "DetailActivity";
    const rootData = await encodeIntent(root), detailData = await encodeIntent(detail);
    const sent: string[][] = [];
    const store = new PendingIntents(async operation => {
      sent.push([...(operation.intents ?? []).slice(0, -1).map(intent => intent.component ?? ""), operation.intent.component ?? ""]);
    });
    const operation = { pkg: "example", process: "example", uid: 10000, kind: "activity" as const,
      code: 7, flags: 0, intent: detailData, intents: [rootData, detailData] };
    const first = store.create(operation);
    expect(first).not.toBeNull();
    expect(store.create({ ...operation, intents: [detailData] })).toBe(first);
    expect(await store.send(first ?? 0)).toBe(true);
    expect(sent).toEqual([["RootActivity", "DetailActivity"]]);
  });

  test("PendingIntent reports its stored operation type", async () => {
    const context = new JContext(), intent = new JIntent();
    const activity = await scall("android/app/PendingIntent", "getActivity", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, 1, intent, 0x4000000);
    const broadcast = await scall("android/app/PendingIntent", "getBroadcast", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, 1, intent, 0);
    const foreground = await scall("android/app/PendingIntent", "getForegroundService", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, 1, intent, 0);
    expect(await vcall(activity, "isActivity", "()Z")).toBe(1);
    expect(await vcall(activity, "isBroadcast", "()Z")).toBe(0);
    expect(await vcall(activity, "isImmutable", "()Z")).toBe(1);
    expect(await vcall(broadcast, "isActivity", "()Z")).toBe(0);
    expect(await vcall(broadcast, "isBroadcast", "()Z")).toBe(1);
    expect(await vcall(foreground, "isForegroundService", "()Z")).toBe(1);
    expect(await vcall(foreground, "isService", "()Z")).toBe(0);
  });
});

describe("platform-queries", () => {
  rt.linkNatives();
  test("NotificationChannelGroup persists empty descriptions and supports deletion", async () => {
    const manager = rt.make("android/app/NotificationManager");
    const group = await newObj("android/app/NotificationChannelGroup", "(Ljava/lang/String;Ljava/lang/CharSequence;)V", "query-test", "Test");
    await vcall(group, "setDescription", "(Ljava/lang/String;)V", "");
    await vcall(manager, "createNotificationChannelGroup", "(Landroid/app/NotificationChannelGroup;)V", group);
    try {
      const copy = await vcall(manager, "getNotificationChannelGroup", "(Ljava/lang/String;)Landroid/app/NotificationChannelGroup;", "query-test");
      expect(await vcall(copy, "getName", "()Ljava/lang/CharSequence;")).toBe("Test");
      expect(await vcall(copy, "getDescription", "()Ljava/lang/String;")).toBe("");
    } finally { await vcall(manager, "deleteNotificationChannelGroup", "(Ljava/lang/String;)V", "query-test"); }
    expect(await vcall(manager, "getNotificationChannelGroup", "(Ljava/lang/String;)Landroid/app/NotificationChannelGroup;", "query-test")).toBeNull();
  });
});

describe("provider-file-ipc", () => {
  rt.linkNatives();

  test("provider file descriptors cross IPC as readable bytes", async () => {
    const encoded = await encodeProviderValue(mkPfd(new Uint8Array([4, 5, 6]), null));
    const descriptor = await decodeProviderValue(encoded);
    const input = await newObj("android/os/ParcelFileDescriptor$AutoCloseInputStream", "(Landroid/os/ParcelFileDescriptor;)V", descriptor);
    const bytes = new Int8Array(3);
    expect(await vcall(input, "read", "([B)I", bytes)).toBe(3);
    expect([...bytes]).toEqual([4, 5, 6]);
    expect(providerOperations.openFile).toBe("(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;");
  });

  test("writable provider descriptors forward flushed bytes", async () => {
    let written = new Uint8Array(0);
    const encoded = await encodeProviderValue(mkPfd(new Uint8Array(0), () => {}));
    const descriptor = await decodeProviderValue(encoded, (bytes) => { written = bytes.slice(); });
    const output = await newObj("android/os/ParcelFileDescriptor$AutoCloseOutputStream", "(Landroid/os/ParcelFileDescriptor;)V", descriptor);
    await vcall(output, "write", "([B)V", new Int8Array([7, 8]));
    await vcall(output, "close", "()V");
    expect([...written]).toEqual([7, 8]);
  });
});

describe("resolver-file", () => {
  rt.linkNatives();
  test("resolver file opens decode paths and reject missing files without creating them", async () => {
    const resolver = rt.make("android/content/ContentResolver");
    const path = "/resolver file?x=1", uri = mkUri("file:///resolver%20file%3Fx%3D1?ignored=2#fragment");
    vfs.write(path, Uint8Array.of(7, 8));
    try {
      const stream = await vcall(resolver, "openInputStream", "(Landroid/net/Uri;)Ljava/io/InputStream;", uri);
      expect(await vcall(stream, "read", "()I")).toBe(7);
      await vcall(stream, "close", "()V");
      const pfd = await vcall(resolver, "openFileDescriptor", "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;", uri, "r");
      const fd = await vcall(pfd, "getFd", "()I"), data = new Uint8Array(2);
      expect(await javaReadFd(fd, data)).toBe(2);
      expect([...data]).toEqual([7, 8]);
      await vcall(pfd, "close", "()V");
      vfs.delete(path);
      for (const missing of [uri, mkUri("unsupported://file")]) {
        const error = await vcallAsync(resolver, "openFileDescriptor", "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;", missing, "r").catch(error => error);
        expect(rt.iof(error, "java/io/FileNotFoundException")).toBe(1);
      }
      expect(vfs.exists(path)).toBe(false);
    } finally { vfs.delete(path); }
  });

  test("parcel file modes distinguish read-write access, truncation and append", async () => {
    const cls = rt.link("android/os/ParcelFileDescriptor").ctor;
    for (const [mode, flags] of [["r", 0x10000000], ["w", 0x2c000000], ["wt", 0x2c000000], ["wa", 0x2a000000], ["rw", 0x38000000], ["rwt", 0x3c000000]] satisfies [string, number][]) {
      expect(await vcall(cls, "parseMode", "(Ljava/lang/String;)I", mode)).toBe(flags);
    }
    for (const mode of ["", "read", "rwa"]) {
      const error = await vcallAsync(cls, "parseMode", "(Ljava/lang/String;)I", mode).catch(error => error);
      expect(rt.iof(error, "java/lang/IllegalArgumentException")).toBe(1);
    }
  });
});

describe("resource-type-id-offset", () => {
  function stringPool(text = ""): Uint8Array {
    const count = text ? 1 : 0;
    const size = 28 + count * 4 + (text ? 4 + text.length * 2 : 0);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 1, true);
    view.setUint16(2, 28, true);
    view.setUint32(4, size, true);
    view.setUint32(8, count, true);
    view.setUint32(20, 28 + count * 4, true);
    if (text) {
      let pos = 32;
      view.setUint16(pos, text.length, true);
      pos += 2;
      for (const char of text) {
        view.setUint16(pos, char.charCodeAt(0), true);
        pos += 2;
      }
    }
    return bytes;
  }

  function packageChunk(typeName: string, key: string, entryIdx: number, typeId = 1, typeIdOffset = 0, pkgId = 0x7f): Uint8Array {
    const types = stringPool(typeName);
    const keys = stringPool(key);
    const entriesStart = 84 + (entryIdx + 1) * 4;
    const type = new Uint8Array(entriesStart + 16);
    const tv = new DataView(type.buffer);
    tv.setUint16(0, 0x0201, true);
    tv.setUint16(2, 84, true);
    tv.setUint32(4, type.length, true);
    tv.setUint8(8, typeId);
    tv.setUint32(12, entryIdx + 1, true);
    tv.setUint32(16, entriesStart, true);
    tv.setUint32(20, 64, true);
    for (let i = 0; i < entryIdx; i++) tv.setUint32(84 + i * 4, 0xffffffff, true);
    tv.setUint16(entriesStart, 8, true);
    tv.setUint16(entriesStart + 8, 8, true);

    const packageSize = 288 + types.length + keys.length + type.length;
    const bytes = new Uint8Array(packageSize);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0x0200, true);
    view.setUint16(2, 288, true);
    view.setUint32(4, packageSize, true);
    view.setUint32(8, pkgId, true);
    const name = `package${pkgId}`;
    for (let i = 0; i < name.length; i++) view.setUint16(12 + i * 2, name.charCodeAt(i), true);
    view.setUint32(268, 288, true);
    view.setUint32(276, 288 + types.length, true);
    view.setUint32(284, typeIdOffset, true);
    bytes.set(types, 288);
    bytes.set(keys, 288 + types.length);
    bytes.set(type, 288 + types.length + keys.length);
    return bytes;
  }

  function resourceTable(...packages: Uint8Array[]): Uint8Array {
    const values = stringPool();
    const bytes = new Uint8Array(12 + values.length + packages.reduce((size, pkg) => size + pkg.length, 0));
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0x0002, true);
    view.setUint16(2, 12, true);
    view.setUint32(4, bytes.length, true);
    view.setUint32(8, packages.length, true);
    bytes.set(values, 12);
    let pos = 12 + values.length;
    for (const pkg of packages) { bytes.set(pkg, pos); pos += pkg.length; }
    return bytes;
  }

  test("package type ID offsets apply to resource lookup", () => {
    const resources = new Arsc(resourceTable(packageChunk("id", "item", 0, 1, 9)));
    expect(resources.findId("id", "item")).toBe(0x7f0a0000);
    expect(resources.entry(0x7f0a0000)?.key).toBe("item");
  });

  test("resource names use the type pool of each package chunk", () => {
    const resources = new Arsc(resourceTable(
      packageChunk("string", "label", 0),
      packageChunk("id", "target", 1),
    ));
    expect(resources.findId("id", "target")).toBe(0x7f010001);
    expect(resources.typeName(1, 1)).toBe("id");
  });

  test("resource packages keep colliding type and entry IDs separate", () => {
    const resources = new Arsc(resourceTable(
      packageChunk("style", "library", 0, 1, 0, 0x4f),
      packageChunk("integer", "font", 0),
      packageChunk("drawable", "feature", 0, 1, 0, 0x53),
    ));
    expect(resources.pkgId).toBe(0x7f);
    expect(resources.entry(0x7f010000)?.key).toBe("font");
    expect(resources.entry(0x4f010000)?.key).toBe("library");
    expect(resources.typeName(1, 0)).toBe("integer");
    expect(resources.typeName(1, 0, 0x53)).toBe("drawable");
    expect(resources.findId("style", "library")).toBe(0);
    expect(resources.findId("style", "library", 0x4f)).toBe(0x4f010000);
    expect(resources.packageName(0x53)).toBe("package83");
    expect(resources.packageId("package79")).toBe(0x4f);
    resources.add(resourceTable(packageChunk("string", "extra", 1, 1, 0, 0x4f)));
    expect(resources.findId("string", "extra", 0x4f)).toBe(0x4f010001);
  });
});

describe("resource-value-density", () => {
  rt.linkNatives();
  test("resource values retain selected density and resolved reference identity", async () => {
    const table = new Arsc(Uint8Array.of(2, 0, 8, 0, 8, 0, 0, 0));
    const config = { density: 0, sdk: 0, orientation: 0, night: 0, lang: "", region: "", swdp: 0, wdp: 0, hdp: 0, size: 0, dir: 0, uiType: 0, score: 0 };
    table.device.density = 480;
    table.types.set(1, [
      { id: 1, name: "integer", config, entries: new Map([
        [0, { key: "density_value", value: { type: TV.INT_DEC, data: 1 } }],
        [1, { key: "alias", value: { type: TV.REFERENCE, data: 0x7f010000 } }],
        [2, { key: "plain", value: { type: TV.INT_DEC, data: 2 } }],
      ]) },
      { id: 1, name: "integer", config: { ...config, density: 480 }, entries: new Map([
        [0, { key: "density_value", value: { type: TV.INT_DEC, data: 3 } }],
      ]) },
    ]);
    const res = mkJResources(new Resources(table, {}), false), value = new JTypedValue();
    for (const [id, resolve, expected] of [
      [0x7f010000, 1, [TV.INT_DEC, 3, 480, 0x7f010000]],
      [0x7f010001, 1, [TV.INT_DEC, 3, 480, 0x7f010000]],
      [0x7f010001, 0, [TV.REFERENCE, 0x7f010000, 0, 0x7f010001]],
      [0x7f010002, 1, [TV.INT_DEC, 2, 0, 0x7f010002]],
    ] satisfies [number, number, number[]][]) {
      await vcall(res, "getValue", "(ILandroid/util/TypedValue;Z)V", id, value, resolve);
      expect([value.type, value.data, value.density, value.resourceId]).toEqual(expected);
    }
  });
});

describe("search-recent-suggestions", () => {
  rt.linkNatives();

  test("SearchRecentSuggestions inserts queries through ContentValues", async () => {
    let inserted: unknown = null;
    let uri = "";
    const resolver = {
      [mangleMethod("insert", "(Landroid/net/Uri;Landroid/content/ContentValues;)Landroid/net/Uri;")]:
        (target: { uri: string }, values: unknown) => { uri = target.uri; inserted = values; return null; },
    };
    const context = {
      [mangleMethod("getContentResolver", "()Landroid/content/ContentResolver;")]: () => resolver,
    };
    const recent = await newObj("android/provider/SearchRecentSuggestions", "(Landroid/content/Context;Ljava/lang/String;I)V", context, "history", 1);

    await vcall(recent, "saveRecentQuery", "(Ljava/lang/String;Ljava/lang/String;)V", "android", null);

    expect(uri).toBe("content://history/suggestions");
    expect(await vcall(inserted, "getAsString", "(Ljava/lang/String;)Ljava/lang/String;", "display1")).toBe("android");
    expect(await vcall(inserted, "getAsString", "(Ljava/lang/String;)Ljava/lang/String;", "query")).toBe("android");
    expect(await vcall(inserted, "getAsLong", "(Ljava/lang/String;)Ljava/lang/Long;", "date")).not.toBeNull();
  });
});

describe("service-bind", () => {
  rt.linkNatives();

  test("a failed service binding still requires one unbind", async () => {
    const context = rt.make("android/content/Context") as JContext;
    context.$host = { pkg: "service-bind-test" } as JContext["$host"];
    const intent = new JIntent();
    intent.componentPkg = "service-bind-test";
    intent.component = "service-bind-test.MissingService";
    const connection = new JObj();
    expect(await vcall(context, "bindService", "(Landroid/content/Intent;Landroid/content/ServiceConnection;I)Z", intent, connection, 0)).toBe(0);
    await vcall(context, "unbindService", "(Landroid/content/ServiceConnection;)V", connection);
    await expect(vcallAsync(context, "unbindService", "(Landroid/content/ServiceConnection;)V", connection)).rejects.toMatchObject({ msg: "Service not registered" });
  });
});

describe("settings-location", () => {
  rt.linkNatives();
  const CR = "Landroid/content/ContentResolver;";

  test("Settings.Secure reports the device's location switch", () => {
    const enabled = locationTransport.enabled;
    try {
      locationTransport.enabled = () => false;
      expect(scall("android/provider/Settings$Secure", "getInt", `(${CR}Ljava/lang/String;)I`, null, "location_mode")).toBe(0);
      expect(scall("android/provider/Settings$Secure", "getString", `(${CR}Ljava/lang/String;)Ljava/lang/String;`, null, "location_providers_allowed")).toBe("");
      locationTransport.enabled = () => true;
      expect(scall("android/provider/Settings$Secure", "getInt", `(${CR}Ljava/lang/String;)I`, null, "location_mode")).toBe(3);
      expect(scall("android/provider/Settings$Secure", "getInt", `(${CR}Ljava/lang/String;I)I`, null, "location_mode", 7)).toBe(3);
      expect(scall("android/provider/Settings$Secure", "getString", `(${CR}Ljava/lang/String;)Ljava/lang/String;`, null, "location_providers_allowed")).toBe("gps,network");
      expect(() => scall("android/provider/Settings$Secure", "getInt", `(${CR}Ljava/lang/String;)I`, null, "no_such_setting")).toThrow();
      expect(scall("android/provider/Settings$Global", "getInt", `(${CR}Ljava/lang/String;I)I`, null, "location_mode", 7)).toBe(7);
    } finally { locationTransport.enabled = enabled; }
  });
});

describe("window-context", () => {
  rt.linkNatives();

  test("finding an activity content view installs its decor before setContentView", async () => {
    const activity = new JActivity(), res = new Resources(null, {}), theme = new JTheme();
    theme.res = res;
    Reflect.set(activity, "$host", { res, theme, pkg: "test" });
    activity.window.activity = activity;
    expect(activity.window.decor).toBeNull();
    const content = await vcall(activity, "findViewById", "(I)Landroid/view/View;", 0x01020002);
    expect(content).not.toBeNull();
    expect(content).toBe(activity.window.contentParent);
    expect(await vcall(activity.window, "findViewById", "(I)Landroid/view/View;", 0x01020002)).toBe(content);
  });

  test("display and window contexts retain display identity and own their window service", async () => {
    const source = new JContext(), screen = await display();
    Reflect.set(source, "$host", { pkg: "test" });
    const displayContext = await vcall(source, "createDisplayContext", "(Landroid/view/Display;)Landroid/content/Context;", screen);
    expect(await vcall(displayContext, "getDisplay", "()Landroid/view/Display;")).toBe(screen);
    expect(await vcall(displayContext, "isUiContext", "()Z")).toBe(0);
    const window = await vcall(displayContext, "createWindowContext", "(ILandroid/os/Bundle;)Landroid/content/Context;", 2038, null);
    expect(rt.iof(window, "android/content/ContextWrapper")).toBeTruthy();
    expect(await vcall(window, "getDisplay", "()Landroid/view/Display;")).toBe(screen);
    expect(await vcall(window, "isUiContext", "()Z")).toBe(1);
    const manager = await vcall(window, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "window");
    expect(await vcall(window, "getSystemService", "(Ljava/lang/Class;)Ljava/lang/Object;", rt.classFor("android/view/WindowManager"))).toBe(manager);
    const second = await vcall(source, "createWindowContext", "(Landroid/view/Display;ILandroid/os/Bundle;)Landroid/content/Context;", screen, 2038, null);
    expect(await vcall(second, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "window")).not.toBe(manager);
    const error = await vcallAsync(source, "createDisplayContext", "(Landroid/view/Display;)Landroid/content/Context;", null).then(() => null, e => e);
    expect(rt.iof(error, "java/lang/IllegalArgumentException")).toBeTruthy();
  });

  test("attribution contexts retain their base and expose their tag", async () => {
    const source = new JContext();
    Reflect.set(source, "$host", { application: source, pkg: "test" });
    const tagged = await vcall(source, "createAttributionContext", "(Ljava/lang/String;)Landroid/content/Context;", "navigation");
    expect(tagged).not.toBe(source);
    expect(await vcall(tagged, "getApplicationContext", "()Landroid/content/Context;")).toBe(source);
    expect(await vcall(tagged, "isUiContext", "()Z")).toBe(0);
    expect(await vcall(tagged, "getAttributionTag", "()Ljava/lang/String;")).toBe("navigation");
    const attribution = await vcall(tagged, "getAttributionSource", "()Landroid/content/AttributionSource;");
    expect(await vcall(attribution, "getAttributionTag", "()Ljava/lang/String;")).toBe("navigation");
    const reset = await vcall(tagged, "createAttributionContext", "(Ljava/lang/String;)Landroid/content/Context;", null);
    expect(await vcall(reset, "getAttributionTag", "()Ljava/lang/String;")).toBeNull();
  });

  test("unchanged window attributes do not restart inset dispatch", async () => {
    const window = rt.make("android/view/Window");
    const attrs = await vcall(window, "getAttributes", "()Landroid/view/WindowManager$LayoutParams;");
    const pending = uiState.needsInsets;
    try {
      uiState.needsInsets = false;
      await vcall(attrs, "setFitInsetsTypes", "(I)V", 0);
      await vcall(window, "setAttributes", "(Landroid/view/WindowManager$LayoutParams;)V", attrs);
      expect(uiState.needsInsets).toBe(true);
      uiState.needsInsets = false;
      await vcall(window, "setAttributes", "(Landroid/view/WindowManager$LayoutParams;)V", attrs);
      expect(uiState.needsInsets).toBe(false);
    } finally { uiState.needsInsets = pending; }
  });

  test("destroyed context windows detach without dismissing dialogs or other activities", async () => {
    const owner = new JContext(), other = new JContext();
    const themed = new JContextWrapper();
    themed.base = owner;
    const ownedView = new JView(), otherView = new JView();
    ownedView.ctx = themed; otherView.ctx = other;
    addOverlay(ownedView, 0, 0, 0);
    addOverlay(otherView, 0, 0, 0);
    await dispatchAttached(ownedView);
    await dispatchAttached(otherView);
    try {
      await detachContextOverlays(owner);
      expect(ownedView.attached).toBe(false);
      expect(overlays.some(o => o.view === ownedView)).toBe(false);
      expect(otherView.attached).toBe(true);
      expect(overlays.some(o => o.view === otherView)).toBe(true);
    } finally {
      await detachContextOverlays(other);
      removeOverlay(ownedView);
    }
  });

  test("Dialog exposes its overlay theme through its context and inflater without changing its owner", async () => {
    const res = new Resources(null, {}), theme = new JTheme();
    theme.res = res; theme.styles = [100];
    res.bagCache.set(100, { parent: 0, map: new Map([[1, { t: T_STR, d: 0, s: "base" }]]) });
    res.bagCache.set(101, { parent: 0, map: new Map([[1, { t: T_STR, d: 0, s: "dialog" }]]) });
    const context = Object.assign(rt.make("android/content/Context"), { $host: { res, theme } });
    const dialog = await newObj("android/app/Dialog", "(Landroid/content/Context;I)V", context, 101);
    const themed = await vcall(dialog, "getContext", "()Landroid/content/Context;");
    expect(themed).not.toBe(context);
    expect(themeOf(themed)?.lookup(1)?.s).toBe("dialog");
    expect(themeOf(getInflater(themed).jctx)?.lookup(1)?.s).toBe("dialog");
    expect(theme.lookup(1)?.s).toBe("base");
    expect(await vcall(dialog, "getOwnerActivity", "()Landroid/app/Activity;")).toBeNull();
    const owner = rt.make("android/app/Activity");
    await vcall(dialog, "setOwnerActivity", "(Landroid/app/Activity;)V", owner);
    expect(await vcall(dialog, "getOwnerActivity", "()Landroid/app/Activity;")).toBe(owner);
  });


  test("full-screen windows own their system bars and hiding restores the underlying window", async () => {
    const activity = new JFrameLayout(), dialog = new JFrameLayout();
    const underneath = activity.windowOwner = new JWindow(), above = dialog.windowOwner = new JWindow();
    underneath.decor = activity; above.decor = dialog;
    above.layoutW = above.layoutH = -1;
    dialog.right = device.width; dialog.bottom = device.height;
    const overlays = [{ view: dialog, x: 0, y: 0, flags: 0 }];
    await vcall(underneath, "setStatusBarColor", "(I)V", 0xff112233);
    await vcall(underneath, "setNavigationBarColor", "(I)V", 0xff223344);
    await vcall(above, "setStatusBarColor", "(I)V", 0xffeeeeee);
    await vcall(above, "setNavigationBarColor", "(I)V", 0xffdddddd);
    const controller = await vcall(above, "getInsetsController", "()Landroid/view/WindowInsetsController;");
    await vcall(controller, "setSystemBarsAppearance", "(II)V", 24, 24);
    expect(await vcall(controller, "getSystemBarsAppearance", "()I")).toBe(24);
    await vcall(controller, "hide", "(I)V", 1);
    const bars = resolveSystemBars(activity, overlays);
    expect(bars.root).toBe(dialog);
    expect([bars.status, bars.navigation, bars.visible & 3]).toEqual([0xffeeeeee, 0xffdddddd, 2]);
    above.layoutW = device.width; above.layoutH = device.height;
    expect(resolveSystemBars(activity, overlays)).toEqual(bars);
    above.flags |= 8;
    expect(resolveSystemBars(activity, overlays).root).toBe(activity);
    above.flags &= ~8;
    dialog.right--;
    expect(resolveSystemBars(activity, overlays).root).toBe(activity);
    dialog.right++;
    dialog.visibility = 4;
    const restored = resolveSystemBars(activity, overlays);
    expect(restored.root).toBe(activity);
    expect([restored.status, restored.navigation, restored.visible & 3]).toEqual([0xff112233, 0xff223344, 2]);
    expect(await vcall(underneath, "getNavigationBarColor", "()I")).toBe(0xff223344);
  });
});
