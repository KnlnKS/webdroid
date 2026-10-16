// IVibratorManagerService, the TS half of AOSP's SystemVibratorManager and SystemVibrator: one
// vibrator (id 1, as the reference AVD's) on navigator.vibrate, a bare on/off motor, so it reports
// no capabilities (no amplitude or frequency control) and supports no effects or primitives.
import { awaited, JObj, rt, driven, type Gen } from "../jvm/runtime.ts";
import { newObj, scall, vcall, iof } from "../jvm/natives/jentry.ts";
import { logUncaught, detached } from "../jvm/natives/jthrowable.ts";
import { systemResource } from "./resnative.ts";
import { toJsArray } from "../jvm/natives/jcoll.ts";
import { settingsAccess } from "./settings.ts";

const VIBRATOR_ID = 1;
/** VibrationSettings' fallbacks for prebaked effects a motor without effects cannot play (CLICK,
 *  DOUBLE_CLICK, TICK, HEAVY_CLICK); TEXTURE_TICK's is a TICK without fallback, which plays nothing */
const FALLBACK_PATTERNS: Record<number, string> = {
  0: "config_virtualKeyVibePattern", 1: "config_doubleClickVibePattern", 2: "config_clockTickVibePattern", 5: "config_longPressVibePattern",
};
/** a fallback pattern as off/on durations, as VibrationSettings.createEffectFromTimings reads it */
function* fallbackTimings(effect: number): Gen<number[]> {
  const name = FALLBACK_PATTERNS[effect];
  if (!name) return [];
  const timings = [...(yield systemResource("array", name, "getIntArray", "(I)[I")) as Int32Array];
  return timings.length === 1 ? [0, timings[0]] : timings;
}
let vibration: ReturnType<typeof setTimeout> | undefined;
/** Android's alternating off/on durations, from the composed effect's segments, played from `repeat` */
function play(timings: number[], repeat: number): void {
  clearTimeout(vibration);
  const run = (from: number) => {
    const part = timings.slice(from), total = part.reduce((a, b) => a + b, 0);
    globalThis.navigator?.vibrate?.(from % 2 ? part : [0, ...part]);
    if (repeat >= 0 && total > 0) vibration = setTimeout(() => run(repeat), total);
  };
  run(0);
}
/** a composed effect's segments as off/on durations (off first), and the index its repeat starts at */
function* timingsOf(effect: JObj): Gen<[number[], number]> {
  const segments = (yield* awaited(toJsArray(yield vcall(effect, "getSegments", "()Ljava/util/List;")))) as JObj[];
  const repeatSegment: number = yield vcall(effect, "getRepeatIndex", "()I");
  const timings: number[] = [];
  let repeat = -1;
  const push = (on: boolean, ms: number) => {
    if ((timings.length % 2 === 1) !== on) timings.push(0);
    timings.push(ms);
  };
  for (const [i, segment] of segments.entries()) {
    if (i === repeatSegment) repeat = timings.length;
    if (iof(segment, "android/os/vibrator/StepSegment")) {
      push((yield vcall(segment, "getAmplitude", "()F")) !== 0, Number(yield vcall(segment, "getDuration", "()J")));
    } else if (iof(segment, "android/os/vibrator/RampSegment")) {
      push((yield vcall(segment, "getStartAmplitude", "()F")) !== 0 || (yield vcall(segment, "getEndAmplitude", "()F")) !== 0,
        Number(yield vcall(segment, "getDuration", "()J")));
    } else if (iof(segment, "android/os/vibrator/PrebakedSegment") && (yield vcall(segment, "shouldFallback", "()Z"))) {
      (yield* fallbackTimings(yield vcall(segment, "getEffectId", "()I"))).forEach((ms, k) => push(k % 2 === 1, ms));
    }
  }
  return [timings, repeat];
}
/** one vibrator: a stereo vibration plays the effect meant for it */
function* playCombined(combined: JObj): Gen<void> {
  const effect: JObj | null = iof(combined, "android/os/CombinedVibration$Mono")
    ? yield vcall(combined, "getEffect", "()Landroid/os/VibrationEffect;")
    : yield vcall(yield vcall(combined, "getEffects", "()Landroid/util/SparseArray;"), "get", "(I)Ljava/lang/Object;", VIBRATOR_ID);
  if (effect) play(...(yield* timingsOf(effect)));
}
/** HapticFeedbackVibrationProvider's effect for a haptic feedback constant, as [effect, fallback],
 *  on a vibrator without primitives: a primitive effect plays its prebaked fallback. Text handle
 *  haptics are off (config_enableHapticTextHandle); 10004 and 10005 need VIBRATE_SYSTEM_CONSTANTS;
 *  SAFE_MODE_ENABLED is the system's own. */
