// The audio policy: AudioSystem's limits and product strategies, and IAudioService under AOSP's
// AudioManager and Spatializer: the reference AVD's stream volumes (dumpsys audio; aliased streams
// follow their alias, rescaled as AudioService.rescaleIndex does), a normal ringer and mode,
// MediaFocusControl's focus stack, PlaybackActivityMonitor's players, and no spatializer. Output
// devices are not modelled (AudioSystem lists no ports), so no attributes route to one. A codec's
// loudness parameters are the reference AVD's for its output (the speaker).
import { rt, JObj, noops, stubs, declaredField, driven, getDeclared, type Gen } from "../jvm/runtime.ts";
import { jarray } from "../jvm/abi.ts";
import { newObj, scall, vcall } from "../jvm/natives/jentry.ts";
import { newArrayList } from "../jvm/natives/jcoll.ts";
import { callingIdentity, hostStub, onCallerDeath, oneway, type Caller } from "./binder.ts";
import { newAudioSessionId, outputSampleRate } from "./audio-output.ts";

/** [min, max, index] by stream type, STREAM_VOICE_CALL..STREAM_ASSISTANT */
const VOLUMES: [number, number, number][] = [[1, 5, 3], [0, 7, 5], [0, 7, 5], [0, 15, 5], [1, 7, 6], [0, 7, 5], [0, 15, 7],
  [0, 7, 5], [0, 15, 11], [0, 15, 5], [1, 15, 6], [0, 15, 5]];
/** a handset's aliases: SYSTEM, SYSTEM_ENFORCED and DTMF to RING; TTS, ACCESSIBILITY and ASSISTANT to MUSIC */
const ALIAS = [0, 2, 2, 3, 4, 5, 6, 2, 2, 3, 3, 3];
const volumeOf = (stream: number) => {
  const v = VOLUMES[stream];
  if (!v) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Bad stream type " + stream);
  return v;
};
const rescale = (index: number, from: number, to: number) => Math.floor((index * VOLUMES[to][1] + (VOLUMES[from][1] >> 1)) / VOLUMES[from][1]);
export const streamVolume = (stream: number): number => volumeOf(stream)[2];
export const streamMaxVolume = (stream: number): number => volumeOf(stream)[1];
export function setStreamVolume(stream: number, index: number): void {
  const [min, max] = volumeOf(stream), alias = ALIAS[stream];
  const set = rescale(Math.min(max, Math.max(min, index)), stream, alias);
  ALIAS.forEach((a, s) => { if (a === alias) VOLUMES[s][2] = Math.max(VOLUMES[s][0], s === alias ? set : rescale(set, alias, s)); });
}

/** a focus holder in process `pid`, and the loss it last heard (0 while it holds focus) */
type Holder = { pid: number; clientId: string; dispatcher: JObj | null; loss: number };
const focusStack: Holder[] = [];
const GAIN = 1, GAIN_TRANSIENT_MAY_DUCK = 3, LOSS = -1, LOSS_TRANSIENT = -2, LOSS_TRANSIENT_CAN_DUCK = -3;
/** FocusRequester.focusLossForGainRequest */
const lossFor = (gain: number, loss: number) => loss === LOSS || gain === GAIN ? LOSS
  : gain === GAIN_TRANSIENT_MAY_DUCK && loss !== LOSS_TRANSIENT ? LOSS_TRANSIENT_CAN_DUCK : LOSS_TRANSIENT;
const dispatch = (h: Holder, change: number) => {
  if (h.dispatcher) oneway(h.dispatcher, "dispatchAudioFocusChange", "(ILjava/lang/String;)V", change, h.clientId);
};
function requestFocus(gain: number, dispatcher: JObj | null, clientId: string): number {
  const { pid } = caller();
  abandon(clientId, false);
  for (const h of [...focusStack]) {
    const loss = lossFor(gain, h.loss);
    if (loss === h.loss) continue;
    h.loss = loss;
    if (loss === LOSS) focusStack.splice(focusStack.indexOf(h), 1);
    dispatch(h, loss);
  }
  focusStack.push({ pid, clientId, dispatcher, loss: 0 });
  return 1;
}
/** the holder leaves the stack; a new top that had lost focus regains it */
function abandon(clientId: string, notify = true): number {
  const i = focusStack.findIndex((h) => h.clientId === clientId);
  if (i < 0) return 1;
  focusStack.splice(i, 1);
  const top = focusStack.at(-1);
  if (notify && i === focusStack.length && top?.loss) { top.loss = 0; dispatch(top, GAIN); }
  return 1;
}

