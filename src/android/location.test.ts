import { expect, test } from "bun:test";
import "../natives";
import { rt } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { mangleStaticField } from "../jvm/abi";

const required = "070000006e6574776f726b00000000007b68e5cf8b010000cb04fb711f0100000000000000c042400000000000905ec0ffffffff";
const full = "070000006e6574776f726b00ff0100007b68e5cf8b010000cb04fb711f01000000000000008031400000000000c042400000000000905ec00000000000d05e400000c03f0000874300008840000020400000803e00006040ffffffff";

test("Location reads and writes Android 13 reference parcels without losing optional fields", async () => {
  const creator = rt.link("android/location/Location").ctor[mangleStaticField("CREATOR")];
  for (const [wire, hasOptional] of [[required, 0], [full, 1]] as const) {
    const parcel = await newObj("android/os/Parcel"), bytes = new Int8Array(Buffer.from(wire, "hex"));
    await vcall(parcel, "unmarshall", "([BII)V", bytes, 0, bytes.length);
    const location = await vcall(creator, "createFromParcel", "(Landroid/os/Parcel;)Ljava/lang/Object;", parcel);
    expect(await vcall(location, "getProvider", "()Ljava/lang/String;")).toBe("network");
    expect(await vcall(location, "getLatitude", "()D")).toBe(37.5);
    expect(await vcall(location, "getLongitude", "()D")).toBe(-122.25);
    expect(await vcall(location, "getTime", "()J")).toBe(1700000000123n);
    expect(await vcall(location, "getElapsedRealtimeNanos", "()J")).toBe(1234567890123n);
    for (const name of ["Altitude", "Speed", "Bearing", "Accuracy", "VerticalAccuracy", "SpeedAccuracy", "BearingAccuracy", "ElapsedRealtimeUncertaintyNanos"])
      expect(await vcall(location, "has" + name, "()Z")).toBe(hasOptional);
    expect(await vcall(location, "isMock", "()Z")).toBe(hasOptional);
    expect(await vcall(parcel, "dataAvail", "()I")).toBe(0);
    const output = await newObj("android/os/Parcel");
    await vcall(location, "writeToParcel", "(Landroid/os/Parcel;I)V", output, 0);
    expect(Buffer.from(await vcall(output, "marshall", "()[B")).toString("hex")).toBe(wire);
  }
});

test("Location copies isolate optional fields and extras and normalize bearings", async () => {
  const location = await newObj("android/location/Location", "(Ljava/lang/String;)V", "network");
  await vcall(location, "setBearing", "(F)V", -90);
  expect(await vcall(location, "getBearing", "()F")).toBe(270);
  const extras = await newObj("android/os/Bundle");
  await vcall(extras, "putInt", "(Ljava/lang/String;I)V", "satellites", 3);
  await vcall(location, "setExtras", "(Landroid/os/Bundle;)V", extras);
  await vcall(extras, "putInt", "(Ljava/lang/String;I)V", "satellites", 4);
  const copy = await newObj("android/location/Location", "(Landroid/location/Location;)V", location);
  await vcall(location, "removeBearing", "()V");
  const copiedExtras = await vcall(copy, "getExtras", "()Landroid/os/Bundle;");
  expect(await vcall(copiedExtras, "getInt", "(Ljava/lang/String;)I", "satellites")).toBe(3);
  await vcall(copiedExtras, "putInt", "(Ljava/lang/String;I)V", "satellites", 5);
  const originalExtras = await vcall(location, "getExtras", "()Landroid/os/Bundle;");
  expect(await vcall(originalExtras, "getInt", "(Ljava/lang/String;)I", "satellites")).toBe(3);
  expect(await vcall(copy, "hasBearing", "()Z")).toBe(1);
  expect(await vcall(location, "hasBearing", "()Z")).toBe(0);
  await vcall(copy, "reset", "()V");
  expect(await vcall(copy, "getProvider", "()Ljava/lang/String;")).toBeNull();
  expect(await vcall(copy, "getExtras", "()Landroid/os/Bundle;")).toBeNull();
  expect(await vcall(copy, "hasBearing", "()Z")).toBe(0);
  await expect(vcall(location, "setBearing", "(F)V", Infinity)).rejects.toBeTruthy();
});
