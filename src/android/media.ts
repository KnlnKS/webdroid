// android.media's natives: MediaPlayer over a media element; SoundPool and AudioTrack over Web Audio.

import { rt, JObj, noops, driven, setDeclared, type Gen } from "../jvm/runtime";
import { handle, release } from "./handles";
import { jarray } from "../jvm/abi";
import { after, vcall, scall, newObj } from "../jvm/natives/jlang";
import { fdInt } from "../jvm/natives/jio";
import { javaFdSource } from "../native/fs";
import { readFully } from "../shell/lazyfile";
import { type JBuffer, bufferBytes } from "../jvm/natives/jnio";
import { uptimeMillis } from "../guest-clock";
import { onMain } from "./mainloop";
import { reportUncaught } from "./os";
import { presentSurface, windowSurface, type GlSurface } from "./glsurface";
import { hostStub } from "./binder";

/** the rate the Web Audio output actually runs at */
export const outputSampleRate = (): number => actx?.sampleRate ?? 44100;
let audioSession = 0;
export const newAudioSessionId = (): number => ++audioSession;

// No camera is attached (Camera.getNumberOfCameras is 0), so MediaProfiles holds no camcorder
// profile: get() fails as the native lookup does for a missing profile and getAll() finds none.
rt.claimNativeLib("media_jni");
rt.registerJnis("android/media/CamcorderProfile", {
  "native_init()V": () => {},
  "native_has_camcorder_profile(II)Z": () => 0,
  "native_get_camcorder_profile(II)Landroid/media/CamcorderProfile;": () => {
    throw rt.mkThrowable("java/lang/RuntimeException", "Error retrieving camcorder profile params");
  },
  "native_get_camcorder_profiles(IIZ)Landroid/media/EncoderProfiles;": () => null,
});

// The audio policy's product strategies, as the reference AVD's engine configuration lists them:
// [name, id, [volume group, legacy stream, [usage, content type, flags, tag][]][]]. AudioAttributes
// maps legacy stream types and volume streams through them.
const PRODUCT_STRATEGIES: [string, number, [number, number, [number, number, number, string?][]][]][] = [
  ["STRATEGY_PHONE", 15, [[14, 0, [[2, 0, 0]]], [4, 6, [[0, 0, 4]]]]],
  ["STRATEGY_SONIFICATION", 16, [[11, 2, [[6, 0, 0]]], [2, 4, [[4, 0, 0]]]]],
  ["STRATEGY_ENFORCED_AUDIBLE", 17, [[6, 7, [[0, 0, 1]]]]],
  ["STRATEGY_ACCESSIBILITY", 18, [[1, 10, [[11, 0, 0]]]]],
  ["STRATEGY_SONIFICATION_RESPECTFUL", 19, [[8, 5, [[5, 0, 0], [10, 0, 0]]]]],
  ["STRATEGY_MEDIA", 20, [[3, 11, [[16, 1, 0]]], [7, 3, [[1, 0, 0], [14, 0, 0], [16, 0, 0], [12, 0, 0], [0, 0, 0]]], [12, 1, [[13, 0, 0]]]]],
  ["STRATEGY_DTMF", 21, [[5, 8, [[3, 0, 0]]]]],
  ["STRATEGY_CALL_ASSISTANT", 22, [[23, 14, [[17, 0, 0]]]]],
  ["STRATEGY_TRANSMITTED_THROUGH_SPEAKER", 24, [[13, 9, [[0, 0, 8], [0, 1997, 0]]]]],
  ["STRATEGY_REROUTING", 25, [[10, 12, [[15, 0, 0, "reserved_internal_strategy"]]]]],
  ["STRATEGY_PATCH", 26, [[9, 13, [[0, 0, 0, "reserved_internal_strategy"]]]]],
];
const AAB = "Landroid/media/AudioAttributes$Builder;";
// AudioSystem: the audio framework's channel and sample rate limits, as the reference AVD reports
// them, and the Web Audio output. Its buffer is not a fixed number of frames, so the primary output
// reports no frame count. No device ports or patches are modelled, nothing is connected (no wired
// headset or A2DP), and nothing plays direct or offloaded.
const listNone = (_list: unknown, generation: Int32Array) => { generation[0] = 1; return 0; };
rt.registerJnis("android/media/AudioSystem", {
  "native_getMaxChannelCount()I": () => 12,
  "native_getMaxSampleRate()I": () => 192000,
  "native_getMinSampleRate()I": () => 4000,
  "newAudioSessionId()I": newAudioSessionId,
  "getPrimaryOutputSamplingRate()I": outputSampleRate,
  "getPrimaryOutputFrameCount()I": () => 0,
  "listAudioPorts(Ljava/util/ArrayList;[I)I": listNone,
  "listAudioPatches(Ljava/util/ArrayList;[I)I": listNone,
  "getDeviceConnectionState(ILjava/lang/String;)I": () => 0,
  "getParameters(Ljava/lang/String;)Ljava/lang/String;": () => "",
  "getDirectProfilesForAttributes(Landroid/media/AudioAttributes;Ljava/util/ArrayList;)I": () => 0,
  "getDirectPlaybackSupport(Landroid/media/AudioFormat;Landroid/media/AudioAttributes;)I": () => 0,
  "native_get_offload_support(IIIII)I": () => 0,
});
rt.registerJnis("android/media/audiopolicy/AudioProductStrategy", {
  "native_list_audio_product_strategies(Ljava/util/ArrayList;)I": driven(function* (list: unknown) {
    for (const [name, id, groups] of PRODUCT_STRATEGIES) {
      const built = [];
      for (const [volumeGroup, stream, attributes] of groups) {
        const all = [];
        for (const [usage, content, flags, tag] of attributes) {
          const builder = yield newObj("android/media/AudioAttributes$Builder");
          const system = yield scall("android/media/AudioAttributes", "isSystemUsage", "(I)Z", usage);
          yield vcall(builder, system ? "setSystemUsage" : "setUsage", "(I)" + AAB, usage);
          yield vcall(builder, "setInternalContentType", "(I)" + AAB, content);
          yield vcall(builder, "replaceFlags", "(I)" + AAB, flags);
          if (tag) yield vcall(builder, "addTag", "(Ljava/lang/String;)" + AAB, tag);
          all.push(yield vcall(builder, "build", "()Landroid/media/AudioAttributes;"));
        }
        built.push(yield newObj("android/media/audiopolicy/AudioProductStrategy$AudioAttributesGroup", "(II[Landroid/media/AudioAttributes;)V",
          volumeGroup, stream, jarray(all, "Landroid/media/AudioAttributes;")));
      }
      yield vcall(list, "add", "(Ljava/lang/Object;)Z", yield newObj("android/media/audiopolicy/AudioProductStrategy",
        "(Ljava/lang/String;I[Landroid/media/audiopolicy/AudioProductStrategy$AudioAttributesGroup;)V", name, id,
        jarray(built, "Landroid/media/audiopolicy/AudioProductStrategy$AudioAttributesGroup;")));
    }
    return 0;
  }),
});

