import { expect, test } from "bun:test";
import "../natives";
import { newObj, vcall } from "../jvm/natives/jlang";

test("WorkSource retains sorted attribution, chains and copy isolation through Parcel", async () => {
  const source = await newObj("android/os/WorkSource");
  for (const [uid, name] of [[20, "z"], [10, "a"], [20, "b"]])
    expect(await vcall(source, "add", "(ILjava/lang/String;)Z", uid, name)).toBe(1);
  expect(await vcall(source, "add", "(ILjava/lang/String;)Z", 20, "b")).toBe(0);
  expect(await vcall(source, "getUid", "(I)I", 0)).toBe(10);
  expect(await vcall(source, "getPackageName", "(I)Ljava/lang/String;", 1)).toBe("b");
  await expect(vcall(source, "add", "(I)Z", 30)).rejects.toBeTruthy();
  const chain = await vcall(source, "createWorkChain", "()Landroid/os/WorkSource$WorkChain;");
  await vcall(chain, "addNode", "(ILjava/lang/String;)Landroid/os/WorkSource$WorkChain;", 10, "caller");
  const parcel = await newObj("android/os/Parcel");
  await vcall(parcel, "writeParcelable", "(Landroid/os/Parcelable;I)V", source, 0);
  await vcall(parcel, "writeInt", "(I)V", 1234);
  await vcall(parcel, "setDataPosition", "(I)V", 0);
  const decoded = await vcall(parcel, "readParcelable", "(Ljava/lang/ClassLoader;)Landroid/os/Parcelable;", null);
  expect(await vcall(decoded, "equals", "(Ljava/lang/Object;)Z", source)).toBe(1);
  expect(await vcall(decoded, "hashCode", "()I")).toBe(await vcall(source, "hashCode", "()I"));
  expect(await vcall(parcel, "readInt", "()I")).toBe(1234);
  const copy = await newObj("android/os/WorkSource", "(Landroid/os/WorkSource;)V", decoded);
  expect(await vcall(copy, "add", "(Landroid/os/WorkSource;)Z", source)).toBe(0);
  await vcall(chain, "addNode", "(ILjava/lang/String;)Landroid/os/WorkSource$WorkChain;", 20, "service");
  expect(await vcall(copy, "equals", "(Ljava/lang/Object;)Z", source)).toBe(0);
  expect(await vcall(copy, "remove", "(Landroid/os/WorkSource;)Z", decoded)).toBe(1);
  expect(await vcall(copy, "isEmpty", "()Z")).toBe(1);
  expect(await vcall(source, "size", "()I")).toBe(3);
});
