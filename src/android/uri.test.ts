import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";
import { importParcel } from "./binder";
import { readUri } from "./net";

test("StringUri wire matches the Android device and survives Parcelable transport", async () => {
  const hex = "010000001f00000068747470733a2f2f666978747572652f61253230623f713d7825323079236600";
  const parcel = importParcel({ bytes: Uint8Array.from(Buffer.from(hex, "hex")), objects: [] }, await newObj("android/os/Parcel"));
  const uri = await readUri(parcel);
  expect(await vcall(uri, "toString", "()Ljava/lang/String;")).toBe("https://fixture/a%20b?q=x%20y#f");
  expect(parcel.pos).toBe(parcel.size);
  const written = await newObj("android/os/Parcel");
  await vcall(uri, "writeToParcel", "(Landroid/os/Parcel;I)V", written, 0);
  expect(Buffer.from(written.buf.subarray(0, written.size)).toString("hex")).toBe(hex);
  const transport = await newObj("android/os/Parcel");
  await vcall(transport, "writeParcelable", "(Landroid/os/Parcelable;I)V", uri, 0);
  transport.pos = 0;
  const copy = await vcall(transport, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
  expect(await vcall(copy, "equals", "(Ljava/lang/Object;)Z", uri)).toBe(1);
});

test("Android 13 URI parts preserve encoding and make hierarchical paths absolute", async () => {
  // Android 13 Uri.java layout; Android 15 writes a single String8 for these private types.
  for (const [expected, hex] of [
    ["https://fixture/a%20b?q%3Dx%20y#f", "03000000050000006874747073000000010000000700000066697874757265000200000003000000612062000200000005000000713d782079000000010000000100000066000000"],
    ["mailto:name%40example.test#fragment", "02000000060000006d61696c746f000002000000110000006e616d65406578616d706c652e746573740000000100000008000000667261676d656e7400000000"],
  ]) {
    const p = importParcel({ bytes: Uint8Array.from(Buffer.from(hex, "hex")), objects: [] }, await newObj("android/os/Parcel"));
    expect(await vcall(await readUri(p), "toString", "()Ljava/lang/String;")).toBe(expected);
    expect(p.pos).toBe(p.size);
  }
  const p = await newObj("android/os/Parcel");
  await vcall(p, "writeInt", "(I)V", 7); p.pos = 0;
  await expect(readUri(p)).rejects.toThrow();
  expect(p.pos).toBe(4);
});