// PlaybackActivityMonitor's players by the piid trackPlayer hands out: their owner, legacy stream and last state
const IDLE = 1, STARTED = 2, STOPPED = 4, PLAYER_TYPE_JAM_SOUNDPOOL = 3, STREAM_MUSIC = 3;
type Player = { pid: number; uid: number; type: number; stream: number; state: number };
const players = new Map<number, Player>();
let playerIds = 0;
const PIC = "android/media/PlayerBase$PlayerIdCard";
const legacyStream = (attributes: unknown) => scall("android/media/AudioAttributes", "toLegacyStreamType", "(Landroid/media/AudioAttributes;)I", attributes);
/** the player, when the caller owns it: checkConfigurationCaller takes no other uid's updates */
const owned = (piid: number) => {
  const p = players.get(piid);
  return p?.uid === callingIdentity().uid ? p : undefined;
};
/** whether a started player `matches` */
function active(matches: (p: Player) => boolean): number {
  for (const p of players.values()) if (p.state === STARTED && matches(p)) return 1;
  return 0;
}
/** the caller, whose players and focus requests die with its process */
function caller(): Caller {
  const who = callingIdentity();
  onCallerDeath(who.pid, died);
  return who;
}
function died(pid: number) {
  for (const [piid, p] of players) if (p.pid === pid) players.delete(piid);
  for (const h of focusStack.filter((h) => h.pid === pid)) abandon(h.clientId);
}
/** each uid's allowed capture policy, ALLOW_CAPTURE_BY_ALL until it sets one */
const capturePolicies = new Map<number, number>();
rt.register({ name: "webdroid/AudioService", ctor: class extends JObj {}, sup: "android/media/IAudioService$Stub", methods: {
  "getStreamVolume(I)I": streamVolume,
  "getStreamMaxVolume(I)I": streamMaxVolume,
  "getStreamMinVolume(I)I": (stream: number) => volumeOf(stream)[0],
  "getLastAudibleStreamVolume(I)I": streamVolume,
  "getStreamTypeAlias(I)I": (stream: number) => { volumeOf(stream); return ALIAS[stream]; },
  "setStreamVolume(IIILjava/lang/String;)V": setStreamVolume,
  "setStreamVolumeWithAttribution(IIILjava/lang/String;Ljava/lang/String;)V": setStreamVolume,
  // AudioSystem.isStreamActive(STREAM_MUSIC) as its players report it; none plays to a remote submix
  "isMusicActive(Z)Z": (remotely: number) => remotely ? 0 : active((p) => p.stream === STREAM_MUSIC),
  // RINGER_MODE_NORMAL, MODE_NORMAL
  ...stubs(2, "getRingerModeExternal()I", "getRingerModeInternal()I"),
  ...stubs(0, "getMode()I", "isStreamMute(I)Z", "isMasterMute()Z", "isSpeakerphoneOn()Z", "isBluetoothScoOn()Z", "isBluetoothA2dpOn()Z", "isVolumeFixed()Z",
    "isSpatializerEnabled()Z", "isSpatializerAvailable()Z", "getSpatializerImmersiveAudioLevel()I",
    "canBeSpatialized(Landroid/media/AudioAttributes;Landroid/media/AudioFormat;)Z"),
  ...noops("registerSpatializerCallback(Landroid/media/ISpatializerCallback;)V", "unregisterSpatializerCallback(Landroid/media/ISpatializerCallback;)V"),
  // nothing set navigation repeat effects on; SoundEffectsHelper has no samples to play, as the
  // device has no /system/media/audio/ui
  "areNavigationRepeatSoundEffectsEnabled()Z": () => 0,
  "playSoundEffect(II)V": () => {},
  // the one output is the speaker (AudioRoutesInfo.MAIN_SPEAKER), and it never changes
  "startWatchingRoutes(Landroid/media/IAudioRoutesObserver;)Landroid/media/AudioRoutesInfo;": () => newObj("android/media/AudioRoutesInfo"),
  "getAllowedCapturePolicy()I": () => capturePolicies.get(callingIdentity().uid) ?? 1,
  // AudioService validates the policy as AudioAttributes does
  "setAllowedCapturePolicy(I)I": async (policy: number) => {
    const { uid } = callingIdentity();
    await scall("android/media/AudioAttributes", "capturePolicyToFlags", "(II)I", policy, 0);
    capturePolicies.set(uid, policy);
    return 0;
  },
  "getDevicesForAttributesUnprotected(Landroid/media/AudioAttributes;)Ljava/util/List;": () => newArrayList(),
  "requestAudioFocus(Landroid/media/AudioAttributes;ILandroid/os/IBinder;Landroid/media/IAudioFocusDispatcher;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;ILandroid/media/audiopolicy/IAudioPolicyCallback;I)I":
    (_attrs: unknown, gain: number, _cb: unknown, dispatcher: JObj | null, clientId: string) => requestFocus(gain, dispatcher, clientId),
  "abandonAudioFocus(Landroid/media/IAudioFocusDispatcher;Ljava/lang/String;Landroid/media/AudioAttributes;Ljava/lang/String;)I":
    (_dispatcher: unknown, clientId: string) => abandon(clientId),
  "getLoudnessParams(Landroid/media/LoudnessCodecInfo;)Landroid/os/PersistableBundle;": driven(function* (info: Record<string, number>) {
    const bundle = yield newObj("android/os/PersistableBundle"), type = info[declaredField("android/media/LoudnessCodecInfo", "metadataType")];
    yield vcall(bundle, "putInt", "(Ljava/lang/String;I)V", "aac-target-ref-level", 64);
    if (type === 1) yield vcall(bundle, "putInt", "(Ljava/lang/String;I)V", "aac-drc-heavy-compression", 1);
    if (type === 2) yield vcall(bundle, "putInt", "(Ljava/lang/String;I)V", "aac-drc-effect-type", 3);
    return bundle;
  }),
  // the output never changes, so no updated parameters are ever dispatched
  ...noops("registerLoudnessCodecUpdatesDispatcher(Landroid/media/ILoudnessCodecUpdatesDispatcher;)V",
    "unregisterLoudnessCodecUpdatesDispatcher(Landroid/media/ILoudnessCodecUpdatesDispatcher;)V", "startLoudnessCodecUpdates(I)V",
    "stopLoudnessCodecUpdates(I)V", "addLoudnessCodecInfo(IILandroid/media/LoudnessCodecInfo;)V",
    "removeLoudnessCodecInfo(ILandroid/media/LoudnessCodecInfo;)V"),
  // no SystemUI registered a ringtone player, so a Ringtone plays locally
  "getRingtonePlayer()Landroid/media/IRingtonePlayer;": () => null,
  // PlaybackActivityMonitor; no playback callback is registered to hear of its players' events
  "trackPlayer(Landroid/media/PlayerBase$PlayerIdCard;)I": driven(function* (card: JObj): Gen<number> {
    const { pid, uid } = caller(), piid = ++playerIds;
    const stream: number = yield legacyStream(getDeclared(card, PIC, "mAttributes"));
    players.set(piid, { pid, uid, type: getDeclared(card, PIC, "mPlayerType"), stream, state: IDLE });
    return piid;
  }),
  "playerAttributes(ILandroid/media/AudioAttributes;)V": driven(function* (piid: number, attributes: JObj): Gen<void> {
    const p = owned(piid);
    if (p) p.stream = yield legacyStream(attributes);
  }),
  // a SoundPool reports each play but never its end, so the monitor takes none of its states; events
  // past STOPPED update a player's device, port, mute or format
  "playerEvent(III)V": (piid: number, event: number) => {
    const p = owned(piid);
    if (p && p.type !== PLAYER_TYPE_JAM_SOUNDPOOL && event <= STOPPED) p.state = event;
  },
  "releasePlayer(I)V": (piid: number) => { if (owned(piid)) players.delete(piid); },
  "playerSessionId(II)V": () => {},
  // the mode stays MODE_NORMAL, so no mode change is ever dispatched
  ...noops("registerModeDispatcher(Landroid/media/IAudioModeDispatcher;)V", "unregisterModeDispatcher(Landroid/media/IAudioModeDispatcher;)V"),
} });
hostStub("audio", "webdroid/AudioService");

