import { jarray } from "../jvm/abi";
import { curThread } from "../jvm/natives/jlang";
import { newStringSet } from "../jvm/natives/jutil";
import { JObj, noops, rt } from "../jvm/runtime";

rt.register({
  name: "android/hardware/camera2/CameraCaptureSession", ctor: class extends JObj {},
  ifaces: ["java/lang/AutoCloseable"], methods: { "<init>()V": function () {} },
});
rt.markers("android/hardware/camera2/CaptureResult");
// No camera is exposed, so characteristics are never read; their keys still exist as statics that
// camera libraries collect at class initialization. A key's name is its metadata tag:
// LENS_INFO_AVAILABLE_FOCAL_LENGTHS is "android.lens.info.availableFocalLengths".
class JCameraCharacteristicsKey extends JObj { keyName = ""; }
const keyName = (field: string) => {
  const [section, ...rest] = field.toLowerCase().split("_");
  const prefix = rest[0] === "info" ? `${section}.${rest.shift()}` : section;
  return `android.${prefix}.${rest.map((w, i) => i ? w[0].toUpperCase() + w.slice(1) : w).join("")}`;
};
rt.register({
  name: "android/hardware/camera2/CameraCharacteristics$Key", ctor: JCameraCharacteristicsKey,
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/Class;)V": function (this: JCameraCharacteristicsKey, name: string) { this.keyName = name; },
    "getName()Ljava/lang/String;": function (this: JCameraCharacteristicsKey) { return this.keyName; },
    "toString()Ljava/lang/String;": function (this: JCameraCharacteristicsKey) { return `CameraCharacteristics.Key(${this.keyName})`; },
  },
});
rt.register({
  name: "android/hardware/camera2/CameraCharacteristics", ctor: class extends JObj {},
  statics: Object.fromEntries(["LENS_FACING", "SENSOR_ORIENTATION", "SCALER_STREAM_CONFIGURATION_MAP", "INFO_SUPPORTED_HARDWARE_LEVEL",
    "REQUEST_AVAILABLE_CAPABILITIES", "FLASH_INFO_AVAILABLE", "CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES", "CONTROL_AE_AVAILABLE_MODES",
    "CONTROL_AE_COMPENSATION_RANGE", "CONTROL_AE_COMPENSATION_STEP", "CONTROL_AF_AVAILABLE_MODES", "CONTROL_AWB_AVAILABLE_MODES",
    "CONTROL_AVAILABLE_SCENE_MODES", "CONTROL_MAX_REGIONS_AE", "CONTROL_MAX_REGIONS_AF", "CONTROL_MAX_REGIONS_AWB", "CONTROL_ZOOM_RATIO_RANGE",
    "SCALER_AVAILABLE_MAX_DIGITAL_ZOOM", "SENSOR_INFO_ACTIVE_ARRAY_SIZE", "SENSOR_INFO_PHYSICAL_SIZE", "SENSOR_INFO_PIXEL_ARRAY_SIZE",
    "LENS_INFO_AVAILABLE_FOCAL_LENGTHS", "LENS_INFO_MINIMUM_FOCUS_DISTANCE"]
    .map((field) => [field, Object.assign(new JCameraCharacteristicsKey(), { keyName: keyName(field) })])),
});
rt.register({ name: "android/hardware/camera2/CameraDevice$StateCallback", ctor: class extends JObj {},
  statics: { ERROR_CAMERA_IN_USE: 1, ERROR_MAX_CAMERAS_IN_USE: 2, ERROR_CAMERA_DISABLED: 3, ERROR_CAMERA_DEVICE: 4, ERROR_CAMERA_SERVICE: 5 },
  methods: noops("<init>()V", "onClosed(Landroid/hardware/camera2/CameraDevice;)V"),
});
rt.register({ name: "android/hardware/camera2/CameraCaptureSession$StateCallback", ctor: class extends JObj {}, methods: noops(
  "<init>()V",
  "onReady(Landroid/hardware/camera2/CameraCaptureSession;)V",
  "onActive(Landroid/hardware/camera2/CameraCaptureSession;)V",
  "onCaptureQueueEmpty(Landroid/hardware/camera2/CameraCaptureSession;)V",
  "onClosed(Landroid/hardware/camera2/CameraCaptureSession;)V",
  "onSurfacePrepared(Landroid/hardware/camera2/CameraCaptureSession;Landroid/view/Surface;)V",
) });
rt.register({ name: "android/hardware/camera2/CameraCaptureSession$CaptureCallback", ctor: class extends JObj {}, methods: noops(
  "<init>()V",
  "onCaptureStarted(Landroid/hardware/camera2/CameraCaptureSession;Landroid/hardware/camera2/CaptureRequest;JJ)V",
  "onReadoutStarted(Landroid/hardware/camera2/CameraCaptureSession;Landroid/hardware/camera2/CaptureRequest;JJ)V",
  "onCapturePartial(Landroid/hardware/camera2/CameraCaptureSession;Landroid/hardware/camera2/CaptureRequest;Landroid/hardware/camera2/CaptureResult;)V",
  "onCaptureProgressed(Landroid/hardware/camera2/CameraCaptureSession;Landroid/hardware/camera2/CaptureRequest;Landroid/hardware/camera2/CaptureResult;)V",
  "onCaptureCompleted(Landroid/hardware/camera2/CameraCaptureSession;Landroid/hardware/camera2/CaptureRequest;Landroid/hardware/camera2/TotalCaptureResult;)V",
  "onCaptureFailed(Landroid/hardware/camera2/CameraCaptureSession;Landroid/hardware/camera2/CaptureRequest;Landroid/hardware/camera2/CaptureFailure;)V",
  "onCaptureSequenceCompleted(Landroid/hardware/camera2/CameraCaptureSession;IJ)V",
  "onCaptureSequenceAborted(Landroid/hardware/camera2/CameraCaptureSession;I)V",
  "onCaptureBufferLost(Landroid/hardware/camera2/CameraCaptureSession;Landroid/hardware/camera2/CaptureRequest;Landroid/view/Surface;J)V",
) });

