import { expect, test, describe } from "vite-plus/test";
import { zipSync } from "fflate";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import "../src/natives.ts";
import { rt, JObj, getDeclared } from "../src/jvm/runtime.ts";
import { jarray } from "../src/jvm/abi.ts";
import { newObj, vcall, vcallAsync, iof } from "../src/jvm/natives/jentry.ts";
import { checkUriPermission, grantUriPermission, revokeUriPermission } from "../src/android/urigrants.ts";
import { mkUri } from "../src/android/net.ts";
import { packages, PackageRecord, registerPackage } from "../src/android/packages.ts";
import { vfs } from "../src/shell/vfs.ts";
import { pickFiles } from "../src/shell/hostfs.ts";
import { centralDir, zipTree } from "../src/zip.ts";
import { mergeInstall } from "../src/shell/install.ts";
import { BytesFile, readFully } from "../src/shell/lazyfile.ts";
import { parsePackageArchive, packageArchiveSource, apkCertificates } from "../src/android/packagearchive.ts";
import { FLAG_IS_GAME } from "../src/android/pm.ts";
import { hostedService } from "../src/android/binder.ts";
import { notConnected, unconnected } from "../src/jvm/natives/jthrowable.ts";
import { newArrayList, toJsArray } from "../src/jvm/natives/jcoll.ts";
import { Resources, NativeTheme, rvString, newSV } from "../src/android/res.ts";
import { TV, type XmlNode, type XmlAttr } from "../src/android/axml.ts";
import { mkComponentName, newIntent } from "../src/android/intent.ts";
import { decodeIntent, encodeIntent, intentCodec } from "../src/android/intentipc.ts";
import { uptimeMillis } from "../src/guest-clock.ts";
import { createProcessEndpoint } from "../src/shell/process-endpoint.ts";
import { ProcessBroker } from "../src/shell/processes.ts";
import { brokerMethods, type BrokerCalls } from "../src/shell/broker-contract.ts";
import { NOT_CRASHED } from "../src/android/server/appexitinfo.ts";
import { PendingIntents } from "../src/shell/pendingintents.ts";
import { pendingTransport, sendIntent, type PendingAccess } from "../src/android/pendingintent.ts";
import { removeAlarm, setOperationAlarm, useAlarmIntents } from "../src/android/alarm.ts";
import { callProxy } from "../src/shell/process-port.ts";
import { javaReadFd } from "../src/native/fd.ts";
import { Arsc } from "../src/android/arsc.ts";
import { scall, bootApp, packageRecord, loadPlatform } from "./java.ts";

describe("android-uri-permission", () => {
  test("tree URI grants cover descendants with the granted access mode", () => {
    const pkg = "org.webdroid.test.uri";
    const uid = 77123;
    const tree = "content://com.android.externalstorage.documents/tree/test%3A";
    packages.set(pkg, { uid } as PackageRecord);
    try {
      grantUriPermission(pkg, tree, 1 | 0x80);
      const child = tree + "/document/test%3Afile.txt";
      const sibling = "content://com.android.externalstorage.documents/tree/test%3Aother/document/test%3Aother";
      expect(checkUriPermission(child, uid, 1)).toBe(0);
      expect(checkUriPermission(child, uid, 2)).toBe(-1);
      expect(checkUriPermission(sibling, uid, 1)).toBe(-1);
      revokeUriPermission(tree, 1);
      expect(checkUriPermission(child, uid, 1)).toBe(-1);
    } finally {
      packages.delete(pkg);
      revokeUriPermission(tree, 3);
    }
  });
});

// one app process for the file
const PKG = "org.webdroid.test.content";
const app = async () => bootApp(await packageRecord(PKG));
rt.register({ name: "test/Connection", ctor: class extends JObj {}, ifaces: ["android/content/ServiceConnection"], methods: {} });

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

