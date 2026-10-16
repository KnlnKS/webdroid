import { expect, test } from "bun:test";
import "../natives.ts";
import { JThread } from "../jvm/natives/jentry.ts";
import { Cpu, setA64 } from "./cpu.ts";
import { lookupHost } from "./host.ts";
import { mem } from "./mem.ts";
import { javaBytesFd, javaCloseFd } from "./fs.ts";
import { mediaInit } from "./media.ts";

// 0.3 seconds of 32x32 red H.264 (10 fps, key interval 2, no B frames) and 8 kHz AAC.
test("NDK extraction owns its descriptor and preserves samples, timestamps and sync seeking", async () => {
  const clip = new Uint8Array(await Bun.file(new URL("../../tests/fixtures/media.mp4", import.meta.url)).arrayBuffer());
  const wrapped = new Uint8Array(clip.length + 17); wrapped.set(clip, 17);
  for (const wide of [false, true]) {
    setA64(wide); mediaInit();
    const cpu = new Cpu(new JThread(), "media-test");
    const call = (name: string, ...args: (number | bigint)[]) => cpu.call(lookupHost("AMedia" + name, "libmediandk.so")!, args);
    const fd = javaBytesFd(wrapped), out = mem.malloc(8192), mime = mem.ld32(lookupHost("AMEDIAFORMAT_KEY_MIME", "libmediandk.so")!) >>> 0, width = mem.strdup("width"), csd = mem.strdup("csd-0");
    let extractor = 0, format = 0;
    try {
      extractor = await call("Extractor_new");
      expect(await call("Extractor_setDataSourceFd", extractor, fd, 17n, BigInt(clip.length))).toBe(0);
      javaCloseFd(fd);
      expect(await call("Extractor_getTrackCount", extractor)).toBe(2);
      format = await call("Extractor_getTrackFormat", extractor, 0);
      expect(await call("Format_getInt32", format, width, out)).toBe(1); expect(mem.ld32(out)).toBe(32);
      expect(await call("Format_getString", format, mime, out)).toBe(1);
      expect(mem.cstr(mem.ld32(out) >>> 0)).toBe("video/avc");
      expect(await call("Format_getBuffer", format, csd, out, out + 8)).toBe(1);
      expect([...mem.bytes(mem.ld32(out) >>> 0, 4)]).toEqual([0, 0, 0, 1]);
      expect(await call("Extractor_selectTrack", extractor, 0)).toBe(0);
      expect(await call("Extractor_getSampleTime", extractor)).toBe(0);
      expect(await call("Extractor_getSampleFlags", extractor)).toBe(1);
      expect(await call("Extractor_readSampleData", extractor, out, 8192)).toBeGreaterThan(4);
      expect([...mem.bytes(out, 4)]).toEqual([0, 0, 0, 1]);
      expect(await call("Extractor_advance", extractor)).toBe(1);
      expect(await call("Extractor_getSampleTime", extractor)).toBe(100000);
      expect(await call("Extractor_getSampleFlags", extractor)).toBe(0);
      expect(await call("Extractor_seekTo", extractor, 150000n, 1)).toBe(0);
      expect(await call("Extractor_getSampleTime", extractor)).toBe(200000);
      expect(await call("Extractor_advance", extractor)).toBe(0);
      expect(await call("Extractor_readSampleData", extractor, out, 8192)).toBe(-1);
      expect(await call("Extractor_seekTo", extractor, 150000n, 0)).toBe(0);
      expect(await call("Extractor_getSampleTime", extractor)).toBe(0);
    } finally {
      if (format) await call("Format_delete", format);
      if (extractor) await call("Extractor_delete", extractor);
      javaCloseFd(fd); mem.free(out); mem.free(width); mem.free(csd); cpu.dispose(); setA64(false);
    }
  }
});
