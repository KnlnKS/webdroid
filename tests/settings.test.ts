import { expect, test, beforeAll, describe } from "bun:test";
import "../src/natives";
import { rt, JObj, declaredField } from "../src/jvm/runtime";
import { newObj, vcall, scall } from "../src/jvm/natives/jlang";
import { JApplication } from "../src/android/app";
import { setAppHost } from "../src/android/apphost";
import { packages, PackageRecord, packageUid } from "../src/android/packages";
import { Resources } from "../src/android/res";
import { TV, type XmlAttr, type XmlNode } from "../src/android/axml";
import { setProcessIdentity } from "../src/android/os";
import { locationTransport } from "../src/android/locationmanager";
import { hostedService } from "../src/android/binder";
import { mkUri, type JUri } from "../src/android/net";
import { settingsStore } from "../src/android/settings";
import { systemProvider } from "../src/android/systemproviders";
import { appResources } from "./java";

const attr = (name: string, str: string | null, data = 0): XmlAttr => ({ name, str, ns: "", resId: 0, type: str === null ? TV.INT_DEC : TV.STRING, data });
function install(pkg: string, target: number, permissions: string[], certificate: number): PackageRecord {
  const manifest: XmlNode = { name: "manifest", attrs: [attr("package", pkg)], children: [
    { name: "uses-sdk", attrs: [attr("minSdkVersion", null, 21), attr("targetSdkVersion", null, target)], children: [] },
    ...permissions.map((name) => ({ name: "uses-permission", attrs: [attr("name", name)], children: [] })),
    { name: "application", attrs: [], children: [] },
  ] };
  const record = new PackageRecord(manifest, new Resources(null, {}), `/${pkg}.apk`, packageUid(pkg), async () => [new Uint8Array([certificate])]);
  packages.set(pkg, record);
  return record;
}
const CR = "Landroid/content/ContentResolver;", S = "Ljava/lang/String;";
const SECURE = "android/provider/Settings$Secure", SYSTEM = "android/provider/Settings$System", GLOBAL = "android/provider/Settings$Global";
let app: JApplication, cr: JObj;
const changes: string[] = [];
rt.register({ name: "webdroid/test/SettingsObserver", ctor: class extends JObj {}, sup: "android/database/ContentObserver", methods: {
  "onChange(ZLandroid/net/Uri;)V": function (this: JObj, _self: number, uri: JUri) { changes.push(`${Reflect.get(this, "tag")} ${uri.uri}`); },
} });
async function observer(tag: string): Promise<JObj> {
  const o = await newObj("webdroid/test/SettingsObserver", "(Landroid/os/Handler;)V", null);
  Reflect.set(o, "tag", tag);
  return o;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const thrown = async (call: () => unknown): Promise<string> => {
  try { await call(); } catch (error) { return `${(error as { constructor: { $i?: { name: string } } }).constructor.$i?.name}: ${(error as { msg?: string }).msg}`; }
  return "no exception";
};

beforeAll(async () => {
  rt.linkNatives();
  const record = install("org.webdroid.test.settings", 35, [], 1);
  install("org.webdroid.test.settings.twin", 35, [], 1);
  install("org.webdroid.test.settings.other", 35, [], 2);
  setProcessIdentity(4321, record.uid);
  const res = record.res, jresources = await appResources(res, record.pkg);
  app = new JApplication();
  const host = { pkg: record.pkg, application: app, res, jresources, splits: [], themeResId: 0, iconRes: 0, currentActivity: () => null, activities: () => [] } as never;
  Reflect.set(app, "$host", host); setAppHost(host);
  cr = await vcall(app, "getContentResolver", `()${CR}`);
});

describe("settings-provider", () => {
  test("Settings reads the device's tables through the provider", async () => {
    expect(await scall(SYSTEM, "getFloat", `(${CR}${S})F`, cr, "font_scale")).toBe(1);
    expect(await scall(SYSTEM, "getInt", `(${CR}${S})I`, cr, "screen_brightness")).toBe(102);
    expect(await thrown(() => scall(SYSTEM, "getInt", `(${CR}${S})I`, cr, "font_scale"))).toBe("android/provider/Settings$SettingNotFoundException: font_scale");
    expect(await scall(GLOBAL, "getString", `(${CR}${S})${S}`, cr, "device_name")).toBe("webdroid");
    expect(await scall(GLOBAL, "getFloat", `(${CR}${S}F)F`, cr, "animator_duration_scale", 0.5)).toBe(0.5);
    const enabled = locationTransport.enabled;
    try {
      locationTransport.enabled = () => false;
      expect(await scall(SECURE, "getInt", `(${CR}${S})I`, cr, "location_mode")).toBe(0);
      locationTransport.enabled = () => true;
      expect(await scall(SECURE, "getInt", `(${CR}${S})I`, cr, "location_mode")).toBe(3);
    } finally { locationTransport.enabled = enabled; }
  });

  test("an app reads its SSAID, the same for every package with its signer", async () => {
    const id: string = await scall(SECURE, "getString", `(${CR}${S})${S}`, cr, "android_id");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
    const provider = await systemProvider("settings")!;
    const read = async (pkg: string) => {
      setProcessIdentity(4321, packages.get(pkg)!.uid);
      try {
        const b = await vcall(provider, "call", "(Landroid/content/AttributionSource;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Landroid/os/Bundle;)Landroid/os/Bundle;", null, "settings", "GET_secure", "android_id", null);
        return vcall(b, "getString", `(${S})${S}`, "value");
      } finally { setProcessIdentity(4321, packages.get("org.webdroid.test.settings")!.uid); }
    };
    expect(await read("org.webdroid.test.settings.twin")).toBe(id);
    expect(await read("org.webdroid.test.settings.other")).not.toBe(id);
  });

  test("a third-party app cannot read hidden keys or write the tables", async () => {
    expect(await thrown(() => scall(SECURE, "getString", `(${CR}${S})${S}`, cr, "lockscreen_show_wallet"))).toBe("java/lang/SecurityException: Settings key: " +
      "<lockscreen_show_wallet> is not readable. From S+, settings keys annotated with @hide are restricted to system_server and system apps only, unless they are annotated with @Readable.");
    expect(await thrown(() => scall(SECURE, "getString", `(${CR}${S})${S}`, cr, "bluetooth_name")))
      .toBe("java/lang/SecurityException: Settings key: <bluetooth_name> is only readable to apps with targetSdkVersion lower than or equal to: 31");
    expect(await thrown(() => scall(SYSTEM, "putInt", `(${CR}${S}I)Z`, cr, "screen_brightness", 50)))
      .toBe("java/lang/SecurityException: org.webdroid.test.settings was not granted  this permission: android.permission.WRITE_SETTINGS.");
    expect(await thrown(() => scall(GLOBAL, "putInt", `(${CR}${S}I)Z`, cr, "airplane_mode_on", 1)))
      .toBe("java/lang/SecurityException: Permission denial, must have one of: [android.permission.WRITE_SECURE_SETTINGS]");
    expect(await scall(SYSTEM, "canWrite", "(Landroid/content/Context;)Z", app)).toBe(0);
    expect(await scall("android/provider/Settings", "canDrawOverlays", "(Landroid/content/Context;)Z", app)).toBe(0);
    expect(await scall(SYSTEM, "getInt", `(${CR}${S})I`, cr, "screen_brightness")).toBe(102);
  });

  test("an app targeting below 23 holds WRITE_SETTINGS and writes persist", async () => {
    const legacy = install("org.webdroid.test.settings.legacy", 22, ["android.permission.WRITE_SETTINGS"], 3);
    setProcessIdentity(4321, legacy.uid);
    try {
      const provider = await systemProvider("settings")!;
      const values = await newObj("android/content/ContentValues");
      await vcall(values, "put", `(${S}${S})V`, "name", "screen_off_timeout");
      await vcall(values, "put", `(${S}${S})V`, "value", "60000");
      const uri: JUri = await vcall(provider, "insert", "(Landroid/content/AttributionSource;Landroid/net/Uri;Landroid/content/ContentValues;Landroid/os/Bundle;)Landroid/net/Uri;",
        null, mkUri("content://settings/system"), values, null);
      expect(uri.uri).toBe("content://settings/system/screen_off_timeout");
      expect(settingsStore().get("system", "screen_off_timeout")).toBe("60000");
    } finally {
      setProcessIdentity(4321, packages.get("org.webdroid.test.settings")!.uid);
      settingsStore().put("system", "screen_off_timeout", "2147483647");
    }
  });

  test("whole-table queries leave out what the caller may not read", async () => {
    const cursor = await vcall(cr, "query", `(Landroid/net/Uri;[${S}${S}[${S}${S})Landroid/database/Cursor;`, mkUri("content://settings/secure"), null, null, null, null);
    const names: string[] = [];
    while (await vcall(cursor, "moveToNext", "()Z")) names.push(await vcall(cursor, "getString", "(I)Ljava/lang/String;", 1));
    expect(names).toContain("android_id");
    expect(names).toContain("long_press_timeout");
    expect(await thrown(() => vcall(cr, "query", `(Landroid/net/Uri;[${S}${S}[${S}${S})Landroid/database/Cursor;`, mkUri("content://settings/config"), null, null, null, null)))
      .toBe("java/lang/IllegalArgumentException: Bad root path: config");
  });

  test("the activity manager hands ActivityThread a holder for the settings provider", async () => {
    const am = await hostedService("activity");
    const holder = await vcall(am, "getContentProvider", "(Landroid/app/IApplicationThread;Ljava/lang/String;Ljava/lang/String;IZ)Landroid/app/ContentProviderHolder;",
      null, "org.webdroid.test.settings", "settings", 0, 0);
    expect(Reflect.get(holder, declaredField("android/app/ContentProviderHolder", "provider"))).toBe(await systemProvider("settings"));
    const info = Reflect.get(holder, declaredField("android/app/ContentProviderHolder", "info"));
    expect(Reflect.get(info, declaredField("android/content/pm/ProviderInfo", "authority"))).toBe("settings");
    expect(await vcall(am, "getContentProvider", "(Landroid/app/IApplicationThread;Ljava/lang/String;Ljava/lang/String;IZ)Landroid/app/ContentProviderHolder;",
      null, "org.webdroid.test.settings", "no.such.authority", 0, 0)).toBe(null);
  });

  test("DeviceConfig reads the config table", async () => {
    expect(await scall("android/provider/DeviceConfig", "getBoolean", `(${S}${S}Z)Z`, "interaction_jank_monitor", "enabled", 0)).toBe(1);
    expect(await scall("android/provider/DeviceConfig", "getInt", `(${S}${S}I)I`, "latency_tracker", "sampling_interval", 0)).toBe(100);
    expect(await scall("android/provider/DeviceConfig", "getProperty", `(${S}${S})${S}`, "latency_tracker", "no_such_flag")).toBe(null);
  });

  test("a change reaches observers of its uri, its ancestors that watch descendants, and through IContentService", async () => {
    const uri = await scall(SECURE, "getUriFor", `(${S})Landroid/net/Uri;`, "ui_night_mode");
    const table = mkUri("content://settings/secure");
    const register = (u: unknown, descendants: number, o: JObj) => vcall(cr, "registerContentObserver", "(Landroid/net/Uri;ZLandroid/database/ContentObserver;)V", u, descendants, o);
    const item = await observer("item"), deep = await observer("deep"), shallow = await observer("shallow"), remote = await observer("remote");
    await register(uri, 0, item); await register(table, 1, deep); await register(table, 0, shallow);
    const content = await hostedService("content");
    await vcall(content, "registerContentObserver", "(Landroid/net/Uri;ZLandroid/database/IContentObserver;II)V",
      uri, 0, await vcall(remote, "getContentObserver", "()Landroid/database/IContentObserver;"), 0, 35);
    changes.length = 0;
    settingsStore().put("secure", "ui_night_mode", "2");
    await settle();
    expect(changes.sort()).toEqual(["deep content://settings/secure/ui_night_mode", "item content://settings/secure/ui_night_mode", "remote content://settings/secure/ui_night_mode"]);
    expect(await scall(SECURE, "getInt", `(${CR}${S})I`, cr, "ui_night_mode")).toBe(2);
    changes.length = 0;
    await vcall(cr, "notifyChange", "(Landroid/net/Uri;Landroid/database/ContentObserver;)V", table, null);
    await settle();
    expect(changes.sort()).toEqual(["deep content://settings/secure", "item content://settings/secure", "remote content://settings/secure", "shallow content://settings/secure"]);
    settingsStore().put("secure", "ui_night_mode", null);
  });
});
