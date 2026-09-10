import { afterAll, expect, test } from "bun:test";
import "../natives";
import { vcall, newObj } from "../jvm/natives/jlang";
import { type XmlNode, TV, attrStr } from "./axml";
import { Arsc } from "./arsc";
import { Resources, JTheme } from "./res";
import { JResources } from "./resnative";
import { type AppHost, appHost, setAppHost } from "./apphost";
import { setManifest, registerPackage } from "./pm";
import { packages } from "./packages";
import { parsePackageArchive } from "./packagearchive";
import { mkComponentName, launchIntent } from "./intent";

const previousHost = appHost;
afterAll(() => setAppHost(previousHost));

test("installed packages resolve components, resources and signing identities independently", async () => {
  const first = host(); setAppHost(first);
  setManifest(node("manifest", { package: first.pkg }, [node("application")]), new Map(), new Map());
  const other = host(); other.pkg = "test.other";
  const root = node("manifest", { package: other.pkg, versionCode: 42 }, [node("application", { label: "Other" }, [
    node("service", { name: ".Shared", process: ":worker", exported: 1 }, [node("intent-filter", {}, [node("action", { name: "test.CROSS_PACKAGE" })]), node("meta-data", { name: "owner", value: "other" })]),
    node("provider", { name: ".Data", authorities: "test.other.data", exported: 1 }),
  ])]);
  const cert = new Uint8Array([1, 2, 3]);
  const record = registerPackage({ root, pkg: other.pkg, res: other.res, certificates: [cert] });
  try {
    const pm = await newObj("android/content/pm/PackageManager"), intent = await newObj("android/content/Intent");
    intent.action = "test.CROSS_PACKAGE"; intent.pkg = other.pkg;
    const list = await vcall(pm, "queryIntentServices", "(Landroid/content/Intent;I)Ljava/util/List;", intent, 128);
    expect(list.a).toHaveLength(1);
    expect(list.a[0].serviceInfo.processName).toBe("test.other:worker");
    expect(list.a[0].serviceInfo.metaData.map.get("owner")).toBe("other");
    expect(list.a[0].serviceInfo.applicationInfo.uid).toBe(record.uid);
    expect(list.a[0].serviceInfo.applicationInfo.uid).not.toBe(packages.get(first.pkg)?.uid);
    const provider = await vcall(pm, "resolveContentProvider", "(Ljava/lang/String;I)Landroid/content/pm/ProviderInfo;", "test.other.data", 0);
    expect(provider.applicationInfo.packageName).toBe(other.pkg);
    const get = () => vcall(pm, "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", other.pkg, 64);
    expect(new Uint8Array((await get()).signatures[0].bytes)).toEqual(cert);
    record.compatibilityCertificates = [new Uint8Array([9])];
    expect(new Uint8Array((await get()).signatures[0].bytes)).toEqual(new Uint8Array([9]));
    expect(await record.certificates()).toEqual([cert]);
    record.system = true;
    expect((await vcall(pm, "queryIntentServices", "(Landroid/content/Intent;I)Ljava/util/List;", intent, 0x100000)).a).toHaveLength(1);
    intent.pkg = first.pkg;
    expect((await vcall(pm, "queryIntentServices", "(Landroid/content/Intent;I)Ljava/util/List;", intent, 0)).a).toHaveLength(0);
  } finally { packages.delete(other.pkg); }
});

const node = (name: string, attrs: Record<string, string | number> = {}, children: XmlNode[] = []): XmlNode => ({ name, children,
  attrs: Object.entries(attrs).map(([name, value]) => ({ name, ns: "", resId: 0, type: typeof value === "string" ? TV.STRING : TV.INT_DEC, data: typeof value === "number" ? value : 0, str: typeof value === "string" ? value : null })) });
