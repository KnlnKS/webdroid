import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("video codec capabilities expose the advertised height range", async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "VideoDecoder");
  Object.defineProperty(globalThis, "VideoDecoder", { configurable: true, value: class {
    static isConfigSupported(config: VideoDecoderConfig) { return Promise.resolve({ config, supported: true }); }
  } });
  try {
    const list = await newObj("android/media/MediaCodecList", "(I)V", 0);
    const infos = await vcall(list, "getCodecInfos", "()[Landroid/media/MediaCodecInfo;");
    const caps = await vcall(infos[0], "getCapabilitiesForType", "(Ljava/lang/String;)Landroid/media/MediaCodecInfo$CodecCapabilities;", "video/avc");
    const video = await vcall(caps, "getVideoCapabilities", "()Landroid/media/MediaCodecInfo$VideoCapabilities;");
    for (const method of ["getSupportedHeights", "getSupportedWidths"]) {
      const range = await vcall(video, method, "()Landroid/util/Range;");
      const upper = await vcall(range, "getUpper", "()Ljava/lang/Comparable;");
      expect(await vcall(upper, "intValue", "()I")).toBe(4096);
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, "VideoDecoder", previous);
    else delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
  }
});
