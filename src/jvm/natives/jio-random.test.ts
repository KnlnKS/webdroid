import { expect, test } from "bun:test";
import "../../natives";
import { newObj, vcall } from "./jlang";
import { vfs } from "./jio";

test("read-only random access opens cached files, including empty files", async () => {
  const path = "/tmp/random-access-cache";
  vfs.write(path, Uint8Array.of(7, 8, 9));
  const file = await newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", path, "r");
  expect(await vcall(file, "length", "()J")).toBe(3n);
  await vcall(file, "seek", "(J)V", 1n);
  expect(await vcall(file, "read", "()I")).toBe(8);
  await vcall(file, "close", "()V");
  vfs.write(path, new Uint8Array());
  const empty = await newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", path, "r");
  expect(await vcall(empty, "read", "()I")).toBe(-1);
  await vcall(empty, "close", "()V");
  vfs.delete(path);
  await expect(newObj("java/io/RandomAccessFile", "(Ljava/lang/String;Ljava/lang/String;)V", path, "r")).rejects.toMatchObject({ msg: path });
});
