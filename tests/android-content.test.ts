import { expect, test, describe, beforeAll } from "bun:test";
import { zipSync } from "fflate";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { unbox } from "../src/jvm/natives/jbox";
import { checkUriPermission, grantUriPermission, revokeUriPermission, providerOperations } from "../src/android/contentresolver";
import { mkUri } from "../src/android/net";
import { packages, PackageRecord, signaturePermissions } from "../src/android/packages";
import { mangleMethod } from "../src/jvm/abi";
import { JContext, JContextWrapper } from "../src/android/context";
import { defaultDisplay } from "../src/android/display";
import { vfs } from "../src/shell/vfs";
import { pickFiles } from "../src/shell/hostfs";
import { centralDir, zipTree } from "../src/jvm/natives/jzip";
import { mergeInstall } from "../src/shell/install";
import { BytesFile, readFully } from "../src/shell/lazyfile";
import { parsePackageArchive, apkCertificates } from "../src/android/packagearchive";
import { registerPackage, FLAG_IS_GAME, field } from "../src/android/pm";
import { hostedService } from "../src/android/binder";
import { newArrayList, toJsArray } from "../src/jvm/natives/jcoll";
import { Resources, JTheme, themeOf, rvString, newSV, nativeRes, AID } from "../src/android/res";
import { newTheme } from "../src/android/resources";
import { TV, type XmlNode, type XmlAttr } from "../src/android/axml";
import { mkComponentName, newIntent } from "../src/android/intent";
import { decodeIntent, encodeIntent, intentCodec } from "../src/android/intentipc";
import { PendingIntents } from "../src/shell/pendingintents";
import { mkPfd } from "../src/android/os";
import { decodeProviderValue, encodeProviderValue } from "../src/android/provideripc";
import { javaReadFd } from "../src/native/stdio";
import { Arsc } from "../src/android/arsc";
import { getInflater } from "../src/android/inflate";
import { JFrameLayout } from "../src/android/layouts";
import { JWindow } from "../src/android/window";
import { resolveSystemBars } from "../src/shell/systembars";
import { device } from "../src/shell/config";
import { JView, dispatchAttached, uiState } from "../src/android/view";
import { addOverlay, overlays, detachContextOverlays, removeOverlay } from "../src/android/popup";
import { JActivity } from "../src/android/app";
import { scall, loadLibcore, appResources, preloadTextPaint } from "./java";

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

describe("clip-data", () => {
  rt.linkNatives();

  test("ClipData carries nested intents across a Parcel boundary", async () => {
    const inner = await newObj("android/content/Intent", "(Ljava/lang/String;)V", "test.action");
    const clip = await scall("android/content/ClipData", "newIntent", "(Ljava/lang/CharSequence;Landroid/content/Intent;)Landroid/content/ClipData;", "label", inner);
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
    await loadLibcore();
    const file = await newObj("java/io/File", "(Ljava/lang/String;)V", "/data/provider-test.txt");
    const path = await vcall(file, "toPath", "()Ljava/nio/file/Path;");
    const provider = await vcall(await vcall(path, "getFileSystem", "()Ljava/nio/file/FileSystem;"), "provider", "()Ljava/nio/file/spi/FileSystemProvider;");
    const output = await vcall(provider, "newOutputStream", "(Ljava/nio/file/Path;[Ljava/nio/file/OpenOption;)Ljava/io/OutputStream;", path, []);
    await vcall(output, "write", "([B)V", new Int8Array([10, 20, 30]));
    await vcall(output, "close", "()V");
    await vcall(provider, "checkAccess", "(Ljava/nio/file/Path;[Ljava/nio/file/AccessMode;)V", path, []);
    const attrs = await vcall(provider, "readAttributes", "(Ljava/nio/file/Path;Ljava/lang/Class;[Ljava/nio/file/LinkOption;)Ljava/nio/file/attribute/BasicFileAttributes;", path, rt.classFor("java/nio/file/attribute/BasicFileAttributes"), []);
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
    expect(unbox(await vcall(bundle, "getByte", "(Ljava/lang/String;B)Ljava/lang/Byte;", "b", 0))).toBe(-7);
    expect([...await vcall(bundle, "getDoubleArray", "(Ljava/lang/String;)[D", "D")]).toEqual([0.25]);
    expect(await vcall(bundle, "getParcelable", "(Ljava/lang/String;Ljava/lang/Class;)Ljava/lang/Object;", "r", rt.classFor("android/content/ComponentName"))).toBeNull();
    await vcall(bundle, "putParcelable", "(Ljava/lang/String;Landroid/os/Parcelable;)V", "p", component);
    expect(await vcall(bundle, "getParcelable", "(Ljava/lang/String;Ljava/lang/Class;)Ljava/lang/Object;", "p", rt.classFor("android/content/ComponentName"))).toBe(component);
    expect(await vcall(bundle, "getSerializable", "(Ljava/lang/String;Ljava/lang/Class;)Ljava/io/Serializable;", "p", rt.classFor("java/lang/String"))).toBeNull();
  });
});

