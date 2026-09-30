// android.media.RingtoneManager and Ringtone, played through MediaPlayer.

import { rt, JObj, driven, type Gen } from "../jvm/runtime";
import { jarray } from "../jvm/abi";
import { vcall, scall, newObj, javaFormat } from "../jvm/natives/jlang";
import { mkUri, uriParts, type JUri } from "./net";
import { currentResources, frameworkString } from "./res";
import { type JMediaPlayer, mpLoad, mpReset, mpStart } from "./media";

// A default URI names a Settings.System entry, and a device with none set has nothing to play for
// it; any other URI that cannot be opened plays the framework's fallback ring, as AOSP's Ringtone does.
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
  attributes: unknown = null; looping = false; volume = 1;
}
const AAB = "Landroid/media/AudioAttributes$Builder;";
/** a Ringtone plays notification-ringtone sonification until given other attributes, as AOSP's does */
const ringtoneAttributes = driven(function* (r: JRingtone): Gen {
  if (r.attributes) return r.attributes;
  const builder = yield newObj("android/media/AudioAttributes$Builder");
  yield vcall(builder, "setUsage", "(I)" + AAB, 6);
  yield vcall(builder, "setContentType", "(I)" + AAB, 4);
  return r.attributes = yield vcall(builder, "build", "()Landroid/media/AudioAttributes;");
});
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
  if (player.media) { player.media.loop = r.looping; player.media.volume = r.volume; }
  mpStart(player);
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
    "isPlaying()Z": function (this: JRingtone) { return this.player?.media && !this.player.media.paused ? 1 : 0; },
    "setLooping(Z)V": function (this: JRingtone, looping: number) {
      this.looping = !!looping;
      if (this.player?.media) this.player.media.loop = this.looping;
    },
    "isLooping()Z": function (this: JRingtone) { return +this.looping; },
    "setVolume(F)V": function (this: JRingtone, volume: number) {
      this.volume = Math.max(0, Math.min(1, volume));
      if (this.player?.media) this.player.media.volume = this.volume;
    },
    "getVolume()F": function (this: JRingtone) { return this.volume; },
    "setStreamType(I)V": driven(function* (this: JRingtone, type: number): Gen {
      yield scall("android/media/PlayerBase", "deprecateStreamTypeForPlayback", "(ILjava/lang/String;Ljava/lang/String;)V", type, "Ringtone", "setStreamType()");
      const builder = yield newObj("android/media/AudioAttributes$Builder");
      yield vcall(builder, "setInternalLegacyStreamType", "(I)" + AAB, type);
      this.attributes = yield vcall(builder, "build", "()Landroid/media/AudioAttributes;");
    }),
    "getStreamType()I": driven(function* (this: JRingtone): Gen {
      return scall("android/media/AudioAttributes", "toLegacyStreamType", "(Landroid/media/AudioAttributes;)I", yield ringtoneAttributes(this));
    }),
    "setAudioAttributes(Landroid/media/AudioAttributes;)V": function (this: JRingtone, attributes: unknown) {
      if (!attributes) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid null AudioAttributes for Ringtone");
      this.attributes = attributes;
    },
    "getAudioAttributes()Landroid/media/AudioAttributes;": function (this: JRingtone) { return ringtoneAttributes(this); },
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
