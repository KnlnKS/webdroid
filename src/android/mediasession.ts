import { JObj, rt, noops } from "../jvm/runtime";
import { mangleMethod, jmethod } from "../jvm/abi";
import { curThread, idHash, stringHash, vcall } from "../jvm/natives/jlang";
import { JHandler, JFnRunnable, JLooper, type JBundle } from "./os";
import { type JContext } from "./context";
import { JService } from "./runningservices";

class JMediaSession extends JObj {
  token = new JSessionToken(this);
  controller = new JMediaController();
  callback: unknown = null;
  handler = new JHandler();
  active = 0;
  released = false;
  flags = 0;
  pkg = "";
  tag = "";
  receiver: unknown = null;
  activity: unknown = null;
  playback: unknown = null;
  metadata: unknown = null;
  queue: unknown = null;
  extras: JBundle | null = null;
  ratingType = 0;
}
class JSessionToken extends JObj { constructor(readonly session: JMediaSession) { super(); } }
class JMediaController extends JObj { session!: JMediaSession; }
class JQueueItem extends JObj {
  description: unknown = null;
  id = -1n;
}
class JRemoteUserInfo extends JObj { packageName = ""; pid = -1; uid = -1; }
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
class JMediaBrowserService extends JService { token: JSessionToken | null = null; }
class JBrowserRoot extends JObj { rootId = ""; extras: JBundle | null = null; }
rt.register({ name: "android/service/media/MediaBrowserService", ctor: JMediaBrowserService, sup: "android/app/Service", methods: {
  "<init>()V": function () {},
  "setSessionToken(Landroid/media/session/MediaSession$Token;)V": function (this: JMediaBrowserService, token: JSessionToken | null) {
    if (!token) throw rt.mkThrowable("java/lang/IllegalArgumentException", "session token cannot be null");
    if (this.token) throw rt.mkThrowable("java/lang/IllegalStateException", "session token already set");
    this.token = token;
  },
  "getSessionToken()Landroid/media/session/MediaSession$Token;": function (this: JMediaBrowserService) { return this.token; },
  "notifyChildrenChanged(Ljava/lang/String;)V": (parent: string | null) => {
    if (!parent) throw rt.mkThrowable("java/lang/IllegalArgumentException", "parentId cannot be null");
  },
  "notifyChildrenChanged(Ljava/lang/String;Landroid/os/Bundle;)V": (parent: string | null, options: JBundle | null) => {
    if (!parent || !options) throw rt.mkThrowable("java/lang/IllegalArgumentException", "parentId and options cannot be null");
  },
  "getBrowserRootHints()Landroid/os/Bundle;": () => { throw rt.mkThrowable("java/lang/IllegalStateException", "Outside onGetRoot or onLoadChildren"); },
  "getCurrentBrowserInfo()Landroid/media/session/MediaSessionManager$RemoteUserInfo;": () => { throw rt.mkThrowable("java/lang/IllegalStateException", "Outside onGetRoot or onLoadChildren"); },
} });
rt.register({ name: "android/service/media/MediaBrowserService$BrowserRoot", ctor: JBrowserRoot, methods: {
  "<init>(Ljava/lang/String;Landroid/os/Bundle;)V": function (this: JBrowserRoot, id: string | null, extras: JBundle | null) {
    if (!id) throw rt.mkThrowable("java/lang/IllegalArgumentException", "rootId cannot be null or empty");
    this.rootId = id; this.extras = extras;
  },
  "getRootId()Ljava/lang/String;": function (this: JBrowserRoot) { return this.rootId; },
  "getExtras()Landroid/os/Bundle;": function (this: JBrowserRoot) { return this.extras; },
} });

