import { expect, test } from "bun:test";
import "../src/natives";
import { rt } from "../src/jvm/runtime";
import { newObj, vcall } from "../src/jvm/natives/jlang";

rt.linkNatives();

test("NetworkRequest builder includes other UID networks fluently", async () => {
  const builder = await newObj("android/net/NetworkRequest$Builder", "()V");
  expect(await vcall(builder, "setIncludeOtherUidNetworks", "(Z)Landroid/net/NetworkRequest$Builder;", 1)).toBe(builder);
  const request = await vcall(builder, "build", "()Landroid/net/NetworkRequest;");
  expect(request).not.toBeNull();
});
