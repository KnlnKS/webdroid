// android.media: MediaPlayer over HTMLAudioElement, SoundPool over Web Audio.

import { rt, JObj, stubs, noops, fieldGetters, driven, type Gen } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import { after, vcall, scall, newObj, staticField, vcallUncaught } from "../jvm/natives/jlang";
import { newArrayList, newStringSet } from "../jvm/natives/jcoll";
import { fdInt } from "../jvm/natives/jio";
import { vfs } from "../shell/vfs";
import { javaFdSource } from "../native/fs";
import { readFully } from "../shell/lazyfile";
import { type JBuffer, limit, position, remainingBytes, setPosition } from "../jvm/natives/jnio";
import { onMain } from "./mainloop";
import { JBundle, reportUncaught } from "./os";
import { mkUri, uriParts, type JUri } from "./net";
import { csText } from "../jvm/natives/jchars";
import { scannedMediaUri } from "./mediastore";
import { presentSurface, windowSurface, type GlSurface } from "./glsurface";
import { hostStub } from "./binder";

rt.markers("android/media/ImageReader$OnImageAvailableListener");
/** the rate the Web Audio output actually runs at */
export const outputSampleRate = (): number => actx?.sampleRate ?? 44100;
let audioSession = 0;
export const newAudioSessionId = (): number => ++audioSession;

class JCamcorderProfile extends JObj {
  duration = 0; quality = 0; fileFormat = 0;
  videoCodec = 0; videoBitRate = 0; videoFrameRate = 0; videoFrameWidth = 0; videoFrameHeight = 0;
  audioCodec = 0; audioBitRate = 0; audioSampleRate = 0; audioChannels = 0;
}
function checkCamcorderQuality(quality: number): void {
  if ((quality >= 0 && quality <= 13) || (quality >= 1000 && quality <= 1013) ||
      (quality >= 2000 && quality <= 2008)) return;
  throw rt.mkThrowable("java/lang/IllegalArgumentException", `Unsupported quality level: ${quality}`);
}
rt.register({
  name: "android/media/CamcorderProfile", ctor: JCamcorderProfile,
  fields: ["duration", "quality", "fileFormat", "videoCodec", "videoBitRate", "videoFrameRate",
    "videoFrameWidth", "videoFrameHeight", "audioCodec", "audioBitRate", "audioSampleRate", "audioChannels"],
  methods: {
    "static get(I)Landroid/media/CamcorderProfile;": () => null,
    "static get(II)Landroid/media/CamcorderProfile;": (_cameraId: number, quality: number) => {
      checkCamcorderQuality(quality);
      return null;
    },
    "static hasProfile(I)Z": () => 0,
    "static hasProfile(II)Z": () => 0,
    "static getAll(Ljava/lang/String;I)Landroid/media/EncoderProfiles;": (_cameraId: string, quality: number) => {
      checkCamcorderQuality(quality);
      return null;
    },
  },
});
rt.register({ name: "android/media/EncoderProfiles", ctor: class extends JObj {} });

rt.register({ name: "android/media/Image", ctor: class extends JObj {}, ifaces: ["java/lang/AutoCloseable"] });
rt.register({ name: "android/media/MediaDataSource", ctor: class extends JObj {}, ifaces: ["java/io/Closeable"],
  methods: noops("<init>()V"),
});