function host(): AppHost {
  const bytes = new Uint8Array([2, 0, 12, 0, 12, 0, 0, 0, 0, 0, 0, 0]);
  const res = new Resources(new Arsc(bytes), {}), theme = new JTheme(), jresources = new JResources();
  theme.res = res; jresources.host = res;
  const unused = () => { throw new Error("unexpected lifecycle call"); };
  return { res, theme, jresources, pkg: "test.services", apkFile: "", appLabel: "Service Test", themeResId: 0, iconRes: 0,
    zip: {}, splits: [], application: null, statusBarColor: 0, navBarColor: 0, launch: unused, finishActivity: unused,
    recreateActivity: unused, setRequestedOrientation: unused, currentActivity: () => null, invalidateOptionsMenu: unused };
}

test("service metadata and resolution honor the installed manifest and query flags", async () => {
  const installed = host(); setAppHost(installed);
  const filter = (priority: number) => node("intent-filter", { priority }, [node("action", { name: "test.ACTION" }), node("category", { name: "test.CATEGORY" })]);
  const app = node("application", { permission: "test.permission.DEFAULT" }, [
    node("service", { name: ".Private", exported: 0, process: ":worker" }, [filter(2), node("meta-data", { name: "count", value: 7 })]),
    node("service", { name: "Public", exported: 1 }, [filter(5)]),
    node("service", { name: "vendor.disabled.Metadata", enabled: 0, directBootAware: 1 }, [node("meta-data", { name: "flag", value: "value" })]),
  ]);
  setManifest(node("manifest", { package: installed.pkg }, [app]), new Map(), new Map());
  const pm = await newObj("android/content/pm/PackageManager");
  const get = (name: string, flags = 0) => vcall(pm, "getServiceInfo", "(Landroid/content/ComponentName;I)Landroid/content/pm/ServiceInfo;", mkComponentName(installed.pkg, name), flags);
  const service = await get(".Private", 0x80);
  expect(service.name).toBe("test.services.Private"); expect(service.exported).toBe(0);
  expect(service.applicationInfo.packageName).toBe(installed.pkg); expect(service.applicationInfo.nonLocalizedLabel).toBe("Service Test");
  expect(service.processName).toBe("test.services:worker"); expect(service.permission).toBe("test.permission.DEFAULT");
  expect(service.metaData.map.get("count")).toBe(7); expect((await get(".Private")).metaData).toBeNull();
  await expect(get("Missing")).rejects.toMatchObject({ msg: "test.services/test.services.Missing" });
  await expect(get("vendor.disabled.Metadata")).rejects.toMatchObject({ msg: "test.services/vendor.disabled.Metadata" });
  expect((await get("vendor.disabled.Metadata", 0xc0280)).metaData.map.get("flag")).toBe("value");
  const intent = await newObj("android/content/Intent"); intent.action = "test.ACTION"; intent.categories.add("test.CATEGORY");
  const query = (flags = 0) => vcall(pm, "queryIntentServices", "(Landroid/content/Intent;I)Ljava/util/List;", intent, flags);
  expect((await query()).a.map((r: { serviceInfo: { name: string } }) => r.serviceInfo.name)).toEqual(["test.services.Public", "test.services.Private"]);
  expect((await vcall(pm, "resolveService", "(Landroid/content/Intent;I)Landroid/content/pm/ResolveInfo;", intent, 0)).serviceInfo.name).toBe("test.services.Public");
  expect((await query(0x100000)).a).toEqual([]);
  intent.categories.add("missing"); expect((await query()).a).toEqual([]); intent.categories.clear();
  intent.pkg = "external.package"; expect((await query()).a).toEqual([]); intent.pkg = null;
  await vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", mkComponentName("external.package", "test.services.Public"));
  expect((await vcall(intent, "getComponent", "()Landroid/content/ComponentName;")).pkg).toBe("external.package");
  expect((await query()).a).toEqual([]);
  await vcall(intent, "setComponent", "(Landroid/content/ComponentName;)Landroid/content/Intent;", mkComponentName(installed.pkg, ".Private"));
  intent.action = "wrong.action"; expect((await query()).a.length).toBe(1);
  app.attrs.push(...node("application", { enabled: 0 }).attrs);
  expect((await query()).a).toEqual([]); expect((await query(0x200)).a.length).toBe(1);
  setManifest(node("manifest", { package: installed.pkg }, [node("application")]), new Map(), new Map());
  expect((await query(0x200)).a).toEqual([]);
});

