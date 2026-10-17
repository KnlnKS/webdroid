// ISessionManager, ISession and ISessionController, as MediaSessionService and MediaSessionRecord
// keep sessions: a record holds what its session last set, relays a controller's transport calls
// to the session's ISessionCallback, and tells registered ISessionControllerCallbacks of changes.
import { awaited, JObj, rt, driven, noops, type Gen } from "../jvm/runtime.ts";
import { after, newObj, scall, vcall } from "../jvm/natives/jentry.ts";
import { lambda } from "../jvm/natives/jlambda.ts";
import { hostStub, newStub, oneway } from "./binder.ts";
import { setStreamVolume, streamMaxVolume, streamVolume } from "./audio.ts";

const MS = "android/media/session/", S = "Ljava/lang/String;", B = "Landroid/os/Bundle;";
const PS = MS + "PlaybackState", PI = MS + "MediaController$PlaybackInfo", AA = "Landroid/media/AudioAttributes;";
const PLAYBACK_TYPE_LOCAL = 1, PLAYBACK_TYPE_REMOTE = 2, VOLUME_CONTROL_ABSOLUTE = 2;
type Record = {
  pkg: string; tag: string; info: JObj | null; cb: JObj; pid: number; uid: number;
  controller: JObj; callbacks: Set<JObj>; destroyed: boolean;
  flags: bigint; launch: JObj | null; metadata: JObj | null; duration: bigint; playback: JObj | null;
  queue: JObj | null; queueTitle: unknown; extras: JObj | null; ratingType: number;
  attributes: JObj | null; remote: { control: number; max: number; current: number; id: string | null } | null;
};
/** a session's ISession or ISessionController over its Record; each class has its own ctor, which takes on its Stub as supertype */
const recordBinder = () => class extends JObj { r!: Record; };
type JRecordBinder = InstanceType<ReturnType<typeof recordBinder>>;

const push = (r: Record, name: string, desc: string, ...args: unknown[]) => {
  for (const cb of r.callbacks) oneway(cb, name, desc, ...args);
};
const queueSlice = (queue: JObj | null) => queue && newObj("android/content/pm/ParceledListSlice", "(Ljava/util/List;)V", queue);

const playbackInfo = driven(function* playbackInfo$(r: Record): Gen {
  const attributes = r.attributes ?? (yield vcall(yield vcall(yield newObj("android/media/AudioAttributes$Builder"),
    "setUsage", "(I)Landroid/media/AudioAttributes$Builder;", 1), "build", `()${AA}`));
  if (r.remote) return newObj(PI, `(IIII${AA}${S})V`, PLAYBACK_TYPE_REMOTE, r.remote.control, r.remote.max, r.remote.current, attributes, r.remote.id);
  const stream: number = yield scall("android/media/AudioAttributes", "toLegacyStreamType", `(${AA})I`, attributes);
  return newObj(PI, `(IIII${AA}${S})V`, PLAYBACK_TYPE_LOCAL, VOLUME_CONTROL_ABSOLUTE, streamMaxVolume(stream), streamVolume(stream), attributes, null);
});
const volumeChanged = driven(function* volumeChanged$(r: Record): Gen {
  push(r, "onVolumeInfoChanged", `(L${PI};)V`, yield playbackInfo(r));
});
/** the stream a locally played session's volume adjusts */
const localStream = driven(function* localStream$(r: Record): Gen<number> {
  return scall("android/media/AudioAttributes", "toLegacyStreamType", `(${AA})I`, yield vcall(yield playbackInfo(r), "getAudioAttributes", `()${AA}`));
});
/** MediaSessionRecord.getStateWithUpdatedPosition: a playing state's position advanced to now */
const currentState = driven(function* currentState$(r: Record): Gen {
  const state = r.playback;
  if (r.destroyed || !state) return null;
  const code: number = yield vcall(state, "getState", "()I");
  const updated: bigint = yield vcall(state, "getLastPositionUpdateTime", "()J");
  if ((code !== 3 && code !== 4 && code !== 5) || updated <= 0n) return state;
  const now: bigint = yield scall("android/os/SystemClock", "elapsedRealtime", "()J");
  const speed: number = yield vcall(state, "getPlaybackSpeed", "()F");
  let position = BigInt(Math.trunc(speed * Number(now - updated))) + (yield vcall(state, "getPosition", "()J"));
  if (r.duration >= 0n && position > r.duration) position = r.duration; else if (position < 0n) position = 0n;
  const builder = yield newObj(PS + "$Builder", `(L${PS};)V`, state);
  yield vcall(builder, "setState", `(IJFJ)L${PS}$Builder;`, code, position, speed, now);
  return vcall(builder, "build", `()L${PS};`);
});