rt.register({
  name: "android/media/session/MediaController$Callback", ctor: class extends JObj {},
  methods: { ...noops("<init>()V") },
});
class JPlaybackCustomAction extends JObj {
  action = "";
  name: unknown = null;
  icon = 0;
  extras: unknown = null;
}
class JPlaybackCustomActionBuilder extends JObj {
  value = new JPlaybackCustomAction();
}
class JPlaybackState extends JObj {
  state = 0;
  position = 0n;
  bufferedPosition = 0n;
  speed = 0;
  actions = 0n;
  errorMessage: unknown = null;
  updateTime = 0n;
  customActions: unknown = null;
  activeQueueItemId = -1n;
  extras: unknown = null;
}
class JPlaybackStateBuilder extends JObj {
  value = new JPlaybackState();
  customActions: unknown[] = [];
}
class JMediaMetadata extends JObj { values = new Map<string, unknown>(); description: JMediaDescription | null = null; }
class JMediaMetadataBuilder extends JObj { value = new JMediaMetadata(); }
class JMediaDescription extends JObj {
  mediaId: string | null = null;
  title: unknown = null;
  subtitle: unknown = null;
  description: unknown = null;
  iconBitmap: unknown = null;
  iconUri: unknown = null;
  extras: JBundle | null = null;
  mediaUri: unknown = null;
}
class JMediaDescriptionBuilder extends JObj { value = new JMediaDescription(); }
rt.register({ name: "android/media/MediaDescription", ctor: JMediaDescription, ifaces: ["android/os/Parcelable"], methods: {
  ...fieldGetters({
    "getMediaId()Ljava/lang/String;": "mediaId",
    "getTitle()Ljava/lang/CharSequence;": "title",
    "getSubtitle()Ljava/lang/CharSequence;": "subtitle",
    "getDescription()Ljava/lang/CharSequence;": "description",
    "getIconBitmap()Landroid/graphics/Bitmap;": "iconBitmap",
    "getIconUri()Landroid/net/Uri;": "iconUri",
    "getExtras()Landroid/os/Bundle;": "extras",
    "getMediaUri()Landroid/net/Uri;": "mediaUri",
  }),
  "describeContents()I": () => 0,
  "toString()Ljava/lang/String;": driven(function* (this: JMediaDescription): Gen {
    return `${this.title == null ? "null" : yield csText(this.title)}, ${this.subtitle == null ? "null" : yield csText(this.subtitle)}, ${this.description == null ? "null" : yield csText(this.description)}`;
  }),
} });
const descriptionFields = {
  "setMediaId(Ljava/lang/String;)Landroid/media/MediaDescription$Builder;": "mediaId",
  "setTitle(Ljava/lang/CharSequence;)Landroid/media/MediaDescription$Builder;": "title",
  "setSubtitle(Ljava/lang/CharSequence;)Landroid/media/MediaDescription$Builder;": "subtitle",
  "setDescription(Ljava/lang/CharSequence;)Landroid/media/MediaDescription$Builder;": "description",
  "setIconBitmap(Landroid/graphics/Bitmap;)Landroid/media/MediaDescription$Builder;": "iconBitmap",
  "setIconUri(Landroid/net/Uri;)Landroid/media/MediaDescription$Builder;": "iconUri",
  "setExtras(Landroid/os/Bundle;)Landroid/media/MediaDescription$Builder;": "extras",
  "setMediaUri(Landroid/net/Uri;)Landroid/media/MediaDescription$Builder;": "mediaUri",
} as const;
rt.register({ name: "android/media/MediaDescription$Builder", ctor: JMediaDescriptionBuilder, methods: {
  "<init>()V": () => {},
  ...Object.fromEntries(Object.entries(descriptionFields).map(([method, field]) => [method,
    function (this: JMediaDescriptionBuilder, value: unknown) { Reflect.set(this.value, field, value); return this; }])),
  "build()Landroid/media/MediaDescription;": function (this: JMediaDescriptionBuilder) { return Object.assign(new JMediaDescription(), this.value); },
} });
rt.register({ name: "android/media/session/PlaybackState$CustomAction", ctor: JPlaybackCustomAction, ifaces: ["android/os/Parcelable"], methods: fieldGetters({
  "getAction()Ljava/lang/String;": "action", "getName()Ljava/lang/CharSequence;": "name",
  "getIcon()I": "icon", "getExtras()Landroid/os/Bundle;": "extras",
}) });
rt.register({ name: "android/media/session/PlaybackState$CustomAction$Builder", ctor: JPlaybackCustomActionBuilder, methods: {
  "<init>(Ljava/lang/String;Ljava/lang/CharSequence;I)V": function (this: JPlaybackCustomActionBuilder, action: string, name: unknown, icon: number) {
    this.value.action = action; this.value.name = name; this.value.icon = icon;
  },
  "setExtras(Landroid/os/Bundle;)Landroid/media/session/PlaybackState$CustomAction$Builder;": function (this: JPlaybackCustomActionBuilder, extras: unknown) { this.value.extras = extras; return this; },
  "build()Landroid/media/session/PlaybackState$CustomAction;": function (this: JPlaybackCustomActionBuilder) { return Object.assign(new JPlaybackCustomAction(), this.value); },
} });
rt.register({ name: "android/media/session/PlaybackState", ctor: JPlaybackState, ifaces: ["android/os/Parcelable"], methods: fieldGetters({
  "getState()I": "state", "getPosition()J": "position", "getBufferedPosition()J": "bufferedPosition",
  "getPlaybackSpeed()F": "speed", "getActions()J": "actions", "getErrorMessage()Ljava/lang/CharSequence;": "errorMessage",
  "getLastPositionUpdateTime()J": "updateTime", "getCustomActions()Ljava/util/List;": "customActions",
  "getActiveQueueItemId()J": "activeQueueItemId", "getExtras()Landroid/os/Bundle;": "extras",
}) });
rt.register({ name: "android/media/session/PlaybackState$Builder", ctor: JPlaybackStateBuilder, methods: {
  "<init>()V": () => {},
  "setState(IJFJ)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackStateBuilder, state: number, position: bigint, speed: number, time: bigint) {
    this.value.state = state; this.value.position = position; this.value.speed = speed; this.value.updateTime = time; return this;
  },
  "setBufferedPosition(J)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackStateBuilder, position: bigint) { this.value.bufferedPosition = position; return this; },
  "setActions(J)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackStateBuilder, actions: bigint) { this.value.actions = actions; return this; },
  "setErrorMessage(Ljava/lang/CharSequence;)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackStateBuilder, message: unknown) { this.value.errorMessage = message; return this; },
  "addCustomAction(Landroid/media/session/PlaybackState$CustomAction;)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackStateBuilder, action: unknown) { this.customActions.push(action); return this; },
  "setActiveQueueItemId(J)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackStateBuilder, id: bigint) { this.value.activeQueueItemId = id; return this; },
  "setExtras(Landroid/os/Bundle;)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackStateBuilder, extras: unknown) { this.value.extras = extras; return this; },
  "build()Landroid/media/session/PlaybackState;": function (this: JPlaybackStateBuilder) {
    return Object.assign(new JPlaybackState(), this.value, { customActions: newArrayList(this.customActions.slice()) });
  },
} });
rt.register({ name: "android/media/MediaMetadata", ctor: JMediaMetadata, ifaces: ["android/os/Parcelable"], methods: {
  "containsKey(Ljava/lang/String;)Z": function (this: JMediaMetadata, key: string) { return +this.values.has(key); },
  "keySet()Ljava/util/Set;": function (this: JMediaMetadata) { return newStringSet(this.values.keys()); },
  "getText(Ljava/lang/String;)Ljava/lang/CharSequence;": function (this: JMediaMetadata, key: string) { return this.values.get(key) ?? null; },
  "getString(Ljava/lang/String;)Ljava/lang/String;": function (this: JMediaMetadata, key: string) { const value = this.values.get(key); return value == null ? null : csText(value); },
  "getLong(Ljava/lang/String;)J": function (this: JMediaMetadata, key: string) { const value = this.values.get(key); return typeof value === "bigint" ? value : 0n; },
  "getBitmap(Ljava/lang/String;)Landroid/graphics/Bitmap;": function (this: JMediaMetadata, key: string) { return this.values.get(key) ?? null; },
  "getRating(Ljava/lang/String;)Landroid/media/Rating;": function (this: JMediaMetadata, key: string) { return this.values.get(key) ?? null; },
  "getDescription()Landroid/media/MediaDescription;": driven(function* (this: JMediaMetadata): Gen {
    if (this.description) return this.description;
    const prefix = "android.media.metadata.";
    const result = new JMediaDescription();
    const mediaId = this.values.get(prefix + "MEDIA_ID");
    result.mediaId = typeof mediaId === "string" ? mediaId : null;
    const display = this.values.get(prefix + "DISPLAY_TITLE");
    if (display != null && (yield csText(display))) {
      result.title = display;
      result.subtitle = this.values.get(prefix + "DISPLAY_SUBTITLE") ?? null;
      result.description = this.values.get(prefix + "DISPLAY_DESCRIPTION") ?? null;
    } else {
      const text: unknown[] = [];
      for (const key of ["TITLE", "ARTIST", "ALBUM", "ALBUM_ARTIST", "WRITER", "AUTHOR", "COMPOSER"]) {
        const value = this.values.get(prefix + key);
        if (value != null && (yield csText(value))) text.push(value);
        if (text.length === 3) break;
      }
      result.title = text[0] ?? null;
      result.subtitle = text[1] ?? null;
      result.description = text[2] ?? null;
    }
    for (const key of ["DISPLAY_ICON", "ART", "ALBUM_ART"]) {
      const bitmap = this.values.get(prefix + key);
      if (bitmap != null) { result.iconBitmap = bitmap; break; }
    }
    for (const key of ["DISPLAY_ICON_URI", "ART_URI", "ALBUM_ART_URI"]) {
      const value = this.values.get(prefix + key);
      const uri = value == null ? "" : yield csText(value);
      if (uri) { result.iconUri = mkUri(uri); break; }
    }
    const uri = this.values.get(prefix + "MEDIA_URI");
    if (uri != null) {
      const text = yield csText(uri);
      if (text) result.mediaUri = mkUri(text);
    }
    return this.description = result;
  }),
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": driven(function* (this: JMediaMetadata, parcel: unknown): Gen {
    const bundle = new JBundle(); bundle.map = new Map(this.values);
    yield vcall(parcel, "writeBundle", "(Landroid/os/Bundle;)V", bundle);
  }),
} });
const putMetadata = function (this: JMediaMetadataBuilder, key: string, value: unknown) { this.value.values.set(key, value); return this; };
rt.register({ name: "android/media/MediaMetadata$Builder", ctor: JMediaMetadataBuilder, methods: {
  "<init>()V": () => {},
  "putText(Ljava/lang/String;Ljava/lang/CharSequence;)Landroid/media/MediaMetadata$Builder;": putMetadata,
  "putString(Ljava/lang/String;Ljava/lang/String;)Landroid/media/MediaMetadata$Builder;": putMetadata,
  "putLong(Ljava/lang/String;J)Landroid/media/MediaMetadata$Builder;": putMetadata,
  "putBitmap(Ljava/lang/String;Landroid/graphics/Bitmap;)Landroid/media/MediaMetadata$Builder;": putMetadata,
  "putRating(Ljava/lang/String;Landroid/media/Rating;)Landroid/media/MediaMetadata$Builder;": putMetadata,
  "build()Landroid/media/MediaMetadata;": function (this: JMediaMetadataBuilder) { const value = new JMediaMetadata(); value.values = new Map(this.value.values); return value; },
} });

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

