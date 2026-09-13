import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
rt.linkNatives();

test("StatsEvent encodes typed fields and annotations and reports invalid atom order", async () => {
  const builder = await vcall(rt.link("android/util/StatsEvent").ctor, "newBuilder", "()Landroid/util/StatsEvent$Builder;");
  await vcall(builder, "setAtomId", "(I)Landroid/util/StatsEvent$Builder;", 42);
  await vcall(builder, "writeInt", "(I)Landroid/util/StatsEvent$Builder;", -1);
  await vcall(builder, "addBooleanAnnotation", "(BZ)Landroid/util/StatsEvent$Builder;", 3, 1);
  const event = await vcall(builder, "build", "()Landroid/util/StatsEvent;");
  const bytes: Int8Array = await vcall(event, "getBytes", "()[B");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect([...bytes.slice(0, 3)]).toEqual([7, 3, 1]);
  expect(view.getInt32(12, true)).toBe(42);
  expect(bytes[16]).toBe(0x10);
  expect(view.getInt32(17, true)).toBe(-1);
  expect([...bytes.slice(21)]).toEqual([3, 5, 1]);
  const bad = await vcall(rt.link("android/util/StatsEvent").ctor, "newBuilder", "()Landroid/util/StatsEvent$Builder;");
  await vcall(bad, "writeInt", "(I)Landroid/util/StatsEvent$Builder;", 10);
  await vcall(bad, "setAtomId", "(I)Landroid/util/StatsEvent$Builder;", 42);
  const failed = await vcall(bad, "build", "()Landroid/util/StatsEvent;");
  const error: Int8Array = await vcall(failed, "getBytes", "()[B");
  expect(error[16]).toBe(15);
  expect(new DataView(error.buffer, error.byteOffset).getInt32(17, true)).toBe(0x2000);
});