describe("package-checksums", () => {
  class ChecksumListener extends JObj { checksums: unknown = null; }
  rt.register({
    name: "test/ChecksumListener", ctor: ChecksumListener, ifaces: ["android/content/pm/IOnChecksumsReadyListener"],
    methods: { "onChecksumsReady(Ljava/util/List;)V": function (this: ChecksumListener, checksums: unknown) { this.checksums = checksums; } },
  });

  test("the package service reports installed APK checksums and signing certificates", async () => {
    const bytes = new Uint8Array(readFileSync("apks/FitNotes.apk"));
    const archive = await parsePackageArchive(bytes);
    const path = "/data/app/checksum-test/base.apk";
    vfs.write(path, bytes);
    registerPackage(archive, { path });
    const listener = new ChecksumListener();
    const pms = await hostedService("package");
    await vcall(pms, "requestPackageChecksums", "(Ljava/lang/String;ZIILjava/util/List;Landroid/content/pm/IOnChecksumsReadyListener;I)V", archive.pkg, 0, 0, 8, await newArrayList(), listener, 0);
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
    expect([...await vcall(session, "getNames", "()[Ljava/lang/String;")]).toEqual(["base.apk"]);
    expect(vfs.read(`/data/app/vmdl${id}.tmp/base.apk`)).toEqual(Uint8Array.of(1, 2, 3));
    const info = await vcall(installer, "getSessionInfo", "(I)Landroid/content/pm/PackageInstaller$SessionInfo;", id);
    expect(await vcall(info, "getInstallerPackageName", "()Ljava/lang/String;")).toBe("test.installer");
    await vcall(session, "abandon", "()V");
    expect(vfs.read(`/data/app/vmdl${id}.tmp/base.apk`)).toBeNull();
    expect(await vcall(installer, "getSessionInfo", "(I)Landroid/content/pm/PackageInstaller$SessionInfo;", id)).toBeNull();
  });
});

describe("package-game-info", () => {

  test("installed game metadata survives the package service's ApplicationInfo", async () => {
    const pkg = "test.game.info";
    const root: XmlNode = { name: "manifest", attrs: [{ name: "package", str: pkg, ns: "", resId: 0, type: TV.STRING, data: 0 }], children: [
      { name: "application", attrs: [
        { name: "appCategory", str: null, ns: "", resId: 0, type: TV.INT_DEC, data: 0 },
        { name: "isGame", str: null, ns: "", resId: 0, type: TV.BOOLEAN, data: 1 },
      ], children: [] },
    ] };
    packages.set(pkg, new PackageRecord(root, new Resources(null, {}), "/test-game.apk", 12345, async () => [], { system: true }));
    try {
      const info = await vcall(await hostedService("package"), "getApplicationInfo", "(Ljava/lang/String;JI)Landroid/content/pm/ApplicationInfo;", pkg, 0n, 0);
      const APP = "android/content/pm/ApplicationInfo";
      expect([getDeclared(info, APP, "category"), getDeclared<number>(info, APP, "flags") & (FLAG_IS_GAME | 1)]).toEqual([0, FLAG_IS_GAME | 1]);
    } finally { packages.delete(pkg); }
  });
});

describe("package-intent-filters", () => {

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
      const pms = await hostedService("package");
      const resolve = async (url: string) => {
        const intent = await newObj("android/content/Intent", "(Ljava/lang/String;Landroid/net/Uri;)V", "android.intent.action.VIEW", await mkUri(url));
        await vcall(intent, "setPackage", "(Ljava/lang/String;)Landroid/content/Intent;", pkg);
        const info: JObj | null = await vcall(pms, "resolveIntent", "(Landroid/content/Intent;Ljava/lang/String;JI)Landroid/content/pm/ResolveInfo;", intent, null, 0x10000n, 0);
        return info && getDeclared<string>(getDeclared<JObj>(info, "android/content/pm/ResolveInfo", "activityInfo"), "android/content/pm/ActivityInfo", "name");
      };
      expect(await resolve("https://www.example.com/item/7")).toBe(pkg + ".Glob");
      expect(await resolve("https://www.example.com/blocked?x=1")).toBeNull();
      expect(await resolve("https://www.example.com/blocked?x=2")).toBe(pkg + ".Group");
      expect(await resolve("https://elsewhere.test/item/7")).toBeNull();
    } finally { packages.delete(pkg); }
  });
});

