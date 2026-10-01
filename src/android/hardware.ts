// android.hardware: the legacy Camera, and the natives of AOSP's SystemSensorManager
// (android_hardware_SensorManager.cpp). This device has no sensors (config.ts features), so the
// sensor list is empty, no dynamic or runtime sensor appears, data injection is off, and an event
// queue or direct channel has no sensor to enable: SensorService answers BAD_VALUE.

import { rt, JObj } from "../jvm/runtime";

rt.markers("android/hardware/Camera$AutoFocusCallback");
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
rt.register({ name: "android/hardware/HardwareBuffer", ctor: class extends JObj {}, ifaces: ["android/os/Parcelable", "java/lang/AutoCloseable"] });

const BAD_VALUE = -22;
let handles = 0n;
const newHandle = () => ++handles;
rt.registerJnis("android/hardware/SystemSensorManager", {
  "nativeClassInit()V": () => {},
  "nativeCreate(Ljava/lang/String;)J": newHandle,
  "nativeGetSensorAtIndex(JLandroid/hardware/Sensor;I)Z": () => 0,
  "nativeGetDefaultDeviceSensorAtIndex(JLandroid/hardware/Sensor;I)Z": () => 0,
  "nativeGetDynamicSensors(JLjava/util/List;)V": () => {},
  "nativeGetRuntimeSensors(JILjava/util/List;)V": () => {},
  "nativeIsDataInjectionEnabled(J)Z": () => 0,
  "nativeIsReplayDataInjectionEnabled(J)Z": () => 0,
  "nativeIsHalBypassReplayDataInjectionEnabled(J)Z": () => 0,
  "nativeCreateDirectChannel(JIJIILandroid/hardware/HardwareBuffer;)I": () => BAD_VALUE,
  "nativeConfigDirectChannel(JIII)I": () => BAD_VALUE,
  "nativeDestroyDirectChannel(JI)V": () => {},
  "nativeSetOperationParameter(JII[F[I)I": () => BAD_VALUE,
});
rt.registerJnis("android/hardware/SystemSensorManager$BaseEventQueue", {
  "nativeInitBaseEventQueue(JLjava/lang/ref/WeakReference;Landroid/os/MessageQueue;Ljava/lang/String;ILjava/lang/String;Ljava/lang/String;)J": newHandle,
  "nativeEnableSensor(JIII)I": () => BAD_VALUE,
  "nativeDisableSensor(JI)I": () => BAD_VALUE,
  "nativeFlushSensor(J)I": () => 0,
  "nativeInjectSensorData(JI[FIJ)I": () => BAD_VALUE,
  "nativeDestroySensorEventQueue(J)V": () => {},
});
