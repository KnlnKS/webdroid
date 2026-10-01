// android.hardware: Sensor value classes and the listener interface apps implement.
// SensorManager itself is a Context system service and lives with the others in app.ts.

import { rt, JObj, fieldGetters } from "../jvm/runtime";

rt.markers("android/hardware/SensorEventListener");
rt.markers("android/hardware/TriggerEventListener");
rt.markers("android/hardware/Camera$AutoFocusCallback");
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

