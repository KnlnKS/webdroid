import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleMethod } from "../src/jvm/abi";
import { locationTransport } from "../src/android/locationmanager";

rt.linkNatives();
const scall = (cls: string, name: string, desc: string, ...args: unknown[]) => (rt.link(cls).ctor as any)[mangleMethod(name, desc)](...args);
const CR = "Landroid/content/ContentResolver;";

test("Settings.Secure reports the device's location switch", () => {
  const enabled = locationTransport.enabled;
  try {
    locationTransport.enabled = () => false;
    expect(scall("android/provider/Settings$Secure", "getInt", `(${CR}Ljava/lang/String;)I`, null, "location_mode")).toBe(0);
    expect(scall("android/provider/Settings$Secure", "getString", `(${CR}Ljava/lang/String;)Ljava/lang/String;`, null, "location_providers_allowed")).toBe("");
    locationTransport.enabled = () => true;
    expect(scall("android/provider/Settings$Secure", "getInt", `(${CR}Ljava/lang/String;)I`, null, "location_mode")).toBe(3);
    expect(scall("android/provider/Settings$Secure", "getInt", `(${CR}Ljava/lang/String;I)I`, null, "location_mode", 7)).toBe(3);
    expect(scall("android/provider/Settings$Secure", "getString", `(${CR}Ljava/lang/String;)Ljava/lang/String;`, null, "location_providers_allowed")).toBe("gps,network");
    expect(() => scall("android/provider/Settings$Secure", "getInt", `(${CR}Ljava/lang/String;)I`, null, "no_such_setting")).toThrow();
    expect(scall("android/provider/Settings$Global", "getInt", `(${CR}Ljava/lang/String;I)I`, null, "location_mode", 7)).toBe(7);
  } finally { locationTransport.enabled = enabled; }
});
