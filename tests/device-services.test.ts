import { expect, test, beforeAll, describe } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, scall, staticField, vcall } from "../src/jvm/natives/jlang";
import { JApplication } from "../src/android/app";
import { setAppHost } from "../src/android/apphost";
import { packages, PackageRecord, packageUid } from "../src/android/packages";
import { Resources } from "../src/android/res";
import { TV, type XmlAttr, type XmlNode } from "../src/android/axml";
import { setProcessIdentity } from "../src/android/os";
import { grantPermissions } from "../src/android/context";
import { appResources } from "./java";

const pkg = "org.webdroid.test.services";
const attr = (name: string, str: string | null, data = 0): XmlAttr => ({ name, str, ns: "", resId: 0, type: str === null ? TV.INT_DEC : TV.STRING, data });
let app: JApplication, phone: JObj, subscriptions: JObj, wifi: JObj;
rt.register({ name: "webdroid/test/CallState", ctor: class extends JObj {}, sup: "android/telephony/TelephonyCallback",
  ifaces: ["android/telephony/TelephonyCallback$CallStateListener"], methods: { "onCallStateChanged(I)V": () => {} } });
rt.register({ name: "webdroid/test/Inline", ctor: class extends JObj {}, ifaces: ["java/util/concurrent/Executor"],
  methods: { "execute(Ljava/lang/Runnable;)V": (r: JObj) => vcall(r, "run", "()V") } });

beforeAll(async () => {
  rt.linkNatives();
  await scall("android/app/ActivityThread", "initializeMainlineModules", "()V");
  const manifest: XmlNode = { name: "manifest", attrs: [attr("package", pkg)], children: [
    { name: "uses-sdk", attrs: [attr("minSdkVersion", null, 21), attr("targetSdkVersion", null, 34)], children: [] },
    ...["READ_PHONE_STATE", "ACCESS_WIFI_STATE", "WAKE_LOCK"].map((name) => ({ name: "uses-permission", attrs: [attr("name", "android.permission." + name)], children: [] })),
    { name: "application", attrs: [], children: [] },
  ] };
  const res = new Resources(null, {});
  packages.set(pkg, new PackageRecord(manifest, res, "/t.apk", packageUid(pkg), async () => []));
  setProcessIdentity(4321, packageUid(pkg));
  app = new JApplication();
  const host = { pkg, application: app, res, jresources: await appResources(res, pkg), splits: [], themeResId: 0, iconRes: 0, currentActivity: () => null, activities: () => [] } as never;
  Reflect.set(app, "$host", host); setAppHost(host);
  phone = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "phone");
  subscriptions = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "telephony_subscription_service");
  wifi = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "wifi");
});

describe("telephony", () => {
  test("a device without telephony has no operator, number, call or subscription", async () => {
    expect(await vcall(phone, "getPhoneType", "()I")).toBe(0);
    expect(await vcall(phone, "getNetworkOperatorName", "()Ljava/lang/String;")).toBe("");
    expect(await vcall(phone, "getSimCountryIso", "()Ljava/lang/String;")).toBe("");
    expect(await vcall(phone, "getLine1Number", "()Ljava/lang/String;")).toBeNull();
    expect(await vcall(phone, "getCallState", "()I")).toBe(0);
    expect(await vcall(subscriptions, "getActiveSubscriptionInfoCount", "()I")).toBe(0);
  });

  test("a call-state callback needs READ_PHONE_STATE after R", async () => {
    const register = async () => vcall(phone, "registerTelephonyCallback", "(Ljava/util/concurrent/Executor;Landroid/telephony/TelephonyCallback;)V",
      await newObj("webdroid/test/Inline"), await newObj("webdroid/test/CallState"));
    const thrown = await register().then(() => null, (e: { constructor: { $i?: { name: string } } }) => e.constructor.$i?.name);
    expect(thrown).toBe("java/lang/SecurityException");
    grantPermissions(["android.permission.READ_PHONE_STATE"]);
    await register();
  });
});

describe("wifi", () => {
  test("the page's network is the connected Wi-Fi network, its identity redacted without location", async () => {
    expect(await vcall(wifi, "isWifiEnabled", "()Z")).toBe(1);
    const info = await vcall(wifi, "getConnectionInfo", "()Landroid/net/wifi/WifiInfo;");
    expect(await vcall(info, "getSSID", "()Ljava/lang/String;")).toBe("<unknown ssid>");
    expect(await vcall(info, "getBSSID", "()Ljava/lang/String;")).toBe("02:00:00:00:00:00");
    expect(await vcall(info, "getRssi", "()I")).toBe(-50);
    expect(await vcall(await vcall(info, "getSupplicantState", "()Landroid/net/wifi/SupplicantState;"), "name", "()Ljava/lang/String;")).toBe("COMPLETED");
    expect(await vcall(await vcall(wifi, "getScanResults", "()Ljava/util/List;"), "size", "()I")).toBe(0);
  });

  test("a Wi-Fi lock is held between acquire and release", async () => {
    const lock = await vcall(wifi, "createWifiLock", "(ILjava/lang/String;)Landroid/net/wifi/WifiManager$WifiLock;", 3, "test");
    await vcall(lock, "acquire", "()V");
    expect(await vcall(lock, "isHeld", "()Z")).toBe(1);
    await vcall(lock, "release", "()V");
    expect(await vcall(lock, "isHeld", "()Z")).toBe(0);
  });
});