describe("package-checksums", () => {
  class ChecksumListener extends JObj { checksums: unknown = null; }
  rt.register({
    name: "test/ChecksumListener", ctor: ChecksumListener, ifaces: ["android/content/pm/IOnChecksumsReadyListener"],
    methods: { "onChecksumsReady(Ljava/util/List;)V": function (this: ChecksumListener, checksums: unknown) { this.checksums = checksums; } },
  });
  rt.linkNatives();

  test("the package service reports installed APK checksums and signing certificates", async () => {
    const bytes = new Uint8Array(await Bun.file("apks/FitNotes.apk").arrayBuffer());
    const archive = await parsePackageArchive(bytes);
    const path = "/data/app/checksum-test/base.apk";
    vfs.write(path, bytes);
    registerPackage(archive, path);
    const listener = new ChecksumListener();
    const pms = await hostedService("package");
    await vcall(pms, "requestPackageChecksums", "(Ljava/lang/String;ZIILjava/util/List;Landroid/content/pm/IOnChecksumsReadyListener;I)V", archive.pkg, 0, 0, 8, newArrayList(), listener, 0);
    const checksums = await toJsArray(listener.checksums);
    expect(checksums).toHaveLength(1);
    expect(await vcall(checksums[0], "getSplitName", "()Ljava/lang/String;")).toBeNull();
    expect(await vcall(checksums[0], "getType", "()I")).toBe(8);
    expect(await vcall(checksums[0], "getValue", "()[B")).toHaveLength(32);
    const cert = archive.certificates[0];
    const hash = new Int8Array(await crypto.subtle.digest("SHA-256", cert.slice()));
    const hasCertificate = (bytes: Int8Array, type: number) =>
      vcall(pms, "hasSigningCertificate", "(Ljava/lang/String;[BI)Z", archive.pkg, bytes, type);
    expect(await hasCertificate(new Int8Array(cert), 0)).toBe(1);
    expect(await hasCertificate(hash, 1)).toBe(1);
    hash[0] ^= 1;
    expect(await hasCertificate(hash, 1)).toBe(0);
    expect(await hasCertificate(new Int8Array(cert), 2)).toBe(0);
  });
});

describe("package-installer", () => {
  rt.linkNatives();

  test("a session stages what AOSP's Session writes, and abandoning it drops the file", async () => {
    const installer = await vcall(await hostedService("package"), "getPackageInstaller", "()Landroid/content/pm/IPackageInstaller;");
    const params = await newObj("android/content/pm/PackageInstaller$SessionParams", "(I)V", 1);
    const id = await vcall(installer, "createSession", "(Landroid/content/pm/PackageInstaller$SessionParams;Ljava/lang/String;Ljava/lang/String;I)I", params, "test.installer", null, 0);
    const session = await newObj("android/content/pm/PackageInstaller$Session", "(Landroid/content/pm/IPackageInstallerSession;)V",
      await vcall(installer, "openSession", "(I)Landroid/content/pm/IPackageInstallerSession;", id));
    const out = await vcall(session, "openWrite", "(Ljava/lang/String;JJ)Ljava/io/OutputStream;", "base.apk", 0n, -1n);
    await vcall(out, "write", "([B)V", Int8Array.of(1, 2, 3));
    await vcall(session, "fsync", "(Ljava/io/OutputStream;)V", out);
    await vcall(out, "close", "()V");
    expect(await vcall(session, "getNames", "()[Ljava/lang/String;")).toEqual(["base.apk"]);
    expect(vfs.read(`/data/app/vmdl${id}.tmp/base.apk`)).toEqual(Uint8Array.of(1, 2, 3));
    const info = await vcall(installer, "getSessionInfo", "(I)Landroid/content/pm/PackageInstaller$SessionInfo;", id);
    expect(await vcall(info, "getInstallerPackageName", "()Ljava/lang/String;")).toBe("test.installer");
    await vcall(session, "abandon", "()V");
    expect(vfs.read(`/data/app/vmdl${id}.tmp/base.apk`)).toBeNull();
    expect(await vcall(installer, "getSessionInfo", "(I)Landroid/content/pm/PackageInstaller$SessionInfo;", id)).toBeNull();
  });
});

