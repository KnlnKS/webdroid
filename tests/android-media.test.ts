import { expect, test, describe, beforeAll } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { bootApp, packageRecord, thrown } from "./java.ts";
import { startMainLooper } from "../src/android/mainloop.ts";
import "../src/natives.ts";
import { rt, JObj, getDeclared } from "../src/jvm/runtime.ts";
import { newObj, scall, vcall, vcallAsync, iof } from "../src/jvm/natives/jentry.ts";
import { lambda } from "../src/jvm/natives/jlambda.ts";
import { vfs } from "../src/shell/vfs.ts";
import { onMain } from "../src/android/mainloop.ts";
import { mkAssetFd } from "../src/android/resnative.ts";
import { hostedService } from "../src/android/binder.ts";
import { definitionFor, videoConfig, videoKeyFrame } from "../src/android/media-codec.ts";
import { NativeFormat } from "../src/android/media-format.ts";

// framework.jar and a running main looper, as a booted page has them
beforeAll(startMainLooper);
// one app process for the file
const app = async () => bootApp(await packageRecord("org.webdroid.test.media"));

describe("audio-attributes", () => {

  test("AudioAttributes maps legacy music streams", async () => {
    const builder = await newObj("android/media/AudioAttributes$Builder");
    expect(await vcall(builder, "setLegacyStreamType", "(I)Landroid/media/AudioAttributes$Builder;", 3)).toBe(builder);
    const attrs = await vcall(builder, "build", "()Landroid/media/AudioAttributes;");
    expect(await vcall(attrs, "getUsage", "()I")).toBe(1);
    // the reference AVD's media strategy carries no content type for STREAM_MUSIC
    expect(await vcall(attrs, "getContentType", "()I")).toBe(0);
    expect(await vcall(attrs, "getVolumeControlStream", "()I")).toBe(3);
  });

  test("the audio service's focus stack tells holders of their loss and return", async () => {
    const changes: [string, number][] = [];
    const dispatcher = () => lambda("android/media/IAudioFocusDispatcher", "dispatchAudioFocusChange(ILjava/lang/String;)V", (change: number, id: string) => { changes.push([id, change]); });
    const audio = await hostedService("audio");
    const request = (gain: number, id: string) => vcall(audio, "requestAudioFocus",
      "(Landroid/media/AudioAttributes;ILandroid/os/IBinder;Landroid/media/IAudioFocusDispatcher;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ILandroid/media/audiopolicy/IAudioPolicyCallback;I)I",
      null, gain, null, dispatcher(), id, "p", null, 0, null, 35);
    const abandon = (id: string) => vcall(audio, "abandonAudioFocus", "(Landroid/media/IAudioFocusDispatcher;Ljava/lang/String;Landroid/media/AudioAttributes;Ljava/lang/String;)I", null, id, null, "p");
    expect(await request(1, "music")).toBe(1);
    expect(await request(3, "nav")).toBe(1);
    expect(await abandon("nav")).toBe(1);
    expect(await request(1, "other")).toBe(1);
    await onMain(() => {});
    expect(changes).toEqual([["music", -3], ["music", 1], ["music", -1]]);
  });

});

describe("media-codec-capabilities", () => {

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
      const rates = await vcall(video, "getSupportedFrameRatesFor", "(II)Landroid/util/Range;", 3840, 2160);
      const upper = await vcall(rates, "getUpper", "()Ljava/lang/Comparable;");
      expect(await vcall(upper, "doubleValue", "()D")).toBe(64);
      expect(await vcall(video, "areSizeAndRateSupported", "(IID)Z", 3840, 2160, 65)).toBe(0);
      expect(await vcall(video, "isSizeSupported", "(II)Z", 4096, 4096)).toBe(0);
    } finally {
      if (previous) Object.defineProperty(globalThis, "VideoDecoder", previous);
      else delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
    }
  });
});