const players = new Set<JMediaPlayer>();
const pools = new Set<JSoundPool>();
/** AudioManager.isMusicActive: a MediaPlayer or a SoundPool stream is sounding right now. */
export function isMusicActive(): number {
  for (const p of players) if (p.media && !p.media.paused) return 1;
  for (const p of pools) for (const s of p.streams.values()) if (s.src.playbackRate.value) return 1;
  return 0;
}

/** A MediaPlayer plays through a media element; given a display (setDisplay/setSurface), each
 *  video frame the element shows is presented to that surface. */
export class JMediaPlayer extends JObj {
  media: HTMLMediaElement | null = null;
  attributes: unknown = null;
  looping = false;
  prepared = false;
  preparedL: unknown = null;
  completionL: unknown = null;
  errorL: unknown = null;
  sizeL: unknown = null;
  infoL: unknown = null;
  seekL: unknown = null;
  display: unknown = null;
  /** a frame has reached the display since the source was set */
  rendering = false;
  srcBytes: Uint8Array | null = null;
}
export function mpReset(mp: JMediaPlayer) {
  players.delete(mp);
  if (mp.media) {
    mp.media.pause();
    if (mp.media.src.startsWith("blob:")) URL.revokeObjectURL(mp.media.src);
  }
  mp.media = null;
  mp.srcBytes = null;
  mp.prepared = mp.rendering = false;
}
const call = (listener: unknown, name: string, desc: string, ...args: unknown[]) => listener ? vcallUncaught(listener, name, desc, ...args) : undefined;
function mpLoadSrc(mp: JMediaPlayer, src: string) {
  mpReset(mp);
  const el = mp.media = document.createElement("video");
  el.preload = "auto";
  el.src = src;
  el.loop = mp.looping;
  const live = (f: () => void) => () => { if (mp.media === el) f(); };
  el.onended = live(() => void call(mp.completionL, "onCompletion", "(Landroid/media/MediaPlayer;)V", mp));
  // MEDIA_ERROR_UNKNOWN with MEDIA_ERROR_UNSUPPORTED or _IO, as a decoder or source failure reports
  el.onerror = live(() => void call(mp.errorL, "onError", "(Landroid/media/MediaPlayer;II)Z", mp, 1, el.error?.code === 4 ? -1010 : -1004));
  el.onloadedmetadata = live(() => {
    if (el.videoWidth) void call(mp.sizeL, "onVideoSizeChanged", "(Landroid/media/MediaPlayer;II)V", mp, el.videoWidth, el.videoHeight);
  });
  el.onseeked = live(() => void call(mp.seekL, "onSeekComplete", "(Landroid/media/MediaPlayer;)V", mp));
}
export function mpLoad(mp: JMediaPlayer, bytes: Uint8Array) {
  mpLoadSrc(mp, URL.createObjectURL(new Blob([bytes as BlobPart])));
  mp.srcBytes = bytes;
}
/** each frame the element shows goes to the display surface while it plays */
function pumpFrames(mp: JMediaPlayer, el: HTMLVideoElement) {
  // the display's surface, resolved once per display: a SurfaceHolder answers it through Java
  let display: unknown, surface: GlSurface | null = null;
  const next = async () => {
    if (mp.media !== el || el.paused) return;
    if (display !== mp.display) { display = mp.display; surface = await windowSurface(display); }
    if (surface && el.videoWidth) {
      presentSurface(surface, new VideoFrame(el));
      if (!mp.rendering) { mp.rendering = true; void call(mp.infoL, "onInfo", "(Landroid/media/MediaPlayer;II)Z", mp, 3, 0); }   // MEDIA_INFO_VIDEO_RENDERING_START
    }
    el.requestVideoFrameCallback(next);
  };
  el.requestVideoFrameCallback(next);
}
export function mpStart(mp: JMediaPlayer) {
  const el = mp.media;
  players.add(mp);
  void el?.play().then(() => { if (el instanceof HTMLVideoElement && mp.display) pumpFrames(mp, el); }).catch(() => { /* */ });
}
/** The bytes of a descriptor's range, or null when the descriptor or range is not readable */
async function fdRange(fd: JObj | null, offset: bigint, length: bigint) {
  if (fd === null) rt.npe();
  const source = javaFdSource(fdInt(fd));
  if (!source || offset < 0n || length <= 0n || offset >= BigInt(source.size)) return null;
  return readFully(source, Number(offset), Math.min(Number(length), source.size - Number(offset)));
}
const afdRange = driven(function* afdRange(asset: unknown): Gen {
  const fd = yield vcall(asset, "getFileDescriptor", "()Ljava/io/FileDescriptor;");
  return fdRange(fd, yield vcall(asset, "getStartOffset", "()J"), yield vcall(asset, "getLength", "()J"));
});
/** AOSP's context.getResources().openRawResourceFd(resId), read and closed; null without a descriptor */
const rawResourceBytes = driven(function* rawResourceBytes(context: unknown, resId: number): Gen {
  const res = yield vcall(context, "getResources", "()Landroid/content/res/Resources;");
  const asset = yield vcall(res, "openRawResourceFd", "(I)Landroid/content/res/AssetFileDescriptor;", resId);
  if (asset === null) return null;
  try { return yield afdRange(asset); } finally { yield vcall(asset, "close", "()V"); }
});
function mpLoadBytes(mp: JMediaPlayer, bytes: Uint8Array | null) {
  if (!bytes) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid media file descriptor or range");
  mpLoad(mp, bytes);
}
async function mpLoadFd(this: JMediaPlayer, fd: JObj | null, offset = 0n, length = 0x7fffffffffffffffn) {
  mpLoadBytes(this, await fdRange(fd, offset, length));
}
/** OnPrepared follows the source's metadata, which carries the duration and video size */
function mpPrepare(mp: JMediaPlayer) {
  const el = mp.media;
  if (!el) throw rt.mkThrowable("java/lang/IllegalStateException", "MediaPlayer has no data source");
  mp.prepared = true;
  const fire = () => {
    if (mp.prepared && mp.media === el) void call(mp.preparedL, "onPrepared", "(Landroid/media/MediaPlayer;)V", mp);
  };
  if (el.readyState >= 1) setTimeout(fire, 0); else el.addEventListener("loadedmetadata", fire, { once: true });
}
/** setDataSource(Context, Uri): a file or network URI directly, anything else through the resolver */
const mpLoadUri = driven(function* mpLoadUri(this: JMediaPlayer, context: unknown, uri: JUri): Gen {
  const { scheme, path } = uriParts(uri);
  if (!scheme || scheme === "file") return mpLoadPath(this, path);
  if (scheme === "http" || scheme === "https") return mpLoadPath(this, uri.uri);
  const resolver = yield vcall(context, "getContentResolver", "()Landroid/content/ContentResolver;");
  const asset = yield vcall(resolver, "openAssetFileDescriptor", "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/res/AssetFileDescriptor;", uri, "r");
  if (asset === null) throw rt.mkThrowable("java/io/FileNotFoundException", "Media source not found");
  try { yield mpLoadAsset.call(this, asset); } finally { yield vcall(asset, "close", "()V"); }
});
const mpLoadAsset = driven(function* mpLoadAsset(this: JMediaPlayer, asset: unknown): Gen {
  mpLoadBytes(this, yield afdRange(asset));
});
/** setDataSource(String): a path in the file system, or a URL fetched through the proxy */
async function mpLoadPath(mp: JMediaPlayer, path: string) {
  if (/^https?:/i.test(path)) return mpLoadSrc(mp, "/proxy?url=" + encodeURIComponent(path));
  const source = vfs.source(path);
  if (!source) throw rt.mkThrowable("java/io/IOException", "setDataSource failed.: status=0x80000000");
  mpLoad(mp, await readFully(source, 0, source.size));
}
rt.register({
  name: "android/media/MediaPlayer", ctor: JMediaPlayer,
  methods: {
    "static create(Landroid/content/Context;I)Landroid/media/MediaPlayer;": driven(function* (context: unknown, resId: number): Gen {
      const bytes = yield rawResourceBytes(context, resId);
      if (!bytes) return null;
      const mp = new JMediaPlayer();
      mpLoad(mp, bytes);
      return mp;
    }),
    "prepare()V": function (this: JMediaPlayer) { mpPrepare(this); },
    "prepareAsync()V": function (this: JMediaPlayer) { mpPrepare(this); },
    "start()V": function (this: JMediaPlayer) { mpStart(this); },
    "pause()V": function (this: JMediaPlayer) { this.media?.pause(); },
    "stop()V": function (this: JMediaPlayer) {
      if (this.media) {
        this.media.pause();
        this.media.currentTime = 0;
      }
    },
    "release()V": function (this: JMediaPlayer) { mpReset(this); },
    "isPlaying()Z": function (this: JMediaPlayer) { return this.media && !this.media.paused ? 1 : 0; },
    "isLooping()Z": function (this: JMediaPlayer) { return +this.looping; },
    "setLooping(Z)V": function (this: JMediaPlayer, l: number) {
      this.looping = !!l;
      if (this.media) this.media.loop = !!l;
    },
    "setAudioAttributes(Landroid/media/AudioAttributes;)V": function (this: JMediaPlayer, attributes: unknown) {
      if (attributes === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "AudioAttributes must not be null");
      this.attributes = attributes;
    },
    "setVolume(FF)V": function (this: JMediaPlayer, v: number) { if (this.media) this.media.volume = Math.min(1, v); },
    "setDisplay(Landroid/view/SurfaceHolder;)V": function (this: JMediaPlayer, holder: unknown) { this.display = holder; },
    "setSurface(Landroid/view/Surface;)V": function (this: JMediaPlayer, surface: unknown) { this.display = surface; },
    "getVideoWidth()I": function (this: JMediaPlayer) { return this.media instanceof HTMLVideoElement ? this.media.videoWidth : 0; },
    "getVideoHeight()I": function (this: JMediaPlayer) { return this.media instanceof HTMLVideoElement ? this.media.videoHeight : 0; },
    "setOnErrorListener(Landroid/media/MediaPlayer$OnErrorListener;)V": function (this: JMediaPlayer, l: unknown) { this.errorL = l; },
    "setOnVideoSizeChangedListener(Landroid/media/MediaPlayer$OnVideoSizeChangedListener;)V": function (this: JMediaPlayer, l: unknown) { this.sizeL = l; },
    "setDataSource(Ljava/lang/String;)V": function (this: JMediaPlayer, path: string) { return mpLoadPath(this, path); },
    "setDataSource(Landroid/content/Context;Landroid/net/Uri;Ljava/util/Map;)V": function (this: JMediaPlayer, context: unknown, uri: JUri) { return mpLoadUri.call(this, context, uri); },
    "setOnCompletionListener(Landroid/media/MediaPlayer$OnCompletionListener;)V": function (this: JMediaPlayer, l: unknown) {
      this.completionL = l;
    },
    "setOnPreparedListener(Landroid/media/MediaPlayer$OnPreparedListener;)V": function (this: JMediaPlayer, l: unknown) {
      this.preparedL = l;
    },
    "setDataSource(Ljava/io/FileDescriptor;JJ)V": mpLoadFd,
    "setDataSource(Ljava/io/FileDescriptor;)V": mpLoadFd,
    "setDataSource(Landroid/content/res/AssetFileDescriptor;)V": mpLoadAsset,
    "setOnInfoListener(Landroid/media/MediaPlayer$OnInfoListener;)V": function (this: JMediaPlayer, l: unknown) { this.infoL = l; },
    "setOnSeekCompleteListener(Landroid/media/MediaPlayer$OnSeekCompleteListener;)V": function (this: JMediaPlayer, l: unknown) { this.seekL = l; },
    "setDataSource(Landroid/content/Context;Landroid/net/Uri;)V": function (this: JMediaPlayer, context: unknown, uri: JUri) { return mpLoadUri.call(this, context, uri); },
    "reset()V": function (this: JMediaPlayer) { mpReset(this); },
    ...noops("<init>()V", "setAudioStreamType(I)V", "setWakeMode(Landroid/content/Context;I)V", "setScreenOnWhilePlaying(Z)V"),
    "getDuration()I": function (this: JMediaPlayer) { const d = this.media?.duration; return d && Number.isFinite(d) ? Math.round(d * 1000) : -1; },
    "getCurrentPosition()I": function (this: JMediaPlayer) { return Math.round((this.media?.currentTime ?? 0) * 1000); },
    "seekTo(I)V": function (this: JMediaPlayer, ms: number) { if (this.media) this.media.currentTime = ms / 1000; },
  },
});
for (const n of ["android/media/MediaPlayer$OnCompletionListener", "android/media/MediaPlayer$OnPreparedListener",
  "android/media/MediaPlayer$OnErrorListener", "android/media/MediaPlayer$OnInfoListener", "android/media/MediaPlayer$OnSeekCompleteListener",
  "android/media/MediaPlayer$OnVideoSizeChangedListener",
  "android/media/SoundPool$OnLoadCompleteListener"]) {
  rt.register({ name: n, ctor: class extends JObj {} });
}

