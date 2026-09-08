import { afterAll, expect, test } from "bun:test";
import "../natives";
import { vcall, newObj } from "../jvm/natives/jlang";
import { type XmlNode, TV } from "./axml";
import { Arsc } from "./arsc";
import { Resources, JTheme } from "./res";
import { JResources } from "./resnative";
import { type AppHost, appHost, setAppHost } from "./apphost";
import { setManifest } from "./pm";
import { mkComponentName } from "./intent";

const previousHost = appHost;
afterAll(() => setAppHost(previousHost));

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