test("broadcast receiver queries and PackageInfo expose only installed matching receivers", async () => {
  const installed = host(); setAppHost(installed);
  const filter = node("intent-filter", {}, [node("action", { name: "test.PUSH" }), node("category", { name: "test.CATEGORY" })]);
  setManifest(node("manifest", { package: installed.pkg }, [node("application", {}, [
    node("receiver", { name: ".Push", exported: 1 }, [filter, node("meta-data", { name: "version", value: 2 })]),
    node("receiver", { name: ".Disabled", enabled: 0 }, [filter]),
    node("service", { name: ".Service" }, [filter]),
  ])]), new Map(), new Map());
  const pm = await newObj("android/content/pm/PackageManager"), intent = await newObj("android/content/Intent");
  intent.action = "test.PUSH";
  const query = (flags = 0) => vcall(pm, "queryBroadcastReceivers", "(Landroid/content/Intent;I)Ljava/util/List;", intent, flags);
  const matches = (await query(0x80)).a;
  expect(matches.length).toBe(1); expect(matches[0].serviceInfo).toBeNull();
  expect(matches[0].activityInfo.name).toBe("test.services.Push");
  expect(matches[0].activityInfo.applicationInfo.packageName).toBe(installed.pkg);
  expect(matches[0].activityInfo.metaData.map.get("version")).toBe(2);
  expect((await query(0x200)).a.length).toBe(2);
  const receiver = (pkg: string, cls: string, flags = 0) => vcall(pm, "getReceiverInfo", "(Landroid/content/ComponentName;I)Landroid/content/pm/ActivityInfo;", mkComponentName(pkg, cls), flags);
  expect((await receiver(installed.pkg, ".Push", 0x80)).metaData.map.get("version")).toBe(2);
  expect((await receiver(installed.pkg, "test/services/Push")).name).toBe("test.services.Push");
  expect((await receiver(installed.pkg, ".Push")).metaData).toBeNull();
  await expect(receiver(installed.pkg, ".Disabled")).rejects.toBeDefined();
  expect((await receiver(installed.pkg, ".Disabled", 0x200)).enabled).toBe(0);
  await expect(receiver("other.package", ".Push")).rejects.toBeDefined();
  await expect(receiver(installed.pkg, ".Service")).rejects.toBeDefined();

  intent.categories.add("absent"); expect((await query()).a).toEqual([]); intent.categories.clear();
  intent.pkg = "external.package"; expect((await query()).a).toEqual([]); intent.pkg = null;
  const get = (flags: number) => vcall(pm, "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", installed.pkg, flags);
  expect((await get(0)).receivers).toBeNull();
  const receivers = (await get(2)).receivers;
  expect(receivers.$t).toBe("Landroid/content/pm/ActivityInfo;"); expect(receivers.map((a: { name: string }) => a.name)).toEqual(["test.services.Push"]);
  expect((await get(0x202)).receivers.length).toBe(2);
  setManifest(node("manifest", { package: installed.pkg }, [node("application")]), new Map(), new Map());
  expect((await query()).a).toEqual([]);
});


