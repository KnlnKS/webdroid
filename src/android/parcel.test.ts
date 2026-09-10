import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";

test("Bundle lengths exclude the magic word and empty bundles consume one word", async () => {
  const empty = await newObj("android/os/Bundle"), p = await newObj("android/os/Parcel");
  await vcall(p, "writeBundle", "(Landroid/os/Bundle;)V", null);
  await vcall(p, "writeBundle", "(Landroid/os/Bundle;)V", empty);
  await vcall(p, "writeInt", "(I)V", 0x12345678);
  expect(Buffer.from(p.buf.subarray(0, p.size)).toString("hex")).toBe("ffffffff0000000078563412");
  p.pos = 0;
  expect(await vcall(p, "readBundle", "()Landroid/os/Bundle;")).toBeNull();
  expect((await vcall(p, "readBundle", "()Landroid/os/Bundle;")).map.size).toBe(0);
  expect(await vcall(p, "readInt", "()I")).toBe(0x12345678);
  const b = await newObj("android/os/Bundle"), written = await newObj("android/os/Parcel");
  await vcall(b, "putInt", "(Ljava/lang/String;I)V", "k", 7);
  await vcall(written, "writeBundle", "(Landroid/os/Bundle;)V", b);
  expect(Buffer.from(written.buf.subarray(0, written.size)).toString("hex")).toBe("14000000424e444c01000000010000006b0000000100000007000000");
});

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
