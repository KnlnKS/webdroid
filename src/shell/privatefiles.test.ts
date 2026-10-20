import { expect, test } from "vite-plus/test";
import { vfs } from "./vfs.ts";
import { PrivateFiles } from "./privatefiles.ts";

test("appends keep the writer's spare capacity", () => {
  new PrivateFiles().attach(1, vfs);
  // cache files are tracked but never scheduled for persistence
  const path = "/data/data/test.pkg/cache/log";
  vfs.write(path, new Uint8Array(0));
  vfs.setAttributes(path,{uid:12345,gid:1078,mode:0o660});
  const file = vfs.open(path)!, buffers = new Set<ArrayBufferLike>();
  for (let i = 0; i < 4096; i++) {
    vfs.writeAt(file, i * 16, new Uint8Array(16).fill(i & 255));
    buffers.add(file.data.buffer);
  }
  expect(buffers.size).toBeLessThan(10);
  expect(vfs.read(path)![4095 * 16]).toBe(255);
  expect(vfs.open(path)!.attributes).toEqual({uid:12345,gid:1078,mode:0o660});
});