const CLICK = 0, DOUBLE_CLICK = 1, TICK = 2, HEAVY_CLICK = 5, TEXTURE_TICK = 21;
const HAPTIC_EFFECTS: Record<number, [number, boolean]> = {
  0: [HEAVY_CLICK, true], 1: [CLICK, true], 3: [CLICK, true], 4: [TEXTURE_TICK, true], 5: [CLICK, true], 6: [TICK, true],
  7: [TICK, false], 8: [TICK, false], 11: [TICK, false], 12: [CLICK, true], 13: [TICK, true], 14: [HEAVY_CLICK, true],
  15: [CLICK, true], 16: [CLICK, true], 17: [DOUBLE_CLICK, true], 18: [TICK, true], 19: [CLICK, true], 20: [CLICK, true],
  21: [TICK, true], 22: [TEXTURE_TICK, true], 23: [TICK, true], 24: [TEXTURE_TICK, true], 25: [HEAVY_CLICK, true],
  26: [TICK, true], 27: [TEXTURE_TICK, true], 10002: [HEAVY_CLICK, true], 10003: [HEAVY_CLICK, true],
};
/** VibratorManagerService.performHapticFeedback: touch feedback, off with haptic_feedback_enabled
 *  unless the caller bypasses that setting */
function* performHapticFeedback(constant: number, always: number): Gen<void> {
  const effect = HAPTIC_EFFECTS[constant];
  if (!effect || !always && (yield* awaited(settingsAccess().get("system", "haptic_feedback_enabled"))) === "0") return;
  const vibration = yield scall("android/os/VibrationEffect", "get", "(IZ)Landroid/os/VibrationEffect;", effect[0], +effect[1]);
  play(...(yield* timingsOf(vibration)));
}
rt.register({ name: "webdroid/VibratorManagerService", ctor: class extends JObj {}, sup: "android/os/IVibratorManagerService$Stub", methods: {
  "getVibratorIds()[I": () => Int32Array.of(VIBRATOR_ID),
  "getVibratorInfo(I)Landroid/os/VibratorInfo;": driven(function* (id: number) {
    if (id !== VIBRATOR_ID) return null;
    const builder = yield newObj("android/os/VibratorInfo$Builder", "(I)V", id);
    yield vcall(builder, "setSupportedEffects", "([I)Landroid/os/VibratorInfo$Builder;", new Int32Array(0));
    return yield vcall(builder, "build", "()Landroid/os/VibratorInfo;");
  }),
  "vibrate(IILjava/lang/String;Landroid/os/CombinedVibration;Landroid/os/VibrationAttributes;Ljava/lang/String;Landroid/os/IBinder;)V":
    (_uid: number, _device: number, _pkg: string, combined: JObj) => { detached(() => rt.drive(playCombined(combined)), logUncaught); },
  "cancelVibrate(ILandroid/os/IBinder;)V": () => { clearTimeout(vibration); globalThis.navigator?.vibrate?.(0); },
  "performHapticFeedback(IILjava/lang/String;IZLjava/lang/String;Z)V": (_uid: number, _device: number, _pkg: string, constant: number, always: number) => {
    detached(() => rt.drive(performHapticFeedback(constant, always)), logUncaught);
  },
  "isVibrating(I)Z": () => 0,
  // no state changes are reported, as none can be observed
  "registerVibratorStateListener(ILandroid/os/IVibratorStateListener;)Z": () => 0,
  "unregisterVibratorStateListener(ILandroid/os/IVibratorStateListener;)Z": () => 0,
} });
