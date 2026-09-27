// android.media: MediaPlayer over HTMLAudioElement, SoundPool over Web Audio.

import { rt, JObj, stubs, noops, fieldGetters, driven, type Gen } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import { vcall, stringHash, vcallUncaught, javaFormat } from "../jvm/natives/jlang";
import { uuidFromString } from "../jvm/natives/jvalues";
import { newArrayList, newStringSet, type JList } from "../jvm/natives/jutil";
import { type JFileDescriptor, vfs } from "../jvm/natives/jio";
import { javaFdSource } from "../native/stdio";
import { readFully } from "../shell/lazyfile";
import type { JBuffer } from "../jvm/natives/jnio";
rt.markers("android/media/AudioManager$OnAudioFocusChangeListener", "android/media/ImageReader$OnImageAvailableListener");
/** the rate the Web Audio output actually runs at */
export const outputSampleRate = (): number => actx?.sampleRate ?? 44100;
let audioSession = 0;
export const newAudioSessionId = (): number => ++audioSession;
import { onMain } from "./mainloop";
import { JBundle, reportUncaught } from "./os";
import { mkUri, uriParts, type JUri } from "./net";
import { currentResources, frameworkString } from "./res";
import { csText } from "./text";
import { scannedMediaUri } from "./mediastore";