describe("package-permissions", () => {
  const attr = (name: string, str: string): XmlAttr => ({ name, str, ns: "", resId: 0, type: TV.STRING, data: 0 });

  test("PackageInfo aligns requested permission flags with actual package grants", async () => {
    // framework-res declares WRITE_SECURE_SETTINGS signature|privileged|development
    await loadPlatform();
    const pkg = "test.permissions", denied = "android.permission.WRITE_SECURE_SETTINGS";
    const int = (name: string, data: number): XmlAttr => ({ name, str: null, ns: "", resId: 0, type: TV.INT_DEC, data });
    const root: XmlNode = { name: "manifest", attrs: [attr("package", pkg)], children: [
      { name: "uses-sdk", attrs: [int("targetSdkVersion", 35)], children: [] },
      { name: "application", attrs: [], children: [] },
      ...["android.permission.INTERNET", denied].map(name => ({ name: "uses-permission", attrs: [attr("name", name)], children: [] })),
      // requested only through API 28
      { name: "uses-permission", attrs: [attr("name", "android.permission.WRITE_EXTERNAL_STORAGE"), int("maxSdkVersion", 28)], children: [] },
    ] };
    const register = (grants: string[]) => packages.set(pkg, new PackageRecord(root, new Resources(null, {}), "/test.apk", 12345, async () => [], { grants }));
    register([]);
    try {
      const pms = await hostedService("package"), PI = "android/content/pm/PackageInfo";
      const packageInfo = (flags: bigint) => vcall(pms, "getPackageInfo", "(Ljava/lang/String;JI)Landroid/content/pm/PackageInfo;", pkg, flags, 0);
      const info = await packageInfo(0x1000n);
      expect([...getDeclared<string[]>(info, PI, "requestedPermissions")]).toEqual(["android.permission.INTERNET", denied]);
      expect([...getDeclared<Int32Array>(info, PI, "requestedPermissionsFlags")]).toEqual([3, 1]);
      register([denied]);
      expect([...getDeclared<Int32Array>(await packageInfo(0x1000n), PI, "requestedPermissionsFlags")]).toEqual([3, 3]);
      const omitted = await packageInfo(0n);
      expect(getDeclared(omitted, PI, "requestedPermissions")).toBeNull();
      expect(getDeclared(omitted, PI, "requestedPermissionsFlags")).toBeNull();
    } finally { packages.delete(pkg); }
  });
});

describe("packagearchive", () => {
  test("foreign package metadata retains lazy assets without reading the whole APK", async () => {
    const bytes = new Uint8Array(readFileSync("apks/FitNotes.apk"));
    const baseline = await parsePackageArchive(bytes), file = new BytesFile(bytes);
    let readBytes = 0;
    const archive = await packageArchiveSource({ size: file.size, read(offset, length) {
      const chunk = file.read(offset, length);
      readBytes += chunk.length;
      return chunk;
    } }, baseline.certificates);
    expect(archive.root).toEqual(baseline.root);
    expect(archive.certificates).toEqual(baseline.certificates);
    expect(archive.res.zip["resources.arsc"]).toEqual(baseline.res.zip["resources.arsc"]);
    expect(readBytes).toBeLessThan(bytes.length);
    const pool = archive.res.arsc!.values;
    for (let i = 0; i < pool.length; i++) {
      const name = pool.get(i);
      if (Object.hasOwn(baseline.res.zip, name)) expect(archive.res.arsc!.files(name)).toEqual(baseline.res.zip[name]);
    }
    expect(archive.res.lazyEntries.has("classes.dex")).toBe(true);
    const metadataBytes = readBytes, residentBytes = Object.values(archive.res.zip).reduce((sum, data) => sum + data.length, 0);
    expect(await readFully(archive.res.lazyEntries.get("classes.dex")!)).toEqual(baseline.res.zip["classes.dex"]);
    console.log(JSON.stringify({ apkBytes: bytes.length, metadataBytes, residentBytes }));
  });

  test("v1 APK certificate discovery leaves unrelated ZIP entries lazy", async () => {
    const bytes = new Uint8Array(readFileSync("apks/flappybird.apk"));
    const zip = zipTree(bytes), descriptors = Object.getOwnPropertyDescriptors(zip);
    const certificates = await apkCertificates(bytes, zip);
    expect(certificates).toHaveLength(1);
    expect(createHash("sha256").update(certificates[0]).digest("hex"))
      .toBe("91cc0cfca44abfc55f7974e68fb4bcaa9684d6e222d44f3393b5c4bcdbc95654");
    for (const [name, descriptor] of Object.entries(descriptors)) {
      if (!/^META-INF\/[^/]+\.(RSA|DSA|EC)$/i.test(name)) {
        expect(Object.getOwnPropertyDescriptor(zip, name)?.get).toBe(descriptor.get);
      }
    }
  });
});