// AudioPortEventHandler's native half: the port and patch lists never change, so no event is posted
rt.registerJnis("android/media/AudioPortEventHandler", { "native_setup(Ljava/lang/Object;)V": () => {}, "native_finalize()V": () => {} });

// No camera is attached (Camera.getNumberOfCameras is 0), so MediaProfiles holds no camcorder
// profile: get() fails as the native lookup does for a missing profile and getAll() finds none.
rt.claimNativeLib("media_jni");
rt.registerJnis("android/media/CamcorderProfile", {
  "native_init()V": () => {},
  "native_has_camcorder_profile(II)Z": () => 0,
  "native_get_camcorder_profile(II)Landroid/media/CamcorderProfile;": () => {
    throw rt.mkThrowable("java/lang/RuntimeException", "Error retrieving camcorder profile params");
  },
  "native_get_camcorder_profiles(IIZ)Landroid/media/EncoderProfiles;": () => null,
});

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

// IMediaRouterService, under AOSP's MediaRouter: no remote display provider is installed, so the
// global state holds no routes (dumpsys media_router on the reference AVD: routes=[]) and an app
// has only the default audio and video route MediaRouter makes itself
const MRC = "Landroid/media/IMediaRouterClient;";
rt.register({ name: "webdroid/MediaRouterService", ctor: class extends JObj {}, sup: "android/media/IMediaRouterService$Stub", methods: {
  [`getState(${MRC})Landroid/media/MediaRouterClientState;`]: () => newObj("android/media/MediaRouterClientState"),
  // AudioPlayerStateMonitor's view of the client's uid: its own started players
  [`isPlaybackActive(${MRC})Z`]: () => {
    const { uid } = callingIdentity();
    return active((p) => p.uid === uid);
  },
  ...noops(`registerClientAsUser(${MRC}Ljava/lang/String;I)V`, `unregisterClient(${MRC})V`, `setDiscoveryRequest(${MRC}IZ)V`,
    `setSelectedRoute(${MRC}Ljava/lang/String;Z)V`),
} });
hostStub("media_router", "webdroid/MediaRouterService");
