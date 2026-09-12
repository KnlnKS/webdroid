import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { mangleStaticField } from "../src/jvm/abi";
import { newObj, vcall } from "../src/jvm/natives/jlang";
import { JBitmap } from "../src/android/graphics";

rt.linkNatives();

test("a Bitmap survives a Parcel round trip with its flags, geometry and pixels", async () => {
  const b = JBitmap.create(3, 2);
  b.density = 320; b.hasAlpha = false;
  await vcall(b, "setPixel", "(III)V", 2, 1, 0xff336699 | 0);
  const p = await newObj("android/os/Parcel", "()V");
  await vcall(p, "writeParcelable", "(Landroid/os/Parcelable;I)V", b, 0);
  await vcall(p, "setDataPosition", "(I)V", 0);
  const back: JBitmap = await vcall(p, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
  expect(back).toBeInstanceOf(JBitmap);
  expect(back).not.toBe(b);
  expect([back.w, back.h, back.density, back.hasAlpha]).toEqual([3, 2, 320, false]);
  expect(await vcall(back, "getPixel", "(II)I", 2, 1)).toBe(0xff336699 | 0);
  expect(await vcall(back, "getPixel", "(II)I", 0, 0)).toBe(0);
  const creator = (rt.link("android/graphics/Bitmap").ctor as any)[mangleStaticField("CREATOR")];
  expect(rt.iof(creator, "android/os/Parcelable$Creator")).toBe(1);
});