describe("pending-intents", () => {


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

  test("canonical pending commands bind creator identity and preserve copied updates after caller death", async () => {
    await app();
    const broker = new ProcessBroker(), owner = packages.get(PKG)!;
    const foreign = await packageRecord("org.webdroid.test.pendingforeign");
    packages.set(foreign.pkg, foreign);
    broker.register(PKG, PKG + ":owner", 7701);
    broker.register(PKG, PKG + ":sibling", 7702);
    broker.register(foreign.pkg, foreign.pkg, 7703);
    const clients = [7701,7702,7703].map(pid => callProxy<BrokerCalls>(broker.brokerPort(pid), brokerMethods,
      [], error => Object.assign(new Error(error.message ?? ""), {javaClass:error.javaClass})));
    const [creator,sibling,other] = clients.map(client => client.endpoint);
    const encoded = async (extra: string) => {
      const intent = await newIntent("org.webdroid.test.PENDING");
      await vcall(intent,"putExtra","(Ljava/lang/String;Ljava/lang/String;)Landroid/content/Intent;","extra",extra);
      return encodeIntent(intent);
    };
    try {
      const data = await encoded("original");
      const cls = PKG + ".CanonicalService";
      owner.components.service.set(cls,{name:"service",attrs:[
        {name:"name",str:cls,ns:"",resId:0,type:TV.STRING,data:0},
        {name:"process",str:PKG+":owner",ns:"",resId:0,type:TV.STRING,data:0}],children:[]});
      expect(await sibling.starts.created(cls,data).catch(error=>error.javaClass)).toBe("java/lang/SecurityException");
      await creator.starts.created(cls,data);
      expect(await creator.starts.requested(cls)).toBe(false);
      const queued = await encoded("service");
      const start = await creator.starts.start(cls,queued);
      queued.bytes.fill(0);
      expect(await creator.starts.requested(cls)).toBe(true);
      const delivered = await creator.starts.deliver(cls);
      expect(delivered.map(item=>item.id)).toEqual([start]);
      expect(await vcall(await decodeIntent(delivered[0].intent!),"getStringExtra","(Ljava/lang/String;)Ljava/lang/String;","extra")).toBe("service");
      expect(await creator.starts.stopSelf(cls,start+1)).toBe(false);
      expect(await creator.starts.done(cls,start,2)).toBe(true);
      expect(await creator.starts.stop(cls)).toBe(true);
      await creator.starts.foreground(cls,true);
      await creator.starts.destroyed(cls);

      const id = (await creator.pending.create(PKG,"activity",7,0,data))!;
      const denied = await other.pending.create(PKG,"activity",8,0,data).catch(error => error.javaClass);
      expect(denied).toBe("java/lang/SecurityException");
      expect(await creator.pending.creator(id)).toEqual({pkg:PKG,uid:owner.uid});
      expect(await sibling.pending.create(PKG,"activity",7,0x8000000,await encoded("updated"))).toBe(id);
      const operation = (await sibling.pending.operation(id))!;
      expect(operation.process).toBe(PKG + ":owner");
      expect(await vcall(await decodeIntent(operation.intent),"getStringExtra","(Ljava/lang/String;)Ljava/lang/String;","extra")).toBe("updated");
      operation.intent.bytes.fill(0);
      expect(await vcall(await decodeIntent(broker.intents.get(id)!.intent),"getStringExtra","(Ljava/lang/String;)Ljava/lang/String;","extra")).toBe("updated");
      expect(await other.pending.cancel(id).catch(error => error.javaClass)).toBe("java/lang/SecurityException");
      // An alarm is system_server's: its creator's death does not cancel its operation.
      let receiveAlarm!: (request: unknown) => void;
      const delivery = new Promise(resolve => receiveAlarm = resolve);
      useAlarmIntents(broker.intents);
      setOperationAlarm(id,2,uptimeMillis()+50,0);
      broker.fail(7701,"normal caller fixture death",NOT_CRASHED);
      broker.register(PKG,PKG + ":owner",7704);
      broker.ready(7704,{...createProcessEndpoint(),service:async request => {receiveAlarm(request);return null;}});
      const fired = await Promise.race([delivery,new Promise(resolve => setTimeout(()=>resolve(null),1000))]);
      expect(fired).toMatchObject({kind:"pending",alarmCount:1,operation:{uid:owner.uid,process:PKG+":owner"}});
      expect(await sibling.pending.kind(id)).toBe("activity");
      removeAlarm(id);
      await sibling.pending.cancel(id);
      expect(await sibling.pending.creator(id)).toBeNull();
      const single = (await sibling.pending.create(PKG,"broadcast",9,0x40000000,await encoded("single")))!;
      expect((await sibling.pending.operation(single))!.kind).toBe("broadcast");
      expect(await sibling.pending.operation(single)).toBeNull();
    } finally {
      for (const client of clients) client.close();
      for (const pid of [7701,7702,7703,7704]) broker.fail(pid,"pending fixture cleanup",NOT_CRASHED);
      broker.intents.remove(PKG); broker.permissions.clear(PKG); packages.delete(foreign.pkg);
      useAlarmIntents({ get: unconnected, watch: unconnected, send: notConnected });
    }
  });

  test("PendingIntent reports its stored operation type", async () => {
    const context = await app(), intent = await newIntent();
    const broker = new ProcessBroker(), { pid } = broker.register(PKG, PKG, 4321);
    const client = callProxy<BrokerCalls>(broker.brokerPort(pid), brokerMethods), records = client.endpoint, owner = { ...pendingTransport };
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const acknowledgment = new Promise<void>(resolve => { release = resolve; });
    Object.assign(pendingTransport, { ...records.pending, cancel: async (id: number) => { entered(); await acknowledgment; await records.pending.cancel(id); } } satisfies PendingAccess);
    useAlarmIntents(broker.intents);
    try {
      const path = "/data/data/test/pending-fd.bin";
      vfs.write(path, Uint8Array.of(7));
      const fd = await scall("android/system/Os", "open", "(Ljava/lang/String;II)Ljava/io/FileDescriptor;", path, 0, 0);
      const pfd = await newObj("android/os/ParcelFileDescriptor", "(Ljava/io/FileDescriptor;)V", fd);
      try {
        const supplied = await newIntent();
        await vcall(supplied, "putExtra", "(Ljava/lang/String;Landroid/os/Parcelable;)Landroid/content/Intent;", "fd", pfd);
        const activityManager = await hostedService("activity");
        const rejected = await Promise.resolve().then(() => vcall(activityManager, "getIntentSenderWithFeature",
          "(ILjava/lang/String;Ljava/lang/String;Landroid/os/IBinder;Ljava/lang/String;I[Landroid/content/Intent;[Ljava/lang/String;ILandroid/os/Bundle;I)Landroid/content/IIntentSender;",
          1, PKG, null, null, null, 2, jarray([supplied], "Landroid/content/Intent;"), null, 0x4000000, null, 0)).then(() => null, (error: unknown) => error);
        expect(iof(rejected, "java/lang/IllegalArgumentException")).toBe(true);
        expect(await vcall(pfd, "getFd", "()I")).toBeGreaterThanOrEqual(0);
      } finally { await vcall(pfd, "close", "()V"); }
      const activity = await scall("android/app/PendingIntent", "getActivity", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, 1, intent, 0x4000000);
      const broadcast = await scall("android/app/PendingIntent", "getBroadcast", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, 1, intent, 0x4000000);
      const foreground = await scall("android/app/PendingIntent", "getForegroundService", "(Landroid/content/Context;ILandroid/content/Intent;I)Landroid/app/PendingIntent;", context, 1, intent, 0x4000000);
      expect(await vcall(activity, "isActivity", "()Z")).toBe(1);
      expect(await vcall(activity, "isBroadcast", "()Z")).toBe(0);
      expect(await vcall(activity, "isImmutable", "()Z")).toBe(1);
      expect(await vcall(broadcast, "isActivity", "()Z")).toBe(0);
      expect(await vcall(broadcast, "isBroadcast", "()Z")).toBe(1);
      expect(await vcall(foreground, "isForegroundService", "()Z")).toBe(1);
      expect(await vcall(foreground, "isService", "()Z")).toBe(0);
      const alarm = await vcall(context, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "alarm");
      await vcall(alarm, "set", "(IJLandroid/app/PendingIntent;)V", 2, 1000000000000n, broadcast);
      await vcall(alarm, "cancel", "(Landroid/app/PendingIntent;)V", broadcast);
      let done = false;
      const canceled = vcallAsync(activity, "cancel", "()V").then(() => { done = true; });
      await waiting;
      expect(done).toBe(false);
      release();
      await canceled;
      expect(done).toBe(true);
      const error = await Promise.resolve(sendIntent(activity)).then(() => null, error => error);
      expect(iof(error, "android/app/PendingIntent$CanceledException")).toBe(true);
    } finally {
      release(); client.close(); Object.assign(pendingTransport, owner); useAlarmIntents({ get: unconnected, watch: unconnected, send: notConnected });
      broker.fail(pid, "pending fixture cleanup", NOT_CRASHED); broker.intents.remove(PKG);
    }
  });
});

