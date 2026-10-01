// IInputManager, under AOSP's InputManagerGlobal, InputManager, InputDevice and KeyCharacterMap: the
// reference AVD's virtual keyboard (id -1) and the touchscreen that serves its display
// (virtio_input_multi_touch_1, id 12), as `dumpsys input` and InputDevice.toString report them
// there. The touchscreen's raw axes span 0..32767; InputReader scales them to the panel, which
// sets its motion ranges and the events' precision.

import { rt, JObj } from "../jvm/runtime";
import { newObj, vcall } from "../jvm/natives/jlang";
import { hostStub } from "./binder";
import { device } from "../shell/config";
import { KEY_CHARACTER_MAPS, DEVICE_KEYS } from "./keychars";
import { parseKeyMap, javaKeyCharacterMap } from "./keyevent";
import { NativeMotionEvent, Coords, nextId, SUPPORTS_ORIENTATION, AXIS_X, AXIS_Y, AXIS_PRESSURE } from "./motionevent";

export const VIRTUAL_KEYBOARD = -1, TOUCHSCREEN = 12;
/** TOUCHSCREEN | STYLUS: the source of the touchscreen's events */
export const TOUCH_SOURCE = 0x5002;
const TOOL_TYPE_FINGER = 1;
const RAW_RANGE = 32768;

const B = "android/view/InputDevice$Builder";
async function build(calls: [string, string, ...unknown[]][], ranges: [number, number, number][] = []): Promise<JObj> {
  const builder = await newObj(B, "()V");
  for (const [name, arg, ...values] of calls) await vcall(builder, name, `(${arg})L${B};`, ...values);
  for (const [axis, min, max] of ranges) await vcall(builder, "addMotionRange", `(IIFFFFF)L${B};`, axis, TOUCH_SOURCE, min, max, 0, 0, 0);
  return vcall(builder, "build", "()Landroid/view/InputDevice;");
}
const keyMap = (file: string) => parseKeyMap(`/system/usr/keychars/${file}`, KEY_CHARACTER_MAPS[file]);
function common(id: number, generation: number, name: string, descriptor: string, sources: number, keyboardType: number, bus: number, display: number) {
  return [["setId", "I", id], ["setGeneration", "I", generation], ["setName", "Ljava/lang/String;", name],
    ["setDescriptor", "Ljava/lang/String;", descriptor], ["setSources", "I", sources], ["setKeyboardType", "I", keyboardType],
    ["setDeviceBus", "I", bus], ["setAssociatedDisplayId", "I", display], ["setEnabled", "Z", 1]] as [string, string, ...unknown[]][];
}
let devices: Promise<Map<number, JObj>> | null = null;
const inputDevices = () => devices ??= (async () => {
  const virtual = await build([...common(VIRTUAL_KEYBOARD, 3, "Virtual", "a718a782d34bc767f4689c232d64d527998ea7fd", 0x301, 2, 0, -1),
    ["setKeyCharacterMap", "Landroid/view/KeyCharacterMap;", await javaKeyCharacterMap(VIRTUAL_KEYBOARD, keyMap("Virtual.kcm"))]]);
  const { width, height } = device, diagonal = Math.hypot(width, height);
  // the switch mapper's source (AINPUT_SOURCE_SWITCH, 0x80000000) rides along with keyboard, touchscreen and stylus
  const touch = await build([...common(TOUCHSCREEN, 86, "virtio_input_multi_touch_1", "43db9dd6fa61939c1b516cd9522f0fe93926a00b", 0x80005103 | 0, 1, 6, 0),
    ["setKeyCharacterMap", "Landroid/view/KeyCharacterMap;", await javaKeyCharacterMap(TOUCHSCREEN, keyMap("Generic.kcm"))]],
  [[0, 0, (RAW_RANGE - 1) * width / RAW_RANGE], [1, 0, (RAW_RANGE - 1) * height / RAW_RANGE], [2, 0, 1], [3, 0, 1],
    [4, 0, diagonal], [5, 0, diagonal], [6, 0, diagonal], [7, 0, diagonal], [8, -Math.PI / 2, Math.PI / 2]]);
  return new Map([[VIRTUAL_KEYBOARD, virtual], [TOUCHSCREEN, touch]]);
})();

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

rt.register({ name: "webdroid/InputManagerService", ctor: class extends JObj {}, sup: "android/hardware/input/IInputManager$Stub", methods: {
  "getInputDevice(I)Landroid/view/InputDevice;": async (id: number) => (await inputDevices()).get(id) ?? null,
  "getInputDeviceIds()[I": () => Int32Array.of(VIRTUAL_KEYBOARD, TOUCHSCREEN),
  // the devices never change, so a listener is never called
  "registerInputDevicesChangedListener(Landroid/hardware/input/IInputDevicesChangedListener;)V": () => {},
  "hasKeys(II[I[Z)Z": hasKeys,
  // the device leaves the velocitytracker_strategy flag at its default
  "getVelocityTrackerStrategy()Ljava/lang/String;": () => null,
} });
hostStub("input", "webdroid/InputManagerService");

/** A finger on the touchscreen as InputReader cooks it: at (x, y) on the display, for a window
 *  whose origin is at (left, top) */
export function touchEvent(action: number, x: number, y: number, downMs: number, atMs: number, left = 0, top = 0): NativeMotionEvent {
  const e = new NativeMotionEvent(), c = new Coords();
  c.set(AXIS_X, x); c.set(AXIS_Y, y); c.set(AXIS_PRESSURE, 1);
  Object.assign(e, { id: nextId(), deviceId: TOUCHSCREEN, source: TOUCH_SOURCE, action, flags: SUPPORTS_ORIENTATION,
    xPrecision: RAW_RANGE / device.width, yPrecision: RAW_RANGE / device.height, downTime: BigInt(Math.round(downMs * 1e6)),
    ids: [0], tools: [TOOL_TYPE_FINGER], times: [BigInt(Math.round(atMs * 1e6))], coords: [c] });
  e.xform = Float32Array.of(1, 0, -left, 0, 1, -top);
  return e;
}