const R = <A extends unknown[], T>(f: (r: Record, ...a: A) => T) => function (this: JRecordBinder, ...a: A): T { return f(this.r, ...a); };
rt.register({ name: "webdroid/MediaSessionRecord", ctor: recordBinder(), sup: MS + "ISession$Stub", methods: {
  [`getController()L${MS}ISessionController;`]: R((r) => r.controller),
  "setFlags(I)V": R((r, flags: number) => { r.flags = BigInt(flags); }),
  "setLaunchPendingIntent(Landroid/app/PendingIntent;)V": R((r, intent: JObj | null) => { r.launch = intent; }),
  ...noops("setActive(Z)V", "setMediaButtonReceiver(Landroid/app/PendingIntent;)V", "setMediaButtonBroadcastReceiver(Landroid/content/ComponentName;)V"),
  "destroySession()V": R((r) => {
    if (r.destroyed) return;
    r.destroyed = true;
    push(r, "onSessionDestroyed", "()V");
    r.callbacks.clear();
  }),
  [`sendEvent(${S}${B})V`]: R((r, event: string, extras: JObj | null) => push(r, "onEvent", `(${S}${B})V`, event, extras)),
  [`setMetadata(Landroid/media/MediaMetadata;J${S})V`]: R((r, metadata: JObj | null, duration: bigint) => {
    r.metadata = metadata; r.duration = duration;
    push(r, "onMetadataChanged", "(Landroid/media/MediaMetadata;)V", metadata);
  }),
  [`setPlaybackState(L${PS};)V`]: R((r, state: JObj | null) => { r.playback = state; push(r, "onPlaybackStateChanged", `(L${PS};)V`, state); }),
  "resetQueue()V": R((r) => { r.queue = null; push(r, "onQueueChanged", "(Landroid/content/pm/ParceledListSlice;)V", null); }),
  "getBinderForSetQueue()Landroid/os/IBinder;": R((r) => newObj(MS + "ParcelableListBinder", "(Ljava/lang/Class;Ljava/util/function/Consumer;)V",
    rt.classFor(MS + "MediaSession$QueueItem"), lambda("java/util/function/Consumer", "accept(Ljava/lang/Object;)V", driven(function* (list: JObj): Gen {
      r.queue = list;
      push(r, "onQueueChanged", "(Landroid/content/pm/ParceledListSlice;)V", yield queueSlice(list));
    })))),
  "setQueueTitle(Ljava/lang/CharSequence;)V": R((r, title: unknown) => { r.queueTitle = title; push(r, "onQueueTitleChanged", "(Ljava/lang/CharSequence;)V", title); }),
  [`setExtras(${B})V`]: R((r, extras: JObj | null) => { r.extras = extras; push(r, "onExtrasChanged", `(${B})V`, extras); }),
  "setRatingType(I)V": R((r, type: number) => { r.ratingType = type; }),
  [`setPlaybackToLocal(${AA})V`]: R((r, attributes: JObj | null) => { r.attributes = attributes; r.remote = null; return volumeChanged(r); }),
  [`setPlaybackToRemote(II${S})V`]: R((r, control: number, max: number, id: string | null) => {
    r.remote = { control, max, current: r.remote?.current ?? 0, id };
    return volumeChanged(r);
  }),
  "setCurrentVolume(I)V": R((r, volume: number) => { if (r.remote) { r.remote.current = volume; return volumeChanged(r); } }),
} });

