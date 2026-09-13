import { expect, test } from "bun:test";
import "../src/natives";
import { mangleMethod } from "../src/jvm/abi";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("MediaDrm reports the browser device's unsupported schemes", async () => {
  const uuid = await newObj("java/util/UUID", "(JJ)V", 0n, 0n);
  await expect(newObj("android/media/MediaDrm", "(Ljava/util/UUID;)V", uuid)).rejects.toMatchObject({
    constructor: rt.link("android/media/UnsupportedSchemeException").ctor,
  });
  expect(rt.iof(rt.make("android/media/UnsupportedSchemeException"), "android/media/MediaDrmException")).toBe(1);
  const supported = rt.link("android/media/MediaDrm").ctor[mangleMethod("isCryptoSchemeSupported", "(Ljava/util/UUID;)Z")];
  expect(supported(uuid)).toBe(0);
  await vcall(rt.make("android/media/MediaDrm"), "close", "()V");
});
