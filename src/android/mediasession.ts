import { JObj, rt, noops } from "../jvm/runtime";
import { mangleMethod, jmethod } from "../jvm/abi";
import { idHash, newObj, stringHash, vcall } from "../jvm/natives/jlang";
import type { JBundle } from "./os";
import { myLooper, postTo } from "./mainloop";

class JMediaSession extends JObj {
  token = new JSessionToken(this);
  controller = new JMediaController();
  callback: unknown = null;
  handler: JObj | null = null;
  epoch = 0;
  active = 0;
  released = false;
  flags = 0;
  pkg = "";
  tag = "";
  receiver: unknown = null;
  activity: unknown = null;
  playback: unknown = null;
  audioAttributes: unknown = null;
  metadata: unknown = null;
  queue: unknown = null;
  queueTitle: unknown = null;
  extras: JBundle | null = null;
  ratingType = 0;
}
class JSessionToken extends JObj { constructor(readonly session: JMediaSession) { super(); } }
class JMediaController extends JObj { session!: JMediaSession; controls = new JTransportControls(); }
class JTransportControls extends JObj { session!: JMediaSession; }
class JRemoteUserInfo extends JObj { packageName = ""; pid = -1; uid = -1; }
class JQueueItem extends JObj { description: unknown = null; id = -1n; }
rt.register({ name: "android/media/session/MediaSession$QueueItem", ctor: JQueueItem, ifaces: ["android/os/Parcelable"], methods: {
  "<init>(Landroid/media/MediaDescription;J)V": function (this: JQueueItem, description: unknown, id: bigint) {
    if (description == null || id === -1n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid queue item");
    this.description = description; this.id = id;
  },
  "getDescription()Landroid/media/MediaDescription;": function (this: JQueueItem) { return this.description; },
  "getQueueId()J": function (this: JQueueItem) { return this.id; },
  "describeContents()I": () => 0,
} });
rt.register({ name: "android/media/session/MediaSessionManager$RemoteUserInfo", ctor: JRemoteUserInfo,
  fields: { mPackageName: "packageName", mPid: "pid", mUid: "uid" }, methods: {
    "<init>(Ljava/lang/String;II)V": function (this: JRemoteUserInfo, packageName: string | null, pid: number, uid: number) {
      if (packageName === null) rt.npe();
      this.packageName = packageName!; this.pid = pid; this.uid = uid;
    },
    "getPackageName()Ljava/lang/String;": function (this: JRemoteUserInfo) { return this.packageName; },
    "getPid()I": function (this: JRemoteUserInfo) { return this.pid; },
    "getUid()I": function (this: JRemoteUserInfo) { return this.uid; },
    "equals(Ljava/lang/Object;)Z": function (this: JRemoteUserInfo, other: unknown) {
      return other instanceof JRemoteUserInfo && this.packageName === other.packageName && this.pid === other.pid && this.uid === other.uid ? 1 : 0;
    },
    "hashCode()I": function (this: JRemoteUserInfo) {
      return Math.imul(31, Math.imul(31, Math.imul(31, 1) + stringHash(this.packageName)) + this.pid) + this.uid | 0;
    },
  } });
async function initialize(session: JMediaSession, context: JObj | null, tag: string) {
  if (!context) throw rt.mkThrowable("java/lang/IllegalArgumentException", "context cannot be null");
  if (!tag) throw rt.mkThrowable("java/lang/IllegalArgumentException", "tag cannot be null or empty");
  rt.link("android/media/session/MediaSession$Token"); rt.link("android/media/session/MediaController");
  const getPackageName = jmethod(context, mangleMethod("getPackageName", "()Ljava/lang/String;"));
  session.pkg = getPackageName ? await getPackageName.call(context) as string : "";
  session.tag = tag;
  session.controller.session = session;
  session.controller.controls.session = session;
}
function dispatch(session: JMediaSession, method: string, desc: string, ...args: unknown[]) {
  if (session.released || !session.callback) return;
  const { callback, epoch } = session;
  postTo(session.handler!, () => session.released || session.epoch !== epoch ? undefined : vcall(callback, method, desc, ...args));
}
const initSession = function (this: JMediaSession, context: JObj | null, tag: string) { return initialize(this, context, tag); };
rt.register({ name: "android/media/session/MediaSession", ctor: JMediaSession, methods: {
  "<init>(Landroid/content/Context;Ljava/lang/String;)V": initSession,
  "<init>(Landroid/content/Context;Ljava/lang/String;Landroid/os/Bundle;)V": initSession,
  "setCallback(Landroid/media/session/MediaSession$Callback;)V": function (this: JMediaSession, callback: unknown) { return vcall(this, "setCallback", "(Landroid/media/session/MediaSession$Callback;Landroid/os/Handler;)V", callback, null); },
  // a replaced callback's pending calls lapse, as AOSP drops its old handler's messages
  "setCallback(Landroid/media/session/MediaSession$Callback;Landroid/os/Handler;)V": async function (this: JMediaSession, callback: unknown, handler: JObj | null) {
    if (!handler && callback && !myLooper()) throw rt.mkThrowable("java/lang/RuntimeException", "Cannot create a media callback handler without a Looper");
    this.callback = callback; this.epoch++;
    this.handler = handler ?? (callback ? await newObj("android/os/Handler", "()V") : null);
  },
  "getSessionToken()Landroid/media/session/MediaSession$Token;": function (this: JMediaSession) { return this.token; },
  "getController()Landroid/media/session/MediaController;": function (this: JMediaSession) { return this.controller; },
  "setActive(Z)V": function (this: JMediaSession, active: number) { this.active = active; },
  "isActive()Z": function (this: JMediaSession) { return this.active; },
  "setFlags(I)V": function (this: JMediaSession, flags: number) { this.flags = flags; },
  "setMediaButtonReceiver(Landroid/app/PendingIntent;)V": function (this: JMediaSession, receiver: unknown) { this.receiver = receiver; },
  "setMediaButtonBroadcastReceiver(Landroid/content/ComponentName;)V": function (this: JMediaSession, receiver: unknown) { this.receiver = receiver; },
  "setSessionActivity(Landroid/app/PendingIntent;)V": function (this: JMediaSession, activity: unknown) { this.activity = activity; },
  "setPlaybackState(Landroid/media/session/PlaybackState;)V": function (this: JMediaSession, playback: unknown) { this.playback = playback; },
  "setPlaybackToLocal(Landroid/media/AudioAttributes;)V": function (this: JMediaSession, attributes: unknown) { this.audioAttributes = attributes; },
  "setMetadata(Landroid/media/MediaMetadata;)V": function (this: JMediaSession, metadata: unknown) { this.metadata = metadata; },
  "setQueue(Ljava/util/List;)V": function (this: JMediaSession, queue: unknown) { this.queue = queue; },
  "setQueueTitle(Ljava/lang/CharSequence;)V": function (this: JMediaSession, title: unknown) { this.queueTitle = title; },
  "setExtras(Landroid/os/Bundle;)V": function (this: JMediaSession, extras: JBundle | null) { this.extras = extras; },
  "setRatingType(I)V": function (this: JMediaSession, type: number) { this.ratingType = type; },
  "release()V": function (this: JMediaSession) { this.released = true; this.active = 0; this.callback = null; },
} });
rt.register({ name: "android/media/session/MediaSession$Token", ctor: JSessionToken, ifaces: ["android/os/Parcelable"], methods: {
  "equals(Ljava/lang/Object;)Z": function (this: JSessionToken, other: unknown) { return other instanceof JSessionToken && other.session === this.session ? 1 : 0; },
  "hashCode()I": function (this: JSessionToken) { return idHash(this.session); },
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": () => {},
} });
rt.register({ name: "android/media/session/MediaSession$Callback", ctor: class extends JObj {}, methods: {
  ...noops("<init>()V"),
} });
rt.register({ name: "android/media/session/MediaController", ctor: JMediaController, methods: {
  "<init>(Landroid/content/Context;Landroid/media/session/MediaSession$Token;)V": function (this: JMediaController, context: JObj | null, token: JSessionToken | null) {
    if (!context || !token) throw rt.mkThrowable("java/lang/IllegalArgumentException", "context and token must not be null");
    this.session = token.session; this.controls.session = token.session;
  },
  "getTransportControls()Landroid/media/session/MediaController$TransportControls;": function (this: JMediaController) { return this.controls; },
  "getSessionToken()Landroid/media/session/MediaSession$Token;": function (this: JMediaController) { return this.session.token; },
  "getPackageName()Ljava/lang/String;": function (this: JMediaController) { return this.session.pkg; },
  "getTag()Ljava/lang/String;": function (this: JMediaController) { return this.session.tag; },
  "getFlags()J": function (this: JMediaController) { return BigInt(this.session.flags | 3); },
  "getPlaybackState()Landroid/media/session/PlaybackState;": function (this: JMediaController) { return this.session.playback; },
  "getMetadata()Landroid/media/MediaMetadata;": function (this: JMediaController) { return this.session.metadata; },
  "getQueue()Ljava/util/List;": function (this: JMediaController) { return this.session.queue; },
  "getQueueTitle()Ljava/lang/CharSequence;": function (this: JMediaController) { return this.session.queueTitle; },
  "getExtras()Landroid/os/Bundle;": function (this: JMediaController) { return this.session.extras; },
  "getSessionActivity()Landroid/app/PendingIntent;": function (this: JMediaController) { return this.session.activity; },
  "sendCommand(Ljava/lang/String;Landroid/os/Bundle;Landroid/os/ResultReceiver;)V": function (this: JMediaController, command: string, args: unknown, receiver: unknown) {
    if (!command) throw rt.mkThrowable("java/lang/IllegalArgumentException", "command cannot be null or empty");
    dispatch(this.session, "onCommand", "(Ljava/lang/String;Landroid/os/Bundle;Landroid/os/ResultReceiver;)V", command, args, receiver);
  },
} });
rt.register({ name: "android/media/session/MediaController$TransportControls", ctor: JTransportControls, methods: {
  "sendCustomAction(Ljava/lang/String;Landroid/os/Bundle;)V": function (this: JTransportControls, action: string, args: JBundle | null) {
    if (!action) throw rt.mkThrowable("java/lang/IllegalArgumentException", "action cannot be null or empty");
    dispatch(this.session, "onCustomAction", "(Ljava/lang/String;Landroid/os/Bundle;)V", action, args);
  },
  "play()V": function (this: JTransportControls) { dispatch(this.session, "onPlay", "()V"); },
  "pause()V": function (this: JTransportControls) { dispatch(this.session, "onPause", "()V"); },
  "stop()V": function (this: JTransportControls) { dispatch(this.session, "onStop", "()V"); },
  "seekTo(J)V": function (this: JTransportControls, position: bigint) { dispatch(this.session, "onSeekTo", "(J)V", position); },
} });
