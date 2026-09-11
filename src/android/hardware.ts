// android.hardware: Sensor value classes and the listener interface apps implement.
// SensorManager itself is a Context system service and lives with the others in app.ts.

import { rt, JObj } from "../jvm/runtime";
import { device } from "../shell/config";
import { newArrayList } from "../jvm/natives/jutil";

rt.markers("android/hardware/SensorEventListener");
rt.register({ name: "android/hardware/HardwareBuffer", ctor: class extends JObj {}, ifaces: ["android/os/Parcelable", "java/lang/AutoCloseable"] });

class JSensor extends JObj { type = 0; sname = ""; vendor = ""; maxRange = 0; resolution = 0; minDelay = 0; }
rt.register({
  name: "android/hardware/Sensor", ctor: JSensor,
  statics: {
    TYPE_ACCELEROMETER: 1, TYPE_MAGNETIC_FIELD: 2, TYPE_ORIENTATION: 3, TYPE_GYROSCOPE: 4, TYPE_LIGHT: 5,
    TYPE_PRESSURE: 6, TYPE_PROXIMITY: 8, TYPE_GRAVITY: 9, TYPE_LINEAR_ACCELERATION: 10, TYPE_ROTATION_VECTOR: 11, TYPE_ALL: -1,
  },
  methods: {
    "getType()I": function (this: JSensor) { return this.type; },
    "getName()Ljava/lang/String;": function (this: JSensor) { return this.sname; },
    "getVendor()Ljava/lang/String;": function (this: JSensor) { return this.vendor; },
    "getMaximumRange()F": function (this: JSensor) { return this.maxRange; },
    "getResolution()F": function (this: JSensor) { return this.resolution; },
    "getMinDelay()I": function (this: JSensor) { return this.minDelay; },
  },
});

class JSensorEvent extends JObj { values = new Float32Array(3); accuracy = 0; timestamp = 0n; sensor: JSensor | null = null; }
rt.register({
  name: "android/hardware/SensorEvent", ctor: JSensorEvent,
  fields: { values: "values", accuracy: "accuracy", timestamp: "timestamp", sensor: "sensor" },
});

// ── android.hardware.input: the one input device is the touchscreen (id 1, SOURCE_TOUCHSCREEN)
class JInputDevice extends JObj {}
class JMotionRange extends JObj { axis = 0; max = 0; }
const touchscreen = new JInputDevice();
function inputDevice(id: number): JInputDevice | null {
  if (id !== 1) return null;
  rt.link("android/view/InputDevice");
  return touchscreen;
}
export class JInputEvent extends JObj { deviceId = 0; source = 0; }
rt.register({
  name: "android/view/InputEvent", ctor: JInputEvent, ifaces: ["android/os/Parcelable"],
  methods: {
    "getDevice()Landroid/view/InputDevice;": function (this: JInputEvent) { return inputDevice(this.deviceId); },
    "getDeviceId()I": function (this: JInputEvent) { return this.deviceId; },
    "getSource()I": function (this: JInputEvent) { return this.source; },
    "setSource(I)V": function (this: JInputEvent, source: number) { this.source = source; },
    "isFromSource(I)Z": function (this: JInputEvent, source: number) { return (this.source & source) === source ? 1 : 0; },
  },
});
const range = (axis: number, max: number) => { const r = new JMotionRange(); r.axis = axis; r.max = max; return r; };
const ranges = [range(0, 0), range(1, 0), range(2, 1), range(3, 1)];
function motionRange(axis: number, source = 0x1002): JMotionRange | null {
  if (source !== 0x1002) return null;
  const r = ranges[axis];
  if (!r) return null;
  rt.link("android/view/InputDevice$MotionRange");
  if (axis < 2) r.max = axis === 0 ? device.width : device.height;
  return r;
}
rt.register({
  name: "android/view/InputDevice", ctor: JInputDevice,
  statics: { SOURCE_TOUCHSCREEN: 0x1002, SOURCE_KEYBOARD: 0x101, SOURCE_MOUSE: 0x2002, SOURCE_JOYSTICK: 0x1000010, SOURCE_GAMEPAD: 0x401, SOURCE_DPAD: 0x201,
    SOURCE_CLASS_POINTER: 2, SOURCE_CLASS_BUTTON: 1, SOURCE_CLASS_JOYSTICK: 16, SOURCE_UNKNOWN: 0, SOURCE_ANY: -256, KEYBOARD_TYPE_NONE: 0, KEYBOARD_TYPE_ALPHABETIC: 2 },
  methods: {
    "static getDeviceIds()[I": () => Int32Array.of(1),
    "static getDevice(I)Landroid/view/InputDevice;": inputDevice,
    "getId()I": () => 1,
    "getName()Ljava/lang/String;": () => "touchscreen",
    "getDescriptor()Ljava/lang/String;": () => "touchscreen",
    "getSources()I": () => 0x1002,
    "supportsSource(I)Z": (s: number) => ((s & 0x1002) === s ? 1 : 0),
    "getKeyboardType()I": () => 0,
    "isVirtual()Z": () => 0,
    "isExternal()Z": () => 0,
    "getVendorId()I": () => 0,
    "getProductId()I": () => 0,
    "getControllerNumber()I": () => 0,
    "getMotionRange(I)Landroid/view/InputDevice$MotionRange;": motionRange,
    "getMotionRange(II)Landroid/view/InputDevice$MotionRange;": motionRange,
    "getMotionRanges()Ljava/util/List;": () => newArrayList(ranges.map(r => motionRange(r.axis))),
    "hasKeys([I)[Z": (keys: Int32Array) => new Uint8Array(keys.length),
  },
});
rt.register({
  name: "android/view/InputDevice$MotionRange", ctor: JMotionRange,
  methods: {
    "getAxis()I": function (this: JMotionRange) { return this.axis; },
    "getMin()F": () => 0, "getMax()F": function (this: JMotionRange) { return this.max; },
    "getRange()F": function (this: JMotionRange) { return this.max; },
    "getFlat()F": () => 0, "getFuzz()F": () => 0, "getResolution()F": () => 0,
    "getSource()I": () => 0x1002,
  },
});
rt.markers("android/hardware/input/InputManager$InputDeviceListener");
rt.register({
  name: "android/hardware/input/InputManager", ctor: class extends JObj {},
  methods: {
    "getInputDeviceIds()[I": () => Int32Array.of(1),
    "getInputDevice(I)Landroid/view/InputDevice;": inputDevice,
    "registerInputDeviceListener(Landroid/hardware/input/InputManager$InputDeviceListener;Landroid/os/Handler;)V": () => {},
    "unregisterInputDeviceListener(Landroid/hardware/input/InputManager$InputDeviceListener;)V": () => {},
  },
});