test("provider XML metadata loads the manifest resource through PackageItemInfo", async () => {
  const archive = await parsePackageArchive(new Uint8Array(await Bun.file(new URL("../../apks/mihon-v0.20.4.apk", import.meta.url)).arrayBuffer()));
  const installed = host(); installed.pkg = archive.pkg; installed.res = archive.res; setAppHost(installed);
  const nodes = archive.root.children.find((child) => child.name === "application")!.children.filter((child) => child.name === "provider");
  const providers = new Map(nodes.map((child) => [attrStr(child, "name")!, child]));
  setManifest(archive.root, new Map(), providers);
  const pm = await newObj("android/content/pm/PackageManager");
  const info = await vcall(pm, "resolveContentProvider", "(Ljava/lang/String;I)Landroid/content/pm/ProviderInfo;", "app.mihon.provider", 128);
  expect(info.applicationInfo.packageName).toBe(archive.pkg);
  const parser = await vcall(info, "loadXmlMetaData", "(Landroid/content/pm/PackageManager;Ljava/lang/String;)Landroid/content/res/XmlResourceParser;", pm, "android.support.FILE_PROVIDER_PATHS");
  expect(await vcall(parser, "next", "()I")).toBe(0);
  expect(await vcall(parser, "next", "()I")).toBe(2);
  expect(await vcall(parser, "getName", "()Ljava/lang/String;")).toBe("paths");
  expect(await vcall(parser, "next", "()I")).toBe(2);
  expect(await vcall(parser, "getName", "()Ljava/lang/String;")).toBe("cache-path");
  expect(await vcall(parser, "getAttributeValue", "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;", null, "name")).toBe("cache_files");
  expect(await vcall(info, "loadXmlMetaData", "(Landroid/content/pm/PackageManager;Ljava/lang/String;)Landroid/content/res/XmlResourceParser;", pm, "missing")).toBeNull();
  expect(await vcall(pm, "getXml", "(Ljava/lang/String;ILandroid/content/pm/ApplicationInfo;)Landroid/content/res/XmlResourceParser;", archive.pkg, 0x7fffffff, info.applicationInfo)).toBeNull();
  const without = await vcall(pm, "getProviderInfo", "(Landroid/content/ComponentName;I)Landroid/content/pm/ProviderInfo;", mkComponentName(archive.pkg, info.name), 0);
  expect(without.metaData).toBeNull();
  const direct = await vcall(pm, "getProviderInfo", "(Landroid/content/ComponentName;I)Landroid/content/pm/ProviderInfo;", mkComponentName(archive.pkg, info.name), 128);
  expect(direct.metaData.map.get("android.support.FILE_PROVIDER_PATHS")).toBe(info.metaData.map.get("android.support.FILE_PROVIDER_PATHS"));
});