async function initialize(session: JMediaSession, context: JContext | null, tag: string) {
  if (!context) throw rt.mkThrowable("java/lang/IllegalArgumentException", "context cannot be null");
  if (!tag) throw rt.mkThrowable("java/lang/IllegalArgumentException", "tag cannot be null or empty");
  rt.link("android/media/session/MediaSession$Token"); rt.link("android/media/session/MediaController");
  const getPackageName = jmethod(context, mangleMethod("getPackageName", "()Ljava/lang/String;"));
  session.pkg = getPackageName ? await getPackageName.call(context) as string : "";
  session.tag = tag;
  session.controller.session = session;
}
function dispatch(session: JMediaSession, method: string, desc: string, ...args: unknown[]) {
  if (session.released || !session.callback) return;
  const callback = session.callback, job = new JFnRunnable();
  job.fn = () => session.released || session.callback !== callback ? undefined : vcall(callback, method, desc, ...args);
  session.handler.post(job, 0);
}
rt.register({ name: "android/media/session/MediaSession", ctor: JMediaSession, methods: {
  "<init>(Landroid/content/Context;Ljava/lang/String;)V": function (this: JMediaSession, context: JContext | null, tag: string) { return initialize(this, context, tag); },
  "<init>(Landroid/content/Context;Ljava/lang/String;Landroid/os/Bundle;)V": function (this: JMediaSession, context: JContext | null, tag: string) { return initialize(this, context, tag); },
  "setCallback(Landroid/media/session/MediaSession$Callback;)V": function (this: JMediaSession, callback: unknown) { return vcall(this, "setCallback", "(Landroid/media/session/MediaSession$Callback;Landroid/os/Handler;)V", callback, null); },
  "setCallback(Landroid/media/session/MediaSession$Callback;Landroid/os/Handler;)V": function (this: JMediaSession, callback: unknown, handler: JHandler | null) {
    for (const key of this.handler.pending.keys()) this.handler.cancel(key);
    this.callback = callback; this.handler = new JHandler();
    if (handler) this.handler.looper = handler.looper;
    else if (curThread.looper instanceof JLooper) this.handler.looper = curThread.looper;
    else if (callback) throw rt.mkThrowable("java/lang/RuntimeException", "Cannot create a media callback handler without a Looper");
  },
  "getSessionToken()Landroid/media/session/MediaSession$Token;": function (this: JMediaSession) { return this.token; },
  "getController()Landroid/media/session/MediaController;": function (this: JMediaSession) { return this.controller; },
  "setActive(Z)V": function (this: JMediaSession, active: number) { this.active = active; },
  "isActive()Z": function (this: JMediaSession) { return this.active; },
  "setFlags(I)V": function (this: JMediaSession, flags: number) { this.flags = flags; },
  "setMediaButtonReceiver(Landroid/app/PendingIntent;)V": function (this: JMediaSession, receiver: unknown) { this.receiver = receiver; },
  "setSessionActivity(Landroid/app/PendingIntent;)V": function (this: JMediaSession, activity: unknown) { this.activity = activity; },
  "setPlaybackState(Landroid/media/session/PlaybackState;)V": function (this: JMediaSession, playback: unknown) { this.playback = playback; },
  "setMetadata(Landroid/media/MediaMetadata;)V": function (this: JMediaSession, metadata: unknown) { this.metadata = metadata; },
  "setQueue(Ljava/util/List;)V": function (this: JMediaSession, queue: unknown) { this.queue = queue; },
  "setExtras(Landroid/os/Bundle;)V": function (this: JMediaSession, extras: JBundle | null) { this.extras = extras; },
  "setRatingType(I)V": function (this: JMediaSession, type: number) { this.ratingType = type; },
  "release()V": function (this: JMediaSession) { this.released = true; this.active = 0; this.callback = null; },
} });
rt.register({ name: "android/media/session/MediaSession$QueueItem", ctor: JQueueItem, ifaces: ["android/os/Parcelable"], statics: { UNKNOWN_ID: -1 }, methods: {
  "<init>(Landroid/media/MediaDescription;J)V": function (this: JQueueItem, description: unknown, id: bigint) {
    if (!description || id === -1n) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid queue item");
    this.description = description; this.id = id;
  },
  "getDescription()Landroid/media/MediaDescription;": function (this: JQueueItem) { return this.description; },
  "getQueueId()J": function (this: JQueueItem) { return this.id; },
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": async function (this: JQueueItem, parcel: unknown, flags: number) {
    await vcall(this.description, "writeToParcel", "(Landroid/os/Parcel;I)V", parcel, flags);
    await vcall(parcel, "writeLong", "(J)V", this.id);
  },
} });
rt.register({ name: "android/media/session/MediaSession$Token", ctor: JSessionToken, ifaces: ["android/os/Parcelable"], methods: {
  "equals(Ljava/lang/Object;)Z": function (this: JSessionToken, other: unknown) { return other instanceof JSessionToken && other.session === this.session ? 1 : 0; },
  "hashCode()I": function (this: JSessionToken) { return idHash(this.session); },
  "describeContents()I": () => 0,
  "writeToParcel(Landroid/os/Parcel;I)V": () => {},
} });
rt.register({ name: "android/media/session/MediaSession$Callback", ctor: class extends JObj {}, methods: {
  ...noops("<init>()V", "onCommand(Ljava/lang/String;Landroid/os/Bundle;Landroid/os/ResultReceiver;)V", "onPlay()V", "onPause()V", "onStop()V",
    "onSkipToNext()V", "onSkipToPrevious()V", "onFastForward()V", "onRewind()V", "onSeekTo(J)V", "onCustomAction(Ljava/lang/String;Landroid/os/Bundle;)V"),
} });
rt.register({ name: "android/media/session/MediaController", ctor: JMediaController, methods: {
  "<init>(Landroid/content/Context;Landroid/media/session/MediaSession$Token;)V": function (this: JMediaController, context: JContext | null, token: JSessionToken | null) {
    if (!context || !token) throw rt.mkThrowable("java/lang/IllegalArgumentException", "context and token must not be null");
    this.session = token.session;
  },
  "getSessionToken()Landroid/media/session/MediaSession$Token;": function (this: JMediaController) { return this.session.token; },
  "getPackageName()Ljava/lang/String;": function (this: JMediaController) { return this.session.pkg; },
  "getTag()Ljava/lang/String;": function (this: JMediaController) { return this.session.tag; },
  "getFlags()J": function (this: JMediaController) { return BigInt(this.session.flags | 3); },
  "getPlaybackState()Landroid/media/session/PlaybackState;": function (this: JMediaController) { return this.session.playback; },
  "getMetadata()Landroid/media/MediaMetadata;": function (this: JMediaController) { return this.session.metadata; },
  "getQueue()Ljava/util/List;": function (this: JMediaController) { return this.session.queue; },
  "getExtras()Landroid/os/Bundle;": function (this: JMediaController) { return this.session.extras; },
  "getSessionActivity()Landroid/app/PendingIntent;": function (this: JMediaController) { return this.session.activity; },
  "sendCommand(Ljava/lang/String;Landroid/os/Bundle;Landroid/os/ResultReceiver;)V": function (this: JMediaController, command: string, args: unknown, receiver: unknown) {
    if (!command) throw rt.mkThrowable("java/lang/IllegalArgumentException", "command cannot be null or empty");
    dispatch(this.session, "onCommand", "(Ljava/lang/String;Landroid/os/Bundle;Landroid/os/ResultReceiver;)V", command, args, receiver);
  },
} });
