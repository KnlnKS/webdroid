import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();

test("WifiManager retains its DHCP and redacted connection state", async () => {
  const wifi = rt.make("android/net/wifi/WifiManager");
  expect(await vcall(wifi, "getDhcpInfo", "()Landroid/net/DhcpInfo;")).not.toBeNull();
  const info = await vcall(wifi, "getConnectionInfo", "()Landroid/net/wifi/WifiInfo;");
  expect(await vcall(info, "getSSID", "()Ljava/lang/String;")).toBe("<unknown ssid>");
});
