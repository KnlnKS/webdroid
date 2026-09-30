import { expect, test, describe } from "bun:test";
import "../src/natives";
import { rt, JObj } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";
import { systemService, JContext } from "../src/android/context";
import { vfs } from "../src/shell/vfs";
import { mangleMethod } from "../src/jvm/abi";
import { onMain } from "../src/android/mainloop";
import { mkAssetFd } from "../src/android/resnative";

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

  test("AudioFocusRequest retains builder state and AudioManager grants focus", async () => {
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
    expect(await vcall(rt.make("android/media/AudioManager"), "requestAudioFocus", "(Landroid/media/AudioFocusRequest;)I", request)).toBe(1);
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

describe("camera2", () => {
  rt.linkNatives();

  test("camera2 reports a device with no connected cameras", async () => {
    const manager = systemService(rt.make("android/content/Context"), "camera");
    expect(await vcall(manager, "getCameraIdList", "()[Ljava/lang/String;")).toHaveLength(0);
    const combinations = await vcall(manager, "getConcurrentCameraIds", "()Ljava/util/Set;");
    expect(await vcall(combinations, "isEmpty", "()Z")).toBe(1);
    await expect(vcallAsync(manager, "getCameraCharacteristics", "(Ljava/lang/String;)Landroid/hardware/camera2/CameraCharacteristics;", "0"))
      .rejects.toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
  });

  test("capture request builders retain keys, targets and tags", async () => {
    const builder = rt.make("android/hardware/camera2/CaptureRequest$Builder");
    const key = await newObj("android/hardware/camera2/CaptureRequest$Key", "(Ljava/lang/String;Ljava/lang/Class;)V", "mode", rt.classFor("java/lang/Integer"));
    const surface = rt.make("android/view/Surface");
    await vcall(builder, "set", "(Landroid/hardware/camera2/CaptureRequest$Key;Ljava/lang/Object;)V", key, "auto");
    await vcall(builder, "addTarget", "(Landroid/view/Surface;)V", surface);
    await vcall(builder, "setTag", "(Ljava/lang/Object;)V", "capture");
    const request = await vcall(builder, "build", "()Landroid/hardware/camera2/CaptureRequest;");
    expect(await vcall(request, "get", "(Landroid/hardware/camera2/CaptureRequest$Key;)Ljava/lang/Object;", key)).toBe("auto");
    expect(await vcall(request, "getTag", "()Ljava/lang/Object;")).toBe("capture");
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

describe("media-metadata", () => {
  rt.linkNatives();

  test("MediaMetadata builder preserves text and long values", async () => {
    const builder = await newObj("android/media/MediaMetadata$Builder");
    await vcall(builder, "putText", "(Ljava/lang/String;Ljava/lang/CharSequence;)Landroid/media/MediaMetadata$Builder;", "title", "Big Buck Bunny");
    await vcall(builder, "putLong", "(Ljava/lang/String;J)Landroid/media/MediaMetadata$Builder;", "duration", 636000n);
    const metadata = await vcall(builder, "build", "()Landroid/media/MediaMetadata;");
    expect(await vcall(metadata, "getText", "(Ljava/lang/String;)Ljava/lang/CharSequence;", "title")).toBe("Big Buck Bunny");
    expect(await vcall(metadata, "getLong", "(Ljava/lang/String;)J", "duration")).toBe(636000n);
    expect(await vcall(metadata, "containsKey", "(Ljava/lang/String;)Z", "missing")).toBe(0);
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
  rt.register({ name: "test/SessionContext", ctor: class extends JContext {}, sup: "android/content/Context", methods: {
    "getPackageName()Ljava/lang/String;": () => "test.session",
  } });
  rt.register({ name: "test/SessionCallback", ctor: class extends JObj {}, sup: "android/media/session/MediaSession$Callback", methods: {
    "onCommand(Ljava/lang/String;Landroid/os/Bundle;Landroid/os/ResultReceiver;)V": (command: string) => { commands.push(command); },
  } });
  rt.linkNatives();

  test("MediaSession keeps controller identity and dispatches commands through the callback looper", async () => {
    const context = rt.make("test/SessionContext");
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

  test("PlaybackState builders preserve immutable snapshots and 64-bit positions", async () => {
    const builder = await newObj("android/media/session/PlaybackState$Builder"), position = 9007199254740993n;
    await vcall(builder, "setState", "(IJFJ)Landroid/media/session/PlaybackState$Builder;", 3, position, 1.25, 45n);
    const first = await vcall(builder, "build", "()Landroid/media/session/PlaybackState;");
    await vcall(builder, "setState", "(IJFJ)Landroid/media/session/PlaybackState$Builder;", 2, 0n, 0, 80n);
    expect(await vcall(first, "getPosition", "()J")).toBe(position);
    expect(await vcall(first, "getState", "()I")).toBe(3);
    expect(await vcall(first, "getPlaybackSpeed", "()F")).toBe(1.25);
    expect(await vcall(first, "getLastPositionUpdateTime", "()J")).toBe(45n);
  });
});

describe("sensor-manager", () => {
  rt.linkNatives();

  const rotation = (r: Float32Array | null, i: Float32Array | null, gravity: Float32Array, field: Float32Array): number => {
    const fn = (rt.link("android/hardware/SensorManager").ctor as unknown as Record<string, unknown>)[mangleMethod("getRotationMatrix", "([F[F[F[F)Z")];
    if (typeof fn !== "function") throw new Error("getRotationMatrix is not linked");
    return (fn as (r: Float32Array | null, i: Float32Array | null, g: Float32Array, f: Float32Array) => number)(r, i, gravity, field);
  };

  test("SensorManager.getRotationMatrix produces Android's ENU basis", () => {
    const r = new Float32Array(9), i = new Float32Array(9);
    expect(rotation(r, i, new Float32Array([0, 0, 9.81]), new Float32Array([0, 1, 0]))).toBe(1);
    expect([...r]).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect([...i].map((v) => Math.abs(v))).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  test("SensorManager.getRotationMatrix supports 4x4 output and rejects free fall", () => {
    const r = new Float32Array(16);
    expect(rotation(r, null, new Float32Array([0, 0, 9.81]), new Float32Array([0, 1, 0]))).toBe(1);
    expect([...r]).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(rotation(r, null, new Float32Array([0, 0, 0]), new Float32Array([0, 1, 0]))).toBe(0);
  });

  test("SensorManager orientation uses the same axes in 3x3 and 4x4 matrices", () => {
    const fn = Reflect.get(rt.link("android/hardware/SensorManager").ctor, mangleMethod("getOrientation", "([F[F)[F"));
    if (typeof fn !== "function") throw new Error("getOrientation is not linked");
    for (const size of [9, 16]) {
      const r = new Float32Array(size), out = new Float32Array(3);
      rotation(r, null, new Float32Array([0, 0, 9.81]), new Float32Array([1, 0, 0]));
      expect(fn(r, out)).toBe(out);
      expect(out[0]).toBeCloseTo(-Math.PI / 2);
      expect(Math.abs(out[1]) + Math.abs(out[2])).toBe(0);
    }
  });
});

describe("tts", () => {
  rt.linkNatives();

  class InitListener extends JObj {
    statuses: number[] = [];
    [mangleMethod("onInit", "(I)V")](status: number) { this.statuses.push(status); }
  }

  test("TextToSpeech reports the unavailable browser service", async () => {
    const init = new InitListener();
    const tts = await newObj("android/speech/tts/TextToSpeech",
      "(Landroid/content/Context;Landroid/speech/tts/TextToSpeech$OnInitListener;Ljava/lang/String;)V", null, init, null);
    await new Promise((resolve) => setTimeout(resolve, 0)); await onMain(() => {});
    expect(init.statuses).toEqual([-1]);
    expect(await vcall(tts, "setLanguage", "(Ljava/util/Locale;)I", null)).toBe(-1);
    expect(await vcall(tts, "speak", "(Ljava/lang/CharSequence;ILandroid/os/Bundle;Ljava/lang/String;)I", "hello", 1, null, "one")).toBe(-1);
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
