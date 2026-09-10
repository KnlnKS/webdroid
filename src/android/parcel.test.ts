import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";

test("String8 matches Android 13 bytes, including modified NUL and unpaired surrogates", async () => {
  const parcel = await newObj("android/os/Parcel");
  const values = [null, "", "gps", "réseau🌍", "a\0b", "\ud800"];
  for (const value of values) await vcall(parcel, "writeString8", "(Ljava/lang/String;)V", value);
  await vcall(parcel, "writeInt", "(I)V", 0x12345678);
  const bytes: Int8Array = await vcall(parcel, "marshall", "()[B");
  expect(Buffer.from(bytes).toString("hex")).toBe("ffffffff000000000000000003000000677073000b00000072c3a973656175f09f8c8d000400000061c080620000000003000000eda0800078563412");
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  for (const value of values) expect(await vcall(parcel, "readString8", "()Ljava/lang/String;")).toBe(value);
  expect(await vcall(parcel, "readInt", "()I")).toBe(0x12345678);
  expect(await vcall(parcel, "dataAvail", "()I")).toBe(0);
});