describe("media-retriever", () => {

  test("MediaMetadataRetriever reads video metadata and rejects nonmedia input", async () => {
    await app();
    const retriever = await newObj("android/media/MediaMetadataRetriever", "()V");
    vfs.write("/sdcard/media-probe.mp4", new Uint8Array(readFileSync("tests/fixtures/media.mp4")));
    await vcall(retriever, "setDataSource", "(Ljava/lang/String;)V", "/sdcard/media-probe.mp4");
    expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 12)).toBe("video/mp4");
    expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 18)).toBe("32");
    expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 19)).toBe("32");
    await vcall(retriever, "release", "()V");
    vfs.write("/sdcard/media-probe.txt", new Uint8Array(0));
    const failed = await vcallAsync(await newObj("android/media/MediaMetadataRetriever", "()V"), "setDataSource", "(Ljava/lang/String;)V", "/sdcard/media-probe.txt").then(() => null, (e: unknown) => e);
    expect(iof(failed, "java/lang/RuntimeException")).toBe(true);
  });

  test("MediaMetadataRetriever reads MP3 metadata", async () => {
    const retriever = await newObj("android/media/MediaMetadataRetriever", "()V");
    vfs.write("/sdcard/media-probe.mp3", new Uint8Array(readFileSync("tests/fixtures/audio.mp3")));
    await vcall(retriever, "setDataSource", "(Ljava/lang/String;)V", "/sdcard/media-probe.mp3");
    expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 12)).toBe("audio/mpeg");
    expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 9)).toBe("52");
    expect(await vcall(retriever, "getEmbeddedPicture", "()[B")).toBeNull();
  });
});

describe("mediadrm", () => {

  test("MediaDrm reports the browser device's unsupported schemes", async () => {
    const uuid = await newObj("java/util/UUID", "(JJ)V", 0n, 0n);
    expect(await thrown(() => newObj("android/media/MediaDrm", "(Ljava/util/UUID;)V", uuid))).toMatch(/^android\/media\/UnsupportedSchemeException:/);
    expect(await scall("android/media/MediaDrm", "isCryptoSchemeSupported", "(Ljava/util/UUID;)Z", uuid)).toBe(0);
  });
});

describe("mediasession", () => {
  const commands: string[] = [];
  rt.register({ name: "test/SessionCallback", ctor: class extends JObj {}, sup: "android/media/session/MediaSession$Callback", methods: {
    "onCommand(Ljava/lang/String;Landroid/os/Bundle;Landroid/os/ResultReceiver;)V": (command: string) => { commands.push(command); },
  } });

  test("MediaSession keeps controller identity and dispatches commands through the callback looper", async () => {
    const context = await app();
    const session = await newObj("android/media/session/MediaSession", "(Landroid/content/Context;Ljava/lang/String;)V", context, "test");
    const token = await vcall(session, "getSessionToken", "()Landroid/media/session/MediaSession$Token;");
    const controller = await newObj("android/media/session/MediaController", "(Landroid/content/Context;Landroid/media/session/MediaSession$Token;)V", context, token);
    const callback = rt.make("test/SessionCallback");
    const setCallback = () => vcall(session, "setCallback", "(Landroid/media/session/MediaSession$Callback;)V", callback);
    const command = (name: string) => vcall(controller, "sendCommand", "(Ljava/lang/String;Landroid/os/Bundle;Landroid/os/ResultReceiver;)V", name, null, null);
    // the session's ISessionCallback is oneway, as from system_server: the command reaches the callback's handler on a turn of its own
    const queued = async () => vcall(getDeclared(session, "android/media/session/MediaSession", "mCallback"), "hasMessagesOrCallbacks", "()Z");
    await onMain(async () => {
      await setCallback();
      await command("discarded");
      while (!await queued()) await new Promise((r) => setTimeout(r, 0));
      await setCallback();
      await command("delivered");
      expect(commands).toEqual([]);
    });
    await onMain(() => {});
    expect(commands).toEqual(["delivered"]);
    expect(await vcall(controller, "getSessionToken", "()Landroid/media/session/MediaSession$Token;")).toBe(token);
    await vcall(session, "setActive", "(Z)V", 1);
    expect(await vcall(session, "isActive", "()Z")).toBe(1);
    await vcall(session, "release", "()V");
    await command("released");
    await onMain(() => {});
    expect(commands).toEqual(["delivered"]);
  });
});

