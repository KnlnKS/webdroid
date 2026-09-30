// IVibratorManagerService, the TS half of AOSP's SystemVibratorManager and SystemVibrator: one
// vibrator (id 1, as the reference AVD's) on navigator.vibrate, a bare on/off motor, so it reports
// no capabilities (no amplitude or frequency control) and supports no effects or primitives.
import { JObj, rt } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { toJsArray } from "../jvm/natives/jutil";
import { reportUncaught } from "./os";

const VIBRATOR_ID = 1;
/** a prebaked effect (EFFECT_CLICK, TICK, ...) plays as a short pulse on a motor with no effects */
const PREBAKED_MS = 30;
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
async function timingsOf(effect: JObj): Promise<[number[], number]> {
  const segments = await toJsArray(await vcall(effect, "getSegments", "()Ljava/util/List;")) as JObj[];
  const repeatSegment: number = await vcall(effect, "getRepeatIndex", "()I");
  const timings: number[] = [];
  let repeat = -1;
  for (const [i, segment] of segments.entries()) {
    let on: boolean, ms: number;
    if (rt.iof(segment, "android/os/vibrator/StepSegment")) {
      on = await vcall(segment, "getAmplitude", "()F") !== 0; ms = Number(await vcall(segment, "getDuration", "()J"));
    } else if (rt.iof(segment, "android/os/vibrator/RampSegment")) {
      on = await vcall(segment, "getStartAmplitude", "()F") !== 0 || await vcall(segment, "getEndAmplitude", "()F") !== 0;
      ms = Number(await vcall(segment, "getDuration", "()J"));
    } else { on = true; ms = PREBAKED_MS; }
    if ((timings.length % 2 === 1) !== on) timings.push(0);
    if (i === repeatSegment) repeat = timings.length;
    timings.push(ms);
  }
  return [timings, repeat];
}
/** one vibrator: a stereo vibration plays the effect meant for it */
async function playCombined(combined: JObj): Promise<void> {
  const effect: JObj | null = rt.iof(combined, "android/os/CombinedVibration$Mono")
    ? await vcall(combined, "getEffect", "()Landroid/os/VibrationEffect;")
    : await vcall(await vcall(combined, "getEffects", "()Landroid/util/SparseArray;"), "get", "(I)Ljava/lang/Object;", VIBRATOR_ID);
  if (effect) play(...await timingsOf(effect));
}
rt.register({ name: "webdroid/VibratorManagerService", ctor: class extends JObj {}, sup: "android/os/IVibratorManagerService$Stub", methods: {
  "getVibratorIds()[I": () => Int32Array.of(VIBRATOR_ID),
  "getVibratorInfo(I)Landroid/os/VibratorInfo;": async (id: number) => {
    if (id !== VIBRATOR_ID) return null;
    const builder = await newObj("android/os/VibratorInfo$Builder", "(I)V", id);
    await vcall(builder, "setSupportedEffects", "([I)Landroid/os/VibratorInfo$Builder;", new Int32Array(0));
    return vcall(builder, "build", "()Landroid/os/VibratorInfo;");
  },
  "vibrate(IILjava/lang/String;Landroid/os/CombinedVibration;Landroid/os/VibrationAttributes;Ljava/lang/String;Landroid/os/IBinder;)V":
    (_uid: number, _device: number, _pkg: string, combined: JObj) => { void playCombined(combined).catch(reportUncaught); },
  "cancelVibrate(ILandroid/os/IBinder;)V": () => { clearTimeout(vibration); globalThis.navigator?.vibrate?.(0); },
  "isVibrating(I)Z": () => 0,
  // no state changes are reported, as none can be observed
  "registerVibratorStateListener(ILandroid/os/IVibratorStateListener;)Z": () => 0,
  "unregisterVibratorStateListener(ILandroid/os/IVibratorStateListener;)Z": () => 0,
} });
