import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("FileSystemProvider performs file operations through the VFS", async () => {
  const provider = await newObj("java/nio/file/spi/FileSystemProvider", "()V");
  const file = await newObj("java/io/File", "(Ljava/lang/String;)V", "/data/provider-test.txt");
  const path = await vcall(file, "toPath", "()Ljava/nio/file/Path;");
  const output = await vcall(provider, "newOutputStream", "(Ljava/nio/file/Path;[Ljava/nio/file/OpenOption;)Ljava/io/OutputStream;", path, []);
  await vcall(output, "write", "([B)V", new Int8Array([10, 20, 30]));
  await vcall(output, "close", "()V");
  await vcall(provider, "checkAccess", "(Ljava/nio/file/Path;[Ljava/nio/file/AccessMode;)V", path, []);
  const attrs = await vcall(provider, "readAttributes", "(Ljava/nio/file/Path;Ljava/lang/Class;[Ljava/nio/file/LinkOption;)Ljava/nio/file/attribute/BasicFileAttributes;", path, null, []);
  expect(await vcall(attrs, "size", "()J")).toBe(3n);
  expect(await vcall(provider, "deleteIfExists", "(Ljava/nio/file/Path;)Z", path)).toBe(1);
  expect(await vcall(provider, "deleteIfExists", "(Ljava/nio/file/Path;)Z", path)).toBe(0);
});
