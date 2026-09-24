// android.hardware: Sensor value classes and the listener interface apps implement.
// SensorManager itself is a Context system service and lives with the others in app.ts.

import { rt, JObj, stubs, fieldGetters, fieldSetters } from "../jvm/runtime";
import { device } from "../shell/config";
import { newArrayList } from "../jvm/natives/jutil";

rt.markers("android/hardware/SensorEventListener");
rt.markers("android/hardware/TriggerEventListener");
class JTriggerEvent extends JObj { values = new Float32Array(0); timestamp = 0n; }
rt.register({ name: "android/hardware/TriggerEvent", ctor: JTriggerEvent, fields: ["values", "timestamp"] });
class JCameraInfo extends JObj { facing = 0; orientation = 0; }
rt.register({
  name: "android/hardware/Camera$CameraInfo", ctor: JCameraInfo, fields: ["facing", "orientation"],
  statics: { CAMERA_FACING_BACK: 0, CAMERA_FACING_FRONT: 1 }, methods: { "<init>()V": function () {} },
});
rt.register({
  name: "android/hardware/Camera", ctor: class extends JObj {},
  methods: {
    "static getNumberOfCameras()I": () => 0,
    "static getCameraInfo(ILandroid/hardware/Camera$CameraInfo;)V": () => { throw rt.mkThrowable("java/lang/RuntimeException", "Unknown camera ID"); },
  },
});
rt.register({ name: "android/hardware/SensorEventListener2", ctor: class extends JObj {}, ifaces: ["android/hardware/SensorEventListener"] });
rt.register({ name: "android/hardware/HardwareBuffer", ctor: class extends JObj {}, ifaces: ["android/os/Parcelable", "java/lang/AutoCloseable"] });
rt.register({ name: "android/hardware/fingerprint/FingerprintManager", ctor: class extends JObj {}, methods: {
  "isHardwareDetected()Z": () => 0,
  "hasEnrolledFingerprints()Z": () => 0,
} });
rt.register({ name: "android/hardware/biometrics/BiometricManager", ctor: class extends JObj {},
  statics: { BIOMETRIC_SUCCESS: 0, BIOMETRIC_ERROR_HW_UNAVAILABLE: 1, BIOMETRIC_ERROR_NONE_ENROLLED: 11,
    BIOMETRIC_ERROR_NO_HARDWARE: 12, BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED: 15 },
  methods: {
    "canAuthenticate()I": () => 12,
    "canAuthenticate(I)I": () => 12,
  },
});
rt.register({ name: "android/hardware/usb/UsbManager", ctor: class extends JObj {}, methods: {
  "getDeviceList()Ljava/util/HashMap;": () => rt.make("java/util/HashMap"),
  "getAccessoryList()[Landroid/hardware/usb/UsbAccessory;": () => null,
} });

class JSensor extends JObj { type = 0; sname = ""; vendor = ""; maxRange = 0; resolution = 0; minDelay = 0; }
rt.register({
  name: "android/hardware/Sensor", ctor: JSensor,
  statics: {
    TYPE_ACCELEROMETER: 1, TYPE_MAGNETIC_FIELD: 2, TYPE_ORIENTATION: 3, TYPE_GYROSCOPE: 4, TYPE_LIGHT: 5,
    TYPE_PRESSURE: 6, TYPE_PROXIMITY: 8, TYPE_GRAVITY: 9, TYPE_LINEAR_ACCELERATION: 10, TYPE_ROTATION_VECTOR: 11, TYPE_ALL: -1,
  },
  methods: {
    ...fieldGetters({ "getType()I": "type", "getName()Ljava/lang/String;": "sname",
      "getVendor()Ljava/lang/String;": "vendor", "getMaximumRange()F": "maxRange", "getResolution()F": "resolution",
      "getMinDelay()I": "minDelay" }),
  },
});

class JSensorEvent extends JObj { values = new Float32Array(3); accuracy = 0; timestamp = 0n; sensor: JSensor | null = null; }
rt.register({
  name: "android/hardware/SensorEvent", ctor: JSensorEvent,
  fields: ["values", "accuracy", "timestamp", "sensor"],
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
    ...fieldGetters({ "getDeviceId()I": "deviceId", "getSource()I": "source" }),
    ...fieldSetters({ "setSource(I)V": "source" }),
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
    "getName()Ljava/lang/String;": () => "touchscreen",
    "getDescriptor()Ljava/lang/String;": () => "touchscreen",
    "getSources()I": () => 0x1002,
    "supportsSource(I)Z": (s: number) => ((s & 0x1002) === s ? 1 : 0),
    ...stubs(1, "getId()I"),
    ...stubs(0, "getKeyboardType()I", "isVirtual()Z", "isExternal()Z", "getVendorId()I", "getProductId()I",
      "getControllerNumber()I"),
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
