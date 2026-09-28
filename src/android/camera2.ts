import { jarray } from "../jvm/abi";
import { curThread } from "../jvm/natives/jlang";
import { newStringSet } from "../jvm/natives/jutil";
import { JObj, noops, rt, type NativeSpec } from "../jvm/runtime";

rt.register({
  name: "android/hardware/camera2/CameraCaptureSession", ctor: class extends JObj {},
  ifaces: ["java/lang/AutoCloseable"], methods: { "<init>()V": function () {} },
});
// No camera is exposed, so metadata is never read; its keys still exist as statics that camera
// libraries collect at class initialization. A key's name is its metadata tag:
// LENS_INFO_AVAILABLE_FOCAL_LENGTHS is "android.lens.info.availableFocalLengths".
class JMetadataKey extends JObj { keyName = ""; }
const keyName = (field: string) => {
  const [section, ...rest] = field.toLowerCase().split("_");
  const prefix = rest[0] === "info" ? `${section}.${rest.shift()}` : section;
  return `android.${prefix}.${rest.map((w, i) => i ? w[0].toUpperCase() + w.slice(1) : w).join("")}`;
};
function metadata(owner: string, fields: string[], ctor: new () => JObj = class extends JObj {}, methods?: NativeSpec["methods"]): void {
  const Key = class extends JMetadataKey {}, label = owner.slice(owner.lastIndexOf("/") + 1);
  rt.register({
    name: `android/hardware/camera2/${owner}$Key`, ctor: Key,
    methods: {
      "<init>(Ljava/lang/String;Ljava/lang/Class;)V": function (this: JMetadataKey, name: string) { this.keyName = name; },
      "getName()Ljava/lang/String;": function (this: JMetadataKey) { return this.keyName; },
      "toString()Ljava/lang/String;": function (this: JMetadataKey) { return `${label}.Key(${this.keyName})`; },
    },
  });
  rt.register({ name: `android/hardware/camera2/${owner}`, ctor, methods,
    statics: Object.fromEntries(fields.map((field) => [field, Object.assign(new Key(), { keyName: keyName(field) })])) });
}
metadata("CameraCharacteristics", ["LENS_FACING", "SENSOR_ORIENTATION", "SCALER_STREAM_CONFIGURATION_MAP", "INFO_SUPPORTED_HARDWARE_LEVEL",
  "REQUEST_AVAILABLE_CAPABILITIES", "FLASH_INFO_AVAILABLE", "CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES", "CONTROL_AE_AVAILABLE_MODES",
  "CONTROL_AE_COMPENSATION_RANGE", "CONTROL_AE_COMPENSATION_STEP", "CONTROL_AF_AVAILABLE_MODES", "CONTROL_AWB_AVAILABLE_MODES",
  "CONTROL_AVAILABLE_SCENE_MODES", "CONTROL_MAX_REGIONS_AE", "CONTROL_MAX_REGIONS_AF", "CONTROL_MAX_REGIONS_AWB", "CONTROL_ZOOM_RATIO_RANGE",
  "SCALER_AVAILABLE_MAX_DIGITAL_ZOOM", "SENSOR_INFO_ACTIVE_ARRAY_SIZE", "SENSOR_INFO_PHYSICAL_SIZE", "SENSOR_INFO_PIXEL_ARRAY_SIZE",
  "LENS_INFO_AVAILABLE_FOCAL_LENGTHS", "LENS_INFO_MINIMUM_FOCUS_DISTANCE"]);
