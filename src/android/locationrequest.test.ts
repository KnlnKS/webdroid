import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";

test("LocationRequest builder snapshots values, clamps minimum intervals and rejects invalid requests", async () => {
  const builder = await newObj("android/location/LocationRequest$Builder", "(J)V", 1000n);
  await vcall(builder, "setMinUpdateIntervalMillis", "(J)Landroid/location/LocationRequest$Builder;", 2000n);
  const first = await vcall(builder, "build", "()Landroid/location/LocationRequest;");
  await vcall(builder, "setIntervalMillis", "(J)Landroid/location/LocationRequest$Builder;", 3000n);
  expect(await vcall(first, "getIntervalMillis", "()J")).toBe(1000n);
  expect(await vcall(first, "getMinUpdateIntervalMillis", "()J")).toBe(1000n);
  const parcel = await newObj("android/os/Parcel");
  await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", first, 0);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  const decoded = await vcall(parcel, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
  expect(await vcall(decoded, "getIntervalMillis", "()J")).toBe(1000n);
  expect(await vcall(decoded, "getMinUpdateIntervalMillis", "()J")).toBe(1000n);
  expect(await vcall(decoded, "getQuality", "()I")).toBe(102);
  for (const [name, d, value] of [["Quality", "I", 101], ["DurationMillis", "J", 0n], ["MaxUpdates", "I", 0], ["MinUpdateDistanceMeters", "F", NaN]] as const)
    await expect(vcall(builder, "set" + name, `(${d})Landroid/location/LocationRequest$Builder;`, value)).rejects.toBeTruthy();
  const passive = await newObj("android/location/LocationRequest$Builder", "(J)V", 0x7fffffffffffffffn);
  await expect(vcall(passive, "build", "()Landroid/location/LocationRequest;")).rejects.toBeTruthy();
});