rt.register({ name: "android/hardware/camera2/CameraManager$AvailabilityCallback", ctor: class extends JObj {}, methods: noops(
  "<init>()V", "onCameraAvailable(Ljava/lang/String;)V", "onCameraUnavailable(Ljava/lang/String;)V",
  "onCameraAccessPrioritiesChanged()V", "onPhysicalCameraAvailable(Ljava/lang/String;Ljava/lang/String;)V",
  "onPhysicalCameraUnavailable(Ljava/lang/String;Ljava/lang/String;)V",
) });

class JCaptureRequestKey extends JObj { keyName = ""; }
class JCaptureRequest extends JObj {
  values = new Map<JCaptureRequestKey, unknown>();
  targets = new Set<unknown>();
  tag: unknown = null;
}
class JCaptureRequestBuilder extends JCaptureRequest {}

rt.register({
  name: "android/hardware/camera2/CaptureRequest$Key", ctor: JCaptureRequestKey,
  methods: {
    "<init>(Ljava/lang/String;Ljava/lang/Class;)V": function (this: JCaptureRequestKey, name: string) { this.keyName = name; },
    "getName()Ljava/lang/String;": function (this: JCaptureRequestKey) { return this.keyName; },
  },
});
rt.register({
  name: "android/hardware/camera2/CaptureRequest", ctor: JCaptureRequest,
  methods: {
    "get(Landroid/hardware/camera2/CaptureRequest$Key;)Ljava/lang/Object;": function (this: JCaptureRequest, key: JCaptureRequestKey) {
      return this.values.get(key) ?? null;
    },
    "getTag()Ljava/lang/Object;": function (this: JCaptureRequest) { return this.tag; },
  },
});
rt.register({
  name: "android/hardware/camera2/CaptureRequest$Builder", ctor: JCaptureRequestBuilder,
  methods: {
    "set(Landroid/hardware/camera2/CaptureRequest$Key;Ljava/lang/Object;)V": function (this: JCaptureRequestBuilder, key: JCaptureRequestKey, value: unknown) {
      if (!key) return rt.npe();
      this.values.set(key, value);
    },
    "get(Landroid/hardware/camera2/CaptureRequest$Key;)Ljava/lang/Object;": function (this: JCaptureRequestBuilder, key: JCaptureRequestKey) {
      if (!key) return rt.npe();
      return this.values.get(key) ?? null;
    },
    "addTarget(Landroid/view/Surface;)V": function (this: JCaptureRequestBuilder, surface: unknown) {
      if (!surface) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Null Surface targets are not allowed");
      this.targets.add(surface);
    },
    "removeTarget(Landroid/view/Surface;)V": function (this: JCaptureRequestBuilder, surface: unknown) { this.targets.delete(surface); },
    "setTag(Ljava/lang/Object;)V": function (this: JCaptureRequestBuilder, tag: unknown) { this.tag = tag; },
    "build()Landroid/hardware/camera2/CaptureRequest;": function (this: JCaptureRequestBuilder) {
      const request = new JCaptureRequest();
      request.values = new Map(this.values);
      request.targets = new Set(this.targets);
      request.tag = this.tag;
      return request;
    },
  },
});
rt.register({
  name: "android/hardware/camera2/CameraManager", ctor: class extends JObj {},
  methods: {
    "getCameraIdList()[Ljava/lang/String;": () => jarray([], "Ljava/lang/String;"),
    // The exposed camera topology is empty, so registration has no initial availability events.
    "registerAvailabilityCallback(Ljava/util/concurrent/Executor;Landroid/hardware/camera2/CameraManager$AvailabilityCallback;)V": (executor: unknown) => {
      if (executor == null) throw rt.mkThrowable("java/lang/IllegalArgumentException", "executor was null");
    },
    "registerAvailabilityCallback(Landroid/hardware/camera2/CameraManager$AvailabilityCallback;Landroid/os/Handler;)V": (_callback: unknown, handler: unknown) => {
      if (handler == null && !curThread.looper) throw rt.mkThrowable("java/lang/IllegalArgumentException", "No handler given, and current thread has no looper");
    },
    "unregisterAvailabilityCallback(Landroid/hardware/camera2/CameraManager$AvailabilityCallback;)V": () => {},
    "getConcurrentCameraIds()Ljava/util/Set;": () => newStringSet([]),
    "getCameraCharacteristics(Ljava/lang/String;)Landroid/hardware/camera2/CameraCharacteristics;": () => {
      throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown camera ID");
    },
    "getCameraExtensionCharacteristics(Ljava/lang/String;)Landroid/hardware/camera2/CameraExtensionCharacteristics;": () => {
      throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown camera ID");
    },
    "openCamera(Ljava/lang/String;Landroid/hardware/camera2/CameraDevice$StateCallback;Landroid/os/Handler;)V": () => {
      throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown camera ID");
    },
  },
});
