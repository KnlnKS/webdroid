import { expect, test } from "bun:test";
import "../natives";
import { DexFile } from "./dex";
import { rt } from "./runtime";
import { linkInit, newObj, vcall } from "./natives/jlang";
import { serialize, deserialize } from "./serialization";
import { JParcel } from "../android/parcel";
import { exportParcel, importParcel } from "../android/binder";

test("IPC default serialization preserves cycles and arrays without invoking Java constructors", async () => {
  rt.loadDex(new DexFile(new Uint8Array(await Bun.file(new URL("./fixtures/ipc.dex", import.meta.url)).arrayBuffer())));
  const cls = (await linkInit("webdroid/IpcFixture")).ctor;
  const original = await vcall(cls, "create", "()Lwebdroid/IpcFixture$Payload;");
  const parcel = await newObj("android/os/Parcel");
  await vcall(parcel, "writeSerializable", "(Ljava/io/Serializable;)V", original);
  if (!(parcel instanceof JParcel)) throw new Error("Parcel unavailable");
  const copy = await vcall(importParcel(exportParcel(parcel)), "readSerializable", "()Ljava/io/Serializable;");
  expect(copy).not.toBe(original);
  expect(await vcall(cls, "check", "(Lwebdroid/IpcFixture$Payload;)I", copy)).toBe(127);
  expect(await vcall(cls, "constructions", "()I")).toBe(1);
  expect(await deserialize(serialize(null))).toBeNull();
  expect(() => serialize({ value: "not Java" })).toThrow();
  const custom = await newObj("webdroid/IpcFixture$Custom");
  expect(() => serialize(custom)).toThrow();
});