// ── MediaPlayer's native half (mediaplayer.cpp over a media element). Its state machine answers
// a call in the wrong state with INVALID_OPERATION, which the JNI throws as IllegalStateException;
// events reach Java through postEventFromNative, as the player's listener posts them.
const IDLE = 1, INITIALIZED = 2, PREPARING = 4, PREPARED = 8, STARTED = 16, PAUSED = 32, STOPPED = 64, COMPLETE = 128, ERROR = 0;
const MEDIA_PREPARED = 1, MEDIA_PLAYBACK_COMPLETE = 2, MEDIA_SEEK_COMPLETE = 4, MEDIA_SET_VIDEO_SIZE = 5,
  MEDIA_STARTED = 6, MEDIA_PAUSED = 7, MEDIA_STOPPED = 8, MEDIA_ERROR = 100, MEDIA_INFO = 200;
const MP = "android/media/MediaPlayer";
/** a player plays through a media element; given a surface, each video frame the element shows is presented to it */
class Player {
  constructor(readonly ref: JObj, public sessionId: number) {}
  state = IDLE;
  media: HTMLVideoElement | null = null;
  looping = false;
  volume = 1;
  surface: JObj | null = null;
  /** a frame has reached the surface since the source was set */
  rendering = false;
  /** a synchronous prepare's outcome: resolved with 0 or MEDIA_ERROR's extra */
  prepared: ((status: number) => void) | null = null;
  streamType = 3;
  post(what: number, arg1 = 0, arg2 = 0): void {
    void onMain(() => scall(MP, "postEventFromNative", "(Ljava/lang/Object;IIILjava/lang/Object;)V", this.ref, what, arg1, arg2, null)).catch(reportUncaught);
  }
  require(states: number): void {
    if (!(this.state & states)) throw rt.mkThrowable("java/lang/IllegalStateException", null);
  }
  unload(): void {
    const el = this.media;
    if (el) { el.pause(); if (el.src.startsWith("blob:")) URL.revokeObjectURL(el.src); }
    this.media = null; this.rendering = false; this.prepared?.(1); this.prepared = null;
  }
  load(src: string): void {
    this.require(IDLE);
    const el = this.media = document.createElement("video");
    el.preload = "none"; el.src = src; el.loop = this.looping; el.volume = this.volume;
    const live = (f: () => void) => () => { if (this.media === el) f(); };
    el.onended = live(() => { if (!el.loop) { this.state = COMPLETE; this.post(MEDIA_PLAYBACK_COMPLETE); } });
    // MEDIA_ERROR_UNKNOWN with MEDIA_ERROR_UNSUPPORTED or _IO, as a decoder or source failure reports
    el.onerror = live(() => {
      const extra = el.error?.code === 4 ? -1010 : -1004;
      this.state = ERROR;
      if (this.prepared) { this.prepared(1); this.prepared = null; } else this.post(MEDIA_ERROR, 1, extra);
    });
    el.onloadedmetadata = live(() => {
      if (this.state !== PREPARING) return;
      this.state = PREPARED;
      this.post(MEDIA_SET_VIDEO_SIZE, el.videoWidth, el.videoHeight);
      this.post(MEDIA_PREPARED);
      this.prepared?.(0); this.prepared = null;
    });
    el.onseeked = live(() => this.post(MEDIA_SEEK_COMPLETE));
    this.state = INITIALIZED;
  }
  prepare(): void {
    this.require(INITIALIZED | STOPPED);
    this.state = PREPARING;
    const el = this.media!;
    el.preload = "auto";
    if (el.readyState >= 1) { el.currentTime = 0; queueMicrotask(() => el.onloadedmetadata?.(new Event("loadedmetadata"))); } else el.load();
  }
  /** each frame the element shows goes to the surface while it plays */
  pumpFrames(el: HTMLVideoElement): void {
    let surface: unknown, target: GlSurface | null = null;
    const next = async () => {
      if (this.media !== el || el.paused) return;
      if (surface !== this.surface) { surface = this.surface; target = await windowSurface(surface); }
      if (target && el.videoWidth) {
        presentSurface(target, new VideoFrame(el));
        if (!this.rendering) { this.rendering = true; this.post(MEDIA_INFO, 3); }   // MEDIA_INFO_VIDEO_RENDERING_START
      }
      el.requestVideoFrameCallback(next);
    };
    el.requestVideoFrameCallback(next);
  }
}
const players = new Map<JObj, Player>();
function player(mp: JObj): Player {
  const p = players.get(mp);
  if (!p) throw rt.mkThrowable("java/lang/IllegalStateException", null);
  return p;
}
const M = (f: (p: Player, ...a: any[]) => unknown) => function (this: JObj, ...a: unknown[]) { return f(player(this), ...a); };
/** AudioManager.isMusicActive: a MediaPlayer or a SoundPool stream is sounding right now */
export function isMusicActive(): number {
  for (const p of players.values()) if (p.media && !p.media.paused) return 1;
  for (const p of pools.values()) for (const s of p.streams.values()) if (s.src.playbackRate.value) return 1;
  return 0;
}
/** The bytes of a descriptor's range, or null when the descriptor or range is not readable */
async function fdRange(fd: JObj | null, offset: bigint, length: bigint) {
  if (fd === null) rt.npe();
  const source = javaFdSource(fdInt(fd));
  if (!source || offset < 0n || length <= 0n || offset >= BigInt(source.size)) return null;
  return readFully(source, Number(offset), Math.min(Number(length), source.size - Number(offset)));
}
function releasePlayer(this: JObj) {
  const p = players.get(this);
  if (!p) return;
  p.unload(); players.delete(this); release(handle(p));
  setDeclared(this, MP, { mNativeContext: 0n });
}
const loadBytes = (p: Player, bytes: Uint8Array | null) => {
  if (!bytes) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
  p.load(URL.createObjectURL(new Blob([bytes as BlobPart])));
};
const position = (p: Player) => Math.round((p.media?.currentTime ?? 0) * 1000);
rt.registerJnis(MP, {
  "native_init()V": () => {},
  "native_setup(Ljava/lang/Object;Landroid/os/Parcel;I)V": function (this: JObj, ref: JObj, _source: unknown, session: number) {
    const p = new Player(ref, session || newAudioSessionId());
    players.set(this, p);
    // the EventHandler drops events once mNativeContext is 0
    setDeclared(this, MP, { mNativeContext: handle(p) });
  },
  "_release()V": releasePlayer,
  "native_finalize()V": releasePlayer,
  "_reset()V": M((p) => { p.unload(); p.state = IDLE; }),
  "_setDataSource(Ljava/io/FileDescriptor;JJ)V": function (this: JObj, fd: JObj | null, offset: bigint, length: bigint) {
    const p = player(this);
    p.require(IDLE);
    return after(fdRange(fd, offset, length), (bytes) => loadBytes(p, bytes));
  },
  "_setDataSource(Landroid/media/MediaDataSource;)V": driven(function* setDataSource$(this: JObj, source: JObj): Gen {
    const p = player(this);
    p.require(IDLE);
    const size = Number(yield vcall(source, "getSize", "()J"));
    const bytes = new Int8Array(Math.max(0, size));
    for (let at = 0; at < size;) {
      const n: number = yield vcall(source, "readAt", "(J[BII)I", BigInt(at), bytes, at, size - at);
      if (n <= 0) break;
      at += n;
    }
    loadBytes(p, size > 0 ? new Uint8Array(bytes.buffer) : null);
  }),
  // a URL with a scheme other than file; only HTTP is fetched (through the proxy)
  "nativeSetDataSource(Landroid/os/IBinder;Ljava/lang/String;[Ljava/lang/String;[Ljava/lang/String;)V": function (this: JObj, _http: unknown, path: string) {
    if (!/^https?:/i.test(path)) throw rt.mkThrowable("java/io/IOException", "setDataSource failed.: status=0x80000000");
    player(this).load("/proxy?url=" + encodeURIComponent(path));
  },
  "_setVideoSurface(Landroid/view/Surface;)V": M((p, surface: JObj | null) => {
    p.surface = surface;
    if (surface && p.media && !p.media.paused) p.pumpFrames(p.media);
  }),
  "_prepare(Landroid/os/Parcel;)I": M((p) => {
    p.prepare();
    return new Promise<number>((resolve) => { p.prepared = resolve; }).then((status) => {
      if (status) throw rt.mkThrowable("java/io/IOException", `Prepare failed.: status=0x${status.toString(16).toUpperCase()}`);
      return 0;
    });
  }),
  "_prepareAsync(Landroid/os/Parcel;)I": M((p) => { p.prepare(); return 0; }),
  "_start()V": M((p) => {
    p.require(PREPARED | STARTED | PAUSED | COMPLETE);
    const el = p.media!;
    if (p.state === COMPLETE) el.currentTime = 0;
    p.state = STARTED;
    void el.play().then(() => { if (p.surface) p.pumpFrames(el); }).catch(() => { /* autoplay refused: the element stays paused */ });
    p.post(MEDIA_STARTED);
  }),
  "_pause()V": M((p) => {
    if (p.state & (PAUSED | COMPLETE)) return;
    p.require(STARTED);
    p.media!.pause(); p.state = PAUSED;
    p.post(MEDIA_PAUSED);
  }),
  "_stop()V": M((p) => {
    p.require(PREPARED | STARTED | PAUSED | STOPPED | COMPLETE);
    p.media!.pause(); p.media!.currentTime = 0; p.state = STOPPED;
    p.post(MEDIA_STOPPED);
  }),
  "_seekTo(JI)V": M((p, ms: bigint) => {
    p.require(PREPARED | STARTED | PAUSED | COMPLETE);
    p.media!.currentTime = Math.max(0, Number(ms)) / 1000;
  }),
  "isPlaying()Z": M((p) => p.media && !p.media.paused ? 1 : 0),
  "getCurrentPosition()I": M((p) => { p.require(~IDLE); return position(p); }),
  "getDuration()I": M((p) => {
    p.require(PREPARED | STARTED | PAUSED | STOPPED | COMPLETE);
    const d = p.media!.duration;
    return Number.isFinite(d) ? Math.round(d * 1000) : -1;
  }),
  "getVideoWidth()I": M((p) => { p.require(~IDLE); return p.media?.videoWidth ?? 0; }),
  "getVideoHeight()I": M((p) => { p.require(~IDLE); return p.media?.videoHeight ?? 0; }),
  "setLooping(Z)V": M((p, loop: number) => { p.looping = !!loop; if (p.media) p.media.loop = p.looping; }),
  "isLooping()Z": M((p) => +p.looping),
  "_setVolume(FF)V": M((p, l: number, r: number) => { p.volume = Math.min(1, Math.max(l, r)); if (p.media) p.media.volume = p.volume; }),
  "_setAudioStreamType(I)V": M((p, type: number) => { p.streamType = type; }),
  "_getAudioStreamType()I": M((p) => p.streamType),
  "getAudioSessionId()I": M((p) => p.sessionId),
  "native_setAudioSessionId(I)V": M((p, id: number) => { p.require(IDLE); p.sessionId = id; }),
  // KEY_PARAMETER_AUDIO_ATTRIBUTES and the like: the element plays every usage alike
  "setParameter(ILandroid/os/Parcel;)Z": () => 1,
  // INVOKE_ID_GET_TRACK_INFO: the media element exposes no per-track metadata, so no tracks are listed
  "native_invoke(Landroid/os/Parcel;Landroid/os/Parcel;)I": driven(function* invoke$(request: JObj, reply: JObj): Gen {
    yield vcall(request, "setDataPosition", "(I)V", 0);
    yield vcall(request, "enforceInterface", "(Ljava/lang/String;)V", "android.media.IMediaPlayer");
    if ((yield vcall(request, "readInt", "()I")) !== 1) return -38;   // INVALID_OPERATION
    yield vcall(reply, "writeInt", "(I)V", 0);
    return 0;
  }),
  "native_enableDeviceCallback(Z)V": () => {},
  "native_getRoutedDeviceId()I": () => 0,
});