const CAPTURE_KEYS = ["CONTROL_AF_MODE", "CONTROL_AF_TRIGGER", "CONTROL_AF_REGIONS", "CONTROL_AE_MODE", "CONTROL_AE_REGIONS",
  "CONTROL_AE_PRECAPTURE_TRIGGER", "CONTROL_AE_TARGET_FPS_RANGE", "CONTROL_AE_EXPOSURE_COMPENSATION", "CONTROL_AE_LOCK",
  "CONTROL_AWB_MODE", "CONTROL_AWB_LOCK", "CONTROL_MODE", "CONTROL_SCENE_MODE", "CONTROL_CAPTURE_INTENT", "CONTROL_ZOOM_RATIO",
  "FLASH_MODE", "JPEG_ORIENTATION", "JPEG_QUALITY", "LENS_FOCUS_DISTANCE", "SCALER_CROP_REGION", "SENSOR_EXPOSURE_TIME",
  "SENSOR_SENSITIVITY", "STATISTICS_FACE_DETECT_MODE"];
metadata("CaptureResult", [...CAPTURE_KEYS, "CONTROL_AF_STATE", "CONTROL_AE_STATE", "CONTROL_AWB_STATE", "FLASH_STATE",
  "LENS_STATE", "SENSOR_TIMESTAMP", "STATISTICS_FACES"]);
rt.register({ name: "android/hardware/camera2/CameraDevice$StateCallback", ctor: class extends JObj {},
  statics: { ERROR_CAMERA_IN_USE: 1, ERROR_MAX_CAMERAS_IN_USE: 2, ERROR_CAMERA_DISABLED: 3, ERROR_CAMERA_DEVICE: 4, ERROR_CAMERA_SERVICE: 5 },
  methods: noops("<init>()V"),
});
rt.register({ name: "android/hardware/camera2/CameraCaptureSession$StateCallback", ctor: class extends JObj {}, methods: noops("<init>()V") });
rt.register({ name: "android/hardware/camera2/CameraCaptureSession$CaptureCallback", ctor: class extends JObj {}, methods: noops("<init>()V") });

rt.register({ name: "android/hardware/camera2/CameraManager$AvailabilityCallback", ctor: class extends JObj {}, methods: noops("<init>()V") });

class JCaptureRequest extends JObj {
  values = new Map<JMetadataKey, unknown>();
  targets = new Set<unknown>();
  tag: unknown = null;
}
class JCaptureRequestBuilder extends JCaptureRequest {}
metadata("CaptureRequest", CAPTURE_KEYS, JCaptureRequest, {
  "get(Landroid/hardware/camera2/CaptureRequest$Key;)Ljava/lang/Object;": function (this: JCaptureRequest, key: JMetadataKey) {
    return this.values.get(key) ?? null;
  },
  "getTag()Ljava/lang/Object;": function (this: JCaptureRequest) { return this.tag; },
});
rt.register({
  name: "android/hardware/camera2/CaptureRequest$Builder", ctor: JCaptureRequestBuilder,
  methods: {
    "set(Landroid/hardware/camera2/CaptureRequest$Key;Ljava/lang/Object;)V": function (this: JCaptureRequestBuilder, key: JMetadataKey, value: unknown) {
      if (!key) return rt.npe();
      this.values.set(key, value);
    },
    "get(Landroid/hardware/camera2/CaptureRequest$Key;)Ljava/lang/Object;": function (this: JCaptureRequestBuilder, key: JMetadataKey) {
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
    ...noops("unregisterAvailabilityCallback(Landroid/hardware/camera2/CameraManager$AvailabilityCallback;)V"),
    "getConcurrentCameraIds()Ljava/util/Set;": () => newStringSet([]),
    // every id names a camera the empty topology does not have
    ...Object.fromEntries(["getCameraCharacteristics(Ljava/lang/String;)Landroid/hardware/camera2/CameraCharacteristics;",
      "getCameraExtensionCharacteristics(Ljava/lang/String;)Landroid/hardware/camera2/CameraExtensionCharacteristics;",
      "openCamera(Ljava/lang/String;Landroid/hardware/camera2/CameraDevice$StateCallback;Landroid/os/Handler;)V",
    ].map((sig) => [sig, () => { throw rt.mkThrowable("java/lang/IllegalArgumentException", "Unknown camera ID"); }])),
  },
});
