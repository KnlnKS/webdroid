import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { mkUri } from "../src/android/net";
rt.linkNatives();

test("IntentFilter requires a matching authority before applying decoded path patterns", async () => {
  const filter = await newObj("android/content/IntentFilter");
  await vcall(filter, "addDataScheme", "(Ljava/lang/String;)V", "https");
  await vcall(filter, "addDataAuthority", "(Ljava/lang/String;Ljava/lang/String;)V", "*.example.com", "443");
  await vcall(filter, "addDataPath", "(Ljava/lang/String;I)V", "/place/.*", 2);
  const match = (uri: string) => vcall(filter, "matchData", "(Ljava/lang/String;Ljava/lang/String;Landroid/net/Uri;)I", null, "https", mkUri(uri));
  expect(await match("https://a.example.com:443/place/a%20b")).toBe(0x508000);
  expect(await match("https://a.example.com:442/place/a")).toBe(-2);
  expect(await match("https://elsewhere.test:443/place/a")).toBe(-2);
  expect(await match("https://a.example.com:443/other")).toBe(-2);
});

test("IntentFilter parcels retain data matching and Android field order", async () => {
  const filter = await newObj("android/content/IntentFilter", "(Ljava/lang/String;)V", "test.action");
  await vcall(filter, "addCategory", "(Ljava/lang/String;)V", "test.category");
  await vcall(filter, "addDataScheme", "(Ljava/lang/String;)V", "https");
  await vcall(filter, "addDataAuthority", "(Ljava/lang/String;Ljava/lang/String;)V", "*.example.com", null);
  await vcall(filter, "addDataPath", "(Ljava/lang/String;I)V", "/place/", 1);
  await vcall(filter, "setPriority", "(I)V", 17);
  const parcel = await newObj("android/os/Parcel");
  await vcall(filter, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, 0);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  expect(await vcall(parcel, "createStringArray", "()[Ljava/lang/String;")).toEqual(["test.action"]);
  expect(await vcall(parcel, "readInt", "()I")).toBe(1);
  expect(await vcall(parcel, "createStringArray", "()[Ljava/lang/String;")).toEqual(["test.category"]);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  const restored = await vcall(rt.link("android/content/IntentFilter").ctor.s$CREATOR, "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", parcel);
  expect(await vcall(restored, "getPriority", "()I")).toBe(17);
  expect(await vcall(restored, "matchData", "(Ljava/lang/String;Ljava/lang/String;Landroid/net/Uri;)I", null, "https", mkUri("https://a.example.com/place/a"))).toBe(0x508000);
  expect(await vcall(parcel, "dataAvail", "()I")).toBe(0);
});