// ── SoundPool: one shared AudioContext (never closed), a decoded AudioBuffer per sound id
// (null while decoding), and a one-shot source + gain node per stream id.
let actx: AudioContext | null = null;
type Stream = { src: AudioBufferSourceNode; gain: GainNode; prio: number; rate: number };
class JSoundPool extends JObj {
  maxStreams = 1;
  audioAttributes: unknown = null;
  sounds = new Map<number, AudioBuffer | null>();
  streams = new Map<number, Stream>();
  nextId = 1;
  nextStream = 1;
  loadL: unknown = null;
  load(bytes: Uint8Array | null): number {
    if (!bytes) return 0;
    const id = this.nextId++;
    this.sounds.set(id, null);
    // decodeAudioData detaches the buffer it is given, so the apk's bytes are copied first.
    (actx ??= new AudioContext()).decodeAudioData(bytes.slice().buffer as ArrayBuffer)
      .then((buf) => this.decoded(id, buf, 0), () => this.decoded(id, null, 1));
    return id;
  }
  decoded(id: number, buf: AudioBuffer | null, status: number) {
    if (!this.sounds.has(id)) return; // unloaded or released before the decode finished
    if (buf) this.sounds.set(id, buf);
    if (this.loadL) void onMain(() => vcall(this.loadL, "onLoadComplete", "(Landroid/media/SoundPool;II)V", this, id, status)).catch(reportUncaught);
  }
  stop(sid: number) {
    const s = this.streams.get(sid);
    if (s) { s.src.stop(); this.streams.delete(sid); }
  }
}
rt.register({
  name: "android/media/SoundPool", ctor: JSoundPool,
  methods: {
    "<init>(III)V": function (this: JSoundPool, max: number) { this.maxStreams = max; pools.add(this); },
    "load(Landroid/content/res/AssetFileDescriptor;I)I": driven(function* (this: JSoundPool, afd: unknown): Gen { return this.load(yield afdRange(afd)); }),
    "load(Ljava/io/FileDescriptor;JJI)I": async function (this: JSoundPool, fd: JObj | null, offset: bigint, length: bigint) { return this.load(await fdRange(fd, offset, length)); },
    "load(Landroid/content/Context;II)I": driven(function* (this: JSoundPool, context: unknown, resId: number): Gen {
      return this.load(yield rawResourceBytes(context, resId));
    }),
    "load(Ljava/lang/String;I)I": driven(function* (this: JSoundPool, path: string): Gen { return this.load(yield vfs.readFile(path)); }),
    "play(IFFIIF)I": function (this: JSoundPool, id: number, l: number, r: number, prio: number, loop: number, rate: number) {
      const buf = this.sounds.get(id);
      if (!buf || !actx) return 0;
      // Reached from a pointer-driven main-looper job, i.e. inside the user-activation window.
      if (actx.state === "suspended") void actx.resume();
      if (this.streams.size >= this.maxStreams) {
        // AOSP: the lowest-priority stream at or below the newcomer's yields, else the newcomer is refused.
        let v: [number, Stream] | undefined;
        for (const e of this.streams) if (e[1].prio <= prio && (!v || e[1].prio < v[1].prio)) v = e;
        if (!v) return 0;
        this.stop(v[0]);
      }
      const src = actx.createBufferSource();
      src.buffer = buf; src.loop = loop !== 0; src.playbackRate.value = rate;
      const gain = actx.createGain();
      gain.gain.value = Math.max(l, r);
      src.connect(gain).connect(actx.destination);
      const sid = this.nextStream++;
      src.onended = () => this.streams.delete(sid);
      src.start();
      // loop = n > 0 means n + 1 plays: keep looping and schedule the end (at the starting rate).
      if (loop > 0) src.stop(actx.currentTime + (buf.duration * (loop + 1)) / rate);
      this.streams.set(sid, { src, gain, prio, rate });
      return sid;
    },
    "stop(I)V": function (this: JSoundPool, sid: number) { this.stop(sid); },
    // Web Audio sources cannot pause; a zero playback rate holds the position instead.
    "pause(I)V": function (this: JSoundPool, sid: number) { const s = this.streams.get(sid); if (s) s.src.playbackRate.value = 0; },
    "resume(I)V": function (this: JSoundPool, sid: number) { const s = this.streams.get(sid); if (s) s.src.playbackRate.value = s.rate; },
    "autoPause()V": function (this: JSoundPool) { for (const s of this.streams.values()) s.src.playbackRate.value = 0; },
    "autoResume()V": function (this: JSoundPool) { for (const s of this.streams.values()) s.src.playbackRate.value = s.rate; },
    "setVolume(IFF)V": function (this: JSoundPool, sid: number, l: number, r: number) {
      const s = this.streams.get(sid); if (s) s.gain.gain.value = Math.max(l, r);
    },
    "setLoop(II)V": function (this: JSoundPool, sid: number, loop: number) { const s = this.streams.get(sid); if (s) s.src.loop = loop !== 0; },
    "setRate(IF)V": function (this: JSoundPool, sid: number, rate: number) {
      const s = this.streams.get(sid);
      if (s) { if (s.src.playbackRate.value) s.src.playbackRate.value = rate; s.rate = rate; }
    },
    "setPriority(II)V": function (this: JSoundPool, sid: number, prio: number) { const s = this.streams.get(sid); if (s) s.prio = prio; },
    "unload(I)Z": function (this: JSoundPool, id: number) { return this.sounds.delete(id) ? 1 : 0; },
    "release()V": function (this: JSoundPool) {
      for (const s of this.streams.values()) s.src.stop();
      this.streams.clear(); this.sounds.clear(); pools.delete(this);
    },
    "setOnLoadCompleteListener(Landroid/media/SoundPool$OnLoadCompleteListener;)V": function (this: JSoundPool, l: unknown) { this.loadL = l; },
  },
});
class JSoundPoolBuilder extends JObj { max = 1; attrs: unknown = null; }
rt.register({
  name: "android/media/SoundPool$Builder", ctor: JSoundPoolBuilder,
  methods: {
    "<init>()V": function () {},
    "setMaxStreams(I)Landroid/media/SoundPool$Builder;": function (this: JSoundPoolBuilder, n: number) { this.max = n; return this; },
    "setAudioAttributes(Landroid/media/AudioAttributes;)Landroid/media/SoundPool$Builder;": function (this: JSoundPoolBuilder, attrs: unknown) {
      if (!attrs) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid null AudioAttributes");
      this.attrs = attrs; return this;
    },
    "build()Landroid/media/SoundPool;": function (this: JSoundPoolBuilder) {
      const p = new JSoundPool(); p.maxStreams = this.max;
      p.audioAttributes = this.attrs;
      pools.add(p); return p;
    },
  },
});

