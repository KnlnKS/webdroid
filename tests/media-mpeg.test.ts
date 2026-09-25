import { expect, test } from "bun:test";
import { mpegAudioDuration } from "../src/android/media-mpeg";

test("MPEG audio duration counts frames and honors Xing metadata", async () => {
  const bytes = new Uint8Array(4160);
  for (let i = 0; i < 20; i++) bytes.set([0xff, 0xfb, 0x50, 0x00], i * 208);
  const source = { size: bytes.length, read: async (offset: number, length: number) => bytes.subarray(offset, offset + length) };
  expect(await mpegAudioDuration(source)).toBe(522);
  bytes.set([0x58, 0x69, 0x6e, 0x67, 0, 0, 0, 1, 0, 0, 0, 10], 36);
  expect(await mpegAudioDuration(source)).toBe(261);
});