describe("resolver-file", () => {
  test("resolver file opens decode paths and reject missing files without creating them", async () => {
    const resolver = await vcall(await app(), "getContentResolver", "()Landroid/content/ContentResolver;");
    const path = "/resolver file?x=1", uri = await mkUri("file:///resolver%20file%3Fx%3D1?ignored=2#fragment");
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
      for (const missing of [uri, await mkUri("unsupported://file")]) {
        const error = await vcallAsync(resolver, "openFileDescriptor", "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;", missing, "r").catch(error => error);
        expect(iof(error, "java/io/FileNotFoundException")).toBe(true);
      }
      expect(vfs.exists(path)).toBe(false);
    } finally { vfs.delete(path); }
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
    const zip = zipTree(new Uint8Array(readFileSync("apks/FitNotes.apk")));
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
    const theme = new NativeTheme(res), attr = 0x7f020000;
    theme.entries.set(attr, { t: TV.REFERENCE, d: 0x7f010000, pkg: 0x7f, flags: 0 });
    const selected = theme.resolvedAttribute(attr);
    const other = new Resources(null, {}, undefined, true);
    other.setApks([]);
    expect(theme.resolvedAttribute(attr)).toBe(selected);
    config.density = table.device.density = 160;
    res.invalidate();
    expect(theme.resolvedAttribute(attr)).toMatchObject({ d: 1, density: 160 });
  });
});

