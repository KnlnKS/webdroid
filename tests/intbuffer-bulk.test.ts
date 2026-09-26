import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall, vcallAsync } from "../src/jvm/natives/jlang";
rt.linkNatives();
test("IntBuffer bulk range writes honor order, position and limits", async () => {
  for (const little of [false, true]) {
    const bytes = await vcall(rt.link("java/nio/ByteBuffer").ctor, "allocate", "(I)Ljava/nio/ByteBuffer;", 20);
    if (little) await vcall(bytes, "order", "(Ljava/nio/ByteOrder;)Ljava/nio/ByteBuffer;", rt.link("java/nio/ByteOrder").ctor.s$LITTLE_ENDIAN);
    const buffer = await vcall(bytes, "asIntBuffer", "()Ljava/nio/IntBuffer;");
    await vcall(buffer, "position", "(I)Ljava/nio/IntBuffer;", 1);
    await vcall(buffer, "put", "([III)Ljava/nio/IntBuffer;", Int32Array.of(9, 0x12345678, -42, 8), 1, 2);
    expect(await vcall(buffer, "position", "()I")).toBe(3);
    expect(await vcall(buffer, "get", "(I)I", 1)).toBe(0x12345678);
    expect(await vcall(buffer, "get", "(I)I", 2)).toBe(-42);
    await expect(vcallAsync(buffer, "put", "([III)Ljava/nio/IntBuffer;", new Int32Array(1), 1, 1)).rejects.toBeDefined();
    await expect(vcallAsync(buffer, "put", "([III)Ljava/nio/IntBuffer;", new Int32Array(3), 0, 3)).rejects.toBeDefined();
    expect(await vcall(buffer, "position", "()I")).toBe(3);
  }
});
test("ShortBuffer bulk ranges preserve signed values and bounds", async () => {
  const bytes = await vcall(rt.link("java/nio/ByteBuffer").ctor, "allocate", "(I)Ljava/nio/ByteBuffer;", 8);
  const buffer = await vcall(bytes, "asShortBuffer", "()Ljava/nio/ShortBuffer;");
  await vcall(buffer, "put", "([SII)Ljava/nio/ShortBuffer;", Int16Array.of(8, -32768, 32767, 9), 1, 2);
  expect(await vcall(buffer, "get", "(I)S", 0)).toBe(-32768);
  expect(await vcall(buffer, "get", "(I)S", 1)).toBe(32767);
  await expect(vcallAsync(buffer, "put", "([SII)Ljava/nio/ShortBuffer;", Int16Array.of(1), 1, 1)).rejects.toBeDefined();
  expect(await vcall(buffer, "position", "()I")).toBe(2);
});
