import { expect, test, describe, beforeAll } from "bun:test";
import { loadFrameworkJar, bootApp, packageRecord } from "./java";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { vfs } from "../src/shell/vfs";
import { mangleMethod } from "../src/jvm/abi";
import { onMain } from "../src/android/mainloop";
import { mkAssetFd } from "../src/android/resnative";
import { hostedService } from "../src/android/binder";

// framework.jar and a running main looper, as a booted page has them
beforeAll(loadFrameworkJar);

describe("audio-attributes", () => {
  rt.linkNatives();

  test("AudioAttributes maps legacy music streams", async () => {
    const builder = await newObj("android/media/AudioAttributes$Builder");
    expect(await vcall(builder, "setLegacyStreamType", "(I)Landroid/media/AudioAttributes$Builder;", 3)).toBe(builder);
    const attrs = await vcall(builder, "build", "()Landroid/media/AudioAttributes;");
    expect(await vcall(attrs, "getUsage", "()I")).toBe(1);
    // the reference AVD's media strategy carries no content type for STREAM_MUSIC
    expect(await vcall(attrs, "getContentType", "()I")).toBe(0);
    expect(await vcall(attrs, "getVolumeControlStream", "()I")).toBe(3);
  });

  test("AudioAttributes rejects the accessibility legacy stream", async () => {
    const builder = await newObj("android/media/AudioAttributes$Builder");
    await expect(vcallAsync(builder, "setLegacyStreamType", "(I)Landroid/media/AudioAttributes$Builder;", 10)).rejects.toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
  });

  test("AudioFocusRequest retains builder state", async () => {
    const listener = rt.make("java/lang/Object");
    const builder = await newObj("android/media/AudioFocusRequest$Builder", "(I)V", 1);
    expect(await vcall(builder, "setAcceptsDelayedFocusGain", "(Z)Landroid/media/AudioFocusRequest$Builder;", 1)).toBe(builder);
    expect(await vcall(builder, "setWillPauseWhenDucked", "(Z)Landroid/media/AudioFocusRequest$Builder;", 1)).toBe(builder);
    await vcall(builder, "setOnAudioFocusChangeListener", "(Landroid/media/AudioManager$OnAudioFocusChangeListener;)Landroid/media/AudioFocusRequest$Builder;", listener);
    const request = await vcall(builder, "build", "()Landroid/media/AudioFocusRequest;");
    expect(await vcall(request, "getFocusGain", "()I")).toBe(1);
    expect(await vcall(request, "acceptsDelayedFocusGain", "()Z")).toBe(1);
    expect(await vcall(request, "willPauseWhenDucked", "()Z")).toBe(1);
    expect(await vcall(request, "getOnAudioFocusChangeListener", "()Landroid/media/AudioManager$OnAudioFocusChangeListener;")).toBe(listener);
  });

  test("the audio service's focus stack tells holders of their loss and return", async () => {
    const changes: [string, number][] = [];
    class Dispatcher extends JObj {
      [mangleMethod("dispatchAudioFocusChange", "(ILjava/lang/String;)V")](change: number, id: string) { changes.push([id, change]); }
    }
    const audio = await hostedService("audio");
    const request = (gain: number, id: string) => vcall(audio, "requestAudioFocus",
      "(Landroid/media/AudioAttributes;ILandroid/os/IBinder;Landroid/media/IAudioFocusDispatcher;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ILandroid/media/audiopolicy/IAudioPolicyCallback;I)I",
      null, gain, null, new Dispatcher(), id, "p", null, 0, null, 35);
    const abandon = (id: string) => vcall(audio, "abandonAudioFocus", "(Landroid/media/IAudioFocusDispatcher;Ljava/lang/String;Landroid/media/AudioAttributes;Ljava/lang/String;)I", null, id, null, "p");
    expect(await request(1, "music")).toBe(1);
    expect(await request(3, "nav")).toBe(1);
    expect(await abandon("nav")).toBe(1);
    expect(await request(1, "other")).toBe(1);
    await onMain(() => {});
    expect(changes).toEqual([["music", -3], ["music", 1], ["music", -1]]);
  });

  test("AudioFocusRequest rejects invalid gains and null listeners", async () => {
    await expect((async () => newObj("android/media/AudioFocusRequest$Builder", "(I)V", 0))()).rejects.toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
    const builder = await newObj("android/media/AudioFocusRequest$Builder", "(I)V", 1);
    await expect(vcallAsync(builder, "setOnAudioFocusChangeListener", "(Landroid/media/AudioManager$OnAudioFocusChangeListener;)Landroid/media/AudioFocusRequest$Builder;", null)).rejects.toMatchObject({ constructor: rt.link("java/lang/NullPointerException").ctor });
  });
});

describe("audio-record", () => {
  rt.linkNatives();

  test("AudioRecord reports supported PCM buffer sizes without fabricating an input device", async () => {
    const audioRecord = rt.link("android/media/AudioRecord").ctor;
    expect(await vcall(audioRecord, "getMinBufferSize", "(III)I", 44100, 16, 2)).toBeGreaterThan(0);
    expect(await vcall(audioRecord, "getMinBufferSize", "(III)I", 44100, 0, 2)).toBe(-2);
    const record = await newObj("android/media/AudioRecord", "(IIIII)V", 6, 44100, 16, 2, 8820);
    expect(await vcall(record, "getState", "()I")).toBe(0);
    expect(await vcall(record, "getRecordingState", "()I")).toBe(1);
  });
});