test("activity resolution and launch share manifest data, categories, and visibility", async () => {
  const installed = host(); setAppHost(installed);
  const filter = (priority: number, data: XmlNode[], categories = ["android.intent.category.DEFAULT"]) => node("intent-filter", { priority }, [
    node("action", { name: "android.intent.action.VIEW" }), ...categories.map((name) => node("category", { name })), ...data,
  ]);
  const activities = [
    node("activity", { name: ".Web" }, [filter(2, [node("data", { scheme: "https" }), node("data", { host: "*.example.test", port: "8443", pathPrefix: "/posts/" })])]),
    node("activity", { name: ".Disabled", enabled: 0 }, [filter(5, [node("data", { scheme: "https" })])]),
    node("activity", { name: ".NonDefault" }, [filter(9, [node("data", { scheme: "https" })], [])]),
    node("activity", { name: ".Image" }, [filter(1, [node("data", { mimeType: "image/*" })])]),
    node("activity", { name: ".Glob" }, [filter(1, [node("data", { scheme: "custom", host: "host", pathPattern: "/.*ab" })])]),
  ];
  setManifest(node("manifest", { package: installed.pkg }, [node("application", {}, activities)]),
    new Map(activities.map((n) => [(installed.pkg + attrStr(n, "name")).replace(/\./g, "/"), n])), new Map());
  const pm = await newObj("android/content/pm/PackageManager"), intent = await newObj("android/content/Intent");
  intent.action = "android.intent.action.VIEW"; intent.dataUri = "https://SUB.example.test:8443/posts/a%20b";
  const query = async (flags = 0x10000) => (await vcall(pm, "queryIntentActivities", "(Landroid/content/Intent;I)Ljava/util/List;", intent, flags)).a.map((r: { activityInfo: { name: string } }) => r.activityInfo.name);
  expect(await query()).toEqual(["test.services.Web"]);
  expect(await query(0)).toEqual(["test.services.NonDefault", "test.services.Web"]);
  expect(await query(0x10200)).toEqual(["test.services.Disabled", "test.services.Web"]);
  expect((await vcall(intent, "resolveActivity", "(Landroid/content/pm/PackageManager;)Landroid/content/ComponentName;", pm)).cls).toBe("test.services.Web");
  const launches: unknown[] = []; installed.launch = async (...args) => { launches.push(args); };
  await launchIntent(installed, intent);
  expect(launches).toEqual([["test/services/Web", intent]]); expect(intent.component).toBeNull();
  intent.categories.add("missing"); expect(await query()).toEqual([]); intent.categories.clear();
  intent.pkg = "other"; expect(await query()).toEqual([]); intent.pkg = null;
  for (const uri of ["https://sub.example.test/posts/a", "https://example.test:8443/posts/a", "HTTPS://sub.example.test:8443/posts/a", "https://sub.example.test:8443/other"]) {
    intent.dataUri = uri; expect(await query()).toEqual([]);
  }
  await expect(launchIntent(installed, intent)).rejects.toMatchObject({ msg: "No activity found for android.intent.action.VIEW" });
  intent.typeStr = "image/png"; intent.dataUri = "content://media/photo";
  expect(await query()).toEqual(["test.services.Image"]);
  intent.dataUri = "file:///photo"; expect(await query()).toEqual(["test.services.Image"]);
  intent.dataUri = "https://media/photo"; expect(await query()).toEqual([]);
  intent.dataUri = null; expect(await query()).toEqual(["test.services.Image"]);
  intent.typeStr = null; intent.dataUri = "custom://host/ab"; expect(await query()).toEqual(["test.services.Glob"]);
  intent.dataUri = "custom://host/aab"; expect(await query()).toEqual([]);
  intent.component = ".Web"; intent.action = "unrelated"; expect(await query()).toEqual(["test.services.Web"]);
  intent.component = ".Missing"; expect(await query()).toEqual([]);
});

test("package permissions come from applicable manifest declarations only when requested", async () => {
  const installed = host(); setAppHost(installed);
  setManifest(node("manifest", { package: installed.pkg }, [node("application"),
    node("uses-permission", { name: "test.ONE" }), node("uses-permission", { name: "test.ONE" }),
    node("uses-permission", { name: "test.OLD", maxSdkVersion: 22 }),
    node("uses-permission-sdk-23", { name: "test.NEW" }),
  ]), new Map(), new Map());
  const pm = await newObj("android/content/pm/PackageManager");
  const get = (flags: number) => vcall(pm, "getPackageInfo", "(Ljava/lang/String;I)Landroid/content/pm/PackageInfo;", installed.pkg, flags);
  expect((await get(0)).requestedPermissions).toBeNull();
  const permissions = (await get(0x1000)).requestedPermissions;
  expect([...permissions]).toEqual(["test.ONE", "test.NEW"]); expect(permissions.$t).toBe("Ljava/lang/String;");
  const intent = await newObj("android/content/Intent", "(Ljava/lang/String;Landroid/net/Uri;Landroid/content/Context;Ljava/lang/Class;)V", "test.OPEN", { uri: "https://example.test" }, { $host: installed }, { ci: { name: "test/services/Activity" } });
  expect(intent.action).toBe("test.OPEN"); expect(intent.dataUri).toBe("https://example.test");
  expect(intent.component).toBe("test.services.Activity"); expect(intent.componentPkg).toBe(installed.pkg);
});
