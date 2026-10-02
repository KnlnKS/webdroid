// IAudioService, under AOSP's AudioManager and Spatializer: the reference AVD's stream volumes
// (dumpsys audio; aliased streams follow their alias, rescaled as AudioService.rescaleIndex does),
// a normal ringer and mode, MediaFocusControl's focus stack, and no spatializer. Output devices are
// not modelled (AudioSystem lists no ports), so no attributes route to one. A codec's loudness
// parameters are the reference AVD's for its output (the speaker).
import { rt, JObj, noops, stubs, declaredField, driven } from "../jvm/runtime";
import { newObj, scall, vcall } from "../jvm/natives/jlang";
import { newArrayList } from "../jvm/natives/jcoll";
import { hostStub } from "./binder";
import { isMusicActive } from "./media";
import { reportUncaught } from "./os";

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

/** a focus holder, and the loss it last heard (0 while it holds focus) */
type Holder = { clientId: string; dispatcher: JObj | null; loss: number };
const focusStack: Holder[] = [];
const GAIN = 1, GAIN_TRANSIENT_MAY_DUCK = 3, LOSS = -1, LOSS_TRANSIENT = -2, LOSS_TRANSIENT_CAN_DUCK = -3;
/** FocusRequester.focusLossForGainRequest */
const lossFor = (gain: number, loss: number) => loss === LOSS || gain === GAIN ? LOSS
  : gain === GAIN_TRANSIENT_MAY_DUCK && loss !== LOSS_TRANSIENT ? LOSS_TRANSIENT_CAN_DUCK : LOSS_TRANSIENT;
const dispatch = (h: Holder, change: number) =>
  void (h.dispatcher && vcall(h.dispatcher, "dispatchAudioFocusChange", "(ILjava/lang/String;)V", change, h.clientId))?.catch(reportUncaught);
function requestFocus(gain: number, dispatcher: JObj | null, clientId: string): number {
  abandon(clientId, false);
  for (const h of [...focusStack]) {
    const loss = lossFor(gain, h.loss);
    if (loss === h.loss) continue;
    h.loss = loss;
    if (loss === LOSS) focusStack.splice(focusStack.indexOf(h), 1);
    dispatch(h, loss);
  }
  focusStack.push({ clientId, dispatcher, loss: 0 });
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

let capturePolicy = 1;
rt.register({ name: "webdroid/AudioService", ctor: class extends JObj {}, sup: "android/media/IAudioService$Stub", methods: {
  "getStreamVolume(I)I": streamVolume,
  "getStreamMaxVolume(I)I": streamMaxVolume,
  "getStreamMinVolume(I)I": (stream: number) => volumeOf(stream)[0],
  "getLastAudibleStreamVolume(I)I": streamVolume,
  "getStreamTypeAlias(I)I": (stream: number) => { volumeOf(stream); return ALIAS[stream]; },
  "setStreamVolume(IIILjava/lang/String;)V": setStreamVolume,
  "setStreamVolumeWithAttribution(IIILjava/lang/String;Ljava/lang/String;)V": setStreamVolume,
  "isMusicActive(Z)Z": isMusicActive,
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
  "getAllowedCapturePolicy()I": () => capturePolicy,
  // AudioService validates the policy as AudioAttributes does
  "setAllowedCapturePolicy(I)I": async (policy: number) => {
    await scall("android/media/AudioAttributes", "capturePolicyToFlags", "(II)I", policy, 0);
    capturePolicy = policy;
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
  // the mode stays MODE_NORMAL, so no mode change is ever dispatched
  ...noops("registerModeDispatcher(Landroid/media/IAudioModeDispatcher;)V", "unregisterModeDispatcher(Landroid/media/IAudioModeDispatcher;)V"),
} });
hostStub("audio", "webdroid/AudioService");

// AudioPortEventHandler's native half: the port and patch lists never change, so no event is posted
rt.registerJnis("android/media/AudioPortEventHandler", { "native_setup(Ljava/lang/Object;)V": () => {}, "native_finalize()V": () => {} });
