import { expect, test } from "bun:test";
import { vfs } from "./vfs.ts";
import { PrivateFiles } from "./privatefiles.ts";

test("appends keep the writer's spare capacity while every realm reads the new bytes", async () => {
  const other: typeof vfs = (await import("./vfs.ts?other" as string)).vfs;
  expect(other).not.toBe(vfs);
  const files = new PrivateFiles();
  files.attach(1, vfs); files.attach(2, other);
  // cache files are shared between realms but never scheduled for persistence
  const path = "/data/data/test.pkg/cache/log";
  vfs.write(path, new Uint8Array(0));
  vfs.setAttributes(path,{uid:12345,gid:1078,mode:0o660});
  expect(other.attributes(path)).toEqual({uid:12345,gid:1078,mode:0o660});
  const file = vfs.open(path)!, buffers = new Set<ArrayBufferLike>();
  for (let i = 0; i < 4096; i++) {
    vfs.writeAt(file, i * 16, new Uint8Array(16).fill(i & 255));
    buffers.add(file.data.buffer);
    expect(other.read(path)!.length).toBe((i + 1) * 16);
  }
  expect(buffers.size).toBeLessThan(10);
  const seen = other.read(path)!;
  expect(seen[4095 * 16]).toBe(255);
  other.writeAt(other.open(path)!, 0, Uint8Array.of(7));
  expect(vfs.read(path)![0]).toBe(7);
  vfs.writeAt(file, file.len, Uint8Array.of(9));
  expect(other.read(path)!.subarray(-1)[0]).toBe(9);
  expect(other.read(path)![0]).toBe(7);
  other.setAttributes(path,{mode:0o640});
  expect(vfs.open(path)!.attributes).toEqual({uid:12345,gid:1078,mode:0o640});
});
