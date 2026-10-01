import { expect, test, beforeAll, describe } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, scall, vcall } from "../src/jvm/natives/jlang";
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
