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

const pkg = "org.webdroid.test.telephony";
const attr = (name: string, str: string | null, data = 0): XmlAttr => ({ name, str, ns: "", resId: 0, type: str === null ? TV.INT_DEC : TV.STRING, data });
let phone: JObj, subscriptions: JObj;
rt.register({ name: "webdroid/test/CallState", ctor: class extends JObj {}, sup: "android/telephony/TelephonyCallback",
  ifaces: ["android/telephony/TelephonyCallback$CallStateListener"], methods: { "onCallStateChanged(I)V": () => {} } });
rt.register({ name: "webdroid/test/Inline", ctor: class extends JObj {}, ifaces: ["java/util/concurrent/Executor"],
  methods: { "execute(Ljava/lang/Runnable;)V": (r: JObj) => vcall(r, "run", "()V") } });

beforeAll(async () => {
  rt.linkNatives();
  await scall("android/app/ActivityThread", "initializeMainlineModules", "()V");
  const manifest: XmlNode = { name: "manifest", attrs: [attr("package", pkg)], children: [
    { name: "uses-sdk", attrs: [attr("minSdkVersion", null, 21), attr("targetSdkVersion", null, 34)], children: [] },
    { name: "uses-permission", attrs: [attr("name", "android.permission.READ_PHONE_STATE")], children: [] },
    { name: "application", attrs: [], children: [] },
  ] };
  const res = new Resources(null, {});
  packages.set(pkg, new PackageRecord(manifest, res, "/t.apk", packageUid(pkg), async () => []));
  setProcessIdentity(4321, packageUid(pkg));
  const app = new JApplication();
  const host = { pkg, application: app, res, jresources: await appResources(res, pkg), splits: [], themeResId: 0, iconRes: 0, currentActivity: () => null, activities: () => [] } as never;
  Reflect.set(app, "$host", host); setAppHost(host);
  phone = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "phone");
  subscriptions = await vcall(app, "getSystemService", "(Ljava/lang/String;)Ljava/lang/Object;", "telephony_subscription_service");
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
