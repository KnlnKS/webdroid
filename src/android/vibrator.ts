// android.os.Vibrator on navigator.vibrate, and the VibrationEffect patterns it plays.

import { rt, JObj } from "../jvm/runtime";
import { systemService } from "./context";

// A vibration is Android's alternating off/on durations (starting with off) and the index it
// repeats from; navigator.vibrate is an on/off motor that takes on/off durations and never loops.
class JVibrationEffect extends JObj { timings: number[] = []; repeat = -1; }
function waveform(timings: ArrayLike<bigint>, repeat: number, amplitudes?: ArrayLike<number>): JVibrationEffect {
  if (repeat < -1 || repeat >= timings.length) throw rt.mkThrowable("java/lang/ArrayIndexOutOfBoundsException", "repeat " + repeat);
  const effect: JVibrationEffect = rt.make("android/os/VibrationEffect");
  for (let i = 0; i < timings.length; i++) {
    // a segment of the other kind than the pattern expects next is preceded by an empty one
    if ((effect.timings.length % 2 === 1) !== (amplitudes ? amplitudes[i] !== 0 : i % 2 === 1)) effect.timings.push(0);
    if (i === repeat) effect.repeat = effect.timings.length;
    effect.timings.push(Number(timings[i]));
  }
  return effect;
}
let vibration: ReturnType<typeof setTimeout> | undefined;
function vibrate(effect: JVibrationEffect): void {
  clearTimeout(vibration);
  const play = (from: number) => {
    const part = effect.timings.slice(from), total = part.reduce((a, b) => a + b, 0);
    globalThis.navigator?.vibrate?.(from % 2 ? part : [0, ...part]);
    if (effect.repeat >= 0 && total > 0) vibration = setTimeout(() => play(effect.repeat), total);
  };
  play(0);
}
rt.register({
  name: "android/os/VibrationEffect", ctor: JVibrationEffect, ifaces: ["android/os/Parcelable"],
  statics: { DEFAULT_AMPLITUDE: -1 },
  methods: {
    "static createPredefined(I)Landroid/os/VibrationEffect;": () => waveform([0n, 30n], -1),
    "static createOneShot(JI)Landroid/os/VibrationEffect;": (ms: bigint) => waveform([0n, ms], -1),
    "static createWaveform([JI)Landroid/os/VibrationEffect;": (timings: BigInt64Array, repeat: number) => waveform(timings, repeat),
    "static createWaveform([J[II)Landroid/os/VibrationEffect;": (timings: BigInt64Array, amplitudes: Int32Array, repeat: number) => {
      if (timings.length !== amplitudes.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "timing and amplitude arrays must be of equal length");
      return waveform(timings, repeat, amplitudes);
    },
  },
});
rt.register({ name: "android/os/VibratorManager", ctor: class extends JObj {}, methods: {
  "getDefaultVibrator()Landroid/os/Vibrator;": () => systemService(null, "vibrator"),
} });
rt.register({ name: "android/os/Vibrator", ctor: class extends JObj {}, methods: {
  ...Object.fromEntries(["", "Landroid/media/AudioAttributes;"].flatMap((attrs) => [
    [`vibrate(J${attrs})V`, (ms: bigint) => vibrate(waveform([0n, ms], -1))],
    [`vibrate([JI${attrs})V`, (pattern: BigInt64Array, repeat: number) => vibrate(waveform(pattern, repeat))],
    [`vibrate(Landroid/os/VibrationEffect;${attrs})V`, vibrate],
  ])),
  "vibrate(Landroid/os/VibrationEffect;Landroid/os/VibrationAttributes;)V": vibrate,
  "hasVibrator()Z": () => 1,
  "cancel()V": () => { clearTimeout(vibration); globalThis.navigator?.vibrate?.(0); },
  // navigator.vibrate is a bare on/off motor: no amplitude, no composed primitives
  "hasAmplitudeControl()Z": () => 0,
  "areAllPrimitivesSupported([I)Z": () => 0,
  "arePrimitivesSupported([I)[Z": (ids: Int32Array) => new Uint8Array(ids.length),
  "areAllEffectsSupported([I)I": () => 2,
  "areEffectsSupported([I)[I": (ids: Int32Array) => new Int32Array(ids.length).fill(2),
} });
