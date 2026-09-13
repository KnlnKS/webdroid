import { jarray } from "../jvm/abi";
import { newStringSet } from "../jvm/natives/jutil";
import { JObj, rt } from "../jvm/runtime";

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