describe("service-bind", () => {

  test("a failed service binding still requires one unbind", async () => {
    const context = await app(), intent = await newIntent();
    await vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", await mkComponentName(PKG, PKG + ".MissingService"));
    const connection = await newObj("test/Connection");
    expect(await vcall(context, "bindService", "(Landroid/content/Intent;Landroid/content/ServiceConnection;I)Z", intent, connection, 0)).toBe(0);
    await vcall(context, "unbindService", "(Landroid/content/ServiceConnection;)V", connection);
    const second = await vcallAsync(context, "unbindService", "(Landroid/content/ServiceConnection;)V", connection).then(() => null, (e: { msg?: string }) => e.msg);
    expect(second).toMatch(/^Service not registered: /);
  });
});

describe("window-context", () => {

  test("display and window contexts retain display identity and own their window service", async () => {
    const source = await app(), screen = await vcall(await scall("android/hardware/display/DisplayManagerGlobal", "getInstance", "()Landroid/hardware/display/DisplayManagerGlobal;"), "getRealDisplay", "(I)Landroid/view/Display;", 0);
    const displayContext = await vcall(source, "createDisplayContext", "(Landroid/view/Display;)Landroid/content/Context;", screen);
    expect(await vcall(displayContext, "getDisplay", "()Landroid/view/Display;")).toBe(screen);
    expect(await vcall(displayContext, "isUiContext", "()Z")).toBe(0);
    const window = await vcall(displayContext, "createWindowContext", "(ILandroid/os/Bundle;)Landroid/content/Context;", 2038, null);
    expect(iof(window, "android/content/ContextWrapper")).toBeTruthy();
    // its display is the window manager's for the same display id, not the caller's object
    expect(await vcall(await vcall(window, "getDisplay", "()Landroid/view/Display;"), "getDisplayId", "()I")).toBe(await vcall(screen, "getDisplayId", "()I"));
    expect(await vcall(window, "isUiContext", "()Z")).toBe(1);
    const manager = await vcall(window, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "window");
    expect(await vcall(window, "getSystemService", "(Ljava/lang/Class;)Ljava/lang/Object;", rt.classFor("android/view/WindowManager"))).toBe(manager);
    const second = await vcall(source, "createWindowContext", "(Landroid/view/Display;ILandroid/os/Bundle;)Landroid/content/Context;", screen, 2038, null);
    expect(await vcall(second, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "window")).not.toBe(manager);
    const error = await vcallAsync(source, "createDisplayContext", "(Landroid/view/Display;)Landroid/content/Context;", null).then(() => null, e => e);
    expect(iof(error, "java/lang/IllegalArgumentException")).toBeTruthy();
  });

});