// ── SoundPool's native half: one shared AudioContext (never closed), a decoded AudioBuffer per
// sample id (null while decoding), and a one-shot source + gain node per stream id.
let actx: AudioContext | null = null;
type Stream = { src: AudioBufferSourceNode; gain: GainNode; prio: number; rate: number; volume: number };
class Pool {
  constructor(readonly owner: JObj, readonly maxStreams: number) {}
  sounds = new Map<number, AudioBuffer | null>();
  streams = new Map<number, Stream>();
  nextId = 1;
  nextStream = 1;
  muted = false;
  load(bytes: Uint8Array | null): number {
    if (!bytes) return 0;
    const id = this.nextId++;
    this.sounds.set(id, null);
    // decodeAudioData detaches the buffer it is given, so the bytes are copied first
    (actx ??= new AudioContext()).decodeAudioData(bytes.slice().buffer as ArrayBuffer)
      .then((buf) => this.decoded(id, buf, 0), () => this.decoded(id, null, 1));
    return id;
  }
  /** SoundPool::Sound's SAMPLE_LOADED event, through the Java pool's event handler */
  decoded(id: number, buf: AudioBuffer | null, status: number) {
    if (!this.sounds.has(id)) return; // unloaded or released before the decode finished
    if (buf) this.sounds.set(id, buf);
    void onMain(() => vcall(this.owner, "postEventFromNative", "(IIILjava/lang/Object;)V", 1, id, status, null)).catch(reportUncaught);
  }
  stop(sid: number) {
    const s = this.streams.get(sid);
    if (s) { s.src.stop(); this.streams.delete(sid); }
  }
  each(sid: number, f: (s: Stream) => void) { const s = this.streams.get(sid); if (s) f(s); }
  release() { for (const s of this.streams.values()) s.src.stop(); this.streams.clear(); this.sounds.clear(); }
}
const pools = new Map<JObj, Pool>();
const pool = (p: JObj): Pool => {
  const found = pools.get(p);
  if (!found) throw rt.mkThrowable("java/lang/IllegalStateException", "SoundPool released");
  return found;
};
const P = (f: (p: Pool, ...a: any[]) => unknown) => function (this: JObj, ...a: unknown[]) { return f(pool(this), ...a); };
rt.claimNativeLib("soundpool");
rt.registerJnis("android/media/SoundPool", {
  "native_setup(ILjava/lang/Object;Ljava/lang/String;)I": function (this: JObj, maxStreams: number) { pools.set(this, new Pool(this, maxStreams)); return 0; },
  "native_release()V": function (this: JObj) { pools.get(this)?.release(); pools.delete(this); },
  "_load(Ljava/io/FileDescriptor;JJI)I": function (this: JObj, fd: JObj | null, offset: bigint, length: bigint) {
    return after(fdRange(fd, offset, length), (bytes) => pool(this).load(bytes));
  },
  "_play(IFFIIFI)I": P((p, id: number, l: number, r: number, prio: number, loop: number, rate: number) => {
    const buf = p.sounds.get(id);
    if (!buf || !actx) return 0;
    // reached from a pointer-driven main-looper job, i.e. inside the user-activation window
    if (actx.state === "suspended") void actx.resume();
    if (p.streams.size >= p.maxStreams) {
      // the lowest-priority stream at or below the newcomer's yields, else the newcomer is refused
      let v: [number, Stream] | undefined;
      for (const e of p.streams) if (e[1].prio <= prio && (!v || e[1].prio < v[1].prio)) v = e;
      if (!v) return 0;
      p.stop(v[0]);
    }
    const src = actx.createBufferSource();
    src.buffer = buf; src.loop = loop !== 0; src.playbackRate.value = rate;
    const gain = actx.createGain(), volume = Math.max(l, r);
    gain.gain.value = p.muted ? 0 : volume;
    src.connect(gain).connect(actx.destination);
    const sid = p.nextStream++;
    src.onended = () => p.streams.delete(sid);
    src.start();
    // loop = n > 0 means n + 1 plays: keep looping and schedule the end (at the starting rate)
    if (loop > 0) src.stop(actx.currentTime + (buf.duration * (loop + 1)) / rate);
    p.streams.set(sid, { src, gain, prio, rate, volume });
    return sid;
  }),
  "stop(I)V": P((p, sid: number) => p.stop(sid)),
  // Web Audio sources cannot pause; a zero playback rate holds the position instead
  "pause(I)V": P((p, sid: number) => p.each(sid, (s) => { s.src.playbackRate.value = 0; })),
  "resume(I)V": P((p, sid: number) => p.each(sid, (s) => { s.src.playbackRate.value = s.rate; })),
  "autoPause()V": P((p) => { for (const s of p.streams.values()) s.src.playbackRate.value = 0; }),
  "autoResume()V": P((p) => { for (const s of p.streams.values()) s.src.playbackRate.value = s.rate; }),
  "_setVolume(IFF)V": P((p, sid: number, l: number, r: number) => p.each(sid, (s) => { s.volume = Math.max(l, r); if (!p.muted) s.gain.gain.value = s.volume; })),
  "_mute(Z)V": P((p, muted: number) => { p.muted = !!muted; for (const s of p.streams.values()) s.gain.gain.value = p.muted ? 0 : s.volume; }),
  "setLoop(II)V": P((p, sid: number, loop: number) => p.each(sid, (s) => { s.src.loop = loop !== 0; })),
  "setRate(IF)V": P((p, sid: number, rate: number) => p.each(sid, (s) => { if (s.src.playbackRate.value) s.src.playbackRate.value = rate; s.rate = rate; })),
  "setPriority(II)V": P((p, sid: number, prio: number) => p.each(sid, (s) => { s.prio = prio; })),
  "unload(I)Z": P((p, id: number) => +p.sounds.delete(id)),
});

