import { JObj, rt, type NativeSpec } from "../jvm/runtime";
import { JLogSessionId } from "./media";

const root = "android/media/metrics/";

class JMetricEvent extends JObj { values = new Map<string, unknown>(); }
class JMetricBuilder extends JObj { values = new Map<string, unknown>(); }
class JMetricSession extends JObj {
  readonly id: JLogSessionId;
  readonly reports: [string, unknown][] = [];
  closed = false;
  constructor() {
    super();
    rt.link(root + "LogSessionId");
    this.id = new JLogSessionId(crypto.randomUUID());
  }
  report(kind: string, value: unknown) {
    if (value == null) return rt.npe();
    if (this.closed) return;
    if (this.reports.length === 32) this.reports.shift();
    this.reports.push([kind, value]);
  }
}

const sessions = new Map<string, JMetricSession>();
const sessionTypes: Record<string, string[]> = {
  PlaybackSession: ["NetworkEvent", "PlaybackErrorEvent", "PlaybackMetrics", "PlaybackStateEvent", "TrackChangeEvent"],
  BundleSession: [],
  EditingSession: ["EditingEndedEvent"],
  RecordingSession: [],
  TranscodingSession: [],
};
for (const [name, events] of Object.entries(sessionTypes)) {
  const methods: NonNullable<NativeSpec["methods"]> = {
    "getSessionId()Landroid/media/metrics/LogSessionId;": function (this: JMetricSession) { return this.id; },
    "close()V": function (this: JMetricSession) { this.closed = true; sessions.delete(this.id.id); },
  };
  if (name === "BundleSession") {
    methods["reportBundleMetrics(Landroid/os/PersistableBundle;)V"] = function (this: JMetricSession, value: unknown) { this.report("BundleMetrics", value); };
  }
  for (const event of events) {
    methods[`report${event}(L${root}${event};)V`] = function (this: JMetricSession, value: unknown) { this.report(event, value); };
  }
  rt.register({ name: root + name, ctor: class extends JMetricSession {}, ifaces: ["java/lang/AutoCloseable"], methods });
}

rt.register({ name: root + "MediaMetricsManager", ctor: class extends JObj {},
  statics: { INVALID_TIMESTAMP: -1n },
  methods: {
    ...Object.fromEntries(Object.keys(sessionTypes).map((name) => [
      `create${name}()L${root}${name};`,
      () => {
        const session: JMetricSession = rt.make(root + name);
        sessions.set(session.id.id, session);
        return session;
      },
    ])),
    "releaseSessionId(Ljava/lang/String;)V": (id: string) => {
      if (id == null) return rt.npe();
      const session = sessions.get(id);
      if (session) session.closed = true;
      sessions.delete(id);
    },
  },
});

const eventSetters: Record<string, string[]> = {
  NetworkEvent: ["NetworkType(I)", "TimeSinceCreatedMillis(J)"],
  PlaybackErrorEvent: ["Exception(Ljava/lang/Exception;)", "ErrorCode(I)", "SubErrorCode(I)", "TimeSinceCreatedMillis(J)"],
  PlaybackMetrics: ["AudioUnderrunCount(I)", "DrmType(I)", "MediaDurationMillis(J)", "PlaybackType(I)", "PlayerName(Ljava/lang/String;)", "PlayerVersion(Ljava/lang/String;)", "StreamType(I)", "StreamSource(I)", "VideoFramesDropped(I)", "VideoFramesPlayed(I)", "NetworkBytesRead(J)", "NetworkTransferDurationMillis(J)", "ExperimentId(J)"],
  PlaybackStateEvent: ["State(I)", "TimeSinceCreatedMillis(J)"],
  TrackChangeEvent: ["ChannelCount(I)", "Height(I)", "Width(I)", "AudioSampleRate(I)", "Bitrate(I)", "CodecName(Ljava/lang/String;)", "ContainerMimeType(Ljava/lang/String;)", "Language(Ljava/lang/String;)", "LanguageRegion(Ljava/lang/String;)", "SampleMimeType(Ljava/lang/String;)", "TimeSinceCreatedMillis(J)", "TrackChangeReason(I)", "TrackState(I)", "VideoFrameRate(F)"],
  EditingEndedEvent: ["InputMediaItemInfo(Landroid/media/metrics/MediaItemInfo;)", "OperationType(J)", "ErrorCode(I)", "ExporterName(Ljava/lang/String;)", "FinalProgressPercent(F)", "MuxerName(Ljava/lang/String;)", "OutputMediaItemInfo(Landroid/media/metrics/MediaItemInfo;)", "TimeSinceCreatedMillis(J)"],
  MediaItemInfo: ["CodecName(Ljava/lang/String;)", "DataType(J)", "SampleMimeType(Ljava/lang/String;)", "AudioChannelCount(I)", "AudioSampleRateHz(I)", "ClipDurationMillis(J)", "ContainerMimeType(Ljava/lang/String;)", "DurationMillis(J)", "VideoDataSpace(I)", "VideoFrameRate(F)", "VideoSampleCount(J)", "VideoSize(Landroid/util/Size;)"],
};
for (const [name, setters] of Object.entries(eventSetters)) {
  const eventName = root + name;
  rt.register({ name: eventName, ctor: class extends JMetricEvent {}, ifaces: ["android/os/Parcelable"] });
  // the builders of events that carry a required value take it as their constructor's argument
  const methods: NonNullable<NativeSpec["methods"]> = {
    ...name === "EditingEndedEvent" || name === "TrackChangeEvent"
      ? { "<init>(I)V": function (this: JMetricBuilder, initial: number) { this.values.set("initial", initial); } }
      : { "<init>()V": function () {} },
    [`build()L${eventName};`]: function (this: JMetricBuilder) {
      const event: JMetricEvent = rt.make(eventName);
      event.values = new Map(this.values);
      return event;
    },
  };
  for (const setter of setters) {
    const match = /^([^()]+)(\(.+\))$/.exec(setter)!;
    const field = match[1]!;
    const verb = field === "ExperimentId" || field === "InputMediaItemInfo" || field === "OperationType" ||
      name === "MediaItemInfo" && (field === "CodecName" || field === "DataType" || field === "SampleMimeType") ? "add" : "set";
    methods[`${verb}${field}${match[2]}L${eventName}$Builder;`] = function (this: JMetricBuilder, value: unknown) {
      if (verb === "add") {
        const list = this.values.get(field) as unknown[] | undefined;
        if (list) list.push(value);
        else this.values.set(field, [value]);
      } else this.values.set(field, value);
      return this;
    };
  }
  rt.register({ name: eventName + "$Builder", ctor: class extends JMetricBuilder {}, methods });
}