// ── AudioTrack (MODE_STREAM): PCM written from Java is scheduled back-to-back on the shared
// AudioContext; the periodic position listener is what streaming mixers (a native engine's
// SoundPlayer) refill from, so it fires whenever the queue runs below a few periods.
const D_periodic = "(Landroid/media/AudioTrack;)V";
/** the channel count of a legacy CHANNEL_OUT_STEREO (12) / CHANNEL_CONFIGURATION_STEREO (3) or mono config */
const legacyChannels = (config: number) => config === 12 || config === 3 ? 2 : 1;
const bitCount = (mask: number) => { let n = 0; for (; mask; mask &= mask - 1) n++; return n; };
export class JAudioTrack extends JObj {
  rate = 44100; channels = 2; bytesPerSample = 2; bufBytes = 0;
  sessionId = 0; attributes: unknown = null;
  logSessionId: JObj | null = null;

  state = 1; playState = 1;          // STATE_INITIALIZED; PLAYSTATE_STOPPED
  nextTime = 0; written = 0; played = 0; headOrigin = 0; resetHead = false; underruns = 0;
  queue: { buffer: AudioBuffer; offset: number; start: number; source: AudioBufferSourceNode | null; consumed?: () => void }[] = [];
  period = 0; listener: unknown = null; timer: ReturnType<typeof setInterval> | null = null;
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
        if (!this.queue.length && this.playState === 1) this.played = this.written = this.headOrigin = 0;
        entry.consumed?.();
      };
      source.start(entry.start, entry.offset / this.rate);
      this.nextTime = entry.start + (entry.buffer.length - entry.offset) / this.rate;
    }
  }
  pauseQueue(): void {
    const now = this.queue.length ? this.ctx().currentTime : 0;
    for (const entry of this.queue) {
      if (!entry.source) continue;
      entry.offset = Math.min(entry.buffer.length, entry.offset + Math.max(0, now - entry.start) * this.rate);
      entry.source.onended = null; entry.source.stop(); entry.source.disconnect(); entry.source = null;
    }
    this.nextTime = 0;
  }
  clearQueue(): void { this.pauseQueue(); this.queue = []; this.written = this.played = this.headOrigin = 0; }
  /** a streaming write blocks while the track's buffer is full, which is what paces a writer
   *  loop; the wait is the excess over one buffer's worth of queued audio */
  wrote(n: number): number | Promise<number> {
    const bufSec = this.bufBytes / (this.rate * this.frameBytes()), excess = this.queuedSec() - bufSec;
    return excess > 0.005 ? new Promise((r) => setTimeout(() => r(n), excess * 1000)) : n;
  }
  /** interleaved 16-bit (or 8-bit unsigned) PCM → one scheduled buffer */
  push(samples: Int16Array | Int8Array | Float32Array, frames: number, consumed?: () => void): void {
    if (frames <= 0) return;
    const ctx = this.ctx();
    const buf = ctx.createBuffer(this.channels, frames, this.rate);
    for (let c = 0; c < this.channels; c++) {
      const ch = buf.getChannelData(c);
      if (samples instanceof Float32Array) for (let i = 0; i < frames; i++) ch[i] = samples[i * this.channels + c];
      else if (samples instanceof Int16Array) for (let i = 0; i < frames; i++) ch[i] = samples[i * this.channels + c] / 32768;
      else for (let i = 0; i < frames; i++) ch[i] = ((samples[i * this.channels + c] & 0xff) - 128) / 128;
    }
    if (this.playState === 3 && this.written && this.queuedSec() === 0) this.underruns++;
    this.queue.push({ buffer: buf, offset: 0, start: 0, source: null, consumed });
    this.written += frames;
    if (this.playState === 3) this.schedule();
  }
  /** a byte[] write: 16-bit samples are copied out, 8-bit ones read in place */
  pushBytes(data: Int8Array, off: number, n: number): void {
    if (this.bytesPerSample === 2) this.push(new Int16Array(data.buffer.slice(data.byteOffset + off, data.byteOffset + off + (n & ~1))), Math.floor(n / this.frameBytes()));
    else this.push(data.subarray(off, off + n), Math.floor(n / this.channels));
  }
  writeBuffer(buffer: JBuffer, n: number, mode: number): number | Promise<number> {
    if (this.state !== 1) return -3;
    if (!buffer || n < 0 || n > limit(buffer) - position(buffer) || (mode !== 0 && mode !== 1)) return -2;
    const requested = Math.floor(n / this.frameBytes()) * this.frameBytes();
    const available = Math.max(0, this.bufBytes - Math.ceil(this.queuedSec() * this.rate) * this.frameBytes());
    n = Math.floor(Math.min(requested, available) / this.frameBytes()) * this.frameBytes();
    if (!n) return mode === 0 && requested ? this.finishWrite(buffer, requested, 0) : 0;
    const bytes = remainingBytes(buffer), data = new DataView(bytes.buffer, bytes.byteOffset, n);
    const count = n / this.bytesPerSample;
    // AudioTrack consumes native-order PCM, independently of ByteBuffer.order().
    const SampleArray = this.bytesPerSample === 4 ? Float32Array : this.bytesPerSample === 2 ? Int16Array : Int8Array;
    const aligned = data.byteOffset % this.bytesPerSample === 0;
    const samples = aligned ? new SampleArray(data.buffer, data.byteOffset, count) : new SampleArray(count);
    if (!aligned) for (let i = 0; i < count; i++) samples[i] = this.bytesPerSample === 4 ? data.getFloat32(i * 4, true) : data.getInt16(i * 2, true);
    this.push(samples, n / this.frameBytes());
    setPosition(buffer, position(buffer) + n);
    return mode === 0 && n < requested ? this.finishWrite(buffer, requested, n) : n;
  }
  async finishWrite(buffer: JBuffer, requested: number, written: number): Promise<number> {
    const thread = rt.th();
    while (written < requested && this.state === 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
      rt.st(thread);
      const n = this.writeBuffer(buffer, requested - written, 1) as number;
      if (n < 0) return written || n;
      written += n;
    }
    return written || (this.state === 1 ? 0 : -3);
  }
  startTimer(): void {
    if (this.timer || !this.listener || !this.period) return;
    const periodMs = Math.max(5, this.period / this.rate * 1000);
    this.timer = setInterval(() => {
      const listener = this.listener;
      if (this.playState !== 3 || !listener) return;
      // refill until ~3 periods are queued; each callback is one write of one period
      if (this.queuedSec() < 3 * this.period / this.rate) void onMain(() => vcall(listener, "onPeriodicNotification", D_periodic, this)).catch(reportUncaught);
    }, periodMs / 2);
  }
  stopTimer(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
}
const setPositionListener = function (this: JAudioTrack, l: unknown) { this.listener = l; if (!l) this.stopTimer(); else if (this.playState === 3) this.startTimer(); };
const bufferFrames = function (this: JAudioTrack) { return Math.floor(this.bufBytes / this.frameBytes()); };
const writeByteBuffer = function (this: JAudioTrack, buffer: JBuffer, n: number, mode: number) { return this.writeBuffer(buffer, n, mode); };
// AudioTrack::latency(): the output's latency plus the track's own buffer, in ms
rt.registerJni("android/media/AudioTrack", "native_get_latency()I", function (this: JAudioTrack) {
  const ctx = this.ctx();
  return Math.round(((ctx.outputLatency || ctx.baseLatency) + this.bufBytes / this.frameBytes() / this.rate) * 1000);
});
rt.register({
  name: "android/media/AudioTrack", ctor: JAudioTrack,
  statics: { MODE_STATIC: 0, MODE_STREAM: 1, PLAYSTATE_STOPPED: 1, PLAYSTATE_PAUSED: 2, PLAYSTATE_PLAYING: 3, STATE_UNINITIALIZED: 0, STATE_INITIALIZED: 1, STATE_NO_STATIC_DATA: 2,
    SUCCESS: 0, ERROR: -1, ERROR_BAD_VALUE: -2, ERROR_INVALID_OPERATION: -3, WRITE_BLOCKING: 0, WRITE_NON_BLOCKING: 1 },
  methods: {
    "<init>(IIIIII)V": function (this: JAudioTrack, _stream: number, rate: number, chanCfg: number, fmt: number, bufBytes: number) {
      this.rate = rate; this.channels = legacyChannels(chanCfg); this.bytesPerSample = fmt === 3 ? 1 : 2; this.bufBytes = bufBytes;
      this.sessionId = newAudioSessionId();
    },
    "static getMinBufferSize(III)I": (rate: number, chanCfg: number, fmt: number) => {
      // ~100 ms of frames, as AudioFlinger answers for a typical output
      const frames = Math.max(1024, Math.ceil(rate / 10));
      return frames * legacyChannels(chanCfg) * (fmt === 3 ? 1 : 2);
    },
    "static getNativeOutputSampleRate(I)I": () => outputSampleRate(),
    "static getMaxVolume()F": () => 1, "static getMinVolume()F": () => 0,
    "getLogSessionId()Landroid/media/metrics/LogSessionId;": function (this: JAudioTrack) {
      return this.logSessionId ?? staticField("android/media/metrics/LogSessionId", "LOG_SESSION_ID_NONE");
    },
    "setLogSessionId(Landroid/media/metrics/LogSessionId;)V": function (this: JAudioTrack, id: JObj) {
      if (!id) return rt.npe();
      if (this.state !== 1) throw rt.mkThrowable("java/lang/IllegalStateException", "AudioTrack not initialized");
      this.logSessionId = id;
    },
    "getPlaybackHeadPosition()I": function (this: JAudioTrack) { return this.playState === 1 ? 0 : Math.floor(this.head() - this.headOrigin) | 0; },
    "setStereoVolume(FF)I": function (this: JAudioTrack, l: number, r: number) { this.vol = (l + r) / 2; if (this.gain) this.gain.gain.value = this.vol; return 0; },
    "setVolume(F)I": function (this: JAudioTrack, v: number) { this.vol = v; if (this.gain) this.gain.gain.value = v; return 0; },
    "setPlaybackPositionUpdateListener(Landroid/media/AudioTrack$OnPlaybackPositionUpdateListener;)V": setPositionListener,
    "setPlaybackPositionUpdateListener(Landroid/media/AudioTrack$OnPlaybackPositionUpdateListener;Landroid/os/Handler;)V": setPositionListener,
    "setPositionNotificationPeriod(I)I": function (this: JAudioTrack, p: number) { this.period = p; return 0; },
    "play()V": function (this: JAudioTrack) { if (this.resetHead) { this.headOrigin = this.head(); this.resetHead = false; } this.playState = 3; void this.ctx().resume(); this.schedule(); this.startTimer(); },
    "pause()V": function (this: JAudioTrack) { this.playState = 2; this.pauseQueue(); this.stopTimer(); },
    "stop()V": function (this: JAudioTrack) { if (this.playState !== 3 || !this.queue.length) this.clearQueue(); this.playState = 1; this.resetHead = true; this.stopTimer(); },
    "flush()V": function (this: JAudioTrack) { if (this.playState !== 3) this.clearQueue(); },
    "release()V": function (this: JAudioTrack) { this.stopTimer(); this.clearQueue(); this.gain?.disconnect(); this.gain = null; this.state = 0; this.playState = 1; this.listener = null; },
    "write([SII)I": function (this: JAudioTrack, data: Int16Array, off: number, n: number) {
      if (this.state !== 1) return -3;
      this.push(data.subarray(off, off + n), Math.floor(n / this.channels));
      return this.wrote(n);
    },
    "write([BIII)I": function (this: JAudioTrack, data: Int8Array, off: number, n: number, mode: number) {
      if (this.state !== 1) return -3;
      this.pushBytes(data, off, n);
      return mode === 1 ? n : this.wrote(n);   // WRITE_NON_BLOCKING
    },
    "write([BII)I": function (this: JAudioTrack, data: Int8Array, off: number, n: number) {
      if (this.state !== 1) return -3;
      this.pushBytes(data, off, n);
      return this.wrote(n);
    },
    "getBufferSizeInFrames()I": bufferFrames,
    "getBufferCapacityInFrames()I": bufferFrames,
    ...fieldGetters({ "getState()I": "state", "getPlayState()I": "playState", "getSampleRate()I": "rate",
      "getChannelCount()I": "channels", "getAudioSessionId()I": "sessionId",
      "getAudioAttributes()Landroid/media/AudioAttributes;": "attributes", "getUnderrunCount()I": "underruns" }),
    ...stubs(0, "static isDirectPlaybackSupported(Landroid/media/AudioFormat;Landroid/media/AudioAttributes;)Z",
      "setPlaybackRate(I)I", "setNotificationMarkerPosition(I)I", "isOffloadedPlayback()Z",
      "getTimestamp(Landroid/media/AudioTimestamp;)Z", "setPreferredDevice(Landroid/media/AudioDeviceInfo;)Z"),
    ...stubs(null, "getRoutedDevice()Landroid/media/AudioDeviceInfo;"),
    ...noops("addOnRoutingChangedListener(Landroid/media/AudioRouting$OnRoutingChangedListener;Landroid/os/Handler;)V",
      "removeOnRoutingChangedListener(Landroid/media/AudioRouting$OnRoutingChangedListener;)V"),
    "write(Ljava/nio/ByteBuffer;II)I": writeByteBuffer,
    "write(Ljava/nio/ByteBuffer;IIJ)I": writeByteBuffer,
  },
});
class JAudioTrackBuilder extends JObj {
  format: JAudioFormat | null = null;
  attributes: unknown = null;
  mode = 1; bufferSize = 0; sessionId = 0; offload = false;
}
rt.register({
  name: "android/media/AudioTrack$Builder", ctor: JAudioTrackBuilder,
  methods: {
    "<init>()V": () => {},
    "setAudioFormat(Landroid/media/AudioFormat;)Landroid/media/AudioTrack$Builder;": function (this: JAudioTrackBuilder, format: JAudioFormat) {
      if (!format) throw rt.mkThrowable("java/lang/NullPointerException", null);
      this.format = format; return this;
    },
    "setAudioAttributes(Landroid/media/AudioAttributes;)Landroid/media/AudioTrack$Builder;": function (this: JAudioTrackBuilder, attributes: unknown) {
      if (!attributes) throw rt.mkThrowable("java/lang/NullPointerException", null);
      this.attributes = attributes; return this;
    },
    "setTransferMode(I)Landroid/media/AudioTrack$Builder;": function (this: JAudioTrackBuilder, mode: number) {
      if (mode !== 0 && mode !== 1) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid transfer mode");
      this.mode = mode; return this;
    },
    "setBufferSizeInBytes(I)Landroid/media/AudioTrack$Builder;": function (this: JAudioTrackBuilder, size: number) {
      if (size <= 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid buffer size");
      this.bufferSize = size; return this;
    },
    "setSessionId(I)Landroid/media/AudioTrack$Builder;": function (this: JAudioTrackBuilder, id: number) {
      if (id < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid session ID");
      this.sessionId = id; return this;
    },
    "setOffloadedPlayback(Z)Landroid/media/AudioTrack$Builder;": function (this: JAudioTrackBuilder, offload: number) { this.offload = !!offload; return this; },
    "setContext(Landroid/content/Context;)Landroid/media/AudioTrack$Builder;": function (this: JAudioTrackBuilder) { return this; },
    "build()Landroid/media/AudioTrack;": function (this: JAudioTrackBuilder) {
      if (this.offload || this.mode !== 1) rt.unimplemented("AudioTrack non-streaming output");
      const format = this.format, encoding = format?.encoding || 2;
      if (encoding !== 2 && encoding !== 3 && encoding !== 4) throw rt.mkThrowable("java/lang/UnsupportedOperationException", "Unsupported PCM encoding");
      const track = rt.make("android/media/AudioTrack") as JAudioTrack;
      track.rate = format?.sampleRate || outputSampleRate();
      if (track.rate < 3000 || track.rate > 384000) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid sample rate");
      track.channels = bitCount(format?.channelIndexMask || format?.channelMask || 12);
      track.bytesPerSample = encoding === 4 ? 4 : encoding === 3 ? 1 : 2;
      track.bufBytes = this.bufferSize || Math.max(1024, Math.ceil(track.rate / 10)) * track.frameBytes();
      if (track.bufBytes % track.frameBytes()) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Buffer size must contain whole frames");
      track.attributes = this.attributes;
      track.sessionId = this.sessionId || newAudioSessionId();
      return track;
    },
  },
});
rt.markers("android/media/AudioRouting$OnRoutingChangedListener");
rt.register({ name: "android/media/AudioTimestamp", ctor: class extends JObj { framePosition = 0n; nanoTime = 0n; }, fields: { framePosition: "framePosition", nanoTime: "nanoTime" }, methods: { "<init>()V": () => {} } });
rt.markers("android/media/AudioTrack$OnPlaybackPositionUpdateListener",
  "android/media/AudioRecord$OnRecordPositionUpdateListener");

class JAudioRecord extends JObj { state = 0; recordingState = 1; }
rt.register({
  name: "android/media/AudioRecord", ctor: JAudioRecord,
  statics: { STATE_UNINITIALIZED: 0, STATE_INITIALIZED: 1, RECORDSTATE_STOPPED: 1, RECORDSTATE_RECORDING: 3, ERROR: -1, ERROR_BAD_VALUE: -2, ERROR_INVALID_OPERATION: -3 },
  methods: {
    "<init>(IIIII)V": () => {},
    "static getMinBufferSize(III)I": (rate: number, channels: number, encoding: number) => {
      const count = channels === 16 ? 1 : channels === 12 ? 2 : 0;
      const bytes = encoding === 3 ? 1 : encoding === 2 ? 2 : encoding === 4 ? 4 : 0;
      return rate >= 4000 && rate <= 192000 && count && bytes ? Math.max(256, Math.ceil(rate / 10) * count * bytes) : -2;
    },
    ...fieldGetters({ "getState()I": "state", "getRecordingState()I": "recordingState" }),
    "release()V": function (this: JAudioRecord) { this.state = 0; this.recordingState = 1; },
  },
});

class JAudioFormat extends JObj { encoding = 0; sampleRate = 0; channelMask = 0; channelIndexMask = 0; }
rt.register({
  name: "android/media/AudioFormat", ctor: JAudioFormat,
  statics: { CHANNEL_CONFIGURATION_MONO: 2, CHANNEL_CONFIGURATION_STEREO: 3, CHANNEL_OUT_MONO: 4, CHANNEL_OUT_STEREO: 12, CHANNEL_IN_MONO: 16, CHANNEL_IN_STEREO: 12,
    ENCODING_PCM_16BIT: 2, ENCODING_PCM_8BIT: 3, ENCODING_PCM_FLOAT: 4, ENCODING_DEFAULT: 1, ENCODING_INVALID: 0 },
  methods: {
    ...fieldGetters({ "getEncoding()I": "encoding", "getSampleRate()I": "sampleRate",
      "getChannelMask()I": "channelMask", "getChannelIndexMask()I": "channelIndexMask" }),
    "getChannelCount()I": function (this: JAudioFormat) { return bitCount(this.channelMask || this.channelIndexMask); },
  },
});
class JAudioFormatBuilder extends JObj { format = new JAudioFormat(); }
rt.register({
  name: "android/media/AudioFormat$Builder", ctor: JAudioFormatBuilder,
  methods: {
    "<init>()V": function () {},
    "<init>(Landroid/media/AudioFormat;)V": function (this: JAudioFormatBuilder, format: JAudioFormat) { Object.assign(this.format, format); },
    "setEncoding(I)Landroid/media/AudioFormat$Builder;": function (this: JAudioFormatBuilder, encoding: number) { this.format.encoding = encoding === 1 ? 2 : encoding; return this; },
    "setSampleRate(I)Landroid/media/AudioFormat$Builder;": function (this: JAudioFormatBuilder, rate: number) { this.format.sampleRate = rate; return this; },
    "setChannelMask(I)Landroid/media/AudioFormat$Builder;": function (this: JAudioFormatBuilder, mask: number) { this.format.channelMask = mask; return this; },
    "setChannelIndexMask(I)Landroid/media/AudioFormat$Builder;": function (this: JAudioFormatBuilder, mask: number) { this.format.channelIndexMask = mask; return this; },
    "build()Landroid/media/AudioFormat;": function (this: JAudioFormatBuilder) { return Object.assign(new JAudioFormat(), this.format); },
  },
});

/** MediaScannerConnection publishes a file before delivering its callback on the main queue. */
rt.register({
  name: "android/media/MediaScannerConnection", ctor: class extends JObj {},
  methods: {
    "static scanFile(Landroid/content/Context;[Ljava/lang/String;[Ljava/lang/String;Landroid/media/MediaScannerConnection$OnScanCompletedListener;)V":
      (_c: unknown, paths: string[] | null, _m: unknown, l: unknown) => {
        if (!l) return;
        for (const p of paths ?? []) {
          void onMain(() => after(scannedMediaUri(p), (uri) => vcall(l, "onScanCompleted", "(Ljava/lang/String;Landroid/net/Uri;)V", p, uri))).catch(reportUncaught);
        }
      },
  },
});
rt.markers("android/media/MediaScannerConnection$OnScanCompletedListener",
  "android/media/MediaScannerConnection$MediaScannerConnectionClient");

class JPlaybackParams extends JObj { speed = 1; pitch = 1; fallback = 0; defaults = false; }
rt.register({ name: "android/media/PlaybackParams", ctor: JPlaybackParams, methods: {
  "<init>()V": function () {},
  "allowDefaults()Landroid/media/PlaybackParams;": function (this: JPlaybackParams) { this.defaults = true; return this; },
  "setSpeed(F)Landroid/media/PlaybackParams;": function (this: JPlaybackParams, speed: number) { this.speed = speed; return this; },
  "getSpeed()F": function (this: JPlaybackParams) { return this.speed; },
  "setPitch(F)Landroid/media/PlaybackParams;": function (this: JPlaybackParams, pitch: number) {
    if (pitch < 0) throw rt.mkThrowable("java/lang/IllegalArgumentException", "pitch must not be negative");
    this.pitch = pitch; return this;
  },
  "getPitch()F": function (this: JPlaybackParams) { return this.pitch; },
  "setAudioFallbackMode(I)Landroid/media/PlaybackParams;": function (this: JPlaybackParams, mode: number) { this.fallback = mode; return this; },
  "getAudioFallbackMode()I": function (this: JPlaybackParams) { return this.fallback; },
} });

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

rt.register({ name: "android/media/MediaCodec$Callback", ctor: class extends JObj {}, methods: { "<init>()V": function () {} } });

export class JBufferInfo extends JObj { offset = 0; size = 0; presentationTimeUs = 0n; flags = 0; }
rt.register({
  name: "android/media/MediaCodec$BufferInfo", ctor: JBufferInfo,
  fields: ["offset", "size", "presentationTimeUs", "flags"],
  methods: {
    "<init>()V": function () {},
    "set(IIJI)V": function (this: JBufferInfo, o: number, s: number, t: bigint, f: number) { this.offset = o; this.size = s; this.presentationTimeUs = t; this.flags = f; },
  },
});
class JCryptoInfo extends JObj {
  numSubSamples = 0; numBytesOfClearData: Int32Array | null = null; numBytesOfEncryptedData: Int32Array | null = null;
  key: Int8Array | null = null; iv: Int8Array | null = null; mode = 0; pattern: unknown = null;
}
rt.register({
  name: "android/media/MediaCodec$CryptoInfo", ctor: JCryptoInfo,
  fields: ["numSubSamples", "numBytesOfClearData", "numBytesOfEncryptedData", "key", "iv", "mode"],
  methods: {
    "<init>()V": function () {},
    "set(I[I[I[B[BI)V": function (this: JCryptoInfo, count: number, clear: Int32Array | null, encrypted: Int32Array | null, key: Int8Array | null, iv: Int8Array | null, mode: number) {
      this.numSubSamples = count; this.numBytesOfClearData = clear; this.numBytesOfEncryptedData = encrypted; this.key = key; this.iv = iv; this.mode = mode;
    },
    "setPattern(Landroid/media/MediaCodec$CryptoInfo$Pattern;)V": function (this: JCryptoInfo, p: unknown) { this.pattern = p; } },
});
class JCryptoPattern extends JObj { encrypt = 0; skip = 0; }
rt.register({
  name: "android/media/MediaCodec$CryptoInfo$Pattern", ctor: JCryptoPattern,
  methods: {
    "<init>(II)V": function (this: JCryptoPattern, e: number, s: number) { this.encrypt = e; this.skip = s; },
    "set(II)V": function (this: JCryptoPattern, e: number, s: number) { this.encrypt = e; this.skip = s; },
    "getEncryptBlocks()I": function (this: JCryptoPattern) { return this.encrypt; },
    "getSkipBlocks()I": function (this: JCryptoPattern) { return this.skip; },
  },
});

