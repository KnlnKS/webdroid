import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("ObjectInputStream consumes complete short blocks and crosses block boundaries", async () => {
  const source = await newObj("java/io/ByteArrayInputStream", "([B)V", new Int8Array([
    0xac, 0xed, 0, 5, 0x77, 4, 0x12, 0x34, 0x56, 0x78,
    0x77, 1, 0x11, 0x77, 3, 0x22, 0x33, 0x44,
  ]));
  const input = await newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source);
  expect(await vcall(input, "readInt", "()I")).toBe(0x12345678);
  expect(await vcall(input, "readInt", "()I")).toBe(0x11223344);
});

test("ObjectOutputStream writes a complete object before explicit flush", async () => {
  const set = await newObj("java/util/TreeSet", "()V");
  await vcall(set, "add", "(Ljava/lang/Object;)Z", await newObj("java/util/UUID", "(JJ)V", 1n, 2n));
  const bytes = await newObj("java/io/ByteArrayOutputStream", "()V");
  const output = await newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", bytes);
  await vcall(output, "writeObject", "(Ljava/lang/Object;)V", set);
  const source = await newObj("java/io/ByteArrayInputStream", "([B)V", await vcall(bytes, "toByteArray", "()[B"));
  const input = await newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source);
  const restored = await vcall(input, "readObject", "()Ljava/lang/Object;");
  const iterator = await vcall(restored, "iterator", "()Ljava/util/Iterator;");
  const uuid = await vcall(iterator, "next", "()Ljava/lang/Object;");
  expect(await vcall(uuid, "getMostSignificantBits", "()J")).toBe(1n);
  expect(await vcall(uuid, "getLeastSignificantBits", "()J")).toBe(2n);
});

test("unmodifiable random-access lists retain their serialized read-only view", async () => {
  const list = await newObj("java/util/ArrayList", "()V");
  await vcall(list, "add", "(Ljava/lang/Object;)Z", "saved");
  await vcall(list, "add", "(Ljava/lang/Object;)Z", await newObj("java/util/concurrent/atomic/AtomicInteger", "(I)V", 7));
  const view = await vcall(rt.link("java/util/Collections").ctor, "unmodifiableList", "(Ljava/util/List;)Ljava/util/List;", list);
  const bytes = await newObj("java/io/ByteArrayOutputStream", "()V");
  const output = await newObj("java/io/ObjectOutputStream", "(Ljava/io/OutputStream;)V", bytes);
  await vcall(output, "writeObject", "(Ljava/lang/Object;)V", view);
  const source = await newObj("java/io/ByteArrayInputStream", "([B)V", await vcall(bytes, "toByteArray", "()[B"));
  const input = await newObj("java/io/ObjectInputStream", "(Ljava/io/InputStream;)V", source);
  const restored = await vcall(input, "readObject", "()Ljava/lang/Object;");
  expect(rt.iof(restored, "java/util/RandomAccess")).toBe(1);
  expect(await vcall(restored, "get", "(I)Ljava/lang/Object;", 0)).toBe("saved");
  expect(await vcall(await vcall(restored, "get", "(I)Ljava/lang/Object;", 1), "get", "()I")).toBe(7);
  await expect(vcall(restored, "add", "(Ljava/lang/Object;)Z", "new")).rejects.toThrow();
});
