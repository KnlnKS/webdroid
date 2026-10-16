// MediaPlayer's native half (mediaplayer.cpp over a media element). Its state machine answers a
// call in the wrong state with INVALID_OPERATION, which the JNI throws as IllegalStateException;
// events reach Java through postEventFromNative, as the player's listener posts them.
import { rt, driven, getDeclared, setDeclared, type JObj, type Gen } from "../jvm/runtime";
import { after, newObj, scall, vcall } from "../jvm/natives/jentry";
import { fdInt } from "../jvm/natives/jio";
import { readFully, type FileSource } from "../shell/lazyfile";
import { presentSurface, windowSurface, type GlSurface } from "./glsurface";
import { newAudioSessionId, setSounding } from "./audio-output";
import { dataSourceFile, fdSlice, nativePeer, postNativeEvent } from "./media-native";
import { guestEndpoint } from "../native/net-address";
import { deviceFetch } from "../shell/devicefetch";
import { nativeParcel, writeInt } from "./parcel";

const IDLE = 1, INITIALIZED = 2, PREPARING = 4, PREPARED = 8, STARTED = 16, PAUSED = 32, STOPPED = 64, COMPLETE = 128, ERROR = 0;
const MEDIA_PREPARED = 1, MEDIA_PLAYBACK_COMPLETE = 2, MEDIA_SEEK_COMPLETE = 4, MEDIA_SET_VIDEO_SIZE = 5,
  MEDIA_STARTED = 6, MEDIA_PAUSED = 7, MEDIA_STOPPED = 8, MEDIA_ERROR = 100, MEDIA_INFO = 200;
