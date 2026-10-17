import { expect, test, beforeAll, describe } from "vite-plus/test";
import "../src/natives.ts";
import { rt, JObj, getDeclared } from "../src/jvm/runtime.ts";
import { classNameOf, newObj, scall, staticField, vcall } from "../src/jvm/natives/jentry.ts";
import { packageUid } from "../src/android/packages.ts";
import { grantPermissions } from "../src/android/permissions.ts";
import { bootApp, packageRecord, thrown } from "./java.ts";
import { vfs } from "../src/shell/vfs.ts";
import { procIdentity } from "../src/shell/procfs.ts";

const pkg = "org.webdroid.test.services";
let app: JObj, phone: JObj, subscriptions: JObj, wifi: JObj;
const outcomes: ((value: string) => void)[] = [];
rt.register({ name: "webdroid/test/Outcome", ctor: class extends JObj {}, ifaces: ["android/os/OutcomeReceiver"], methods: {
  "onResult(Ljava/lang/Object;)V": (value: unknown) => outcomes.shift()?.(`result ${value}`),
  "onError(Ljava/lang/Throwable;)V": (error: { msg?: string }) => outcomes.shift()?.(`${classNameOf(error)}: ${error.msg}`),
} });
rt.register({ name: "webdroid/test/CallState", ctor: class extends JObj {}, sup: "android/telephony/TelephonyCallback",
  ifaces: ["android/telephony/TelephonyCallback$CallStateListener"], methods: { "onCallStateChanged(I)V": () => {} } });
rt.register({ name: "webdroid/test/DiscoveryListener", ctor: class extends JObj {}, ifaces: ["android/net/nsd/NsdManager$DiscoveryListener"],
  methods: { "onStartDiscoveryFailed(Ljava/lang/String;I)V": (type: string, code: number) => outcomes.shift()?.(`failed ${type} ${code}`) } });
rt.register({ name: "webdroid/test/Inline", ctor: class extends JObj {}, ifaces: ["java/util/concurrent/Executor"],
  methods: { "execute(Ljava/lang/Runnable;)V": (r: JObj) => vcall(r, "run", "()V") } });

beforeAll(async () => {
  app = await bootApp(await packageRecord(pkg, { target: 34, permissions: ["READ_PHONE_STATE", "ACCESS_WIFI_STATE", "WAKE_LOCK"].map((name) => "android.permission." + name) }));
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
    expect(await thrown(register)).toMatch(/^java\/lang\/SecurityException/);
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

describe("fonts", () => {
  test("FontManager exists and its configuration needs UPDATE_FONTS", async () => {
    const fonts = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "font");
    expect(fonts).not.toBeNull();
    expect(await thrown(() => vcall(fonts, "getFontConfig", "()Landroid/text/FontConfig;"))).toMatch(/^java\/lang\/SecurityException/);
  });
});

describe("system health", () => {
  test("a uid snapshot holds no usage, and another uid's needs BATTERY_STATS", async () => {
    const health = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "systemhealth");
    const stats = await vcall(health, "takeMyUidSnapshot", "()Landroid/os/health/HealthStats;");
    expect(await vcall(stats, "getDataType", "()Ljava/lang/String;")).toBe("UidHealthStats");
    expect(await vcall(stats, "getMeasurementKeyCount", "()I")).toBe(0);
    expect(await thrown(() => vcall(health, "takeUidSnapshot", "(I)Landroid/os/health/HealthStats;", 1000)))
      .toBe(`java/lang/SecurityException: Neither user ${packageUid(pkg)} nor current process has android.permission.BATTERY_STATS.`);
  });
});

