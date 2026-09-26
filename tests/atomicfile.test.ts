import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { mkFile, vfs } from "../src/jvm/natives/jio";

rt.linkNatives();
const make = (path: string) => newObj("android/util/AtomicFile", "(Ljava/io/File;)V", mkFile(path));
const write = async (file: unknown, text: string) => {
  const stream = await vcall(file, "startWrite", "()Ljava/io/FileOutputStream;");
  const bytes = new TextEncoder().encode(text);
  await vcall(stream, "write", "([BII)V", bytes, 0, bytes.length);
  return stream;
};
test("AtomicFile commits new data and rolls failed replacements back", async () => {
  const path = "/data/test-atomic/replace", file = await make(path);
  let stream = await write(file, "first");
  expect(vfs.exists(path)).toBe(false);
  await vcall(file, "finishWrite", "(Ljava/io/FileOutputStream;)V", stream);
  stream = await write(file, "second");
  await vcall(file, "failWrite", "(Ljava/io/FileOutputStream;)V", stream);
  expect(new TextDecoder().decode(await vcall(file, "readFully", "()[B"))).toBe("first");
  expect(vfs.exists(path + ".new")).toBe(false);
  stream = await write(file, "third");
  await vcall(file, "finishWrite", "(Ljava/io/FileOutputStream;)V", stream);
  expect(new TextDecoder().decode(await vcall(file, "readFully", "()[B"))).toBe("third");
  await vcall(file, "delete", "()V");
  await expect(vcallAsync(file, "openRead", "()Ljava/io/FileInputStream;")).rejects.toBeDefined();
});
test("AtomicFile restores legacy backups and discards interrupted replacements on read", async () => {
  const path = "/data/test-atomic/recover", file = await make(path);
  vfs.write(path, new Uint8Array([1]));
  vfs.write(path + ".bak", new Uint8Array([2]));
  vfs.write(path + ".new", new Uint8Array([3]));
  expect(Array.from(await vcall(file, "readFully", "()[B"))).toEqual([2]);
  expect(vfs.exists(path + ".bak")).toBe(false);
  expect(vfs.exists(path + ".new")).toBe(false);
  await vcall(file, "delete", "()V");
});
