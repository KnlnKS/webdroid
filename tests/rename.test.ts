import { describe, expect, test } from "bun:test";
import { vfs } from "../src/jvm/natives/jio";
import { BytesFile } from "../src/shell/lazyfile";
import { renamePath } from "../src/native/stdio";

describe("renamePath", () => {
  test("moves a loaded file and keeps a lazy source lazy", () => {
    vfs.write("/data/t/a.txt", new Uint8Array([1, 2, 3]));
    expect(renamePath(null, "/data/t/a.txt", "/data/t/b.txt")).toBe(0);
    expect(vfs.read("/data/t/a.txt")).toBeNull();
    expect([...vfs.read("/data/t/b.txt")!]).toEqual([1, 2, 3]);

    vfs.mount("/data/t/lazy.bin", new BytesFile(new Uint8Array([9])));
    expect(renamePath(null, "/data/t/lazy.bin", "/data/t/moved.bin")).toBe(0);
    expect(vfs.lazyFiles.has("/data/t/moved.bin")).toBe(true);
    expect(vfs.exists("/data/t/lazy.bin")).toBe(false);
  });

  test("reports a missing source and a directory target", () => {
    expect(renamePath(null, "/data/t/none", "/data/t/x")).toBe(-1);
    vfs.mkdir("/data/t/dir");
    vfs.write("/data/t/f", new Uint8Array(1));
    expect(renamePath(null, "/data/t/f", "/data/t/dir")).toBe(-1);
    expect(vfs.exists("/data/t/f")).toBe(true);
  });

  test("renames a directory with its entries", () => {
    vfs.write("/data/t/old/sub/x", new Uint8Array([4]));
    vfs.mkdir("/data/t/old/empty");
    expect(renamePath(null, "/data/t/old", "/data/t/new")).toBe(0);
    expect(vfs.exists("/data/t/old")).toBe(false);
    expect([...vfs.read("/data/t/new/sub/x")!]).toEqual([4]);
    expect(vfs.isDir("/data/t/new/empty")).toBe(true);
    expect(renamePath(null, "/data/t/new", "/data/t/new/inner")).toBe(-1);
  });
});