const MP = "android/media/MediaPlayer", PP = "android/media/PlaybackParams";
/** PlaybackParams' SET_* bits: which of its fields a setPlaybackParams call changes */
const SET_SPEED = 1, SET_PITCH = 2, SET_FALLBACK = 4, SET_STRETCH = 8;
export type Handler = ((event: Event) => void) | null;
/** the media element subset a player drives, which a process Worker reaches on the page */
export interface MediaElement {
  preload: string; loop: boolean; volume: number; src: string; playbackRate: number; preservesPitch: boolean; currentTime: number;
  readonly paused: boolean; readonly duration: number; readonly videoWidth: number; readonly videoHeight: number;
  readonly readyState: number; readonly error: { readonly code: number } | null;
  onplay: Handler; onpause: Handler; onended: Handler; onerror: Handler; onloadedmetadata: Handler; onseeked: Handler;
  play(): Promise<void>; pause(): void; load(): void;
  /** `show` gets the next frame the element presents */
  nextFrame(show: (frame: VideoFrame) => void): void;
}
let createElement = (): MediaElement => {
  const el = document.createElement("video");
  return Object.assign(el, { nextFrame: (show: (frame: VideoFrame) => void) => void el.requestVideoFrameCallback(() => show(new VideoFrame(el))) });
};
export const useMediaElements = (create: () => MediaElement): void => { createElement = create; };
/** a player plays through a media element; given a surface, each video frame the element shows is presented to it */
class Player {
  constructor(readonly ref: JObj, public sessionId: number) {}
  state = IDLE;
  media: MediaElement | null = null;
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
  /** the AudioPlaybackRate: the element plays at `speed`, and keeps its pitch only at pitch 1 */
  rate = { mSpeed: 1, mPitch: 1, mAudioFallbackMode: 0, mAudioStretchMode: 0 };
  applyRate(el: MediaElement): void {
    if (this.rate.mSpeed) el.playbackRate = this.rate.mSpeed;
    el.preservesPitch = this.rate.mPitch === 1;
  }
  play(): void {
    const el = this.media!;
    if (this.state === COMPLETE) el.currentTime = 0;
    this.state = STARTED;
    void el.play().then(() => { if (this.surface) this.pumpFrames(el); }).catch(() => { /* autoplay refused: the element stays paused */ });
  }
  post(what: number, arg1 = 0, arg2 = 0): void { postNativeEvent([MP, this.ref], null, what, arg1, arg2); }
  require(states: number): void {
    if (!(this.state & states)) throw rt.mkThrowable("java/lang/IllegalStateException", null);
  }
  unload(): void {
    const el = this.media;
    if (el) { el.pause(); setSounding(el, false); if (el.src.startsWith("blob:")) URL.revokeObjectURL(el.src); }
    this.media = null; this.rendering = false; this.prepared?.(1); this.prepared = null;
  }
  load(src: string | Promise<string>): void {
    this.require(IDLE);
    const el = this.media = createElement();
    el.preload = "none"; el.loop = this.looping; el.volume = this.volume;
    if (typeof src === "string") el.src = src;
    else src.then((url) => { if (this.media === el) el.src = url; else URL.revokeObjectURL(url); }, () => el.onerror?.(new Event("error")));
    this.applyRate(el);
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
  pumpFrames(el: MediaElement): void {
    let surface: unknown, target: GlSurface | null = null;
    const show = async (frame: VideoFrame) => {
      if (this.media !== el || el.paused) { frame.close(); return; }
      if (surface !== this.surface) { surface = this.surface; target = await windowSurface(surface); }
      if (target && frame.displayWidth) {
        presentSurface(target, frame);
        if (!this.rendering) { this.rendering = true; this.post(MEDIA_INFO, 3); }   // MEDIA_INFO_VIDEO_RENDERING_START
      } else frame.close();
      el.nextFrame(show);
    };
    el.nextFrame(show);
  }
}
// the EventHandler drops events once mNativeContext is 0
const players = nativePeer<Player>(MP, null, (p) => p.unload());
const M = players.on;
const loadFrom = (p: Player, source: FileSource | null) => {
  if (!source?.size) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
  return after(readFully(source), (bytes) => p.load(URL.createObjectURL(new Blob([bytes as BlobPart]))));
};
/** where the media element reads `url` with `headers`: through the proxy, or for a URL the device serves
 *  itself, read whole from the app's loopback server as the media server reads it, after its redirects */
function mediaSource(url: string, headers: [string, string][], hops = 0): string | Promise<string> {
  if (!guestEndpoint(url)) return `/proxy?url=${encodeURIComponent(url)}&headers=${encodeURIComponent(JSON.stringify(headers))}`;
  return deviceFetch(url, { headers: new Headers(headers.map(([k, v]): [string, string] => ["x-wd-" + k, v])) }).then(async (response) => {
    const status = Number(response.headers.get("x-wd-status")) || response.status, location = response.headers.get("location");
    if (status >= 300 && status < 400 && location && hops < 20) {
      await response.body?.cancel();
      return mediaSource(new URL(location, url).href, headers, hops + 1);
    }
    if (status < 200 || status > 299) throw new Error(`HTTP ${status}`);
    return URL.createObjectURL(await response.blob());
  });
}
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
  // a URL with a scheme other than file; only HTTP is fetched, through the proxy or from the app's own loopback server
  // MediaHTTPConnection, an HttpURLConnection, sends the app's headers and http.agent when they name no User-Agent
  "nativeSetDataSource(Landroid/os/IBinder;Ljava/lang/String;[Ljava/lang/String;[Ljava/lang/String;)V": M((p, _http: unknown, path: string, keys: string[] | null, values: string[] | null) => {
    if (!/^https?:/i.test(path)) throw rt.mkThrowable("java/io/IOException", "setDataSource failed.: status=0x80000000");
    const headers: [string, string][] = (keys ?? []).map((k, i) => [k, values?.[i] ?? ""]);
    if (headers.some(([k]) => k.toLowerCase() === "user-agent")) { p.load(mediaSource(path, headers)); return; }
    return after(scall("java/lang/System", "getProperty", "(Ljava/lang/String;)Ljava/lang/String;", "http.agent"), (agent: string | null) => {
      p.load(mediaSource(path, agent ? [...headers, ["User-Agent", agent]] : headers));
    });
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
    p.play();
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
  // MediaPlayerService's header over NuPlayerDriver's records: pause, then backward, forward and any seek, as BOOLEAN_VAL records
  "native_getMetadata(ZZLandroid/os/Parcel;)Z": M((p, _updateOnly: number, _filter: number, reply: JObj) => {
    const parcel = nativeParcel(reply), start = parcel.pos, seekable = Number.isFinite(p.media?.duration) ? 1 : 0;
    writeInt(parcel, 8 + 4 * 16); writeInt(parcel, 0x4d455441);
    for (const [key, on] of [[1, 1], [2, seekable], [3, seekable], [4, seekable]]) { writeInt(parcel, 16); writeInt(parcel, key); writeInt(parcel, 3); writeInt(parcel, on); }
    parcel.pos = start;
    return 1;
  }),
  // MediaPlayer::setPlaybackSettings: no player before a source or once stopped; a negative rate is
  // BAD_VALUE; speed 0 pauses a started player, and any other speed starts a prepared, paused or
  // completed one
  "setPlaybackParams(Landroid/media/PlaybackParams;)V": M((p, params: JObj | null) => {
    if (params === null) rt.npe();
    p.require(~(IDLE | STOPPED));
    const set = getDeclared<number>(params, PP, "mSet"), rate = { ...p.rate };
    for (const [bit, name] of [[SET_SPEED, "mSpeed"], [SET_PITCH, "mPitch"], [SET_FALLBACK, "mAudioFallbackMode"], [SET_STRETCH, "mAudioStretchMode"]] as const)
      if (set & bit) rate[name] = getDeclared<number>(params, PP, name);
    if (rate.mSpeed < 0 || rate.mPitch < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", null);
    p.rate = rate;
    if (p.media) p.applyRate(p.media);
    if (rate.mSpeed === 0 && p.state === STARTED) { p.media!.pause(); p.state = PAUSED; }
    else if (rate.mSpeed !== 0 && p.state & (PREPARED | PAUSED | COMPLETE)) p.play();
  }),
  "getPlaybackParams()Landroid/media/PlaybackParams;": M((p) => {
    p.require(~IDLE);
    return after(newObj(PP), (params: JObj) => setDeclared(params, PP, { mSet: SET_SPEED | SET_PITCH | SET_FALLBACK | SET_STRETCH, ...p.rate }));
  }),
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
