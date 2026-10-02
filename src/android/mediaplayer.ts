// MediaPlayer's native half (mediaplayer.cpp over a media element). Its state machine answers a
// call in the wrong state with INVALID_OPERATION, which the JNI throws as IllegalStateException;
// events reach Java through postEventFromNative, as the player's listener posts them.
import { rt, driven, type JObj, type Gen } from "../jvm/runtime";
import { after, vcall } from "../jvm/natives/jlang";
import { fdInt } from "../jvm/natives/jio";
import { readFully, type FileSource } from "../shell/lazyfile";
import { presentSurface, windowSurface, type GlSurface } from "./glsurface";
import { newAudioSessionId, setSounding } from "./audio-output";
import { dataSourceFile, fdSlice, nativePeer, postNativeEvent } from "./media-native";

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
  /** seeks the app asked for that the element has not completed: only they report MEDIA_SEEK_COMPLETE */
  seeks = 0;
  /** a synchronous prepare's outcome: resolved with 0 or MEDIA_ERROR's extra */
  prepared: ((status: number) => void) | null = null;
  streamType = 3;
  post(what: number, arg1 = 0, arg2 = 0): void { postNativeEvent([MP, this.ref], null, what, arg1, arg2); }
  require(states: number): void {
    if (!(this.state & states)) throw rt.mkThrowable("java/lang/IllegalStateException", null);
  }
  unload(): void {
    const el = this.media;
    if (el) { el.pause(); setSounding(el, false); if (el.src.startsWith("blob:")) URL.revokeObjectURL(el.src); }
    this.media = null; this.rendering = false; this.prepared?.(1); this.prepared = null;
  }
  load(src: string): void {
    this.require(IDLE);
    const el = this.media = document.createElement("video");
    el.preload = "none"; el.src = src; el.loop = this.looping; el.volume = this.volume;
    this.seeks = 0;
    const live = (f: () => void) => () => { if (this.media === el) f(); };
    el.onplay = live(() => setSounding(el, true));
    el.onpause = () => setSounding(el, false);
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
    // a later seek supersedes a pending one, which completes with it
    el.onseeked = live(() => { if (this.seeks) { this.seeks = 0; this.post(MEDIA_SEEK_COMPLETE); } });
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
// the EventHandler drops events once mNativeContext is 0
const players = nativePeer<Player>(MP, null, (p) => p.unload());
const M = players.on;
const loadFrom = (p: Player, source: FileSource | null) => {
  if (!source?.size) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
  return after(readFully(source), (bytes) => p.load(URL.createObjectURL(new Blob([bytes as BlobPart]))));
};
const position = (p: Player) => Math.round((p.media?.currentTime ?? 0) * 1000);
rt.registerJnis(MP, {
  "native_init()V": () => {},
  "native_setup(Ljava/lang/Object;Landroid/os/Parcel;I)V": function (this: JObj, ref: JObj, _source: unknown, session: number) {
    players.attach(this, new Player(ref, session || newAudioSessionId()));
  },
  "_release()V": players.detach,
  "native_finalize()V": players.detach,
  "_reset()V": M((p) => { p.unload(); p.state = IDLE; }),
  "_setDataSource(Ljava/io/FileDescriptor;JJ)V": M((p, fd: JObj | null, offset: bigint, length: bigint) => {
    p.require(IDLE);
    if (fd === null) rt.npe();
    return loadFrom(p, fdSlice(fdInt(fd), offset, length));
  }),
  "_setDataSource(Landroid/media/MediaDataSource;)V": M((p, source: JObj) => {
    p.require(IDLE);
    return after(dataSourceFile(source), (file) => loadFrom(p, file));
  }),
  // a URL with a scheme other than file; only HTTP is fetched (through the proxy)
  "nativeSetDataSource(Landroid/os/IBinder;Ljava/lang/String;[Ljava/lang/String;[Ljava/lang/String;)V": M((p, _http: unknown, path: string) => {
    if (!/^https?:/i.test(path)) throw rt.mkThrowable("java/io/IOException", "setDataSource failed.: status=0x80000000");
    p.load("/proxy?url=" + encodeURIComponent(path));
  }),
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
    p.seeks++;
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