/** a controller call relayed to the session's callback, the caller's identity before its arguments */
const relay = (r: Record, callback: string, rest: string, pkg: string, ...a: unknown[]) => {
  if (!r.destroyed) oneway(r.cb, callback, `(${S}II${rest})V`, pkg, r.pid, r.uid, ...a);
};
const TRANSPORT: [string, string, string][] = [
  ["play", "onPlay", ""], ["pause", "onPause", ""], ["stop", "onStop", ""], ["next", "onNext", ""], ["previous", "onPrevious", ""],
  ["fastForward", "onFastForward", ""], ["rewind", "onRewind", ""], ["prepare", "onPrepare", ""], ["seekTo", "onSeekTo", "J"],
  ["skipToQueueItem", "onSkipToTrack", "J"], ["setPlaybackSpeed", "onSetPlaybackSpeed", "F"], ["rate", "onRate", "Landroid/media/Rating;"],
  ["sendCommand", "onCommand", `${S}${B}Landroid/os/ResultReceiver;`], ["sendCustomAction", "onCustomAction", `${S}${B}`],
  ["playFromMediaId", "onPlayFromMediaId", `${S}${B}`], ["playFromSearch", "onPlayFromSearch", `${S}${B}`],
  ["playFromUri", "onPlayFromUri", `Landroid/net/Uri;${B}`], ["prepareFromMediaId", "onPrepareFromMediaId", `${S}${B}`],
  ["prepareFromSearch", "onPrepareFromSearch", `${S}${B}`], ["prepareFromUri", "onPrepareFromUri", `Landroid/net/Uri;${B}`],
];
rt.register({ name: "webdroid/MediaSessionController", ctor: recordBinder(), sup: MS + "ISessionController$Stub", methods: {
  ...Object.fromEntries(TRANSPORT.map(([name, callback, rest]) => [`${name}(${S}${rest})V`, R((r, ...a: [string]) => relay(r, callback, rest, ...a))])),
  [`sendMediaButton(${S}Landroid/view/KeyEvent;)Z`]: driven(function* sendMediaButton$(this: JRecordBinder, pkg: string, event: JObj): Gen {
    const intent = yield newObj("android/content/Intent", `(${S})V`, "android.intent.action.MEDIA_BUTTON");
    yield vcall(intent, "putExtra", `(${S}Landroid/os/Parcelable;)Landroid/content/Intent;`, "android.intent.extra.KEY_EVENT", event);
    relay(this.r, "onMediaButtonFromController", "Landroid/content/Intent;", pkg, intent);
    return 1;
  }),
  [`registerCallback(${S}L${MS}ISessionControllerCallback;)V`]: R((r, _pkg: string, cb: JObj) => { if (!r.destroyed) r.callbacks.add(cb); }),
  [`unregisterCallback(L${MS}ISessionControllerCallback;)V`]: R((r, cb: JObj) => { r.callbacks.delete(cb); }),
  [`getPackageName()${S}`]: R((r) => r.pkg),
  [`getTag()${S}`]: R((r) => r.tag),
  [`getSessionInfo()${B}`]: R((r) => r.info),
  "getLaunchPendingIntent()Landroid/app/PendingIntent;": R((r) => r.launch),
  "getFlags()J": R((r) => r.flags),
  [`getVolumeAttributes()L${PI};`]: R((r) => playbackInfo(r)),
  [`adjustVolume(${S}${S}II)V`]: R((r, pkg: string, _op: string, direction: number) => r.remote ? relay(r, "onAdjustVolume", "I", pkg, direction)
    : after(localStream(r), (stream) => setStreamVolume(stream, streamVolume(stream) + Math.sign(direction)))),
  [`setVolumeTo(${S}${S}II)V`]: R((r, pkg: string, _op: string, value: number) => r.remote ? relay(r, "onSetVolumeTo", "I", pkg, value)
    : after(localStream(r), (stream) => setStreamVolume(stream, value))),
  "getMetadata()Landroid/media/MediaMetadata;": R((r) => r.metadata),
  [`getPlaybackState()L${PS};`]: R((r) => currentState(r)),
  "getQueue()Landroid/content/pm/ParceledListSlice;": R((r) => queueSlice(r.queue)),
  "getQueueTitle()Ljava/lang/CharSequence;": R((r) => r.queueTitle),
  [`getExtras()${B}`]: R((r) => r.extras),
  "getRatingType()I": R((r) => r.ratingType),
} });

/** MediaSessionService.enforceMediaPermissions: no app holds MEDIA_CONTENT_CONTROL or an enabled notification listener */
const noMediaControl = () => { throw rt.mkThrowable("java/lang/SecurityException", "Missing permission to control media."); };
rt.register({ name: "webdroid/MediaSessionService", ctor: class extends JObj {}, sup: MS + "ISessionManager$Stub", methods: {
  [`createSession(${S}L${MS}ISessionCallback;${S}${B}I)L${MS}ISession;`]: driven(function* createSession$(pkg: string, cb: JObj, tag: string, info: JObj | null): Gen {
    const binder = (yield* awaited(newStub("webdroid/MediaSessionRecord"))) as JRecordBinder, controller = (yield* awaited(newStub("webdroid/MediaSessionController"))) as JRecordBinder;
    binder.r = controller.r = {
      pkg, tag, info, cb, pid: yield scall("android/os/Process", "myPid", "()I"), uid: yield scall("android/os/Process", "myUid", "()I"),
      controller, callbacks: new Set(), destroyed: false, flags: 0n, launch: null, metadata: null, duration: -1n, playback: null,
      queue: null, queueTitle: null, extras: null, ratingType: 0, attributes: null, remote: null,
    };
    return binder;
  }),
  "getSessions(Landroid/content/ComponentName;I)Ljava/util/List;": noMediaControl,
  [`addSessionsListener(L${MS}IActiveSessionsListener;Landroid/content/ComponentName;I)V`]: noMediaControl,
  ...noops(`removeSessionsListener(L${MS}IActiveSessionsListener;)V`),
} });
hostStub("media_session", "webdroid/MediaSessionService");
