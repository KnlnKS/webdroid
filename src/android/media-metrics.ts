// IMediaMetricsManager, under AOSP's MediaMetricsManager, its sessions, events and LogSessionId:
// MediaMetricsManagerService hands out 12 random bytes as an unpadded URL-safe base64 session id
// and turns reports into statsd atoms, which nothing on this device reads.
import { JObj, rt, noops } from "../jvm/runtime.ts";
import { hostStub } from "./binder.ts";

const sessionId = () => crypto.getRandomValues(new Uint8Array(12)).toBase64({ alphabet: "base64url", omitPadding: true });
const M = "android/media/metrics/", S = "Ljava/lang/String;";
rt.register({ name: "webdroid/MediaMetricsManagerService", ctor: class extends JObj {}, sup: M + "IMediaMetricsManager$Stub", methods: {
  ...Object.fromEntries(["Playback", "Recording", "Transcoding", "Editing", "Bundle"].map((kind) => [`get${kind}SessionId(I)${S}`, sessionId])),
  ...noops(`releaseSessionId(${S}I)V`, `reportBundleMetrics(${S}Landroid/os/PersistableBundle;I)V`,
    ...["EditingEndedEvent", "NetworkEvent", "PlaybackErrorEvent", "PlaybackMetrics", "PlaybackStateEvent", "TrackChangeEvent"]
      .map((event) => `report${event}(${S}L${M}${event};I)V`)),
} });
hostStub("media_metrics", "webdroid/MediaMetricsManagerService");