describe("sound-pool", () => {

  const loadListener = () => {
    const loaded: number[][] = [];
    return Object.assign(lambda("android/media/SoundPool$OnLoadCompleteListener", "onLoadComplete(Landroid/media/SoundPool;II)V", (_pool: unknown, id: number, status: number) => { loaded.push([id, status]); }), { loaded });
  };

  test("SoundPool.load(AssetFileDescriptor) decodes the descriptor's bytes and reports the load", async () => {
    const decoded: number[] = [];
    (globalThis as { AudioContext?: unknown }).AudioContext ??= class {
      decodeAudioData(b: ArrayBuffer) { decoded.push(b.byteLength); return Promise.resolve({}); }
    };
    const pool = await newObj("android/media/SoundPool", "(III)V", 4, 3, 0);
    const listener = loadListener();
    await vcall(pool, "setOnLoadCompleteListener", "(Landroid/media/SoundPool$OnLoadCompleteListener;)V", listener);
    const id = await vcallAsync(pool, "load", "(Landroid/content/res/AssetFileDescriptor;I)I", await mkAssetFd(new Uint8Array(7)), 1);
    expect(id).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 0)); await onMain(() => {});
    expect(decoded).toEqual([7]);
    expect(listener.loaded).toEqual([[id, 0]]);
  });
});

describe("media-codec-bitstreams", () => {
  const u = (...b: number[]) => Uint8Array.from(b);
  const read = (mime: string, data: Uint8Array) => {
    const def = definitionFor(mime)!;
    if (def.kind !== "video") throw new Error(mime);
    return [videoKeyFrame(def, data), videoConfig(def, new NativeFormat(), data).codec];
  };
  test("an access unit's key frame and its sequence parameter set's codec string", () => {
    // AVC: SPS, PPS, IDR; a non-IDR slice; an SPS with emulation prevention
    expect(read("video/avc", u(0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0xac, 0, 0, 0, 1, 0x68, 0xee, 0, 0, 1, 0x65, 0x88, 0x80))).toEqual([true, "avc1.64001F"]);
    expect(read("video/avc", u(0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x41, 0x9a))).toEqual([false, "avc1.640034"]);
    expect(read("video/avc", u(0, 0, 1, 0x67, 0x64, 0x00, 0x00, 0x03, 0x1f))[1]).toBe("avc1.640000");
    // HEVC: VPS, SPS, PPS, IDR_W_RADL; a TRAIL_R slice; a truncated SPS
    expect(read("video/hevc", u(0, 0, 0, 1, 0x40, 0x01, 0x0c, 0, 0, 0, 1, 0x42, 0x01, 0x01, 0x01, 0x60, 0x00, 0x00, 0x00, 0x90, 0, 0, 0, 0, 0, 0x5d,
      0, 0, 1, 0x44, 0x01, 0xc0, 0, 0, 1, 0x26, 0x01, 0xaf))).toEqual([true, "hvc1.1.6.L93.90"]);
    expect(read("video/hevc", u(0, 0, 1, 0x02, 0x01, 0xd0))).toEqual([false, "hvc1.1.6.L153.B0"]);
    expect(read("video/hevc", u(0, 0, 1, 0x42, 0x01, 0x01, 0x01))).toEqual([false, "hvc1.1.6.L153.B0"]);
    expect([u(0x10, 2), u(0x11, 2)].map((data) => read("video/x-vnd.on2.vp8", data)[0])).toEqual([true, false]);
    expect([u(0x82, 0x49), u(0x86, 0), u(0xb2, 0)].map((data) => read("video/x-vnd.on2.vp9", data)[0])).toEqual([true, false, false]);
    // AV1: a temporal delimiter then a frame header OBU; a frame OBU of an inter frame; one without a size; none
    expect([u(0x12, 0x00, 0x1a, 0x01, 0x10), u(0x12, 0x00, 0x32, 0x02, 0x30, 0x00), u(0x32, 0x01, 0x00), u()].map((data) => read("video/av01", data)[0]))
      .toEqual([true, false, true, false]);
  });
});
