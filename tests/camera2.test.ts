import { expect, test } from "bun:test";
import "../src/natives";
import { systemService } from "../src/android/context";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall, vcallAsync } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("camera2 reports a device with no connected cameras", async () => {
  const manager = systemService(rt.make("android/content/Context"), "camera");
  expect(await vcall(manager, "getCameraIdList", "()[Ljava/lang/String;")).toHaveLength(0);
  const combinations = await vcall(manager, "getConcurrentCameraIds", "()Ljava/util/Set;");
  expect(await vcall(combinations, "isEmpty", "()Z")).toBe(1);
  await expect(vcallAsync(manager, "getCameraCharacteristics", "(Ljava/lang/String;)Landroid/hardware/camera2/CameraCharacteristics;", "0"))
    .rejects.toMatchObject({ constructor: rt.link("java/lang/IllegalArgumentException").ctor });
});

test("capture request builders retain keys, targets and tags", async () => {
  const builder = rt.make("android/hardware/camera2/CaptureRequest$Builder");
  const key = await newObj("android/hardware/camera2/CaptureRequest$Key", "(Ljava/lang/String;Ljava/lang/Class;)V", "mode", rt.classFor("java/lang/Integer"));
  const surface = rt.make("android/view/Surface");
  await vcall(builder, "set", "(Landroid/hardware/camera2/CaptureRequest$Key;Ljava/lang/Object;)V", key, "auto");
  await vcall(builder, "addTarget", "(Landroid/view/Surface;)V", surface);
  await vcall(builder, "setTag", "(Ljava/lang/Object;)V", "capture");
  const request = await vcall(builder, "build", "()Landroid/hardware/camera2/CaptureRequest;");
  expect(await vcall(request, "get", "(Landroid/hardware/camera2/CaptureRequest$Key;)Ljava/lang/Object;", key)).toBe("auto");
  expect(await vcall(request, "getTag", "()Ljava/lang/Object;")).toBe("capture");
});