describe("storage stats", () => {
  test("StorageManager repairs existing external app ownership through the canonical mount alias", async () => {
    const root = `/sdcard/Android/data/${pkg}`, dir = root + "/files", file = dir + "/owned.bin", sibling = root + "/cache/untouched.bin";
    for (const path of [root,dir,root+"/cache"]) vfs.mkdir(path);
    for (const path of [file,sibling]) vfs.write(path,Uint8Array.of(9));
    for (const path of [root,dir,file,sibling]) vfs.setAttributes(path,{uid:0,gid:0,mode:0o700});
    const opened = vfs.open(file)!, previousUid = procIdentity.uid;
    try {
      const storage = await vcall(app,"getSystemService","(Ljava/lang/String;)Ljava/lang/Object;","storage");
      const directory = await newObj("java/io/File","(Ljava/lang/String;)V",dir);
      expect(await vcall(directory,"getCanonicalPath","()Ljava/lang/String;")).toBe(`/storage/emulated/0/Android/data/${pkg}/files`);
      await vcall(storage,"fixupAppDir","(Ljava/io/File;)V",directory);
      expect(opened.attributes).toEqual({uid:packageUid(pkg),gid:1078,mode:0o2770});
      expect(vfs.attributes(root,true)).toEqual(opened.attributes!);
      expect(vfs.attributes(sibling)).toEqual({uid:0,gid:0,mode:0o700});
      procIdentity.uid = 0;
      const stat = await scall("android/system/Os","stat","(Ljava/lang/String;)Landroid/system/StructStat;",file);
      expect(["st_uid","st_gid","st_mode"].map(name=>getDeclared(stat,"android/system/StructStat",name))).toEqual([packageUid(pkg),1078,0o102770]);
      const missing = dir + "/missing";
      await vcall(storage,"fixupAppDir","(Ljava/io/File;)V",await newObj("java/io/File","(Ljava/lang/String;)V",missing));
      expect(vfs.exists(missing)).toBe(false);
      procIdentity.uid = packageUid(pkg);
      await scall("android/system/Os","chmod","(Ljava/lang/String;I)V",file,0o640);
      expect(opened.attributes).toEqual({uid:packageUid(pkg),gid:1078,mode:0o640});
    } finally {
      procIdentity.uid = previousUid;
      for (const path of [file,sibling]) vfs.delete(path);
      for (const path of [dir,root+"/cache",root]) vfs.rmdir(path);
    }
  });
  test("an app reads its own package's stats, and the user's need PACKAGE_USAGE_STATS", async () => {
    const stats = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "storagestats");
    const user = await scall("android/os/Process", "myUserHandle", "()Landroid/os/UserHandle;");
    const own = await vcall(stats, "queryStatsForPackage", "(Ljava/util/UUID;Ljava/lang/String;Landroid/os/UserHandle;)Landroid/app/usage/StorageStats;",
      await staticField("android/os/storage/StorageManager", "UUID_DEFAULT"), pkg, user);
    expect(typeof await vcall(own, "getDataBytes", "()J")).toBe("bigint");
    const uuid = await staticField("android/os/storage/StorageManager", "UUID_DEFAULT");
    expect(await thrown(() => vcall(stats, "queryStatsForUser", "(Ljava/util/UUID;Landroid/os/UserHandle;)Landroid/app/usage/StorageStats;", uuid, user)))
      .toMatch(/^java\/lang\/SecurityException: Caller does not have android.permission.PACKAGE_USAGE_STATS/);
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
    expect(await thrown(() => vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "permission_controller")))
      .toMatch(/^java\/lang\/IllegalStateException/);
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

describe("camera", () => {
  test("cameraserver is disabled: no camera is listed and none has characteristics", async () => {
    const camera = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "camera");
    expect(await vcall(camera, "getCameraIdList", "()[Ljava/lang/String;")).toHaveLength(0);
    expect(await thrown(() => vcall(camera, "getCameraCharacteristics", "(Ljava/lang/String;)Landroid/hardware/camera2/CameraCharacteristics;", "0")))
      .toBe("java/lang/IllegalArgumentException: No cameras available on device");
  });
});

describe("measurement", () => {
  test("no AdServices package is installed, so a measurement call fails on the receiver", async () => {
    const measurement = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "measurement_service");
    const outcome = new Promise<string>((resolve) => { outcomes.push(resolve); });
    await vcall(measurement, "registerTrigger", "(Landroid/net/Uri;Ljava/util/concurrent/Executor;Landroid/os/OutcomeReceiver;)V",
      await scall("android/net/Uri", "parse", "(Ljava/lang/String;)Landroid/net/Uri;", "https://example.com/trigger"),
      await newObj("webdroid/test/Inline"), await newObj("webdroid/test/Outcome"));
    expect(await outcome).toBe("java/lang/IllegalStateException: Unable to find the service");
  });
});

describe("media router", () => {
  test("the only route is MediaRouter's own default, selected for live audio", async () => {
    const router = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "media_router");
    expect(await vcall(router, "getRouteCount", "()I")).toBe(1);
    const route = await vcall(router, "getSelectedRoute", "(I)Landroid/media/MediaRouter$RouteInfo;", 1);
    expect(route).toBe(await vcall(router, "getDefaultRoute", "()Landroid/media/MediaRouter$RouteInfo;"));
    expect(await vcall(route, "getPresentationDisplay", "()Landroid/view/Display;")).toBeNull();
  });
});

describe("captioning", () => {
  test("captions follow Settings.Secure: off, at normal scale, in the default style", async () => {
    const captioning = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "captioning");
    expect(await vcall(captioning, "isEnabled", "()Z")).toBe(0);
    expect(await vcall(captioning, "getFontScale", "()F")).toBe(1);
    expect(await vcall(captioning, "getUserStyle", "()Landroid/view/accessibility/CaptioningManager$CaptionStyle;"))
      .toBe(await staticField("android/view/accessibility/CaptioningManager$CaptionStyle", "DEFAULT"));
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

describe("network service discovery", () => {
  test("multicast discovery is unavailable, reported without fabricated services", async () => {
    const nsd = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "servicediscovery");
    const outcome = new Promise<string>((resolve) => { outcomes.push(resolve); });
    await vcall(nsd, "discoverServices", "(Ljava/lang/String;ILandroid/net/nsd/NsdManager$DiscoveryListener;)V",
      "_googlecast._tcp.", 1, await newObj("webdroid/test/DiscoveryListener"));
    expect(await outcome).toBe("failed _googlecast._tcp. 0");
  });
});
