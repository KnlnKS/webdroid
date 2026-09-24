import { rt, JObj, type NativeSpec } from "../jvm/runtime";
import { stringHash } from "../jvm/natives/jlang";

class JLogSessionId extends JObj { id = ""; }
rt.register({ name: "android/media/metrics/LogSessionId", ctor: JLogSessionId,
  statics: { LOG_SESSION_ID_NONE: new JLogSessionId() }, methods: {
    "<init>(Ljava/lang/String;)V": function (this: JLogSessionId, id: string) {
      if (id == null) rt.npe();
      this.id = id;
    },
    "getStringId()Ljava/lang/String;": function (this: JLogSessionId) { return this.id; },
    "equals(Ljava/lang/Object;)Z": function (this: JLogSessionId, other: unknown) {
      return +(other instanceof JLogSessionId && other.id === this.id);
    },
    "hashCode()I": function (this: JLogSessionId) { return stringHash(this.id); },
  } });

class JPlaybackSession extends JObj {
  id = new JLogSessionId();
  closed = false;
  events: { kind: string; value: unknown }[] = [];
}
const reportMethods: NativeSpec["methods"] = {};
for (const kind of ["PlaybackMetrics", "PlaybackStateEvent", "PlaybackErrorEvent", "TrackChangeEvent", "NetworkEvent"]) {
  reportMethods[`report${kind}(Landroid/media/metrics/${kind};)V`] = function (this: JPlaybackSession, value: unknown) {
    if (this.closed) throw rt.mkThrowable("java/lang/IllegalStateException", "PlaybackSession is closed");
    if (this.events.length === 256) this.events.shift();
    this.events.push({ kind, value });
  };
}
rt.register({ name: "android/media/metrics/PlaybackSession", ctor: JPlaybackSession,
  ifaces: ["java/lang/AutoCloseable"], methods: {
    "getSessionId()Landroid/media/metrics/LogSessionId;": function (this: JPlaybackSession) { return this.id; },
    "close()V": function (this: JPlaybackSession) { this.closed = true; },
    ...reportMethods,
  } });
rt.register({ name: "android/media/metrics/MediaMetricsManager", ctor: class extends JObj {},
  statics: { INVALID_TIMESTAMP: -1n }, methods: {
    "createPlaybackSession()Landroid/media/metrics/PlaybackSession;": () => {
      const session = new JPlaybackSession();
      session.id.id = crypto.randomUUID();
      return session;
    },
  } });

class JMetricEvent extends JObj { values = new Map<string, unknown>(); }
class JMetricBuilder extends JObj { values = new Map<string, unknown>(); }
const builders: Record<string, Record<string, string>> = {
  NetworkEvent: { NetworkType: "I", TimeSinceCreatedMillis: "J" },
  PlaybackErrorEvent: { ErrorCode: "I", Exception: "Ljava/lang/Exception;", SubErrorCode: "I", TimeSinceCreatedMillis: "J" },
  PlaybackStateEvent: { State: "I", TimeSinceCreatedMillis: "J" },
  PlaybackMetrics: {
    AudioUnderrunCount: "I", DrmType: "I", MediaDurationMillis: "J", NetworkBytesRead: "J",
    NetworkTransferDurationMillis: "J", PlaybackType: "I", PlayerName: "Ljava/lang/String;",
    PlayerVersion: "Ljava/lang/String;", StreamSource: "I", StreamType: "I",
    VideoFramesDropped: "I", VideoFramesPlayed: "I",
  },
  TrackChangeEvent: {
    AudioSampleRate: "I", Bitrate: "I", ChannelCount: "I", CodecName: "Ljava/lang/String;",
    ContainerMimeType: "Ljava/lang/String;", Height: "I", Language: "Ljava/lang/String;",
    LanguageRegion: "Ljava/lang/String;", SampleMimeType: "Ljava/lang/String;",
    TimeSinceCreatedMillis: "J", TrackChangeReason: "I", TrackState: "I", VideoFrameRate: "F", Width: "I",
  },
};
for (const [kind, setters] of Object.entries(builders)) {
  const name = `android/media/metrics/${kind}`;
  class Event extends JMetricEvent {}
  class Builder extends JMetricBuilder {}
  rt.register({ name, ctor: Event });
  const methods: NativeSpec["methods"] = {
    "<init>()V": function () {},
    [`build()L${name};`]: function (this: JMetricBuilder) {
      const event = new Event();
      event.values = new Map(this.values);
      return event;
    },
  };
  if (kind === "TrackChangeEvent") methods["<init>(I)V"] = function (this: JMetricBuilder, type: number) { this.values.set("trackType", type); };
  for (const [field, desc] of Object.entries(setters)) {
    methods[`set${field}(${desc})L${name}$Builder;`] = function (this: JMetricBuilder, value: unknown) {
      this.values.set(field, value);
      return this;
    };
  }
  rt.register({ name: `${name}$Builder`, ctor: Builder, methods });
}