describe("media-codec-capabilities", () => {
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
      const rates = await vcall(video, "getSupportedFrameRatesFor", "(II)Landroid/util/Range;", 1920, 1080);
      const upper = await vcall(rates, "getUpper", "()Ljava/lang/Comparable;");
      expect(await vcall(upper, "doubleValue", "()D")).toBe(64);
      expect(await vcall(video, "areSizeAndRateSupported", "(IID)Z", 1920, 1080, 65)).toBe(0);
      expect(await vcall(video, "isSizeSupported", "(II)Z", 4096, 4096)).toBe(0);
    } finally {
      if (previous) Object.defineProperty(globalThis, "VideoDecoder", previous);
      else delete (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
    }
  });
});

describe("media-retriever", () => {
  rt.linkNatives();

  test("MediaMetadataRetriever reads video metadata and rejects nonmedia input", async () => {
    const retriever = await newObj("android/media/MediaMetadataRetriever", "()V");
    vfs.write("/sdcard/media-probe.mp4", new Uint8Array(await Bun.file("tests/fixtures/media.mp4").arrayBuffer()));
    await vcall(retriever, "setDataSource", "(Ljava/lang/String;)V", "/sdcard/media-probe.mp4");
    expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 12)).toBe("video/mp4");
    expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 18)).toBe("32");
    expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 19)).toBe("32");
    await vcall(retriever, "release", "()V");
    vfs.write("/sdcard/media-probe.txt", new Uint8Array(0));
    await expect(vcallAsync(retriever, "setDataSource", "(Ljava/lang/String;)V", "/sdcard/media-probe.txt")).rejects.toMatchObject({ msg: "Invalid media source" });
  });

  test("MediaMetadataRetriever reads MP3 metadata", async () => {
    const retriever = await newObj("android/media/MediaMetadataRetriever", "()V");
    vfs.write("/sdcard/media-probe.mp3", new Uint8Array(await Bun.file("tests/fixtures/audio.mp3").arrayBuffer()));
    await vcall(retriever, "setDataSource", "(Ljava/lang/String;)V", "/sdcard/media-probe.mp3");
    expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 12)).toBe("audio/mpeg");
    expect(await vcall(retriever, "extractMetadata", "(I)Ljava/lang/String;", 9)).toBe("52");
    expect(await vcall(retriever, "getEmbeddedPicture", "()[B")).toBeNull();
  });
});

describe("mediadrm", () => {
  rt.linkNatives();

  test("MediaDrm reports the browser device's unsupported schemes", async () => {
    const uuid = await newObj("java/util/UUID", "(JJ)V", 0n, 0n);
    await expect((async () => newObj("android/media/MediaDrm", "(Ljava/util/UUID;)V", uuid))()).rejects.toMatchObject({
      constructor: rt.link("android/media/UnsupportedSchemeException").ctor,
    });
    expect(rt.iof(rt.make("android/media/UnsupportedSchemeException"), "android/media/MediaDrmException")).toBe(1);
    const supported = rt.link("android/media/MediaDrm").ctor[mangleMethod("isCryptoSchemeSupported", "(Ljava/util/UUID;)Z")];
    expect(supported(uuid)).toBe(0);
    await vcall(rt.make("android/media/MediaDrm"), "close", "()V");
  });
});

describe("mediasession", () => {
  const commands: string[] = [];
  rt.register({ name: "test/SessionCallback", ctor: class extends JObj {}, sup: "android/media/session/MediaSession$Callback", methods: {
    "onCommand(Ljava/lang/String;Landroid/os/Bundle;Landroid/os/ResultReceiver;)V": (command: string) => { commands.push(command); },
  } });
  rt.linkNatives();

  test("MediaSession keeps controller identity and dispatches commands through the callback looper", async () => {
    const context = await bootApp(await packageRecord("org.webdroid.test.session"));
    const session = await newObj("android/media/session/MediaSession", "(Landroid/content/Context;Ljava/lang/String;)V", context, "test");
    const token = await vcall(session, "getSessionToken", "()Landroid/media/session/MediaSession$Token;");
    const controller = await newObj("android/media/session/MediaController", "(Landroid/content/Context;Landroid/media/session/MediaSession$Token;)V", context, token);
    const callback = rt.make("test/SessionCallback");
    const setCallback = () => vcall(session, "setCallback", "(Landroid/media/session/MediaSession$Callback;)V", callback);
    const command = (name: string) => vcall(controller, "sendCommand", "(Ljava/lang/String;Landroid/os/Bundle;Landroid/os/ResultReceiver;)V", name, null, null);
    await onMain(async () => {
      await setCallback();
      await command("discarded");
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
  rt.linkNatives();

  class LoadListener extends JObj {
    loaded: number[][] = [];
    [mangleMethod("onLoadComplete", "(Landroid/media/SoundPool;II)V")](_pool: unknown, id: number, status: number) { this.loaded.push([id, status]); }
  }

  test("SoundPool.load(AssetFileDescriptor) decodes the descriptor's bytes and reports the load", async () => {
    const decoded: number[] = [];
    (globalThis as { AudioContext?: unknown }).AudioContext ??= class {
      decodeAudioData(b: ArrayBuffer) { decoded.push(b.byteLength); return Promise.resolve({}); }
    };
    const pool = await newObj("android/media/SoundPool", "(III)V", 4, 3, 0);
    const listener = new LoadListener();
    await vcall(pool, "setOnLoadCompleteListener", "(Landroid/media/SoundPool$OnLoadCompleteListener;)V", listener);
    const id = await vcallAsync(pool, "load", "(Landroid/content/res/AssetFileDescriptor;I)I", await mkAssetFd(new Uint8Array(7)), 1);
    expect(id).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 0)); await onMain(() => {});
    expect(decoded).toEqual([7]);
    expect(listener.loaded).toEqual([[id, 0]]);
  });
});