// ── AudioTrack's native half (MODE_STREAM): PCM written from Java is scheduled back-to-back on the
// shared AudioContext. The periodic position event is what streaming mixers (a native engine's
// SoundPlayer) refill from, so it fires whenever the queue runs below a few periods.
const bitCount = (mask: number) => { let n = 0; for (; mask; mask &= mask - 1) n++; return n; };
/** bytes per sample of ENCODING_PCM_16BIT, _8BIT and _FLOAT, the encodings Web Audio can play */
const PCM_BYTES: Record<number, number> = { 2: 2, 3: 1, 4: 4 };
/** the frames AudioFlinger's minimum buffer holds, about 100 ms of output */
const minFrames = (rate: number) => Math.max(1024, Math.ceil(rate / 10));
/** PCM scheduled on the AudioContext, for a Java AudioTrack or an AAudio stream */
export class PcmOutput {
  rate = 44100; channels = 2; bytesPerSample = 2; bufBytes = 0;
  sessionId = 0;
  playing = false; nextTime = 0; written = 0; played = 0; underruns = 0;
  queue: { buffer: AudioBuffer; offset: number; start: number; source: AudioBufferSourceNode | null; consumed?: () => void }[] = [];
  gain: GainNode | null = null;
  vol = 1;
  ctx(): AudioContext { return (actx ??= new AudioContext()); }
  frameBytes(): number { return this.channels * this.bytesPerSample; }
  head(): number {
    const now = this.queue.length ? this.ctx().currentTime : 0;
    return this.played + this.queue.reduce((frames, entry) => frames + Math.min(entry.buffer.length,
      entry.offset + (entry.source ? Math.max(0, now - entry.start) * this.rate : 0)), 0);
  }
  queuedSec(): number { return Math.max(0, this.written - this.head()) / this.rate; }
  setVolume(v: number): void { this.vol = v; if (this.gain) this.gain.gain.value = v; }
  schedule(): void {
    const ctx = this.ctx();
    if (!this.gain) { this.gain = ctx.createGain(); this.gain.gain.value = this.vol; this.gain.connect(ctx.destination); }
    for (const entry of this.queue) {
      if (entry.source) continue;
      const source = entry.source = ctx.createBufferSource();
      source.buffer = entry.buffer; source.connect(this.gain);
      entry.start = Math.max(this.nextTime, ctx.currentTime + 0.02);
      source.onended = () => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1); this.played += entry.buffer.length; source.disconnect();
        this.drained();
        entry.consumed?.();
      };
      source.start(entry.start, entry.offset / this.rate);
      this.nextTime = entry.start + (entry.buffer.length - entry.offset) / this.rate;
    }
  }
  drained(): void {}
  play(): void { this.playing = true; void this.ctx().resume(); this.schedule(); }
  pauseQueue(): void {
    this.playing = false;
    const now = this.queue.length ? this.ctx().currentTime : 0;
    for (const entry of this.queue) {
      if (!entry.source) continue;
      entry.offset = Math.min(entry.buffer.length, entry.offset + Math.max(0, now - entry.start) * this.rate);
      entry.source.onended = null; entry.source.stop(); entry.source.disconnect(); entry.source = null;
    }
    this.nextTime = 0;
  }
  clearQueue(): void { this.pauseQueue(); this.queue = []; this.written = this.played = 0; }
  release(): void { this.clearQueue(); this.gain?.disconnect(); this.gain = null; }
  /** interleaved 16-bit, 8-bit unsigned or float PCM → one scheduled buffer */
  push(samples: Int16Array | Int8Array | Float32Array, frames: number, consumed?: () => void): void {
    if (frames <= 0) return;
    const buf = this.ctx().createBuffer(this.channels, frames, this.rate);
    for (let c = 0; c < this.channels; c++) {
      const ch = buf.getChannelData(c);
      if (samples instanceof Float32Array) for (let i = 0; i < frames; i++) ch[i] = samples[i * this.channels + c];
      else if (samples instanceof Int16Array) for (let i = 0; i < frames; i++) ch[i] = samples[i * this.channels + c] / 32768;
      else for (let i = 0; i < frames; i++) ch[i] = ((samples[i * this.channels + c] & 0xff) - 128) / 128;
    }
    if (this.playing && this.written && this.queuedSec() === 0) this.underruns++;
    this.queue.push({ buffer: buf, offset: 0, start: 0, source: null, consumed });
    this.written += frames;
    if (this.playing) this.schedule();
  }
}

