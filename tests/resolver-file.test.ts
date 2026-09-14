import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { vcall } from "../src/jvm/natives/jlang";
import { vfs } from "../src/jvm/natives/jio";
import { mkUri } from "../src/android/net";
import { javaReadFd } from "../src/native/stdio";

rt.linkNatives();
test("resolver file opens decode paths and reject missing files without creating them", async () => {
  const resolver = rt.make("android/content/ContentResolver");
  const path = "/resolver file?x=1", uri = mkUri("file:///resolver%20file%3Fx%3D1?ignored=2#fragment");
  vfs.write(path, Uint8Array.of(7, 8));
  try {
    const stream = await vcall(resolver, "openInputStream", "(Landroid/net/Uri;)Ljava/io/InputStream;", uri);
    expect(await vcall(stream, "read", "()I")).toBe(7);
    await vcall(stream, "close", "()V");
    const pfd = await vcall(resolver, "openFileDescriptor", "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;", uri, "r");
    const fd = await vcall(pfd, "getFd", "()I"), data = new Uint8Array(2);
    expect(await javaReadFd(fd, data)).toBe(2);
    expect([...data]).toEqual([7, 8]);
    await vcall(pfd, "close", "()V");
    vfs.delete(path);
    for (const missing of [uri, mkUri("unsupported://file")]) {
      const error = await vcall(resolver, "openFileDescriptor", "(Landroid/net/Uri;Ljava/lang/String;)Landroid/os/ParcelFileDescriptor;", missing, "r").catch(error => error);
      expect(rt.iof(error, "java/io/FileNotFoundException")).toBe(1);
    }
    expect(vfs.exists(path)).toBe(false);
  } finally { vfs.delete(path); }
});

test("parcel file modes distinguish read-write access, truncation and append", async () => {
  const cls = rt.link("android/os/ParcelFileDescriptor").ctor;
  for (const [mode, flags] of [["r", 0x10000000], ["w", 0x2c000000], ["wt", 0x2c000000], ["wa", 0x2a000000], ["rw", 0x38000000], ["rwt", 0x3c000000]] satisfies [string, number][]) {
    expect(await vcall(cls, "parseMode", "(Ljava/lang/String;)I", mode)).toBe(flags);
  }
  for (const mode of ["", "read", "rwa"]) {
    const error = await vcall(cls, "parseMode", "(Ljava/lang/String;)I", mode).catch(error => error);
    expect(rt.iof(error, "java/lang/IllegalArgumentException")).toBe(1);
  }
});