describe("radios this device lacks", () => {
  test("Bluetooth and NFC managers exist and report no adapter", async () => {
    const service = (name: string) => vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", name);
    expect(await vcall(await service("bluetooth"), "getAdapter", "()Landroid/bluetooth/BluetoothAdapter;")).toBeNull();
    expect(await scall("android/bluetooth/BluetoothAdapter", "getDefaultAdapter", "()Landroid/bluetooth/BluetoothAdapter;")).toBeNull();
    expect(await vcall(await service("nfc"), "getDefaultAdapter", "()Landroid/nfc/NfcAdapter;")).toBeNull();
  });
});

describe("app widgets", () => {
  test("no host binds a widget: ids are empty and the package's providers are listed", async () => {
    const widgets = await scall("android/appwidget/AppWidgetManager", "getInstance", "(Landroid/content/Context;)Landroid/appwidget/AppWidgetManager;", app);
    const provider = await newObj("android/content/ComponentName", "(Ljava/lang/String;Ljava/lang/String;)V", pkg, pkg + ".Widget");
    expect([...await vcall(widgets, "getAppWidgetIds", "(Landroid/content/ComponentName;)[I", provider)]).toEqual([]);
    expect(await vcall(await vcall(widgets, "getInstalledProviders", "()Ljava/util/List;"), "size", "()I")).toBe(0);
    expect(await vcall(widgets, "isRequestPinAppWidgetSupported", "()Z")).toBe(0);
  });
});

describe("system health", () => {
  test("a uid snapshot holds no usage, and another uid's needs BATTERY_STATS", async () => {
    const health = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "systemhealth");
    const stats = await vcall(health, "takeMyUidSnapshot", "()Landroid/os/health/HealthStats;");
    expect(await vcall(stats, "getDataType", "()Ljava/lang/String;")).toBe("UidHealthStats");
    expect(await vcall(stats, "getMeasurementKeyCount", "()I")).toBe(0);
    const thrown = await vcall(health, "takeUidSnapshot", "(I)Landroid/os/health/HealthStats;", 1000)
      .then(() => null, (e: { constructor: { $i?: { name: string } } }) => e.constructor.$i?.name);
    expect(thrown).toBe("java/lang/SecurityException");
  });
});

describe("storage stats", () => {
  test("an app reads its own package's stats, and the user's need PACKAGE_USAGE_STATS", async () => {
    const stats = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "storagestats");
    const user = await scall("android/os/Process", "myUserHandle", "()Landroid/os/UserHandle;");
    const own = await vcall(stats, "queryStatsForPackage", "(Ljava/util/UUID;Ljava/lang/String;Landroid/os/UserHandle;)Landroid/app/usage/StorageStats;",
      await staticField("android/os/storage/StorageManager", "UUID_DEFAULT"), pkg, user);
    expect(typeof await vcall(own, "getDataBytes", "()J")).toBe("bigint");
    const thrown = await vcall(stats, "queryStatsForUser", "(Ljava/util/UUID;Landroid/os/UserHandle;)Landroid/app/usage/StorageStats;",
      await staticField("android/os/storage/StorageManager", "UUID_DEFAULT"), user).then(() => null, (e: { constructor: { $i?: { name: string } } }) => e.constructor.$i?.name);
    expect(thrown).toBe("java/lang/SecurityException");
  });
});

describe("media metrics", () => {
  test("a playback session carries a fresh URL-safe session id", async () => {
    const metrics = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "media_metrics");
    const session = await vcall(metrics, "createPlaybackSession", "()Landroid/media/metrics/PlaybackSession;");
    const id: string = await vcall(await vcall(session, "getSessionId", "()Landroid/media/metrics/LogSessionId;"), "getStringId", "()Ljava/lang/String;");
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    await vcall(session, "close", "()V");
  });
});

describe("device policy", () => {
  test("no admin or owner is in force", async () => {
    const policy = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "device_policy");
    const admin = await newObj("android/content/ComponentName", "(Ljava/lang/String;Ljava/lang/String;)V", pkg, pkg + ".Admin");
    expect(await vcall(policy, "isAdminActive", "(Landroid/content/ComponentName;)Z", admin)).toBe(0);
    expect(await vcall(await vcall(policy, "getActiveAdmins", "()Ljava/util/List;"), "size", "()I")).toBe(0);
    expect(await vcall(policy, "isDeviceOwnerApp", "(Ljava/lang/String;)Z", pkg)).toBe(0);
    expect(await vcall(policy, "getCameraDisabled", "(Landroid/content/ComponentName;)Z", null)).toBe(0);
  });
});

describe("permission controller", () => {
  test("no PermissionController package is installed, so its manager cannot be made", async () => {
    const thrown = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "permission_controller")
      .then(() => null, (e: { constructor: { $i?: { name: string } } }) => e.constructor.$i?.name);
    expect(thrown).toBe("java/lang/IllegalStateException");
  });
});

describe("network stats", () => {
  test("no traffic is recorded: a summary has no buckets", async () => {
    const manager = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "netstats");
    const stats = await vcall(manager, "querySummary", "(ILjava/lang/String;JJ)Landroid/app/usage/NetworkStats;", 1, null, 0n, 1n);
    expect(await vcall(stats, "hasNextBucket", "()Z")).toBe(0);
    await vcall(stats, "close", "()V");
  });
});

describe("performance hints", () => {
  test("sessions are created at the AVD's preferred rate and keep their threads", async () => {
    const hints = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "performance_hint");
    expect(await vcall(hints, "getPreferredUpdateRateNanos", "()J")).toBe(1_000_000n);
    const session = await vcall(hints, "createHintSession", "([IJ)Landroid/os/PerformanceHintManager$Session;", Int32Array.of(7), 16_000_000n);
    expect([...await vcall(session, "getThreadIds", "()[I")]).toEqual([7]);
    await vcall(session, "close", "()V");
  });
});