describe("package-game-info", () => {
  rt.linkNatives();

  test("installed game metadata survives the package service's ApplicationInfo", async () => {
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
      const info = await vcall(await hostedService("package"), "getApplicationInfo", "(Ljava/lang/String;JI)Landroid/content/pm/ApplicationInfo;", pkg, 0n, 0);
      const APP = "android/content/pm/ApplicationInfo";
      expect([field(info, APP, "category"), field<number>(info, APP, "flags") & (FLAG_IS_GAME | 1)]).toEqual([0, FLAG_IS_GAME | 1]);
    } finally { packages.delete(pkg); }
  });
});

describe("package-intent-filters", () => {
  rt.linkNatives();

  test("manifest filters resolve through AOSP's IntentFilter, uri-relative groups included", async () => {
    const pkg = "test.filters", a = (name: string, str: string): XmlAttr => ({ name, str, ns: "", resId: 0, type: TV.STRING, data: 0 });
    const filter = (children: XmlNode[]): XmlNode => ({ name: "intent-filter", attrs: [], children: [
      { name: "action", attrs: [a("name", "android.intent.action.VIEW")], children: [] },
      { name: "category", attrs: [a("name", "android.intent.category.DEFAULT")], children: [] },
      { name: "data", attrs: [a("scheme", "https"), a("host", "*.example.com")], children: [] }, ...children] });
    const activity = (name: string, children: XmlNode[]): XmlNode => ({ name: "activity", attrs: [a("name", name)], children: [filter(children)] });
    const root: XmlNode = { name: "manifest", attrs: [a("package", pkg)], children: [{ name: "application", attrs: [], children: [
      activity(".Glob", [{ name: "data", attrs: [a("pathPattern", "/item/.*")], children: [] }]),
      activity(".Group", [{ name: "uri-relative-filter-group", attrs: [{ name: "allow", str: null, ns: "", resId: 0, type: TV.BOOLEAN, data: 0 }],
        children: [{ name: "data", attrs: [a("path", "/blocked"), a("query", "x=1")], children: [] }] },
      // the first group whose filters all match decides; none matching is no match
      { name: "uri-relative-filter-group", attrs: [], children: [{ name: "data", attrs: [a("pathPrefix", "/")], children: [] }] }]),
    ] }] };
    packages.set(pkg, new PackageRecord(root, new Resources(null, {}), "/test-filters.apk", 12346, async () => []));
    try {
      const { resolveActivity } = await import("../src/android/pm");
      const resolve = async (url: string) => {
        const intent = await newObj("android/content/Intent", "(Ljava/lang/String;Landroid/net/Uri;)V", "android.intent.action.VIEW", mkUri(url));
        await vcall(intent, "setPackage", "(Ljava/lang/String;)Landroid/content/Intent;", pkg);
        const match = await resolveActivity(intent);
        return match && match !== "system" ? match.name : null;
      };
      expect(await resolve("https://www.example.com/item/7")).toBe(pkg + ".Glob");
      expect(await resolve("https://www.example.com/blocked?x=1")).toBeNull();
      expect(await resolve("https://www.example.com/blocked?x=2")).toBe(pkg + ".Group");
      expect(await resolve("https://elsewhere.test/item/7")).toBeNull();
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
      const pms = await hostedService("package"), PI = "android/content/pm/PackageInfo";
      const packageInfo = (flags: bigint) => vcall(pms, "getPackageInfo", "(Ljava/lang/String;JI)Landroid/content/pm/PackageInfo;", pkg, flags, 0);
      const info = await packageInfo(0x1000n);
      expect([...field<string[]>(info, PI, "requestedPermissions")]).toEqual(["android.permission.INTERNET", denied]);
      expect([...field<Int32Array>(info, PI, "requestedPermissionsFlags")]).toEqual([3, 1]);
      record.grants.add(denied);
      expect([...field<Int32Array>(await packageInfo(0x1000n), PI, "requestedPermissionsFlags")]).toEqual([3, 3]);
      const omitted = await packageInfo(0n);
      expect(field(omitted, PI, "requestedPermissions")).toBeNull();
      expect(field(omitted, PI, "requestedPermissionsFlags")).toBeNull();
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
    const explicit = async (cls: string, extra: string) => {
      const intent = await newIntent();
      await vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", await mkComponentName("example", cls));
      await vcall(intent, "putExtra", "(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;", "extra", extra);
      return encodeIntent(intent);
    };
    const rootData = await explicit("RootActivity", "root"), detailData = await explicit("DetailActivity", "first");
    const sent: string[][] = [];
    const describe = async (data: typeof rootData) => {
      const intent = await decodeIntent(data);
      const component = await vcall(await vcall(intent, "getComponent", "()Landroid/content/ComponentName;"), "getClassName", "()Ljava/lang/String;");
      return component + ":" + await vcall(intent, "getStringExtra", "(Ljava/lang/String;)Ljava/lang/String;", "extra");
    };
    const store = new PendingIntents(intentCodec, async operation => {
      sent.push([...await Promise.all((operation.intents ?? []).slice(0, -1).map(describe)), await describe(operation.intent)]);
    });
    const operation = { pkg: "example", process: "example", uid: 10000, kind: "activity" as const,
      code: 7, flags: 0, intent: detailData, intents: [rootData, detailData] };
    const first = await store.create(operation);
    expect(first).not.toBeNull();
    // equal under filterEquals despite the extras; FLAG_UPDATE_CURRENT replaces them
    const updated = await explicit("DetailActivity", "second");
    expect(await store.create({ ...operation, flags: 0x8000000, intent: updated, intents: [rootData, updated] })).toBe(first);
    expect(await store.create({ ...operation, intent: rootData, intents: [rootData] })).not.toBe(first);
    expect(await store.send(first ?? 0)).toBe(true);
    expect(sent).toEqual([["RootActivity:root", "DetailActivity:second"]]);
  });

  test("PendingIntent reports its stored operation type", async () => {
    const context = new JContext(), intent = await newIntent();
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
    await loadLibcore();
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

  test("a file resource resolves to a reference to itself, once", async () => {
    const zip = zipTree(new Uint8Array(await Bun.file("apks/FitNotes.apk").arrayBuffer()));
    const table = new Arsc(zip["resources.arsc"], (path) => zip[path] ?? null), res = new Resources(table, zip, undefined, true);
    const id = table.findId("layout", "activity_main"), ref = res.ref(id);
    expect(ref).toMatchObject({ t: TV.REFERENCE, d: id });
    expect(res.resolveRefs(ref)).toBe(ref);
    expect(rvString(res, { t: TV.REFERENCE, d: id })).toBe(res.fileOf(id)!.path);
  });

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
    const res = new Resources(table, {});
    for (const [id, resolve, expected] of [
      [0x7f010000, 1, [TV.INT_DEC, 3, 480, 0x7f010000]],
      [0x7f010001, 1, [TV.INT_DEC, 3, 480, 0x7f010000]],
      [0x7f010001, 0, [TV.REFERENCE, 0x7f010000, 0, 0x7f010001]],
      [0x7f010002, 1, [TV.INT_DEC, 2, 0, 0x7f010002]],
    ] satisfies [number, number, number[]][]) {
      const value = newSV();
      expect(res.getResource(id, false, value)).toBe(true);
      if (resolve) res.resolveReference(value);
      expect([value.t, value.d, value.density, value.resid]).toEqual(expected);
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
      [mangleMethod("delete", "(Landroid/net/Uri;Ljava/lang/String;[Ljava/lang/String;)I")]: () => 0,
    };
    const context = {
      [mangleMethod("getContentResolver", "()Landroid/content/ContentResolver;")]: () => resolver,
    };
    const recent = await newObj("android/provider/SearchRecentSuggestions", "(Landroid/content/Context;Ljava/lang/String;I)V", context, "history", 1);

    await vcall(recent, "saveRecentQuery", "(Ljava/lang/String;Ljava/lang/String;)V", "android", null);
    await vcall(recent, "waitForSave", "()V");

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
    const intent = await newIntent();
    await vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", await mkComponentName("service-bind-test", "service-bind-test.MissingService"));
    const connection = new JObj();
    expect(await vcall(context, "bindService", "(Landroid/content/Intent;Landroid/content/ServiceConnection;I)Z", intent, connection, 0)).toBe(0);
    await vcall(context, "unbindService", "(Landroid/content/ServiceConnection;)V", connection);
    await expect(vcallAsync(context, "unbindService", "(Landroid/content/ServiceConnection;)V", connection)).rejects.toMatchObject({ msg: "Service not registered" });
  });
});

describe("window-context", () => {
  beforeAll(preloadTextPaint);
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
    const source = new JContext(), screen = await defaultDisplay();
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
    const jresources = await appResources(new Resources(null, {}), "dialog"), res = nativeRes(jresources);
    const style = (name: string) => res.idFor("style", name, "android"), floating = (t: JTheme | null | undefined) => t?.lookup(AID("windowIsFloating"))?.d;
    const theme = await newTheme(jresources, null, style("Theme.Material.Light"));
    const context = Object.assign(rt.make("android/content/Context"), { $host: { res, jresources, theme } });
    const dialog = await newObj("android/app/Dialog", "(Landroid/content/Context;I)V", context, style("Theme.Material.Light.Dialog"));
    const themed = await vcall(dialog, "getContext", "()Landroid/content/Context;");
    expect(themed).not.toBe(context);
    expect(floating(themeOf(themed))).toBe(-1);
    expect(floating(themeOf(getInflater(themed).jctx))).toBe(-1);
    expect(floating(theme)).toBe(0);
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