const AT = "android/media/AudioTrack";
/** a Java AudioTrack's native track, which posts position events back through its WeakReference */
class Track extends PcmOutput {
  constructor(readonly ref: JObj) { super(); }
  stopped = true; origin = 0; period = 0; marker = 0; markerSent = false;
  timer: ReturnType<typeof setInterval> | null = null;
  override drained(): void { if (!this.queue.length && this.stopped) this.played = this.written = this.origin = 0; }
  post(what: number): void {
    void onMain(() => scall(AT, "postEventFromNative", "(Ljava/lang/Object;IIILjava/lang/Object;)V", this.ref, what, 0, 0, null)).catch(reportUncaught);
  }
  position(): number { return this.stopped && !this.queue.length ? 0 : Math.floor(this.head() - this.origin); }
  /** refill until ~3 periods are queued: each NATIVE_EVENT_NEW_POS is one write of one period */
  tick(): void {
    if (!this.playing) return;
    if (this.marker > 0 && !this.markerSent && this.position() >= this.marker) { this.markerSent = true; this.post(3); }
    if (this.period && this.queuedSec() < 3 * this.period / this.rate) this.post(4);
  }
  startTimer(): void {
    if (this.timer || (!this.period && !this.marker)) return;
    this.timer = setInterval(() => this.tick(), Math.max(5, (this.period || 1024) / this.rate * 500));
  }
  stopTimer(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  /** a blocking write waits while the buffer is full, which is what paces a writer loop; a
   *  non-blocking one takes what fits */
  write(blocking: boolean, frames: number, take: (frames: number) => void): number | Promise<number> {
    const room = () => Math.max(0, Math.floor(this.bufBytes / this.frameBytes() - this.queuedSec() * this.rate));
    if (!blocking) { const n = Math.min(frames, room()); take(n); return n; }
    take(frames);
    const excess = this.queuedSec() - this.bufBytes / this.frameBytes() / this.rate;
    return excess > 0.005 ? new Promise((r) => setTimeout(() => r(frames), excess * 1000)) : frames;
  }
}
const tracks = new WeakMap<JObj, Track>();
function track(t: JObj): Track {
  const tr = tracks.get(t);
  if (!tr) throw rt.mkThrowable("java/lang/IllegalStateException", "Unable to retrieve AudioTrack pointer");
  return tr;
}
/** a write of `count` samples starting at `off`, answered in samples (bytes for byte[]) as the JNI does */
function writeSamples(t: JObj, data: Int16Array | Int8Array | Float32Array, off: number, count: number, format: number, blocking: number) {
  const tr = tracks.get(t);
  if (!tr) return -3;
  if (PCM_BYTES[format] !== tr.bytesPerSample) return -2;
  const unit = data instanceof Int8Array ? tr.bytesPerSample : 1;
  const frames = Math.floor(count / unit / tr.channels);
  return after(tr.write(!!blocking, frames, (n) => {
    const n0 = n * tr.channels * unit;
    // byte[] PCM wider than 8 bits is copied out to an aligned buffer
    tr.push(data instanceof Int8Array && tr.bytesPerSample !== 1
      ? new (tr.bytesPerSample === 2 ? Int16Array : Float32Array)(new Uint8Array(data.buffer, data.byteOffset + off, n0).slice().buffer)
      : data.subarray(off, off + n0), n);
  }), (n) => n * tr.channels * unit);
}
rt.registerJnis(AT, {
  "native_setup(Ljava/lang/Object;Ljava/lang/Object;[IIIIII[ILandroid/os/Parcel;JZILjava/lang/Object;Ljava/lang/String;)I": function (this: JObj,
    ref: JObj, _attributes: unknown, rate: Int32Array, channelMask: number, indexMask: number, format: number, bufBytes: number, mode: number, session: Int32Array) {
    // MODE_STATIC's shared-memory buffer is not modelled: AUDIOTRACK_ERROR_SETUP_NATIVEINITFAILED
    if (mode !== 1 || !PCM_BYTES[format]) return -20;
    const tr = new Track(ref);
    tr.rate = rate[0] || outputSampleRate(); tr.channels = bitCount(indexMask || channelMask); tr.bytesPerSample = PCM_BYTES[format];
    tr.bufBytes = Math.max(bufBytes, minFrames(tr.rate) * tr.frameBytes());
    tr.sessionId = session[0] ||= newAudioSessionId();
    rate[0] = tr.rate;
    tracks.set(this, tr);
    return 0;
  },
  "native_start()V": function (this: JObj) { const tr = track(this); if (tr.stopped) { tr.origin = tr.head(); tr.markerSent = false; } tr.stopped = false; tr.play(); tr.startTimer(); },
  "native_pause()V": function (this: JObj) { const tr = track(this); tr.pauseQueue(); tr.stopTimer(); },
  // a stopped stream plays out what it was given
  "native_stop()V": function (this: JObj) { const tr = track(this); tr.stopped = true; if (!tr.playing || !tr.queue.length) tr.clearQueue(); tr.stopTimer(); },
  "native_flush()V": function (this: JObj) { const tr = track(this); if (!tr.playing) { tr.clearQueue(); tr.origin = 0; } },
  "native_release()V": function (this: JObj) { const tr = tracks.get(this); if (tr) { tr.stopTimer(); tr.release(); tracks.delete(this); } },
  "native_finalize()V": function (this: JObj) { tracks.get(this)?.release(); tracks.delete(this); },
  "native_write_byte([BIIIZ)I": function (this: JObj, d: Int8Array, off: number, n: number, f: number, b: number) { return writeSamples(this, d, off, n, f, b); },
  "native_write_short([SIIIZ)I": function (this: JObj, d: Int16Array, off: number, n: number, f: number, b: number) { return writeSamples(this, d, off, n, f, b); },
  "native_write_float([FIIIZ)I": function (this: JObj, d: Float32Array, off: number, n: number, f: number, b: number) { return writeSamples(this, d, off, n, f, b); },
  "native_write_native_bytes(Ljava/nio/ByteBuffer;IIIZ)I": function (this: JObj, buffer: JBuffer, pos: number, n: number, f: number, b: number) {
    const bytes = bufferBytes(buffer);
    return writeSamples(this, new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length), pos, n, f, b);
  },
  "native_get_position()I": function (this: JObj) { return track(this).position() | 0; },
  "native_get_timestamp([J)I": function (this: JObj, out: BigInt64Array) {
    const tr = track(this);
    if (!tr.playing || !tr.written) return -7;   // ERROR_WOULD_BLOCK until frames are presented
    out[0] = BigInt(tr.position()); out[1] = BigInt(Math.floor(uptimeMillis() * 1e6));
    return 0;
  },
  // AudioTrack::latency(): the output's latency plus the track's own buffer, in ms
  "native_get_latency()I": function (this: JObj) {
    const tr = track(this), ctx = tr.ctx();
    return Math.round(((ctx.outputLatency || ctx.baseLatency) + tr.bufBytes / tr.frameBytes() / tr.rate) * 1000);
  },
  "native_setVolume(FF)V": function (this: JObj, l: number, r: number) { track(this).setVolume(Math.max(l, r)); },
  "native_set_pos_update_period(I)I": function (this: JObj, period: number) { const tr = track(this); tr.period = period; if (tr.playing) tr.startTimer(); return 0; },
  "native_get_pos_update_period()I": function (this: JObj) { return track(this).period; },
  "native_set_marker_pos(I)I": function (this: JObj, marker: number) { const tr = track(this); tr.marker = marker; tr.markerSent = false; if (tr.playing) tr.startTimer(); return 0; },
  "native_get_marker_pos()I": function (this: JObj) { return track(this).marker; },
  "native_get_buffer_size_frames()I": function (this: JObj) { const tr = track(this); return tr.bufBytes / tr.frameBytes(); },
  "native_get_buffer_capacity_frames()I": function (this: JObj) { const tr = track(this); return tr.bufBytes / tr.frameBytes(); },
  "native_get_underrun_count()I": function (this: JObj) { return track(this).underruns; },
  "native_get_playback_rate()I": function (this: JObj) { return track(this).rate; },
  "native_get_flags()I": () => 0,
  "native_getRoutedDeviceId()I": () => 0,
  "native_getPortId()I": () => 0,
  // the output never changes route, so no routing event is ever posted; no AudioFlinger reads the ids
  "native_enableDeviceCallback()V": () => {}, "native_disableDeviceCallback()V": () => {},
  "native_setPlayerIId(I)V": () => {}, "native_setLogSessionId(Ljava/lang/String;)V": () => {},
  "native_get_min_buff_size(III)I": (rate: number, channels: number, format: number) =>
    PCM_BYTES[format] ? minFrames(rate) * channels * PCM_BYTES[format] : -1,
  "native_get_output_sample_rate(I)I": outputSampleRate,
  "native_is_direct_output_supported(IIIIIII)Z": () => 0,
});
// No capture device is modelled: AudioRecord's setup fails as AUDIORECORD_ERROR_SETUP_NATIVEINITFAILED.
rt.registerJnis("android/media/AudioRecord", {
  "native_setup(Ljava/lang/Object;Ljava/lang/Object;[IIIII[ILandroid/os/Parcel;JII)I": () => -20,
  "native_get_min_buff_size(III)I": (rate: number, channels: number, format: number) =>
    rate >= 4000 && rate <= 192000 && PCM_BYTES[format] ? Math.max(256, Math.ceil(rate / 10) * channels * PCM_BYTES[format]) : 0,
  "native_release()V": () => {}, "native_finalize()V": () => {},
});
rt.registerJni("android/media/MediaRecorder", "native_init()V", () => {});

// IMediaRouterService, under AOSP's MediaRouter: no remote display provider is installed, so the
// global state holds no routes (dumpsys media_router on the reference AVD: routes=[]) and an app
// has only the default audio and video route MediaRouter makes itself
const MRC = "Landroid/media/IMediaRouterClient;";
rt.register({ name: "webdroid/MediaRouterService", ctor: class extends JObj {}, sup: "android/media/IMediaRouterService$Stub", methods: {
  [`getState(${MRC})Landroid/media/MediaRouterClientState;`]: () => newObj("android/media/MediaRouterClientState"),
  // AudioPlayerStateMonitor's view of the client's uid: its own players
  [`isPlaybackActive(${MRC})Z`]: isMusicActive,
  ...noops(`registerClientAsUser(${MRC}Ljava/lang/String;I)V`, `unregisterClient(${MRC})V`, `setDiscoveryRequest(${MRC}IZ)V`,
    `setSelectedRoute(${MRC}Ljava/lang/String;Z)V`),
} });
hostStub("media_router", "webdroid/MediaRouterService");

