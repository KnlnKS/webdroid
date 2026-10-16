// android.hardware: the natives of the legacy Camera, and those of AOSP's SystemSensorManager
// (android_hardware_SensorManager.cpp). This device has no sensors (config.ts features), so the
// sensor list is empty, no dynamic or runtime sensor appears, data injection is off, and an event
// queue or direct channel has no sensor to enable: SensorService answers BAD_VALUE.

import { rt } from "../jvm/runtime.ts";

// android_hardware_Camera.cpp over a CameraService with no cameras: connecting fails with -EACCES
rt.registerJnis("android/hardware/Camera", {
  "_getNumberOfCameras(II)I": () => 0,
  "_getCameraInfo(IIIILandroid/hardware/Camera$CameraInfo;)V": () => { throw rt.mkThrowable("java/lang/RuntimeException", "Fail to get camera info"); },
  "native_setup(Ljava/lang/Object;ILjava/lang/String;IZII)I": () => -13,
});

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
