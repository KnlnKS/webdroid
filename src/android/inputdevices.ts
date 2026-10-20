// IInputManager, under AOSP's InputManagerGlobal, InputManager, InputDevice and KeyCharacterMap: the
// reference AVD's virtual keyboard (id -1) and the touchscreen that serves its display
// (virtio_input_multi_touch_1, id 12), as `dumpsys input` and InputDevice.toString report them
// there. The touchscreen's raw axes span 0..32767; InputReader scales them to the panel, which
// sets its motion ranges and the events' precision.

import { awaited, rt, JObj, driven, waits, type Gen } from "../jvm/runtime.ts";
import { after, newObj, vcall } from "../jvm/natives/jentry.ts";
import { once } from "../jvm/suspend.ts";
import { hostService } from "./binder.ts";
import { device } from "../shell/config.ts";
import { KEY_CHARACTER_MAPS, DEVICE_KEYS } from "./keychars.ts";
import { parseKeyMap, javaKeyCharacterMap } from "./keyevent.ts";

export const VIRTUAL_KEYBOARD = -1, TOUCHSCREEN = 12;
/** TOUCHSCREEN | STYLUS: the source of the touchscreen's events */
export const TOUCH_SOURCE = 0x5002;
const RAW_RANGE = 32768;
/** a touch event's precision along a display axis of `size` pixels: raw units per pixel */
export const touchPrecision = (size: number): number => RAW_RANGE / size;

const B = "android/view/InputDevice$Builder";
function* build(calls: [string, string, ...unknown[]][], ranges: [number, number, number][] = []): Gen<JObj> {
  const builder = yield newObj(B, "()V");
  for (const [name, arg, ...values] of calls) yield vcall(builder, name, `(${arg})L${B};`, ...values);
  for (const [axis, min, max] of ranges) yield vcall(builder, "addMotionRange", `(IIFFFFF)L${B};`, axis, TOUCH_SOURCE, min, max, 0, 0, 0);
  return yield vcall(builder, "build", "()Landroid/view/InputDevice;");
}
const keyMap = (file: string) => parseKeyMap(`/system/usr/keychars/${file}`, KEY_CHARACTER_MAPS[file]);
function common(id: number, generation: number, name: string, descriptor: string, sources: number, keyboardType: number, bus: number, display: number): [string, string, ...unknown[]][] {
  return [["setId", "I", id], ["setGeneration", "I", generation], ["setName", "Ljava/lang/String;", name],
    ["setDescriptor", "Ljava/lang/String;", descriptor], ["setSources", "I", sources], ["setKeyboardType", "I", keyboardType],
    ["setDeviceBus", "I", bus], ["setAssociatedDisplayId", "I", display], ["setEnabled", "Z", 1]];
}
const inputDevices = once(driven(function* (): Gen<Map<number, JObj>> {
  const virtual = yield* build([...common(VIRTUAL_KEYBOARD, 3, "Virtual", "a718a782d34bc767f4689c232d64d527998ea7fd", 0x301, 2, 0, -1),
    ["setKeyCharacterMap", "Landroid/view/KeyCharacterMap;", yield* awaited(javaKeyCharacterMap(VIRTUAL_KEYBOARD, keyMap("Virtual.kcm")))]]);
  const { width, height } = device, diagonal = Math.hypot(width, height);
  // the switch mapper's source (AINPUT_SOURCE_SWITCH, 0x80000000) rides along with keyboard, touchscreen and stylus
  const touch = yield* build([...common(TOUCHSCREEN, 86, "virtio_input_multi_touch_1", "43db9dd6fa61939c1b516cd9522f0fe93926a00b", 0x80005103 | 0, 1, 6, 0),
    ["setKeyCharacterMap", "Landroid/view/KeyCharacterMap;", yield* awaited(javaKeyCharacterMap(TOUCHSCREEN, keyMap("Generic.kcm")))]],
  [[0, 0, (RAW_RANGE - 1) * width / RAW_RANGE], [1, 0, (RAW_RANGE - 1) * height / RAW_RANGE], [2, 0, 1], [3, 0, 1],
    [4, 0, diagonal], [5, 0, diagonal], [6, 0, diagonal], [7, 0, diagonal], [8, -Math.PI / 2, Math.PI / 2]]);
  return new Map([[VIRTUAL_KEYBOARD, virtual], [TOUCHSCREEN, touch]]);
}));

/** InputReader::hasKeys: a negative id asks every device; only keyboard mappers know keys */
function hasKeys(id: number, sourceMask: number, codes: Int32Array, out: Uint8Array): number {
  if (codes.length > out.length) throw rt.mkThrowable("java/lang/IllegalArgumentException", "keyExists must be at least as large as keyCodes");
  out.fill(0, 0, codes.length);
  if (id !== VIRTUAL_KEYBOARD && id !== TOUCHSCREEN && id >= 0) return 0;
  if (!(sourceMask & 0x101 & ~0xff)) return 0;
  const keys = new Set(DEVICE_KEYS[id === TOUCHSCREEN ? "virtio_input_multi_touch_1" : "Virtual"]);
  codes.forEach((code, i) => { if (keys.has(code)) out[i] = 1; });
  return 1;
}

hostService("input", "webdroid/InputManagerService", "android/hardware/input/IInputManager$Stub", {
  "getInputDevice(I)Landroid/view/InputDevice;": waits((id: number) => after(inputDevices(), (devices) => devices.get(id) ?? null)),
  "getInputDeviceIds()[I": () => Int32Array.of(VIRTUAL_KEYBOARD, TOUCHSCREEN),
  // the devices never change, so a listener is never called
  "registerInputDevicesChangedListener(Landroid/hardware/input/IInputDevicesChangedListener;)V": () => {},
  "hasKeys(II[I[Z)Z": hasKeys,
  // the device leaves the velocitytracker_strategy flag at its default
  "getVelocityTrackerStrategy()Ljava/lang/String;": () => null,
});