rt.register({ name: "android/media/audiofx/AudioEffect$Descriptor", ctor: class extends JObj { type = null; }, fields: { type: "type" } });
rt.register({ name: "android/media/audiofx/AudioEffect", ctor: class extends JObj {},
  statics: { EFFECT_TYPE_LOUDNESS_ENHANCER: uuidFromString("fe3199be-aed0-413f-87bb-11260eb63cf1") },
  methods: { "static queryEffects()[Landroid/media/audiofx/AudioEffect$Descriptor;": () => jarray([], "Landroid/media/audiofx/AudioEffect$Descriptor;") },
});


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
  methods: { ...noops("<init>()V", "onSessionDestroyed()V", "onSessionEvent(Ljava/lang/String;Landroid/os/Bundle;)V",
    "onPlaybackStateChanged(Landroid/media/session/PlaybackState;)V", "onMetadataChanged(Landroid/media/MediaMetadata;)V",
    "onQueueChanged(Ljava/util/List;)V", "onQueueTitleChanged(Ljava/lang/CharSequence;)V",
    "onExtrasChanged(Landroid/os/Bundle;)V", "onAudioInfoChanged(Landroid/media/session/MediaController$PlaybackInfo;)V") },
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
  customActions: JList = newArrayList();
  activeQueueItemId = -1n;
  extras: unknown = null;
}
class JPlaybackStateBuilder extends JObj {
  value = new JPlaybackState();
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
rt.register({ name: "android/media/session/PlaybackState$CustomAction", ctor: JPlaybackCustomAction, ifaces: ["android/os/Parcelable"], methods: {
  "getAction()Ljava/lang/String;": function (this: JPlaybackCustomAction) { return this.action; },
  "getName()Ljava/lang/CharSequence;": function (this: JPlaybackCustomAction) { return this.name; },
  "getIcon()I": function (this: JPlaybackCustomAction) { return this.icon; },
  "getExtras()Landroid/os/Bundle;": function (this: JPlaybackCustomAction) { return this.extras; },
} });
rt.register({ name: "android/media/session/PlaybackState$CustomAction$Builder", ctor: JPlaybackCustomActionBuilder, methods: {
  "<init>(Ljava/lang/String;Ljava/lang/CharSequence;I)V": function (this: JPlaybackCustomActionBuilder, action: string, name: unknown, icon: number) {
    this.value.action = action; this.value.name = name; this.value.icon = icon;
  },
  "setExtras(Landroid/os/Bundle;)Landroid/media/session/PlaybackState$CustomAction$Builder;": function (this: JPlaybackCustomActionBuilder, extras: unknown) { this.value.extras = extras; return this; },
  "build()Landroid/media/session/PlaybackState$CustomAction;": function (this: JPlaybackCustomActionBuilder) { return Object.assign(new JPlaybackCustomAction(), this.value); },
} });
rt.register({ name: "android/media/session/PlaybackState", ctor: JPlaybackState, ifaces: ["android/os/Parcelable"], methods: {
  "getState()I": function (this: JPlaybackState) { return this.state; },
  "getPosition()J": function (this: JPlaybackState) { return this.position; },
  "getBufferedPosition()J": function (this: JPlaybackState) { return this.bufferedPosition; },
  "getPlaybackSpeed()F": function (this: JPlaybackState) { return this.speed; },
  "getActions()J": function (this: JPlaybackState) { return this.actions; },
  "getErrorMessage()Ljava/lang/CharSequence;": function (this: JPlaybackState) { return this.errorMessage; },
  "getLastPositionUpdateTime()J": function (this: JPlaybackState) { return this.updateTime; },
  "getCustomActions()Ljava/util/List;": function (this: JPlaybackState) { return this.customActions; },
  "getActiveQueueItemId()J": function (this: JPlaybackState) { return this.activeQueueItemId; },
  "getExtras()Landroid/os/Bundle;": function (this: JPlaybackState) { return this.extras; },
} });
rt.register({ name: "android/media/session/PlaybackState$Builder", ctor: JPlaybackStateBuilder, methods: {
  "<init>()V": () => {},
  "setState(IJFJ)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackStateBuilder, state: number, position: bigint, speed: number, time: bigint) {
    this.value.state = state; this.value.position = position; this.value.speed = speed; this.value.updateTime = time; return this;
  },
  "setBufferedPosition(J)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackStateBuilder, position: bigint) { this.value.bufferedPosition = position; return this; },
  "setActions(J)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackStateBuilder, actions: bigint) { this.value.actions = actions; return this; },
  "setErrorMessage(Ljava/lang/CharSequence;)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackStateBuilder, message: unknown) { this.value.errorMessage = message; return this; },
  "addCustomAction(Landroid/media/session/PlaybackState$CustomAction;)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackStateBuilder, action: unknown) { this.value.customActions.a.push(action); return this; },
  "setActiveQueueItemId(J)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackStateBuilder, id: bigint) { this.value.activeQueueItemId = id; return this; },
  "setExtras(Landroid/os/Bundle;)Landroid/media/session/PlaybackState$Builder;": function (this: JPlaybackStateBuilder, extras: unknown) { this.value.extras = extras; return this; },
  "build()Landroid/media/session/PlaybackState;": function (this: JPlaybackStateBuilder) {
    return Object.assign(new JPlaybackState(), this.value, { customActions: newArrayList(this.value.customActions.a.slice()) });
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
rt.register({ name: "android/media/MediaMetadata$Builder", ctor: JMediaMetadataBuilder, methods: {
  "<init>()V": () => {},
  "putText(Ljava/lang/String;Ljava/lang/CharSequence;)Landroid/media/MediaMetadata$Builder;": function (this: JMediaMetadataBuilder, key: string, value: unknown) { this.value.values.set(key, value); return this; },
  "putString(Ljava/lang/String;Ljava/lang/String;)Landroid/media/MediaMetadata$Builder;": function (this: JMediaMetadataBuilder, key: string, value: string) { this.value.values.set(key, value); return this; },
  "putLong(Ljava/lang/String;J)Landroid/media/MediaMetadata$Builder;": function (this: JMediaMetadataBuilder, key: string, value: bigint) { this.value.values.set(key, value); return this; },
  "putBitmap(Ljava/lang/String;Landroid/graphics/Bitmap;)Landroid/media/MediaMetadata$Builder;": function (this: JMediaMetadataBuilder, key: string, value: unknown) { this.value.values.set(key, value); return this; },
  "putRating(Ljava/lang/String;Landroid/media/Rating;)Landroid/media/MediaMetadata$Builder;": function (this: JMediaMetadataBuilder, key: string, value: unknown) { this.value.values.set(key, value); return this; },
  "build()Landroid/media/MediaMetadata;": function (this: JMediaMetadataBuilder) { const value = new JMediaMetadata(); value.values = new Map(this.value.values); return value; },
} });
class JAudioAttributes extends JObj { usage = 0; contentType = 0; flags = 0x800; }
rt.register({
  name: "android/media/AudioAttributes", ctor: JAudioAttributes, ifaces: ["android/os/Parcelable"],
  methods: {
    "getUsage()I": function (this: JAudioAttributes) { return this.usage; },
    "getContentType()I": function (this: JAudioAttributes) { return this.contentType; },
    "getFlags()I": function (this: JAudioAttributes) { return this.flags & 0x111; },
    "getAllFlags()I": function (this: JAudioAttributes) { return this.flags & 0x1f7ff; },
    "getAllowedCapturePolicy()I": function (this: JAudioAttributes) { return this.flags & 0x1000 ? 3 : this.flags & 0x400 ? 2 : 1; },
    "areHapticChannelsMuted()Z": function (this: JAudioAttributes) { return this.flags & 0x800 ? 1 : 0; },
    "isContentSpatialized()Z": function (this: JAudioAttributes) { return this.flags & 0x4000 ? 1 : 0; },
    "getSpatializationBehavior()I": function (this: JAudioAttributes) { return this.flags & 0x8000 ? 1 : 0; },
    "equals(Ljava/lang/Object;)Z": function (this: JAudioAttributes, other: unknown) {
      return other instanceof JAudioAttributes && this.usage === other.usage && this.contentType === other.contentType && this.flags === other.flags ? 1 : 0;
    },
    "hashCode()I": function (this: JAudioAttributes) { return ((this.contentType * 31 + this.usage) * 31 + this.flags) | 0; },
  },
});
class JAudioAttributesBuilder extends JObj { attrs = new JAudioAttributes(); }
function setLegacyStreamType(this: JAudioAttributesBuilder, stream: number) {
  switch (stream) {
    case 0: case 6: this.attrs.contentType = 1; this.attrs.usage = 2; break;
    case 1: this.attrs.contentType = 4; this.attrs.usage = 13; break;
    case 2: this.attrs.contentType = 4; this.attrs.usage = 6; break;
    case 3: this.attrs.contentType = 2; this.attrs.usage = 1; break;
    case 4: this.attrs.contentType = 4; this.attrs.usage = 4; break;
    case 5: this.attrs.contentType = 4; this.attrs.usage = 5; break;
    case 7: this.attrs.contentType = 4; this.attrs.usage = 13; this.attrs.flags |= 1; break;
    case 8: this.attrs.contentType = 4; this.attrs.usage = 3; break;
    case 9: this.attrs.contentType = 1; this.attrs.usage = 11; break;
    default: throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid stream type " + stream);
  }
  return this;
}
rt.register({
  name: "android/media/AudioAttributes$Builder", ctor: JAudioAttributesBuilder,
  methods: {
    "<init>()V": function () {},
    "setFlags(I)Landroid/media/AudioAttributes$Builder;": function (this: JAudioAttributesBuilder, flags: number) { this.attrs.flags |= flags & 0x1d1; return this; },
    "setLegacyStreamType(I)Landroid/media/AudioAttributes$Builder;": setLegacyStreamType,
    "setAllowedCapturePolicy(I)Landroid/media/AudioAttributes$Builder;": function (this: JAudioAttributesBuilder, policy: number) {
      if (policy < 1 || policy > 3) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid capture policy " + policy);
      this.attrs.flags = (this.attrs.flags & ~0x1400) | (policy === 3 ? 0x1400 : policy === 2 ? 0x400 : 0); return this;
    },
    "setHapticChannelsMuted(Z)Landroid/media/AudioAttributes$Builder;": function (this: JAudioAttributesBuilder, muted: number) { this.attrs.flags = (this.attrs.flags & ~0x800) | (muted ? 0x800 : 0); return this; },
    "setIsContentSpatialized(Z)Landroid/media/AudioAttributes$Builder;": function (this: JAudioAttributesBuilder, spatialized: number) { this.attrs.flags = (this.attrs.flags & ~0x4000) | (spatialized ? 0x4000 : 0); return this; },
    "setSpatializationBehavior(I)Landroid/media/AudioAttributes$Builder;": function (this: JAudioAttributesBuilder, behavior: number) {
      if (behavior !== 0 && behavior !== 1) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid spatialization behavior " + behavior);
      this.attrs.flags = (this.attrs.flags & ~0x8000) | (behavior ? 0x8000 : 0); return this;
    },
    "setUsage(I)Landroid/media/AudioAttributes$Builder;": function (this: JAudioAttributesBuilder, usage: number) {
      if (usage < 0 || usage > 16) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid usage " + usage);
      this.attrs.usage = usage; return this;
    },
    "setContentType(I)Landroid/media/AudioAttributes$Builder;": function (this: JAudioAttributesBuilder, type: number) {
      if (type < 0 || type > 4) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid content type " + type);
      this.attrs.contentType = type; return this;
    },
    "build()Landroid/media/AudioAttributes;": function (this: JAudioAttributesBuilder) {
      const attrs = Object.assign(new JAudioAttributes(), this.attrs);
      if (attrs.usage >= 7 && attrs.usage <= 9) attrs.usage = 5;
      return attrs;
    },
  },
});

class JAudioFocusRequest extends JObj {
  gain = 0;
  attrs = Object.assign(new JAudioAttributes(), { usage: 1 });
  listener: unknown = null;
  handler: unknown = null;
  acceptsDelayed = false;
  pausesOnDuck = false;
}
class JAudioFocusRequestBuilder extends JObj { request = new JAudioFocusRequest(); }
function setFocusGain(request: JAudioFocusRequest, gain: number) {
  if (gain < 1 || gain > 4) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Illegal audio focus gain type " + gain);
  request.gain = gain;
}
rt.register({ name: "android/media/AudioFocusRequest", ctor: JAudioFocusRequest, methods: {
  "getFocusGain()I": function (this: JAudioFocusRequest) { return this.gain; },
  "getAudioAttributes()Landroid/media/AudioAttributes;": function (this: JAudioFocusRequest) { return this.attrs; },
  "willPauseWhenDucked()Z": function (this: JAudioFocusRequest) { return +this.pausesOnDuck; },
  "acceptsDelayedFocusGain()Z": function (this: JAudioFocusRequest) { return +this.acceptsDelayed; },
  "getOnAudioFocusChangeListener()Landroid/media/AudioManager$OnAudioFocusChangeListener;": function (this: JAudioFocusRequest) { return this.listener; },
} });
rt.register({ name: "android/media/AudioFocusRequest$Builder", ctor: JAudioFocusRequestBuilder, methods: {
  "<init>(I)V": function (this: JAudioFocusRequestBuilder, gain: number) { setFocusGain(this.request, gain); },
  "setFocusGain(I)Landroid/media/AudioFocusRequest$Builder;": function (this: JAudioFocusRequestBuilder, gain: number) { setFocusGain(this.request, gain); return this; },
  "setAudioAttributes(Landroid/media/AudioAttributes;)Landroid/media/AudioFocusRequest$Builder;": function (this: JAudioFocusRequestBuilder, attrs: JAudioAttributes | null) {
    if (!attrs) throw rt.mkThrowable("java/lang/NullPointerException", "Illegal null AudioAttributes");
    this.request.attrs = attrs; return this;
  },
  "setOnAudioFocusChangeListener(Landroid/media/AudioManager$OnAudioFocusChangeListener;)Landroid/media/AudioFocusRequest$Builder;": function (this: JAudioFocusRequestBuilder, listener: unknown) {
    if (!listener) throw rt.mkThrowable("java/lang/NullPointerException", "Illegal null focus listener");
    this.request.listener = listener; this.request.handler = null; return this;
  },
  "setOnAudioFocusChangeListener(Landroid/media/AudioManager$OnAudioFocusChangeListener;Landroid/os/Handler;)Landroid/media/AudioFocusRequest$Builder;": function (this: JAudioFocusRequestBuilder, listener: unknown, handler: unknown) {
    if (!listener || !handler) throw rt.mkThrowable("java/lang/NullPointerException", "Illegal null focus listener or handler");
    this.request.listener = listener; this.request.handler = handler; return this;
  },
  "setAcceptsDelayedFocusGain(Z)Landroid/media/AudioFocusRequest$Builder;": function (this: JAudioFocusRequestBuilder, value: number) { this.request.acceptsDelayed = !!value; return this; },
  "setWillPauseWhenDucked(Z)Landroid/media/AudioFocusRequest$Builder;": function (this: JAudioFocusRequestBuilder, value: number) { this.request.pausesOnDuck = !!value; return this; },
  "build()Landroid/media/AudioFocusRequest;": function (this: JAudioFocusRequestBuilder) { return Object.assign(new JAudioFocusRequest(), this.request); },
} });

const players = new Set<JMediaPlayer>();
const pools = new Set<JSoundPool>();
/** AudioManager.isMusicActive: a MediaPlayer or a SoundPool stream is sounding right now. */
export function isMusicActive(): number {
  for (const p of players) if (p.audio && !p.audio.paused) return 1;
  for (const p of pools) for (const s of p.streams.values()) if (s.src.playbackRate.value) return 1;
  return 0;
}

class JMediaPlayer extends JObj {
  audio: HTMLAudioElement | null = null;
  attributes: JAudioAttributes | null = null;
  looping = false;
  prepared = false;
  preparedL: unknown = null;
  completionL: unknown = null;
  srcBytes: Uint8Array | null = null;
}
function mpReset(mp: JMediaPlayer) {
  players.delete(mp);
  if (mp.audio) {
    mp.audio.pause();
    URL.revokeObjectURL(mp.audio.src);
  }
  mp.audio = null;
  mp.srcBytes = null;
  mp.prepared = false;
}
function mpLoad(mp: JMediaPlayer, bytes: Uint8Array) {
  mpReset(mp);
  const blob = new Blob([bytes as BlobPart]);
  mp.audio = new Audio(URL.createObjectURL(blob));
  mp.audio.loop = mp.looping;
  mp.srcBytes = bytes;
  mp.audio.onended = () => {
    if (mp.completionL) void vcallUncaught(mp.completionL, "onCompletion", "(Landroid/media/MediaPlayer;)V", mp);
  };
}
async function mpLoadFd(this: JMediaPlayer, fd: JFileDescriptor, offset = 0n, length = 0x7fffffffffffffffn) {
  if (fd === null) rt.npe();
  const source = javaFdSource(fd.fd) ?? vfs.source(fd.path);
  if (!source || offset < 0n || length <= 0n || offset >= BigInt(source.size)) {
    throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid media file descriptor or range");
  }
  mpLoad(this, await readFully(source, Number(offset), Math.min(Number(length), source.size - Number(offset))));
}
function mpPrepare(mp: JMediaPlayer) {
  if (!mp.audio) throw rt.mkThrowable("java/lang/IllegalStateException", "MediaPlayer has no data source");
  mp.prepared = true;
  const listener = mp.preparedL;
  if (listener) setTimeout(() => {
    if (mp.prepared && mp.preparedL === listener) void vcallUncaught(listener, "onPrepared", "(Landroid/media/MediaPlayer;)V", mp);
  }, 0);
}
rt.register({
  name: "android/media/MediaPlayer", ctor: JMediaPlayer,
  methods: {
    "static create(Landroid/content/Context;I)Landroid/media/MediaPlayer;": (c: any, resId: number) => {
      const mp = new JMediaPlayer();
      const host = c?.$host;
      if (host) {
        const f = host.res.fileOf(resId);
        if (f) mpLoad(mp, f.bytes);
      }
      return mp;
    },
    "prepare()V": function (this: JMediaPlayer) { mpPrepare(this); },
    "prepareAsync()V": function (this: JMediaPlayer) { mpPrepare(this); },
    "start()V": function (this: JMediaPlayer) { players.add(this); void this.audio?.play().catch(() => { /* */ }); },
    "pause()V": function (this: JMediaPlayer) { this.audio?.pause(); },
    "stop()V": function (this: JMediaPlayer) {
      if (this.audio) {
        this.audio.pause();
        this.audio.currentTime = 0;
      }
    },
    "release()V": function (this: JMediaPlayer) { mpReset(this); },
    "isPlaying()Z": function (this: JMediaPlayer) { return this.audio && !this.audio.paused ? 1 : 0; },
    "setLooping(Z)V": function (this: JMediaPlayer, l: number) {
      this.looping = !!l;
      if (this.audio) this.audio.loop = !!l;
    },
    "setAudioAttributes(Landroid/media/AudioAttributes;)V": function (this: JMediaPlayer, attributes: JAudioAttributes | null) {
      if (attributes === null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "AudioAttributes must not be null");
      this.attributes = attributes;
    },
    "setVolume(FF)V": function (this: JMediaPlayer, v: number) { if (this.audio) this.audio.volume = Math.min(1, v); },
    "setOnCompletionListener(Landroid/media/MediaPlayer$OnCompletionListener;)V": function (this: JMediaPlayer, l: unknown) {
      this.completionL = l;
    },
    "setOnPreparedListener(Landroid/media/MediaPlayer$OnPreparedListener;)V": function (this: JMediaPlayer, l: unknown) {
      this.preparedL = l;
    },
    "setDataSource(Ljava/io/FileDescriptor;JJ)V": mpLoadFd,
    "setDataSource(Ljava/io/FileDescriptor;)V": mpLoadFd,
    "setDataSource(Landroid/content/Context;Landroid/net/Uri;)V": driven(function* (this: JMediaPlayer, context: unknown, uri: unknown): Gen {
      const resolver = yield vcall(context, "getContentResolver", "()Landroid/content/ContentResolver;");
      const asset = yield vcall(resolver, "openAssetFileDescriptor", "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/res/AssetFileDescriptor;", uri, "r");
      if (asset === null) throw rt.mkThrowable("java/io/FileNotFoundException", "Media source not found");
      try {
        const fd = yield vcall(asset, "getFileDescriptor", "()Ljava/io/FileDescriptor;");
        const offset = yield vcall(asset, "getStartOffset", "()J");
        const length = yield vcall(asset, "getLength", "()J");
        yield mpLoadFd.call(this, fd, offset, length);
      } finally { yield vcall(asset, "close", "()V"); }
    }),
    "reset()V": function (this: JMediaPlayer) { mpReset(this); },
    ...noops("<init>()V",
      "setAudioStreamType(I)V", "setOnErrorListener(Landroid/media/MediaPlayer$OnErrorListener;)V",
      "setWakeMode(Landroid/content/Context;I)V"),
    "getDuration()I": function (this: JMediaPlayer) { return Math.round((this.audio?.duration ?? 0) * 1000); },
    "getCurrentPosition()I": function (this: JMediaPlayer) { return Math.round((this.audio?.currentTime ?? 0) * 1000); },
    "seekTo(I)V": function (this: JMediaPlayer, ms: number) { if (this.audio) this.audio.currentTime = ms / 1000; },
  },
});
for (const n of ["android/media/MediaPlayer$OnCompletionListener", "android/media/MediaPlayer$OnPreparedListener",
  "android/media/MediaPlayer$OnErrorListener", "android/media/MediaPlayer$OnInfoListener", "android/media/MediaPlayer$OnSeekCompleteListener",
  "android/media/SoundPool$OnLoadCompleteListener"]) {
  rt.register({ name: n, ctor: class extends JObj {} });
}

// ── RingtoneManager / Ringtone. A default URI names a Settings.System entry, and a device with
// none set has nothing to play for it; any other URI that cannot be opened plays the framework's
// fallback ring, as AOSP's Ringtone does.
const DEFAULT_SETTINGS = ["ringtone", "notification_sound", "alarm_alert"]; // TYPE_RINGTONE, TYPE_NOTIFICATION, TYPE_ALARM
const defaultType = (uri: JUri | null): number => {
  const i = uri ? DEFAULT_SETTINGS.findIndex((s) => uri.uri === "content://settings/system/" + s) : -1;
  return i < 0 ? -1 : 1 << i;
};
const defaultSetting = (type: number): string | null => DEFAULT_SETTINGS[type & 1 ? 0 : type & 2 ? 1 : type & 4 ? 2 : 3] ?? null;
const actualDefaultUri = driven(function* (context: unknown, type: number): Gen<JUri | null> {
  const setting = defaultSetting(type);
  if (!setting) return null;
  const resolver = yield vcall(context, "getContentResolver", "()Landroid/content/ContentResolver;");
  const value: string | null = yield vcall(rt.link("android/provider/Settings$System").ctor, "getString",
    "(Landroid/content/ContentResolver;Ljava/lang/String;)Ljava/lang/String;", resolver, setting);
  return value ? mkUri(value) : null;
});
const ringtoneTitle = driven(function* (context: unknown, uri: JUri | null, followDefault: boolean): Gen<string> {
  let title: string | null = null;
  if (!uri) title = frameworkString("ringtone_silent");
  else if (uriParts(uri).authority === "settings") {
    if (followDefault) {
      const actual: string = yield ringtoneTitle(context, yield actualDefaultUri(context, defaultType(uri)), false);
      title = javaFormat(frameworkString("ringtone_default_with_actual") ?? "%1$s", [actual]);
    }
  } else {
    if (uriParts(uri).authority === "media") {
      try {
        const resolver = yield vcall(context, "getContentResolver", "()Landroid/content/ContentResolver;");
        const cursor = yield vcall(resolver, "query", "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
          uri, jarray(["title"], "Ljava/lang/String;"), null, null, null);
        if (cursor) {
          if (yield vcall(cursor, "moveToFirst", "()Z")) title = yield vcall(cursor, "getString", "(I)Ljava/lang/String;", 0);
          yield vcall(cursor, "close", "()V");
        }
      } catch { /* AOSP falls back to the path */ }
    }
    title ??= yield vcall(uri, "getLastPathSegment", "()Ljava/lang/String;");
  }
  return title ?? frameworkString("ringtone_unknown") ?? "";
});
class JRingtone extends JObj {
  context: unknown = null; uri: JUri | null = null; player: JMediaPlayer | null = null;
  streamType = 2; attributes: JAudioAttributes | null = null; looping = false; volume = 1;
}
const setRingtoneUri = driven(function* (this: JRingtone, uri: JUri | null): Gen {
  if (this.player) mpReset(this.player);
  this.uri = uri; this.player = null;
  const source: JUri | null = defaultType(uri) < 0 ? uri : yield actualDefaultUri(this.context, defaultType(uri));
  if (!source) return;
  const player: JMediaPlayer = rt.make("android/media/MediaPlayer");
  try {
    yield vcall(player, "setDataSource", "(Landroid/content/Context;Landroid/net/Uri;)V", this.context, source);
    this.player = player;
  } catch { /* play() falls back */ }
});
function startRingtone(r: JRingtone, player: JMediaPlayer) {
  r.player = player;
  player.looping = r.looping;
  if (player.audio) { player.audio.loop = r.looping; player.audio.volume = r.volume; }
  players.add(player); void player.audio?.play().catch(() => { /* */ });
}
rt.register({ name: "android/media/Ringtone", ctor: JRingtone,
  methods: {
    "getTitle(Landroid/content/Context;)Ljava/lang/String;": function (this: JRingtone, context: unknown) { return ringtoneTitle(context, this.uri, true); },
    "getUri()Landroid/net/Uri;": function (this: JRingtone) { return this.uri; },
    "setUri(Landroid/net/Uri;)V": setRingtoneUri,
    "play()V": function (this: JRingtone) {
      if (this.player) return startRingtone(this, this.player);
      if (!this.uri || defaultType(this.uri) >= 0) return;
      const res = currentResources(), id = res?.idFor("raw", "fallbackring", "android"), file = id ? res!.fileOf(id) : null;
      if (!file) return;
      const player: JMediaPlayer = rt.make("android/media/MediaPlayer");
      mpLoad(player, file.bytes);
      startRingtone(this, player);
    },
    "stop()V": function (this: JRingtone) { if (this.player) mpReset(this.player); },
    "isPlaying()Z": function (this: JRingtone) { return this.player?.audio && !this.player.audio.paused ? 1 : 0; },
    "setLooping(Z)V": function (this: JRingtone, looping: number) {
      this.looping = !!looping;
      if (this.player?.audio) this.player.audio.loop = this.looping;
    },
    "isLooping()Z": function (this: JRingtone) { return +this.looping; },
    "setVolume(F)V": function (this: JRingtone, volume: number) {
      this.volume = Math.max(0, Math.min(1, volume));
      if (this.player?.audio) this.player.audio.volume = this.volume;
    },
    "getVolume()F": function (this: JRingtone) { return this.volume; },
    "setStreamType(I)V": function (this: JRingtone, type: number) {
      const attrs: JAudioAttributes = rt.make("android/media/AudioAttributes");
      setLegacyStreamType.call({ attrs } as JAudioAttributesBuilder, type);
      this.streamType = type; this.attributes = attrs;
    },
    "getStreamType()I": function (this: JRingtone) { return this.streamType; },
    "setAudioAttributes(Landroid/media/AudioAttributes;)V": function (this: JRingtone, attributes: JAudioAttributes | null) {
      if (!attributes) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid null AudioAttributes for Ringtone");
      this.attributes = attributes;
    },
    "getAudioAttributes()Landroid/media/AudioAttributes;": function (this: JRingtone) {
      return this.attributes ??= Object.assign(rt.make("android/media/AudioAttributes") as JAudioAttributes, { usage: 6, contentType: 4 });
    },
  },
});
rt.register({ name: "android/media/RingtoneManager", ctor: class extends JObj {},
  statics: { TYPE_RINGTONE: 1, TYPE_NOTIFICATION: 2, TYPE_ALARM: 4, TYPE_ALL: 7 },
  methods: {
    "static getDefaultUri(I)Landroid/net/Uri;": (type: number) => {
      const setting = defaultSetting(type);
      return setting ? mkUri("content://settings/system/" + setting) : null;
    },
    "static getDefaultType(Landroid/net/Uri;)I": defaultType,
    "static isDefault(Landroid/net/Uri;)Z": (uri: JUri | null) => +(defaultType(uri) >= 0),
    "static getActualDefaultRingtoneUri(Landroid/content/Context;I)Landroid/net/Uri;": actualDefaultUri,
    "static getRingtone(Landroid/content/Context;Landroid/net/Uri;)Landroid/media/Ringtone;": driven(function* (context: unknown, uri: JUri | null): Gen {
      const ringtone: JRingtone = rt.make("android/media/Ringtone");
      ringtone.context = context;
      yield setRingtoneUri.call(ringtone, uri);
      return ringtone;
    }),
  },
});

// ── SoundPool: one shared AudioContext (never closed), a decoded AudioBuffer per sound id
// (null while decoding), and a one-shot source + gain node per stream id.
let actx: AudioContext | null = null;
type Stream = { src: AudioBufferSourceNode; gain: GainNode; prio: number; rate: number };
class JSoundPool extends JObj {
  maxStreams = 1;
  audioAttributes = new JAudioAttributes();
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
    "load(Landroid/content/res/AssetFileDescriptor;I)I": function (this: JSoundPool, afd: any) { return this.load(afd?.bytes ?? null); },
    "load(Landroid/content/Context;II)I": function (this: JSoundPool, c: any, resId: number) {
      const host = c?.$host;
      return this.load(host?.res.fileOf(resId)?.bytes ?? null);
    },
    "load(Ljava/lang/String;I)I": function (this: JSoundPool, path: string) { return this.load(vfs.read(path)); },
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
class JSoundPoolBuilder extends JObj { max = 1; attrs: JAudioAttributes | null = null; }
rt.register({
  name: "android/media/SoundPool$Builder", ctor: JSoundPoolBuilder,
  methods: {
    "<init>()V": function () {},
    "setMaxStreams(I)Landroid/media/SoundPool$Builder;": function (this: JSoundPoolBuilder, n: number) { this.max = n; return this; },
    "setAudioAttributes(Landroid/media/AudioAttributes;)Landroid/media/SoundPool$Builder;": function (this: JSoundPoolBuilder, attrs: JAudioAttributes | null) {
      if (!attrs) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid null AudioAttributes");
      this.attrs = attrs; return this;
    },
    "build()Landroid/media/SoundPool;": function (this: JSoundPoolBuilder) {
      const p = new JSoundPool(); p.maxStreams = this.max;
      if (this.attrs) p.audioAttributes = this.attrs; else p.audioAttributes.usage = 1;
      pools.add(p); return p;
    },
  },
});

// ── AudioTrack (MODE_STREAM): PCM written from Java is scheduled back-to-back on the shared
// AudioContext; the periodic position listener is what streaming mixers (a native engine's
// SoundPlayer) refill from, so it fires whenever the queue runs below a few periods.
const D_periodic = "(Landroid/media/AudioTrack;)V";
export class JAudioTrack extends JObj {
  rate = 44100; channels = 2; bytesPerSample = 2; bufBytes = 0;
  sessionId = 0; attributes: unknown = null;
  logSessionId = noLogSessionId;

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
  writeBuffer(buffer: JBuffer, n: number, mode: number): number | Promise<number> {
    if (this.state !== 1) return -3;
    if (!buffer || n < 0 || n > buffer.lim - buffer.pos || (mode !== 0 && mode !== 1)) return -2;
    const requested = Math.floor(n / this.frameBytes()) * this.frameBytes();
    const available = Math.max(0, this.bufBytes - Math.ceil(this.queuedSec() * this.rate) * this.frameBytes());
    n = Math.floor(Math.min(requested, available) / this.frameBytes()) * this.frameBytes();
    if (!n) return mode === 0 && requested ? this.finishWrite(buffer, requested, 0) : 0;
    const data = new DataView(buffer.ab, buffer.dv.byteOffset + buffer.pos, n);
    const count = n / this.bytesPerSample;
    // AudioTrack consumes native-order PCM, independently of ByteBuffer.order().
    const SampleArray = this.bytesPerSample === 4 ? Float32Array : this.bytesPerSample === 2 ? Int16Array : Int8Array;
    const aligned = data.byteOffset % this.bytesPerSample === 0;
    const samples = aligned ? new SampleArray(data.buffer, data.byteOffset, count) : new SampleArray(count);
    if (!aligned) for (let i = 0; i < count; i++) samples[i] = this.bytesPerSample === 4 ? data.getFloat32(i * 4, true) : data.getInt16(i * 2, true);
    this.push(samples, n / this.frameBytes());
    buffer.pos += n;
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
rt.register({
  name: "android/media/AudioTrack", ctor: JAudioTrack,
  statics: { MODE_STATIC: 0, MODE_STREAM: 1, PLAYSTATE_STOPPED: 1, PLAYSTATE_PAUSED: 2, PLAYSTATE_PLAYING: 3, STATE_UNINITIALIZED: 0, STATE_INITIALIZED: 1, STATE_NO_STATIC_DATA: 2,
    SUCCESS: 0, ERROR: -1, ERROR_BAD_VALUE: -2, ERROR_INVALID_OPERATION: -3, WRITE_BLOCKING: 0, WRITE_NON_BLOCKING: 1 },
  methods: {
    "<init>(IIIIII)V": function (this: JAudioTrack, _stream: number, rate: number, chanCfg: number, fmt: number, bufBytes: number) {
      this.rate = rate; this.channels = chanCfg === 12 || chanCfg === 3 ? 2 : 1; this.bytesPerSample = fmt === 3 ? 1 : 2; this.bufBytes = bufBytes;
    },
    "static getMinBufferSize(III)I": (rate: number, chanCfg: number, fmt: number) => {
      // ~100 ms of frames, as AudioFlinger answers for a typical output
      const frames = Math.max(1024, Math.ceil(rate / 10));
      return frames * (chanCfg === 12 || chanCfg === 3 ? 2 : 1) * (fmt === 3 ? 1 : 2);
    },
    "static getNativeOutputSampleRate(I)I": () => outputSampleRate(),
    "static getMaxVolume()F": () => 1, "static getMinVolume()F": () => 0,
    "getLogSessionId()Landroid/media/metrics/LogSessionId;": function (this: JAudioTrack) { rt.link("android/media/metrics/LogSessionId"); return this.logSessionId; },
    "setLogSessionId(Landroid/media/metrics/LogSessionId;)V": function (this: JAudioTrack, id: JLogSessionId) {
      if (!id) return rt.npe();
      if (this.state !== 1) throw rt.mkThrowable("java/lang/IllegalStateException", "AudioTrack not initialized");
      this.logSessionId = id;
    },
    "getPlaybackHeadPosition()I": function (this: JAudioTrack) { return this.playState === 1 ? 0 : Math.floor(this.head() - this.headOrigin) | 0; },
    "setStereoVolume(FF)I": function (this: JAudioTrack, l: number, r: number) { this.vol = (l + r) / 2; if (this.gain) this.gain.gain.value = this.vol; return 0; },
    "setVolume(F)I": function (this: JAudioTrack, v: number) { this.vol = v; if (this.gain) this.gain.gain.value = v; return 0; },
    "setPlaybackPositionUpdateListener(Landroid/media/AudioTrack$OnPlaybackPositionUpdateListener;)V": function (this: JAudioTrack, l: unknown) { this.listener = l; if (!l) this.stopTimer(); else if (this.playState === 3) this.startTimer(); },
    "setPlaybackPositionUpdateListener(Landroid/media/AudioTrack$OnPlaybackPositionUpdateListener;Landroid/os/Handler;)V": function (this: JAudioTrack, l: unknown) { this.listener = l; if (!l) this.stopTimer(); else if (this.playState === 3) this.startTimer(); },
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
      if (this.bytesPerSample === 2) this.push(new Int16Array(data.buffer.slice(data.byteOffset + off, data.byteOffset + off + (n & ~1))), Math.floor(n / this.frameBytes()));
      else this.push(data.subarray(off, off + n), Math.floor(n / this.channels));
      return mode === 1 ? n : this.wrote(n);   // WRITE_NON_BLOCKING
    },
    "write([BII)I": function (this: JAudioTrack, data: Int8Array, off: number, n: number) {
      if (this.state !== 1) return -3;
      if (this.bytesPerSample === 2) this.push(new Int16Array(data.buffer.slice(data.byteOffset + off, data.byteOffset + off + (n & ~1))), Math.floor(n / this.frameBytes()));
      else this.push(data.subarray(off, off + n), Math.floor(n / this.channels));
      return this.wrote(n);
    },
    "getBufferSizeInFrames()I": function (this: JAudioTrack) { return Math.floor(this.bufBytes / this.frameBytes()); },
    "getBufferCapacityInFrames()I": function (this: JAudioTrack) { return Math.floor(this.bufBytes / this.frameBytes()); },
    ...fieldGetters({ "getState()I": "state", "getPlayState()I": "playState", "getSampleRate()I": "rate",
      "getChannelCount()I": "channels", "getAudioSessionId()I": "sessionId",
      "getAudioAttributes()Landroid/media/AudioAttributes;": "attributes", "getUnderrunCount()I": "underruns" }),
    ...stubs(0, "static isDirectPlaybackSupported(Landroid/media/AudioFormat;Landroid/media/AudioAttributes;)Z",
      "setPlaybackRate(I)I", "setNotificationMarkerPosition(I)I", "isOffloadedPlayback()Z",
      "getTimestamp(Landroid/media/AudioTimestamp;)Z", "setPreferredDevice(Landroid/media/AudioDeviceInfo;)Z"),
    ...stubs(null, "getRoutedDevice()Landroid/media/AudioDeviceInfo;"),
    ...noops("addOnRoutingChangedListener(Landroid/media/AudioRouting$OnRoutingChangedListener;Landroid/os/Handler;)V",
      "removeOnRoutingChangedListener(Landroid/media/AudioRouting$OnRoutingChangedListener;)V"),
    "write(Ljava/nio/ByteBuffer;II)I": function (this: JAudioTrack, buffer: JBuffer, n: number, mode: number) { return this.writeBuffer(buffer, n, mode); },
    "write(Ljava/nio/ByteBuffer;IIJ)I": function (this: JAudioTrack, buffer: JBuffer, n: number, mode: number) { return this.writeBuffer(buffer, n, mode); },
  },
});
let nextAudioSession = 1;
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
      let mask = format?.channelIndexMask || format?.channelMask || 12, channels = 0;
      for (; mask; mask &= mask - 1) channels++;
      track.channels = channels;
      track.bytesPerSample = encoding === 4 ? 4 : encoding === 3 ? 1 : 2;
      track.bufBytes = this.bufferSize || Math.max(1024, Math.ceil(track.rate / 10)) * track.frameBytes();
      if (track.bufBytes % track.frameBytes()) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Buffer size must contain whole frames");
      track.attributes = this.attributes;
      track.sessionId = this.sessionId || nextAudioSession++;
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
    "getChannelCount()I": function (this: JAudioFormat) {
      let mask = this.channelMask || this.channelIndexMask, n = 0;
      for (; mask; mask &= mask - 1) n++;
      return n;
    },
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
          void onMain(async () => vcall(l, "onScanCompleted", "(Ljava/lang/String;Landroid/net/Uri;)V", p, await scannedMediaUri(p))).catch(reportUncaught);
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

// ── MediaRouter: one route, the device's own display, with no presentation display behind it
class JRouteInfo extends JObj { tag: unknown = null; }
class JRouteCategory extends JObj { name: unknown = ""; groupable = false; }
const theRoute = new JRouteInfo();
let routeAudio: JObj | null = null;
function routeVolume(method: string): Promise<unknown> {
  routeAudio ??= new (rt.link("android/media/AudioManager").ctor)();
  return vcall(routeAudio, method, "(I)I", 3);
}
rt.register({
  name: "android/media/MediaRouter", ctor: class extends JObj {},
  statics: { ROUTE_TYPE_LIVE_AUDIO: 1, ROUTE_TYPE_LIVE_VIDEO: 2, ROUTE_TYPE_USER: 0x800000, CALLBACK_FLAG_PERFORM_ACTIVE_SCAN: 1, CALLBACK_FLAG_UNFILTERED_EVENTS: 2 },
  methods: {
    "createRouteCategory(Ljava/lang/CharSequence;Z)Landroid/media/MediaRouter$RouteCategory;": (name: unknown, groupable: number) => {
      rt.link("android/media/MediaRouter$RouteCategory");
      const category = new JRouteCategory(); category.name = name; category.groupable = !!groupable; return category;
    },
    "getSelectedRoute(I)Landroid/media/MediaRouter$RouteInfo;": () => theRoute,
    "getDefaultRoute()Landroid/media/MediaRouter$RouteInfo;": () => theRoute,
    "getRouteAt(I)Landroid/media/MediaRouter$RouteInfo;": (i: number) => (i === 0 ? theRoute : null),

    ...stubs(1, "getRouteCount()I"),
    ...noops("addCallback(ILandroid/media/MediaRouter$Callback;)V",
      "addCallback(ILandroid/media/MediaRouter$Callback;I)V", "removeCallback(Landroid/media/MediaRouter$Callback;)V"),
  },
});
rt.markers("android/media/MediaRouter$Callback");
rt.register({ name: "android/media/MediaRouter$VolumeCallback", ctor: class extends JObj {}, methods: { "<init>()V": function () {} } });
rt.register({ name: "android/media/MediaRouter$RouteCategory", ctor: JRouteCategory, methods: {
  "getName()Ljava/lang/CharSequence;": function (this: JRouteCategory) { return this.name; },
  "getName(Landroid/content/Context;)Ljava/lang/CharSequence;": function (this: JRouteCategory) { return this.name; },
  "getSupportedTypes()I": () => 0x800000,
  "isGroupable()Z": function (this: JRouteCategory) { return this.groupable ? 1 : 0; },
} });
class JCaptionStyle extends JObj {
  foregroundColor = -1; backgroundColor = -16777216; edgeType = 0; edgeColor = -16777216; windowColor = 0xff;
  typeface: unknown = null;
}
const defaultCaptionStyle = new JCaptionStyle();
rt.register({
  name: "android/view/accessibility/CaptioningManager$CaptionStyle", ctor: JCaptionStyle,
  fields: ["foregroundColor", "backgroundColor", "edgeType", "edgeColor", "windowColor", "typeface"],
  statics: { DEFAULT: defaultCaptionStyle },
  methods: {
    "<init>(IIIIILandroid/graphics/Typeface;)V": function (this: JCaptionStyle, foreground: number, background: number,
      edgeType: number, edgeColor: number, window: number, typeface: unknown) {
      Object.assign(this, { foregroundColor: foreground, backgroundColor: background, edgeType, edgeColor, windowColor: window, typeface });
    },
    "getTypeface()Landroid/graphics/Typeface;": function (this: JCaptionStyle) { return this.typeface; },
    ...stubs(1, "hasForegroundColor()Z", "hasBackgroundColor()Z", "hasEdgeType()Z", "hasEdgeColor()Z", "hasWindowColor()Z"),
  },
});
rt.register({ name: "android/view/accessibility/CaptioningManager", ctor: class extends JObj {}, methods: {
  "isEnabled()Z": () => 0,
  "getFontScale()F": () => 1,
  "getLocale()Ljava/util/Locale;": () => null,
  "getUserStyle()Landroid/view/accessibility/CaptioningManager$CaptionStyle;": () => defaultCaptionStyle,
  "addCaptioningChangeListener(Landroid/view/accessibility/CaptioningManager$CaptioningChangeListener;)V": () => {},
  "removeCaptioningChangeListener(Landroid/view/accessibility/CaptioningManager$CaptioningChangeListener;)V": () => {},
} });
rt.markers("android/view/accessibility/CaptioningManager$CaptioningChangeListener");
rt.register({
  name: "android/media/MediaRouter$RouteInfo", ctor: JRouteInfo,
  methods: {
    "getTag()Ljava/lang/Object;": function (this: JRouteInfo) { return this.tag; },
    "setTag(Ljava/lang/Object;)V": function (this: JRouteInfo, tag: unknown) { this.tag = tag; },
    "getPresentationDisplay()Landroid/view/Display;": () => null,
    "getName()Ljava/lang/CharSequence;": () => "Phone",
    "getName(Landroid/content/Context;)Ljava/lang/CharSequence;": () => "Phone",
    "getSupportedTypes()I": () => 3,
    "getPlaybackType()I": () => 0,
    "getPlaybackStream()I": () => 3,
    "getVolume()I": () => routeVolume("getStreamVolume"),
    "getVolumeMax()I": () => routeVolume("getStreamMaxVolume"),
    "getVolumeHandling()I": () => 1,
    "isConnecting()Z": () => 0,
    "getDescription()Ljava/lang/CharSequence;": () => null,
    "getDeviceType()I": () => 0,
    "isEnabled()Z": () => 1,

  },
});

rt.register({ name: "android/media/MediaCodec$Callback", ctor: class extends JObj {}, methods: { "<init>()V": function () {} } });
export class JLogSessionId extends JObj {
  constructor(public id = "") { super(); }
}
const noLogSessionId = new JLogSessionId();
rt.register({ name: "android/media/metrics/LogSessionId", ctor: JLogSessionId, statics: { LOG_SESSION_ID_NONE: noLogSessionId }, methods: {
  "<init>(Ljava/lang/String;)V": function (this: JLogSessionId, id: string) { if (id == null) throw rt.mkThrowable("java/lang/NullPointerException", "id"); this.id = id; },
  "getStringId()Ljava/lang/String;": function (this: JLogSessionId) { return this.id; },
  "toString()Ljava/lang/String;": function (this: JLogSessionId) { return this.id; },
  "equals(Ljava/lang/Object;)Z": function (this: JLogSessionId, other: unknown) { return +(other instanceof JLogSessionId && other.id === this.id); },
  "hashCode()I": function (this: JLogSessionId) { return stringHash(this.id); },
} });

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

export class JSpatializer extends JObj {}
rt.register({
  name: "android/media/Spatializer", ctor: JSpatializer,
  statics: { SPATIALIZER_IMMERSIVE_LEVEL_NONE: 0 },
  methods: {
    ...stubs(0, "getImmersiveAudioLevel()I", "isAvailable()Z", "isEnabled()Z",
      "canBeSpatialized(Landroid/media/AudioAttributes;Landroid/media/AudioFormat;)Z"),
    ...noops("addOnSpatializerStateChangedListener(Ljava/util/concurrent/Executor;Landroid/media/Spatializer$OnSpatializerStateChangedListener;)V",
      "removeOnSpatializerStateChangedListener(Landroid/media/Spatializer$OnSpatializerStateChangedListener;)V"),
  },
});
rt.markers("android/media/Spatializer$OnSpatializerStateChangedListener");

rt.register({
  name: "android/media/AudioDeviceCallback", ctor: class extends JObj {},
  methods: {
    ...noops("<init>()V", "onAudioDevicesAdded([Landroid/media/AudioDeviceInfo;)V",
      "onAudioDevicesRemoved([Landroid/media/AudioDeviceInfo;)V"),
  },
});
