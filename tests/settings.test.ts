import { expect, test, beforeAll, describe } from "bun:test";
import "../src/natives.ts";
import { rt, JObj, declaredField } from "../src/jvm/runtime.ts";
import { newObj, vcall, scall } from "../src/jvm/natives/jentry.ts";
import { packages, type PackageRecord } from "../src/android/packages.ts";
import { setProcessIdentity } from "../src/android/os.ts";
import { locationTransport } from "../src/android/locationmanager.ts";
import { hostedService } from "../src/android/binder.ts";
import { mkUri, uriText, type JUri } from "../src/android/net.ts";
import { settingsStore, useSettingsStore, useSettingsAccess } from "../src/android/settings.ts";
import { remoteSettings, type SettingsCalls } from "../src/shell/settings.ts";
import { callProxy, serveCalls } from "../src/shell/process-port.ts";
import { systemProvider } from "../src/android/systemproviders.ts";
import { bootApp, packageRecord, thrown } from "./java.ts";
import { DEVICE_PROPERTIES } from "../src/shell/device-properties.ts";

async function install(pkg: string, target: number, permissions: string[], certificate: number): Promise<PackageRecord> {
  const record = await packageRecord(pkg, { target, permissions, certificate });
  packages.set(pkg, record);
  return record;
}
const CR = "Landroid/content/ContentResolver;", S = "Ljava/lang/String;";
const SECURE = "android/provider/Settings$Secure", SYSTEM = "android/provider/Settings$System", GLOBAL = "android/provider/Settings$Global";
let app: JObj, cr: JObj;
const changes: string[] = [];
rt.register({ name: "webdroid/test/SettingsObserver", ctor: class extends JObj {}, sup: "android/database/ContentObserver", methods: {
  "onChange(ZLandroid/net/Uri;)V": async function (this: JObj, _self: number, uri: JUri) { changes.push(`${Reflect.get(this, "tag")} ${await uriText(uri)}`); },
} });
async function observer(tag: string): Promise<JObj> {
  const o = await newObj("webdroid/test/SettingsObserver", "(Landroid/os/Handler;)V", null);
  Reflect.set(o, "tag", tag);
  return o;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeAll(async () => {
  await install("org.webdroid.test.settings.twin", 35, [], 1);
  await install("org.webdroid.test.settings.other", 35, [], 2);
  app = await bootApp(await install("org.webdroid.test.settings", 35, [], 1));
  cr = await vcall(app, "getContentResolver", `()${CR}`);
});

describe("settings-provider", () => {
  test("the provider awaits canonical reads and mutation acknowledgment", async () => {
    const store = settingsStore(), channel = new MessageChannel(), key = "webdroid_async_setting";
    let release!: () => void, began!: () => void;
    const gate = new Promise<void>(resolve => release = resolve), entered = new Promise<void>(resolve => began = resolve);
    const stop = serveCalls<SettingsCalls>(channel.port1, {
      settingsGet: async (table, name) => store.get(table, name),
      settingsEntries: async table => store.entries(table),
      settingsSsaid: async () => store.ssaidKey(),
      settingsPut: async (table, name, value) => { began(); await gate; return store.put(table, name, value); },
    });
    const client = callProxy<SettingsCalls>(channel.port2, ["settingsGet", "settingsEntries", "settingsPut", "settingsSsaid"]);
    useSettingsAccess(remoteSettings(() => client.endpoint));
    setProcessIdentity(4321, 1000);
    try {
      const pending = scall(GLOBAL, "putString", `(${CR}${S}${S})Z`, cr, key, "shared");
      await entered;
      expect(store.get("global", key)).toBeNull();
      release();
      expect(await pending).toBe(1);
      expect(await scall(GLOBAL, "getString", `(${CR}${S})${S}`, cr, key)).toBe("shared");
      const cursor = await vcall(cr, "query", "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
        mkUri(`content://settings/global/${key}`), null, null, null, null);
      expect(await vcall(cursor, "getCount", "()I")).toBe(1);
      expect(await vcall(cursor, "moveToFirst", "()Z")).toBe(1);
      expect(await vcall(cursor, "getString", "(I)Ljava/lang/String;", 2)).toBe("shared");
      await vcall(cursor, "close", "()V");
    } finally {
      release(); client.close(); stop(); useSettingsStore(store); store.put("global", key, null);
      setProcessIdentity(4321, packages.get("org.webdroid.test.settings")!.uid);
    }
  });
  test("Settings reads the device's tables through the provider", async () => {
    expect(await scall(SYSTEM, "getFloat", `(${CR}${S})F`, cr, "font_scale")).toBe(1);
    expect(await scall(SYSTEM, "getInt", `(${CR}${S})I`, cr, "screen_brightness")).toBe(102);
    expect(await thrown(() => scall(SYSTEM, "getInt", `(${CR}${S})I`, cr, "font_scale"))).toBe("android/provider/Settings$SettingNotFoundException: font_scale");
    expect(await scall(GLOBAL, "getString", `(${CR}${S})${S}`, cr, "device_name")).toBe(DEVICE_PROPERTIES["ro.product.model"]);
    expect(await scall(GLOBAL, "getFloat", `(${CR}${S}F)F`, cr, "animator_duration_scale", 0.5)).toBe(0.5);
    const enabled = locationTransport.enabled, available = locationTransport.available;
    try {
      const service = rt.make("webdroid/LocationManagerService");
      locationTransport.available = async () => false;
      expect(await vcall(service, "hasProvider", "(Ljava/lang/String;)Z", "gps")).toBe(0);
      locationTransport.available = async () => true;
      expect(await vcall(service, "hasProvider", "(Ljava/lang/String;)Z", "gps")).toBe(1);
      locationTransport.enabled = async () => false;
      expect(await scall(SECURE, "getInt", `(${CR}${S})I`, cr, "location_mode")).toBe(0);
      locationTransport.enabled = async () => true;
      expect(await scall(SECURE, "getInt", `(${CR}${S})I`, cr, "location_mode")).toBe(3);
    } finally { locationTransport.enabled = enabled; locationTransport.available = available; }
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
    const legacy = await install("org.webdroid.test.settings.legacy", 22, ["android.permission.WRITE_SETTINGS"], 3);
    setProcessIdentity(4321, legacy.uid);
    try {
      const provider = await systemProvider("settings")!;
      const values = await newObj("android/content/ContentValues");
      await vcall(values, "put", `(${S}${S})V`, "name", "screen_off_timeout");
      await vcall(values, "put", `(${S}${S})V`, "value", "60000");
      const uri: JUri = await vcall(provider, "insert", "(Landroid/content/AttributionSource;Landroid/net/Uri;Landroid/content/ContentValues;Landroid/os/Bundle;)Landroid/net/Uri;",
        null, await mkUri("content://settings/system"), values, null);
      expect(await uriText(uri)).toBe("content://settings/system/screen_off_timeout");
      expect(settingsStore().get("system", "screen_off_timeout")).toBe("60000");
    } finally {
      setProcessIdentity(4321, packages.get("org.webdroid.test.settings")!.uid);
      settingsStore().put("system", "screen_off_timeout", "2147483647");
    }
  });

  test("whole-table queries leave out what the caller may not read", async () => {
    const cursor = await vcall(cr, "query", `(Landroid/net/Uri;[${S}${S}[${S}${S})Landroid/database/Cursor;`, await mkUri("content://settings/secure"), null, null, null, null);
    const names: string[] = [];
    while (await vcall(cursor, "moveToNext", "()Z")) names.push(await vcall(cursor, "getString", "(I)Ljava/lang/String;", 1));
    expect(names).toContain("android_id");
    expect(names).toContain("long_press_timeout");
    const config = await mkUri("content://settings/config");
    expect(await thrown(() => vcall(cr, "query", `(Landroid/net/Uri;[${S}${S}[${S}${S})Landroid/database/Cursor;`, config, null, null, null, null)))
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
    const table = await mkUri("content://settings/secure");
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
