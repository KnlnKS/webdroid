import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { mangleMethod } from "../src/jvm/abi";
rt.linkNatives();

const signalLevel = (rssi: number, levels: number) =>
  (rt.link("android/net/wifi/WifiManager").ctor as unknown as Record<string, (rssi: number, levels: number) => number>)[
    mangleMethod("calculateSignalLevel", "(II)I")
  ](rssi, levels);

test("WifiManager retains its DHCP and redacted connection state", async () => {
  const wifi = rt.make("android/net/wifi/WifiManager");
  expect(await vcall(wifi, "getDhcpInfo", "()Landroid/net/DhcpInfo;")).not.toBeNull();
  const info = await vcall(wifi, "getConnectionInfo", "()Landroid/net/wifi/WifiInfo;");
  expect(await vcall(info, "getSSID", "()Ljava/lang/String;")).toBe("<unknown ssid>");
});

test("WifiManager clamps and truncates signal levels like Android", () => {
  expect(signalLevel(-101, 5)).toBe(0);
  expect(signalLevel(-100, 5)).toBe(0);
  expect(signalLevel(-89, 5)).toBe(0);
  expect(signalLevel(-77, 5)).toBe(2);
  expect(signalLevel(-56, 5)).toBe(3);
  expect(signalLevel(-55, 5)).toBe(4);
  expect(signalLevel(-54, 5)).toBe(4);
  expect(signalLevel(-77, 9)).toBe(4);
  expect(signalLevel(-77, 1)).toBe(0);
});
